const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MockAgent } = require('undici');
const { ChatDB, configuration } = require('./runtime.cjs');
const { QqBotClient } = require('../src/qq-bot-client.ts');
const { recipientId } = require('../src/recipient-types.ts');

const now = () => Math.floor(Date.now() / 1000);
const ref = (peerId = 'alice', accountId = 'bot') => ({ accountId, peerId });
const notSent = error => error instanceof Error && error.deliveryState === 'not_sent';
const inbound = (id, peerId = 'alice', accountId = 'bot', timestamp = now()) => ({
  direction: 'received', type: 1, content: 'hello', timestamp, context_token: '',
  from_user_id: peerId, to_user_id: accountId, message_id: id,
});
const options = (peerId = 'alice') => ({
  appId: 'bot', openId: peerId, nowSeconds: now(), windowSeconds: 3600, maxReplies: 4,
});
async function importHistory(db, message) {
  const records = [{ key: randomUUID(), originalId: 90, message }];
  const plan = await db.previewRestore(records);
  return db.appendRestore(records, plan.generation);
}

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-qq-recipients-'));
  const context = { globalStorageUri: { fsPath: directory } };
  const db = new ChatDB(context, 'qq');
  await db.init();
  const client = new QqBotClient(context, db);
  client._connected = true;
  let credentials = { appId: 'bot', appSecret: 'private-original-secret' };
  client.readCredentials = async () => credentials && { ...credentials };
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  client.getProxyAgent = () => dispatcher;
  const filePath = path.join(directory, 'sample.png');
  fs.writeFileSync(filePath, Buffer.from('test-file'));
  configuration.delete('vschat.qqUserOpenId');
  t.after(async () => {
    configuration.delete('vschat.qqUserOpenId');
    client.dispose();
    await dispatcher.close();
    await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { client, db, directory, filePath, dispatcher,
    credentials: () => credentials, changeCredentials: value => { credentials = value; } };
}

function mockTransport(client, onRequest = async () => {}) {
  const calls = [], uploads = [];
  client.requestApi = async (url, init, retryAuth, target) => {
    const body = JSON.parse(init.body);
    const call = { url, body, target };
    calls.push(call);
    await onRequest(call);
    if (url.endsWith('/upload_prepare')) return {
      upload_id: 'upload', block_size: body.file_size,
      parts: [{ index: 0, block_size: body.file_size, presigned_url: 'https://upload.example.test/part' }],
    };
    if (url.endsWith('/upload_part_finish')) return {};
    if (url.endsWith('/files')) return { file_info: 'media-info' };
    if (url.endsWith('/messages')) return { id: `sent-${calls.length}`, timestamp: new Date().toISOString() };
    throw new Error(`Unexpected ${url}`);
  };
  client.putUploadPart = async (url, bytes, index, timeout, target) => uploads.push({ url, bytes, index, target });
  return { calls, uploads };
}

test('recipient list scopes current bot, keeps imported history read-only and does not spend reply quota', async t => {
  const { client, db } = await setup(t);
  await db.storeQqInbound(inbound('alice-live'));
  await db.storeQqInbound(inbound('other-bot-live', 'foreign', 'different-bot'));
  await db.storeQqInbound(inbound('expired', 'expired', 'bot', now() - 3601));
  await importHistory(db, inbound('imported-only', 'archive-peer'));
  configuration.set('vschat.qqUserOpenId', 'configured-peer');
  const state = await client.getRecipients();
  assert.equal(state.accountId, 'bot');
  const byPeer = new Map(state.recipients.map(item => [item.conversation.peerId, item]));
  assert.deepEqual([...byPeer.keys()].sort(), ['alice', 'archive-peer', 'configured-peer', 'expired']);
  assert.equal(byPeer.get('alice').canSend, true);
  for (const peer of ['archive-peer', 'configured-peer', 'expired']) {
    assert.equal(byPeer.get(peer).canSend, false);
    assert.match(byPeer.get(peer).reason, /被动回复/);
  }
  assert.equal((await db.peekQqReply(options())).sequence, 0);
  assert.doesNotMatch(JSON.stringify(state), /private-original-secret|sessionKey|contextToken/);
  configuration.set('vschat.qqUserOpenId', 'alice');
  assert.equal((await client.getRecipients()).recipients.filter(item => item.conversation.peerId === 'alice').length, 1);
  await db.clearAll();
  assert.equal((await client.getRecipients()).recipients.find(item => item.conversation.peerId === 'alice').canSend, true);
});

test('capture rejects missing, foreign, restored, exhausted and offline recipients', async t => {
  const { client, db, changeCredentials } = await setup(t);
  await db.storeQqInbound(inbound('live'));
  await importHistory(db, inbound('archive', 'readonly'));
  for (const id of ['not-json', recipientId(ref('unknown')), recipientId(ref('alice', 'foreign-bot')), recipientId(ref('readonly'))]) {
    await assert.rejects(client.captureSendTarget(id), notSent);
  }
  const target = await client.captureSendTarget(recipientId(ref()));
  assert.equal(Object.isFrozen(target), true);
  assert.equal(target.channel, 'qq');
  assert.match(target.sessionKey, /^[a-f0-9]{64}$/);
  assert.equal((await db.peekQqReply(options())).sequence, 0);
  for (let i = 0; i < 4; i++) await db.reserveQqReply(options());
  await assert.rejects(client.captureSendTarget(recipientId(ref())), notSent);
  client._connected = false;
  assert.equal((await client.getRecipients()).recipients[0].canSend, false);
  changeCredentials(null);
  assert.deepEqual((await client.getRecipients()).recipients, []);
});

for (const kind of ['text', 'image', 'file']) {
  test(`${kind} freezes the selected peer despite incoming messages, setting edits and caller mutation`, async t => {
    const { client, db, filePath } = await setup(t);
    await db.storeQqInbound(inbound('alice-inbound'));
    const target = { ...await client.captureSendTarget(recipientId(ref())) };
    const { calls, uploads } = mockTransport(client);
    const send = kind === 'text' ? client.sendText('hello alice', undefined, target)
      : kind === 'image' ? client.sendImage(filePath, target) : client.sendFile(filePath, 'report.txt', target);
    target.peerId = 'bob';
    configuration.set('vschat.qqUserOpenId', 'bob');
    await db.storeQqInbound(inbound('bob-inbound', 'bob'));
    await send;
    assert.ok(calls.length);
    assert.ok(calls.every(call => call.url.startsWith('/v2/users/alice/')));
    assert.ok(calls.every(call => call.target.peerId === 'alice' && call.target.accountId === 'bot'));
    assert.ok(uploads.every(part => part.target.peerId === 'alice'));
    const sent = (await db.getRecentMessages()).filter(message => message.direction === 'sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to_user_id, 'alice');
    assert.equal(sent[0].from_user_id, 'bot');
    assert.equal(calls.at(-1).body.msg_id, 'alice-inbound');
    assert.equal((await db.peekQqReply(options('bob'))).sequence, 0);
  });
}

test('captured targets reject bot or secret changes before text/image/file starts', async t => {
  const { client, db, filePath, changeCredentials } = await setup(t);
  await db.storeQqInbound(inbound('live'));
  const target = await client.captureSendTarget(recipientId(ref()));
  const { calls, uploads } = mockTransport(client);
  for (const credentials of [{ appId: 'other-bot', appSecret: 'secret' }, { appId: 'bot', appSecret: 'changed-secret' }, null]) {
    changeCredentials(credentials);
    await assert.rejects(client.sendText('hello', undefined, target), notSent);
    await assert.rejects(client.sendImage(filePath, target), notSent);
    await assert.rejects(client.sendFile(filePath, 'report.txt', target), notSent);
  }
  assert.equal(calls.length, 0);
  assert.equal(uploads.length, 0);
  assert.equal((await db.peekQqReply(options())).sequence, 0);
});

test('account change during upload aborts before bytes or final send and keeps the reserved target', async t => {
  const { client, db, filePath, changeCredentials } = await setup(t);
  await db.storeQqInbound(inbound('live'));
  const target = await client.captureSendTarget(recipientId(ref()));
  const { calls, uploads } = mockTransport(client, async call => {
    if (call.url.endsWith('/upload_prepare')) changeCredentials({ appId: 'bot', appSecret: 'rotated' });
  });
  await assert.rejects(client.sendFile(filePath, 'report.txt', target), notSent);
  assert.equal(calls.length, 1);
  assert.equal(uploads.length, 0);
  assert.equal((await db.peekQqReply(options())).sequence, 0);
});

test('quota consumed by another window during upload prevents proactive fallback', async t => {
  const { client, db, filePath } = await setup(t);
  await db.storeQqInbound(inbound('live'));
  const target = await client.captureSendTarget(recipientId(ref()));
  const { calls } = mockTransport(client, async call => {
    if (call.url.endsWith('/files')) for (let i = 0; i < 4; i++) await db.reserveQqReply(options());
  });
  await assert.rejects(client.sendFile(filePath, 'report.txt', target), notSent);
  assert.ok(!calls.some(call => call.url.endsWith('/messages')));
  await assert.rejects(client.sendText('cannot fall back', undefined, target), notSent);
});

test('explicit targets use independent peer quotas and never recycle a failed attempt', async t => {
  const { client, db } = await setup(t);
  await db.storeQqInbound(inbound('alice-inbound'));
  await db.storeQqInbound(inbound('bob-inbound', 'bob'));
  const alice = await client.captureSendTarget(recipientId(ref()));
  const bob = await client.captureSendTarget(recipientId(ref('bob')));
  let reject = true;
  const { calls } = mockTransport(client, async call => {
    if (reject && call.url.endsWith('/messages')) { reject = false; throw new Error('uncertain timeout'); }
  });
  await assert.rejects(client.sendText('uncertain', undefined, alice), /uncertain timeout/);
  await Promise.all([client.sendText('alice again', undefined, alice), client.sendText('bob once', undefined, bob)]);
  assert.deepEqual(calls.filter(call => call.target.peerId === 'alice').map(call => call.body.msg_seq), [1, 2]);
  assert.deepEqual(calls.filter(call => call.target.peerId === 'bob').map(call => call.body.msg_seq), [1]);
});

test('accepted sends keep the original account in history when credentials change after the response', async t => {
  const { client, db, changeCredentials } = await setup(t);
  await db.storeQqInbound(inbound('live'));
  const target = await client.captureSendTarget(recipientId(ref()));
  mockTransport(client, async call => {
    if (call.url.endsWith('/messages')) changeCredentials({ appId: 'other-bot', appSecret: 'other' });
  });
  await client.sendText('already accepted', undefined, target);
  const sent = (await db.getRecentMessages()).find(message => message.direction === 'sent');
  assert.equal(sent.from_user_id, 'bot');
  assert.equal(sent.to_user_id, 'alice');
});

function seedToken(state) {
  state.client.accessToken = 'original-token';
  state.client.accessTokenExpiresAt = Date.now() + 3_600_000;
  state.client.accessTokenCredentialKey = state.client.credentialKey(state.credentials());
}

test('actual HTTP 401 retry retains the same peer, quota sequence and credential identity', async t => {
  const state = await setup(t), { client, db, dispatcher } = state;
  await db.storeQqInbound(inbound('live'));
  const target = await client.captureSendTarget(recipientId(ref()));
  seedToken(state);
  const api = dispatcher.get('https://api.bot.qq.com'), bodies = [];
  api.intercept({ path: '/v2/users/alice/messages', method: 'POST' }).reply(request => {
    bodies.push(JSON.parse(request.body));
    return { statusCode: 401, data: { err_code: 401 } };
  });
  api.intercept({ path: '/app/getAppAccessToken', method: 'POST' }).reply(request => {
    assert.deepEqual(JSON.parse(request.body), { appId: state.credentials().appId, clientSecret: state.credentials().appSecret });
    return { statusCode: 200, data: { access_token: 'refreshed-token', expires_in: 7200 } };
  });
  api.intercept({ path: '/v2/users/alice/messages', method: 'POST' }).reply(request => {
    bodies.push(JSON.parse(request.body));
    return { statusCode: 200, data: { id: 'accepted' } };
  });
  await client.sendText('safe retry', undefined, target);
  assert.deepEqual(bodies.map(body => [body.msg_id, body.msg_seq]), [['live', 1], ['live', 1]]);
  dispatcher.assertNoPendingInterceptors();
});

test('actual HTTP 401 cannot refresh or retry under changed credentials', async t => {
  const state = await setup(t), { client, db, dispatcher, changeCredentials } = state;
  await db.storeQqInbound(inbound('live'));
  const target = await client.captureSendTarget(recipientId(ref()));
  seedToken(state);
  dispatcher.get('https://api.bot.qq.com').intercept({ path: '/v2/users/alice/messages', method: 'POST' }).reply(() => {
    changeCredentials({ appId: 'bot', appSecret: 'rotated-secret' });
    return { statusCode: 401, data: { err_code: 401 } };
  });
  await assert.rejects(client.sendText('stop retry', undefined, target), notSent);
  assert.equal((await db.peekQqReply(options())).sequence, 1);
  assert.equal((await db.getRecentMessages()).filter(row => row.direction === 'sent').length, 0);
  dispatcher.assertNoPendingInterceptors();
});

test('a token cached for another credential identity is never reused', async t => {
  const state = await setup(t), { client, dispatcher, changeCredentials } = state;
  seedToken(state);
  changeCredentials({ appId: 'different-bot', appSecret: 'different-secret' });
  const api = dispatcher.get('https://api.bot.qq.com');
  api.intercept({ path: '/app/getAppAccessToken', method: 'POST' }).reply(request => {
    assert.equal(JSON.parse(request.body).appId, 'different-bot');
    return { statusCode: 200, data: { access_token: 'different-token', expires_in: 7200 } };
  });
  assert.equal(await client.getAccessToken(), 'different-token');
  assert.notEqual(client.accessToken, 'original-token');
  dispatcher.assertNoPendingInterceptors();
});

test('legacy direct calls keep automatic routing and proactive compatibility', async t => {
  const { client, db } = await setup(t);
  configuration.set('vschat.qqUserOpenId', 'legacy-configured');
  const { calls } = mockTransport(client);
  await client.sendText('legacy proactive');
  assert.equal(calls[0].url, '/v2/users/legacy-configured/messages');
  assert.equal(calls[0].body.msg_id, undefined);
  assert.equal((await db.getRecentMessages())[0].to_user_id, 'legacy-configured');
});

test('incoming messages retain the authenticated gateway account after settings change', async t => {
  const { client, db, changeCredentials } = await setup(t);
  client.gatewayAccountId = 'original-bot';
  changeCredentials({ appId: 'new-bot', appSecret: 'new-secret' });
  await client.processC2CMessage({ id: 'old-socket-event', author: { user_openid: 'old-peer' }, content: 'from original bot', timestamp: new Date().toISOString() });
  const stored = await db.findByMessageId('old-socket-event');
  assert.equal(stored.to_user_id, 'original-bot');
  assert.deepEqual((await client.getRecipients()).recipients, []);
});

test('gateway resumes only a session bound to the same credential identity', async t => {
  const state = await setup(t), { client, db } = state;
  seedToken(state);
  const sent = [];
  client.createGatewaySocket = () => ({ readyState: 1, addEventListener() {},
    send(value) { sent.push(JSON.parse(value)); }, close() { this.readyState = 3; } });
  client.requestApi = async () => ({ url: 'wss://gateway.example.test' });
  await db.saveQqGatewayCheckpoint({ sessionId: 'old-session', sequence: 42, credentialKey: 'another-credential' });
  await client.startPolling();
  await client.handleHello(30_000);
  assert.equal(sent.at(-1).op, 2);
  assert.equal(client.gatewayAccountId, 'bot');
  client.stopPolling();
  await db.saveQqGatewayCheckpoint({ sessionId: 'old-session', sequence: 42, credentialKey: client.credentialKey(state.credentials()) });
  await client.startPolling();
  await client.handleHello(30_000);
  assert.equal(sent.at(-1).op, 6);
  assert.equal(sent.at(-1).d.session_id, 'old-session');
  assert.equal(sent.at(-1).d.seq, 42);
});
