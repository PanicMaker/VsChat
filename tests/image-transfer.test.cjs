const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { MockAgent } = require('undici');
require('./runtime.cjs');
const { MAX_IMAGE_BYTES, MAX_FILE_BYTES, downloadImageBytes, downloadFileBytes } = require('../src/file-transfer.ts');

const origin = 'https://novac2c.cdn.weixin.qq.com';
const url = pathname => `${origin}${pathname}`;
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const rawKey = key.toString('base64');
const hexKey = Buffer.from(key.toString('hex')).toString('base64');
const plainImage = Buffer.from('89504e470d0a1a0a0102030405060708', 'hex');
const encrypt = bytes => {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
};

function setup(t) {
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  t.after(() => dispatcher.close());
  return { dispatcher, cdn: dispatcher.get(origin) };
}

test('image downloads reject HTTP, IP/private and unverified hosts before requesting them', async t => {
  const { dispatcher } = setup(t);
  for (const address of ['http://novac2c.cdn.weixin.qq.com/image', 'https://127.0.0.1/private',
    'https://10.0.0.1/private', 'https://[::1]/private', 'https://localhost/private',
    'https://other.example/image', 'https://user:password@novac2c.cdn.weixin.qq.com/image',
    'https://novac2c.cdn.weixin.qq.com:8443/image']) {
    await assert.rejects(downloadImageBytes({ url: address }, { dispatcher }), /不支持/);
  }
  await assert.rejects(downloadImageBytes({ url: url('/unrequested'), expectedSize: MAX_IMAGE_BYTES + 1 }, { dispatcher }), /10 MiB/);
  dispatcher.assertNoPendingInterceptors();
});

test('relative and Tencent cross-domain redirects remain bounded unauthenticated GETs', async t => {
  const { dispatcher, cdn } = setup(t);
  const requests = [];
  const reply = (statusCode, data, headers) => request => {
    requests.push(request);
    return { statusCode, data, responseOptions: { headers } };
  };
  cdn.intercept({ path: '/start', method: 'GET' }).reply(reply(302, '', { location: '/next' }));
  cdn.intercept({ path: '/next', method: 'GET' }).reply(reply(307, '', { location: 'https://gchat.qpic.cn/image' }));
  dispatcher.get('https://gchat.qpic.cn').intercept({ path: '/image', method: 'GET' }).reply(reply(200, plainImage));
  assert.deepEqual(await downloadImageBytes({ url: url('/start'), expectedSize: plainImage.length }, { dispatcher }), plainImage);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.method, 'GET');
    const headers = JSON.stringify(request.headers).toLowerCase();
    assert.doesNotMatch(headers, /authorization|cookie/);
  }
  dispatcher.assertNoPendingInterceptors();
});

test('redirects to HTTP, localhost, private IPs or non-Tencent domains are never followed', async t => {
  const { dispatcher, cdn } = setup(t);
  let unsafeRequests = 0;
  const targets = ['http://novac2c.cdn.weixin.qq.com/insecure', 'https://127.0.0.1/private',
    'https://10.0.0.2/private', 'https://localhost/private', 'https://example.test/private'];
  for (const [index, target] of targets.entries()) {
    cdn.intercept({ path: `/redirect-${index}` }).reply(302, '', { headers: { location: target } });
    const parsed = new URL(target);
    dispatcher.get(parsed.origin).intercept({ path: parsed.pathname }).reply(() => {
      unsafeRequests++;
      return { statusCode: 200, data: plainImage };
    }).persist();
    await assert.rejects(downloadImageBytes({ url: url(`/redirect-${index}`) }, { dispatcher }), /不支持的地址/);
  }
  assert.equal(unsafeRequests, 0);
});

test('image redirect loops stop after three redirects', async t => {
  const { dispatcher, cdn } = setup(t);
  for (let i = 0; i <= 3; i++) cdn.intercept({ path: `/loop-${i}` }).reply(302, '', { headers: { location: `/loop-${i + 1}` } });
  await assert.rejects(downloadImageBytes({ url: url('/loop-0') }, { dispatcher }), /重定向过多/);
  dispatcher.assertNoPendingInterceptors();
});

test('image AES decoding supports raw16 and hex32 keys with optional length and MD5 checks', async t => {
  const { dispatcher, cdn } = setup(t);
  for (const [index, aesKey] of [rawKey, hexKey].entries()) {
    cdn.intercept({ path: `/encrypted-${index}` }).reply(200, encrypt(plainImage));
    const result = await downloadImageBytes({ url: url(`/encrypted-${index}`), aesKey,
      expectedSize: plainImage.length, md5: crypto.createHash('md5').update(plainImage).digest('hex') }, { dispatcher });
    assert.deepEqual(result, plainImage);
  }
  dispatcher.assertNoPendingInterceptors();
});

test('bad image ciphertext, key, plaintext length or MD5 never returns unchecked bytes', async t => {
  const { dispatcher, cdn } = setup(t);
  await assert.rejects(downloadImageBytes({ url: url('/unrequested'), aesKey: 'invalid-private-key' }, { dispatcher }), /解密信息/);
  cdn.intercept({ path: '/broken' }).reply(200, 'invalid ciphertext');
  await assert.rejects(downloadImageBytes({ url: url('/broken'), aesKey: rawKey }, { dispatcher }), /解密失败/);
  cdn.intercept({ path: '/wrong-length' }).reply(200, encrypt(plainImage));
  await assert.rejects(downloadImageBytes({ url: url('/wrong-length'), aesKey: rawKey, expectedSize: plainImage.length + 1 }, { dispatcher }), /长度校验失败/);
  cdn.intercept({ path: '/wrong-hash' }).reply(200, encrypt(plainImage));
  await assert.rejects(downloadImageBytes({ url: url('/wrong-hash'), aesKey: rawKey, md5: '0'.repeat(32) }, { dispatcher }), /校验失败/);
  dispatcher.assertNoPendingInterceptors();
});

test('plaintext image limits apply to declared, actual and decoded content lengths', async t => {
  const { dispatcher, cdn } = setup(t);
  cdn.intercept({ path: '/advertised' }).reply(200, plainImage, { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } });
  await assert.rejects(downloadImageBytes({ url: url('/advertised') }, { dispatcher }), /10 MiB/);
  const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1, 65);
  cdn.intercept({ path: '/streamed' }).reply(200, oversized);
  await assert.rejects(downloadImageBytes({ url: url('/streamed') }, { dispatcher }), /10 MiB/);
  const compressed = zlib.gzipSync(oversized);
  cdn.intercept({ path: '/compressed' }).reply(200, compressed, { headers: {
    'content-encoding': 'gzip', 'content-length': String(compressed.length),
  } });
  await assert.rejects(downloadImageBytes({ url: url('/compressed') }, { dispatcher }), /10 MiB/);
  dispatcher.assertNoPendingInterceptors();
});

test('encrypted image allows only 16 padding bytes and separately limits decrypted plaintext', async t => {
  const { dispatcher, cdn } = setup(t);
  const exactPlain = Buffer.alloc(MAX_IMAGE_BYTES, 1), exactCipher = encrypt(exactPlain);
  assert.equal(exactCipher.length, MAX_IMAGE_BYTES + 16);
  cdn.intercept({ path: '/exact' }).reply(200, exactCipher, { headers: { 'content-length': String(exactCipher.length) } });
  assert.deepEqual(await downloadImageBytes({ url: url('/exact'), aesKey: hexKey, expectedSize: MAX_IMAGE_BYTES }, { dispatcher }), exactPlain);
  const overPlain = Buffer.alloc(MAX_IMAGE_BYTES + 1, 2), overCipher = encrypt(overPlain);
  assert.equal(overCipher.length, MAX_IMAGE_BYTES + 16, 'cipher fits padding budget but plaintext must still be rejected');
  cdn.intercept({ path: '/plain-over' }).reply(200, overCipher);
  await assert.rejects(downloadImageBytes({ url: url('/plain-over'), aesKey: rawKey }, { dispatcher }), /10 MiB/);
  const tooMuchCipher = Buffer.alloc(MAX_IMAGE_BYTES + 17, 3);
  cdn.intercept({ path: '/cipher-over' }).reply(200, tooMuchCipher);
  await assert.rejects(downloadImageBytes({ url: url('/cipher-over'), aesKey: rawKey }, { dispatcher }), /10 MiB/);
  const compressed = zlib.gzipSync(tooMuchCipher);
  cdn.intercept({ path: '/cipher-compressed' }).reply(200, compressed, { headers: {
    'content-encoding': 'gzip', 'content-length': String(compressed.length),
  } });
  await assert.rejects(downloadImageBytes({ url: url('/cipher-compressed'), aesKey: rawKey }, { dispatcher }), /10 MiB/);
  dispatcher.assertNoPendingInterceptors();
});

test('file downloads retain their separate 20 MiB cap', async t => {
  const { dispatcher, cdn } = setup(t);
  assert.equal(MAX_FILE_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_IMAGE_BYTES, 10 * 1024 * 1024);
  const file = Buffer.alloc(MAX_IMAGE_BYTES + 1, 4);
  cdn.intercept({ path: '/larger-file' }).reply(200, file);
  assert.equal((await downloadFileBytes({ url: url('/larger-file') }, { dispatcher })).length, file.length);
  dispatcher.assertNoPendingInterceptors();
});

test('image errors do not include signed URLs, response bodies, abort reasons or AES keys', async t => {
  const { dispatcher, cdn } = setup(t);
  const secret = 'PRIVATE_SIGNED_QUERY';
  cdn.intercept({ path: `/expired?token=${secret}` }).reply(403, secret);
  await assert.rejects(downloadImageBytes({ url: url(`/expired?token=${secret}`), aesKey: rawKey }, { dispatcher }), error => {
    assert.match(error.message, /失效或无权访问/);
    assert.doesNotMatch(error.message, /PRIVATE_SIGNED_QUERY|https:/);
    return true;
  });
  cdn.intercept({ path: '/network' }).replyWithError(new Error(`failed ${url('/network')} aesKey=${rawKey}`));
  await assert.rejects(downloadImageBytes({ url: url('/network'), aesKey: rawKey }, { dispatcher }), error => {
    assert.match(error.message, /检查网络/);
    assert.ok(!error.message.includes(rawKey));
    assert.ok(!error.message.includes('https:'));
    return true;
  });
  dispatcher.assertNoPendingInterceptors();
});

test('image cancellation and the shared total deadline abort delayed downloads', async t => {
  const { dispatcher, cdn } = setup(t);
  const controller = new AbortController();
  cdn.intercept({ path: '/cancel' }).reply(200, plainImage).delay(80);
  const pending = downloadImageBytes({ url: url('/cancel') }, { dispatcher, signal: controller.signal });
  controller.abort(new Error('PRIVATE_ABORT_REASON'));
  await assert.rejects(pending, error => /图片下载已取消/.test(error.message) && !error.message.includes('PRIVATE_ABORT_REASON'));
  cdn.intercept({ path: '/timeout' }).reply(200, plainImage).delay(80);
  const nativeSetTimeout = global.setTimeout;
  let timeout;
  try {
    global.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 30_000 ? 5 : delay, ...args);
    timeout = downloadImageBytes({ url: url('/timeout') }, { dispatcher });
  } finally { global.setTimeout = nativeSetTimeout; }
  await assert.rejects(timeout, /图片下载超时/);
  dispatcher.assertNoPendingInterceptors();
});
