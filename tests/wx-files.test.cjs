const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const undici = require('undici');
const { ChatDB } = require('./runtime.cjs');
const { WxClient } = require('../src/wx-client.ts');
const { MAX_FILE_BYTES, FileSendError, getFileDownloadSpec } = require('../src/file-transfer.ts');

const cdn = 'https://novac2c.cdn.weixin.qq.com/c2c';
const bytes = Buffer.from('file body with 中文 and **markdown**\n');
const md5 = value => crypto.createHash('md5').update(value).digest('hex');

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-wx-files-'));
  const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, 'wechat');
  await db.init();
  await db.setMetadata('from_user_id', 'peer');
  await db.setMetadata('to_user_id', 'bot');
  await db.setMetadata('context_token', 'private-context-token');
  const client = new WxClient({ globalStorageUri: { fsPath: directory } }, db);
  client._connected = true;
  client.getProxyAgent = () => undefined;
  const filePath = path.join(directory, 'source.bin');
  fs.writeFileSync(filePath, bytes);
  const requests = [], uploads = [], events = [];
  client.onMessage(event => events.push(event));
  const state = {
    uploadReply: { upload_full_url: `${cdn}/upload?server=full`, upload_param: 'must-not-use-upload-param' },
    sendReply: { ret: 0, message_id: '9007199254740993' },
    uploadResponse: () => new undici.Response(null, { status: 200, headers: { 'x-encrypted-param': 'download+/=&?' } }),
  };
  client.request = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body, init });
    if (url === '/ilink/bot/getuploadurl') return state.uploadReply;
    assert.equal(url, '/ilink/bot/sendmessage', 'all API calls are mocked and expected');
    if (state.sendError) throw state.sendError;
    return state.sendReply;
  };
  const originalFetch = undici.fetch;
  undici.fetch = async (url, init) => {
    uploads.push({ url, init });
    if (state.uploadError) throw state.uploadError;
    return state.uploadResponse(url, init);
  };
  t.after(async () => {
    undici.fetch = originalFetch;
    client.dispose(); await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, db, client, filePath, requests, uploads, events, state };
}
const isNotSent = error => error instanceof FileSendError && error.deliveryState === 'not_sent';

// No request in this file reaches the network: both Bot API and undici fetch
// are replaced with deterministic fake responses while real crypto/DB code runs.
test('WeChat sends one encrypted file with official fields and stores metadata without local paths', async t => {
  const { directory, db, client, filePath, requests, uploads, events } = await setup(t);
  assert.deepEqual(client.fileCapabilities, { canSend: true, maxBytes: 20 * 1024 * 1024 });
  assert.equal(await client.sendFile(filePath, '../../report.txt'), undefined);
  assert.equal(requests.length, 2); assert.equal(uploads.length, 1); assert.equal(events.length, 1);
  const upload = requests[0].body, sent = requests[1].body.msg;
  assert.equal(upload.media_type, 3); assert.equal(upload.rawsize, bytes.length);
  assert.equal(upload.rawfilemd5, md5(bytes)); assert.equal(upload.no_need_thumb, true);
  assert.equal(upload.to_user_id, 'peer');
  assert.equal(upload.filesize, Math.ceil((bytes.length + 1) / 16) * 16);
  assert.match(upload.filekey, /^[a-f0-9]{32}$/); assert.match(upload.aeskey, /^[a-f0-9]{32}$/);
  assert.equal(uploads[0].url, `${cdn}/upload?server=full`);
  assert.equal(uploads[0].init.method, 'POST'); assert.equal(uploads[0].init.redirect, 'error');
  assert.equal(uploads[0].init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(uploads[0].init.headers.Authorization, undefined, 'CDN never receives bot credentials');
  assert.equal(uploads[0].init.body.length, upload.filesize);
  const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(upload.aeskey, 'hex'), null);
  assert.deepEqual(Buffer.concat([decipher.update(uploads[0].init.body), decipher.final()]), bytes);
  assert.equal(sent.message_type, 2); assert.equal(sent.message_state, 2);
  assert.equal(sent.to_user_id, 'peer'); assert.equal(sent.from_user_id, 'bot');
  assert.equal(sent.context_token, 'private-context-token'); assert.equal(sent.item_list.length, 1);
  assert.equal(sent.item_list[0].type, 4);
  const item = sent.item_list[0].file_item;
  assert.equal(item.file_name, 'report.txt'); assert.equal(item.len, String(bytes.length));
  assert.equal(item.md5, md5(bytes)); assert.equal(item.media.encrypt_type, 1);
  assert.equal(item.media.encrypt_query_param, 'download+/=&?');
  assert.equal(Buffer.from(item.media.aes_key, 'base64').toString(), upload.aeskey);
  const rows = await db.getRecentMessages(), row = rows[0];
  assert.equal(rows.length, 1); assert.equal(row.type, 4); assert.equal(row.parts.length, 1);
  assert.equal(row.message_id, String(sent.message_id));
  assert.equal(row.parts[0].fileName, 'report.txt'); assert.equal(row.parts[0].size, bytes.length);
  assert.deepEqual(row.parts[0].fileMedia, { aesKey: item.media.aes_key, encryptQueryParam: 'download+/=&?', md5: md5(bytes) });
  assert.equal(getFileDownloadSpec(row.parts[0], 'WeChat').expectedSize, bytes.length);
  assert.ok(!JSON.stringify(row).includes(directory)); assert.ok(!JSON.stringify(row).includes(bytes.toString()));
  assert.ok(!fs.existsSync(path.join(directory, 'files')), 'file bytes are not cached locally');
});

test('WeChat builds upload URL from opaque parameters and pads block-aligned files with PKCS7', async t => {
  const { client, filePath, requests, uploads, state } = await setup(t);
  fs.writeFileSync(filePath, Buffer.alloc(16));
  state.uploadReply = { upload_param: 'opaque+/=&?' };
  assert.equal(await client.sendFile(filePath), undefined);
  const url = new URL(uploads[0].url);
  assert.equal(url.origin + url.pathname, `${cdn}/upload`);
  assert.equal(url.searchParams.get('encrypted_query_param'), 'opaque+/=&?');
  assert.equal(url.searchParams.get('filekey'), requests[0].body.filekey);
  assert.equal(uploads[0].init.body.length, 32);
  assert.equal(requests[1].body.msg.item_list[0].file_item.len, '16');
});

test('WeChat preflight validates connection, ordinary files and both stat/actual byte limits without sending', async t => {
  const { directory, client, filePath, requests, uploads } = await setup(t);
  client._connected = false;
  await assert.rejects(client.sendFile(filePath), isNotSent);
  client._connected = true;
  await assert.rejects(client.sendFile(directory), isNotSent);
  await assert.rejects(client.sendFile(path.join(directory, 'missing')), isNotSent);
  fs.writeFileSync(filePath, Buffer.alloc(0));
  await assert.rejects(client.sendFile(filePath), error => isNotSent(error) && /空文件/.test(error.message));
  fs.truncateSync(filePath, MAX_FILE_BYTES + 1);
  await assert.rejects(client.sendFile(filePath), isNotSent);
  fs.writeFileSync(filePath, bytes);
  const readFile = fs.promises.readFile;
  try {
    for (const actual of [Buffer.alloc(0), Buffer.alloc(MAX_FILE_BYTES + 1)]) {
      fs.promises.readFile = async target => { assert.equal(target, filePath); return actual; };
      await assert.rejects(client.sendFile(filePath), isNotSent);
    }
  }
  finally { fs.promises.readFile = readFile; }
  assert.equal(requests.length, 0); assert.equal(uploads.length, 0);
});

test('WeChat requires safe upload URLs and exact HTTP200 plus download header before sendmessage', async t => {
  const { client, filePath, requests, uploads, state, db } = await setup(t);
  for (const reply of [undefined, {}, { ret: -1 }, { errcode: -14 },
    { upload_full_url: 'https://evil.invalid/upload' },
    { upload_full_url: 'https://127.0.0.1/upload' },
    { upload_full_url: 'http://novac2c.cdn.weixin.qq.com/upload' }]) {
    client._connected = true; // Each response is an independent connected attempt; -14 expires login.
    state.uploadReply = reply;
    await assert.rejects(client.sendFile(filePath), isNotSent);
  }
  assert.equal(uploads.length, 0);
  client._connected = true;
  state.uploadReply = { upload_param: 'upload-only-never-download-fallback' };
  for (const [status, header] of [[200, undefined], [200, ''], [201, 'present'], [204, 'present'], [302, 'present'], [403, 'present'], [500, 'present']]) {
    state.uploadResponse = () => new undici.Response(null, { status,
      headers: header === undefined ? {} : { 'x-encrypted-param': header } });
    await assert.rejects(client.sendFile(filePath), isNotSent);
  }
  state.uploadError = new Error('network error with private signed URL');
  await assert.rejects(client.sendFile(filePath), error => isNotSent(error) && !error.message.includes('private'));
  assert.ok(requests.every(request => request.url === '/ilink/bot/getuploadurl'));
  assert.equal((await db.getRecentMessages()).length, 0);
});

test('WeChat explicit message rejection is not_sent and never retries the file upload or send', async t => {
  const { client, filePath, requests, uploads, state, db } = await setup(t);
  for (const reply of [{ ret: -2, errmsg: 'prepare failed' }, { ret: 0, errcode: -14 }, { errcode: 12 }]) {
    client._connected = true; // -14 deliberately disconnects the previous fixture session.
    requests.length = 0; uploads.length = 0; state.sendReply = reply;
    await assert.rejects(client.sendFile(filePath), isNotSent);
    assert.equal(requests.filter(request => request.url === '/ilink/bot/sendmessage').length, 1);
    assert.equal(uploads.length, 1);
  }
  assert.equal((await db.getRecentMessages()).length, 0);
});

test('WeChat final request exceptions remain uncertain and missing IDs return a warning without confirmed history', async t => {
  const { client, filePath, requests, uploads, state, db, events } = await setup(t);
  state.sendError = new Error('timeout after request reached peer');
  await assert.rejects(client.sendFile(filePath), error => !(error instanceof FileSendError) && error.deliveryState === undefined);
  assert.equal(requests.length, 2); assert.equal(uploads.length, 1);
  state.sendError = undefined;
  for (const reply of [undefined, {}, { ret: 0 }, { message_id: '' }]) {
    requests.length = 0; uploads.length = 0; state.sendReply = reply;
    assert.match(await client.sendFile(filePath), /尚未确认/);
    assert.equal(requests.length, 2); assert.equal(uploads.length, 1);
  }
  assert.equal((await db.getRecentMessages()).length, 0); assert.equal(events.length, 0);
});

test('WeChat history persistence errors after acceptance do not claim not_sent or retry', async t => {
  const { client, filePath, requests, uploads, db } = await setup(t);
  const insert = db.insertMessage;
  db.insertMessage = async () => { throw new Error('simulated disk failure'); };
  try {
    await assert.rejects(client.sendFile(filePath), error => !(error instanceof FileSendError) && /已接受/.test(error.message));
  } finally { db.insertMessage = insert; }
  assert.equal(requests.length, 2); assert.equal(uploads.length, 1);
  assert.equal((await db.getRecentMessages()).length, 0);
});

test('WeChat incoming file metadata preserves official len/md5/private key and captions without auto-downloads', async t => {
  const { client, db, requests, uploads } = await setup(t);
  const key = Buffer.alloc(16, 7).toString('base64');
  await client.processMessages([{
    from_user_id: 'peer', to_user_id: 'bot', message_type: 1, message_state: 2,
    message_id: 'exact-envelope', context_token: 'received-context', item_list: [
      { type: 1, text_item: { text: 'retained caption' } },
      { type: 4, file_item: {
        file_name: 'actual.pdf', len: String(bytes.length), file_size: 999, md5: md5(bytes),
        cdn_url: 'https://legacy.qq.com/unused', media: { full_url: `${cdn}/download?source=official`,
          aes_key: key, encrypt_query_param: 'private-param', encrypt_type: 1, ignored: 'raw-unused-key' },
      } },
      { type: 4, file_item: { file_name: 'old.zip', len: '0', cdn_url: `${cdn}/legacy` } },
    ],
  }]);
  const row = (await db.getRecentMessages())[0];
  assert.equal(row.parts.length, 3); assert.equal(row.parts[0].text, 'retained caption');
  assert.equal(row.parts[1].size, bytes.length); assert.equal(row.parts[1].url, `${cdn}/download?source=official`);
  assert.deepEqual(row.parts[1].fileMedia, { aesKey: key, encryptQueryParam: 'private-param', md5: md5(bytes) });
  assert.ok(!row.content.includes(key)); assert.ok(!row.content.includes('private-param'));
  assert.ok(!JSON.stringify(row).includes('raw-unused-key'));
  assert.equal(row.parts[2].size, 0); assert.equal(row.parts[2].fileMedia, undefined);
  await assert.rejects(client.downloadFile(row.parts[2]), /缺少有效/);
  assert.equal(requests.length, 0); assert.equal(uploads.length, 0);
});

test('WeChat download wrapper decrypts both accepted key encodings and verifies file bytes', async t => {
  const { client, uploads, state } = await setup(t);
  const rawKey = Buffer.alloc(16, 5);
  const cipher = crypto.createCipheriv('aes-128-ecb', rawKey, null);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const proxy = { fakeProxy: true }; client.getProxyAgent = () => proxy;
  state.uploadResponse = () => new undici.Response(ciphertext, { status: 200, headers: { 'content-length': String(ciphertext.length) } });
  for (const aesKey of [rawKey.toString('base64'), Buffer.from(rawKey.toString('hex')).toString('base64')]) {
    const part = { type: 4, fileName: 'file.txt', size: bytes.length,
      fileMedia: { aesKey, encryptQueryParam: 'opaque+/=&?', md5: md5(bytes) } };
    assert.deepEqual(await client.downloadFile(part, new AbortController().signal), bytes);
    const call = uploads.at(-1), url = new URL(call.url);
    assert.equal(url.origin + url.pathname, `${cdn}/download`);
    assert.equal(url.searchParams.get('encrypted_query_param'), 'opaque+/=&?');
    assert.equal(call.init.dispatcher, proxy); assert.equal(call.init.headers?.Authorization, undefined);
  }
  assert.equal(uploads.length, 2);
});
