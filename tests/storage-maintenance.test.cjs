const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./runtime.cjs');
const { collectBackupImages, restoreBackupImages, getStorageUsage, previewCacheCleanup,
  executeCacheCleanup, withMediaLock, MAX_CACHED_IMAGE_BYTES } = require('../src/storage-maintenance.ts');

const png = 'data:image/png;base64,iVBORw0KGgo=';
const jpeg = 'data:image/jpeg;base64,/9j/';
const now = Date.now();
const old = new Date(now - 30 * 86400_000);
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function record(id, message = {}) {
  return { key: `key-${id}`, originalId: id, message: { direction: 'received', type: 2, content: '[图片]',
    timestamp: 1_700_000_000, from_user_id: 'peer', to_user_id: 'bot', ...message } };
}
function snapshot(channel, records = [], extra = {}) { return { channel, generation: 'gen-one', contentVersion: 0, records, ...extra }; }
function file(root, relative, data, aged = false) {
  const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  if (aged) fs.utimesSync(target, old, old);
  return target;
}
function cache(root, channel, stem, dataUrl = png, aged = false) {
  const directory = channel === 'wechat' ? 'images' : 'qq-images';
  if (channel === 'wechat') file(root, `${directory}/${stem}.png`, Buffer.from(dataUrl.split(',')[1] || '', 'base64'), aged);
  return file(root, `${directory}/${stem}${channel === 'wechat' ? '.png.url' : ''}.json`, JSON.stringify({ dataUrl }), aged);
}
function walk(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(path.join(root, entry.name)) : [path.join(root, entry.name)]);
}

for (const channel of ['wechat', 'qq']) {
  test(`${channel} collects only referenced raster cache and does not read credentials, drafts or remote URLs`, async t => {
    const root = setup(t);
    cache(root, channel, '1'); cache(root, channel, '2.part-1', jpeg); cache(root, channel, '99');
    file(root, 'credentials.json', 'private login secret'); file(root, 'file-drafts/private.bin', 'draft contents');
    const bad = cache(root, channel, '3', 'https://remote.invalid/image');
    const oversized = cache(root, channel, '4'); fs.truncateSync(oversized, Math.ceil(MAX_CACHED_IMAGE_BYTES / 3) * 4 + 2048);
    const outside = file(root, 'outside-secret.json', JSON.stringify({ dataUrl: png }));
    const linked = path.join(root, channel === 'wechat' ? 'images/5.png.url.json' : 'qq-images/5.json');
    fs.symlinkSync(outside, linked);
    const open = fs.promises.open, opened = [];
    fs.promises.open = async (target, ...args) => { opened.push(String(target)); return open.call(fs.promises, target, ...args); };
    let result;
    try { result = await collectBackupImages(root, snapshot(channel, [record(1), record(2, { type: 1, parts: [{ type: 1, text: 'caption' }, { type: 2 }] }),
      record(3), record(4), record(5), record(6)])); }
    finally { fs.promises.open = open; }
    assert.deepEqual(result.images, [{ messageKey: 'key-1', dataUrl: png }, { messageKey: 'key-2', partIndex: 1, dataUrl: jpeg }]);
    assert.equal(result.missing, 1); assert.equal(result.skipped, 3);
    assert.ok(opened.every(target => !target.includes('credentials') && !target.includes('file-drafts') && !target.includes('99.')));
    assert.ok(!opened.includes(oversized), 'size is checked before opening the oversized sidecar');
    assert.ok(!opened.includes(linked), 'links are never opened');
    assert.ok(opened.includes(bad), 'invalid cached URLs are inspected, never downloaded');
  });
}

test('multipart image backup never exports an unused legacy cache or a false missing legacy image', async t => {
  const root = setup(t);
  cache(root, 'wechat', '1', jpeg); cache(root, 'wechat', '1.part-0');
  const result = await collectBackupImages(root, snapshot('wechat', [record(1, { parts: [{ type: 2 }] }), record(2, { parts: [] })]));
  assert.deepEqual(result, { images: [{ messageKey: 'key-1', partIndex: 0, dataUrl: png }], missing: 0, skipped: 0 });
});

test('a cache that changes during the bounded read is skipped', async t => {
  const root = setup(t), target = cache(root, 'qq', '1');
  const open = fs.promises.open;
  fs.promises.open = async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === target) {
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => {
        const result = await read(...readArgs);
        fs.appendFileSync(target, ' ');
        return result;
      };
    }
    return handle;
  };
  try { assert.deepEqual(await collectBackupImages(root, snapshot('qq', [record(1)])), { images: [], missing: 0, skipped: 1 }); }
  finally { fs.promises.open = open; }
});

for (const channel of ['wechat', 'qq']) {
  test(`${channel} restore remaps IDs, retains indexed caches and never overwrites existing files`, async t => {
    const root = setup(t);
    const input = [{ messageKey: 'old', partIndex: 2, dataUrl: jpeg }, { messageKey: 'legacy', dataUrl: png }];
    const mapping = [{ key: 'old', id: 101, inserted: true }, { key: 'legacy', id: 102, inserted: false }];
    assert.deepEqual(await restoreBackupImages(root, channel, input, mapping), { restored: 2, existing: 0, failed: 0 });
    const result = await collectBackupImages(root, snapshot(channel, [
      { key: 'old', originalId: 101, message: { ...record(1).message, type: 1, parts: [{ type: 1 }, { type: 4 }, { type: 2 }] } },
      { key: 'legacy', originalId: 102, message: record(1).message },
    ]));
    assert.deepEqual(result.images, input);
    assert.deepEqual(await restoreBackupImages(root, channel, input.map(image => ({ ...image, dataUrl: png })), mapping), { restored: 0, existing: 2, failed: 0 });
    assert.deepEqual(await restoreBackupImages(root, channel, [input[0], { messageKey: 'old', partIndex: '../99', dataUrl: png },
      { messageKey: 'old', dataUrl: 'data:image/png;base64,PHNjcmlwdD4=' }], []), { restored: 0, existing: 0, failed: 3 });
  });
}

test('failed paired cache creation rolls back only this attempt and a later restore can succeed', async t => {
  const root = setup(t), images = [{ messageKey: 'key', dataUrl: png }], mapping = [{ key: 'key', id: 7, inserted: true }];
  const open = fs.promises.open;
  fs.promises.open = async (target, ...args) => {
    if (String(target).endsWith('/7.png.url.json')) throw Object.assign(new Error('simulated open failure'), { code: 'EACCES' });
    return open.call(fs.promises, target, ...args);
  };
  try { assert.deepEqual(await restoreBackupImages(root, 'wechat', images, mapping), { restored: 0, existing: 0, failed: 1 }); }
  finally { fs.promises.open = open; }
  assert.ok(!fs.existsSync(path.join(root, 'images/7.png')));
  assert.ok(!fs.existsSync(path.join(root, 'images/7.png.url.json')));
  assert.deepEqual(await restoreBackupImages(root, 'wechat', images, mapping), { restored: 1, existing: 0, failed: 0 });
});

test('failed restore never removes a replacement inode or a pre-existing cache', async t => {
  const root = setup(t), original = file(root, 'images/4.png', 'existing');
  const input = [{ messageKey: 'existing', dataUrl: png }, { messageKey: 'new', dataUrl: png }];
  const mapping = [{ key: 'existing', id: 4, inserted: false }, { key: 'new', id: 5, inserted: true }];
  const open = fs.promises.open, target = path.join(root, 'images/5.png');
  fs.promises.open = async (name, ...args) => {
    if (String(name).endsWith('/5.png.url.json')) {
      fs.renameSync(target, path.join(root, 'owned-uncommitted'));
      fs.writeFileSync(target, 'replacement');
      throw Object.assign(new Error('simulated race'), { code: 'EACCES' });
    }
    return open.call(fs.promises, name, ...args);
  };
  try { assert.deepEqual(await restoreBackupImages(root, 'wechat', input, mapping), { restored: 0, existing: 1, failed: 1 }); }
  finally { fs.promises.open = open; }
  assert.equal(fs.readFileSync(original, 'utf8'), 'existing');
  assert.equal(fs.readFileSync(target, 'utf8'), 'replacement');
});

test('storage usage reads only metadata, counts shared areas and never follows links', async t => {
  const root = setup(t);
  for (const [name, count] of [['vschat_chats.db', 11], ['vschat_chats.db.bak', 13], ['images/1.png', 17],
    ['file-drafts/active.bin', 19], ['temp/draft.png', 23], ['cache-quarantine/run/images/2.png', 29],
    ['credentials.json', 31], ['vschat_qq_chats.db', 37]]) file(root, name, Buffer.alloc(count));
  fs.symlinkSync(path.join(root, 'credentials.json'), path.join(root, 'images/link'));
  const read = fs.promises.readFile; fs.promises.readFile = async () => { throw new Error('contents must never be read'); };
  try { assert.deepEqual(await getStorageUsage(root, 'wechat'), {
    databaseBytes: 24, cacheBytes: 17, draftBytes: 19, temporaryBytes: 23,
    quarantineBytes: 29, otherBytes: 68, totalBytes: 180, fileCount: 8,
  }); } finally { fs.promises.readFile = read; }
});

for (const channel of ['wechat', 'qq']) {
  test(`${channel} cleanup only quarantines old unreferenced recognized caches and preserves disk bytes`, async t => {
    const root = setup(t), directory = channel === 'wechat' ? 'images' : 'qq-images';
    cache(root, channel, '1', png, true); cache(root, channel, '2.part-1', png, true);
    cache(root, channel, '900', png, true); cache(root, channel, '901', png, false);
    file(root, `${directory}/unknown.json`, 'unknown', true); file(root, 'file-drafts/active.bin', 'active', true);
    const linkedName = channel === 'wechat' ? '902.png' : '902.json';
    fs.symlinkSync(path.join(root, 'file-drafts/active.bin'), path.join(root, directory, linkedName));
    const snap = snapshot(channel, [record(1), record(2, { type: 1, parts: [{ type: 1 }, { type: 2 }] })]);
    const before = await getStorageUsage(root, channel), plan = await previewCacheCleanup(root, snap, now);
    assert.equal(plan.count, channel === 'wechat' ? 2 : 1);
    assert.ok(fs.existsSync(path.join(root, directory, channel === 'wechat' ? '900.png' : '900.json')), 'preview does not move files');
    const result = await executeCacheCleanup(root, snap, plan);
    assert.deepEqual(result, { moved: plan.count, skipped: 0, failed: 0, bytes: plan.bytes });
    const quarantined = walk(path.join(root, 'cache-quarantine'));
    assert.equal(quarantined.length, plan.count); assert.ok(quarantined.every(name => name.includes('900.')));
    assert.equal((await getStorageUsage(root, channel)).totalBytes, before.totalBytes, 'quarantine is not disk cleanup');
    assert.ok(fs.existsSync(path.join(root, directory, 'unknown.json'))); assert.equal(fs.readFileSync(path.join(root, 'file-drafts/active.bin'), 'utf8'), 'active');
    await assert.rejects(executeCacheCleanup(root, snap, plan), /失效/);
  });
}

test('cleanup rejects forged plans and skips changed files, new references and changed generations', async t => {
  const root = setup(t), snap = snapshot('qq');
  cache(root, 'qq', '1', png, true); cache(root, 'qq', '2', png, true);
  const plan = await previewCacheCleanup(root, snap, now);
  await assert.rejects(executeCacheCleanup(root, snap, { ...plan }), /失效/);
  fs.appendFileSync(path.join(root, 'qq-images/1.json'), ' ');
  assert.deepEqual(await executeCacheCleanup(root, snapshot('qq', [record(2)]), plan), { moved: 0, skipped: 2, failed: 0, bytes: 0 });
  const generationPlan = await previewCacheCleanup(root, snap, now);
  assert.deepEqual(await executeCacheCleanup(root, snapshot('qq', [], { generation: 'different' }), generationPlan), { moved: 0, skipped: generationPlan.count, failed: 0, bytes: 0 });
});

test('WeChat paired files stay together when either partner changes or a new sidecar appears', async t => {
  const root = setup(t), snap = snapshot('wechat');
  cache(root, 'wechat', '1', png, true); file(root, 'images/2.png', Buffer.from('old'), true);
  const plan = await previewCacheCleanup(root, snap, now);
  fs.appendFileSync(path.join(root, 'images/1.png.url.json'), ' ');
  file(root, 'images/2.png.url.json', JSON.stringify({ dataUrl: png }));
  assert.deepEqual(await executeCacheCleanup(root, snap, plan), { moved: 0, skipped: 3, failed: 0, bytes: 0 });
  assert.ok(fs.existsSync(path.join(root, 'images/1.png'))); assert.ok(fs.existsSync(path.join(root, 'images/2.png')));
});

test('media locks serialize operations and release after errors without taking any database lock', async t => {
  const root = setup(t), order = [];
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const first = withMediaLock(root, 'wechat', async () => { order.push('first'); entered(); await gate; throw new Error('expected'); });
  const rejected = assert.rejects(first, /expected/);
  await started;
  const second = withMediaLock(root, 'wechat', async () => { order.push('second'); });
  await withMediaLock(root, 'qq', async () => { order.push('other-channel'); });
  assert.deepEqual(order, ['first', 'other-channel']);
  release(); await rejected; await second;
  assert.deepEqual(order, ['first', 'other-channel', 'second']);
  assert.ok(!fs.existsSync(path.join(root, '.media-wechat.lock')));
});

test('failed sidecar writes roll back both newly created files so the same backup can be retried', async t => {
  const root = setup(t), images = [{ messageKey: 'key', dataUrl: png }], mapping = [{ key: 'key', id: 8, inserted: true }];
  const open = fs.promises.open;
  fs.promises.open = async (target, ...args) => {
    const handle = await open.call(fs.promises, target, ...args);
    if (String(target).endsWith('/8.png.url.json')) handle.writeFile = async () => { throw new Error('simulated disk failure'); };
    return handle;
  };
  try { assert.deepEqual(await restoreBackupImages(root, 'wechat', images, mapping), { restored: 0, existing: 0, failed: 1 }); }
  finally { fs.promises.open = open; }
  assert.ok(!fs.existsSync(path.join(root, 'images/8.png')));
  assert.ok(!fs.existsSync(path.join(root, 'images/8.png.url.json')));
  assert.deepEqual(await restoreBackupImages(root, 'wechat', images, mapping), { restored: 1, existing: 0, failed: 0 });
});

test('symlink cache directories cannot be backed up, restored into or quarantined', async t => {
  const root = setup(t), outside = setup(t);
  cache(outside, 'qq', '9', png, true);
  fs.symlinkSync(path.join(outside, 'qq-images'), path.join(root, 'qq-images'));
  const snap = snapshot('qq', [record(9)]);
  await assert.rejects(collectBackupImages(root, snap), /符号链接/);
  await assert.rejects(previewCacheCleanup(root, snapshot('qq')), /符号链接/);
  assert.deepEqual(await restoreBackupImages(root, 'qq', [{ messageKey: 'key-9', dataUrl: png }], [{ key: 'key-9', id: 9, inserted: false }]),
    { restored: 0, existing: 0, failed: 1 });
  assert.equal(fs.readFileSync(path.join(outside, 'qq-images/9.json'), 'utf8'), JSON.stringify({ dataUrl: png }));
});

test('quarantine failures are reported and never fall back to deleting the source', async t => {
  const root = setup(t), snap = snapshot('qq');
  const first = cache(root, 'qq', '1', png, true); cache(root, 'qq', '2', png, true);
  const plan = await previewCacheCleanup(root, snap, now);
  const rename = fs.promises.rename, unlink = fs.promises.unlink;
  fs.promises.rename = async (source, destination) => {
    if (source === first) throw new Error('simulated quarantine failure');
    return rename.call(fs.promises, source, destination);
  };
  fs.promises.unlink = async () => { throw new Error('permanent deletion must not be used'); };
  try {
    const result = await executeCacheCleanup(root, snap, plan);
    assert.equal(result.moved, 1); assert.equal(result.failed, 1); assert.equal(result.skipped, 0);
    assert.ok(fs.existsSync(first));
    assert.equal(walk(path.join(root, 'cache-quarantine')).length, 1);
  } finally { fs.promises.rename = rename; fs.promises.unlink = unlink; }
});

test('backup image aggregate budget reports skipped images instead of silently exceeding 64 MiB', async t => {
  const root = setup(t), bytes = Buffer.alloc(MAX_CACHED_IMAGE_BYTES);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
  const rows = [];
  for (let id = 1; id <= 5; id++) { cache(root, 'qq', String(id), dataUrl); rows.push(record(id)); }
  const result = await collectBackupImages(root, snapshot('qq', rows));
  assert.equal(result.images.length, 4); assert.equal(result.skipped, 1); assert.equal(result.missing, 0);
  assert.ok(result.images.reduce((count, image) => count + Buffer.byteLength(image.dataUrl), 0) <= 64 * 1024 * 1024);
});

for (const [channel, Client] of [
  ['wechat', require('../src/wx-client.ts').WxClient],
  ['qq', require('../src/qq-bot-client.ts').QqBotClient],
]) {
  test(`${channel} persist releases media lock before requesting database readiness`, async t => {
    const root = setup(t); let marked = 0;
    const client = new Client({ globalStorageUri: { fsPath: root } }, {
      async markMessageMediaReady() {
        assert.equal(fs.existsSync(path.join(root, `.media-${channel}.lock`)), false, 'DB callback runs after media lock release');
        await withMediaLock(root, channel, async () => { marked++; });
      },
    });
    t.after(() => client.dispose());
    await client.persistImage(1, png);
    assert.equal(marked, 1);
  });
}
