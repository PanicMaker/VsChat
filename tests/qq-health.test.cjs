const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatDB } = require('./runtime.cjs');
const { QqBotClient } = require('../src/qq-bot-client.ts');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

class Clock {
  now = 1_800_000_000_000;
  next = 1;
  timers = new Map();
  after(ms, callback) { const id = this.next++; this.timers.set(id, { at: this.now + ms, callback }); return id; }
  cancel(id) { this.timers.delete(id); }
  tick(ms) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}
class Socket {
  readyState = 1;
  listeners = new Map();
  sent = [];
  closes = [];
  addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) || []), callback]); }
  send(value) { if (this.sendError) throw new Error('simulated socket send failure'); this.sent.push(JSON.parse(value)); }
  close(code, reason) { this.closes.push({ code, reason }); this.readyState = 3; if (this.closeError) throw new Error('close failed'); }
  emit(name, value = {}) { for (const callback of this.listeners.get(name) || []) callback(value); }
}

async function setup(t, autoStart = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-qq-health-'));
  const context = { globalStorageUri: { fsPath: directory } }, db = new ChatDB(context, 'qq');
  await db.init();
  const client = new QqBotClient(context, db), clock = new Clock(), sockets = [], health = [];
  const credentials = { appId: 'bot', appSecret: 'secret' };
  client.readCredentials = async () => credentials;
  client.accessToken = 'test-token';
  client.accessTokenExpiresAt = Date.now() + 3_600_000;
  client.accessTokenCredentialKey = client.credentialKey(credentials);
  client.requestApi = async url => {
    assert.equal(url, '/gateway', 'no message or upload network request is allowed');
    return { url: 'wss://gateway.test.invalid' };
  };
  client.createGatewaySocket = () => { const socket = new Socket(); sockets.push(socket); return socket; };
  client.now = () => clock.now;
  client.after = (ms, callback) => clock.after(ms, callback);
  client.cancelTimer = timer => clock.cancel(timer);
  client.onConnectionHealth(value => health.push(value));
  t.after(async () => { client.dispose(); await db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  if (autoStart) await client.startPolling();
  const receive = payload => client.handleGatewayMessage(JSON.stringify(payload));
  const hello = (interval = 1000) => receive({ op: 10, d: { heartbeat_interval: interval } });
  const ready = (sessionId = 'session-a', sequence = 1) => receive({ op: 0, s: sequence, t: 'READY', d: { session_id: sessionId } });
  const online = async interval => { await hello(interval); await ready(); };
  return { client, db, clock, sockets, health, receive, hello, ready, online, credentials };
}
const event = (s, id = `message-${s}`) => ({ op: 0, s, t: 'C2C_MESSAGE_CREATE', d: {
  id, author: { user_openid: 'peer' }, content: `text ${id}`, timestamp: new Date().toISOString(),
} });

test('Hello, READY, heartbeat and ACK publish health and an atomic processed checkpoint', async t => {
  const state = await setup(t), { client, db, clock, sockets, receive, online } = state;
  assert.equal(client.connectionHealth.state, 'connecting');
  await online();
  assert.equal(sockets[0].sent[0].op, 2);
  assert.equal(client.connected, true);
  assert.equal(client.connectionHealth.state, 'online');
  assert.deepEqual(await db.getQqGatewayCheckpoint(), { sessionId: 'session-a', sequence: 1, credentialKey: client.credentialKey(state.credentials) });
  clock.tick(1000);
  assert.deepEqual(sockets[0].sent.at(-1), { op: 1, d: 1 });
  await receive({ op: 11 });
  assert.equal(client.connectionHealth.lastAckAt, clock.now);
  const snapshot = client.connectionHealth;
  snapshot.state = 'error';
  assert.equal(client.connectionHealth.state, 'online');
  clock.tick(1000);
  await receive({ op: 11 });
  assert.equal(sockets.length, 1);
});

test('missing ACK disconnects even without a close event and resumes the committed sequence', async t => {
  const { client, clock, sockets, online, hello, receive } = await setup(t);
  await online();
  clock.tick(2000);
  assert.equal(client.connected, false);
  assert.equal(sockets[0].closes.length, 1);
  assert.match(client.connectionHealth.detail, /心跳确认超时/);
  assert.equal(client.connectionHealth.retryAt, clock.now + 1000);
  clock.tick(1000); await flush();
  assert.equal(sockets.length, 2);
  await hello();
  assert.deepEqual(sockets[1].sent[0], { op: 6, d: { token: 'QQBot test-token', session_id: 'session-a', seq: 1 } });
  await receive({ op: 0, s: 2, t: 'RESUMED', d: '' });
  assert.equal(client.connectionHealth.state, 'online');
});

test('server heartbeat requests are immediate and cannot postpone a pending ACK deadline', async t => {
  const { client, clock, sockets, online, receive } = await setup(t);
  await online();
  clock.tick(1000);
  clock.tick(900);
  await receive({ op: 1 });
  assert.equal(sockets[0].sent.filter(frame => frame.op === 1).length, 2);
  clock.tick(100);
  assert.equal(client.connected, false);
  assert.match(client.connectionHealth.detail, /心跳确认超时/);
});

test('socket error, late close and stale ACK produce only one reconnect', async t => {
  const { client, clock, sockets, online, hello } = await setup(t);
  await online();
  const old = sockets[0];
  old.emit('error');
  old.emit('close', { code: 1006 });
  clock.tick(1000); await flush(); await hello();
  assert.equal(sockets.length, 2);
  const before = client.connectionHealth;
  old.emit('message', { data: JSON.stringify({ op: 11 }) });
  old.emit('close', { code: 4915 });
  await flush();
  assert.deepEqual(client.connectionHealth, before);
  assert.equal(client.shouldRun, true);
});

test('stop cancels gateway lookup and a late result cannot create or replace a socket', async t => {
  const { client, sockets } = await setup(t, false);
  const first = deferred();
  let signal;
  client.requestApi = async (_, init) => { signal = init.signal; return first.promise; };
  const pending = client.startPolling();
  client.stopPolling();
  assert.equal(signal.aborted, true);
  client.requestApi = async () => ({ url: 'wss://new.test.invalid' });
  await client.startPolling();
  first.resolve({ url: 'wss://late.test.invalid' });
  await pending;
  assert.equal(sockets.length, 1);
  assert.equal(client.socket, sockets[0]);
  assert.equal(client.connectionHealth.state, 'connecting');
});

test('handshake deadline and control-frame send failures reconnect without waiting for close', async t => {
  const { client, clock, sockets, hello } = await setup(t);
  sockets[0].closeError = true;
  clock.tick(30_000);
  assert.match(client.connectionHealth.detail, /握手超时/);
  clock.tick(1000); await flush();
  sockets[1].sendError = true;
  await hello();
  assert.match(client.connectionHealth.detail, /控制帧失败/);
  assert.equal(client.connected, false);
});

test('dispatch stays ordered while ACK and server heartbeat bypass a blocked DB handler', async t => {
  const { client, db, clock, sockets, online, receive } = await setup(t);
  await online();
  const hold = deferred(), entered = [], process = client.processC2CMessage.bind(client);
  client.processC2CMessage = async (message, ...args) => {
    entered.push(message.id);
    if (message.id === 'first') await hold.promise;
    return process(message, ...args);
  };
  const first = receive(event(2, 'first')), second = receive(event(3, 'second'));
  assert.deepEqual(entered, ['first']);
  assert.equal(client.sequence, 1);
  assert.equal((await db.getQqGatewayCheckpoint()).sequence, 1);
  clock.tick(1000);
  await receive({ op: 11 });
  await receive({ op: 1 });
  assert.deepEqual(sockets[0].sent.at(-1), { op: 1, d: 3 });
  await receive({ op: 11 });
  assert.equal(client.connected, true);
  hold.resolve(); await Promise.all([first, second]);
  assert.deepEqual(entered, ['first', 'second']);
  assert.equal((await db.getQqGatewayCheckpoint()).sequence, 3);
  assert.deepEqual((await db.getRecentMessages()).map(message => message.message_id), ['first', 'second']);
});

test('failed dispatch rejects queued successors and replays from the last successful checkpoint', async t => {
  const { client, db, clock, sockets, online, receive, hello } = await setup(t);
  await online();
  const hold = deferred(), original = client.processC2CMessage.bind(client), seen = [];
  client.processC2CMessage = async message => { seen.push(message.id); await hold.promise; throw new Error('simulated store failure'); };
  const first = receive(event(2, 'first')).catch(error => error);
  const second = receive(event(3, 'second')).catch(error => error);
  hold.resolve();
  assert.ok(await first instanceof Error); assert.ok(await second instanceof Error);
  await flush();
  assert.deepEqual(seen, ['first']);
  assert.equal(client.sequence, 1);
  assert.equal((await db.getQqGatewayCheckpoint()).sequence, 1);
  client.processC2CMessage = original;
  clock.tick(1000); await flush(); await hello();
  assert.equal(sockets.at(-1).sent[0].d.seq, 1);
  await receive(event(2, 'first')); await receive(event(3, 'second'));
  await receive({ op: 0, s: 4, t: 'RESUMED', d: '' });
  assert.equal((await db.getRecentMessages()).length, 2);
  assert.equal(client.sequence, 4);
});

test('failed checkpoint save cannot advance memory; replay deduplicates the already-saved inbound', async t => {
  const { client, db, clock, online, receive, hello } = await setup(t);
  await online();
  const save = db.saveQqGatewayCheckpoint.bind(db);
  db.saveQqGatewayCheckpoint = async checkpoint => {
    if (checkpoint.sequence === 2) throw new Error('disk full');
    return save(checkpoint);
  };
  await assert.rejects(receive(event(2, 'saved-before-checkpoint')), /disk full/);
  await flush();
  assert.equal(client.sequence, 1);
  assert.equal((await db.getRecentMessages()).length, 1);
  db.saveQqGatewayCheckpoint = save;
  clock.tick(1000); await flush(); await hello();
  await receive(event(2, 'saved-before-checkpoint'));
  assert.equal((await db.getRecentMessages()).length, 1);
  assert.equal(client.sequence, 2);
});

test('a timed-out handler is fenced and bounded until it settles, without advancing the old cursor', async t => {
  const { client, db, clock, sockets, online, receive } = await setup(t);
  await online(100_000);
  const hold = deferred(), original = client.processC2CMessage.bind(client);
  client.processC2CMessage = async (...args) => { await hold.promise; return original(...args); };
  const pending = receive(event(2)).catch(error => error);
  await receive({ op: 1 }); await receive({ op: 11 });
  clock.tick(30_000); await flush();
  assert.ok(await pending instanceof Error);
  assert.equal(client.connected, false);
  assert.match(client.connectionHealth.detail, /消息处理/);
  clock.tick(300_000); await flush();
  assert.equal(sockets.length, 1, 'do not accumulate uncancellable handlers on replacement connections');
  hold.resolve(); await flush();
  assert.equal((await db.getQqGatewayCheckpoint()).sequence, 1);
  assert.equal((await db.getRecentMessages()).length, 0);
  clock.tick(1000); await flush();
  assert.equal(sockets.length, 2);
});

test('dispatch queue is bounded and discards unprocessed events for a later resume', async t => {
  const { client, db, online, receive } = await setup(t);
  await online(100_000);
  const hold = deferred();
  client.processC2CMessage = async () => hold.promise;
  const pending = [];
  for (let i = 0; i < 257; i++) pending.push(receive(event(i + 2)).catch(error => error));
  assert.equal(client.activeGateway, undefined);
  assert.equal(client.connected, false);
  assert.match(client.connectionHealth.detail, /积压/);
  assert.equal((await db.getQqGatewayCheckpoint()).sequence, 1);
  client.stopPolling(); hold.resolve(); await Promise.all(pending);
});

test('stop promptly rejects an active dispatch and clears its deadline without waiting for the DB work', async t => {
  const { client, db, clock, online, receive } = await setup(t);
  await online();
  const hold = deferred();
  client.processC2CMessage = async () => hold.promise;
  const pending = receive(event(2)).catch(error => error);
  client.stopPolling(); await flush();
  assert.match((await pending).message, /cancelled/);
  assert.equal(clock.timers.size, 0);
  assert.equal(client.connectionHealth.state, 'offline');
  hold.resolve(); await flush();
  assert.equal((await db.getQqGatewayCheckpoint()).sequence, 1);
});

test('invalid session clears only its own checkpoint and forces Identify', async t => {
  const { client, db, clock, sockets, online, receive, hello, credentials } = await setup(t);
  await online();
  await db.saveQqGatewayCheckpoint({ sessionId: 'other-window-session', sequence: 80, credentialKey: client.credentialKey(credentials) });
  await receive({ op: 9, d: false });
  assert.equal((await db.getQqGatewayCheckpoint()).sessionId, 'other-window-session');
  clock.tick(1000); await flush(); await hello();
  assert.equal(sockets.at(-1).sent[0].op, 2);
});

test('an invalid fresh Identify cannot erase a different window checkpoint', async t => {
  const { client, db, receive, hello, credentials } = await setup(t);
  const checkpoint = { sessionId: 'other-window', sequence: 80, credentialKey: client.credentialKey(credentials) };
  await db.saveQqGatewayCheckpoint(checkpoint);
  client.forceIdentify = true;
  await hello();
  assert.equal(client.activeGateway.sessionId, '');
  await receive({ op: 9, d: false });
  assert.deepEqual(await db.getQqGatewayCheckpoint(), checkpoint);
});

test('fatal close codes stop reconnecting, while invalid seq can reconnect with Identify', async t => {
  const { client, db, clock, sockets, online, hello } = await setup(t);
  await online();
  sockets[0].emit('close', { code: 4007 });
  await flush();
  // Wait for the real isolated DB clear before advancing the fake retry clock.
  assert.equal(await db.getQqGatewayCheckpoint(), undefined);
  await flush(); clock.tick(1000); await flush(); await hello();
  assert.equal(sockets.at(-1).sent[0].op, 2);
  sockets.at(-1).emit('close', { code: 4014 }); await flush();
  assert.equal(client.connectionHealth.state, 'error');
  assert.equal(client.shouldRun, false);
  const count = sockets.length;
  clock.tick(600_000); await flush();
  assert.equal(sockets.length, count);
});

test('connection failures use capped exponential backoff and stop cancels scheduled retries', async t => {
  const { client, clock, sockets } = await setup(t, false);
  let attempts = 0;
  client.requestApi = async () => { attempts++; throw new Error('offline'); };
  await client.startPolling();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    assert.equal(client.connectionHealth.retryAt - clock.now, delay);
    clock.tick(delay); await flush();
  }
  assert.equal(attempts, 8);
  client.stopPolling();
  clock.tick(1_000_000); await flush();
  assert.equal(attempts, 8);
  assert.equal(sockets.length, 0);
  assert.equal(client.connectionHealth.state, 'offline');
});

test('READY and RESUMED do not reset flapping backoff; only an online ACK does', async t => {
  const { client, clock, sockets, online, hello, receive } = await setup(t);
  await online();
  sockets.at(-1).emit('close', { code: 4009 }); await flush();
  assert.equal(client.connectionHealth.retryAt - clock.now, 1000);
  clock.tick(1000); await flush(); await hello();
  await receive({ op: 0, s: 2, t: 'RESUMED', d: '' });
  sockets.at(-1).emit('close', { code: 4009 }); await flush();
  assert.equal(client.connectionHealth.retryAt - clock.now, 2000);
  clock.tick(2000); await flush(); await hello();
  // A heartbeat ACK before the replay is complete is not proof of an online
  // session and must not reset the backoff either.
  await receive({ op: 1 }); await receive({ op: 11 });
  assert.equal(client.reconnectDelay, 4000);
  await receive({ op: 0, s: 3, t: 'RESUMED', d: '' });
  sockets.at(-1).emit('close', { code: 4009 }); await flush();
  assert.equal(client.connectionHealth.retryAt - clock.now, 4000);
  clock.tick(4000); await flush(); await hello();
  await receive({ op: 0, s: 4, t: 'RESUMED', d: '' });
  await receive({ op: 1 }); await receive({ op: 11 });
  assert.equal(client.reconnectDelay, 1000);
  sockets.at(-1).emit('close', { code: 4009 }); await flush();
  assert.equal(client.connectionHealth.retryAt - clock.now, 1000);
});

test('rate-limited close waits a minute and disposal fences all pending socket events', async t => {
  const { client, clock, sockets, online } = await setup(t);
  await online();
  sockets[0].emit('close', { code: 4008 }); await flush();
  assert.equal(client.connectionHealth.retryAt - clock.now, 60_000);
  client.dispose();
  clock.tick(60_000); await flush();
  sockets[0].emit('message', { data: JSON.stringify(event(2)) });
  sockets[0].emit('error');
  await client.startPolling(); await flush();
  assert.equal(sockets.length, 1);
  assert.equal(clock.timers.size, 0);
  assert.equal(client.connectionHealth.state, 'offline');
});

test('malformed gateway frames recover without checkpoint changes', async t => {
  const { client, db, sockets, online } = await setup(t);
  await online();
  sockets[0].emit('message', { data: '{invalid-json' }); await flush();
  assert.equal(client.connectionHealth.state, 'reconnecting');
  assert.equal((await db.getQqGatewayCheckpoint()).sequence, 1);
});

test('recipient refresh uses one batched summary instead of per-contact DB peeks', async t => {
  const { client, db, online } = await setup(t);
  await online();
  let summaries = 0;
  const summary = db.getQqRecipientSummary.bind(db);
  db.getQqRecipientSummary = async options => { summaries++; return summary(options); };
  db.listConversations = async () => assert.fail('must not separately list conversations');
  db.peekQqReply = async () => assert.fail('must not query a reply per peer');
  const state = await client.getRecipients();
  assert.equal(summaries, 1);
  assert.equal(state.totalUnreadCount, 0);
});
