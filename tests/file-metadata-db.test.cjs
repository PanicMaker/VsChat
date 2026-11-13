const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatDB, message } = require('./runtime.cjs');

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-file-metadata-'));
  const instances = [];
  const open = async () => {
    const db = new ChatDB({ globalStorageUri: { fsPath: directory } }, 'wechat');
    await db.init();
    instances.push(db);
    return db;
  };
  t.after(async () => {
    await Promise.all(instances.map(db => db.close()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { db: await open(), open };
}

const filePart = (extra = {}) => ({
  type: 4, fileName: 'report.pdf', size: 1024, mimeType: 'application/pdf',
  url: 'https://example.invalid/report', ...extra,
});
const incoming = (name, parts) => ({
  ...message(name), direction: 'received', from_user_id: 'peer', to_user_id: 'bot',
  context_token: 'test-context', content: `Files: ${name} report.pdf`, parts,
});

test('host file metadata survives all persisted read paths while runtime rendering fields are stripped', async (t) => {
  const { db, open } = await setup(t);
  const initial = await db.getSyncSnapshot();
  const metadata = { aesKey: 'test-aes-key', encryptQueryParam: 'encrypted-query', md5: 'test-md5' };
  const expected = [
    { type: 1, text: 'caption' },
    filePart({ fileMedia: metadata }),
  ];
  const supplied = expected.map(part => ({
    ...part, fileAction: { canSave: true, reason: 'runtime-only-reason' },
    imageDataUrl: 'data:image/png;base64,RUNTIME', markdown: [{ type: 'text', text: 'rendered' }],
  }));
  supplied[1].fileMedia = { ...metadata, authorization: 'not-a-stored-field', nested: { unwanted: true } };
  const { id } = await db.storeWxInbound(incoming('file-roundtrip', supplied));
  const stamp = await db.getChangeStamp();
  const sync = await db.getSyncSnapshot(initial.cursor);
  const search = await db.searchMessages({ query: 'report.pdf', type: 4 });
  const context = await db.getMessageContext({ id }, sync.cursor.generation, 0);
  assert.equal(context.messages.length, 1);
  const readers = [
    (await db.getRecentMessages())[0],
    (await db.getMessagesFromId(id))[0],
    await db.findByMessageId('file-roundtrip'),
    await db.findByTimestamp(1_700_000_000, 0),
    (await db.getHistoryPage(id + 1, sync.cursor.generation)).messages[0],
    sync.messages[0], search.messages[0], context.messages[0],
  ];
  for (const row of readers) assert.deepEqual(row.parts, expected);
  assert.equal(await db.getChangeStamp(), stamp);
  const stored = await db.withDatabase(sql => sql.exec('SELECT parts FROM messages WHERE id = ?', [id]));
  assert.deepEqual(JSON.parse(stored[0].values[0][0]), expected);
  assert.doesNotMatch(stored[0].values[0][0], /fileAction|runtime-only|imageDataUrl|markdown|authorization|nested/);
  const reopened = await open();
  assert.deepEqual((await reopened.findByMessageId('file-roundtrip')).parts, expected);
});

test('file media strings accept their maximum lengths and drop invalid required keys without losing the file card', async (t) => {
  const { db } = await setup(t);
  const max = { aesKey: 'k'.repeat(512), encryptQueryParam: 'q'.repeat(8192), md5: 'm'.repeat(128) };
  const id = await db.insertMessage(incoming('boundary', [filePart({ fileMedia: max })]));
  const persisted = (await db.getMessageContext({ id }, undefined, 0)).messages[0].parts[0].fileMedia;
  assert.equal(persisted.aesKey.length, 512);
  assert.equal(persisted.encryptQueryParam.length, 8192);
  assert.equal(persisted.md5.length, 128);

  const invalid = [undefined, null, [], ['key'], 'key', 5, true, {},
    ...['', '   ', 5, false, [], {}, 'k'.repeat(513), '\0key', 'ke\0y', 'key\0', 'key\n', 'key\t', 'key\r', 'key\x1f', 'key\x7f']
      .map(aesKey => ({ aesKey, encryptQueryParam: 'valid-query', md5: 'valid-md5' }))];
  for (const [index, fileMedia] of invalid.entries()) {
    const rowId = await db.insertMessage(incoming(`invalid-key-${index}`, [filePart({ fileMedia })]));
    const card = (await db.getMessageContext({ id: rowId }, undefined, 0)).messages[0].parts[0];
    assert.equal(card.fileMedia, undefined, `invalid key fixture ${index}`);
    assert.equal(card.fileName, 'report.pdf');
    assert.equal(card.url, 'https://example.invalid/report');
  }
  const spaced = { aesKey: ' key ', encryptQueryParam: ' query ', md5: ' checksum ' };
  const spacedId = await db.insertMessage(incoming('preserve-whitespace', [filePart({ fileMedia: spaced })]));
  assert.deepEqual((await db.getMessageContext({ id: spacedId }, undefined, 0)).messages[0].parts[0].fileMedia, spaced);
});

test('invalid optional media strings are dropped independently of the valid AES key and other option', async (t) => {
  const { db } = await setup(t);
  for (const [key, maxLength, retainedKey] of [
    ['encryptQueryParam', 8192, 'md5'], ['md5', 128, 'encryptQueryParam'],
  ]) {
    for (const [index, value] of ['', '   ', null, 1, false, [], {}, 'x'.repeat(maxLength + 1), '\0', 'prefix\0suffix', 'bad\nvalue', 'bad\tvalue', 'bad\rvalue', 'bad\x1fvalue', 'bad\x7fvalue'].entries()) {
      const metadata = { aesKey: 'valid-key', [retainedKey]: 'keep-value', [key]: value };
      const id = await db.insertMessage(incoming(`${key}-${index}`, [filePart({ fileMedia: metadata })]));
      const actual = (await db.getMessageContext({ id }, undefined, 0)).messages[0].parts[0].fileMedia;
      assert.deepEqual(actual, { aesKey: 'valid-key', [retainedKey]: 'keep-value' });
    }
  }
});

test('non-file parts never persist file download metadata or runtime capabilities', async (t) => {
  const { db } = await setup(t);
  const expected = [1, 2, 3, 5].map(type => ({ type, text: `type ${type}`, url: 'https://example.invalid/media' }));
  const id = await db.insertMessage(incoming('non-files', expected.map(part => ({
    ...part, fileMedia: { aesKey: 'must-be-removed', encryptQueryParam: 'must-be-removed' },
    fileAction: { canSave: true }, imageDataUrl: 'data:image/png;base64,RUNTIME',
    markdown: [{ type: 'text', text: 'runtime' }],
  }))));
  assert.deepEqual((await db.getMessageContext({ id }, undefined, 0)).messages[0].parts, expected);
  const raw = await db.withDatabase(sql => sql.exec('SELECT parts FROM messages WHERE id = ?', [id]));
  assert.doesNotMatch(raw[0].values[0][0], /fileMedia|fileAction|imageDataUrl|markdown/);
});

test('old parts remain compatible and untrusted legacy JSON is sanitized on every read without being rewritten', async (t) => {
  const { db } = await setup(t);
  const oldParts = [{ type: 1, text: 'legacy text' }, filePart()];
  const oldId = await db.insertMessage(incoming('old-file', oldParts));
  assert.deepEqual((await db.getMessageContext({ id: oldId }, undefined, 0)).messages[0].parts, oldParts);
  const id = await db.insertMessage(incoming('legacy-raw', [filePart()]));
  const rawParts = [
    filePart({ fileMedia: { aesKey: 'valid-key', encryptQueryParam: 'too-long'.repeat(1200), md5: 'ok-md5', ignored: 'drop' }, fileAction: { canSave: true } }),
    filePart({ fileName: 'invalid-key.pdf', fileMedia: { aesKey: 'bad\0key', md5: 'ignored' } }),
    { type: 2, url: 'https://example.invalid/image', fileMedia: { aesKey: 'wrong-type' } },
  ];
  const expected = [
    filePart({ fileMedia: { aesKey: 'valid-key', md5: 'ok-md5' } }),
    filePart({ fileName: 'invalid-key.pdf' }),
    { type: 2, url: 'https://example.invalid/image' },
  ];
  await db.withDatabase(sql => sql.run('UPDATE messages SET parts = ? WHERE id = ?', [JSON.stringify(rawParts), id]), true);
  const before = await db.getSyncSnapshot();
  const stamp = await db.getChangeStamp();
  const readers = [
    await db.findByMessageId('legacy-raw'),
    (await db.getMessageContext({ id }, before.cursor.generation, 0)).messages[0],
    (await db.searchMessages({ query: 'legacy-raw', type: 4 })).messages[0],
    (await db.getSyncSnapshot()).messages.find(row => row.id === id),
  ];
  for (const row of readers) assert.deepEqual(row.parts, expected);
  assert.equal(await db.getChangeStamp(), stamp);
  const raw = await db.withDatabase(sql => sql.exec('SELECT parts FROM messages WHERE id = ?', [id]));
  assert.deepEqual(JSON.parse(raw[0].values[0][0]), rawParts, 'defensive reads do not silently migrate stored bytes');
});

test('message text normalization preserves valid file decryption metadata unchanged', async (t) => {
  const { db } = await setup(t);
  const metadata = { aesKey: '<face>key', encryptQueryParam: 'query=<face>', md5: '<face>md5' };
  const id = await db.insertMessage(incoming('normalization', [
    { type: 1, text: '<face> caption' }, filePart({ fileMedia: metadata }),
  ]));
  await db.normalizeMessageText(value => value.replaceAll('<face>', '[face]'));
  const actual = (await db.getMessageContext({ id }, undefined, 0)).messages[0].parts;
  assert.equal(actual[0].text, '[face] caption');
  assert.deepEqual(actual[1].fileMedia, metadata);
});
