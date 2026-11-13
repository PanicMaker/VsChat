const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ChatDB, message } = require('./runtime.cjs');
const { createBackup, parseBackup, exportHistory } = require('../src/chat-archive.ts');

async function setup(t, channel = 'qq') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-archive-db-'));
  const instances = [];
  const open = async () => {
    const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, channel);
    await db.init();
    instances.push(db);
    return db;
  };
  t.after(async () => {
    await Promise.all(instances.map(db => db.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, db: await open(), open };
}

const inbound = (name, extra = {}) => ({
  ...message(name), direction: 'received', from_user_id: 'peer', to_user_id: 'bot',
  context_token: 'private-session-token', ...extra,
});
const archiveRecord = (name, originalId = 1000, extra = {}) => ({
  key: randomUUID(), originalId,
  message: {
    direction: 'received', type: 1, content: `archive ${name}`, timestamp: 1_700_000_000,
    from_user_id: 'archive-peer', to_user_id: 'archive-bot', message_id: name, ...extra,
  },
});
const planCounts = plan => ({ total: plan.total, newCount: plan.newCount, duplicateCount: plan.duplicateCount, conflictCount: plan.conflictCount });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('archive keys migrate once and stay stable across reopen without changing legacy message data', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-archive-legacy-'));
  const SQL = await require('sql.js')();
  const legacy = new SQL.Database();
  legacy.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT, type INTEGER,
    content TEXT, timestamp INTEGER, context_token TEXT, from_user_id TEXT, to_user_id TEXT
  ); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO messages VALUES (1, 'received', 1, 'old body', 1700000000, 'private-legacy-token', 'peer', 'bot');
  INSERT INTO messages VALUES (2, 'sent', 1, 'old reply', 1700000001, '', 'bot', 'peer');
  INSERT INTO metadata VALUES ('session', 'private-routing-value');`);
  const original = Buffer.from(legacy.export());
  legacy.close();
  fs.writeFileSync(path.join(directory, 'vschat_qq_chats.db'), original);
  const instances = [];
  const open = async () => {
    const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, 'qq');
    instances.push(db);
    await db.init();
    return db;
  };
  t.after(async () => {
    await Promise.all(instances.map(db => db.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const db = await open();
  const first = await db.exportHistorySnapshot();
  assert.equal(first.records.length, 2);
  assert.equal(new Set(first.records.map(record => record.key)).size, 2);
  for (const record of first.records) assert.match(record.key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.deepEqual(first.records.map(record => record.originalId), [1, 2]);
  assert.deepEqual(first.records.map(record => record.message.content), ['old body', 'old reply']);
  assert.deepEqual((await db.exportHistorySnapshot()).records, first.records);
  const reopened = await open();
  assert.deepEqual((await reopened.exportHistorySnapshot()).records, first.records);
  assert.equal(await reopened.getMetadata('session'), 'private-routing-value');
  assert.deepEqual(fs.readFileSync(path.join(directory, 'vschat_qq_chats.db.bak')), original);
  assert.ok((await reopened.getRecentMessages()).every(row => row.restored === undefined));
});

test('legacy NULL identities support backup, shareable export and canonical restore deduplication without rewriting history', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-archive-null-identities-'));
  const SQL = await require('sql.js')(), legacy = new SQL.Database();
  legacy.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT, type INTEGER,
    content TEXT, timestamp INTEGER, context_token TEXT, from_user_id TEXT, to_user_id TEXT, message_id TEXT
  ); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO messages VALUES (1, 'received', 1, 'missing sender', 100, 'private-token', NULL, 'bot', 'legacy-one');
  INSERT INTO messages VALUES (2, 'sent', 1, 'missing receiver', 101, '', 'bot', NULL, 'legacy-two');
  INSERT INTO messages VALUES (3, 'received', 1, 'unclassified history', 102, '', NULL, NULL, 'legacy-three');`);
  const original = Buffer.from(legacy.export());
  legacy.close();
  const databasePath = path.join(directory, 'vschat_qq_chats.db');
  fs.writeFileSync(databasePath, original);
  const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, 'qq');
  t.after(async () => { await db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await db.init();
  const identities = () => db.withDatabase(sql => sql.exec('SELECT from_user_id, to_user_id FROM messages ORDER BY id')[0].values);
  const storedIdentities = [[null, 'bot'], ['bot', null], [null, null]];
  assert.deepEqual(await identities(), storedIdentities);
  const before = fs.readFileSync(databasePath), snapshot = await db.exportHistorySnapshot();
  assert.deepEqual(snapshot.records.map(record => [record.message.from_user_id, record.message.to_user_id]),
    [['', 'bot'], ['bot', ''], ['', '']]);
  const backup = parseBackup(createBackup(snapshot, []), 'qq');
  assert.deepEqual(backup.records, snapshot.records);
  const shared = JSON.parse(exportHistory(snapshot, 'json').toString());
  assert.deepEqual(shared.records.map(record => record.content), ['missing sender', 'missing receiver', 'unclassified history']);
  const markdown = exportHistory(snapshot, 'markdown').toString();
  assert.match(markdown, /missing sender/);
  assert.match(markdown, /unclassified history/);
  assert.doesNotMatch(markdown, /private-token/);

  for (const records of [backup.records, backup.records.map(record => ({ ...record, key: randomUUID() }))]) {
    const plan = await db.previewRestore(records);
    assert.deepEqual(planCounts(plan), { total: 3, newCount: 0, duplicateCount: 3, conflictCount: 0 });
    const result = await db.appendRestore(records, plan.generation);
    assert.equal(result.inserted, 0);
    assert.equal(result.skipped, 3);
    assert.equal(result.conflicts, 0);
    assert.deepEqual(result.mapping.map(item => item.id), [1, 2, 3]);
  }
  const conflict = { ...backup.records[0], key: randomUUID(), message: { ...backup.records[0].message, content: 'different body' } };
  assert.deepEqual(planCounts(await db.previewRestore([conflict])), { total: 1, newCount: 0, duplicateCount: 0, conflictCount: 1 });
  assert.deepEqual(await identities(), storedIdentities);
  assert.deepEqual(fs.readFileSync(databasePath), before, 'export and duplicate restore leave original NULL rows untouched');
  assert.deepEqual(fs.readFileSync(`${databasePath}.bak`), original);
  assert.equal((await db.getRecentMessages()).length, 3);
  assert.equal(await db.getTotalUnreadCount(), 0);
});

test('export filters use an inclusive start and exclusive end and exclude routing and runtime data', async (t) => {
  const { db } = await setup(t, 'wechat');
  const fileMedia = { aesKey: '00112233445566778899aabbccddeeff', encryptQueryParam: 'encrypted-query', md5: '0123456789abcdef0123456789abcdef' };
  await db.storeWxInbound(inbound('before-filter', { timestamp: 100, content: 'before' }));
  await db.storeWxInbound(inbound('in-filter', {
    timestamp: 200, content: 'report.pdf', reference_id: 'reference-for-file',
    parts: [
      { type: 1, text: 'caption', markdown: [{ type: 'text', text: 'runtime-rendering' }] },
      { type: 4, fileName: 'report.pdf', url: 'https://example.invalid/report', size: 12, mimeType: 'application/pdf', fileMedia,
        imageDataUrl: 'data:image/png;base64,RUNTIME', fileAction: { canSave: true } },
    ],
  }));
  await db.storeWxInbound(inbound('after-filter', { timestamp: 300, content: 'after' }));
  await db.setMetadata('private-metadata', 'not-for-export');
  const before = await db.getSyncSnapshot();
  const stamp = await db.getChangeStamp();
  const filtered = await db.exportHistorySnapshot({ fromTimestamp: 200, toTimestamp: 300 });
  assert.equal(filtered.channel, 'wechat');
  assert.equal(filtered.generation, before.cursor.generation);
  assert.equal(filtered.contentVersion, before.cursor.contentVersion);
  assert.equal(filtered.records.length, 1);
  assert.equal(filtered.records[0].message.message_id, 'in-filter');
  assert.equal(filtered.records[0].message.reference_id, 'reference-for-file');
  assert.deepEqual(filtered.records[0].message.parts[1].fileMedia, fileMedia);
  const serialized = JSON.stringify(filtered);
  assert.doesNotMatch(serialized, /context_token|private-session-token|private-metadata|not-for-export|markdown|imageDataUrl|fileAction|runtime-rendering/);
  assert.equal(filtered.records[0].message.id, undefined);
  assert.equal(filtered.records[0].message.restored, undefined);
  assert.deepEqual((await db.exportHistorySnapshot({ toTimestamp: 200 })).records.map(record => record.message.content), ['before']);
  assert.deepEqual((await db.exportHistorySnapshot({ fromTimestamp: 300 })).records.map(record => record.message.content), ['after']);
  assert.equal(await db.getChangeStamp(), stamp);
  const after = await db.getSyncSnapshot();
  assert.equal(after.readThroughId, before.readThroughId);
  assert.equal(after.unreadCount, before.unreadCount);
});

test('restore preview is read-only and append maps safe duplicates while skipping conflicting payloads', async (t) => {
  const { db } = await setup(t);
  const existingId = await db.insertMessage(inbound('existing', { content: 'original body' }));
  const original = (await db.exportHistorySnapshot()).records[0];
  const duplicate = { ...original, key: randomUUID(), originalId: 101 };
  const conflict = { ...original, originalId: 102, message: { ...original.message, content: 'conflicting body' } };
  const fresh = archiveRecord('new-entry', 103, { parts: [{ type: 1, text: 'new body' }, { type: 4, fileName: 'sample.txt' }] });
  const records = [duplicate, conflict, fresh];
  const before = await db.getChangeStamp();
  const plan = await db.previewRestore(records);
  assert.deepEqual(planCounts(plan), { total: 3, newCount: 1, duplicateCount: 1, conflictCount: 1 });
  assert.equal(await db.getChangeStamp(), before);
  const result = await db.appendRestore(records, plan.generation);
  assert.equal(result.inserted, 1);
  assert.equal(result.skipped, 2);
  assert.equal(result.conflicts, 1);
  assert.deepEqual(result.mapping.find(entry => entry.key === duplicate.key), { key: duplicate.key, id: existingId, inserted: false });
  assert.equal(result.mapping.some(entry => entry.key === conflict.key), false, 'conflicting media must not map to a live row');
  const freshMap = result.mapping.find(entry => entry.key === fresh.key);
  assert.equal(freshMap.inserted, true);
  assert.equal((await db.findByMessageId('existing')).content, 'original body');
  assert.equal((await db.findByMessageId('existing')).restored, undefined);
  assert.equal((await db.findByMessageId('new-entry')).restored, true);

  const repeat = await db.appendRestore([fresh], plan.generation);
  assert.equal(repeat.inserted, 0);
  assert.equal(repeat.skipped, 1);
  assert.equal(repeat.conflicts, 0);
  assert.deepEqual(repeat.mapping, [{ key: fresh.key, id: freshMap.id, inserted: false }]);
  const exported = await db.exportHistorySnapshot();
  assert.equal(exported.records.find(record => record.message.message_id === 'existing').key, original.key);
  assert.equal(exported.records.find(record => record.message.message_id === 'new-entry').key, fresh.key);
  const roundtrip = await db.appendRestore(exported.records, plan.generation);
  assert.equal(roundtrip.inserted, 0);
  assert.equal(roundtrip.conflicts, 0);
  assert.equal(roundtrip.mapping.length, 2);
});

test('package-local duplicate detection agrees with the restore plan and does not merge unrelated id-less messages', async (t) => {
  const { db } = await setup(t);
  const same = archiveRecord('same-transport-id', 11);
  const duplicate = { ...same, key: randomUUID(), originalId: 12 };
  const conflict = { ...same, key: randomUUID(), originalId: 13, message: { ...same.message, content: 'different' } };
  const idless = archiveRecord('unused', 14);
  delete idless.message.message_id;
  const idlessCopy = { ...idless, key: randomUUID(), originalId: 15, message: { ...idless.message } };
  const records = [same, duplicate, conflict, idless, idlessCopy];
  const plan = await db.previewRestore(records);
  assert.deepEqual(planCounts(plan), { total: 5, newCount: 3, duplicateCount: 1, conflictCount: 1 });
  const result = await db.appendRestore(records, plan.generation);
  assert.equal(result.inserted, 3);
  assert.equal(result.skipped, 2);
  assert.equal(result.conflicts, 1);
  assert.equal(result.mapping.length, 4);
  assert.equal(result.mapping.find(entry => entry.key === same.key).id, result.mapping.find(entry => entry.key === duplicate.key).id);
  assert.notEqual(result.mapping.find(entry => entry.key === idless.key).id, result.mapping.find(entry => entry.key === idlessCopy.key).id);
  assert.equal((await db.getRecentMessages()).length, 3);
});

test('concurrent restore operations and live inserts preserve a single import and stable mappings', async (t) => {
  const { db: a, open } = await setup(t), b = await open();
  const record = archiveRecord('concurrent-import', 500);
  const generation = (await a.previewRestore([record])).generation;
  const [first, second, liveId] = await Promise.all([
    a.appendRestore([record], generation), b.appendRestore([record], generation),
    b.insertMessage(inbound('concurrent-live')),
  ]);
  assert.equal(first.inserted + second.inserted, 1);
  assert.equal(first.skipped + second.skipped, 1);
  assert.equal(first.mapping[0].id, second.mapping[0].id);
  const rows = await a.getRecentMessages();
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.id === liveId).restored, undefined);
  assert.equal(rows.find(row => row.message_id === 'concurrent-import').restored, true);
  assert.equal((await a.getSyncSnapshot()).unreadCount, 1, 'only the concurrently received live row is unread');
});

test('clearing after preview invalidates restore and a failed atomic save leaves rows and keys untouched', async (t) => {
  const { db, open, directory } = await setup(t), peer = await open();
  await db.insertMessage(inbound('survivor-before-clear'));
  const record = archiveRecord('cannot-cross-clear', 700);
  const oldPlan = await db.previewRestore([record]);
  await peer.clearAll();
  await assert.rejects(db.appendRestore([record], oldPlan.generation));
  assert.deepEqual(await db.getRecentMessages(), []);
  const plan = await db.previewRestore([record]);
  const target = path.join(directory, 'vschat_qq_chats.db');
  const original = fs.readFileSync(target);
  const baseline = await db.exportHistorySnapshot();
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated restore save failure'); };
  try {
    await assert.rejects(db.appendRestore([record], plan.generation), /restore save failure/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(target), original);
  assert.deepEqual(await db.exportHistorySnapshot(), baseline);
  const retried = await peer.appendRestore([record], plan.generation);
  assert.equal(retried.inserted, 1);
  assert.equal((await db.exportHistorySnapshot()).records[0].key, record.key);
});

test('restoring history never changes routing, QQ reply quota or shared read progress', async (t) => {
  const { db } = await setup(t);
  await db.storeQqInbound(inbound('live-reply-context', { timestamp: 1_700_000_010 }));
  const reserve = { appId: 'bot', openId: 'peer', messageId: 'live-reply-context', nowSeconds: 1_700_000_011, windowSeconds: 3600, maxReplies: 4 };
  assert.equal((await db.reserveQqReply(reserve)).sequence, 1);
  await db.setMetadata('session', 'private-session-state');
  const keys = ['qq_user_openid', 'qq_last_inbound_message_id', 'qq_last_inbound_timestamp', 'session'];
  const metadata = await Promise.all(keys.map(key => db.getMetadata(key)));
  const before = await db.getSyncSnapshot();
  const imported = archiveRecord('old-inbound', 800, { timestamp: 1_800_000_000, from_user_id: 'different-peer', to_user_id: 'different-bot' });
  const result = await db.appendRestore([imported], before.cursor.generation);
  const importedId = result.mapping[0].id;
  const after = await db.getSyncSnapshot();
  assert.equal(after.unreadCount, before.unreadCount);
  assert.equal(after.readThroughId, before.readThroughId);
  assert.deepEqual(await Promise.all(keys.map(key => db.getMetadata(key))), metadata);
  assert.equal((await db.reserveQqReply(reserve)).sequence, 2);
  await db.notifyRestoredMedia();
  const refreshed = await db.getSyncSnapshot(after.cursor);
  assert.equal(refreshed.reset, true);
  assert.equal(refreshed.cursor.contentVersion, after.cursor.contentVersion + 1);
  assert.equal(refreshed.readThroughId, after.readThroughId);
  assert.equal(refreshed.unreadCount, after.unreadCount);
  assert.deepEqual(await Promise.all(keys.map(key => db.getMetadata(key))), metadata);
  await db.markRead(after.cursor.generation, importedId);
  assert.equal((await db.getSyncSnapshot()).readThroughId, before.readThroughId, 'an imported last row cannot acknowledge earlier live messages');
  const liveId = (await db.findByMessageId('live-reply-context')).id;
  await db.markRead(after.cursor.generation, liveId);
  assert.equal((await db.getSyncSnapshot()).unreadCount, 0);
  await db.insertMessage(inbound('later-live'));
  assert.equal((await db.getSyncSnapshot()).unreadCount, 1);
});

test('async history snapshots retain the shared file lock through the callback and release it on rejection', async (t) => {
  const { db: a, open, directory } = await setup(t), b = await open();
  await a.insertMessage(inbound('snapshot-baseline'));
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const snapshot = a.withHistorySnapshot(async state => {
    entered.resolve();
    await release.promise;
    return state.records.map(record => record.message.message_id);
  });
  await entered.promise;
  assert.equal(fs.existsSync(path.join(directory, 'vschat_qq_chats.db.lock')), true);
  let wrote = false;
  const writer = b.insertMessage(inbound('waits-for-snapshot')).then(value => { wrote = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(wrote, false, 'other instances must not write while the async snapshot callback consumes files');
  release.resolve();
  assert.deepEqual(await snapshot, ['snapshot-baseline']);
  await writer;
  assert.equal((await a.getRecentMessages()).length, 2);
  await assert.rejects(a.withHistorySnapshot(async () => { throw new Error('consumer failed'); }), /consumer failed/);
  await b.insertMessage(inbound('after-failed-consumer'));
  assert.equal((await a.getRecentMessages()).length, 3);
});

test('restore strips untrusted session and runtime fields without applying metadata or reply counters', async (t) => {
  const { db } = await setup(t);
  await db.storeQqInbound(inbound('trusted-reply-context', { timestamp: 1_700_000_010 }));
  const reserve = { appId: 'bot', openId: 'peer', messageId: 'trusted-reply-context', nowSeconds: 1_700_000_011, windowSeconds: 3600, maxReplies: 4 };
  assert.equal((await db.reserveQqReply(reserve)).sequence, 1);
  const keys = ['qq_user_openid', 'qq_last_inbound_message_id', 'qq_last_inbound_timestamp'];
  const metadata = await Promise.all(keys.map(key => db.getMetadata(key)));
  const record = archiveRecord('untrusted-archive-fields', 900, {
    context_token: 'malicious-session-token', restored: false,
    markdown: [{ type: 'text', text: 'runtime-rendering' }],
    metadata: { qq_user_openid: 'untrusted-peer' },
    qq_reply_contexts: [{ sequence: 100 }],
    parts: [{ type: 1, text: 'retained caption', imageDataUrl: 'runtime-image', fileAction: { canSave: true }, markdown: [] }],
  });
  record.metadata = { qq_last_inbound_message_id: 'untrusted-context' };
  const stamp = await db.getChangeStamp();
  const plan = await db.previewRestore([record]);
  assert.equal(plan.newCount, 1);
  assert.equal(await db.getChangeStamp(), stamp);
  await db.appendRestore([record], plan.generation);
  const imported = await db.findByMessageId('untrusted-archive-fields');
  assert.equal(imported.context_token, '');
  assert.equal(imported.restored, true);
  assert.deepEqual(imported.parts, [{ type: 1, text: 'retained caption' }]);
  assert.deepEqual(await Promise.all(keys.map(key => db.getMetadata(key))), metadata);
  assert.equal((await db.reserveQqReply(reserve)).sequence, 2);
  const exported = (await db.exportHistorySnapshot()).records.find(item => item.key === record.key);
  assert.doesNotMatch(JSON.stringify(exported), /context_token|malicious-session-token|restored|markdown|runtime-rendering|metadata|untrusted-peer|qq_reply_contexts|imageDataUrl|runtime-image|fileAction|untrusted-context/);
});

test('strict restore validation rejects invalid schema, repeated identities and oversized packages without writing', async (t) => {
  const { db } = await setup(t);
  const base = archiveRecord('valid-shape');
  const generation = (await db.getSyncSnapshot()).cursor.generation;
  const stamp = await db.getChangeStamp();
  const invalid = [
    { ...base, message: { ...base.message, direction: 'unknown' } },
    { ...base, message: { ...base.message, type: 6 } },
    { ...base, message: { ...base.message, timestamp: -1 } },
    { ...base, message: { ...base.message, content: { body: 'invalid' } } },
    { ...base, message: { ...base.message, parts: [{ type: 4, size: 1.5 }] } },
    { ...base, key: '../invalid-key' },
    { ...base, originalId: 0 },
  ];
  for (const record of invalid) {
    await assert.rejects(db.previewRestore([record]));
    await assert.rejects(db.appendRestore([record], generation));
  }
  for (const records of [
    [base, { ...archiveRecord('duplicate-key', 1001), key: base.key }],
    [base, archiveRecord('duplicate-original-id', base.originalId)],
  ]) {
    await assert.rejects(db.previewRestore(records));
    await assert.rejects(db.appendRestore(records, generation));
  }
  const oversized = Array.from({ length: 10001 }, (_, index) => archiveRecord(`limit-${index}`, index + 1));
  await assert.rejects(db.previewRestore(oversized));
  await assert.rejects(db.appendRestore(oversized, generation));
  assert.equal(await db.getChangeStamp(), stamp);
  assert.deepEqual(await db.getRecentMessages(), []);
});

test('export rejects oversized packages without truncation while locked snapshots cover the full history', async (t) => {
  const { db } = await setup(t);
  await db.withDatabase(sql => {
    sql.run('BEGIN TRANSACTION');
    const insert = sql.prepare(`INSERT INTO messages
      (direction, type, content, timestamp, context_token, from_user_id, to_user_id, archive_key)
      VALUES ('received', 1, ?, ?, '', 'peer', 'bot', ?)`);
    try {
      for (let index = 0; index < 10001; index++) insert.run([`bulk ${index}`, index, randomUUID()]);
      sql.run('COMMIT');
    } finally { insert.free(); }
  }, true);
  const stamp = await db.getChangeStamp();
  await assert.rejects(db.exportHistorySnapshot(), /10000/);
  const full = await db.withHistorySnapshot(async snapshot => ({
    count: snapshot.records.length,
    first: snapshot.records[0].message.content,
    last: snapshot.records.at(-1).message.content,
  }));
  assert.deepEqual(full, { count: 10001, first: 'bulk 0', last: 'bulk 10000' });
  const bounded = await db.exportHistorySnapshot({ fromTimestamp: 1 });
  assert.equal(bounded.records.length, 10000);
  assert.equal(bounded.records[0].message.content, 'bulk 1');
  assert.equal(bounded.records.at(-1).message.content, 'bulk 10000');
  assert.equal(await db.getChangeStamp(), stamp);
});
