const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { MockAgent } = require('undici');
require('./runtime.cjs');
const {
  MAX_FILE_BYTES, FileSendError, sanitizeFileName, isSafeFileDownloadUrl,
  getFileDownloadSpec, downloadFileBytes,
} = require('../src/file-transfer.ts');

function setup(t) {
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  t.after(() => dispatcher.close());
  return { dispatcher, cdn: dispatcher.get('https://multimedia.nt.qq.com.cn') };
}
const url = path => `https://multimedia.nt.qq.com.cn${path}`;
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const keyRaw = key.toString('base64');
const keyHex = Buffer.from(key.toString('hex')).toString('base64');
function encrypt(bytes) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

test('file names lose paths and controls and remain portable suggestion names', () => {
  assert.equal(sanitizeFileName('../../nested/report.txt'), 'report.txt');
  assert.equal(sanitizeFileName('C:\\secret\\budget.pdf'), 'budget.pdf');
  assert.equal(sanitizeFileName(' .\u202ereport\u0000?.txt. '), '_report__.txt');
  assert.equal(sanitizeFileName('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFileName('..'), 'attachment');
  assert.equal(sanitizeFileName(undefined), 'attachment');
  assert.ok(Array.from(sanitizeFileName('报告'.repeat(150))).length <= 180);
  assert.ok(Buffer.byteLength(sanitizeFileName('报告'.repeat(150)), 'utf8') <= 180);
  assert.equal(new FileSendError('before sending').deliveryState, 'not_sent');
});

test('download URLs allow only known HTTPS CDN domain families and standard ports', () => {
  for (const address of [url('/file?token=abc'), 'https://gchat.qpic.cn/image',
    'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=abc%2Bdef',
    'https://cdn.gtimg.cn:443/file', 'https://gchat.qpic.cn/%E4%B8%AD%E6%96%87.txt']) assert.equal(isSafeFileDownloadUrl(address), true, address);
  for (const address of ['http://multimedia.nt.qq.com.cn/file', 'file:///tmp/file', 'https://127.0.0.1/file',
    'https://[::1]/file', 'https://[::ffff:127.0.0.1]/file', 'https://localhost/file',
    'https://multimedia.nt.qq.com.cn.evil.test/file', 'https://evilqq.com/file',
    'https://user:pass@multimedia.nt.qq.com.cn/file', 'https://multimedia.nt.qq.com.cn:8080/file',
    'https://multimedia.nt.qq.com.cn./file', 'https://multimedia.nt.qq.com.cn/secret%250aheader',
    'https://multimedia.nt.qq.com.cn/secret%C2%85header',
    'https://multimedia.nt.qq.com.cn/\\localhost/file', 'https://example.com/file']) {
    assert.equal(isSafeFileDownloadUrl(address), false, address);
  }
});

test('download specifications distinguish plaintext QQ and encrypted WeChat, including legacy gaps', () => {
  assert.deepEqual(getFileDownloadSpec({ type: 4, url: url('/f'), size: 12 }, 'QQ'), { url: url('/f'), expectedSize: 12 });
  assert.equal(getFileDownloadSpec({ type: 2, url: url('/f') }, 'QQ'), undefined);
  assert.equal(getFileDownloadSpec({ type: 4, url: url('/f') }, 'WeChat'), undefined);
  assert.equal(getFileDownloadSpec({ type: 4, url: url('/f'), fileMedia: { aesKey: 'invalid' } }, 'WeChat'), undefined);
  assert.equal(getFileDownloadSpec({ type: 4, url: url('/f'), size: MAX_FILE_BYTES + 1 }, 'QQ'), undefined);
  assert.equal(getFileDownloadSpec({ type: 4, url: url('/f'), fileMedia: { aesKey: keyRaw } }, 'QQ'), undefined);
  assert.equal(getFileDownloadSpec({ type: 4, url: 'https://unverified.example/f' }, 'QQ'), undefined);
  const wx = getFileDownloadSpec({ type: 4, size: 0, fileMedia: { aesKey: keyHex, encryptQueryParam: 'a+b/==' } }, 'WeChat');
  assert.equal(wx.url, 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%2Bb%2F%3D%3D');
  assert.equal(wx.expectedSize, 0);
  assert.equal(wx.aesKey, keyHex);
});

test('plaintext downloads use isolated unauthenticated GETs and validate the actual file size', async t => {
  const { dispatcher, cdn } = setup(t);
  let request;
  cdn.intercept({ path: '/file', method: 'GET' }).reply(options => {
    request = options;
    return { statusCode: 200, data: Buffer.from('example') };
  });
  const result = await downloadFileBytes({ url: url('/file'), expectedSize: 7 }, { dispatcher });
  assert.equal(result.toString(), 'example');
  const headers = JSON.stringify(request.headers).toLowerCase();
  assert.ok(!headers.includes('authorization'));
  assert.ok(!headers.includes('cookie'));
  dispatcher.assertNoPendingInterceptors();
});

test('WeChat supports both AES encodings and verifies plaintext length and checksum', async t => {
  const { dispatcher, cdn } = setup(t);
  const plain = Buffer.from('file contents\n\u4e2d\u6587');
  for (const [index, aesKey] of [keyRaw, keyHex].entries()) {
    cdn.intercept({ path: `/encrypted-${index}` }).reply(200, encrypt(plain));
    const result = await downloadFileBytes({ url: url(`/encrypted-${index}`), aesKey, expectedSize: plain.length,
      md5: crypto.createHash('md5').update(plain).digest('hex').toUpperCase() }, { dispatcher });
    assert.deepEqual(result, plain);
  }
  dispatcher.assertNoPendingInterceptors();
});

test('encrypted downloads never return raw ciphertext or accept mismatched length/hash', async t => {
  const { dispatcher, cdn } = setup(t);
  const plain = Buffer.from('data'), ciphertext = encrypt(plain);
  cdn.intercept({ path: '/broken' }).reply(200, Buffer.from('not AES ciphertext'));
  await assert.rejects(downloadFileBytes({ url: url('/broken'), aesKey: keyRaw }, { dispatcher }), /解密失败/);
  cdn.intercept({ path: '/short' }).reply(200, ciphertext);
  await assert.rejects(downloadFileBytes({ url: url('/short'), aesKey: keyRaw, expectedSize: 5 }, { dispatcher }), /长度校验失败/);
  cdn.intercept({ path: '/hash' }).reply(200, ciphertext);
  await assert.rejects(downloadFileBytes({ url: url('/hash'), aesKey: keyRaw, md5: '0'.repeat(32) }, { dispatcher }), /文件校验失败/);
  await assert.rejects(downloadFileBytes({ url: url('/never-requested'), aesKey: 'invalid' }, { dispatcher }), /解密信息/);
  dispatcher.assertNoPendingInterceptors();
});

test('safe relative and cross-CDN redirects work while local or unverified targets are rejected', async t => {
  const { dispatcher, cdn } = setup(t);
  cdn.intercept({ path: '/relative' }).reply(302, '', { headers: { location: '/cross' } });
  cdn.intercept({ path: '/cross' }).reply(307, '', { headers: { location: 'https://gchat.qpic.cn/file' } });
  dispatcher.get('https://gchat.qpic.cn').intercept({ path: '/file' }).reply(200, 'ok');
  assert.equal((await downloadFileBytes({ url: url('/relative') }, { dispatcher })).toString(), 'ok');
  for (const [index, target] of ['http://127.0.0.1/private', 'https://example.com/private', 'https://user:pass@gchat.qpic.cn/private'].entries()) {
    cdn.intercept({ path: `/unsafe-${index}` }).reply(302, '', { headers: { location: target } });
    await assert.rejects(downloadFileBytes({ url: url(`/unsafe-${index}`) }, { dispatcher }), /不支持的地址/);
  }
  dispatcher.assertNoPendingInterceptors();
});

test('redirect loops stop after three hops without requesting a fourth target', async t => {
  const { dispatcher, cdn } = setup(t);
  for (let i = 0; i <= 3; i++) cdn.intercept({ path: `/hop-${i}` }).reply(302, '', { headers: { location: `/hop-${i + 1}` } });
  await assert.rejects(downloadFileBytes({ url: url('/hop-0') }, { dispatcher }), /重定向过多/);
  dispatcher.assertNoPendingInterceptors();
});

test('advertised and streamed sizes are bounded, including decompressed responses', async t => {
  const { dispatcher, cdn } = setup(t);
  cdn.intercept({ path: '/advertised' }).reply(200, 'small', { headers: { 'content-length': String(MAX_FILE_BYTES + 1) } });
  await assert.rejects(downloadFileBytes({ url: url('/advertised') }, { dispatcher }), /20 MiB/);
  const oversized = Buffer.alloc(MAX_FILE_BYTES + 1, 65);
  cdn.intercept({ path: '/streamed' }).reply(200, oversized);
  await assert.rejects(downloadFileBytes({ url: url('/streamed') }, { dispatcher }), /20 MiB/);
  const compressed = zlib.gzipSync(oversized);
  cdn.intercept({ path: '/compressed' }).reply(200, compressed, { headers: { 'content-encoding': 'gzip', 'content-length': String(compressed.length) } });
  await assert.rejects(downloadFileBytes({ url: url('/compressed') }, { dispatcher }), /20 MiB/);
  dispatcher.assertNoPendingInterceptors();
});

test('maximum-size encrypted payload permits only AES padding beyond the plaintext cap', async t => {
  const { dispatcher, cdn } = setup(t);
  const plain = Buffer.alloc(MAX_FILE_BYTES, 3);
  const ciphertext = encrypt(plain);
  assert.equal(ciphertext.length, MAX_FILE_BYTES + 16);
  cdn.intercept({ path: '/limit' }).reply(200, ciphertext, { headers: { 'content-length': String(ciphertext.length) } });
  const result = await downloadFileBytes({ url: url('/limit'), aesKey: keyHex, expectedSize: MAX_FILE_BYTES }, { dispatcher });
  assert.equal(result.length, MAX_FILE_BYTES);
  assert.equal(result[0], 3);
  dispatcher.assertNoPendingInterceptors();
});

test('HTTP and network failures provide usable errors without signed URLs or keys', async t => {
  const { dispatcher, cdn } = setup(t);
  const secret = 'SENSITIVE_SIGNED_TOKEN';
  cdn.intercept({ path: `/expired?token=${secret}` }).reply(403, secret);
  await assert.rejects(downloadFileBytes({ url: url(`/expired?token=${secret}`) }, { dispatcher }), error => {
    assert.match(error.message, /失效或无权访问/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  cdn.intercept({ path: '/network' }).replyWithError(new Error(`failed ${url('/network')} key=${keyRaw}`));
  await assert.rejects(downloadFileBytes({ url: url('/network'), aesKey: keyRaw }, { dispatcher }), error => {
    assert.match(error.message, /检查网络/);
    assert.ok(!error.message.includes('https:'));
    assert.ok(!error.message.includes(keyRaw));
    return true;
  });
  dispatcher.assertNoPendingInterceptors();
});

test('caller cancellation and the total deadline abort downloads distinctly', async t => {
  const { dispatcher, cdn } = setup(t);
  const controller = new AbortController();
  cdn.intercept({ path: '/cancel' }).reply(200, 'late').delay(80);
  const pending = downloadFileBytes({ url: url('/cancel') }, { dispatcher, signal: controller.signal });
  controller.abort(new Error('secret abort reason'));
  await assert.rejects(pending, /已取消/);

  cdn.intercept({ path: '/deadline' }).reply(200, 'late').delay(80);
  const nativeSetTimeout = global.setTimeout;
  let deadline;
  try {
    // Keep the production 30-second deadline while making this regression immediate.
    global.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 30_000 ? 5 : delay, ...args);
    deadline = downloadFileBytes({ url: url('/deadline') }, { dispatcher });
  } finally {
    global.setTimeout = nativeSetTimeout;
  }
  await assert.rejects(deadline, /超时/);
  dispatcher.assertNoPendingInterceptors();
});
