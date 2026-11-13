const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatDB, vscode, resetVSCodeMocks } = require('./runtime.cjs');
const { ArchiveActions } = require('../src/archive-actions.ts');

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function setup(t) {
  resetVSCodeMocks();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-archive-lifecycle-'));
  const storage = path.join(directory, 'storage');
  fs.mkdirSync(storage);
  const context = { globalStorageUri: vscode.Uri.file(storage) };
  const db = new ChatDB(context, 'qq');
  await db.init();
  const posted = [];
  let changed = 0, sequence = 0;
  const actions = new ArchiveActions(context, db, 'qq', value => posted.push(value), async () => { changed++; });
  const backupPath = path.join(directory, 'backup.json');
  fs.writeFileSync(backupPath, JSON.stringify({
    format: 'vschat-backup', version: 1, channel: 'qq', createdAt: '2026-11-12T00:00:00.000Z', images: [],
    records: [{ key: 'lifecycle-record', originalId: 100, message: {
      direction: 'received', type: 1, content: 'restored lifecycle message', timestamp: 1700000000,
      from_user_id: 'peer', to_user_id: 'bot', message_id: 'lifecycle-message',
    } }],
  }));
  const cache = path.join(storage, 'qq-images');
  fs.mkdirSync(cache);
  const orphan = path.join(cache, '900.json');
  fs.writeFileSync(orphan, JSON.stringify({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }));
  const old = new Date(Date.now() - 30 * 86400000);
  fs.utimesSync(orphan, old, old);
  t.after(async () => {
    actions.dispose();
    await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const ui = {
    actions, db, posted, backupPath, orphan, storage,
    get changed() { return changed; },
    async send(command, fields = {}) {
      const requestId = fields.requestId || `lifecycle-${++sequence}`;
      await actions.handle({ command, ...fields, requestId });
      return posted.filter(item => item.requestId === requestId).at(-1);
    },
    async restorePreview() {
      vscode.window.nextOpenDialogResult = [vscode.Uri.file(backupPath)];
      const result = await ui.send('dataRestorePreview');
      assert.equal(result?.error, undefined);
      assert.equal(typeof result?.previewId, 'string');
      return result;
    },
  };
  return ui;
}

function pauseRestore(ui, stage) {
  const entered = deferred(), release = deferred();
  if (stage === 'dialog') {
    vscode.window.nextOpenDialogResult = async () => {
      entered.resolve(); await release.promise;
      return [vscode.Uri.file(ui.backupPath)];
    };
  } else {
    vscode.window.nextOpenDialogResult = [vscode.Uri.file(ui.backupPath)];
    const owner = stage === 'read' ? ui.actions : ui.db;
    const method = stage === 'read' ? 'readBounded' : 'previewRestore';
    const original = owner[method];
    owner[method] = async function (...args) {
      const value = await original.apply(this, args);
      entered.resolve(); await release.promise;
      return value;
    };
  }
  return { entered, release };
}

function pauseCleanup(ui) {
  const entered = deferred(), release = deferred();
  const original = ui.db.withHistorySnapshot;
  ui.db.withHistorySnapshot = function (callback) {
    return original.call(this, async snapshot => {
      const value = await callback(snapshot);
      entered.resolve(); await release.promise;
      return value;
    });
  };
  return { entered, release };
}

test('invalidating issued restore and cleanup previews rejects both confirmations without changing history or cache', async t => {
  const ui = await setup(t);
  const restore = await ui.restorePreview();
  const cleanup = await ui.send('dataCleanupPreview');
  assert.equal(cleanup?.data.count, 1);
  assert.equal(typeof cleanup?.previewId, 'string');
  const stamp = await ui.db.getChangeStamp(), cache = fs.readFileSync(ui.orphan);
  ui.actions.invalidatePreviews();
  for (const [command, preview] of [['dataRestorePreview', restore], ['dataCleanupPreview', cleanup]]) {
    const replay = await ui.send(command, { requestId: preview.requestId });
    assert.equal(replay?.cancelled, true);
    assert.equal(replay?.previewId, undefined, 'a repeated request must not redisplay its invalidated token');
    assert.equal(replay?.generation, undefined);
  }
  const restoreResult = await ui.send('dataRestoreConfirm', { previewId: restore.previewId });
  const cleanupResult = await ui.send('dataCleanupConfirm', { previewId: cleanup.previewId });
  assert.ok(restoreResult?.error);
  assert.ok(cleanupResult?.error);
  assert.equal(restoreResult?.data, undefined);
  assert.equal(cleanupResult?.data, undefined);
  assert.deepEqual(await ui.db.getRecentMessages(), []);
  assert.deepEqual(fs.readFileSync(ui.orphan), cache);
  assert.equal(fs.existsSync(path.join(ui.storage, 'cache-quarantine')), false);
  assert.equal(await ui.db.getChangeStamp(), stamp);
  assert.equal(ui.changed, 0);
  assert.notEqual((await ui.restorePreview()).previewId, restore.previewId, 'a fresh preview remains possible after invalidation');
});

for (const stage of ['dialog', 'read', 'plan']) {
  test(`restore preview invalidated during ${stage} returns cancellation without a late token`, async t => {
    const ui = await setup(t), gate = pauseRestore(ui, stage);
    const pending = ui.send('dataRestorePreview', { requestId: `pending-${stage}` });
    await gate.entered.promise;
    try { ui.actions.invalidatePreviews(); }
    finally { gate.release.resolve(); }
    const result = await pending;
    assert.equal(result?.cancelled, true);
    assert.equal(result?.previewId, undefined);
    assert.equal(result?.generation, undefined);
    assert.equal(result?.error, undefined);
    assert.equal(ui.posted.some(item => item.previewId), false);
    assert.deepEqual(await ui.db.getRecentMessages(), []);
    assert.equal(ui.changed, 0);
  });
}

test('cleanup preview invalidated while its snapshot callback is pending returns no token and never moves files', async t => {
  const ui = await setup(t), gate = pauseCleanup(ui);
  const bytes = fs.readFileSync(ui.orphan);
  const pending = ui.send('dataCleanupPreview');
  await gate.entered.promise;
  try { ui.actions.invalidatePreviews(); }
  finally { gate.release.resolve(); }
  const result = await pending;
  assert.equal(result?.cancelled, true);
  assert.equal(result?.previewId, undefined);
  assert.equal(result?.generation, undefined);
  assert.equal(result?.error, undefined);
  assert.equal(ui.posted.some(item => item.previewId), false);
  assert.deepEqual(fs.readFileSync(ui.orphan), bytes);
  assert.equal(fs.existsSync(path.join(ui.storage, 'cache-quarantine')), false);
});

for (const kind of ['restore', 'cleanup']) {
  test(`disposing during a pending ${kind} preview suppresses its late response and confirmation`, async t => {
    const ui = await setup(t);
    const gate = kind === 'restore' ? pauseRestore(ui, 'plan') : pauseCleanup(ui);
    const pending = ui.send(kind === 'restore' ? 'dataRestorePreview' : 'dataCleanupPreview');
    await gate.entered.promise;
    try { ui.actions.dispose(); }
    finally { gate.release.resolve(); }
    assert.equal(await pending, undefined);
    assert.deepEqual(ui.posted, []);
    await ui.send(kind === 'restore' ? 'dataRestoreConfirm' : 'dataCleanupConfirm', { previewId: 'late-token' });
    assert.deepEqual(ui.posted, []);
    assert.deepEqual(await ui.db.getRecentMessages(), []);
    assert.equal(fs.existsSync(ui.orphan), true);
    assert.equal(ui.changed, 0);
  });
}

test('invalidating previews after confirmation starts does not cancel the already-authorized append', async t => {
  const ui = await setup(t);
  const preview = await ui.restorePreview();
  const entered = deferred(), release = deferred();
  const append = ui.db.appendRestore;
  let calls = 0;
  ui.db.appendRestore = async function (...args) {
    calls++; entered.resolve(); await release.promise;
    return append.apply(this, args);
  };
  const pending = ui.send('dataRestoreConfirm', { previewId: preview.previewId });
  await entered.promise;
  try { ui.actions.invalidatePreviews(); }
  finally { release.resolve(); }
  const result = await pending;
  assert.equal(result?.error, undefined);
  assert.equal(result?.cancelled, undefined);
  assert.equal(result?.data.inserted, 1);
  assert.equal(ui.changed, 1);
  const history = await ui.db.getRecentMessages();
  assert.equal(history.length, 1);
  assert.equal(history[0].message_id, 'lifecycle-message');
  assert.equal(history[0].restored, true);
  const repeated = await ui.send('dataRestoreConfirm', { previewId: preview.previewId });
  assert.ok(repeated?.error);
  assert.equal(calls, 1);
});
