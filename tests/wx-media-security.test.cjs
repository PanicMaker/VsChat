const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MockAgent } = require('undici');
require('./runtime.cjs');
const { WxClient } = require('../src/wx-client.ts');
const { DEFAULT_WX_BASE_URL, WX_ENDPOINT_SECRET } = require('../src/wx-credentials.ts');

const cdn = 'https://novac2c.cdn.weixin.qq.com';
const key = Buffer.alloc(16, 42);
const keyText = key.toString('base64');
const image = Buffer.from('89504e470d0a1a0a', 'hex');
const encrypt = value => {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(value), cipher.final()]);
};
function setup(t, secrets = new Map()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-wx-security-'));
  const agent = new MockAgent(); agent.disableNetConnect();
  const context = { globalStorageUri: { fsPath: root }, secrets: {
    async get(name) { return secrets.get(name); }, async store(name, value) { secrets.set(name, value); },
    async delete(name) { secrets.delete(name); },
  } };
  const rows = [], events = [];
  const db = { async storeWxInbound(message) { rows.push(structuredClone(message)); return { id: rows.length, inserted: true }; },
    async markMessageMediaReady() {}, async setMetadata() {} };
  const client = new WxClient(context, db); client.getProxyAgent = () => agent;
  client.onMessage(event => events.push(event));
  t.after(async () => { client.dispose(); await agent.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, agent, client, rows, events, secrets, context, db };
}
const imagePart = url => ({ type: 2, image_item: { media: { full_url: url, aes_key: keyText } } });

test('actual WeChat inbound images reject unsafe URLs and redirects without exposing remote fallback', async t => {
  const { client, rows, events, agent } = setup(t);
  let unsafeRequests = 0;
  agent.get('http://127.0.0.1').intercept({ path: '/private' }).reply(() => {
    unsafeRequests++; return { statusCode: 200, data: encrypt(image) };
  }).persist();
  agent.get(cdn).intercept({ path: '/redirect' }).reply(302, '', { headers: { location: 'http://127.0.0.1/private' } });
  agent.get(cdn).intercept({ path: '/good' }).reply(200, encrypt(image));
  await client.processMessages([{ from_user_id: 'peer', to_user_id: 'bot', message_type: 1,
    message_id: 'envelope', context_token: 'context', item_list: [
      { type: 1, text_item: { text: 'caption remains' } }, imagePart('http://127.0.0.1/private'),
      imagePart(`${cdn}/redirect`), imagePart(`${cdn}/good`),
      { type: 4, file_item: { file_name: 'kept.txt', len: '8' } },
    ] }]);
  assert.equal(unsafeRequests, 0); assert.equal(rows.length, 1); assert.equal(events.length, 1);
  assert.match(rows[0].content, /caption remains/); assert.match(rows[0].content, /kept.txt/);
  for (const part of rows[0].parts.filter(value => value.type === 2)) assert.equal(part.url, undefined);
  assert.equal(events[0].parts[1].imageDataUrl, undefined);
  assert.equal(events[0].parts[2].imageDataUrl, undefined);
  assert.equal(events[0].parts[3].imageDataUrl, `data:image/png;base64,${image.toString('base64')}`);
  assert.equal(await client.getDecryptedImageUrl(1, 3), events[0].parts[3].imageDataUrl);
  assert.doesNotMatch(JSON.stringify(events), /127\.0\.0\.1|\/redirect/);
});

test('WeChat API redirects never forward request bodies or credentials', async t => {
  const { client, agent } = setup(t);
  client.botToken = 'fixture-private-token';
  let destinationRequests = 0;
  agent.get(DEFAULT_WX_BASE_URL).intercept({ path: '/ilink/bot/sendmessage', method: 'POST' })
    .reply(307, '', { headers: { location: 'https://outside.example/post' } });
  agent.get('https://outside.example').intercept({ path: '/post', method: 'POST' }).reply(() => {
    destinationRequests++; return { statusCode: 200, data: '{}' };
  }).persist();
  await assert.rejects(client.requestRaw('/ilink/bot/sendmessage', { method: 'POST', body: '{"private":"message"}' }));
  assert.equal(destinationRequests, 0);
});

test('QR login saves a paired trusted endpoint and SecretStorage restore works without credential file', async t => {
  const { client, root, secrets, context, db, agent } = setup(t);
  client.sleep = async () => {};
  const endpoint = 'https://ilink-bot.weixin.qq.com';
  client.request = async request => request.includes('get_bot_qrcode') ? { qrcode: 'mock-qr' }
    : { status: 'confirmed', bot_token: 'paired-token', baseurl: endpoint };
  await client.login();
  assert.equal(secrets.get('vschat_token'), 'paired-token');
  const binding = JSON.parse(secrets.get(WX_ENDPOINT_SECRET));
  assert.equal(binding.baseUrl, endpoint); assert.equal(binding.tokenHash, crypto.createHash('sha256').update('paired-token').digest('hex'));
  fs.unlinkSync(path.join(root, 'credentials.json'));
  const restored = new WxClient(context, db); restored.getProxyAgent = () => agent;
  try {
    assert.equal(await restored.restoreLogin(), true); assert.equal(restored.botBaseUrl, endpoint);
    agent.get(endpoint).intercept({ path: '/probe', method: 'POST' }).reply(request => {
      assert.match(JSON.stringify(request.headers), /paired-token/);
      return { statusCode: 200, data: '{}' };
    });
    await restored.requestRaw('/probe', { method: 'POST', body: '{}' });
    agent.assertNoPendingInterceptors();
  } finally { restored.dispose(); }
});

test('legacy endpoint restoration uses only a matching token and preserves credential data', async t => {
  const { client, root, secrets } = setup(t, new Map([['vschat_token', 'token-new']]));
  const file = path.join(root, 'credentials.json');
  fs.writeFileSync(file, JSON.stringify({ token: 'token-old', baseUrl: 'https://old.weixin.qq.com' }));
  const before = fs.readFileSync(file);
  await client.restoreLogin(); assert.equal(client.botBaseUrl, DEFAULT_WX_BASE_URL);
  assert.deepEqual(fs.readFileSync(file), before);
  fs.writeFileSync(file, JSON.stringify({ token: 'token-new', baseUrl: 'https://matched.weixin.qq.com/' }));
  await client.restoreLogin(); assert.equal(client.botBaseUrl, 'https://matched.weixin.qq.com');
  fs.writeFileSync(file, JSON.stringify({ token: 'token-new', baseUrl: 'http://127.0.0.1/private' }));
  await client.restoreLogin(); assert.equal(client.botBaseUrl, DEFAULT_WX_BASE_URL);
  assert.equal(secrets.has(WX_ENDPOINT_SECRET), false, 'restore does not overwrite legacy data');
});

test('QR confirmation rejects untrusted endpoint without adopting its token', async t => {
  const { client } = setup(t); client.sleep = async () => {};
  let calls = 0;
  client.request = async () => ++calls === 1
    ? { status: 'confirmed', bot_token: 'do-not-adopt', baseurl: 'https://outside.example' }
    : { status: 'expired' };
  assert.equal(await client.pollQrStatus('mock-qr'), false);
  assert.equal(client.botToken, ''); assert.equal(client.botBaseUrl, DEFAULT_WX_BASE_URL);
});
