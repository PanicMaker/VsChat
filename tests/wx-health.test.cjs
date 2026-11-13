const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ChatDB } = require('./runtime.cjs');
const { WxClient } = require('../src/wx-client.ts');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const cursorKey = credential => `wx_poll_cursor:${crypto.createHash('sha256').update(credential).digest('hex')}`;
const envelope = (id, overrides = {}) => ({ from_user_id: 'peer', to_user_id: 'bot',
  message_type: 1, message_state: 2, context_token: 'private-context', message_id: id,
  item_list: [{ type: 1, text_item: { text: `message ${id}` } }], ...overrides });
const response = (msgs = [], cursor = 'cursor-next', extra = {}) => {
  const json = { ret: 0, msgs, get_updates_buf: cursor, ...extra };
  return { json, text: JSON.stringify(json) };
};
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Fixture condition did not become true');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-wx-health-'));
  const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, 'wechat');
  await db.init();
  const client = new WxClient({ globalStorageUri: { fsPath: directory }, secrets: {
    async get() {}, async store() {}, async delete() {},
  } }, db);
  client.botToken = 'fixture-credential'; client._connected = true;
  client.request = async () => { throw new Error('Unexpected API call: all networking must be mocked'); };
  client.fetchImageAsDataUrl = async () => { throw new Error('Unexpected media request'); };
  const calls = [], health = [], events = [], delays = [];
  const state = { reply: () => { throw new Error('Missing mocked response'); } };
  client.requestRaw = async (url, init) => {
    assert.equal(url, '/ilink/bot/getupdates');
    const body = JSON.parse(init.body); calls.push({ body, init });
    return state.reply(calls.length, body, init);
  };
  client.sleep = async delay => { delays.push(delay); };
  client.onConnectionHealth(value => health.push(value));
  client.onMessage(value => events.push(value));
  t.after(async () => {
    client.stopPolling(); await client.pollTask; client.dispose(); await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { client, db, state, calls, health, events, delays };
}

function stopWhenOnline(client) {
  return client.onConnectionHealth(health => { if (health.state === 'online') client.stopPolling(); });
}

test('failed second message preserves the old cursor and replay stores the whole batch exactly once', async t => {
  const { client, db, state, calls, health, delays } = await setup(t);
  const store = db.storeWxInbound.bind(db);
  let failed = false;
  db.storeWxInbound = async (message, session) => {
    if (message.message_id === '2' && !failed) { failed = true; throw new Error('simulated disk failure'); }
    return store(message, session);
  };
  state.reply = () => response([envelope('1'), envelope('2')], 'complete-batch');
  stopWhenOnline(client);
  await client.startPolling(); await client.pollTask;
  assert.deepEqual(calls.map(call => call.body.get_updates_buf), ['', '']);
  assert.equal(await db.getMetadata(cursorKey('fixture-credential')), 'complete-batch');
  assert.deepEqual((await db.getRecentMessages()).map(row => row.message_id).sort(), ['1', '2']);
  assert.deepEqual(delays, [1000]);
  assert.ok(health.some(value => value.state === 'reconnecting' && value.retryAt > 0));
  assert.ok(health.some(value => value.state === 'online' && value.lastAckAt > 0));
  assert.equal(client.connected, true, 'a temporary disk/network failure is recoverable');
});

test('cursor persistence failure replays persisted messages without duplicate events or skipped data', async t => {
  const { client, db, state, calls, events } = await setup(t);
  const set = db.setMetadata.bind(db);
  let failed = false;
  db.setMetadata = async (key, value) => {
    if (key.startsWith('wx_poll_cursor:') && !failed) { failed = true; throw new Error('cursor write failed'); }
    return set(key, value);
  };
  state.reply = () => response([envelope('1')], 'saved');
  stopWhenOnline(client);
  await client.startPolling(); await client.pollTask;
  assert.deepEqual(calls.map(call => call.body.get_updates_buf), ['', '']);
  assert.equal((await db.getRecentMessages()).length, 1); assert.equal(events.length, 1);
  assert.equal(await db.getMetadata(cursorKey('fixture-credential')), 'saved');
});

test('stop/start waits for an in-progress DB operation before polling the same uncommitted cursor', async t => {
  const { client, db, state, calls, health } = await setup(t);
  const entered = deferred(), release = deferred();
  const store = db.storeWxInbound.bind(db);
  let held = false;
  db.storeWxInbound = async (...args) => {
    const result = await store(...args);
    if (!held) { held = true; entered.resolve(); await release.promise; }
    return result;
  };
  state.reply = () => response([envelope('1'), envelope('2')], 'after-both');
  await client.startPolling(); await entered.promise;
  client.stopPolling(); await client.startPolling();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'replacement loop must wait for old DB processing');
  assert.equal(await db.getMetadata(cursorKey('fixture-credential')), null);
  assert.equal(client.connectionHealth.state, 'connecting');
  stopWhenOnline(client); release.resolve(); await client.pollTask;
  assert.deepEqual(calls.map(call => call.body.get_updates_buf), ['', '']);
  assert.equal(await db.getMetadata(cursorKey('fixture-credential')), 'after-both');
  assert.equal((await db.getRecentMessages()).length, 2);
  assert.equal(health.filter(value => value.state === 'online').length, 1);
});

test('late response from a cancelled loop cannot write messages, cursor or new-loop health', async t => {
  const { client, db, state, calls, health } = await setup(t);
  const pending = deferred();
  state.reply = index => index === 1 ? pending.promise : response([envelope('new')], 'new-cursor');
  await client.startPolling(); await until(() => calls.length === 1);
  client.stopPolling(); await client.startPolling();
  assert.equal(client.connectionHealth.state, 'connecting');
  stopWhenOnline(client);
  pending.resolve(response([envelope('old')], 'old-cursor'));
  await client.pollTask;
  assert.deepEqual((await db.getRecentMessages()).map(row => row.message_id), ['new']);
  assert.equal(await db.getMetadata(cursorKey('fixture-credential')), 'new-cursor');
  assert.equal(health.filter(value => value.state === 'online').length, 1);
});

test('credential-scoped cursors resume after restart and never consume legacy or another login cursor', async t => {
  const { client, db, state, calls } = await setup(t);
  await db.setMetadata('last_cursor', 'legacy-unknown-account');
  await db.setMetadata(cursorKey('fixture-credential'), 'saved-own-cursor');
  state.reply = () => response([], 'updated-own-cursor');
  stopWhenOnline(client);
  await client.startPolling(); await client.pollTask;
  assert.equal(calls[0].body.get_updates_buf, 'saved-own-cursor');
  client.botToken = 'different-login';
  state.reply = () => response([], 'other-cursor');
  await client.startPolling(); await client.pollTask;
  assert.equal(calls[1].body.get_updates_buf, '');
  assert.equal(await db.getMetadata(cursorKey('fixture-credential')), 'updated-own-cursor');
  assert.equal(await db.getMetadata(cursorKey('different-login')), 'other-cursor');
  assert.equal(await db.getMetadata('last_cursor'), 'legacy-unknown-account');
});

test('legacy first upgrade replays and deduplicates rather than trusting an unscoped cursor', async t => {
  const { client, db, state, calls, events } = await setup(t);
  await db.setMetadata('last_cursor', 'legacy-cursor');
  await client.processMessages([envelope('existing')]); events.length = 0;
  state.reply = () => response([envelope('existing'), envelope('new')], 'safe-cursor');
  stopWhenOnline(client);
  await client.startPolling(); await client.pollTask;
  assert.equal(calls[0].body.get_updates_buf, '');
  assert.equal((await db.getRecentMessages()).length, 2); assert.equal(events.length, 1);
});

test('non-auth business errors and malformed batches retry without advancing a cursor', async t => {
  const { client, db, state, calls, health } = await setup(t);
  const bad = [
    response([envelope('rejected')], 'must-not-commit', { ret: -2 }),
    response([envelope('rejected')], 'must-not-commit', { errcode: 500 }),
    { json: undefined, text: 'not JSON' },
    response([], 'must-not-commit', { msgs: {} }),
    response([], 123),
    response([null], 'must-not-commit'),
  ];
  state.reply = index => bad[index - 1] || response([envelope('accepted')], 'accepted');
  stopWhenOnline(client);
  await client.startPolling(); await client.pollTask;
  assert.ok(calls.every(call => call.body.get_updates_buf === ''));
  assert.deepEqual((await db.getRecentMessages()).map(row => row.message_id), ['accepted']);
  assert.equal(await db.getMetadata(cursorKey('fixture-credential')), 'accepted');
  assert.equal(health.filter(value => value.state === 'reconnecting').length, bad.length);
  assert.equal(client.connected, true);
});

test('transient AbortError retries, capped backoff resets after success, and public health is sanitized', async t => {
  const { client, state, health, delays, calls } = await setup(t);
  state.reply = index => {
    if (index <= 7) { const error = new Error('private-token signed-url?secret=fixture'); error.name = 'AbortError'; throw error; }
    return response();
  };
  stopWhenOnline(client);
  await client.startPolling(); await client.pollTask;
  assert.equal(calls.length, 8);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(client.reconnectDelay, 1000);
  assert.ok(health.every(value => Object.isFrozen(value)));
  assert.ok(!JSON.stringify(health).includes('private-token'));
  assert.ok(!JSON.stringify(health).includes('fixture-credential'));
  const online = health.find(value => value.state === 'online');
  assert.ok(online.lastAckAt > 0); assert.equal(online.retryAt, undefined);
});

test('stopping a real backoff wakes immediately and leaves offline rather than reconnecting', async t => {
  const { client, state, calls } = await setup(t);
  client.sleep = WxClient.prototype.sleep;
  state.reply = () => { throw new Error('offline fixture'); };
  await client.startPolling(); await until(() => client.connectionHealth.state === 'reconnecting');
  client.stopPolling();
  let done = false; client.pollTask.then(() => { done = true; });
  await until(() => done);
  assert.equal(calls.length, 1); assert.equal(client.connectionHealth.state, 'offline');
  assert.equal(client.connectionHealth.retryAt, undefined);
});

test('authentication failure stops polling and retains error health until explicit reconnect', async t => {
  const { client, db, state, calls, delays } = await setup(t);
  state.reply = () => response([envelope('rejected')], 'must-not-commit', { ret: 0, errcode: -14 });
  await client.startPolling(); await client.pollTask;
  assert.equal(calls.length, 1); assert.deepEqual(delays, []);
  assert.equal(client.connectionHealth.state, 'error'); assert.match(client.connectionHealth.detail, /登录已过期/);
  assert.equal(client.connected, false); assert.equal(client.polling, false);
  assert.equal(await db.getMetadata(cursorKey('fixture-credential')), null);
  assert.equal((await db.getRecentMessages()).length, 0);
});

test('stop aborts active request and overlapping start is idempotent', async t => {
  const { client, state, calls, health } = await setup(t);
  state.reply = (_index, _body, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('cancelled request')), { once: true });
  });
  await client.startPolling(); await client.startPolling(); await until(() => calls.length === 1);
  client.stopPolling(); await client.pollTask;
  assert.equal(calls[0].init.signal.aborted, true); assert.equal(calls.length, 1);
  assert.equal(client.connectionHealth.state, 'offline');
  assert.equal(health.some(value => value.state === 'reconnecting'), false);
});

test('cancelling inbound media aborts the batch without skipping later unsaved messages', async t => {
  const { client, db, state, calls } = await setup(t);
  const entered = deferred();
  client.fetchImageAsDataUrl = async (_url, _key, signal) => {
    assert.ok(signal); entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return undefined;
  };
  const image = envelope('image', { item_list: [{ type: 2, image_item: { media: {
    full_url: 'https://fixture.invalid/image', aes_key: 'fake' } } }] });
  state.reply = () => response([image, envelope('later')], 'after-media');
  await client.startPolling(); await entered.promise;
  client.stopPolling(); await client.pollTask;
  assert.equal(await db.getMetadata(cursorKey('fixture-credential')), null);
  assert.deepEqual((await db.getRecentMessages()).map(row => row.message_id), ['image']);
  stopWhenOnline(client);
  await client.startPolling(); await client.pollTask;
  assert.deepEqual(calls.map(call => call.body.get_updates_buf), ['', '']);
  assert.equal((await db.getRecentMessages()).length, 2);
  assert.equal(await db.getMetadata(cursorKey('fixture-credential')), 'after-media');
});

test('an old credential response cannot overwrite cursor or state after a new login starts', async t => {
  const { client, db, state, calls } = await setup(t);
  const pending = deferred();
  state.reply = index => index === 1 ? pending.promise : response([envelope('new-login-message')], 'new-login-cursor');
  await client.startPolling(); await until(() => calls.length === 1);
  client.stopPolling(); client.botToken = 'new-login'; await client.startPolling();
  stopWhenOnline(client);
  pending.resolve(response([envelope('old-login-message')], 'old-login-cursor', { errcode: -14 }));
  await client.pollTask;
  assert.equal(client.connected, true);
  assert.equal(await db.getMetadata(cursorKey('fixture-credential')), null);
  assert.equal(await db.getMetadata(cursorKey('new-login')), 'new-login-cursor');
  assert.deepEqual((await db.getRecentMessages()).map(row => row.message_id), ['new-login-message']);
});

test('old loop completion cannot replace the connecting state of an active QR login', async t => {
  const { client, state, calls } = await setup(t);
  const poll = deferred(), qr = deferred();
  state.reply = () => poll.promise;
  await client.startPolling(); await until(() => calls.length === 1);
  const oldTask = client.pollTask;
  client.request = () => qr.promise;
  const login = client.login();
  assert.equal(client.connectionHealth.state, 'connecting');
  poll.resolve(response([], 'obsolete'));
  await oldTask;
  assert.equal(client.connectionHealth.state, 'connecting');
  qr.reject(new Error('simulated QR failure'));
  await assert.rejects(login, /simulated QR failure/);
  assert.equal(client.connectionHealth.state, 'error');
});

test('stop/start joins a pending cursor commit before reading the next checkpoint', async t => {
  const { client, db, state, calls } = await setup(t);
  const entered = deferred(), release = deferred();
  const set = db.setMetadata.bind(db);
  let held = false;
  db.setMetadata = async (key, value) => {
    if (key.startsWith('wx_poll_cursor:') && !held) { held = true; entered.resolve(); await release.promise; }
    return set(key, value);
  };
  state.reply = index => response([envelope(String(index))], `cursor-${index}`);
  await client.startPolling(); await entered.promise;
  client.stopPolling(); await client.startPolling();
  assert.equal(calls.length, 1);
  stopWhenOnline(client); release.resolve(); await client.pollTask;
  assert.deepEqual(calls.map(call => call.body.get_updates_buf), ['', 'cursor-1']);
  assert.equal(await db.getMetadata(cursorKey('fixture-credential')), 'cursor-2');
  assert.equal((await db.getRecentMessages()).length, 2);
});

test('HTTP 401 requests login while temporary server errors continue to retry', async t => {
  const { client, state, calls, health, delays } = await setup(t);
  state.reply = index => {
    throw Object.assign(new Error('private fixture error'), { status: index === 1 ? 503 : 401 });
  };
  await client.startPolling(); await client.pollTask;
  assert.equal(calls.length, 2); assert.deepEqual(delays, [1000]);
  assert.ok(health.some(value => value.state === 'reconnecting'));
  assert.equal(client.connectionHealth.state, 'error'); assert.equal(client.connected, false);
  assert.match(client.connectionHealth.detail, /登录/);
});
