const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatDB, message } = require('./runtime.cjs');
const { WxClient } = require('../src/wx-client.ts');
const { QqBotClient } = require('../src/qq-bot-client.ts');

const firstImage = 'data:image/png;base64,YWJj';
const secondImage = 'data:image/jpeg;base64,ZGVm';
const noNetwork = async () => { throw new Error('Unexpected network call in multipart test'); };

async function setup(t, channel) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-multipart-'));
  const context = { globalStorageUri: { fsPath: directory } };
  const db = new ChatDB(context, channel), observer = new ChatDB(context, channel);
  await db.init(); await observer.init();
  const Client = channel === 'wechat' ? WxClient : QqBotClient;
  const writer = new Client(context, db), reader = new Client(context, observer);
  for (const client of [writer, reader]) {
    client.requestApi = noNetwork;
    client.getAppId = async () => 'bot';
    client.fetchImageAsDataUrl = noNetwork;
  }
  t.after(async () => {
    writer.dispose(); reader.dispose();
    await db.close(); await observer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, context, db, observer, writer, reader };
}
const qqEnvelope = (id, overrides = {}) => ({
  id, author: { user_openid: 'user' }, content: '',
  timestamp: '2026-11-12T08:00:00.000Z', ...overrides,
});
const wxEnvelope = (id, items, overrides = {}) => ({
  message_id: id, from_user_id: 'user', to_user_id: 'bot',
  message_type: 1, message_state: 2, context_token: 'fresh-context',
  item_list: items, ...overrides,
});
const wxImage = name => ({
  type: 2,
  image_item: { aeskey: 'do-not-store-outer-key', media: {
    full_url: `https://media.invalid/${name}`, aes_key: 'do-not-store-aes-key',
    encrypt_query_param: 'do-not-store-secret-query',
  } },
});

// These tests call the actual transport handlers with real temporary databases.
// Every image fetch is stubbed and QQ receives never fetch attachment URLs.
test('QQ preserves parsed caption and every attachment in order while dedup and reply quota stay envelope-scoped', async t => {
  const { db, observer, writer, reader } = await setup(t, 'qq');
  const events = [];
  writer.onMessage(event => events.push(event)); reader.onMessage(event => events.push(event));
  const envelope = qqEnvelope('qq-many', {
    content: 'caption with **code**',
    message_scene: { ext: ['msg_idx=original-reference', 'ref_msg_idx=quoted-reference'] },
    msg_elements: [{ content: 'quoted text' }],
    attachments: [
      { url: 'https://media.invalid/one', filename: 'one.png', content_type: 'image/png', size: 4 },
      { url: 'https://media.invalid/report', filename: 'report.pdf', content_type: 'application/pdf', size: 20 },
      { url: 'https://media.invalid/voice', voice_wav_url: 'https://media.invalid/voice.wav',
        filename: 'voice.wav', content_type: 'voice', asr_refer_text: 'voice transcript' },
      { url: 'https://media.invalid/two', filename: 'two.jpg', content_type: 'image/jpeg' },
      { url: 'https://media.invalid/video', filename: 'clip.mp4', content_type: 'video/mp4' },
      { filename: 'offline.zip', content_type: 'application/zip', size: 0 },
    ],
  });
  await Promise.all([writer.processC2CMessage(envelope), reader.processC2CMessage(envelope)]);
  const rows = await observer.getRecentMessages();
  assert.equal(rows.length, 1); assert.equal(events.length, 1);
  const row = rows[0];
  assert.equal(row.message_id, 'qq-many'); assert.equal(row.reference_id, 'original-reference');
  assert.deepEqual(JSON.parse(row.reply_to), {
    messageId: 'quoted-reference', referenceId: 'quoted-reference', type: 1, text: 'quoted text',
  });
  assert.equal(row.type, 1);
  assert.deepEqual(row.parts.map(part => part.type), [1, 2, 4, 3, 2, 5, 4]);
  assert.equal(row.parts[0].text, 'caption with **code**');
  assert.deepEqual(row.parts[1], { type: 2, url: 'https://media.invalid/one', fileName: 'one.png', mimeType: 'image/png', size: 4 });
  assert.equal(row.parts[3].url, 'https://media.invalid/voice.wav');
  assert.equal(row.parts[3].text, 'voice transcript');
  assert.equal(row.parts[6].size, 0);
  for (const text of ['caption with **code**', 'report.pdf', 'voice transcript', 'one.png', 'two.jpg', 'clip.mp4', 'offline.zip']) {
    assert.ok(row.content.includes(text), text);
  }
  assert.ok(!row.content.includes('https://'), 'summary contains labels, not opaque attachment URLs');
  assert.ok(row.parts.every(part => !('imageDataUrl' in part)), 'QQ stores URL metadata without downloading');
  const reservation = await db.reserveQqReply({ appId: 'bot', openId: 'user', messageId: 'qq-many',
    nowSeconds: Date.parse(envelope.timestamp) / 1000 + 1, windowSeconds: 3600, maxReplies: 4 });
  assert.equal(reservation.sequence, 1);
  await reader.processC2CMessage({ ...envelope, content: 'duplicate must not replace caption', attachments: [] });
  assert.equal((await db.getRecentMessages())[0].parts.length, 7);
  assert.equal(events.length, 1);
  assert.equal(await observer.getMetadata('qq_last_inbound_message_id'), 'qq-many');
  const next = await observer.reserveQqReply({ appId: 'bot', openId: 'user', messageId: 'qq-many',
    nowSeconds: Date.parse(envelope.timestamp) / 1000 + 2, windowSeconds: 3600, maxReplies: 4 });
  assert.equal(next.sequence, 2);
});

test('QQ single text, image, file and voice keep their legacy top-level fields', async t => {
  const { db, writer } = await setup(t, 'qq');
  const cases = [
    [{ content: 'plain text' }, 1, 'plain text'],
    [{ attachments: [{ content_type: 'image/png', url: 'https://media.invalid/single' }] }, 2, 'https://media.invalid/single'],
    [{ attachments: [{ filename: 'only.zip', url: 'https://media.invalid/file' }] }, 4, 'https://media.invalid/file'],
    [{ attachments: [{ content_type: 'voice', asr_refer_text: 'transcribed voice' }] }, 3, 'transcribed voice'],
  ];
  for (const [index, [input, type, content]] of cases.entries()) {
    await writer.processC2CMessage(qqEnvelope(`single-${index}`, input));
    const row = await db.findByMessageId(`single-${index}`);
    assert.equal(row.type, type); assert.equal(row.content, content); assert.equal(row.parts.length, 1);
  }
});

test('WeChat saves one full ordered envelope, retains exact quote ID and reloads independent images across clients', async t => {
  const { directory, db, observer, writer, reader } = await setup(t, 'wechat');
  const events = [], fetches = [];
  writer.onMessage(event => events.push(event)); reader.onMessage(event => events.push(event));
  const receiveImage = async url => {
    const snapshot = await observer.getRecentMessages();
    assert.equal(snapshot.length, 1, 'metadata is committed before image download');
    assert.equal(snapshot[0].parts.length, 7, 'whole envelope is already durable');
    fetches.push(url);
    return url.endsWith('one') ? firstImage : secondImage;
  };
  writer.fetchImageAsDataUrl = receiveImage; reader.fetchImageAsDataUrl = receiveImage;
  const items = [
    { type: 1, text_item: { text: 'caption and code `x`' }, msg_id: 'v1:internal-only' },
    { type: 4, file_item: { file_name: 'report.csv', file_size: 20, cdn_url: 'https://media.invalid/report' },
      extra: { ref_msg: { title: 'quoted caption', message_item: { type: 1, msg_id: 'original-exact-reference' } } } },
    wxImage('one'),
    { type: 3, voice_item: { transcription: 'voice transcript', media: { full_url: 'https://media.invalid/voice' } } },
    { ...wxImage('two'), ref_msg: { title: 'must not replace first reference', message_item: { type: 1, msg_id: 'later' } } },
    { type: 5, video_item: { file_name: 'movie.mp4', file_size: 99, cdn_url: 'https://media.invalid/movie', aes_key: 'do-not-store-video-key' } },
    { type: 4, file_item: { file_name: 'last.zip', file_size: 0, media: { full_url: 'https://media.invalid/last', aes_key: 'do-not-store-file-key' } } },
  ];
  const envelope = wxEnvelope(9007199254740992, items, { _exactMessageId: '9007199254740993' });
  await Promise.all([writer.processMessages([envelope]), reader.processMessages([envelope])]);
  const rows = await observer.getRecentMessages(), row = rows[0];
  assert.equal(rows.length, 1); assert.equal(events.length, 1); assert.equal(fetches.length, 2);
  assert.equal(row.message_id, '9007199254740993');
  assert.deepEqual(row.parts.map(part => part.type), [1, 4, 2, 3, 2, 5, 4]);
  assert.deepEqual(JSON.parse(row.reply_to), { messageId: 'original-exact-reference', type: 1, text: 'quoted caption' });
  for (const text of ['caption and code `x`', 'report.csv', 'voice transcript', 'movie.mp4', 'last.zip']) assert.ok(row.content.includes(text));
  assert.ok(!row.content.includes('do-not-store'));
  assert.ok(!JSON.stringify(row.parts.filter(part => part.type !== 4)).includes('do-not-store'));
  assert.deepEqual(row.parts[6].fileMedia, { aesKey: 'do-not-store-file-key' }, 'only host-side file download fields are retained');
  assert.ok(row.parts.every(part => !('media' in part) && !('aes_key' in part) && !('encrypt_query_param' in part)));
  assert.ok(row.parts.every(part => !('imageDataUrl' in part)), 'binary cache data stays out of DB metadata');
  assert.equal(events[0].parts[2].imageDataUrl, firstImage); assert.equal(events[0].parts[4].imageDataUrl, secondImage);
  assert.equal(await reader.getDecryptedImageUrl(row.id, 2), firstImage);
  assert.equal(await reader.getDecryptedImageUrl(row.id, 4), secondImage);
  assert.equal(await reader.getDecryptedImageUrl(row.id, 0), undefined);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'images')).sort(), [
    `${row.id}.part-2.png`, `${row.id}.part-2.png.url.json`, `${row.id}.part-4.png`, `${row.id}.part-4.png.url.json`,
  ]);
  const snapshot = await observer.getSyncSnapshot();
  assert.equal(snapshot.unreadCount, 1, 'attachments and cache completions count as one incoming message');
  assert.equal(await db.getMetadata('from_user_id'), 'user');
  assert.equal(await db.getMetadata('to_user_id'), 'bot');
  assert.equal(await db.getMetadata('context_token'), 'fresh-context');
  assert.equal(await db.getMetadata('context_token_stale'), '');
});

test('WeChat failed image fetches cannot discard neighboring text, files or another image', async t => {
  const { db, writer, reader } = await setup(t, 'wechat');
  const downloads = [], emitted = [];
  writer.onMessage(event => emitted.push(event));
  writer.fetchImageAsDataUrl = async url => {
    downloads.push(url);
    if (url.endsWith('throw')) throw new Error('simulated failed decrypt');
    if (url.endsWith('missing')) return undefined;
    return firstImage;
  };
  await writer.processMessages([wxEnvelope('failed-parts', [
    { type: 1, text_item: { text: 'retained caption' } }, wxImage('throw'),
    { type: 4, file_item: { file_name: 'retained.txt', file_size: 10 } },
    wxImage('missing'), wxImage('success'),
    { type: 2 },
  ])]);
  const rows = await db.getRecentMessages(), row = rows[0];
  assert.equal(rows.length, 1); assert.equal(row.parts.length, 6);
  assert.ok(row.content.includes('retained caption')); assert.ok(row.content.includes('retained.txt'));
  assert.equal(downloads.length, 3); assert.equal(emitted.length, 1);
  assert.equal(await reader.getDecryptedImageUrl(row.id, 1), undefined);
  assert.equal(await reader.getDecryptedImageUrl(row.id, 3), undefined);
  assert.equal(await reader.getDecryptedImageUrl(row.id, 4), firstImage);
  assert.equal(emitted[0].parts[4].imageDataUrl, firstImage);
});

test('WeChat a failed image sidecar does not prevent saving later image parts', async t => {
  const { directory, db, writer, reader } = await setup(t, 'wechat');
  writer.fetchImageAsDataUrl = async url => url.endsWith('one') ? firstImage : secondImage;
  const rename = fs.promises.rename;
  fs.promises.rename = async (source, file) => {
    if (String(file).endsWith('.part-0.png.url.json')) throw new Error('simulated full disk for first image');
    return rename.call(fs.promises, source, file);
  };
  try {
    await writer.processMessages([wxEnvelope('cache-failure', [wxImage('one'), wxImage('two')])]);
  } finally { fs.promises.rename = rename; }
  const row = (await db.getRecentMessages())[0];
  assert.equal(row.parts.length, 2);
  assert.equal(await reader.getDecryptedImageUrl(row.id, 0), undefined);
  assert.equal(await reader.getDecryptedImageUrl(row.id, 1), secondImage);
  assert.ok(fs.existsSync(path.join(directory, 'images', `${row.id}.part-1.png.url.json`)));
});

test('WeChat duplicate envelopes cannot overwrite fresh routing and preserve quote lookup fallbacks', async t => {
  const { db, writer, reader } = await setup(t, 'wechat');
  const original = { ...message('quote-source'), content: 'locally stored quote', timestamp: 1_700_000_000 };
  await db.insertMessage(original);
  const older = wxEnvelope('inbound-old', [{ type: 1, text_item: { text: 'old body' },
    ref_msg: { message_item: { type: 1, msg_id: 'quote-source' } } }], { context_token: 'old-token' });
  await writer.processMessages([older]);
  assert.deepEqual(JSON.parse((await db.findByMessageId('inbound-old')).reply_to), {
    messageId: 'quote-source', type: 1, text: 'locally stored quote',
  });
  await db.setMetadata('context_token_stale', '1');
  await reader.processMessages([wxEnvelope('inbound-new', [{ type: 3, voice_item: { text: 'new voice' },
    extra: { ref_msg: { message_item: { type: 1, msg_id: 'unknown-reference', create_time_ms: original.timestamp * 1000 } } } }],
    { context_token: 'new-token' })]);
  const voice = await db.findByMessageId('inbound-new');
  assert.equal(voice.type, 3); assert.equal(voice.content, 'new voice');
  assert.equal(JSON.parse(voice.reply_to).text, 'locally stored quote');
  await writer.processMessages([older]);
  assert.equal(await db.getMetadata('context_token'), 'new-token');
  assert.equal(await db.getMetadata('context_token_stale'), '');
  assert.equal((await db.getRecentMessages()).length, 3);
});

for (const channel of ['wechat', 'qq']) {
  test(`${channel} indexed image caches remain distinct from legacy caches after a fresh client loads them`, async t => {
    const { db, context, observer, writer } = await setup(t, channel);
    const id = await db.insertMessage({ ...message('cache-keys'), type: 1,
      parts: [{ type: 1, text: 'caption' }, { type: 2 }, { type: 2 }] });
    const before = await observer.getSyncSnapshot();
    await writer.persistImage(id, firstImage, 1);
    await writer.persistImage(id, secondImage, 2);
    await writer.persistImage(id, 'data:image/png;base64,bGVnYWN5');
    const Client = channel === 'wechat' ? WxClient : QqBotClient;
    const reloaded = new Client(context, observer);
    try {
      assert.equal(await reloaded.getDecryptedImageUrl(id, 1), firstImage);
      assert.equal(await reloaded.getDecryptedImageUrl(id, 2), secondImage);
      assert.equal(await reloaded.getDecryptedImageUrl(id), 'data:image/png;base64,bGVnYWN5');
      assert.equal(await reloaded.getDecryptedImageUrl(id, -1), undefined);
      assert.equal(await reloaded.getDecryptedImageUrl(id, '../1'), undefined);
    } finally { reloaded.dispose(); }
    const after = await observer.getSyncSnapshot(before.cursor);
    assert.equal(after.reset, true); assert.equal(after.messages.length, 1);
    assert.equal(after.cursor.lastId, before.cursor.lastId);
    assert.ok(after.cursor.contentVersion > before.cursor.contentVersion);
  });
}

test('QQ malformed attachment entries or MIME fields do not discard the caption and valid files', async t => {
  const { db, writer } = await setup(t, 'qq');
  await writer.processC2CMessage(qqEnvelope('malformed-qq', {
    content: 'caption survives',
    attachments: [null, 'invalid', [],
      { filename: 'valid.txt', content_type: 42, url: 'https://media.invalid/valid', size: 12 },
      { filename: { invalid: true }, content_type: 'image/png', url: { secret: 'must not stringify' } },
      { filename: 'last.png', content_type: 'image/png', url: 'https://media.invalid/last' },
    ],
  }));
  const row = await db.findByMessageId('malformed-qq');
  assert.deepEqual(row.parts.map(part => part.type), [1, 4, 2, 2]);
  assert.equal(row.parts[0].text, 'caption survives');
  assert.equal(row.parts[1].fileName, 'valid.txt'); assert.equal(row.parts[1].mimeType, undefined);
  assert.equal(row.parts[2].url, undefined); assert.equal(row.parts[2].fileName, undefined);
  assert.equal(row.parts[3].fileName, 'last.png');
  await writer.processC2CMessage(qqEnvelope('nonarray-qq', { content: 'still received', attachments: { unexpected: true } }));
  assert.equal((await db.findByMessageId('nonarray-qq')).content, 'still received');
});

test('WeChat ignores malformed items while keeping cache indices aligned with saved parts', async t => {
  const { db, writer, reader } = await setup(t, 'wechat');
  const downloads = [];
  writer.fetchImageAsDataUrl = async url => { downloads.push(url); return firstImage; };
  await writer.processMessages([
    wxEnvelope('invalid-items', null),
    wxEnvelope('not-an-array', { unexpected: true }),
    wxEnvelope('surviving-items', [null, [], 'invalid',
      { type: 1, text_item: { text: 'retained caption' } }, wxImage('valid'),
      { type: 2, image_item: { media: { full_url: 42, aes_key: 42 } } },
      { type: 4, file_item: { file_name: 'retained.txt', file_size: 9 } },
    ]),
  ]);
  const rows = await db.getRecentMessages(), row = rows[0];
  assert.equal(rows.length, 1); assert.deepEqual(row.parts.map(part => part.type), [1, 2, 2, 4]);
  assert.equal(row.parts[0].text, 'retained caption'); assert.equal(row.parts[3].fileName, 'retained.txt');
  assert.equal(downloads.length, 1);
  assert.equal(await reader.getDecryptedImageUrl(row.id, 1), firstImage);
  assert.equal(await reader.getDecryptedImageUrl(row.id, 2), undefined);
  assert.equal(await reader.getDecryptedImageUrl(row.id, 4), undefined);
});
