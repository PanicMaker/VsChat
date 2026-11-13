const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./runtime.cjs');
const { persistImageCache } = require('../src/image-cache.ts');

const oldImage = 'data:image/png;base64,iVBORw0KGgo=';
const newImage = 'data:image/png;base64,iVBORw0KGgoBAgM=';
function setup(t, channel) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-cache-atomic-'));
  const directory = path.join(root, channel === 'wechat' ? 'images' : 'qq-images');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory, sidecar: path.join(directory, channel === 'wechat' ? '1.png.url.json' : '1.json'),
    raw: path.join(directory, '1.png') };
}
function read(file) { return fs.readFileSync(file); }
function noTemporary(directory) { assert.ok(fs.readdirSync(directory).every(name => !name.startsWith('.cache-write-'))); }

for (const channel of ['wechat', 'qq']) {
  test(`${channel} complete replacement preserves filename contracts and closes staged files before publication`, async t => {
    const { root, directory, sidecar } = setup(t, channel);
    await persistImageCache(root, channel, 1, oldImage);
    const oldInode = fs.lstatSync(sidecar).ino;
    await persistImageCache(root, channel, 1, newImage);
    assert.equal(JSON.parse(read(sidecar)).dataUrl, newImage);
    assert.notEqual(fs.lstatSync(sidecar).ino, oldInode);
    await persistImageCache(root, channel, 1, oldImage, 2);
    assert.ok(fs.existsSync(path.join(directory, channel === 'wechat' ? '1.part-2.png.url.json' : '1.part-2.json')));
    noTemporary(directory);
  });

  test(`${channel} staged write failure leaves all existing cache bytes unchanged`, async t => {
    const { root, directory, sidecar, raw } = setup(t, channel);
    await persistImageCache(root, channel, 1, oldImage);
    const before = read(sidecar), rawBefore = channel === 'wechat' ? read(raw) : undefined;
    const open = fs.promises.open;
    fs.promises.open = async (file, ...args) => {
      const handle = await open.call(fs.promises, file, ...args);
      if (String(file).includes('.cache-write-') && String(file).endsWith('.json')) {
        handle.writeFile = async () => { throw new Error('injected write failure'); };
      }
      return handle;
    };
    try { await assert.rejects(persistImageCache(root, channel, 1, newImage), /injected write failure/); }
    finally { fs.promises.open = open; }
    assert.deepEqual(read(sidecar), before);
    if (rawBefore) assert.deepEqual(read(raw), rawBefore);
    noTemporary(directory);
  });

  test(`${channel} refuses symlink final and directory without touching outside bytes`, async t => {
    const { root, directory, sidecar } = setup(t, channel);
    const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'keep');
    fs.mkdirSync(directory); fs.symlinkSync(outside, sidecar);
    await assert.rejects(persistImageCache(root, channel, 1, newImage), /无效/);
    assert.equal(read(outside).toString(), 'keep'); assert.equal(fs.lstatSync(sidecar).isSymbolicLink(), true);
    fs.unlinkSync(sidecar); fs.rmdirSync(directory);
    const other = path.join(root, 'outside-directory'); fs.mkdirSync(other); fs.symlinkSync(other, directory);
    await assert.rejects(persistImageCache(root, channel, 1, newImage), /无效/);
    assert.deepEqual(fs.readdirSync(other), []);
  });
}

for (const existing of [false, true]) {
  test(`WeChat second rename failure rolls back ${existing ? 'the original pair' : 'the newly created first file'}`, async t => {
    const { root, directory, sidecar, raw } = setup(t, 'wechat');
    if (existing) await persistImageCache(root, 'wechat', 1, oldImage);
    const before = existing ? [read(raw), read(sidecar)] : undefined;
    const rename = fs.promises.rename;
    fs.promises.rename = async (source, destination) => {
      if (destination === sidecar && !String(source).endsWith('.previous')) throw new Error('second publication failed');
      return rename.call(fs.promises, source, destination);
    };
    try { await assert.rejects(persistImageCache(root, 'wechat', 1, newImage), /second publication failed/); }
    finally { fs.promises.rename = rename; }
    if (before) { assert.deepEqual(read(raw), before[0]); assert.deepEqual(read(sidecar), before[1]); }
    else { assert.equal(fs.existsSync(raw), false); assert.equal(fs.existsSync(sidecar), false); }
    noTemporary(directory);
    await persistImageCache(root, 'wechat', 1, newImage);
    assert.equal(JSON.parse(read(sidecar)).dataUrl, newImage, 'failure does not poison a later retry');
  });
}

test('rollback never overwrites a different inode and retains original backup for recovery', async t => {
  const { root, directory, sidecar, raw } = setup(t, 'wechat');
  await persistImageCache(root, 'wechat', 1, oldImage);
  const originalBytes = read(raw), replacement = path.join(root, 'replacement');
  fs.writeFileSync(replacement, 'different writer');
  const rename = fs.promises.rename;
  fs.promises.rename = async (source, destination) => {
    if (destination === sidecar) {
      await rename.call(fs.promises, replacement, raw);
      throw new Error('injected concurrent replacement');
    }
    return rename.call(fs.promises, source, destination);
  };
  try { await assert.rejects(persistImageCache(root, 'wechat', 1, newImage), /原缓存备份已保留/); }
  finally { fs.promises.rename = rename; }
  assert.equal(read(raw).toString(), 'different writer');
  assert.equal(JSON.parse(read(sidecar)).dataUrl, oldImage);
  const transaction = fs.readdirSync(directory).find(name => name.startsWith('.cache-write-'));
  assert.ok(transaction);
  assert.deepEqual(read(path.join(directory, transaction, '1.png.previous')), originalBytes);
});
