const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
require('./runtime.cjs');
const { DEFAULT_WX_BASE_URL, WX_ENDPOINT_SECRET, trustedWxBaseUrl, saveWxEndpoint, restoreWxEndpoint } = require('../src/wx-credentials.ts');

function secretStorage(initial = {}) {
  const records = new Map(Object.entries(initial)), writes = [];
  return { records, writes, async get(key) { return records.get(key); },
    async store(key, value) { writes.push({ key, value }); records.set(key, value); } };
}

test('trusted endpoints use official HTTPS hosts, normalize ports/slashes and preserve path prefixes', () => {
  assert.equal(DEFAULT_WX_BASE_URL, 'https://ilinkai.weixin.qq.com');
  assert.equal(WX_ENDPOINT_SECRET, 'vschat_endpoint_v1');
  for (const [input, expected] of [
    ['https://ilinkai.weixin.qq.com/', DEFAULT_WX_BASE_URL],
    ['HTTPS://ILINKAI.WEIXIN.QQ.COM:443///', DEFAULT_WX_BASE_URL],
    ['https://weixin.qq.com', 'https://weixin.qq.com'],
    ['https://api.weixin.qq.com/api/v1/', 'https://api.weixin.qq.com/api/v1'],
  ]) assert.equal(trustedWxBaseUrl(input), expected, input);
});

test('untrusted endpoints, URL credentials, nonstandard ports, query/hash and controls are rejected', () => {
  for (const input of [undefined, null, {}, '', ' https://ilinkai.weixin.qq.com',
    'http://ilinkai.weixin.qq.com', 'https://evil.example', 'https://127.0.0.1', 'https://[::1]',
    'https://weixin.qq.com.evil.example', 'https://evilweixin.qq.com', 'https://qq.com',
    'https://user:password@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:8443',
    'https://ilinkai.weixin.qq.com.', 'https://ilinkai.weixin.qq.com?token=secret',
    'https://ilinkai.weixin.qq.com#fragment', 'https://ilinkai.weixin.qq.com?', 'https://ilinkai.weixin.qq.com#',
    'https://ilinkai.weixin.qq.com/\npath', 'https://ilinkai.weixin.qq.com/\\evil',
    'https://ilinkai.weixin.qq.com/%250aheader', 'https://ilinkai.weixin.qq.com/%5cpath',
    `https://ilinkai.weixin.qq.com/${'a'.repeat(2048)}`,
  ]) assert.equal(trustedWxBaseUrl(input), undefined, String(input));
});

test('saving binds the endpoint to a token digest and changes only the new secret key', async () => {
  const secrets = secretStorage({ vschat_token: 'keep-this-token', legacy: 'keep-this-data' });
  await saveWxEndpoint(secrets, 'actual-bot-token', 'https://alt.weixin.qq.com/');
  assert.equal(secrets.writes.length, 1);
  assert.equal(secrets.writes[0].key, WX_ENDPOINT_SECRET);
  assert.deepEqual(JSON.parse(secrets.records.get(WX_ENDPOINT_SECRET)), {
    version: 1, tokenHash: createHash('sha256').update('actual-bot-token').digest('hex'), baseUrl: 'https://alt.weixin.qq.com',
  });
  assert.ok(!secrets.records.get(WX_ENDPOINT_SECRET).includes('actual-bot-token'));
  assert.equal(secrets.records.get('vschat_token'), 'keep-this-token');
  assert.equal(secrets.records.get('legacy'), 'keep-this-data');
  assert.equal(await restoreWxEndpoint(secrets, 'actual-bot-token'), 'https://alt.weixin.qq.com');
});

test('invalid saves do not overwrite a previous binding or reveal input credentials in the error', async () => {
  const secrets = secretStorage({ [WX_ENDPOINT_SECRET]: 'keep-binding' });
  for (const [token, baseUrl] of [['', DEFAULT_WX_BASE_URL], ['  ', DEFAULT_WX_BASE_URL],
    ['PRIVATE_TOKEN', 'https://evil.example/?PRIVATE_QUERY'], ['PRIVATE_TOKEN', 'http://ilinkai.weixin.qq.com']]) {
    await assert.rejects(saveWxEndpoint(secrets, token, baseUrl), error => {
      assert.doesNotMatch(error.message, /PRIVATE_TOKEN|PRIVATE_QUERY|evil\.example/);
      return true;
    });
  }
  assert.equal(secrets.writes.length, 0);
  assert.equal(secrets.records.get(WX_ENDPOINT_SECRET), 'keep-binding');
});

test('restoration never pairs an old endpoint with a different token', async () => {
  const secrets = secretStorage();
  await saveWxEndpoint(secrets, 'old-token', 'https://old.weixin.qq.com');
  assert.equal(await restoreWxEndpoint(secrets, 'new-token'), DEFAULT_WX_BASE_URL);
  assert.equal(await restoreWxEndpoint(secrets, 'new-token', { token: 'old-token', baseUrl: 'https://old-file.weixin.qq.com' }), DEFAULT_WX_BASE_URL);
  assert.equal(await restoreWxEndpoint(secrets, 'new-token', { token: 'new-token', baseUrl: 'https://new-file.weixin.qq.com/' }), 'https://new-file.weixin.qq.com');
  assert.equal(secrets.writes.length, 1, 'restoration is read-only');
});

test('a valid secret binding takes priority over a matching legacy credential file', async () => {
  const secrets = secretStorage();
  await saveWxEndpoint(secrets, 'token', 'https://secret.weixin.qq.com');
  const legacy = Object.freeze({ token: 'token', baseUrl: 'https://file.weixin.qq.com', unrelated: 'preserve' });
  assert.equal(await restoreWxEndpoint(secrets, 'token', legacy), 'https://secret.weixin.qq.com');
  assert.equal(legacy.unrelated, 'preserve');
  assert.equal(secrets.writes.length, 1);
});

test('missing, malformed, untrusted or mismatched bindings fall back only to a matching trusted file', async () => {
  const digest = createHash('sha256').update('token').digest('hex');
  const rawBindings = [undefined, '{broken', JSON.stringify([]), JSON.stringify(null),
    JSON.stringify({ version: 2, tokenHash: digest, baseUrl: 'https://future.weixin.qq.com' }),
    JSON.stringify({ version: 1, tokenHash: 'mismatched', baseUrl: 'https://wrong.weixin.qq.com' }),
    JSON.stringify({ version: 1, tokenHash: digest, baseUrl: 'https://evil.example' }), 'a'.repeat(4097)];
  for (const raw of rawBindings) {
    const secrets = secretStorage(raw === undefined ? {} : { [WX_ENDPOINT_SECRET]: raw });
    assert.equal(await restoreWxEndpoint(secrets, 'token', { token: 'token', baseUrl: 'https://file.weixin.qq.com' }), 'https://file.weixin.qq.com');
    assert.equal(await restoreWxEndpoint(secrets, 'token', { token: 'other', baseUrl: 'https://file.weixin.qq.com' }), DEFAULT_WX_BASE_URL);
    assert.equal(await restoreWxEndpoint(secrets, 'token', { token: 'token', baseUrl: 'https://evil.example' }), DEFAULT_WX_BASE_URL);
    assert.equal(secrets.writes.length, 0);
  }
});

test('legacy files without an endpoint use the default; unavailable bindings never mutate credentials', async () => {
  const secrets = secretStorage();
  assert.equal(await restoreWxEndpoint(secrets, 'token', { token: 'token' }), DEFAULT_WX_BASE_URL);
  assert.equal(await restoreWxEndpoint(secrets, '', { token: '', baseUrl: 'https://other.weixin.qq.com' }), DEFAULT_WX_BASE_URL);
  secrets.get = async () => { throw new Error('storage unavailable'); };
  assert.equal(await restoreWxEndpoint(secrets, 'token', { token: 'token', baseUrl: 'https://file.weixin.qq.com' }), 'https://file.weixin.qq.com');
  assert.equal(await restoreWxEndpoint(secrets, 'token'), DEFAULT_WX_BASE_URL);
  assert.equal(secrets.writes.length, 0);
});
