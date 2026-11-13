const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatDB, message } = require('./runtime.cjs');
const { WxClient } = require('../src/wx-client.ts');
const { QqBotClient } = require('../src/qq-bot-client.ts');

const imageData = 'data:image/png;base64,iVBORw0KGgo=';
const imageMessage = name => ({ ...message(name), direction: 'received', type: 2, content: '[Image]' });

async function setup(t, channel) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-media-sync-'));
  const context = { globalStorageUri: { fsPath: directory } };
  const db = new ChatDB(context, channel);
  await db.init();
  const observer = new ChatDB(context, channel);
  await observer.init();
  const Client = channel === 'wechat' ? WxClient : QqBotClient;
  const writer = new Client(context, db), reader = new Client(context, observer);
  t.after(async () => {
    writer.dispose();
    reader.dispose();
    await db.close();
    await observer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, db, observer, writer, reader };
}

for (const channel of ['wechat', 'qq']) {
  test(`${channel} publishes a content refresh after the image sidecar is readable by another client`, async (t) => {
    const { db, observer, writer, reader } = await setup(t, channel);
    const id = await db.insertMessage(imageMessage(`${channel}-image`));
    const before = await observer.getSyncSnapshot();
    assert.equal(before.messages[0].id, id);
    assert.equal(await reader.getDecryptedImageUrl(id), undefined);
    await writer.persistImage(id, imageData);
    const ready = await observer.getSyncSnapshot(before.cursor, id);
    assert.equal(ready.reset, true);
    assert.equal(ready.cursor.generation, before.cursor.generation);
    assert.ok(ready.cursor.contentVersion > before.cursor.contentVersion);
    assert.equal(ready.cursor.lastId, before.cursor.lastId, 'cache completion must not insert a second message');
    assert.deepEqual(ready.messages.map(msg => msg.id), [id]);
    assert.equal(ready.unreadCount, before.unreadCount, 'cache completion is not another incoming message');
    assert.equal(await reader.getDecryptedImageUrl(id), imageData);

    await db.clearAll();
    const cleared = await observer.getSyncSnapshot();
    const stamp = await db.getChangeStamp();
    await writer.persistImage(id, imageData);
    const late = await observer.getSyncSnapshot(cleared.cursor);
    assert.equal(late.reset, false, 'late media completion after clearing must not reset history again');
    assert.deepEqual(late.cursor, cleared.cursor);
    assert.deepEqual(late.messages, []);
    assert.equal(await db.getChangeStamp(), stamp);
  });

  test(`${channel} failed sidecar persistence does not announce media readiness`, async (t) => {
    const { directory, db, observer, writer, reader } = await setup(t, channel);
    const id = await db.insertMessage(imageMessage(`${channel}-failed-image`));
    const before = await observer.getSyncSnapshot();
    const stamp = await db.getChangeStamp();
    const sidecar = channel === 'wechat'
      ? path.join(directory, 'images', `${id}.png.url.json`)
      : path.join(directory, 'qq-images', `${id}.json`);
    const originalRename = fs.promises.rename;
    fs.promises.rename = async (source, file) => {
      if (String(file) === sidecar) throw new Error('simulated sidecar failure');
      return originalRename.call(fs.promises, source, file);
    };
    try {
      if (channel === 'wechat') await writer.persistImage(id, imageData); // WeChat logs cache failures.
      else await assert.rejects(writer.persistImage(id, imageData), /simulated sidecar failure/);
    } finally {
      fs.promises.rename = originalRename;
    }
    const after = await observer.getSyncSnapshot(before.cursor);
    assert.equal(after.reset, false);
    assert.deepEqual(after.cursor, before.cursor);
    assert.deepEqual(after.messages, []);
    assert.equal(await db.getChangeStamp(), stamp);
    assert.equal(await reader.getDecryptedImageUrl(id), undefined);
  });
}

test('media readiness validates IDs and ignores non-image or deleted rows without writing', async (t) => {
  const { db, observer } = await setup(t, 'qq');
  const textId = await db.insertMessage(message('plain-text'));
  const imageId = await db.insertMessage(imageMessage('image-row'));
  const before = await observer.getSyncSnapshot();
  const stamp = await db.getChangeStamp();
  for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    await assert.rejects(db.markMessageMediaReady(id));
  }
  await db.markMessageMediaReady(textId);
  await db.markMessageMediaReady(imageId + 1000);
  assert.equal(await db.getChangeStamp(), stamp);
  const ignored = await observer.getSyncSnapshot(before.cursor);
  assert.equal(ignored.reset, false);
  assert.deepEqual(ignored.cursor, before.cursor);
  await db.markMessageMediaReady(imageId);
  const ready = await observer.getSyncSnapshot(before.cursor);
  assert.equal(ready.reset, true);
  assert.ok(ready.cursor.contentVersion > before.cursor.contentVersion);
  await db.clearAll();
  const cleared = await observer.getSyncSnapshot();
  const clearedStamp = await db.getChangeStamp();
  await db.markMessageMediaReady(imageId);
  assert.equal(await db.getChangeStamp(), clearedStamp);
  assert.deepEqual((await observer.getSyncSnapshot()).cursor, cleared.cursor);
});
