// Isolated, opt-in benchmark; never opens the user's VS Code storage.
// node tests/history-performance-benchmark.cjs --rows=100000 --contacts=100
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ChatDB } = require('./runtime.cjs');

function option(name, fallback, maximum) {
  const argument = process.argv.find(value => value.startsWith(`--${name}=`));
  const value = argument ? Number(argument.slice(name.length + 3)) : fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid --${name}`);
  return value;
}

const rowCount = option('rows', 100_000, 250_000);
const contactCount = option('contacts', 100, 2_000);
const repetitions = option('repeat', 3, 10);
const accountId = 'benchmark-bot';
const nowSeconds = 1_800_000_000;
const accountSql = "CASE WHEN direction = 'received' THEN to_user_id WHEN direction = 'sent' THEN from_user_id END";
const peerSql = "CASE WHEN direction = 'received' THEN from_user_id WHEN direction = 'sent' THEN to_user_id END";
const legacyPage = `SELECT id, content FROM messages WHERE
  ((direction = 'received' AND to_user_id = ? AND from_user_id = ?)
  OR (direction = 'sent' AND from_user_id = ? AND to_user_id = ?)) ORDER BY id DESC LIMIT 101`;
const scopedPage = `SELECT id, content FROM messages WHERE (${accountSql}) = ? AND (${peerSql}) = ? ORDER BY id DESC LIMIT 101`;
const peerId = 'peer-1';
const legacyArgs = [accountId, peerId, accountId, peerId];
const scopedArgs = [accountId, peerId];

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}
function rounded(value) { return Math.round(value * 1000) / 1000; }

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-history-benchmark-'));
  const databasePath = path.join(directory, 'vschat_qq_chats.db');
  const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, 'qq');
  try {
    await db.init();
    await db.withDatabase(sql => {
      sql.run('BEGIN TRANSACTION');
      const insert = sql.prepare(`INSERT INTO messages
        (direction, type, content, timestamp, context_token, from_user_id, to_user_id, message_id, reference_id, archive_key, imported)
        VALUES (?, 1, ?, ?, '', ?, ?, ?, ?, ?, ?)`);
      try {
        for (let index = 0; index < rowCount; index++) {
          const inbound = index % 2 === 0;
          const account = Math.floor(index / (contactCount * 2)) % 5 === 0 ? 'other-bot' : accountId;
          const peer = `peer-${Math.floor(index / 2) % contactCount}`;
          insert.run([inbound ? 'received' : 'sent', `History ${index} ${'x'.repeat(256)}`,
            nowSeconds - (rowCount - index), inbound ? peer : account, inbound ? account : peer,
            `message-${index}`, index % 10 === 0 ? `reference-${index}` : null, `archive-${index}`, index % 23 === 0 ? 1 : 0]);
        }
      } finally { insert.free(); }
      for (let index = 0; index < contactCount; index++) {
        const peer = `peer-${index}`;
        sql.run('INSERT INTO conversation_reads VALUES (?, ?, ?)', [accountId, peer, index % 2 ? Math.floor(rowCount / 2) : 0]);
        sql.run('INSERT INTO qq_reply_contexts VALUES (?, ?, ?, ?, ?)', [accountId, peer, `older-${index}`, nowSeconds - 120, 0]);
        sql.run('INSERT INTO qq_reply_contexts VALUES (?, ?, ?, ?, ?)', [accountId, peer, `newer-${index}`, nowSeconds - 60, index % 7 ? index % 3 : 4]);
        sql.run('INSERT INTO qq_reply_contexts VALUES (?, ?, ?, ?, ?)', ['other-bot', peer, `foreign-${index}`, nowSeconds - 30, 0]);
      }
      sql.run('COMMIT');
    }, true);

    const measure = async (operation, samples = repetitions) => {
      const durations = [], reads = [], bytes = [], diskReadTimes = [];
      for (let sample = 0; sample < samples; sample++) {
        let count = 0, readBytes = 0, readMs = 0;
        const originalRead = fs.readFileSync;
        fs.readFileSync = function (file, ...args) {
          const started = performance.now();
          const value = originalRead.call(fs, file, ...args);
          if (typeof file === 'string' && path.resolve(file) === databasePath) {
            count++; readBytes += value.byteLength; readMs += performance.now() - started;
          }
          return value;
        };
        const started = performance.now();
        try { await operation(); }
        finally { fs.readFileSync = originalRead; }
        durations.push(performance.now() - started); reads.push(count); bytes.push(readBytes); diskReadTimes.push(readMs);
      }
      return { samples, medianMs: rounded(percentile(durations, 0.5)), maxMs: rounded(Math.max(...durations)),
        databaseReadsPerRun: reads, databaseBytesReadPerRun: bytes, medianReadFileMs: rounded(percentile(diskReadTimes, 0.5)) };
    };

    const plansAndQueryTimes = await db.withDatabase(sql => {
      const plan = (query, args) => sql.exec(`EXPLAIN QUERY PLAN ${query}`, args)[0].values.map(row => String(row[3]));
      const queryTime = (query, args) => {
        const values = [];
        for (let sample = 0; sample < 11; sample++) {
          const started = performance.now();
          sql.exec(query, args);
          values.push(performance.now() - started);
        }
        return { medianMs: rounded(percentile(values, 0.5)), maxMs: rounded(Math.max(...values)) };
      };
      return { legacyScopePlan: plan(legacyPage, legacyArgs), indexedScopePlan: plan(scopedPage, scopedArgs),
        legacyScopeSqlOnly: queryTime(legacyPage, legacyArgs), indexedScopeSqlOnly: queryTime(scopedPage, scopedArgs) };
    });

    const replyOptions = { appId: accountId, nowSeconds, windowSeconds: 3600, maxReplies: 4 };
    const emptySnapshot = await measure(() => db.withDatabase(() => undefined));
    const scopedHistory = await measure(() => db.getSyncSnapshot(undefined, undefined, 100, false, { accountId, peerId }));
    let legacyResult;
    const legacyRecipients = await measure(async () => {
      const conversations = await db.listConversations(accountId);
      const replies = await Promise.all(conversations.map(row => db.peekQqReply({ ...replyOptions, openId: row.conversation.peerId })));
      legacyResult = { conversations: conversations.map((row, index) => ({ ...row, replyContext: replies[index] })),
        totalUnreadCount: await db.getTotalUnreadCount(accountId) };
    });
    let batchResult;
    const batchedRecipients = await measure(async () => { batchResult = await db.getQqRecipientSummary(replyOptions); });
    require('node:assert/strict').deepEqual(batchResult, legacyResult);
    console.log(JSON.stringify({ dataset: { rows: rowCount, contactsPerAccount: contactCount,
      databaseBytes: fs.statSync(databasePath).size, textBytesPerMessage: 'about 270',
      node: process.version, platform: `${process.platform}/${process.arch}` },
      ...plansAndQueryTimes, emptySnapshot, scopedHistory, legacyRecipients, batchedRecipients,
      ratios: { batchSpeedup: rounded(legacyRecipients.medianMs / batchedRecipients.medianMs),
        scopeSqlSpeedup: rounded(plansAndQueryTimes.legacyScopeSqlOnly.medianMs / plansAndQueryTimes.indexedScopeSqlOnly.medianMs) },
      notes: ['Legacy recipient comparison reproduces N+2 calls on the same indexed database.',
        'All read timings include the existing cross-process lock and fresh sql.js file snapshot.',
        'SQL-only timings reuse one isolated in-memory snapshot; there is no application snapshot cache.',
        'Temporary database and files are removed after the benchmark.'] }, null, 2));
  } finally {
    await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
