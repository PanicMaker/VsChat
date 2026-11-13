const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ChatDB, message } = require('./runtime.cjs');

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-sync-db-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function open(directory, channel = 'qq') {
  const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, channel);
  await db.init();
  return db;
}

const received = (id) => ({ ...message(id), direction: 'received', from_user_id: 'user', to_user_id: 'bot' });

function worker(directory, command, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'sync-db-worker.cjs'), directory, command, ...args.map(String)]);
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(errors || `worker exited ${code}`));
      else resolve(output ? JSON.parse(output) : undefined);
    });
  });
}

test('shared snapshots return only new rows while unread state advances monotonically across instances', async (t) => {
  const directory = temporary(t), a = await open(directory), b = await open(directory);
  const initial = await a.getSyncSnapshot();
  assert.equal(initial.reset, true);
  assert.deepEqual(initial.messages, []);
  assert.equal(initial.unreadCount, 0);
  const first = await b.insertMessage(received('first'));
  await b.insertMessage(message('outgoing'));
  const third = await b.insertMessage(received('third'));
  const fourth = await b.insertMessage(received('fourth'));
  const update = await a.getSyncSnapshot(initial.cursor);
  assert.equal(update.reset, false);
  assert.deepEqual(update.messages.map(msg => msg.id), [first, first + 1, third, fourth]);
  assert.equal(update.cursor.lastId, fourth);
  assert.equal(update.unreadCount, 3, 'outgoing messages are never unread');

  await Promise.all([a.markRead(update.cursor.generation, third), b.markRead(update.cursor.generation, first)]);
  await b.setMetadata('gateway-session', 'updated');
  const read = await b.getSyncSnapshot(update.cursor);
  assert.equal(read.readThroughId, third);
  assert.equal(read.unreadCount, 1);
  assert.deepEqual(read.messages, []);
  assert.equal(read.reset, false);
  assert.equal(read.cursor.contentVersion, update.cursor.contentVersion);
  assert.equal(await a.insertMessage(received('fourth')), fourth, 'duplicate transport events retain their existing row');
  assert.equal((await b.getSyncSnapshot(read.cursor)).unreadCount, 1);
  await a.close();
  await b.close();
});

test('clear rotates history generation and stale readers cannot mark replacement messages read', async (t) => {
  const directory = temporary(t), a = await open(directory), b = await open(directory);
  await a.storeQqInbound(received('reply-context'));
  await a.setMetadata('session', 'must-survive');
  const reserve = { appId: 'bot', openId: 'user', messageId: 'reply-context', nowSeconds: 1_700_000_001, windowSeconds: 3600, maxReplies: 4 };
  assert.equal((await a.reserveQqReply(reserve)).sequence, 1);
  const before = await a.getSyncSnapshot();
  await b.clearAll();
  const newId = await b.insertMessage(received('after-clear'));
  await a.markRead(before.cursor.generation, Number.MAX_SAFE_INTEGER);
  const after = await a.getSyncSnapshot(before.cursor, before.messages[0].id);
  assert.equal(after.reset, true);
  assert.notEqual(after.cursor.generation, before.cursor.generation);
  assert.ok(after.cursor.contentVersion > before.cursor.contentVersion);
  assert.deepEqual(after.messages.map(msg => msg.message_id), ['after-clear']);
  assert.equal(after.cursor.lastId, newId);
  assert.equal(after.readThroughId, 0);
  assert.equal(after.unreadCount, 1);
  assert.equal(await a.getHistoryPage(newId + 1, before.cursor.generation), null);
  assert.equal(await a.getMetadata('session'), 'must-survive');
  assert.equal((await a.reserveQqReply(reserve)).sequence, 2, 'clearing display history must preserve reply quota');
  await a.close();
  await b.close();
});

test('normalization refreshes the loaded range and paging rejects a cleared generation', async (t) => {
  const directory = temporary(t), a = await open(directory), b = await open(directory);
  for (let i = 1; i <= 6; i++) await a.insertMessage({ ...received(`row-${i}`), content: `<face> ${i}` });
  const initial = await a.getSyncSnapshot(undefined, undefined, 2);
  assert.deepEqual(initial.messages.map(msg => msg.id), [5, 6]);
  assert.equal(initial.hasMore, true);
  const older = await a.getHistoryPage(5, initial.cursor.generation, 2);
  assert.deepEqual(older.messages.map(msg => msg.id), [3, 4]);
  assert.equal(older.generation, initial.cursor.generation);
  assert.equal(older.contentVersion, initial.cursor.contentVersion);
  assert.equal(older.hasMore, true);
  const oldest = await a.getHistoryPage(3, initial.cursor.generation, 2);
  assert.deepEqual(oldest.messages.map(msg => msg.id), [1, 2]);
  assert.equal(oldest.hasMore, false);

  const forced = await a.getSyncSnapshot(initial.cursor, 3, 2, true);
  assert.equal(forced.reset, true);
  assert.deepEqual(forced.messages.map(msg => msg.id), [3, 4, 5, 6]);
  assert.deepEqual(forced.cursor, initial.cursor, 'forced refresh retains the database cursor');
  assert.equal(forced.hasMore, true);

  await b.normalizeMessageText(value => value.replace('<face>', '[face]'));
  const updatedPage = await a.getHistoryPage(5, initial.cursor.generation, 2);
  assert.equal(updatedPage.generation, older.generation);
  assert.ok(updatedPage.contentVersion > older.contentVersion,
    'a page from the same clear generation must expose changed content');
  assert.equal(updatedPage.messages[0].content, '[face] 3');
  await b.insertMessage(received('new-row'));
  const refreshed = await a.getSyncSnapshot(initial.cursor, 3, 2);
  assert.equal(refreshed.reset, true);
  assert.equal(refreshed.cursor.generation, initial.cursor.generation);
  assert.ok(refreshed.cursor.contentVersion > initial.cursor.contentVersion);
  assert.deepEqual(refreshed.messages.map(msg => msg.id), [3, 4, 5, 6, 7]);
  assert.equal(refreshed.messages[0].content, '[face] 3');
  assert.equal(refreshed.hasMore, true);
  assert.equal(refreshed.unreadCount, 7);
  await b.normalizeMessageText(value => value);
  const unchanged = await a.getSyncSnapshot(refreshed.cursor, 3, 2);
  assert.equal(unchanged.reset, false);
  assert.deepEqual(unchanged.messages, []);
  await b.clearAll();
  assert.equal(await a.getHistoryPage(3, initial.cursor.generation, 2), null);
  await a.close();
  await b.close();
});

test('legacy migration marks existing history read only once and channels keep separate read cursors', async (t) => {
  const directory = temporary(t);
  const SQL = await require('sql.js')();
  const legacy = new SQL.Database();
  legacy.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT, type INTEGER,
    content TEXT, timestamp INTEGER, context_token TEXT, from_user_id TEXT, to_user_id TEXT
  ); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO messages VALUES (1, 'received', 1, 'old inbound', 1700000000, '', 'user', 'bot');
  INSERT INTO messages VALUES (2, 'sent', 1, 'old outgoing', 1700000000, '', 'bot', 'user');
  INSERT INTO metadata VALUES ('session', 'old-session');`);
  const original = Buffer.from(legacy.export());
  legacy.close();
  fs.writeFileSync(path.join(directory, 'vschat_qq_chats.db'), original);
  const first = await open(directory);
  const migrated = await first.getSyncSnapshot();
  assert.equal(migrated.readThroughId, 2);
  assert.equal(migrated.unreadCount, 0);
  assert.equal(migrated.messages.length, 2);
  assert.equal(await first.getMetadata('session'), 'old-session');
  assert.deepEqual(fs.readFileSync(path.join(directory, 'vschat_qq_chats.db.bak')), original);
  await first.insertMessage(received('new-unread'));
  await first.close();
  const reopened = await open(directory);
  const preserved = await reopened.getSyncSnapshot();
  assert.equal(preserved.cursor.generation, migrated.cursor.generation);
  assert.equal(preserved.readThroughId, 2);
  assert.equal(preserved.unreadCount, 1);
  const wx = await open(directory, 'wechat');
  const wxId = await wx.insertMessage(received('wx-unread'));
  const wxState = await wx.getSyncSnapshot();
  await wx.markRead(wxState.cursor.generation, wxId);
  assert.equal((await wx.getSyncSnapshot()).unreadCount, 0);
  assert.equal((await reopened.getSyncSnapshot()).unreadCount, 1);
  await wx.close();
  await reopened.close();
});

test('independent processes insert, mark read and clear without stale snapshots or unread resurrection', async (t) => {
  const directory = temporary(t), observer = await open(directory);
  const initial = await observer.getSyncSnapshot();
  await Promise.all([worker(directory, 'append', 'a', 12), worker(directory, 'append', 'b', 12)]);
  const filled = await observer.getSyncSnapshot(initial.cursor);
  assert.equal(filled.reset, false);
  assert.equal(filled.messages.length, 25, 'the shared duplicate arrives only once');
  assert.equal(filled.unreadCount, 25);
  assert.equal(new Set(filled.messages.map(msg => msg.id)).size, 25);
  assert.equal(filled.cursor.lastId, filled.messages.at(-1).id);
  await Promise.all([
    worker(directory, 'read', filled.cursor.generation, filled.cursor.lastId),
    worker(directory, 'read', filled.cursor.generation, filled.messages[0].id),
  ]);
  const read = await observer.getSyncSnapshot(filled.cursor);
  assert.deepEqual(read.messages, []);
  assert.equal(read.unreadCount, 0);
  assert.equal(read.readThroughId, filled.cursor.lastId);
  await worker(directory, 'clear-and-append', 'replacement');
  await worker(directory, 'read', filled.cursor.generation, Number.MAX_SAFE_INTEGER);
  const replaced = await observer.getSyncSnapshot(filled.cursor);
  assert.equal(replaced.reset, true);
  assert.deepEqual(replaced.messages.map(msg => msg.message_id), ['replacement']);
  assert.equal(replaced.readThroughId, 0);
  assert.equal(replaced.unreadCount, 1);
  await observer.close();
});

test('read cursors reject invalid IDs and clamp ahead-of-history acknowledgements', async (t) => {
  const db = await open(temporary(t));
  const id = await db.insertMessage(received('unread'));
  const before = await db.getSyncSnapshot();
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    await assert.rejects(db.markRead(before.cursor.generation, value));
  }
  assert.equal((await db.getSyncSnapshot()).unreadCount, 1);
  await db.markRead(before.cursor.generation, Number.MAX_SAFE_INTEGER);
  const read = await db.getSyncSnapshot();
  assert.equal(read.readThroughId, id);
  assert.equal(read.unreadCount, 0);
  await db.markRead(before.cursor.generation, 0);
  assert.equal((await db.getSyncSnapshot()).readThroughId, id);
  await db.insertMessage(received('later-unread'));
  assert.equal((await db.getSyncSnapshot()).unreadCount, 1, 'clamping must not pre-read messages that arrive later');
  await db.close();
});

test('change stamps observe atomic file replacement and a missing database remains an error', async (t) => {
  const directory = temporary(t), db = await open(directory);
  const first = await db.getChangeStamp();
  await db.getSyncSnapshot();
  assert.equal(await db.getChangeStamp(), first, 'read-only sync must not write the file');
  await db.insertMessage(received('changed'));
  assert.notEqual(await db.getChangeStamp(), first);
  fs.unlinkSync(path.join(directory, 'vschat_qq_chats.db'));
  await assert.rejects(db.getChangeStamp(), { code: 'ENOENT' });
  await assert.rejects(db.getSyncSnapshot(), /disappeared/);
  await db.close();
});
