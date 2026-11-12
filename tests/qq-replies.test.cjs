const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ChatDB, message } = require('./runtime.cjs');
const { QqBotClient } = require('../src/qq-bot-client.ts');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-qq-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function open(t, dir = temporary(t)) {
  const db = new ChatDB({ globalStorageUri: { fsPath: dir } }, 'qq');
  await db.init();
  t.after(() => db.close());
  return db;
}
const inbound = (id, timestamp = 1_700_000_000, user = 'user', app = 'bot') => ({
  ...message(id), direction: 'received', timestamp, from_user_id: user, to_user_id: app,
});
const reserve = (db, messageId, extra = {}) => db.reserveQqReply({
  appId: 'bot', openId: 'user', messageId,
  nowSeconds: 1_700_000_010, windowSeconds: 3600, maxReplies: 4, ...extra,
});

test('per-message counters survive A/B/A quoting, parallel windows, quota and reload', async (t) => {
  const dir = temporary(t), a = await open(t, dir), b = await open(t, dir);
  await a.storeQqInbound(inbound('a'));
  await b.storeQqInbound(inbound('b', 1_700_000_001));
  assert.equal((await reserve(a, 'a')).sequence, 1);
  assert.equal((await reserve(b, 'b')).sequence, 1);
  assert.equal((await reserve(a, 'a')).sequence, 2);
  const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => reserve(i % 2 ? a : b, 'a')));
  assert.deepEqual(replies.filter(Boolean).map((r) => r.sequence).sort(), [3, 4]);
  assert.equal(await reserve(b, 'a'), null);
  await a.close();
  const reopened = await open(t, dir);
  assert.equal((await reserve(reopened, 'b')).sequence, 2);
  await reopened.clearAll();
  assert.equal((await reserve(reopened, 'b')).sequence, 3);
  await reopened.storeQqInbound(inbound('b', 1_700_000_001));
  assert.equal((await reserve(b, 'b')).sequence, 4);
  assert.equal(await reserve(b), null); // No fallback to an older context.
});

test('delayed, duplicate and same-second events cannot roll back routing or reset counters', async (t) => {
  const dir = temporary(t), a = await open(t, dir), b = await open(t, dir);
  const first = await a.storeQqInbound(inbound('new', 1_700_000_002));
  const old = await b.storeQqInbound(inbound('old', 1_700_000_001, 'old-user'));
  assert.equal(old.latestAdvanced, false);
  assert.equal(await b.getMetadata('qq_user_openid'), 'user');
  assert.equal(await b.getMetadata('qq_last_inbound_message_id'), 'new');
  const sameSecond = await b.storeQqInbound(inbound('same-second', 1_700_000_002));
  assert.equal(sameSecond.latestAdvanced, true);
  const duplicate = await a.storeQqInbound(inbound('new', 1_700_000_002));
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.latestAdvanced, false);
  assert.equal(await a.getMetadata('qq_last_inbound_message_id'), 'same-second');
  assert.equal((await reserve(a)).messageId, 'same-second');
  assert.equal((await reserve(b)).sequence, 2);
  assert.equal((await a.getRecentMessages()).length, 3);
});

test('reply contexts are isolated by bot, peer, ownership and reply window', async (t) => {
  const db = await open(t);
  await db.storeQqInbound(inbound('a'));
  await db.storeQqInbound(inbound('b', 1_700_000_000, 'other-user'));
  await db.storeQqInbound(inbound('c', 1_700_000_000, 'user', 'other-bot'));
  assert.equal(await reserve(db, 'a', { openId: 'other-user' }), null);
  assert.equal(await reserve(db, 'a', { appId: 'other-bot' }), null);
  assert.equal(await reserve(db, 'a', { nowSeconds: 1_700_003_601 }), null);
  assert.equal(await reserve(db, 'a', { nowSeconds: 1_699_999_999 }), null);
  assert.equal((await reserve(db, 'a', { nowSeconds: 1_700_003_600 })).sequence, 1);
  assert.equal((await reserve(db, undefined, { openId: 'other-user' })).messageId, 'b');
  assert.equal((await reserve(db, undefined, { appId: 'other-bot' })).messageId, 'c');
});

test('failed disk saves cannot expose an uncommitted reservation or partial inbound state', async (t) => {
  const db = await open(t);
  await db.storeQqInbound(inbound('a'));
  assert.equal((await reserve(db, 'a')).sequence, 1);
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('simulated disk failure'); };
  try {
    await assert.rejects(reserve(db, 'a'), /simulated disk failure/);
    await assert.rejects(db.storeQqInbound(inbound('b', 1_700_000_001)), /simulated disk failure/);
  } finally { fs.renameSync = rename; }
  assert.equal((await reserve(db, 'a')).sequence, 2);
  assert.equal(await reserve(db, 'b'), null);
  assert.equal(await db.getMetadata('qq_last_inbound_message_id'), 'a');
  assert.equal((await db.getRecentMessages()).length, 1);
});

test('three independent processes reserve unique sequences and atomically deduplicate inbound events', async (t) => {
  const dir = temporary(t);
  const workers = await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'qq-worker.cjs'), dir]);
    let output = '', error = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
  })));
  for (const messageId of ['shared-a', 'shared-b']) {
    const results = workers.flat().filter((r) => r.messageId === messageId);
    assert.equal(results.filter((r) => r.inserted).length, 1);
    assert.deepEqual(results.flatMap((r) => r.replies).filter(Boolean).map((r) => r.sequence).sort(), [1, 2, 3, 4]);
  }
  const db = await open(t, dir);
  assert.equal((await db.getRecentMessages()).length, 2);
});

test('legacy counters are retired once; new messages remain usable across later initializations', async (t) => {
  const dir = temporary(t), SQL = await require('sql.js')();
  const legacy = new SQL.Database();
  legacy.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, direction TEXT, type INTEGER,
    content TEXT, timestamp INTEGER, context_token TEXT, from_user_id TEXT, to_user_id TEXT
  ); CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
  ALTER TABLE messages ADD COLUMN message_id TEXT;
  INSERT INTO messages VALUES (1, 'received', 1, 'legacy text', 1700000000, '', 'user', 'bot', 'legacy');
  INSERT INTO metadata VALUES ('qq_reply_message_id', 'legacy');
  INSERT INTO metadata VALUES ('qq_reply_sequence', '1');`);
  const original = Buffer.from(legacy.export());
  legacy.close();
  fs.writeFileSync(path.join(dir, 'vschat_qq_chats.db'), original);
  const db = await open(t, dir);
  assert.equal(await reserve(db, 'legacy'), null);
  assert.equal((await db.getRecentMessages())[0].content, 'legacy text');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'vschat_qq_chats.db.bak')), original);
  await db.storeQqInbound(inbound('fresh'));
  assert.equal((await reserve(db, 'fresh')).sequence, 1);
  const second = await open(t, dir);
  assert.equal((await reserve(second, 'fresh')).sequence, 2);
});

function client(t, db, dir, requests) {
  const c = new QqBotClient({ globalStorageUri: { fsPath: dir } }, db);
  c._connected = true;
  c.getAppId = async () => 'bot';
  c.getTargetOpenId = async () => 'user';
  c.requestApi = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/upload_prepare')) return { upload_id: 'upload', block_size: '1', parts: [{ index: 0, block_size: '1', presigned_url: 'https://unused.invalid' }] };
    if (url.endsWith('/files')) return { file_info: 'image-info' };
    if (!url.endsWith('/messages')) return {};
    requests.push(body);
    return { id: `out-${requests.length}`, timestamp: new Date().toISOString() };
  };
  c.putUploadPart = async () => {};
  c.finishUploadPart = async () => {};
  t.after(() => c.dispose());
  return c;
}
const qqEvent = (id, timestamp) => ({ id, author: { user_openid: 'user' }, content: 'hello', timestamp: new Date(timestamp * 1000).toISOString() });

test('actual clients share sequences for quoted text, images and normal replies across windows', async (t) => {
  const dir = temporary(t), a = await open(t, dir), b = await open(t, dir), requests = [];
  const left = client(t, a, dir, requests), right = client(t, b, dir, requests);
  const now = Math.floor(Date.now() / 1000);
  await left.processC2CMessage(qqEvent('a', now - 1));
  await right.processC2CMessage(qqEvent('b', now));
  const quote = { messageId: 'a', direction: 'received', timestamp: now - 1, type: 1, text: 'hello' };
  await left.sendText('quote a', quote);
  await right.sendText('normal b');
  await right.sendText('quote a again', quote);
  const image = path.join(dir, 'sample.png');
  fs.writeFileSync(image, Buffer.from([0]));
  let sentImage;
  left.onMessage(msg => { if (msg.type === 2) sentImage = msg; });
  await left.sendImage(image);
  assert.equal(sentImage.imageDataUrl, 'data:image/png;base64,AA==');
  assert.equal(await right.getDecryptedImageUrl(sentImage.id), sentImage.imageDataUrl);
  assert.deepEqual(requests.map((r) => [r.msg_id, r.msg_seq]), [['a', 1], ['b', 1], ['a', 2], ['b', 2]]);
  assert.equal(requests.at(-1).msg_type, 7);
  await Promise.all([left.sendText('parallel left'), right.sendText('parallel right')]);
  assert.deepEqual(requests.slice(-2).map((r) => r.msg_seq).sort(), [3, 4]);
  assert.equal(new Set(requests.map((r) => `${r.msg_id}/${r.msg_seq}`)).size, 6);
});

test('actual inbound handlers persist concurrent duplicates once and reject delayed routing rollback', async (t) => {
  const dir = temporary(t), a = await open(t, dir), b = await open(t, dir), requests = [];
  const left = client(t, a, dir, requests), right = client(t, b, dir, requests);
  const now = Math.floor(Date.now() / 1000);
  let events = 0;
  left.onMessage(() => events++); right.onMessage(() => events++);
  await Promise.all([left.processC2CMessage(qqEvent('new', now)), right.processC2CMessage(qqEvent('new', now))]);
  assert.equal(events, 1);
  await right.processC2CMessage(qqEvent('late', now - 10));
  await left.sendText('latest');
  assert.equal(requests[0].msg_id, 'new');
  assert.equal(await a.getMetadata('qq_last_inbound_message_id'), 'new');
});

test('failed HTTP attempts never recycle a reserved sequence', async (t) => {
  const dir = temporary(t), db = await open(t, dir), requests = [];
  const c = client(t, db, dir, requests);
  await c.processC2CMessage(qqEvent('a', Math.floor(Date.now() / 1000)));
  const request = c.requestApi;
  c.requestApi = async (url, init) => { await request(url, init); throw new Error('network timeout after server accepted'); };
  await assert.rejects(c.sendText('uncertain'), /network timeout/);
  c.requestApi = request;
  await c.sendText('next attempt');
  assert.deepEqual(requests.map((r) => r.msg_seq), [1, 2]);
});
