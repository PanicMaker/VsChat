const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ChatDB, message } = require('./runtime.cjs');

const A = { accountId: 'bot-one', peerId: 'alice' };
const B = { accountId: 'bot-one', peerId: 'bob' };
const C = { accountId: 'bot-two', peerId: 'alice' };
const identity = scope => JSON.stringify([scope.accountId, scope.peerId]);
const scoped = (name, scope = A, direction = 'received', extra = {}) => ({
  ...message(name), direction,
  from_user_id: direction === 'received' ? scope.peerId : scope.accountId,
  to_user_id: direction === 'received' ? scope.accountId : scope.peerId,
  ...extra,
});
const ids = rows => rows.map(row => row.id);
const sync = (db, scope, cursor, start, limit = 100, force = false) => db.getSyncSnapshot(cursor, start, limit, force, scope);
const options = (scope, extra = {}) => ({ appId: scope.accountId, openId: scope.peerId, nowSeconds: 200, windowSeconds: 3600, maxReplies: 2, ...extra });
const imported = (name, scope, originalId, extra = {}) => {
  const { context_token, ...body } = scoped(name, scope, 'received', extra);
  return { key: randomUUID(), originalId, message: body };
};

async function setup(t, channel = 'qq') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-recipient-db-'));
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

test('scoped snapshots, paging and reconnects isolate each bot and peer and reset on recipient switches', async (t) => {
  const { db, open } = await setup(t), peer = await open();
  const a1 = await db.insertMessage(scoped('a1'));
  const b1 = await db.insertMessage(scoped('b1', B));
  await db.insertMessage(scoped('c1', C));
  const a2 = await db.insertMessage(scoped('a2', A, 'sent'));
  const b2 = await db.insertMessage(scoped('b2', B, 'sent'));
  const a3 = await db.insertMessage(scoped('a3'));
  await db.insertMessage(scoped('c2', C, 'sent'));
  const b3 = await db.insertMessage(scoped('b3', B));
  const initial = await sync(db, A, undefined, undefined, 2);
  assert.equal(initial.cursor.conversationId, identity(A));
  assert.deepEqual(ids(initial.messages), [a2, a3]);
  assert.equal(initial.hasMore, true);
  assert.equal(initial.unreadCount, 2);
  const older = await db.getHistoryPage(a2, initial.cursor.generation, 2, A);
  assert.deepEqual(ids(older.messages), [a1]);
  assert.equal(older.hasMore, false);
  assert.deepEqual(ids(await db.getRecentMessages(2, a3, A)), [a1, a2]);
  assert.deepEqual(ids(await db.getMessagesFromId(a2, A)), [a2, a3]);
  const switched = await sync(db, B, initial.cursor, a3, 2);
  assert.equal(switched.reset, true);
  assert.equal(switched.cursor.conversationId, identity(B));
  assert.deepEqual(ids(switched.messages), [b2, b3], 'a previous recipient loaded range must not truncate the new recipient');
  assert.equal(switched.hasMore, true);
  assert.deepEqual(ids((await db.getHistoryPage(b2, switched.cursor.generation, 2, B)).messages), [b1]);
  const refreshed = await sync(db, A, initial.cursor, a1, 2, true);
  assert.equal(refreshed.reset, true);
  assert.deepEqual(ids(refreshed.messages), [a1, a2, a3]);
  await peer.insertMessage(scoped('only-b-changed', B));
  const noChange = await sync(db, A, refreshed.cursor);
  assert.equal(noChange.reset, false);
  assert.deepEqual(noChange.messages, []);
  const a4 = await peer.insertMessage(scoped('a4'));
  assert.deepEqual(ids((await sync(db, A, noChange.cursor)).messages), [a4]);
  assert.equal((await sync(db, C)).messages.length, 2);
});

test('search, exact lookups and bounded quote context never return neighbors or references from other recipients', async (t) => {
  const { db } = await setup(t);
  await db.insertMessage(scoped('b-before', B, 'received', { content: 'needle' }));
  const first = await db.insertMessage(scoped('a-first', A, 'received', { content: 'needle first', timestamp: 100 }));
  await db.insertMessage(scoped('b-middle', B, 'received', { content: 'needle', reference_id: 'shared-reference', timestamp: 100 }));
  await db.insertMessage(scoped('c-middle', C, 'received', { content: 'needle', reference_id: 'shared-reference', timestamp: 100 }));
  const middle = await db.insertMessage(scoped('a-middle', A, 'sent', { content: 'needle middle', reference_id: 'v1:shared-reference', timestamp: 100 }));
  await db.insertMessage(scoped('b-later', B, 'received', { content: 'needle' }));
  await db.insertMessage(scoped('c-later', C, 'received', { content: 'needle' }));
  const last = await db.insertMessage(scoped('a-last', A, 'received', { content: 'needle report.pdf', parts: [{ type: 4, fileName: 'report.pdf' }] }));
  const foreign = await db.insertMessage(scoped('b-last', B, 'received', { content: 'needle', reference_id: 'shared-reference', timestamp: 100 }));
  const generation = (await sync(db, A)).cursor.generation;
  assert.deepEqual(ids((await db.searchMessages({ query: 'needle', conversation: A })).messages), [last, middle, first]);
  assert.deepEqual(ids((await db.searchMessages({ query: 'needle', conversation: A, beforeId: last, limit: 1 })).messages), [middle]);
  assert.deepEqual(ids((await db.searchMessages({ query: '', conversation: A, type: 4 })).messages), [last]);
  assert.equal((await db.findByMessageId('a-middle', A)).id, middle);
  assert.equal(await db.findByMessageId('b-last', A), null);
  assert.equal((await db.findByTimestamp(100, 0, A)).id, middle);
  const reference = await db.getMessageContext({ messageId: 'shared-reference' }, generation, A);
  assert.equal(reference.targetId, middle);
  assert.deepEqual(ids(reference.messages), [first, middle, last]);
  assert.equal(await db.getMessageContext({ id: foreign }, generation, 1, A), null);
  const zero = await db.getMessageContext({ id: middle }, generation, 0, A);
  assert.deepEqual(ids(zero.messages), [middle]);
  assert.equal(zero.hasBefore, true);
  assert.equal(zero.hasAfter, true);
  const earliest = await db.getMessageContext({ id: first }, generation, 0, A);
  const latest = await db.getMessageContext({ id: last }, generation, 0, A);
  assert.equal(earliest.hasBefore, false);
  assert.equal(latest.hasAfter, false);
  const sqlLikeScope = { accountId: "bot-one' OR 1=1 --", peerId: 'alice' };
  assert.deepEqual((await sync(db, sqlLikeScope)).messages, []);
  assert.deepEqual((await db.searchMessages({ query: '', conversation: sqlLikeScope })).messages, []);
  assert.equal(await db.getMessageContext({ messageId: 'shared-reference' }, generation, sqlLikeScope), null);
});

test('transport deduplication uses direction, bot account and peer without merging complete envelopes', async (t) => {
  const { db, open } = await setup(t), other = await open();
  const input = scoped('shared-id', A, 'received', { content: 'original A', parts: [{ type: 1, text: 'original A' }, { type: 4, fileName: 'a.txt' }] });
  const [first, duplicate] = await Promise.all([db.storeQqInbound(input), other.storeQqInbound(input)]);
  assert.equal(first.id, duplicate.id);
  assert.equal(Number(first.inserted) + Number(duplicate.inserted), 1);
  const b = await db.storeQqInbound(scoped('shared-id', B, 'received', { content: 'B' }));
  const c = await db.storeQqInbound(scoped('shared-id', C, 'received', { content: 'C' }));
  const outgoing = await db.insertMessage(scoped('shared-id', A, 'sent', { content: 'A sent' }));
  assert.equal(new Set([first.id, b.id, c.id, outgoing]).size, 4);
  const repeated = await other.storeQqInbound({ ...input, content: 'truncated duplicate', parts: [{ type: 1, text: 'truncated' }] });
  assert.equal(repeated.inserted, false);
  const original = (await db.getRecentMessages(100, undefined, A)).find(row => row.id === first.id);
  assert.equal(original.content, 'original A');
  assert.deepEqual(original.parts, input.parts);
  assert.equal((await db.findByMessageId('shared-id', B)).content, 'B');
  assert.equal((await db.findByMessageId('shared-id', C)).content, 'C');
});

test('conversation read cursors are monotonic and cannot acknowledge another peer or imported history', async (t) => {
  const { db, open } = await setup(t), other = await open();
  const a1 = await db.insertMessage(scoped('a-unread-1'));
  await db.insertMessage(scoped('b-unread-1', B));
  await db.insertMessage(scoped('c-unread-1', C));
  const a2 = await db.insertMessage(scoped('a-unread-2'));
  const b2 = await db.insertMessage(scoped('b-unread-2', B));
  const initial = await sync(db, A);
  assert.equal(await db.getTotalUnreadCount(), 5);
  assert.equal(await db.getTotalUnreadCount(A.accountId), 4);
  await db.markRead(initial.cursor.generation, b2, A);
  assert.equal((await sync(db, A)).unreadCount, 2);
  assert.equal((await sync(db, B)).unreadCount, 2);
  await Promise.all([db.markRead(initial.cursor.generation, a2, A), other.markRead(initial.cursor.generation, a1, A)]);
  const read = await sync(db, A);
  assert.equal(read.readThroughId, a2);
  assert.equal(read.unreadCount, 0);
  assert.equal((await sync(db, B)).unreadCount, 2);
  assert.equal(await db.getTotalUnreadCount(A.accountId), 2);
  const a3 = await db.insertMessage(scoped('a-unread-3'));
  const result = await db.appendRestore([imported('archived-A', A, 1000)], initial.cursor.generation);
  await other.markRead(initial.cursor.generation, result.mapping[0].id, A);
  assert.equal((await sync(db, A)).readThroughId, a2);
  assert.equal((await sync(db, A)).unreadCount, 1);
  await other.markRead(initial.cursor.generation, a3, A);
  assert.equal((await sync(db, A)).unreadCount, 0);
  assert.equal(await db.getTotalUnreadCount(), 3);
});

test('legacy global read progress seeds every conversation once without losing pending unread messages', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-recipient-legacy-'));
  const SQL = await require('sql.js')(), legacy = new SQL.Database();
  const generation = randomUUID();
  legacy.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT, type INTEGER, content TEXT,
    timestamp INTEGER, context_token TEXT, from_user_id TEXT, to_user_id TEXT
  ); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);`);
  for (const [index, scope] of [A, B, A, B, C].entries()) {
    legacy.run("INSERT INTO messages VALUES (?, 'received', 1, ?, 100, '', ?, ?)", [index + 1, `legacy ${index + 1}`, scope.peerId, scope.accountId]);
  }
  for (const [key, value] of [['vschat_sync_generation', generation], ['vschat_sync_content_version', '0'], ['vschat_sync_read_through', '2']]) {
    legacy.run('INSERT INTO metadata VALUES (?, ?)', [key, value]);
  }
  fs.writeFileSync(path.join(directory, 'vschat_qq_chats.db'), Buffer.from(legacy.export()));
  legacy.close();
  const instances = [];
  const open = async () => {
    const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, 'qq');
    await db.init(); instances.push(db); return db;
  };
  t.after(async () => { await Promise.all(instances.map(db => db.close())); fs.rmSync(directory, { recursive: true, force: true }); });
  const first = await open();
  for (const scope of [A, B, C]) assert.equal((await sync(first, scope)).unreadCount, 1);
  await first.markRead(generation, 3, A);
  const reopened = await open();
  assert.equal((await sync(reopened, A)).unreadCount, 0);
  assert.equal((await sync(reopened, A)).readThroughId, 3);
  assert.equal((await sync(reopened, B)).unreadCount, 1);
  assert.equal((await sync(reopened, C)).unreadCount, 1);
  assert.equal(await reopened.getTotalUnreadCount(), 2);
  const d = { accountId: 'new-bot', peerId: 'new-peer' };
  await reopened.insertMessage(scoped('new-conversation', d));
  assert.equal((await sync(reopened, d)).unreadCount, 1);
});

test('clear resets scoped read progress and stale generation requests cannot affect new conversations', async (t) => {
  const { db, open } = await setup(t), other = await open();
  const oldId = await db.storeQqInbound(scoped('before-clear', A, 'received', { timestamp: 100 }));
  const before = await sync(db, A);
  await db.markRead(before.cursor.generation, oldId.id, A);
  await other.clearAll();
  const fresh = await other.insertMessage(scoped('after-clear'));
  await db.markRead(before.cursor.generation, fresh, A);
  const after = await sync(db, A, before.cursor, oldId.id);
  assert.equal(after.reset, true);
  assert.notEqual(after.cursor.generation, before.cursor.generation);
  assert.deepEqual(ids(after.messages), [fresh]);
  assert.equal(after.readThroughId, 0);
  assert.equal(after.unreadCount, 1);
  assert.equal(await db.getHistoryPage(fresh + 1, before.cursor.generation, 100, A), null);
  assert.equal(await db.getMessageContext({ id: fresh }, before.cursor.generation, A), null);
  assert.equal(await db.searchMessages({ query: '', conversation: A, generation: before.cursor.generation }), null);
});

test('archive identity spans bots and peers while restored-only contacts never gain a live sending context', async (t) => {
  const { db } = await setup(t);
  const records = [imported('same-archived-transport', A, 11), imported('same-archived-transport', B, 12), imported('same-archived-transport', C, 13)];
  const plan = await db.previewRestore(records);
  assert.equal(plan.newCount, 3);
  assert.equal(plan.conflictCount, 0);
  const restored = await db.appendRestore(records, plan.generation);
  assert.equal(restored.inserted, 3);
  assert.equal(new Set(restored.mapping.map(row => row.id)).size, 3);
  const a = await db.listConversations(A.accountId);
  assert.deepEqual(new Set(a.map(row => identity(row.conversation))), new Set([identity(A), identity(B)]));
  assert.ok(a.every(row => row.hasLiveInbound === false && row.unreadCount === 0));
  const c = await db.listConversations(C.accountId);
  assert.deepEqual(c.map(row => row.conversation), [C]);
  assert.equal(c[0].hasLiveInbound, false);
  assert.equal(await db.peekQqReply(options(A)), null);
  assert.equal(await db.getTotalUnreadCount(), 0);
  const exported = await db.exportHistorySnapshot();
  assert.deepEqual(exported.records.map(row => row.key), records.map(row => row.key));
  const roundtrip = await db.appendRestore(exported.records, plan.generation);
  assert.equal(roundtrip.inserted, 0);
  assert.equal(roundtrip.skipped, 3);
  assert.equal(roundtrip.conflicts, 0);
  const aliases = exported.records.map((record, index) => ({ ...record, key: randomUUID(), originalId: index + 100 }));
  assert.equal((await db.previewRestore(aliases)).duplicateCount, 3);
  assert.equal((await db.appendRestore(aliases, plan.generation)).skipped, 3);
  await db.clearAll();
  assert.deepEqual(await db.listConversations(A.accountId), []);
});

test('WeChat routes isolate sessions, accounts and peers and token invalidation uses compare-and-set', async (t) => {
  const { db, open } = await setup(t, 'wechat'), other = await open();
  await db.storeWxInbound(scoped('wx-shared-id', A, 'received', { timestamp: 100, context_token: 'token-a' }), 'session-one');
  await db.storeWxInbound(scoped('wx-shared-id', B, 'received', { timestamp: 101, context_token: '' }), 'session-one');
  await db.storeWxInbound(scoped('wx-shared-id', C, 'received', { timestamp: 102, context_token: 'token-c' }), 'session-one');
  await db.storeWxInbound(scoped('wx-shared-id', A, 'received', { timestamp: 103, context_token: 'token-session-two' }), 'session-two');
  const routes = new Map((await db.getWxRoutes('session-one')).map(route => [identity(route), route]));
  assert.equal(routes.size, 3);
  assert.equal(routes.get(identity(A)).contextToken, 'token-a');
  assert.equal(routes.get(identity(B)).contextToken, '', 'a tokenless peer must not inherit another peer context');
  assert.equal(routes.get(identity(C)).contextToken, 'token-c');
  assert.deepEqual(await db.getWxRoutes('unknown-session'), []);
  assert.equal((await db.getWxRoutes('session-two')).length, 1);
  assert.equal((await db.getRecentMessages()).length, 3, 'a new session restores routing without duplicating the same peer envelope');
  const duplicate = await other.storeWxInbound(scoped('wx-shared-id', A, 'received', { timestamp: 500, context_token: 'duplicate-token' }), 'session-one');
  assert.equal(duplicate.inserted, false);
  assert.equal((await db.getWxRoutes('session-one')).find(route => identity(route) === identity(A)).timestamp, 100);
  await other.storeWxInbound(scoped('wx-a-new-token', A, 'received', { timestamp: 104, context_token: 'fresh-token' }), 'session-one');
  await db.invalidateWxRecipientToken('session-one', A, 'token-a');
  assert.equal((await db.getWxRoutes('session-one')).find(route => identity(route) === identity(A)).contextToken, 'fresh-token');
  await db.invalidateWxRecipientToken('session-one', A, 'fresh-token');
  assert.equal((await db.getWxRoutes('session-one')).find(route => identity(route) === identity(A)).contextToken, '');
  assert.equal((await db.getWxRoutes('session-two'))[0].contextToken, 'token-session-two');
  assert.equal((await db.getWxRoutes('session-one')).find(route => identity(route) === identity(C)).contextToken, 'token-c');
  await db.clearAll();
  assert.equal((await db.getWxRoutes('session-one')).length, 3);
  assert.deepEqual(new Set((await db.listConversations(A.accountId)).map(row => identity(row.conversation))), new Set([identity(A), identity(B)]));
});

test('QQ reply peeks are read-only, exhausted newest contexts do not fall back, and live contacts survive history clearing', async (t) => {
  const { db } = await setup(t);
  await db.storeQqInbound(scoped('older', A, 'received', { timestamp: 100 }));
  await db.storeQqInbound(scoped('newest', A, 'received', { timestamp: 101 }));
  await db.storeQqInbound(scoped('b-context', B, 'received', { timestamp: 102 }));
  await db.storeQqInbound(scoped('c-context', C, 'received', { timestamp: 103 }));
  const stamp = await db.getChangeStamp();
  assert.deepEqual(await db.peekQqReply(options(A)), { messageId: 'newest', sequence: 0, timestamp: 101 });
  assert.deepEqual(await db.peekQqReply(options(A)), { messageId: 'newest', sequence: 0, timestamp: 101 });
  assert.equal(await db.getChangeStamp(), stamp);
  assert.equal((await db.reserveQqReply(options(A))).sequence, 1);
  assert.equal((await db.peekQqReply(options(A))).sequence, 1);
  assert.equal((await db.reserveQqReply(options(A))).sequence, 2);
  assert.equal(await db.peekQqReply(options(A)), null);
  assert.equal((await db.peekQqReply(options(A, { messageId: 'older' }))).sequence, 0);
  assert.equal((await db.peekQqReply(options(B))).sequence, 0);
  assert.equal((await db.peekQqReply(options(C))).sequence, 0);
  const contacts = await db.listConversations(A.accountId);
  assert.deepEqual(new Set(contacts.map(row => identity(row.conversation))), new Set([identity(A), identity(B)]));
  assert.ok(contacts.every(row => row.hasLiveInbound));
  assert.equal(contacts.find(row => identity(row.conversation) === identity(A)).unreadCount, 2);
  await db.clearAll();
  const remaining = await db.listConversations(A.accountId);
  assert.deepEqual(new Set(remaining.map(row => identity(row.conversation))), new Set([identity(A), identity(B)]));
  assert.ok(remaining.every(row => row.hasLiveInbound && row.unreadCount === 0));
  assert.equal(remaining.find(row => identity(row.conversation) === identity(A)).lastTimestamp, 101);
  assert.equal(await db.peekQqReply(options(A)), null);
  assert.equal((await db.reserveQqReply(options(B))).sequence, 1);
});

test('a real WeChat replay can establish a missing route for imported history without rewriting the archived row or global routing', async (t) => {
  const { db } = await setup(t, 'wechat');
  const record = imported('wx-restored-then-live', A, 500, { timestamp: 100, content: 'original archive body' });
  const generation = (await sync(db, A)).cursor.generation;
  await db.appendRestore([record], generation);
  const globalKeys = ['from_user_id', 'to_user_id', 'context_token', 'last_inbound_ts', 'context_token_stale'];
  for (const key of globalKeys) await db.setMetadata(key, `existing-${key}`);
  const globalBefore = await Promise.all(globalKeys.map(key => db.getMetadata(key)));
  assert.deepEqual(await db.getWxRoutes('active-session'), []);
  assert.equal((await db.listConversations(A.accountId))[0].hasLiveInbound, false);
  const replay = await db.storeWxInbound(scoped('wx-restored-then-live', A, 'received', {
    timestamp: 101, content: 'replay must not overwrite', context_token: 'live-context',
  }), 'active-session');
  assert.equal(replay.inserted, false);
  assert.deepEqual(await db.getWxRoutes('active-session'), [{ ...A, contextToken: 'live-context', timestamp: 101 }]);
  assert.equal((await db.listConversations(A.accountId))[0].hasLiveInbound, true);
  const archived = await db.findByMessageId('wx-restored-then-live', A);
  assert.equal(archived.restored, true);
  assert.equal(archived.content, 'original archive body');
  assert.equal(archived.timestamp, 100);
  assert.equal((await sync(db, A)).unreadCount, 0);
  assert.deepEqual(await Promise.all(globalKeys.map(key => db.getMetadata(key))), globalBefore);
  await db.storeWxInbound(scoped('wx-restored-then-live', A, 'received', {
    timestamp: 102, context_token: 'duplicate-replay-context',
  }), 'active-session');
  assert.deepEqual(await db.getWxRoutes('active-session'), [{ ...A, contextToken: 'live-context', timestamp: 101 }]);
});

test('a real QQ replay activates an imported-only contact without unread messages or consuming reply quota', async (t) => {
  const { db } = await setup(t);
  const record = imported('qq-restored-then-live', A, 600, { timestamp: 100, content: 'archive retained' });
  const generation = (await sync(db, A)).cursor.generation;
  await db.appendRestore([record], generation);
  assert.equal((await db.listConversations(A.accountId))[0].hasLiveInbound, false);
  assert.equal(await db.peekQqReply(options(A)), null);
  const received = await db.storeQqInbound(scoped('qq-restored-then-live', A, 'received', { timestamp: 101, content: 'replay discarded' }));
  assert.equal(received.inserted, false);
  assert.equal((await db.listConversations(A.accountId))[0].hasLiveInbound, true);
  assert.deepEqual(await db.peekQqReply(options(A)), { messageId: 'qq-restored-then-live', sequence: 0, timestamp: 101 });
  assert.equal((await sync(db, A)).unreadCount, 0);
  assert.equal((await db.findByMessageId('qq-restored-then-live', A)).content, 'archive retained');
  assert.equal((await db.findByMessageId('qq-restored-then-live', A)).restored, true);
  assert.equal((await db.reserveQqReply(options(A))).sequence, 1);
});
