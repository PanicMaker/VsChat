const { test } = require('node:test');
const assert = require('node:assert/strict');
const MarkdownIt = require('markdown-it');
require('./runtime.cjs');
const {
  MAX_ARCHIVE_BYTES, MAX_ARCHIVE_RECORDS, validateArchiveRecords,
  createBackup, parseBackup, exportHistory, summarizeBackup,
} = require('../src/chat-archive.ts');

const date = '2026-11-12T10:00:00.000Z';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6vSIAAAAASUVORK5CYII=';
const record = (id = 1, overrides = {}) => ({
  key: `source:test-${id}`, originalId: id,
  message: { direction: 'received', type: 1, content: 'hello', timestamp: 1_700_000_000 + id,
    from_user_id: 'historical-peer', to_user_id: 'historical-bot', ...overrides },
});
const snapshot = (records = [record()], channel = 'qq') => ({ channel, generation: 'not-exported', contentVersion: 17, records });
const envelope = (records = [record()], images = []) => ({ format: 'vschat-backup', version: 1, channel: 'qq', createdAt: date, records, images });
const encoded = value => Buffer.from(JSON.stringify(value));
const parse = value => parseBackup(encoded(value), 'qq');

test('backup round trip preserves identity, history, private attachment references and cached images', () => {
  const records = [record(1, { type: 2, content: '[图片]' }), record(2, {
    parts: [
      { type: 1, text: 'caption' }, { type: 2, url: 'https://gchat.qpic.cn/image?secret=1' },
      { type: 4, fileName: 'report.pdf', size: 12, mimeType: 'application/pdf', url: 'https://cdn.qq.com/file?secret=2',
        fileMedia: { aesKey: 'base64-private-key', encryptQueryParam: 'private-download-token', md5: 'a'.repeat(32) } },
    ],
    message_id: 'transport-id', reference_id: 'quote-index', reply_to: JSON.stringify({ messageId: 'previous', type: 1, text: 'quoted' }),
  })];
  const images = [{ messageKey: records[0].key, dataUrl: png }, { messageKey: records[1].key, partIndex: 1, dataUrl: png }];
  const bytes = createBackup(snapshot(records), images, date);
  const restored = parseBackup(bytes, 'qq');
  assert.deepEqual(restored, envelope(records, images));
  assert.ok(!bytes.toString().includes('not-exported'));
  assert.deepEqual(summarizeBackup(restored), {
    messageCount: 2, imageCount: 2, imageBytes: Buffer.from(png.split(',')[1], 'base64').length * 2,
    fromTimestamp: 1_700_000_001, toTimestamp: 1_700_000_002,
  });
});

test('record validation clones only stored fields and strips authentication, routing and runtime injection', () => {
  const input = record(1, {
    context_token: 'do-not-copy-context', credentials: { secret: 'do-not-copy-secret' }, metadata: { qq_user_openid: 'live-route' },
    restored: true, markdown: [{ tag: 'text', text: 'runtime' }],
    parts: [{ type: 4, fileName: 'a.txt', size: 0, fileMedia: { aesKey: 'keep-file-key', token: 'remove-nested-token' },
      imageDataUrl: png, fileAction: { canSave: true }, markdown: [], localPath: '/private/path' }],
  });
  const result = validateArchiveRecords([input]);
  assert.deepEqual(Object.keys(result[0].message).sort(), ['content', 'direction', 'from_user_id', 'parts', 'timestamp', 'to_user_id', 'type']);
  assert.deepEqual(result[0].message.parts, [{ type: 4, fileName: 'a.txt', size: 0, fileMedia: { aesKey: 'keep-file-key' } }]);
  assert.ok(!JSON.stringify(result).includes('do-not-copy'));
  assert.notEqual(result[0], input);
  result[0].message.parts[0].fileMedia.aesKey = 'changed';
  assert.equal(input.message.parts[0].fileMedia.aesKey, 'keep-file-key');
  const restored = parse(envelope([input]));
  assert.ok(!('context_token' in restored.records[0].message));
  assert.ok(!('restored' in restored.records[0].message));
});

test('backup rejects unknown versions, other channels, extra top-level fields and invalid encodings', () => {
  for (const changed of [
    { format: 'vschat-export' }, { version: 2 }, { version: '1' }, { channel: 'wechat' },
    { channel: 'QQ' }, { metadata: {} }, { credentials: {} }, { fileName: '../backup.json' },
    { createdAt: '2026-02-30T00:00:00.000Z' }, { createdAt: 'not a date' },
  ]) assert.throws(() => parse({ ...envelope(), ...changed }));
  for (const bytes of [Buffer.from('{broken'), Buffer.from([0xff, 0xfe]), Buffer.alloc(0)]) assert.throws(() => parseBackup(bytes, 'qq'));
  assert.throws(() => parseBackup(new Uint8Array(MAX_ARCHIVE_BYTES + 1), 'qq'), /64 MiB/);
});

test('records require canonical arrays, bounded fields, valid enums, IDs and unique identity', () => {
  for (const records of [
    null, {}, new Array(1), Array(MAX_ARCHIVE_RECORDS + 1).fill(record()),
    [record(), record()], [record(), { ...record(2), key: record().key }],
    [record(), { ...record(2), originalId: 1 }],
    [{ ...record(), key: '../escape' }], [{ ...record(), key: 'a..b' }], [{ ...record(), key: 'x'.repeat(161) }],
    [{ ...record(), originalId: 0 }], [{ ...record(), originalId: Number.MAX_SAFE_INTEGER + 1 }],
    [record(1, { direction: 'outgoing' })], [record(1, { type: 8 })],
    [record(1, { timestamp: NaN })], [record(1, { timestamp: Infinity })], [record(1, { timestamp: -1 })],
    [record(1, { content: '中'.repeat(Math.ceil(1024 * 1024 / 3)) })],
    [record(1, { from_user_id: null })], [record(1, { parts: Array(101).fill({ type: 2 }) })],
    [record(1, { parts: [{ type: 4, size: -1 }] })], [record(1, { parts: [{ type: 4, size: 1.5 }] })],
    [record(1, { parts: [{ type: 2, fileMedia: { aesKey: 'key' } }] })],
  ]) assert.throws(() => validateArchiveRecords(records));
  const arrayWithExtra = [record()]; arrayWithExtra.path = '/tmp/secret';
  assert.throws(() => validateArchiveRecords(arrayWithExtra));
  const nestedPrototype = record(); nestedPrototype.message = Object.create({ content: 'prototype data' });
  assert.throws(() => validateArchiveRecords([nestedPrototype]));
  const uuid = 'd910be70-0aba-4109-ab60-916a5a147c40';
  assert.equal(validateArchiveRecords([{ ...record(), key: uuid }])[0].key, uuid);
});

test('cached images must map to real image messages or parts and cannot contain filenames or paths', () => {
  const top = record(1, { type: 2 });
  const mixed = record(2, { parts: [{ type: 1, text: 'caption' }, { type: 2 }] });
  const good = { messageKey: top.key, dataUrl: png };
  for (const images of [
    [{ ...good, messageKey: 'missing' }], [{ ...good, messageKey: mixed.key }],
    [{ ...good, partIndex: -1 }], [{ ...good, messageKey: mixed.key, partIndex: 0 }],
    [{ ...good, messageKey: mixed.key, partIndex: 100 }], [good, good],
    [{ ...good, filename: '../../escape.png' }], [{ ...good, path: '/tmp/escape.png' }],
    [{ ...good, dataUrl: 'https://gchat.qpic.cn/image' }],
  ]) assert.throws(() => parse(envelope([top, mixed], images)));
  assert.equal(parse(envelope([top, mixed], [{ ...good, messageKey: mixed.key, partIndex: 1 }])).images[0].partIndex, 1);
  const modernImage = record(1, { type: 2, parts: [{ type: 2 }] });
  assert.throws(() => parse(envelope([modernImage], [good])), /索引/);
  assert.equal(parse(envelope([modernImage], [{ ...good, partIndex: 0 }])).images[0].partIndex, 0);
});

test('cached images require canonical Base64, matching raster magic and the 10 MiB limit', () => {
  const image = dataUrl => [{ messageKey: record().key, dataUrl }];
  const rows = [record(1, { type: 2 })];
  for (const dataUrl of [
    'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=',
    'data:image/png;base64,' + Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'),
    'data:image/png;base64,YWJj', png.replace(/=$/, ''), png + '\n',
    'data:image/bmp;base64,Qk1=', 'data:image/bmp;base64,',
  ]) assert.throws(() => parse(envelope(rows, image(dataUrl))));
  const large = Buffer.alloc(10 * 1024 * 1024 + 1);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(large);
  assert.throws(() => createBackup(snapshot(rows), image(`data:image/png;base64,${large.toString('base64')}`), date), /10 MiB|大小/);
  for (const [mime, bytes] of [
    ['png', Buffer.from(png.split(',')[1], 'base64')], ['jpeg', Buffer.from([255, 216, 255, 217])],
    ['gif', Buffer.from('GIF89a')], ['webp', Buffer.from('RIFF0000WEBP')], ['bmp', Buffer.from('BM')],
  ]) assert.equal(parse(envelope(rows, image(`data:image/${mime};base64,${bytes.toString('base64')}`))).images.length, 1);
});

test('createBackup and exports reject oversized aggregate content instead of truncating', () => {
  const content = 'a'.repeat(1024 * 1024);
  const records = Array.from({ length: 65 }, (_, index) => record(index + 1, { content }));
  assert.throws(() => createBackup(snapshot(records), [], date), /64 MiB/);
  assert.throws(() => exportHistory(snapshot(records), 'json'), /64 MiB/);
  assert.equal(validateArchiveRecords([record(1, { content })])[0].message.content.length, content.length);
});

test('sharing exports remove transport identities, attachment access secrets and legacy file protocol bodies', () => {
  const legacy = JSON.stringify({ type: 4, file_item: { file_name: 'old-report.pdf', len: '7', media: {
    full_url: 'https://cdn.qq.com/download?secret=SIGNED-URL', aes_key: 'PRIVATE-AES', encrypt_query_param: 'PRIVATE-PARAM',
  } } });
  const rows = [record(1, {
    type: 4, content: legacy, context_token: 'PRIVATE-CONTEXT', message_id: 'PRIVATE-TRANSPORT-ID', reference_id: 'PRIVATE-REF',
    reply_to: JSON.stringify({ messageId: 'PRIVATE-QUOTE-ID', type: 4, text: legacy, secret: 'EXTRA-SECRET' }),
    parts: [{ type: 4, text: legacy, fileName: 'report.pdf', size: 7, mimeType: 'application/pdf',
      url: 'https://cdn.qq.com/download?secret=SIGNED-URL', fileMedia: { aesKey: 'PRIVATE-AES', encryptQueryParam: 'PRIVATE-PARAM' } }],
  })];
  for (const format of ['json', 'markdown']) {
    const result = exportHistory(snapshot(rows), format).toString();
    for (const secret of ['SIGNED-URL', 'PRIVATE-', 'EXTRA-SECRET', 'historical-peer', 'historical-bot', 'context_token', 'fileMedia', 'full_url', 'file_item']) {
      assert.ok(!result.includes(secret), `${format} should omit ${secret}`);
    }
    assert.ok(result.includes('report.pdf'));
    assert.ok(result.includes('old-report.pdf'));
    assert.ok(result.includes('application/pdf'));
  }
  const parsed = JSON.parse(exportHistory(snapshot(rows), 'json'));
  assert.equal(parsed.format, 'vschat-export');
  assert.equal(parsed.records[0].parts[0].size, 7);
  assert.throws(() => parseBackup(encoded(parsed), 'qq'), /备份/);
});

test('legacy protocol JSON inside an untyped quote is still reduced to a safe file label', () => {
  const text = JSON.stringify({ file_item: { file_name: 'quoted.txt', media: { aes_key: 'DO-NOT-EXPORT', full_url: 'https://qq.com/private' } } });
  const data = exportHistory(snapshot([record(1, { reply_to: JSON.stringify({ text }), content: 'caption' })]), 'json').toString();
  assert.ok(!data.includes('DO-NOT-EXPORT'));
  assert.ok(!data.includes('https://'));
  assert.equal(JSON.parse(data).records[0].reply.text, '[文件：quoted.txt]');
});

test('bare media URLs never leave sharing exports while links inside actual prose stay intact', () => {
  const signedUrl = 'https://gchat.qpic.cn/image?signature=SECRET-SIGNED-URL';
  const records = [
    record(1, { type: 2, content: signedUrl }),
    record(2, { type: 5, content: JSON.stringify(signedUrl), reply_to: JSON.stringify({ type: 2, text: signedUrl }) }),
    record(3, { content: '查看 https://example.com/docs', parts: [
      { type: 2, text: signedUrl }, { type: 4, text: '真正的文件说明', fileName: 'a.txt' },
    ] }),
  ];
  for (const format of ['json', 'markdown']) {
    const output = exportHistory(snapshot(records), format).toString();
    assert.ok(!output.includes('SECRET-SIGNED-URL'));
    assert.ok(output.includes('https://example.com/docs'));
    assert.ok(output.includes('真正的文件说明'));
  }
});

test('Markdown export keeps hostile HTML, remote images and nested fences inside inert text blocks', () => {
  const content = '<script>alert(1)</script>\n![pixel](https://tracker.test/p.png)\n`````\n# escaped?\n```js\nconst a = `<img onerror=alert(2)>`;\n```\n';
  const rows = [record(1, { content, reply_to: JSON.stringify({ text: '</pre><img src="https://tracker.test/quote">' }),
    parts: [{ type: 4, fileName: '``````\n<script>unsafe</script>.txt', mimeType: 'text/plain' }] })];
  const markdown = exportHistory(snapshot(rows), 'markdown').toString();
  const parser = new MarkdownIt({ html: true, linkify: true });
  const tokens = parser.parse(markdown, {});
  assert.ok(tokens.some(token => token.type === 'fence' && token.content === content));
  assert.ok(!tokens.some(token => token.type === 'html_block'));
  const html = parser.render(markdown);
  assert.ok(!/<(?:script|img)\b/i.test(html));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('empty backup summaries and unsorted timestamps produce explicit accurate counts', () => {
  assert.deepEqual(summarizeBackup(parse(envelope([], []))), { messageCount: 0, imageCount: 0, imageBytes: 0 });
  const summary = summarizeBackup(parse(envelope([record(1, { timestamp: 30 }), record(2, { timestamp: 10 })])));
  assert.equal(summary.fromTimestamp, 10);
  assert.equal(summary.toTimestamp, 30);
  assert.equal(JSON.parse(exportHistory(snapshot([]), 'json')).records.length, 0);
});
