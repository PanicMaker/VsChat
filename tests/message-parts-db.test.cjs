const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatDB, message } = require('./runtime.cjs');

async function setup(t, channel = 'qq') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-parts-db-'));
  const instances = [];
  const open = async (selected = channel) => {
    const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, selected);
    await db.init();
    instances.push(db);
    return db;
  };
  t.after(async () => {
    await Promise.all(instances.map(db => db.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, open, db: await open() };
}

const inbound = (id, extra = {}) => ({
  ...message(id), direction: 'received', from_user_id: 'user', to_user_id: 'bot',
  context_token: 'fresh-token', ...extra,
});
const parts = () => [
  { type: 1, text: 'body before attachments' },
  { type: 2, url: 'https://example.invalid/image.png', mimeType: 'image/png' },
  { type: 3, text: 'voice transcription', url: 'https://example.invalid/voice.ogg' },
  { type: 4, fileName: 'report.pdf', size: 4096, mimeType: 'application/pdf', url: 'https://example.invalid/report.pdf' },
  { type: 5, url: 'https://example.invalid/video.mp4', mimeType: 'video/mp4' },
];

test('legacy migration adds nullable parts without rewriting old message data', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-parts-legacy-'));
  const SQL = await require('sql.js')();
  const legacy = new SQL.Database();
  legacy.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT, type INTEGER,
    content TEXT, timestamp INTEGER, context_token TEXT, from_user_id TEXT, to_user_id TEXT,
    message_id TEXT, reference_id TEXT, reply_to TEXT
  ); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO messages VALUES (1, 'received', 1, 'legacy body', 1700000000, 'old-token', 'user', 'bot', 'old-id', NULL, NULL);
  INSERT INTO metadata VALUES ('session', 'legacy-session');`);
  const original = Buffer.from(legacy.export());
  legacy.close();
  fs.writeFileSync(path.join(directory, 'vschat_qq_chats.db'), original);
  const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, 'qq');
  t.after(async () => { await db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await db.init();
  const row = (await db.getRecentMessages())[0];
  assert.equal(row.content, 'legacy body');
  assert.equal(row.context_token, 'old-token');
  assert.equal(row.parts, undefined);
  assert.equal(await db.getMetadata('session'), 'legacy-session');
  assert.deepEqual(fs.readFileSync(path.join(directory, 'vschat_qq_chats.db.bak')), original);
  const stored = await db.withDatabase(sql => sql.exec('SELECT parts FROM messages WHERE id = 1'));
  assert.equal(stored[0].values[0][0], null);
});

test('ordered parts roundtrip every history, sync, search and reference lookup without runtime fields', async (t) => {
  const { db, open } = await setup(t);
  const initial = await db.getSyncSnapshot();
  const expected = parts();
  const supplied = expected.map(part => ({
    ...part, imageDataUrl: 'data:image/png;base64,SECRET', ignored: 'discard-me',
    markdown: [{ type: 'text', text: 'runtime-rendered-markdown' }],
  }));
  const id = await db.insertMessage(inbound('multipart', {
    content: 'body before attachments\nreport.pdf', timestamp: 1_700_000_060,
    reference_id: 'multipart-reference', parts: supplied,
    markdown: [{ type: 'text', text: 'runtime-rendered-markdown' }],
  }));
  const snapshot = await db.getSyncSnapshot(initial.cursor);
  const page = await db.getHistoryPage(id + 1, snapshot.cursor.generation);
  const context = await db.getMessageContext({ id });
  const reference = await db.getMessageContext({ messageId: 'multipart-reference' });
  const found = await db.searchMessages({ query: 'report.pdf' });
  const readers = [
    (await db.getRecentMessages())[0],
    (await db.getMessagesFromId(id))[0],
    await db.findByMessageId('multipart'),
    await db.findByTimestamp(1_700_000_060, 0),
    snapshot.messages[0], page.messages[0], context.messages[0], reference.messages[0], found.messages[0],
  ];
  for (const row of readers) {
    assert.deepEqual(row.parts, expected);
    assert.equal(row.markdown, undefined);
  }
  const raw = await db.withDatabase(sql => sql.exec('SELECT parts FROM messages WHERE id = ?', [id]));
  assert.deepEqual(JSON.parse(raw[0].values[0][0]), expected);
  assert.doesNotMatch(raw[0].values[0][0], /SECRET|ignored|imageDataUrl|markdown/);
  const reopened = await open();
  assert.deepEqual((await reopened.findByMessageId('multipart')).parts, expected);
});

test('type search includes matching parts while keeping filename summaries and unread state intact', async (t) => {
  const { db } = await setup(t);
  const mixed = await db.insertMessage(inbound('mixed', { type: 1, content: 'caption report.pdf', parts: parts() }));
  const plain = await db.insertMessage(inbound('plain-file', { type: 4, content: 'legacy-report.pdf' }));
  await db.insertMessage(inbound('text-only', { type: 1, content: 'caption' }));
  const before = await db.getSyncSnapshot();
  const stamp = await db.getChangeStamp();
  for (const type of [2, 3, 5]) {
    assert.deepEqual((await db.searchMessages({ query: '', type })).messages.map(row => row.id), [mixed]);
  }
  assert.deepEqual((await db.searchMessages({ query: 'report.pdf', type: 4 })).messages.map(row => row.id), [plain, mixed]);
  assert.deepEqual((await db.searchMessages({ query: 'caption', type: 2 })).messages.map(row => row.id), [mixed]);
  const after = await db.getSyncSnapshot(before.cursor);
  assert.equal(after.readThroughId, before.readThroughId);
  assert.equal(after.unreadCount, before.unreadCount);
  assert.equal(await db.getChangeStamp(), stamp);
});

test('malformed legacy parts use the old message body and never break type filtering or media updates', async (t) => {
  const { db } = await setup(t);
  const malformed = ['{broken', '{"type":2}', 'null', '42', '[null,4,"bad"]'];
  const ids = [];
  for (let index = 0; index < malformed.length; index++) {
    const id = await db.insertMessage(inbound(`malformed-${index}`, { content: `legacy ${index}` }));
    await db.withDatabase(sql => sql.run('UPDATE messages SET parts = ? WHERE id = ?', [malformed[index], id]), true);
    ids.push(id);
  }
  for (const row of await db.getRecentMessages()) {
    assert.equal(row.parts, undefined);
    assert.match(row.content, /^legacy /);
  }
  assert.deepEqual((await db.searchMessages({ query: '', type: 2 })).messages, []);
  assert.equal((await db.searchMessages({ query: 'legacy', type: 1 })).messages.length, malformed.length);
  const before = await db.getSyncSnapshot();
  const stamp = await db.getChangeStamp();
  for (const id of ids) await db.markMessageMediaReady(id);
  assert.equal(await db.getChangeStamp(), stamp);
  assert.deepEqual((await db.getSyncSnapshot()).cursor, before.cursor);
  await db.normalizeMessageText(value => value);
  assert.deepEqual((await db.getSyncSnapshot()).cursor, before.cursor);
});

test('concurrent WeChat envelopes keep one complete parts list and update routing only for the winner', async (t) => {
  const { db: a, open } = await setup(t, 'wechat'), b = await open();
  const variants = [
    inbound('same-envelope', { content: 'first full envelope', from_user_id: 'peer-a', context_token: 'token-a', timestamp: 1_700_000_010, parts: parts() }),
    inbound('same-envelope', { content: 'second full envelope', from_user_id: 'peer-a', context_token: 'token-b', timestamp: 1_700_000_020, parts: [{ type: 1, text: 'alternative body' }, { type: 4, fileName: 'other.zip' }] }),
  ];
  await a.setMetadata('context_token_stale', '1');
  const results = await Promise.all([a.storeWxInbound(variants[0]), b.storeWxInbound(variants[1])]);
  assert.equal(results.filter(result => result.inserted).length, 1);
  assert.equal(results[0].id, results[1].id);
  const winner = variants[results.findIndex(result => result.inserted)];
  const row = (await a.getRecentMessages())[0];
  assert.equal(row.content, winner.content);
  assert.deepEqual(row.parts, winner.parts);
  assert.equal(await a.getMetadata('from_user_id'), winner.from_user_id);
  assert.equal(await a.getMetadata('to_user_id'), winner.to_user_id);
  assert.equal(await a.getMetadata('context_token'), winner.context_token);
  assert.equal(await a.getMetadata('last_inbound_ts'), String(winner.timestamp));
  assert.equal(await a.getMetadata('context_token_stale'), '');
  const duplicate = await b.storeWxInbound({ ...variants[0], content: 'partial duplicate', parts: [{ type: 1, text: 'partial' }], timestamp: winner.timestamp + 100 });
  assert.equal(duplicate.inserted, false);
  assert.deepEqual((await a.findByMessageId('same-envelope')).parts, winner.parts);
  assert.equal(await a.getMetadata('last_inbound_ts'), String(winner.timestamp));
  assert.equal((await a.getSyncSnapshot()).unreadCount, 1);
});

test('WeChat inbound storage keeps session fields without a new token and never commits partial failure', async (t) => {
  const { db, open } = await setup(t, 'wechat');
  await db.storeWxInbound(inbound('baseline', { parts: parts() }));
  await db.setMetadata('context_token_stale', '1');
  await db.storeWxInbound(inbound('without-token', { context_token: '', timestamp: 1_700_000_030, parts: [{ type: 1, text: 'no token' }] }));
  assert.equal(await db.getMetadata('context_token'), 'fresh-token');
  assert.equal(await db.getMetadata('context_token_stale'), '1');
  const before = await db.getSyncSnapshot();
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated atomic-save failure'); };
  try {
    await assert.rejects(db.storeWxInbound(inbound('failed', { from_user_id: 'wrong-peer', context_token: 'wrong-token', parts: parts() })), /atomic-save failure/);
  } finally { fs.renameSync = rename; }
  assert.equal(await db.findByMessageId('failed'), null);
  assert.equal(await db.getMetadata('from_user_id'), 'user');
  assert.equal(await db.getMetadata('context_token'), 'fresh-token');
  assert.equal(await db.getMetadata('last_inbound_ts'), '1700000030');
  assert.deepEqual((await db.getSyncSnapshot()).cursor, before.cursor);
  const noId = inbound(undefined, { timestamp: 1_700_000_040, parts: [{ type: 1, text: 'without identifier' }] });
  assert.notEqual((await db.storeWxInbound(noId)).id, (await db.storeWxInbound(noId)).id);
  for (const invalid of [
    inbound('wrong-direction', { direction: 'sent' }), inbound('empty-peer', { from_user_id: '' }),
    inbound('empty-bot', { to_user_id: '' }), inbound('bad-time', { timestamp: -1 }),
  ]) await assert.rejects(db.storeWxInbound(invalid));
  const qq = await open('qq');
  await assert.rejects(qq.storeWxInbound(inbound('wrong-channel')));
});

test('QQ inbound deduplication stores complete ordered parts once', async (t) => {
  const { db } = await setup(t);
  const original = inbound('qq-envelope', { content: 'body plus report.pdf', parts: parts() });
  const first = await db.storeQqInbound(original);
  const duplicate = await db.storeQqInbound({ ...original, parts: [{ type: 1, text: 'partial retry' }] });
  assert.equal(first.inserted, true);
  assert.equal(duplicate.inserted, false);
  assert.equal(first.id, duplicate.id);
  assert.deepEqual((await db.findByMessageId('qq-envelope')).parts, original.parts);
});

test('normalization updates text parts and published version while preserving attachment metadata', async (t) => {
  const { db } = await setup(t);
  const expected = [
    { type: 1, text: '<face> inside text' },
    { type: 4, fileName: '<face>.pdf', url: 'https://example.invalid/<face>.pdf', size: 23, mimeType: 'application/pdf' },
  ];
  const id = await db.insertMessage(inbound('normalize-parts', { content: '<face> summary', reply_to: JSON.stringify({ text: '<face> quoted' }), parts: expected }));
  const before = await db.getSyncSnapshot();
  await db.normalizeMessageText(value => value.replaceAll('<face>', '[face]'));
  const after = await db.getSyncSnapshot(before.cursor, id);
  assert.equal(after.reset, true);
  assert.equal(after.messages[0].content, '[face] summary');
  assert.equal(JSON.parse(after.messages[0].reply_to).text, '[face] quoted');
  assert.deepEqual(after.messages[0].parts, [{ type: 1, text: '[face] inside text' }, expected[1]]);
  const partsOnly = await db.insertMessage(inbound('only-parts-change', { content: 'plain summary', parts: [{ type: 1, text: '<face>' }] }));
  const partsBefore = await db.getSyncSnapshot();
  await db.normalizeMessageText(value => value.replaceAll('<face>', '[face]'));
  const partsAfter = await db.getSyncSnapshot(partsBefore.cursor, partsOnly);
  assert.equal(partsAfter.reset, true, 'part-only edits must invalidate other windows');
  assert.ok(partsAfter.cursor.contentVersion > partsBefore.cursor.contentVersion);
  assert.equal(partsAfter.messages[0].parts[0].text, '[face]');
  await db.normalizeMessageText(value => value);
  assert.equal((await db.getSyncSnapshot(partsAfter.cursor)).reset, false);
});

test('media readiness refreshes mixed text/image rows but ignores text/file-only rows', async (t) => {
  const { db } = await setup(t);
  const imageId = await db.insertMessage(inbound('mixed-image', { type: 1, content: 'caption', parts: [{ type: 1, text: 'caption' }, { type: 2, url: 'https://example.invalid/a.png' }] }));
  const fileId = await db.insertMessage(inbound('mixed-file', { type: 1, parts: [{ type: 1, text: 'file' }, { type: 4, fileName: 'a.txt' }] }));
  const before = await db.getSyncSnapshot();
  const stamp = await db.getChangeStamp();
  await db.markMessageMediaReady(fileId);
  assert.equal(await db.getChangeStamp(), stamp);
  await db.markMessageMediaReady(imageId);
  const ready = await db.getSyncSnapshot(before.cursor, imageId);
  assert.equal(ready.reset, true);
  assert.ok(ready.cursor.contentVersion > before.cursor.contentVersion);
  assert.equal(ready.messages[0].id, imageId);
  assert.equal(ready.messages[0].parts[1].type, 2);
});
