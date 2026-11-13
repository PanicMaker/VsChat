const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatDB, message } = require('./runtime.cjs');

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-search-db-'));
  const instances = [];
  const open = async () => {
    const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, 'qq');
    await db.init();
    instances.push(db);
    return db;
  };
  t.after(async () => {
    await Promise.all(instances.map(db => db.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db: await open(), open };
}

const received = (name, content, extra = {}) => ({
  ...message(name), direction: 'received', content,
  from_user_id: 'user', to_user_id: 'bot', ...extra,
});
const ids = result => result.messages.map(msg => msg.id);

test('search reaches beyond the latest history page, bounds results and never marks messages read', async (t) => {
  const { db } = await setup(t);
  for (let i = 1; i <= 130; i++) {
    await db.insertMessage(received(`full-${i}`, i === 5 || i === 117 ? `needle ${i}` : `ordinary ${i}`));
  }
  const baseline = await db.getSyncSnapshot();
  await db.markRead(baseline.cursor.generation, 2);
  const before = await db.getSyncSnapshot();
  const stamp = await db.getChangeStamp();
  assert.ok(!(await db.getRecentMessages()).some(msg => msg.id === 5));

  const found = await db.searchMessages({ query: 'needle' });
  assert.deepEqual(ids(found), [117, 5]);
  assert.equal(found.hasMore, false);
  assert.equal(found.generation, before.cursor.generation);
  assert.equal(found.contentVersion, before.cursor.contentVersion);
  const all = await db.searchMessages({ query: '' });
  assert.equal(all.messages.length, 50);
  assert.equal(all.hasMore, true);
  assert.deepEqual(ids(all), Array.from({ length: 50 }, (_, index) => 130 - index));
  assert.equal((await db.searchMessages({ query: '', limit: 999 })).messages.length, 50);
  await db.getMessageContext({ id: 5 }, before.cursor.generation);

  const after = await db.getSyncSnapshot();
  assert.equal(after.readThroughId, before.readThroughId);
  assert.equal(after.unreadCount, before.unreadCount);
  assert.deepEqual(after.cursor, before.cursor);
  assert.equal(await db.getChangeStamp(), stamp, 'search and context reads must not rewrite the database');
});

test('search treats percent, underscore, backslash and SQL-looking text as literal content', async (t) => {
  const { db } = await setup(t);
  const content = [
    'progress 100% done', 'progress 1000 done', 'snake_case', 'snakeXcase',
    'C:\\logs\\app', 'C:logsapp', "literal ' OR 1=1 -- token", 'percent\\_mixed%',
  ];
  for (let i = 0; i < content.length; i++) await db.insertMessage(received(`literal-${i}`, content[i]));
  for (const [query, expected] of [
    ['%', [8, 1]], ['_', [8, 3]], ['\\', [8, 5]], ['100%', [1]],
    ['snake_', [3]], ['C:\\logs', [5]], ['\\_', [8]], ["' OR 1=1 --", [7]],
    ["'; DROP TABLE messages; --", []],
  ]) {
    assert.deepEqual(ids(await db.searchMessages({ query })), expected, query);
  }
  assert.equal((await db.getRecentMessages()).length, content.length);
});

test('NUL-containing queries are rejected instead of broadening a literal search', async (t) => {
  const { db } = await setup(t);
  await db.insertMessage(received('nul-alpha', 'alpha'));
  await db.insertMessage(received('nul-beta', 'beta'));
  const stamp = await db.getChangeStamp();
  for (const query of ['\0', 'alpha\0', '\0beta', 'al\0pha']) {
    await assert.rejects(db.searchMessages({ query }), /must not contain NUL/);
  }
  assert.deepEqual(ids(await db.searchMessages({ query: 'alpha' })), [1]);
  assert.equal(await db.getChangeStamp(), stamp);
});

test('type and timestamp filters compose with inclusive start and exclusive end', async (t) => {
  const { db } = await setup(t);
  for (const [index, type] of [1, 2, 1, 1, 3, 1, 4, 5].entries()) {
    await db.insertMessage(received(`filter-${index}`, 'match this', { type, timestamp: 100 + index * 10 }));
  }
  assert.deepEqual(ids(await db.searchMessages({
    query: 'match', type: 1, fromTimestamp: 110, toTimestamp: 150,
  })), [4, 3]);
  assert.deepEqual(ids(await db.searchMessages({ query: '', type: 2, fromTimestamp: 110, toTimestamp: 120 })), [2]);
  assert.deepEqual(ids(await db.searchMessages({ query: '', fromTimestamp: 160 })), [8, 7]);
  assert.deepEqual(ids(await db.searchMessages({ query: '', toTimestamp: 110 })), [1]);
  assert.deepEqual(ids(await db.searchMessages({ query: 'absent', type: 1 })), []);
  assert.deepEqual(ids(await db.searchMessages({ query: '', type: 5 })), [8]);
});

test('keyset search pagination has no duplicates or newly inserted rows in subsequent pages', async (t) => {
  const { db, open } = await setup(t);
  const writer = await open();
  for (let i = 1; i <= 125; i++) await db.insertMessage(received(`page-${i}`, `match ${i}`));
  let page = await db.searchMessages({ query: 'match', limit: 17 });
  const generation = page.generation;
  const collected = [...ids(page)];
  await Promise.all(Array.from({ length: 5 }, (_, i) => writer.insertMessage(received(`concurrent-${i}`, `match new ${i}`))));
  while (page.hasMore) {
    page = await db.searchMessages({ query: 'match', limit: 17, beforeId: page.messages.at(-1).id, generation });
    collected.push(...ids(page));
  }
  assert.equal(new Set(collected).size, 125);
  assert.deepEqual(collected, Array.from({ length: 125 }, (_, index) => 125 - index));
  assert.equal((await db.searchMessages({ query: 'match', limit: 1 })).messages[0].id, 130);
});

test('clear invalidates search and context requests while content updates expose a new version', async (t) => {
  const { db, open } = await setup(t), other = await open();
  const targetId = await db.insertMessage(received('before-clear', '<face>'));
  const original = await db.searchMessages({ query: '' });
  const originalContext = await db.getMessageContext({ id: targetId }, original.generation);
  await other.normalizeMessageText(text => text.replace('<face>', '[face]'));
  const normalized = await db.searchMessages({ query: '[face]', generation: original.generation });
  const normalizedContext = await db.getMessageContext({ id: targetId }, original.generation);
  assert.equal(normalized.generation, original.generation);
  assert.ok(normalized.contentVersion > original.contentVersion);
  assert.ok(normalizedContext.contentVersion > originalContext.contentVersion);
  assert.equal(normalizedContext.messages[0].content, '[face]');

  await other.clearAll();
  const replacement = await other.insertMessage(received('after-clear', 'replacement'));
  assert.equal(await db.searchMessages({ query: '', generation: original.generation }), null);
  assert.equal(await db.getMessageContext({ id: replacement }, original.generation), null);
  assert.equal(await db.getMessageContext({ id: targetId }), null);
  const fresh = await db.searchMessages({ query: '' });
  assert.notEqual(fresh.generation, original.generation);
  assert.deepEqual(ids(fresh), [replacement]);
});

test('context windows are bounded, ordered and report history on either side', async (t) => {
  const { db } = await setup(t);
  for (let i = 1; i <= 65; i++) await db.insertMessage(received(`context-${i}`, `row ${i}`));
  const { cursor } = await db.getSyncSnapshot();
  const middle = await db.getMessageContext({ id: 33 }, cursor.generation);
  assert.equal(middle.targetId, 33);
  assert.equal(middle.generation, cursor.generation);
  assert.equal(middle.contentVersion, cursor.contentVersion);
  assert.deepEqual(ids(middle), Array.from({ length: 21 }, (_, index) => 23 + index));
  assert.equal(middle.hasBefore, true);
  assert.equal(middle.hasAfter, true);
  const capped = await db.getMessageContext({ id: 33 }, undefined, 999);
  assert.deepEqual(ids(capped), Array.from({ length: 41 }, (_, index) => 13 + index));
  const first = await db.getMessageContext({ id: 1 }, undefined, 3);
  assert.deepEqual(ids(first), [1, 2, 3, 4]);
  assert.equal(first.hasBefore, false);
  assert.equal(first.hasAfter, true);
  const last = await db.getMessageContext({ id: 65 }, undefined, 3);
  assert.deepEqual(ids(last), [62, 63, 64, 65]);
  assert.equal(last.hasBefore, true);
  assert.equal(last.hasAfter, false);
  const single = await db.getMessageContext({ id: 33 }, undefined, 0);
  assert.deepEqual(ids(single), [33]);
  assert.equal(single.hasBefore, true);
  assert.equal(single.hasAfter, true);
  assert.equal(await db.getMessageContext({ id: 999 }), null);
});

test('context resolves transport and reference IDs with v1 normalization and newest-match ordering', async (t) => {
  const { db } = await setup(t);
  const bare = await db.insertMessage(received('quoted', 'bare target'));
  const prefixed = await db.insertMessage(received('v1:quoted', 'prefixed target'));
  assert.equal((await db.getMessageContext({ messageId: 'quoted' }, undefined, 0)).targetId, prefixed);
  assert.equal((await db.getMessageContext({ messageId: 'v1:quoted' }, undefined, 0)).targetId, prefixed);
  const reference = await db.insertMessage(received('different-message-id', 'reference target', { reference_id: 'quoted' }));
  assert.equal((await db.getMessageContext({ messageId: 'quoted' }, undefined, 0)).targetId, reference);
  assert.equal((await db.getMessageContext({ messageId: 'v1:quoted' }, undefined, 0)).targetId, reference);
  const bareOnly = await db.insertMessage(received('bare-only', 'bare only'));
  assert.equal((await db.getMessageContext({ messageId: 'v1:bare-only' }, undefined, 0)).targetId, bareOnly);
  const refOnly = await db.insertMessage(received('another-id', 'prefixed reference', { reference_id: 'v1:ref-only' }));
  assert.equal((await db.getMessageContext({ messageId: 'ref-only' }, undefined, 0)).targetId, refOnly);
  assert.equal((await db.getMessageContext({ id: bare, messageId: 'quoted' }, undefined, 0)).targetId, bare,
    'an explicit database ID has precedence');
  const injection = await db.insertMessage(received("' OR 1=1 --", 'literal transport identifier'));
  assert.equal((await db.getMessageContext({ messageId: "' OR 1=1 --" }, undefined, 0)).targetId, injection);
  assert.equal(await db.getMessageContext({ messageId: 'not-present' }), null);
});

test('search and context reject invalid bounds instead of issuing broad queries', async (t) => {
  const { db } = await setup(t);
  await db.insertMessage(received('validation', 'valid'));
  for (const options of [
    {}, { query: null }, { query: 1 }, { query: 'x'.repeat(201) },
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map(beforeId => ({ query: '', beforeId })),
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map(limit => ({ query: '', limit })),
    ...[0, 6, -1, 1.5, '1'].map(type => ({ query: '', type })),
    ...[-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].flatMap(value => [
      { query: '', fromTimestamp: value }, { query: '', toTimestamp: value },
    ]),
    { query: '', fromTimestamp: 5, toTimestamp: 5 }, { query: '', fromTimestamp: 6, toTimestamp: 5 },
  ]) await assert.rejects(db.searchMessages(options), JSON.stringify(options));
  assert.deepEqual(ids(await db.searchMessages({ query: 'x'.repeat(200) })), []);
  for (const target of [
    {}, { messageId: '' }, { messageId: 1 },
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map(id => ({ id })),
  ]) await assert.rejects(db.getMessageContext(target));
  for (const radius of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    await assert.rejects(db.getMessageContext({ id: 1 }, undefined, radius));
  }
  assert.deepEqual(ids(await db.searchMessages({ query: '', fromTimestamp: 0 })), [1]);
});
