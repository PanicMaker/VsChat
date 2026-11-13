const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const undici = require('undici');
const { ChatDB } = require('./runtime.cjs');
const { WxClient } = require('../src/wx-client.ts');
const { recipientId } = require('../src/recipient-types.ts');
const { FileSendError } = require('../src/file-transfer.ts');

const ref = peerId => ({ accountId: 'bot', peerId });
const cdn = 'https://novac2c.cdn.weixin.qq.com/c2c/upload?fixture=only';

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-wx-recipients-'));
  const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, 'wechat');
  await db.init();
  const context = { globalStorageUri: { fsPath: directory }, secrets: {
    async get() { return 'credential-one'; }, async store() {}, async delete() {},
  } };
  const client = new WxClient(context, db);
  client.botToken = 'credential-one'; client._connected = true;
  client.getProxyAgent = () => undefined;
  client.sleep = async () => {};
  const requests = [], uploads = [], events = [];
  client.onMessage(event => events.push(event));
  const state = { send: () => ({ message_id: '12345' }), upload: () => ({ upload_full_url: cdn }) };
  client.request = async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url, body, init });
    if (url === '/ilink/bot/getuploadurl') return state.upload(body);
    assert.equal(url, '/ilink/bot/sendmessage');
    return state.send(body);
  };
  client.requestRaw = async () => { throw new Error('Unexpected live request'); };
  const fetch = undici.fetch;
  undici.fetch = async (url, init) => {
    assert.equal(url, cdn); uploads.push({ url, init });
    await state.onCdn?.();
    return new undici.Response(null, { status: 200, headers: { 'x-encrypted-param': 'fixture-download' } });
  };
  let inboundCounter = 0;
  const inbound = (peerId, token = `token-${peerId}`, accountId = 'bot') => client.processMessages([{
    from_user_id: peerId, to_user_id: accountId, context_token: token,
    message_type: 1, message_state: 2, message_id: `in-${++inboundCounter}`,
    item_list: [{ type: 1, text_item: { text: `hello ${peerId}` } }],
  }]);
  const file = path.join(directory, 'fixture.png');
  fs.writeFileSync(file, 'mock media bytes');
  t.after(async () => {
    undici.fetch = fetch; client.dispose(); await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { client, db, context, directory, requests, uploads, events, state, inbound, file };
}

test('recipient list separates live peers from history and never exposes context or login secrets', async t => {
  const { client, db, inbound } = await setup(t);
  assert.deepEqual((await client.getRecipients()).recipients, []);
  await inbound('Alice'); await inbound('Bob', '');
  await db.insertMessage({ direction: 'sent', type: 1, content: 'history', timestamp: 100,
    from_user_id: 'bot', to_user_id: 'history-only', context_token: 'imported-secret' });
  await db.insertMessage({ direction: 'received', type: 1, content: 'other account', timestamp: 100,
    from_user_id: 'stranger', to_user_id: 'other-bot', context_token: 'other-secret' });
  const recipients = await client.getRecipients();
  assert.equal(recipients.accountId, 'bot');
  const peers = new Map(recipients.recipients.map(item => [item.conversation.peerId, item]));
  assert.equal(peers.get('Alice').canSend, true);
  assert.equal(peers.get('Bob').canSend, false);
  assert.equal(peers.get('history-only').canSend, false);
  assert.equal(peers.has('stranger'), false);
  assert.ok(!JSON.stringify(recipients).includes('secret'));
  assert.ok(!JSON.stringify(recipients).includes('token-Alice'));
  assert.ok(!JSON.stringify(recipients).includes('credential-one'));
  await assert.rejects(client.captureSendTarget(recipientId(ref('Bob'))));
  await assert.rejects(client.captureSendTarget(recipientId(ref('history-only'))));
  await assert.rejects(client.captureSendTarget('Alice'));
  const target = await client.captureSendTarget(recipientId(ref('Alice')));
  assert.ok(Object.isFrozen(target));
  assert.equal(target.sessionKey, crypto.createHash('sha256').update('credential-one').digest('hex'));
});

test('same credentials restore live routes while a new login cannot reactivate old peers', async t => {
  const { client, db, context, inbound, requests } = await setup(t);
  await inbound('Alice');
  const target = await client.captureSendTarget(recipientId(ref('Alice')));
  const restored = new WxClient(context, db);
  try {
    await restored.restoreLogin();
    assert.equal((await restored.getRecipients()).recipients[0].canSend, true);
  } finally { restored.dispose(); }
  client.botToken = 'credential-two';
  assert.deepEqual((await client.getRecipients()).recipients, []);
  await assert.rejects(client.sendText('never route by history', undefined, target));
  assert.equal(requests.length, 0);
  await inbound('Bob');
  const peers = new Map((await client.getRecipients()).recipients.map(item => [item.label, item.canSend]));
  assert.equal(peers.get('Alice'), false); assert.equal(peers.get('Bob'), true);
});

test('text retry keeps the captured peer, token and quote after another peer arrives', async t => {
  const { client, inbound, state, requests, db } = await setup(t);
  await inbound('Alice');
  const target = await client.captureSendTarget(recipientId(ref('Alice')));
  const reply = { messageId: 'quoted-Alice', text: 'Alice quote', type: 1 };
  let attempts = 0;
  state.send = async () => {
    if (++attempts === 1) {
      await inbound('Bob'); reply.text = 'mutated quote';
      return { ret: -2, errmsg: 'rate limit' };
    }
    return { message_id: 'success' };
  };
  await client.sendText('to Alice', reply, target);
  assert.equal(requests.length, 2);
  for (const { body } of requests) {
    assert.equal(body.msg.to_user_id, 'Alice'); assert.equal(body.msg.from_user_id, 'bot');
    assert.equal(body.msg.context_token, 'token-Alice');
    assert.equal(body.msg.item_list[0].ref_msg.title, 'Alice quote');
  }
  const sent = (await db.getRecentMessages()).find(row => row.direction === 'sent');
  assert.equal(sent.to_user_id, 'Alice'); assert.equal(sent.context_token, 'token-Alice');
});

test('target copies resist caller mutation and keep a refreshed peer token frozen', async t => {
  const { client, inbound, requests } = await setup(t);
  await inbound('Alice');
  const target = { ...await client.captureSendTarget(recipientId(ref('Alice'))) };
  await inbound('Alice', 'new-Alice-token');
  const sending = client.sendText('captured token', undefined, target);
  target.peerId = 'Bob'; target.contextToken = 'evil-mutation';
  await sending;
  assert.equal(requests[0].body.msg.to_user_id, 'Alice');
  assert.equal(requests[0].body.msg.context_token, 'token-Alice');
});

test('stale context recovery clears only its own unchanged token and never switches peer', async t => {
  const { client, inbound, state, requests } = await setup(t);
  await inbound('Alice'); await inbound('Bob');
  const target = await client.captureSendTarget(recipientId(ref('Alice')));
  let attempts = 0;
  state.send = () => ++attempts === 1 ? { ret: -2, errmsg: 'prepare failed' } : { message_id: 'success' };
  await client.sendText('recover Alice', undefined, target);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.msg.to_user_id, 'Alice');
  assert.equal('context_token' in requests[1].body.msg, false);
  const peers = new Map((await client.getRecipients()).recipients.map(item => [item.label, item.canSend]));
  assert.equal(peers.get('Alice'), false); assert.equal(peers.get('Bob'), true);
  assert.equal((await client.captureSendTarget(recipientId(ref('Bob')))).contextToken, 'token-Bob');
});

test('stale recovery compare-delete preserves a newer token for the same recipient', async t => {
  const { client, inbound, state } = await setup(t);
  await inbound('Alice');
  const target = await client.captureSendTarget(recipientId(ref('Alice')));
  let attempts = 0;
  state.send = async () => {
    if (++attempts === 1) { await inbound('Alice', 'refreshed'); return { ret: -2, errmsg: 'prepare failed' }; }
    return { message_id: 'success' };
  };
  await client.sendText('old token', undefined, target);
  assert.equal((await client.captureSendTarget(recipientId(ref('Alice')))).contextToken, 'refreshed');
});

test('-14 with missing or successful ret expires login without tokenless resend or local success', async t => {
  const { client, inbound, state, requests, db } = await setup(t);
  await inbound('Alice');
  for (const response of [{ errcode: -14 }, { ret: 0, errcode: -14 }, { ret: -14 }]) {
    client._connected = true;
    const target = await client.captureSendTarget(recipientId(ref('Alice')));
    state.send = () => response; requests.length = 0;
    await assert.rejects(client.sendText('must reject', undefined, target), /登录已过期/);
    assert.equal(requests.length, 1); assert.equal(client.connected, false);
  }
  assert.equal((await db.getRecentMessages()).filter(row => row.direction === 'sent').length, 0);
});

test('credential change during rate-limit wait stops all later attempts', async t => {
  const { client, inbound, state, requests } = await setup(t);
  await inbound('Alice');
  const target = await client.captureSendTarget(recipientId(ref('Alice')));
  state.send = () => ({ ret: -2, errmsg: 'rate limit' });
  client.sleep = async () => { client.botToken = 'replacement'; };
  await assert.rejects(client.sendText('stop before retry', undefined, target), /登录已变化/);
  assert.equal(requests.length, 1);
});

test('image upload and retry stay bound to their original target', async t => {
  const { client, inbound, state, requests, uploads, file, db } = await setup(t);
  await inbound('Alice');
  const target = await client.captureSendTarget(recipientId(ref('Alice')));
  let attempts = 0;
  state.upload = async () => { await inbound('Bob'); return { upload_full_url: cdn }; };
  state.send = () => ++attempts === 1 ? { ret: -2, errmsg: 'rate limit' } : { message_id: 'success' };
  await client.sendImage(file, target);
  assert.equal(uploads.length, 2);
  for (const { url, body } of requests) assert.equal(url.endsWith('getuploadurl') ? body.to_user_id : body.msg.to_user_id, 'Alice');
  assert.equal((await db.getRecentMessages()).find(row => row.direction === 'sent').to_user_id, 'Alice');
});

test('file uploads and successful history retain the frozen recipient despite inbound changes', async t => {
  const { client, inbound, state, requests, file, db } = await setup(t);
  await inbound('Alice');
  const target = await client.captureSendTarget(recipientId(ref('Alice')));
  state.onCdn = () => inbound('Bob');
  await client.sendFile(file, 'fixture.txt', target);
  assert.equal(requests[0].body.to_user_id, 'Alice');
  assert.equal(requests[1].body.msg.to_user_id, 'Alice');
  assert.equal(requests[1].body.msg.context_token, 'token-Alice');
  assert.equal((await db.getRecentMessages()).find(row => row.direction === 'sent').to_user_id, 'Alice');
});

test('login changes before CDN and final media requests prevent further transmission', async t => {
  const { client, inbound, state, requests, uploads, file } = await setup(t);
  await inbound('Alice');
  const target = await client.captureSendTarget(recipientId(ref('Alice')));
  for (const method of ['sendImage', 'sendFile']) {
    for (const phase of ['prepare', 'cdn']) {
      client.botToken = 'credential-one'; requests.length = 0; uploads.length = 0;
      state.upload = () => {
        if (phase === 'prepare') client.botToken = 'replacement';
        return { upload_full_url: cdn };
      };
      state.onCdn = () => { if (phase === 'cdn') client.botToken = 'replacement'; };
      const sending = method === 'sendImage' ? client.sendImage(file, target) : client.sendFile(file, 'fixture.txt', target);
      await assert.rejects(sending, error => method !== 'sendFile' || error instanceof FileSendError);
      assert.equal(requests.length, 1); assert.ok(requests[0].url.endsWith('getuploadurl'));
      assert.equal(uploads.length, phase === 'prepare' ? 0 : 1);
    }
  }
});

test('legacy direct calls freeze one destination and never substitute the polling cursor for context', async t => {
  const { client, db, inbound, state, requests } = await setup(t);
  await inbound('Alice');
  await db.setMetadata('context_token', ''); await db.setMetadata('last_cursor', 'private-poll-cursor');
  let attempts = 0;
  state.send = async () => {
    if (++attempts === 1) { await inbound('Bob'); return { ret: -2, errmsg: 'rate limit' }; }
    return { message_id: 'success' };
  };
  await client.sendText('legacy fixed target');
  assert.equal(requests.length, 2);
  for (const { body } of requests) {
    assert.equal(body.msg.to_user_id, 'Alice');
    assert.equal(body.msg.context_token, '');
    assert.ok(!JSON.stringify(body).includes('private-poll-cursor'));
  }
});

test('old polling responses cannot seed recipients or replace the cursor after credential change', async t => {
  const { client, db } = await setup(t);
  const envelope = { from_user_id: 'old-peer', to_user_id: 'old-bot', context_token: 'old-token',
    message_id: '777', item_list: [{ type: 1, text_item: { text: 'old' } }] };
  client.polling = true; client.pollingAbort = new AbortController();
  client.requestRaw = async () => {
    client.botToken = 'new-login';
    return { json: { msgs: [envelope], get_updates_buf: 'old-cursor' }, text: JSON.stringify({ msgs: [envelope] }) };
  };
  await client.pollLoop();
  assert.equal((await db.getRecentMessages()).length, 0);
  assert.equal(await db.getMetadata('last_cursor'), null);
  assert.deepEqual((await client.getRecipients()).recipients, []);
});

test('polling -14 stops the login without saving the response cursor', async t => {
  const { client, db } = await setup(t);
  client.polling = true; client.pollingAbort = new AbortController();
  let calls = 0;
  client.requestRaw = async () => {
    calls++;
    return { json: { ret: 0, errcode: -14, get_updates_buf: 'rejected' }, text: '{}' };
  };
  await client.pollLoop();
  assert.equal(calls, 1); assert.equal(client.connected, false);
  assert.equal(await db.getMetadata('last_cursor'), null);
});

test('only explicit rejections retry, and both rate-limit and tokenless recovery are bounded', async t => {
  const { client, inbound, state, requests } = await setup(t);
  await inbound('Alice');
  const target = await client.captureSendTarget(recipientId(ref('Alice')));
  state.send = () => { throw new Error('uncertain network result'); };
  await assert.rejects(client.sendText('no blind retry', undefined, target), /uncertain/);
  assert.equal(requests.length, 1);
  requests.length = 0;
  state.send = () => ({ ret: -2, errmsg: 'rate limit' });
  await assert.rejects(client.sendText('limited', undefined, target), /限流/);
  assert.equal(requests.length, 4);
  requests.length = 0;
  state.send = () => ({ ret: -2, errmsg: 'prepare failed' });
  await assert.rejects(client.sendText('stale', undefined, target), /会话已过期/);
  assert.equal(requests.length, 2);
});

test('inbound quote fallback cannot borrow another conversation text', async t => {
  const { client, db } = await setup(t);
  const now = Math.floor(Date.now() / 1000);
  await db.insertMessage({ direction: 'received', type: 1, content: 'Bob private quote', timestamp: now,
    from_user_id: 'Bob', to_user_id: 'bot', context_token: '', message_id: 'quote-only-in-Bob' });
  await client.processMessages([{
    from_user_id: 'Alice', to_user_id: 'bot', context_token: 'Alice-token',
    message_type: 1, message_state: 2, message_id: 'Alice-quote-message',
    item_list: [{ type: 1, text_item: { text: 'Alice reply' }, ref_msg: {
      message_item: { type: 1, msg_id: 'quote-only-in-Bob', create_time_ms: now * 1000 },
    } }],
  }]);
  const row = (await db.getRecentMessages()).find(message => message.message_id === 'Alice-quote-message');
  assert.equal(JSON.parse(row.reply_to).text, '');
});

test('late auth rejection from an old send cannot disconnect a replacement login', async t => {
  const { client, inbound, state, requests } = await setup(t);
  await inbound('Alice');
  const target = await client.captureSendTarget(recipientId(ref('Alice')));
  state.send = () => { client.botToken = 'new-login'; return { errcode: -14 }; };
  await assert.rejects(client.sendText('old send', undefined, target), /登录已过期/);
  assert.equal(client.connected, true); assert.equal(requests.length, 1);
});

test('QR confirmation cannot silently reuse an earlier login credential', async t => {
  const { client } = await setup(t);
  let calls = 0;
  client.request = async () => ++calls === 1
    ? { status: 'confirmed' } : { status: 'confirmed', bot_token: 'new-credential' };
  assert.equal(await client.pollQrStatus('mock-qr'), true);
  assert.equal(calls, 2); assert.equal(client.botToken, 'new-credential');
});
