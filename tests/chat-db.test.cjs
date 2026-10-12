const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ChatDB, message } = require('./runtime.cjs');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-db-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const open = async (dir, channel = 'qq') => {
  const db = new ChatDB({ globalStorageUri: { fsPath: dir } }, channel);
  await db.init();
  return db;
};

test('two old instances preserve interleaved messages and metadata; close never overwrites', async (t) => {
  const dir = temporary(t);
  const a = await open(dir), b = await open(dir);
  const ids = await Promise.all([
    a.insertMessage(message('a')), b.insertMessage(message('b')),
    a.insertMessage(message('c')), b.setMetadata('other-window', 'preserved'),
  ]);
  assert.equal(new Set(ids.slice(0, 3)).size, 3);
  assert.equal((await a.getRecentMessages()).length, 3);
  assert.equal(await a.getMetadata('other-window'), 'preserved');
  await a.close();
  await b.insertMessage(message('d'));
  await b.close();
  const reopened = await open(dir);
  assert.equal((await reopened.getRecentMessages()).length, 4);
  await reopened.close();
});

test('independent OS processes serialize writes and deduplicate concurrent transport events', async (t) => {
  const dir = temporary(t);
  await Promise.all(['a', 'b', 'c'].map((prefix) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'db-worker.cjs'), dir, prefix]);
    let error = '';
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(error)));
  })));
  const db = await open(dir);
  const messages = await db.getRecentMessages(1000);
  assert.equal(messages.length, 91);
  assert.equal(new Set(messages.map((msg) => msg.id)).size, 91);
  for (const prefix of ['a', 'b', 'c']) assert.equal(await db.getMetadata(`${prefix}-last`), '29');
  assert.equal(messages.filter((msg) => msg.message_id === 'shared-message').length, 1);
  await db.close();
});

test('clear, normalization and stale-lock recovery cannot resurrect an old snapshot', async (t) => {
  const dir = temporary(t), a = await open(dir), b = await open(dir);
  await a.insertMessage({ ...message('legacy'), content: '<face>', reply_to: JSON.stringify({ text: '<face>' }) });
  await b.normalizeMessageText((text) => text.replace('<face>', '[face]'));
  assert.equal((await a.getRecentMessages())[0].content, '[face]');
  await a.setMetadata('session', 'keep');
  await b.clearAll();
  await a.insertMessage(message('after-clear'));
  await a.close();
  await b.close();
  const lockPath = path.join(dir, 'vschat_qq_chats.db.lock');
  fs.mkdirSync(lockPath);
  const expired = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, expired, expired);
  const c = await open(dir);
  assert.deepEqual((await c.getRecentMessages()).map((msg) => msg.message_id), ['after-clear']);
  assert.equal(await c.getMetadata('session'), 'keep');
  assert.ok(fs.existsSync(path.join(dir, 'vschat_qq_chats.db.bak')));
  assert.ok(!fs.readdirSync(dir).some((file) => file.endsWith('.tmp')));
  await c.close();
});

test('cursor pagination covers every row once; refresh includes the full loaded range', async (t) => {
  const db = await open(temporary(t));
  await Promise.all(Array.from({ length: 205 }, (_, i) => db.insertMessage(message(`page-${i}`))));
  let beforeId, ids = [];
  for (;;) {
    const page = await db.getRecentMessages(100, beforeId);
    if (!page.length) break;
    ids = [...page.map((msg) => msg.id), ...ids];
    beforeId = page[0].id;
  }
  assert.equal(ids.length, 205);
  assert.equal(new Set(ids).size, 205);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal((await db.getMessagesFromId(ids[0])).length, 205);
  await db.close();
});

test('a failed atomic save leaves the existing file readable and releases the lock', async (t) => {
  const dir = temporary(t), db = await open(dir);
  await db.insertMessage(message('safe'));
  const target = path.join(dir, 'vschat_qq_chats.db');
  const before = fs.readFileSync(target);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated disk failure'); };
  try {
    await assert.rejects(db.insertMessage(message('failed')), /simulated disk failure/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(target), before);
  assert.equal((await db.getRecentMessages()).length, 1);
  await db.insertMessage(message('retry'));
  assert.equal((await db.getRecentMessages()).length, 2);
  await db.close();
});

test('upgrading a legacy database preserves rows, metadata and a byte-for-byte backup', async (t) => {
  const dir = temporary(t);
  const SQL = await require('sql.js')();
  const legacy = new SQL.Database();
  legacy.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT, type INTEGER,
    content TEXT, timestamp INTEGER, context_token TEXT, from_user_id TEXT, to_user_id TEXT
  ); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
  INSERT INTO messages VALUES (1, 'sent', 1, 'old message', 1700000000, '', 'bot', 'user');
  INSERT INTO metadata VALUES ('session', 'old-session');`);
  const original = Buffer.from(legacy.export());
  legacy.close();
  fs.writeFileSync(path.join(dir, 'vschat_qq_chats.db'), original);
  const db = await open(dir);
  assert.equal((await db.getRecentMessages())[0].content, 'old message');
  assert.equal(await db.getMetadata('session'), 'old-session');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'vschat_qq_chats.db.bak')), original);
  assert.equal(await db.insertMessage(message('new')), 2);
  const wx = await open(dir, 'wechat');
  assert.deepEqual(await wx.getRecentMessages(), []);
  await wx.close();
  await db.close();
});
