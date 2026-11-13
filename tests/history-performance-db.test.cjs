const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ChatDB, message } = require('./runtime.cjs');

const accountId = 'summary-bot';
const recipient = index => `peer-${String(index).padStart(3, '0')}`;
const inbound = (name, peerId, timestamp, appId = accountId) => ({
  ...message(name), direction: 'received', from_user_id: peerId, to_user_id: appId, timestamp,
});
const summaryOptions = { appId: accountId, nowSeconds: 10000, windowSeconds: 1000, maxReplies: 4 };

async function setup(t, channel = 'qq') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-performance-db-'));
  const instances = [];
  const open = async () => {
    const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, channel);
    await db.init(); instances.push(db); return db;
  };
  t.after(async () => {
    await Promise.all(instances.map(db => db.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, dbPath: path.join(directory, channel === 'qq' ? 'vschat_qq_chats.db' : 'vschat_chats.db'), db: await open(), open };
}

// Observe production operations instead of enforcing machine-dependent timing.
async function observe(db, dbPath, action) {
  const originalRead = fs.readFileSync, originalWithDatabase = db.withDatabase;
  const queries = [];
  let reads = 0, snapshots = 0;
  fs.readFileSync = function (file, ...args) {
    if (typeof file === 'string' && path.resolve(file) === dbPath) reads++;
    return originalRead.call(this, file, ...args);
  };
  db.withDatabase = function (operation, write) {
    snapshots++;
    return originalWithDatabase.call(this, sql => {
      const originalExec = sql.exec;
      sql.exec = function (query, parameters, ...args) {
        queries.push({ query, parameters });
        return originalExec.call(this, query, parameters, ...args);
      };
      return operation(sql);
    }, write);
  };
  try { return { value: await action(), reads, snapshots, queries }; }
  finally { fs.readFileSync = originalRead; db.withDatabase = originalWithDatabase; }
}

async function seedContacts(db, start, count) {
  await db.withDatabase(sql => {
    sql.run('BEGIN TRANSACTION');
    const row = sql.prepare(`INSERT INTO messages
      (id, direction, type, content, timestamp, context_token, from_user_id, to_user_id, message_id, reference_id, archive_key)
      VALUES (?, ?, 1, ?, ?, '', ?, ?, ?, ?, ?)`);
    const context = sql.prepare('INSERT INTO qq_reply_contexts (app_id, open_id, message_id, timestamp, sequence) VALUES (?, ?, ?, ?, ?)');
    try {
      for (let index = start; index < start + count; index++) {
        const peer = recipient(index), baseId = index * 3 + 1;
        for (let offset = 0; offset < 3; offset++) {
          const sent = offset === 2, name = `${peer}-${offset}`;
          row.run([baseId + offset, sent ? 'sent' : 'received', name,
            (offset === 0 ? 9800 : offset === 1 ? 9900 : 9950) + index % 50,
            sent ? accountId : peer, sent ? peer : accountId, name, `reference-${name}`, randomUUID()]);
        }
        context.run([accountId, peer, `${peer}-0`, 9800 + index % 50, 0]);
        context.run([accountId, peer, `${peer}-1`, 9900 + index % 50, index % 5]);
        if (index % 2 === 0) sql.run('INSERT INTO conversation_reads VALUES (?, ?, ?)', [accountId, peer, baseId]);
      }
      sql.run('COMMIT');
    } finally { row.free(); context.free(); }
  }, true);
}

test('two hundred recipient summaries use one disk snapshot and a constant number of SQL queries without consuming quota', async (t) => {
  const { db, dbPath } = await setup(t);
  await seedContacts(db, 0, 1);
  const small = await observe(db, dbPath, () => db.getQqRecipientSummary(summaryOptions));
  const smallList = await observe(db, dbPath, () => db.listConversations(accountId));
  await seedContacts(db, 1, 199);
  const quotas = () => db.withDatabase(sql => sql.exec('SELECT app_id, open_id, message_id, sequence FROM qq_reply_contexts ORDER BY app_id, open_id, message_id')[0].values);
  const beforeQuotas = await quotas(), stamp = await db.getChangeStamp();
  const large = await observe(db, dbPath, () => db.getQqRecipientSummary(summaryOptions));
  const largeList = await observe(db, dbPath, () => db.listConversations(accountId));
  assert.equal(large.reads, 1);
  assert.equal(large.snapshots, 1);
  assert.equal(large.queries.length, small.queries.length, 'summary SQL work must not add one query per contact');
  assert.equal(largeList.reads, 1);
  assert.equal(largeList.snapshots, 1);
  assert.equal(largeList.queries.length, smallList.queries.length, 'the legacy contact list must batch unread counts too');
  assert.equal(large.value.conversations.length, 200);
  assert.equal(large.value.totalUnreadCount, 300);
  assert.deepEqual(large.value.conversations.map(({ replyContext, ...conversation }) => conversation), largeList.value);
  const legacyReplies = await Promise.all(largeList.value.map(item => db.peekQqReply({ ...summaryOptions, openId: item.conversation.peerId })));
  assert.deepEqual(large.value.conversations.map(item => item.replyContext), legacyReplies);
  assert.equal(large.value.totalUnreadCount, await db.getTotalUnreadCount(accountId));
  assert.deepEqual(await quotas(), beforeQuotas);
  assert.equal(await db.getChangeStamp(), stamp);
});

test('batched replies respect time boundaries, latest exhaustion, rowid ties, accounts and imported-only history', async (t) => {
  const { db } = await setup(t);
  const options = { appId: accountId, nowSeconds: 1000, windowSeconds: 100, maxReplies: 2 };
  for (const [name, peer, timestamp, app] of [
    ['lower', 'lower', 900], ['upper', 'upper', 1000], ['expired', 'expired', 899], ['future', 'future', 1001],
    ['old-available', 'exhausted', 950], ['new-exhausted', 'exhausted', 960],
    ['tie-first', 'tie', 970], ['tie-second', 'tie', 970], ['foreign', 'tie', 999, 'other-bot'],
  ]) await db.storeQqInbound(inbound(name, peer, timestamp, app));
  await db.reserveQqReply({ ...options, openId: 'exhausted' });
  await db.reserveQqReply({ ...options, openId: 'exhausted' });
  const { context_token, ...archiveMessage } = inbound('archived-only', 'archive', 999);
  const generation = (await db.getSyncSnapshot()).cursor.generation;
  await db.appendRestore([{ key: randomUUID(), originalId: 500, message: archiveMessage }], generation);
  const summary = await db.getQqRecipientSummary(options);
  const byPeer = new Map(summary.conversations.map(item => [item.conversation.peerId, item]));
  assert.equal(byPeer.size, 7);
  assert.equal(byPeer.get('lower').replyContext.messageId, 'lower');
  assert.equal(byPeer.get('upper').replyContext.messageId, 'upper');
  assert.equal(byPeer.get('expired').replyContext, null);
  assert.equal(byPeer.get('future').replyContext, null);
  assert.equal(byPeer.get('exhausted').replyContext, null, 'exhaustion cannot select the older available context');
  assert.deepEqual(byPeer.get('tie').replyContext, { messageId: 'tie-second', sequence: 0, timestamp: 970 });
  assert.equal(byPeer.get('archive').hasLiveInbound, false);
  assert.equal(byPeer.get('archive').replyContext, null);
  assert.equal(byPeer.get('archive').unreadCount, 0);
  assert.equal(summary.totalUnreadCount, 8);
  assert.equal((await db.getQqRecipientSummary({ ...options, appId: 'other-bot' })).conversations[0].replyContext.messageId, 'foreign');
  await db.clearAll();
  const cleared = await db.getQqRecipientSummary(options);
  assert.equal(cleared.totalUnreadCount, 0);
  assert.deepEqual(new Set(cleared.conversations.map(item => item.conversation.peerId)), new Set(['lower', 'upper', 'expired', 'future', 'exhausted', 'tie']));
  assert.ok(cleared.conversations.every(item => item.hasLiveInbound && item.unreadCount === 0));
  assert.equal(cleared.conversations.find(item => item.conversation.peerId === 'exhausted').replyContext, null);
});

test('production history, unread and reply-window queries use their indexes instead of scanning and sorting scoped history', async (t) => {
  const { db, dbPath } = await setup(t);
  await seedContacts(db, 0, 200);
  const scope = { accountId, peerId: recipient(100) };
  const initial = await db.getSyncSnapshot(undefined, undefined, 100, false, scope);
  const captured = await observe(db, dbPath, async () => {
    await db.getRecentMessages(20, undefined, scope);
    await db.getHistoryPage(303, initial.cursor.generation, 20, scope);
    await db.getMessagesFromId(301, scope);
    await db.getSyncSnapshot({ ...initial.cursor, lastId: 300 }, undefined, 100, false, scope);
    await db.getMessageContext({ id: 302 }, initial.cursor.generation, 1, scope);
    await db.findByMessageId(`${recipient(100)}-1`);
    await db.getMessageContext({ messageId: `reference-${recipient(100)}-1` });
    await db.getQqRecipientSummary(summaryOptions);
  });
  const plans = await db.withDatabase(sql => captured.queries.map(({ query, parameters }) => ({
    query, detail: sql.exec(`EXPLAIN QUERY PLAN ${query}`, parameters)[0].values.map(row => String(row[3])).join('\n'),
  })));
  const history = plans.filter(plan => /FROM messages\b/.test(plan.query) && /CASE WHEN direction/.test(plan.query) && /ORDER BY id (?:ASC|DESC)/.test(plan.query));
  assert.ok(history.length >= 6, 'inspect actual page, delta, loaded range and both context-neighbor queries');
  for (const plan of history) {
    assert.match(plan.detail, /USING (?:COVERING )?INDEX messages_conversation_order/, plan.query);
    assert.doesNotMatch(plan.detail, /SCAN messages\b|USE TEMP B-TREE FOR ORDER BY/, plan.query);
  }
  const unread = plans.filter(plan => /COUNT\(\*\)/.test(plan.query) && /m\.imported = 0/.test(plan.query));
  assert.ok(unread.length >= 2, 'inspect scoped unread and grouped recipient unread queries');
  for (const plan of unread) assert.match(plan.detail, /USING (?:COVERING )?INDEX messages_live_inbound/, plan.query);
  const lookup = plans.find(plan => /WHERE message_id = \?\s+ORDER BY id DESC/.test(plan.query));
  assert.ok(lookup);
  assert.match(lookup.detail, /USING (?:COVERING )?INDEX messages_message_lookup/);
  const reference = plans.find(plan => /reference_id IN/.test(plan.query) && !/CASE WHEN direction/.test(plan.query));
  assert.ok(reference);
  assert.match(reference.detail, /messages_reference_lookup/);
  assert.doesNotMatch(reference.detail, /SCAN messages\b/);
  const replyWindow = plans.find(plan => /ROW_NUMBER\(\) OVER/.test(plan.query));
  assert.ok(replyWindow);
  assert.match(replyWindow.detail, /USING (?:COVERING )?INDEX qq_reply_contexts_window/);
});

test('checkpoint saves are monotonic only within one session and credential and redundant operations do not write', async (t) => {
  const { db, open } = await setup(t), other = await open();
  const original = { sessionId: 'session-a', sequence: 10, credentialKey: 'credential-a' };
  assert.equal(await db.getQqGatewayCheckpoint(), undefined);
  await db.saveQqGatewayCheckpoint(original);
  const stamp = await db.getChangeStamp();
  await Promise.all([
    db.saveQqGatewayCheckpoint({ ...original, sequence: 3 }),
    other.saveQqGatewayCheckpoint({ ...original }),
  ]);
  assert.deepEqual(await other.getQqGatewayCheckpoint(), original);
  assert.equal(await db.getChangeStamp(), stamp);
  await other.saveQqGatewayCheckpoint({ ...original, sequence: 11 });
  assert.equal((await db.getQqGatewayCheckpoint()).sequence, 11);
  const newCredential = { ...original, sequence: 1, credentialKey: 'credential-b' };
  await db.saveQqGatewayCheckpoint(newCredential);
  assert.deepEqual(await other.getQqGatewayCheckpoint(), newCredential);
  const newSession = { ...newCredential, sessionId: 'session-b', sequence: 0 };
  await other.saveQqGatewayCheckpoint(newSession);
  const replacementStamp = await db.getChangeStamp();
  await db.clearQqGatewayCheckpoint('session-a');
  assert.deepEqual(await db.getQqGatewayCheckpoint(), newSession);
  assert.equal(await db.getChangeStamp(), replacementStamp);
  await db.clearQqGatewayCheckpoint('session-b');
  assert.equal(await other.getQqGatewayCheckpoint(), undefined);
  const clearedStamp = await db.getChangeStamp();
  await other.clearQqGatewayCheckpoint('session-b');
  await other.clearQqGatewayCheckpoint();
  assert.equal(await db.getChangeStamp(), clearedStamp);
});

test('two database instances persist whole checkpoint tuples and concurrent sequence updates cannot move backward', async (t) => {
  const { db: a, open } = await setup(t), b = await open();
  const base = { sessionId: 'shared-session', sequence: 0, credentialKey: 'shared-credential' };
  await a.saveQqGatewayCheckpoint(base);
  await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? a : b).saveQqGatewayCheckpoint({ ...base, sequence: index % 2 ? 20 - index : index + 1 })));
  assert.deepEqual(await a.getQqGatewayCheckpoint(), { ...base, sequence: 19 });
  for (let index = 0; index < 5; index++) {
    const left = { sessionId: `left-${index}`, sequence: index + 100, credentialKey: `left-secret-${index}` };
    const right = { sessionId: `right-${index}`, sequence: index + 200, credentialKey: `right-secret-${index}` };
    const [, , firstRead, secondRead] = await Promise.all([
      a.saveQqGatewayCheckpoint(left), b.saveQqGatewayCheckpoint(right),
      a.getQqGatewayCheckpoint(), b.getQqGatewayCheckpoint(),
    ]);
    const valid = new Set([JSON.stringify(left), JSON.stringify(right)]);
    assert.ok(valid.has(JSON.stringify(firstRead)), 'readers must see one complete committed session tuple');
    assert.ok(valid.has(JSON.stringify(secondRead)), 'no session, sequence or credential can be mixed between writers');
    assert.ok(valid.has(JSON.stringify(await a.getQqGatewayCheckpoint())));
  }
});

test('checkpoint failures preserve the original disk tuple and message exports never include gateway metadata', async (t) => {
  const { db, open, dbPath } = await setup(t), other = await open();
  await db.insertMessage(inbound('safe-history', 'peer', 100));
  const checkpoint = { sessionId: 'private-session-a', sequence: 77, credentialKey: 'private-credential-a' };
  await db.saveQqGatewayCheckpoint(checkpoint);
  const original = fs.readFileSync(dbPath), stamp = await db.getChangeStamp();
  const rename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (to === dbPath) throw new Error('simulated checkpoint save failure');
    return rename.call(this, from, to);
  };
  try {
    await assert.rejects(other.saveQqGatewayCheckpoint({ sessionId: 'private-session-b', sequence: 1, credentialKey: 'private-credential-b' }), /checkpoint save failure/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(dbPath), original);
  assert.equal(await db.getChangeStamp(), stamp);
  assert.deepEqual(await other.getQqGatewayCheckpoint(), checkpoint);
  const exported = JSON.stringify(await db.exportHistorySnapshot());
  assert.doesNotMatch(exported, /qq_gateway_checkpoint_v1|private-session|private-credential|credentialKey|sessionId/);
  await other.saveQqGatewayCheckpoint({ ...checkpoint, sequence: 78 });
  assert.equal((await db.getQqGatewayCheckpoint()).sequence, 78);
  await db.clearAll();
  assert.deepEqual(await db.getQqGatewayCheckpoint(), { ...checkpoint, sequence: 78 });
});

test('invalid checkpoints and legacy metadata cannot form a resumable session or mutate valid state', async (t) => {
  const { db } = await setup(t);
  for (const [key, value] of [['qq_gateway_session_id', 'legacy-session'], ['qq_gateway_seq', '42'], ['qq_gateway_credential_key', 'legacy-credential']]) {
    await db.setMetadata(key, value);
  }
  assert.equal(await db.getQqGatewayCheckpoint(), undefined);
  for (const encoded of ['not JSON', '{}', JSON.stringify({ sessionId: 'mixed', sequence: 3 })]) {
    await db.setMetadata('qq_gateway_checkpoint_v1', encoded);
    assert.equal(await db.getQqGatewayCheckpoint(), undefined);
  }
  const good = { sessionId: 'valid-session', sequence: 3, credentialKey: 'valid-credential' };
  await db.saveQqGatewayCheckpoint(good);
  const stamp = await db.getChangeStamp();
  for (const value of [null, [], {}, { ...good, sequence: -1 }, { ...good, sequence: 1.5 },
    { ...good, sequence: Number.MAX_SAFE_INTEGER + 1 }, { ...good, sessionId: '' },
    { ...good, credentialKey: '   ' }, { ...good, sessionId: 'bad\0session' }, { ...good, credentialKey: 'x'.repeat(4097) }]) {
    await assert.rejects(db.saveQqGatewayCheckpoint(value));
  }
  assert.deepEqual(await db.getQqGatewayCheckpoint(), good);
  assert.equal(await db.getChangeStamp(), stamp);
});
