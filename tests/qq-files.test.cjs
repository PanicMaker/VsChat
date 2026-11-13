const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MockAgent } = require('undici');
const { ChatDB, outputLines } = require('./runtime.cjs');
const { QqBotClient } = require('../src/qq-bot-client.ts');
const { FileSendError, MAX_FILE_BYTES, sanitizeFileName } = require('../src/file-transfer.ts');

const hash = (kind, bytes) => crypto.createHash(kind).update(bytes).digest('hex');
const isNotSent = error => error instanceof FileSendError && error.deliveryState === 'not_sent';

test('QQ missing local file reports not-sent without exposing its absolute path', async t => {
  const { client, filePath, directory, calls } = await setup(t);
  fs.unlinkSync(filePath);
  await assert.rejects(client.sendFile(filePath), error => isNotSent(error)
    && /无法读取/.test(error.message) && !error.message.includes(directory) && !error.message.includes('ENOENT'));
  assert.equal(calls.length, 0);
});

async function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-qq-files-'));
  const context = { globalStorageUri: { fsPath: directory } };
  const db = new ChatDB(context, 'qq');
  await db.init();
  const client = new QqBotClient(context, db);
  client._connected = true;
  client.getAppId = async () => 'bot';
  client.getTargetOpenId = async () => 'user';
  const calls = [], uploads = [], events = [];
  client.onMessage(event => events.push(event));
  client.requestApi = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (options.fail && url.endsWith(`/${options.fail}`)) throw new Error(`simulated ${options.fail} failure`);
    if (url.endsWith('/upload_prepare')) {
      if (options.prepared) return options.prepared;
      const blockSize = options.blockSize || 4;
      const parts = Array.from({ length: Math.ceil(Number(body.file_size) / blockSize) }, (_, index) => ({
        index, block_size: String(blockSize), presigned_url: `https://upload.invalid/part/${index}`,
      }));
      return { upload_id: 'upload-task', block_size: String(blockSize), parts };
    }
    if (url.endsWith('/upload_part_finish')) return {};
    if (url.endsWith('/files')) return options.media || { file_info: 'opaque-media-info', file_uuid: 'different-uuid' };
    if (url.endsWith('/messages')) return options.response || { id: 'sent-file-id', timestamp: '2026-11-12T10:00:00Z', ext_info: { ref_idx: 'sent-reference' } };
    throw new Error(`Unexpected API request: ${url}`);
  };
  client.putUploadPart = async (url, bytes, index) => {
    uploads.push({ url, bytes: Buffer.from(bytes), index });
    if (options.fail === 'put') throw new Error('simulated put failure');
  };
  const filePath = path.join(directory, 'local-input.bin');
  fs.writeFileSync(filePath, options.bytes || Buffer.from('abcdefghij'));
  t.after(async () => {
    client.dispose();
    await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { client, db, filePath, directory, calls, uploads, events };
}

test('QQ sends a file with explicit type 4, complete chunks, checksums and passive reply context', async t => {
  const { client, db, filePath, calls, uploads, events } = await setup(t);
  await db.storeQqInbound({
    direction: 'received', type: 1, content: 'incoming', timestamp: Math.floor(Date.now() / 1000),
    context_token: '', from_user_id: 'user', to_user_id: 'bot', message_id: 'inbound-id',
  });
  assert.deepEqual(client.fileCapabilities, { canSend: true, maxBytes: MAX_FILE_BYTES });
  assert.equal(await client.sendFile(filePath, '../../月报.pdf'), undefined);
  const bytes = fs.readFileSync(filePath);
  const prepare = calls.find(call => call.url.endsWith('/upload_prepare'));
  assert.deepEqual(prepare.body, {
    file_type: 4, file_size: '10', file_name: '月报.pdf',
    md5: hash('md5', bytes), sha1: hash('sha1', bytes), md5_10m: hash('md5', bytes),
  });
  assert.equal(prepare.url, '/v2/users/user/upload_prepare');
  assert.deepEqual(uploads.map(part => part.index), [0, 1, 2]);
  assert.deepEqual(uploads.map(part => part.bytes.length), [4, 4, 2]);
  assert.deepEqual(Buffer.concat(uploads.map(part => part.bytes)), bytes);
  assert.deepEqual(calls.filter(call => call.url.endsWith('/upload_part_finish')).map(call => call.body), uploads.map(part => ({
    upload_id: 'upload-task', part_index: part.index, block_size: String(part.bytes.length), md5: hash('md5', part.bytes),
  })));
  assert.deepEqual(calls.find(call => call.url.endsWith('/files')).body, {
    upload_id: 'upload-task', file_type: 4, file_name: '月报.pdf', srv_send_msg: false,
  });
  assert.deepEqual(calls.find(call => call.url.endsWith('/messages')).body, {
    msg_type: 7, media: { file_info: 'opaque-media-info' }, msg_id: 'inbound-id', msg_seq: 1,
  });
  assert.equal(events.length, 1);
  const saved = (await db.getRecentMessages()).find(message => message.direction === 'sent');
  assert.equal(saved.type, 4);
  assert.equal(saved.reference_id, 'sent-reference');
  assert.equal(saved.content, '[文件：月报.pdf]');
  assert.deepEqual(saved.parts, [{ type: 4, fileName: '月报.pdf', size: 10 }]);
  assert.ok(!JSON.stringify(saved).includes(filePath), 'a transient local path must not be persisted');
  assert.ok(!JSON.stringify(saved).includes('opaque-media-info'), 'upload handles are not download URLs');
});

test('QQ hashes only the first 10002432 bytes for md5_10m and retains the full-file hashes', async t => {
  const bytes = Buffer.alloc(10_002_432 + 7, 0x61);
  bytes.fill(0x62, 10_002_432);
  const { client, filePath, calls } = await setup(t, { bytes, blockSize: 5_000_000 });
  await client.sendFile(filePath);
  const { body } = calls.find(call => call.url.endsWith('/upload_prepare'));
  assert.equal(body.file_size, String(bytes.length));
  assert.equal(body.md5_10m, hash('md5', bytes.subarray(0, 10_002_432)));
  assert.notEqual(body.md5_10m, body.md5);
  assert.equal(body.md5, hash('md5', bytes));
  assert.equal(body.sha1, hash('sha1', bytes));
});

test('QQ rejects offline, missing, directory, empty and oversized files before upload', async t => {
  const { client, filePath, directory, calls } = await setup(t);
  client._connected = false;
  await assert.rejects(client.sendFile(filePath), isNotSent);
  client._connected = true;
  await assert.rejects(client.sendFile(path.join(directory, 'missing')), isNotSent);
  await assert.rejects(client.sendFile(directory), isNotSent);
  fs.truncateSync(filePath, 0);
  await assert.rejects(client.sendFile(filePath), isNotSent);
  fs.truncateSync(filePath, MAX_FILE_BYTES + 1);
  await assert.rejects(client.sendFile(filePath), isNotSent);
  assert.equal(calls.length, 0);
});

test('QQ checks actual bytes when a file grows after stat and sanitizes the display name', async t => {
  const { client, filePath, calls } = await setup(t);
  fs.truncateSync(filePath, MAX_FILE_BYTES + 1);
  const stat = fs.promises.stat;
  fs.promises.stat = async (target, ...args) => {
    const value = await stat.call(fs.promises, target, ...args);
    if (target === filePath) value.size = 1;
    return value;
  };
  try { await assert.rejects(client.sendFile(filePath), isNotSent); }
  finally { fs.promises.stat = stat; }
  assert.equal(calls.length, 0);
  fs.writeFileSync(filePath, 'abc');
  const suppliedName = '..\\CON.txt\u0000';
  await client.sendFile(filePath, suppliedName);
  assert.equal(calls.find(call => call.url.endsWith('/upload_prepare')).body.file_name, sanitizeFileName(suppliedName));
});

test('all upload stages and pre-send reply reservation failures are definitely not sent', async t => {
  for (const fail of ['upload_prepare', 'put', 'upload_part_finish', 'files', 'reserve']) {
    await t.test(fail, async subtest => {
      const { client, filePath, db, calls, events } = await setup(subtest, { fail });
      if (fail === 'reserve') client.applyRecentPassiveReply = async () => { throw new Error('reply reservation failed'); };
      await assert.rejects(client.sendFile(filePath), isNotSent);
      assert.equal(calls.filter(call => call.url.endsWith('/messages')).length, 0);
      assert.equal((await db.getRecentMessages()).length, 0);
      assert.equal(events.length, 0);
    });
  }
});

test('QQ never substitutes file_uuid for file_info for files or images', async t => {
  const { client, filePath, calls } = await setup(t, { media: { file_uuid: 'uuid-only' } });
  await assert.rejects(client.sendFile(filePath), error => isNotSent(error) && /file_info/.test(error.message));
  await assert.rejects(client.sendImage(filePath), /file_info/);
  assert.equal(calls.filter(call => call.url.endsWith('/messages')).length, 0);
});

test('invalid, missing, duplicate or incomplete prepared parts never start PUT or send a message', async t => {
  const valid = { upload_id: 'upload-task', block_size: '4', parts: [0, 1, 2].map(index => ({ index, block_size: '4', presigned_url: `https://upload.invalid/${index}` })) };
  const invalid = [
    { ...valid, upload_id: '' }, { ...valid, block_size: '0' }, { ...valid, block_size: '1.5' },
    { ...valid, parts: [] }, { ...valid, parts: valid.parts.slice(0, 2) },
    { ...valid, parts: [valid.parts[0], valid.parts[0], valid.parts[2]] },
    { ...valid, parts: [valid.parts[0], { ...valid.parts[1], index: 1.5 }, valid.parts[2]] },
    { ...valid, parts: [valid.parts[0], { ...valid.parts[1], block_size: '3' }, valid.parts[2]] },
    { ...valid, parts: [valid.parts[0], { ...valid.parts[1], block_size: '5' }, valid.parts[2]] },
    { ...valid, parts: [valid.parts[0], { ...valid.parts[1], presigned_url: 'file:///tmp/upload' }, valid.parts[2]] },
  ];
  for (const prepared of invalid) {
    const { client, filePath, calls, uploads } = await setup(t, { prepared });
    await assert.rejects(client.sendFile(filePath), isNotSent);
    assert.equal(uploads.length, 0);
    assert.equal(calls.length, 1);
  }
});

test('legacy one-based upload fields remain compatible while all bytes are covered', async t => {
  const prepared = {
    upload_id: 'upload-task', block_size: '4',
    parts: [3, 1, 2].map(index => ({ part_index: index, block_size: index === 3 ? '2' : '4', upload_url: `https://upload.invalid/${index}` })),
  };
  const { client, filePath, uploads } = await setup(t, { prepared });
  await client.sendFile(filePath);
  assert.deepEqual(uploads.map(part => part.index), [1, 2, 3]);
  assert.equal(Buffer.concat(uploads.map(part => part.bytes)).toString(), 'abcdefghij');
});

test('file uploads reject HTTP, credentials, literal IPs and local hosts before transferring bytes', async t => {
  for (const url of [
    'http://upload.qq.com/part', 'https://user:secret@upload.qq.com/part',
    'https://127.0.0.1/part', 'https://[::1]/part', 'https://192.168.1.10/part',
    'https://169.254.169.254/part', 'https://localhost/part', 'https://host.local/part',
    'https://localhost.qq.com:8080/part', 'https://host.internal/part',
  ]) {
    const prepared = { upload_id: 'upload-task', block_size: '10', parts: [{ index: 0, block_size: '10', presigned_url: url }] };
    const { client, filePath, calls, uploads } = await setup(t, { prepared });
    await assert.rejects(client.sendFile(filePath), isNotSent);
    assert.equal(uploads.length, 0, url);
    assert.equal(calls.length, 1, url);
  }
});

test('PUT redirects never forward file bytes and network errors hide presigned URLs', async t => {
  const { client } = await setup(t);
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  t.after(() => dispatcher.close());
  client.getProxyAgent = () => dispatcher;
  client.sleep = async () => {};
  let redirected = 0;
  dispatcher.get('https://upload.invalid').intercept({ path: '/redirect?sign=top-secret', method: 'PUT' })
    .reply(307, '', { headers: { location: 'https://other.invalid/part?sign=top-secret' } }).times(3);
  dispatcher.get('https://other.invalid').intercept({ path: '/part?sign=top-secret', method: 'PUT' })
    .reply(() => { redirected++; return { statusCode: 200, data: '' }; }).persist();
  await assert.rejects(QqBotClient.prototype.putUploadPart.call(client, 'https://upload.invalid/redirect?sign=top-secret', Buffer.from('private'), 0), /检查网络/);
  assert.equal(redirected, 0);
  const logStart = outputLines.length;
  dispatcher.get('https://upload.invalid').intercept({ path: '/error?sign=do-not-leak', method: 'PUT' })
    .replyWithError(new Error('network failed for https://upload.invalid/error?sign=do-not-leak')).times(3);
  await assert.rejects(QqBotClient.prototype.putUploadPart.call(client, 'https://upload.invalid/error?sign=do-not-leak', Buffer.from('private'), 0), error => /检查网络/.test(error.message) && !error.message.includes('do-not-leak'));
  assert.ok(outputLines.slice(logStart).every(line => !line.includes('do-not-leak')));
});

test('a final send timeout stays uncertain with no automatic resend', async t => {
  const { client, filePath, db, calls, events } = await setup(t, { fail: 'messages' });
  await assert.rejects(client.sendFile(filePath), error => error instanceof Error && !(error instanceof FileSendError));
  assert.equal(calls.filter(call => call.url.endsWith('/messages')).length, 1);
  assert.equal((await db.getRecentMessages()).length, 0);
  assert.equal(events.length, 0);
});

test('missing message ID returns an uncertainty warning without storing a confirmed sent row', async t => {
  const { client, filePath, db, calls, events } = await setup(t, { response: {} });
  const warning = await client.sendFile(filePath);
  assert.match(warning, /无法确认/);
  assert.equal(calls.filter(call => call.url.endsWith('/messages')).length, 1);
  assert.equal((await db.getRecentMessages()).length, 0);
  assert.equal(events.length, 0);
});

test('local persistence failure after QQ acceptance must not become not_sent', async t => {
  const { client, filePath, db, calls } = await setup(t);
  db.insertMessage = async () => { throw new Error('disk full after acceptance'); };
  await assert.rejects(client.sendFile(filePath), error => /disk full/.test(error.message) && !(error instanceof FileSendError));
  assert.equal(calls.filter(call => call.url.endsWith('/messages')).length, 1);
});

test('QQ download wrapper uses the shared validator and dispatcher without Bot authentication', async t => {
  const { client } = await setup(t);
  const dispatcher = new MockAgent();
  dispatcher.disableNetConnect();
  t.after(() => dispatcher.close());
  const controller = new AbortController();
  client.getProxyAgent = () => dispatcher;
  const request = dispatcher.get('https://multimedia.nt.qq.com.cn');
  request.intercept({ path: '/download?fileid=test', method: 'GET', headers: headers => !headers.authorization })
    .reply(200, Buffer.from('pdf'), { headers: { 'content-length': '3' } });
  const bytes = await client.downloadFile({ type: 4, fileName: 'report.pdf', size: 3, url: 'https://multimedia.nt.qq.com.cn/download?fileid=test' }, controller.signal);
  assert.deepEqual(bytes, Buffer.from('pdf'));
  dispatcher.assertNoPendingInterceptors();
  await assert.rejects(client.downloadFile({ type: 4, fileName: 'sent.pdf', size: 3 }), /没有可用/);
  await assert.rejects(client.downloadFile({ type: 4, url: 'https://evil.invalid/file' }), /没有可用/);
  controller.abort();
  await assert.rejects(client.downloadFile({ type: 4, url: 'https://multimedia.nt.qq.com.cn/download?fileid=cancelled' }, controller.signal));
});
