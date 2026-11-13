const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ChatDB, message, vscode, openDialogs, saveDialogs, notifications, outputLines, resetVSCodeMocks,
} = require('./runtime.cjs');
const { ChatViewProvider } = require('../src/chat-view-provider.ts');

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6vSIAAAAASUVORK5CYII=';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const record = (key, overrides = {}) => ({
  key, originalId: 100,
  message: { direction: 'received', type: 1, content: `private content ${key}`, timestamp: 1_700_000_000,
    from_user_id: 'archive-user', to_user_id: 'archive-bot', ...overrides },
});
const backup = (records, images = [], overrides = {}) => ({
  format: 'vschat-backup', version: 1, channel: 'wechat', createdAt: '2026-11-12T00:00:00.000Z', records, images, ...overrides,
});

async function setup(t, { channel = 'WeChat' } = {}) {
  resetVSCodeMocks();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-archive-provider-'));
  const storage = path.join(directory, 'storage');
  fs.mkdirSync(storage);
  const context = { globalStorageUri: vscode.Uri.file(storage), extensionUri: vscode.Uri.file(path.resolve(__dirname, '..')) };
  const db = new ChatDB(context, channel === 'QQ' ? 'qq' : 'wechat');
  await db.init();
  const events = Array.from({ length: 4 }, () => new vscode.EventEmitter());
  const client = {
    channelName: channel, connected: false,
    onMessage: events[0].event, onStatus: events[1].event, onQrCode: events[2].event, onLoginSuccess: events[3].event,
    async getDecryptedImageUrl() {},
    async sendText() { assert.fail('archive tests must not send chat messages'); },
    async sendImage() { assert.fail('archive tests must not send images'); },
  };
  const provider = new ChatViewProvider(context, client, db);
  const posted = [];
  let inbound, currentDisposed;
  function attach() {
    inbound = new vscode.EventEmitter();
    const visibility = new vscode.EventEmitter(), disposed = new vscode.EventEmitter();
    currentDisposed = disposed;
    provider.resolveWebviewView({
      visible: false, show() {}, onDidChangeVisibility: visibility.event, onDidDispose: disposed.event,
      webview: { cspSource: 'vscode-webview:', asWebviewUri: value => value.toString(), onDidReceiveMessage: inbound.event,
        postMessage(value) { posted.push(value); return Promise.resolve(true); } },
    }, {}, {});
  }
  attach();
  await provider.start();
  await inbound.fire({ command: 'ready' });
  t.after(async () => {
    provider.dispose();
    await provider.historyPending;
    await db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let sequence = 0;
  const ui = {
    provider, db, directory, storage, posted, attach,
    disposeView: () => currentDisposed.fire(),
    result: requestId => posted.filter(value => value.command === 'dataResult' && value.requestId === requestId).at(-1),
    async send(command, fields = {}) {
      const requestId = fields.requestId || `archive-${++sequence}`;
      await inbound.fire({ command, ...fields, requestId });
      return ui.result(requestId);
    },
    createBackup(value, name = `backup-${++sequence}.json`) {
      const file = path.join(directory, name);
      fs.writeFileSync(file, JSON.stringify(value));
      return file;
    },
    async preview(value) {
      const file = typeof value === 'string' ? value : ui.createBackup(value);
      vscode.window.nextOpenDialogResult = [vscode.Uri.file(file)];
      const result = await ui.send('dataRestorePreview');
      assert.equal(result?.error, undefined);
      assert.equal(typeof result?.previewId, 'string');
      return { ...result, file };
    },
  };
  return ui;
}

test('history exports use the native destination and date filter without exposing session secrets', async t => {
  const ui = await setup(t);
  await ui.db.insertMessage({ ...message('earlier'), content: 'excluded earlier text', timestamp: 100 });
  await ui.db.insertMessage({ ...message('included'), content: 'included export text', timestamp: 200,
    context_token: 'SECRET-CONTEXT-TOKEN' });
  await ui.db.setMetadata('context_token', 'SECRET-ROUTING-TOKEN');
  await ui.db.setMetadata('from_user_id', 'current-route');
  for (const format of ['json', 'markdown']) {
    const destination = path.join(ui.directory, `export.${format === 'json' ? 'json' : 'md'}`);
    vscode.window.nextSaveDialogResult = vscode.Uri.file(destination);
    const result = await ui.send('dataExport', { format, fromTimestamp: 150, toTimestamp: 250, path: '/ignored/webview-path' });
    assert.equal(result?.error, undefined);
    assert.equal(result?.data.messageCount, 1);
    const contents = fs.readFileSync(destination, 'utf8');
    assert.match(contents, /included export text/);
    assert.doesNotMatch(contents, /excluded earlier text|SECRET-CONTEXT|SECRET-ROUTING/);
    if (format === 'json') assert.doesNotThrow(() => JSON.parse(contents));
  }
  assert.equal(saveDialogs.length, 2);
  assert.equal(outputLines.some(line => /included export text|SECRET-CONTEXT|SECRET-ROUTING/.test(line)), false);
});

test('export cancellation and unsupported or protected destinations never overwrite files', async t => {
  const ui = await setup(t);
  await ui.db.insertMessage(message('original'));
  assert.equal((await ui.send('dataExport', { format: 'json' }))?.cancelled, true);
  const existing = path.join(ui.directory, 'existing.json');
  fs.writeFileSync(existing, 'keep existing bytes');
  const link = path.join(ui.directory, 'link.json');
  fs.symlinkSync(existing, link);
  const blockedInternal = path.join(ui.storage, 'new-archive.json');
  for (const destination of [vscode.Uri.file(existing), vscode.Uri.file(link), vscode.Uri.file(blockedInternal),
    vscode.Uri.parse('vscode-remote://ssh-remote+test/tmp/archive.json')]) {
    vscode.window.nextSaveDialogResult = destination;
    const result = await ui.send('dataBackup', { includeImages: false });
    assert.ok(result?.error);
  }
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep existing bytes');
  assert.equal(fs.existsSync(blockedInternal), false);
  assert.equal((await ui.db.getRecentMessages()).length, 1);
});

test('restore preview retains immutable bytes, preserves repeated no-ID rows, and never changes live routing or unread state', async t => {
  const ui = await setup(t);
  await ui.db.insertMessage({ ...message('live-unread'), direction: 'received' });
  await ui.db.setMetadata('context_token', 'live-route-token');
  await ui.db.setMetadata('from_user_id', 'live-peer');
  await ui.db.setMetadata('to_user_id', 'live-self');
  const before = await ui.db.getSyncSnapshot();
  await ui.provider.refreshSharedHistory(true);
  notifications.length = 0;
  const repeated = { content: 'same historical message', timestamp: 100 };
  const preview = await ui.preview(backup([record('archive:one', repeated), { ...record('archive:two', repeated), originalId: 101 }]));
  assert.equal(preview.data.messageCount, 2);
  assert.equal(preview.data.newCount, 2);
  const previewWire = JSON.stringify(preview);
  assert.doesNotMatch(previewWire, /same historical message|archive-user|archive-bot/);
  fs.writeFileSync(preview.file, JSON.stringify(backup([record('archive:replacement', { content: 'replacement after preview' })])));
  const result = await ui.send('dataRestoreConfirm', { previewId: preview.previewId, records: [], filePath: preview.file, requestId: 'confirm-once' });
  assert.equal(result?.error, undefined);
  assert.equal(result?.data.inserted, 2);
  const rows = await ui.db.getRecentMessages();
  assert.equal(rows.filter(row => row.content === repeated.content).length, 2);
  assert.equal(rows.some(row => row.content === 'replacement after preview'), false);
  const after = await ui.db.getSyncSnapshot();
  assert.equal(after.unreadCount, before.unreadCount);
  assert.equal(after.readThroughId, before.readThroughId);
  assert.equal(await ui.db.getMetadata('context_token'), 'live-route-token');
  assert.equal(await ui.db.getMetadata('from_user_id'), 'live-peer');
  assert.equal(await ui.db.getMetadata('to_user_id'), 'live-self');
  assert.equal(rows.filter(row => row.restored).length, 2);
  await ui.send('dataRestoreConfirm', { previewId: preview.previewId, requestId: 'confirm-once' });
  assert.equal((await ui.db.getRecentMessages()).length, 3, 'replaying the same request must not import twice');
  const reused = await ui.send('dataRestoreConfirm', { previewId: preview.previewId });
  assert.ok(reused?.error, 'a consumed preview cannot authorize a different mutation request');
  await ui.provider.refreshSharedHistory(true);
  assert.equal(notifications.length, 0, 'restored history is not a new inbound notification');
});

test('invalid, cross-channel, oversized, and nonregular backups are rejected before a restore token is issued', async t => {
  const ui = await setup(t);
  const files = [
    ui.createBackup(backup([record('archive:wrong-channel')], [], { channel: 'qq' })),
    ui.createBackup(backup([record('archive:future')], [], { version: 999 })),
    ui.createBackup({ ...backup([record('archive:extra')]), metadata: { context_token: 'must-not-import' } }),
    ui.createBackup(backup([record('archive:bad-type', { type: 900 })])),
    ui.createBackup(backup([record('archive:bad-image', { type: 2 })], [{ messageKey: 'archive:bad-image', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }])),
  ];
  const huge = path.join(ui.directory, 'oversized.json');
  fs.writeFileSync(huge, '');
  fs.truncateSync(huge, 64 * 1024 * 1024 + 1);
  const symlink = path.join(ui.directory, 'backup-link.json');
  fs.symlinkSync(files[0], symlink);
  files.push(huge, symlink, ui.directory);
  for (const file of files) {
    vscode.window.nextOpenDialogResult = [vscode.Uri.file(file)];
    const result = await ui.send('dataRestorePreview');
    assert.ok(result?.error, `invalid backup rejected: ${path.basename(file)}`);
    assert.equal(result?.previewId, undefined);
  }
  assert.equal((await ui.db.getRecentMessages()).length, 0);
  assert.equal(await ui.db.getMetadata('context_token'), null);
});

test('history clear and preview dismissal invalidate confirmation without appending any records', async t => {
  const ui = await setup(t);
  const preview = await ui.preview(backup([record('archive:stale')]));
  await ui.db.clearAll();
  const stale = await ui.send('dataRestoreConfirm', { previewId: preview.previewId });
  assert.ok(stale?.error);
  assert.equal((await ui.db.getRecentMessages()).length, 0);
  const dismissed = await ui.preview(backup([record('archive:dismissed')]));
  await ui.send('dataDismissPreview', { previewId: dismissed.previewId });
  const result = await ui.send('dataRestoreConfirm', { previewId: dismissed.previewId });
  assert.ok(result?.error);
  assert.equal((await ui.db.getRecentMessages()).length, 0);
});

for (const disposeFirst of [true, false]) {
  test(`restore preview cannot authorize a write after ${disposeFirst ? 'view disposal and recreation' : 'direct view replacement'}`, async t => {
    const ui = await setup(t);
    await ui.db.insertMessage(message('existing-history'));
    const before = await ui.db.getRecentMessages(), stamp = await ui.db.getChangeStamp();
    const preview = await ui.preview(backup([record('archive:previous-view')]));
    if (disposeFirst) await ui.disposeView();
    ui.attach();
    await ui.send('ready');
    const stale = await ui.send('dataRestoreConfirm', { previewId: preview.previewId });
    assert.match(stale?.error || '', /预览已失效/);
    assert.equal(stale?.data, undefined);
    assert.deepEqual(await ui.db.getRecentMessages(), before);
    assert.equal(await ui.db.getChangeStamp(), stamp);
    const replay = await ui.send('dataRestorePreview', { requestId: preview.requestId });
    assert.equal(replay?.cancelled, true);
    assert.equal(replay?.previewId, undefined);
    assert.equal(openDialogs.length, 1, 'replaying the old request cannot open another native dialog');
  });
}

test('an active native dialog blocks overlapping work and request replay cannot reopen it', async t => {
  const ui = await setup(t);
  const selecting = deferred(), selected = deferred();
  const file = ui.createBackup(backup([record('archive:only-preview')]));
  vscode.window.nextOpenDialogResult = () => { selecting.resolve(); return selected.promise; };
  const pending = ui.send('dataRestorePreview', { requestId: 'pending-dialog' });
  await selecting.promise;
  const other = await ui.send('dataBackup', { requestId: 'overlapping-export', includeImages: false });
  assert.ok(other?.error);
  await ui.send('dataRestorePreview', { requestId: 'pending-dialog' });
  assert.equal(openDialogs.length, 1);
  assert.equal(saveDialogs.length, 0);
  selected.resolve([vscode.Uri.file(file)]);
  const result = await pending;
  assert.equal(typeof result?.previewId, 'string');
  await ui.send('dataRestorePreview', { requestId: 'pending-dialog' });
  assert.equal(openDialogs.length, 1);
  assert.equal((await ui.db.getRecentMessages()).length, 0);
});

test('portable image backup reads only local cache and omits session and runtime fields', async t => {
  const ui = await setup(t);
  const id = await ui.db.insertMessage({ ...message('cached-image'), type: 2, content: '[Image]', context_token: 'PRIVATE-TOKEN' });
  fs.mkdirSync(path.join(ui.storage, 'images'));
  fs.writeFileSync(path.join(ui.storage, 'images', `${id}.png`), Buffer.from(png.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(ui.storage, 'images', `${id}.png.url.json`), JSON.stringify({ dataUrl: png }));
  const destination = path.join(ui.directory, 'portable.json');
  vscode.window.nextSaveDialogResult = vscode.Uri.file(destination);
  const result = await ui.send('dataBackup', { includeImages: true });
  assert.equal(result?.error, undefined);
  assert.equal(result?.data.imageCount, 1);
  const saved = JSON.parse(fs.readFileSync(destination, 'utf8'));
  assert.equal(saved.images[0].dataUrl, png);
  assert.equal(saved.records[0].message.context_token, undefined);
  assert.equal(saved.records[0].message.imageDataUrl, undefined);
  assert.equal(JSON.stringify(result).includes(png), false);
});

test('restored images map to new local IDs without replacing existing cache files', async t => {
  const ui = await setup(t);
  const existingId = await ui.db.insertMessage({ ...message('existing-image'), type: 2, content: '[Image]' });
  const directory = path.join(ui.storage, 'images');
  fs.mkdirSync(directory);
  const existing = path.join(directory, `${existingId}.png.url.json`);
  fs.writeFileSync(existing, 'existing cache bytes');
  const preview = await ui.preview(backup([{ ...record('archive:image', { type: 2, content: '[Image]' }), originalId: existingId }],
    [{ messageKey: 'archive:image', dataUrl: png }]));
  const result = await ui.send('dataRestoreConfirm', { previewId: preview.previewId });
  assert.equal(result?.error, undefined);
  assert.equal(result?.data.inserted, 1);
  assert.equal(result?.data.imagesRestored, 1);
  const imported = (await ui.db.getRecentMessages()).find(row => row.restored);
  assert.notEqual(imported.id, existingId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, `${imported.id}.png.url.json`), 'utf8')).dataUrl, png);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'existing cache bytes');

  const occupied = path.join(directory, `${imported.id + 1}.png.url.json`);
  const occupiedBytes = JSON.stringify({ dataUrl: png, note: 'retain previously occupied target' });
  fs.writeFileSync(occupied, occupiedBytes);
  fs.writeFileSync(path.join(directory, `${imported.id + 1}.png`), Buffer.from(png.split(',')[1], 'base64'));
  const another = await ui.preview(backup([record('archive:occupied-image', { type: 2, content: '[Image]' })],
    [{ messageKey: 'archive:occupied-image', dataUrl: png }]));
  const occupiedResult = await ui.send('dataRestoreConfirm', { previewId: another.previewId });
  assert.equal(occupiedResult?.data.inserted, 1);
  assert.equal(occupiedResult?.data.imagesExisting, 1);
  assert.equal(occupiedResult?.data.imagesRestored, 0);
  assert.equal(fs.readFileSync(occupied, 'utf8'), occupiedBytes);
});

test('cache restore failure is reported as partial success after safe history append', async t => {
  const ui = await setup(t);
  const preview = await ui.preview(backup([record('archive:cache-failure', { type: 2, content: '[Image]' })],
    [{ messageKey: 'archive:cache-failure', dataUrl: png }]));
  fs.writeFileSync(path.join(ui.storage, 'images'), 'keep blocking path');
  const result = await ui.send('dataRestoreConfirm', { previewId: preview.previewId });
  assert.equal(result?.error, undefined);
  assert.equal(result?.data.inserted, 1);
  assert.equal(result?.data.imagesRestored, 0);
  assert.equal(result?.data.imagesFailed, 1);
  assert.equal((await ui.db.getRecentMessages()).length, 1);
  assert.equal(fs.readFileSync(path.join(ui.storage, 'images'), 'utf8'), 'keep blocking path');
});

test('a refresh failure after commit reports saved history with a pending refresh', async t => {
  const ui = await setup(t);
  const preview = await ui.preview(backup([record('archive:refresh-failure')]));
  const original = ui.provider.refreshSharedHistory;
  ui.provider.refreshSharedHistory = async () => { throw new Error('temporary view refresh failure'); };
  let result;
  try { result = await ui.send('dataRestoreConfirm', { previewId: preview.previewId }); }
  finally { ui.provider.refreshSharedHistory = original; }
  assert.equal(result?.error, undefined);
  assert.equal(result?.data.inserted, 1);
  assert.equal(result?.data.refreshPending, true);
  assert.equal((await ui.db.getRecentMessages()).length, 1);
});

test('storage reports cache usage and confirmed cleanup quarantines only old unreferenced cache files', async t => {
  const ui = await setup(t, { channel: 'QQ' });
  const id = await ui.db.insertMessage({ ...message('retained-image'), type: 2, content: '[Image]' });
  const cache = path.join(ui.storage, 'qq-images');
  fs.mkdirSync(cache);
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const write = (name, contents, aged = true) => {
    const file = path.join(cache, name);
    fs.writeFileSync(file, contents);
    if (aged) fs.utimesSync(file, old, old);
    return file;
  };
  const retained = write(`${id}.json`, JSON.stringify({ dataUrl: png }));
  const orphan = write('900.json', JSON.stringify({ dataUrl: png }));
  const recent = write('901.json', JSON.stringify({ dataUrl: png }), false);
  const unknown = write('unknown-name.json', 'keep unknown cache');
  const credentials = path.join(ui.storage, 'credentials.json');
  fs.writeFileSync(credentials, 'keep credentials');
  const symlink = path.join(cache, '902.json');
  fs.symlinkSync(credentials, symlink);
  const storage = await ui.send('dataStorage');
  assert.equal(storage?.error, undefined);
  assert.ok(storage?.data.cacheBytes > 0);
  assert.ok(storage?.data.databaseBytes > 0);
  const preview = await ui.send('dataCleanupPreview');
  assert.equal(preview?.error, undefined);
  assert.equal(preview?.data.count, 1);
  assert.equal(typeof preview?.previewId, 'string');
  assert.equal(fs.existsSync(orphan), true, 'preview must not move anything');
  assert.equal(JSON.stringify(preview).includes(ui.storage), false, 'only aggregate cleanup metadata crosses into the webview');
  const result = await ui.send('dataCleanupConfirm', { previewId: preview.previewId, files: [credentials] });
  assert.equal(result?.error, undefined);
  assert.equal(result?.data.moved, 1);
  assert.equal(fs.existsSync(orphan), false);
  for (const file of [retained, recent, unknown, symlink, credentials]) assert.equal(fs.existsSync(file), true);
  const quarantine = path.join(ui.storage, 'cache-quarantine');
  const directories = fs.readdirSync(quarantine);
  assert.equal(directories.length, 1);
  const saved = path.join(quarantine, directories[0], 'qq-images', '900.json');
  assert.equal(JSON.parse(fs.readFileSync(saved, 'utf8')).dataUrl, png);
  const after = await ui.send('dataStorage');
  assert.ok(after?.data.quarantineBytes >= result.data.bytes);
  assert.equal(fs.readFileSync(credentials, 'utf8'), 'keep credentials');
  assert.ok((await ui.send('dataCleanupConfirm', { previewId: preview.previewId }))?.error);
});

test('cleanup confirmation rechecks a changed cache file and rejects a stale history generation', async t => {
  const ui = await setup(t, { channel: 'QQ' });
  const cache = path.join(ui.storage, 'qq-images');
  fs.mkdirSync(cache);
  const file = path.join(cache, '900.json');
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  fs.writeFileSync(file, JSON.stringify({ dataUrl: png }));
  fs.utimesSync(file, old, old);
  const preview = await ui.send('dataCleanupPreview');
  assert.equal(preview?.data.count, 1);
  fs.writeFileSync(file, 'fresh replacement after preview');
  const result = await ui.send('dataCleanupConfirm', { previewId: preview.previewId });
  assert.equal(result?.error, undefined);
  assert.equal(result?.data.moved, 0);
  assert.equal(result?.data.skipped, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'fresh replacement after preview');
  fs.utimesSync(file, old, old);
  const next = await ui.send('dataCleanupPreview');
  await ui.db.clearAll();
  const stale = await ui.send('dataCleanupConfirm', { previewId: next.previewId });
  assert.ok(stale?.error);
  assert.equal(fs.existsSync(file), true);
});
