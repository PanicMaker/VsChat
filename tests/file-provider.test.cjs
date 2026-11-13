const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  ChatDB, message, vscode, openDialogs, saveDialogs, workspaceWrites, outputLines, resetVSCodeMocks,
} = require('./runtime.cjs');
const { ChatViewProvider } = require('../src/chat-view-provider.ts');
const { FileSendError, MAX_FILE_BYTES } = require('../src/file-transfer.ts');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const mediaKey = Buffer.alloc(16, 7).toString('base64');
const privateUrl = 'https://novac2c.cdn.weixin.qq.com/c2c/download?token=private-file-url';
const filePart = (channel = 'WeChat') => ({
  type: 4, fileName: 'report.txt', size: 7, url: privateUrl,
  ...(channel === 'WeChat' ? { fileMedia: { aesKey: mediaKey, encryptQueryParam: 'private-file-query' } } : {}),
});

async function setup(t, { channel = 'WeChat', overrides = {} } = {}) {
  resetVSCodeMocks();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-file-provider-'));
  const context = { globalStorageUri: vscode.Uri.file(directory), extensionUri: vscode.Uri.file(path.resolve(__dirname, '..')) };
  const db = new ChatDB(context, channel === 'QQ' ? 'qq' : 'wechat');
  await db.init();
  const sendCalls = [], downloadCalls = [];
  const events = Array.from({ length: 4 }, () => new vscode.EventEmitter());
  const client = {
    channelName: channel, connected: true, fileCapabilities: { canSend: true, maxBytes: MAX_FILE_BYTES },
    onMessage: events[0].event, onStatus: events[1].event, onQrCode: events[2].event, onLoginSuccess: events[3].event,
    async getDecryptedImageUrl() {},
    async sendFile(filePath, originalName) { sendCalls.push({ filePath, originalName, bytes: fs.readFileSync(filePath) }); },
    async downloadFile(part, signal) { downloadCalls.push({ part, signal }); return Buffer.from('payload'); },
    async sendText() { assert.fail('file tests must not send chat text'); },
    async sendImage() { assert.fail('file tests must not send chat images'); },
    ...overrides,
  };
  const provider = new ChatViewProvider(context, client, db);
  const posted = [];
  let inbound;
  function attach() {
    inbound = new vscode.EventEmitter();
    const visibility = new vscode.EventEmitter(), disposed = new vscode.EventEmitter();
    provider.resolveWebviewView({
      visible: true, show() {}, onDidChangeVisibility: visibility.event, onDidDispose: disposed.event,
      webview: {
        cspSource: 'vscode-webview:', asWebviewUri: value => value.toString(), onDidReceiveMessage: inbound.event,
        postMessage(value) { posted.push(value); return Promise.resolve(true); },
      },
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
  return {
    provider, db, directory, client, posted, sendCalls, downloadCalls, attach,
    send: value => inbound.fire(value),
    result: (command, requestId) => posted.filter(value => value.command === command && value.requestId === requestId).at(-1),
    createFile(name = 'original.txt', contents = 'original bytes') {
      const filePath = path.join(directory, name);
      fs.writeFileSync(filePath, contents);
      return filePath;
    },
    async select(filePath, requestId = 'select') {
      vscode.window.nextOpenDialogResult = [vscode.Uri.file(filePath)];
      await inbound.fire({ command: 'selectFile', requestId });
      return posted.find(value => value.command === 'fileSelected' && value.requestId === requestId)?.fileDraft;
    },
    async attachment(parts = [filePart(channel)]) {
      const targetId = await db.insertMessage({ ...message(`attachment-${Date.now()}`), direction: 'received', type: 4, content: 'report.txt', parts });
      const generation = (await db.getSyncSnapshot()).cursor.generation;
      return { command: 'saveAttachment', requestId: 'save', targetId, partIndex: 0, generation };
    },
  };
}

test('native selection creates an opaque immutable snapshot and sends only after an explicit request', async (t) => {
  const ui = await setup(t);
  const original = ui.createFile();
  const draft = await ui.select(original);
  assert.deepEqual(Object.keys(draft).sort(), ['fileId', 'fileName', 'size']);
  assert.equal(draft.fileName, 'original.txt');
  assert.equal(draft.size, Buffer.byteLength('original bytes'));
  assert.notEqual(draft.fileId, original);
  assert.equal(ui.sendCalls.length, 0);
  assert.equal(JSON.stringify(ui.posted).includes(original), false);
  fs.writeFileSync(original, 'changed after selection');
  await ui.send({ command: 'sendFile', requestId: 'send', fileId: draft.fileId, imagePath: '/untrusted/path', fileName: '../../fake' });
  assert.equal(ui.sendCalls.length, 1);
  assert.notEqual(ui.sendCalls[0].filePath, original);
  assert.equal(ui.sendCalls[0].bytes.toString(), 'original bytes');
  assert.equal(ui.sendCalls[0].originalName, 'original.txt');
  assert.equal(ui.result('sendStatus', 'send').sendStatus, 'sent');
  await ui.send({ command: 'getFileDraft', fileId: draft.fileId });
  assert.equal(ui.posted.at(-1).valid, false);
});

test('cancelled selection preserves the existing draft and invalid files never become drafts', async (t) => {
  const ui = await setup(t);
  const draft = await ui.select(ui.createFile());
  await ui.send({ command: 'selectFile', requestId: 'cancelled' });
  assert.equal(ui.result('fileSelected', 'cancelled').cancelled, true);
  await ui.send({ command: 'getFileDraft', fileId: draft.fileId });
  assert.equal(ui.posted.at(-1).valid, true);
  const empty = ui.createFile('empty.txt', '');
  const huge = ui.createFile('huge.bin', '');
  fs.truncateSync(huge, MAX_FILE_BYTES + 1);
  const symbolic = path.join(ui.directory, 'link.txt');
  fs.symlinkSync(empty, symbolic);
  for (const [index, filePath] of [empty, huge, ui.directory, symbolic].entries()) {
    await ui.select(filePath, `invalid-${index}`);
    assert.ok(ui.result('fileSelected', `invalid-${index}`).error);
  }
  assert.equal(ui.sendCalls.length, 0);
  await ui.send({ command: 'getFileDraft', fileId: draft.fileId });
  assert.equal(ui.posted.at(-1).valid, true);
  await ui.send({ command: 'removeFileDraft', fileId: draft.fileId });
  await ui.send({ command: 'getFileDraft', fileId: draft.fileId });
  assert.equal(ui.posted.at(-1).valid, false);
});

test('unsupported channels and forged file tokens cannot open files or reach transport', async (t) => {
  const ui = await setup(t, { channel: 'QQ', overrides: { fileCapabilities: { canSend: false, maxBytes: MAX_FILE_BYTES, reason: '未开放' } } });
  await ui.send({ command: 'selectFile', requestId: 'unsupported', imagePath: ui.createFile() });
  assert.ok(ui.result('fileSelected', 'unsupported').error);
  assert.equal(openDialogs.length, 0);
  ui.client.fileCapabilities.canSend = true;
  await ui.send({ command: 'sendFile', requestId: 'forged', fileId: ui.createFile('must-not-read.txt'), imagePath: '/forged' });
  assert.equal(ui.result('sendStatus', 'forged').sendStatus, 'failed');
  assert.equal(ui.sendCalls.length, 0);
});

test('selecting a FIFO fails promptly without waiting for a writer', { skip: process.platform === 'win32' }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-file-fifo-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fifo = path.join(directory, 'not-a-regular-file');
  execFileSync('mkfifo', [fifo]);
  // Run this regression in a bounded child: without O_NONBLOCK, open() can
  // occupy a libuv thread forever and a test timeout alone cannot release it.
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const { vscode, resetVSCodeMocks } = require('./tests/runtime.cjs');
    const { FileActions } = require('./src/file-actions.ts');
    const { MAX_FILE_BYTES } = require('./src/file-transfer.ts');
    (async () => {
      resetVSCodeMocks();
      const selected = process.argv[1], posted = [];
      vscode.window.nextOpenDialogResult = [vscode.Uri.file(selected)];
      const files = new FileActions(
        { globalStorageUri: vscode.Uri.file(path.dirname(selected)) },
        { channelName: 'WeChat', fileCapabilities: { canSend: true, maxBytes: MAX_FILE_BYTES }, async sendFile() { assert.fail('must not send'); } },
        {}, value => posted.push(value), () => 1,
      );
      await files.select({ command: 'selectFile', requestId: 'fifo' });
      assert.equal(posted.length, 1);
      assert.ok(posted[0].error);
      assert.equal(posted[0].fileDraft, undefined);
      files.dispose();
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `, fifo], { cwd: path.resolve(__dirname, '..'), timeout: 3000, encoding: 'utf8' });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});

test('file sends deduplicate in-flight requests and keep failed or uncertain snapshots for explicit retry', async (t) => {
  const started = deferred(), release = deferred();
  let attempts = 0;
  const ui = await setup(t, { overrides: {
    async sendFile() {
      attempts++;
      if (attempts === 1) { started.resolve(); await release.promise; throw new FileSendError('upload failed before message request'); }
      if (attempts === 2) throw new Error('response lost after message request');
    },
  } });
  const draft = await ui.select(ui.createFile());
  const first = ui.send({ command: 'sendFile', requestId: 'attempt-1', fileId: draft.fileId });
  await started.promise;
  await ui.send({ command: 'sendFile', requestId: 'attempt-1', fileId: draft.fileId });
  assert.equal(attempts, 1);
  assert.equal(ui.result('sendStatus', 'attempt-1').sendStatus, 'sending');
  release.resolve();
  await first;
  assert.equal(ui.result('sendStatus', 'attempt-1').sendStatus, 'failed');
  await ui.send({ command: 'getFileDraft', fileId: draft.fileId });
  assert.equal(ui.posted.at(-1).valid, true);
  await ui.send({ command: 'sendFile', requestId: 'attempt-2', fileId: draft.fileId });
  assert.equal(ui.result('sendStatus', 'attempt-2').sendStatus, 'uncertain');
  await ui.send({ command: 'getFileDraft', fileId: draft.fileId });
  assert.equal(ui.posted.at(-1).valid, true);
  await ui.send({ command: 'sendFile', requestId: 'attempt-3', fileId: draft.fileId });
  assert.equal(ui.result('sendStatus', 'attempt-3').sendStatus, 'sent');
  assert.equal(attempts, 3);
});

test('received files resolve exclusively from database metadata and write only complete bytes to the selected destination', async (t) => {
  const ui = await setup(t);
  const request = await ui.attachment();
  const destination = vscode.Uri.file(path.join(ui.directory, 'chosen-target.txt'));
  vscode.window.nextSaveDialogResult = destination;
  await ui.send({ ...request, url: 'https://evil.invalid/payload', imagePath: '/etc/ignored', fileName: '../../override.txt' });
  assert.equal(ui.downloadCalls.length, 1);
  assert.equal(ui.downloadCalls[0].part.url, privateUrl);
  assert.equal(ui.downloadCalls[0].part.fileMedia.aesKey, mediaKey);
  assert.equal(saveDialogs[0].defaultUri.fsPath.endsWith('report.txt'), true);
  assert.equal(workspaceWrites.length, 1);
  assert.equal(workspaceWrites[0].destination, destination);
  assert.equal(workspaceWrites[0].bytes.toString(), 'payload');
  assert.equal(ui.result('attachmentStatus', 'save').fileStatus, 'saved');
  await ui.send(request);
  assert.equal(saveDialogs.length, 1);
  assert.equal(ui.downloadCalls.length, 1);
  assert.equal(workspaceWrites.length, 1, 'a duplicate completed request must not overwrite twice');
});

test('save-dialog cancellation does not download and a cancelled in-flight download never writes a partial destination', async (t) => {
  const started = deferred(), release = deferred();
  let signal, downloads = 0;
  const ui = await setup(t, { overrides: { async downloadFile(_part, nextSignal) { downloads++; signal = nextSignal; started.resolve(); await release.promise; return Buffer.from('payload'); } } });
  const request = await ui.attachment();
  await ui.send({ ...request, requestId: 'dialog-cancel' });
  assert.equal(ui.result('attachmentStatus', 'dialog-cancel').fileStatus, 'cancelled');
  assert.equal(downloads, 0);
  vscode.window.nextSaveDialogResult = vscode.Uri.file(path.join(ui.directory, 'cancelled.txt'));
  const pending = ui.send({ ...request, requestId: 'download-cancel' });
  await started.promise;
  await ui.send({ command: 'cancelAttachment', requestId: 'download-cancel' });
  assert.equal(signal.aborted, true);
  release.resolve();
  await pending;
  assert.equal(ui.result('attachmentStatus', 'download-cancel').fileStatus, 'cancelled');
  assert.equal(workspaceWrites.length, 0);
});

test('cancellation while resolving database metadata prevents a later save dialog', async (t) => {
  const ui = await setup(t);
  const request = await ui.attachment();
  const started = deferred(), release = deferred();
  const original = ui.db.getMessageContext.bind(ui.db);
  ui.db.getMessageContext = async (...args) => { started.resolve(); await release.promise; return original(...args); };
  const pending = ui.send(request);
  await started.promise;
  await ui.send({ command: 'cancelAttachment', requestId: request.requestId });
  release.resolve();
  await pending;
  assert.equal(ui.result('attachmentStatus', request.requestId).fileStatus, 'cancelled');
  assert.equal(saveDialogs.length, 0);
  assert.equal(ui.downloadCalls.length, 0);
  assert.equal(workspaceWrites.length, 0);
});

test('concurrent requests for the same attachment share a single download and duplicate IDs replay status', async (t) => {
  const started = deferred(), release = deferred();
  let downloads = 0;
  const ui = await setup(t, { overrides: { async downloadFile() { downloads++; started.resolve(); await release.promise; return Buffer.from('payload'); } } });
  const request = await ui.attachment();
  vscode.window.nextSaveDialogResult = vscode.Uri.file(path.join(ui.directory, 'single.txt'));
  const pending = ui.send(request);
  await started.promise;
  await ui.send(request);
  assert.equal(ui.result('attachmentStatus', 'save').fileStatus, 'saving');
  await ui.send({ ...request, requestId: 'other-save' });
  assert.equal(ui.result('attachmentStatus', 'other-save').fileStatus, 'failed');
  assert.equal(saveDialogs.length, 1);
  release.resolve();
  await pending;
  assert.equal(downloads, 1);
  assert.equal(workspaceWrites.length, 1);
});

test('a third concurrent attachment save is rejected before choosing a destination or downloading', async (t) => {
  const started = [deferred(), deferred()], release = deferred();
  let downloads = 0;
  const ui = await setup(t, { overrides: { async downloadFile() {
    started[downloads++]?.resolve();
    await release.promise;
    return Buffer.from('payload');
  } } });
  const request = await ui.attachment([filePart(), filePart(), filePart()]);
  const pending = [];
  try {
    for (let index = 0; index < 2; index++) {
      vscode.window.nextSaveDialogResult = vscode.Uri.file(path.join(ui.directory, `parallel-${index}.txt`));
      pending.push(ui.send({ ...request, requestId: `parallel-${index}`, partIndex: index }));
      await started[index].promise;
    }
    await ui.send({ ...request, requestId: 'parallel-third', partIndex: 2 });
    assert.equal(ui.result('attachmentStatus', 'parallel-third').fileStatus, 'failed');
    assert.match(ui.result('attachmentStatus', 'parallel-third').error, /最多.*两个/);
    assert.equal(saveDialogs.length, 2);
    assert.equal(downloads, 2);
    assert.equal(workspaceWrites.length, 0);
  } finally {
    release.resolve();
    await Promise.all(pending);
  }
  assert.equal(workspaceWrites.length, 2);
});

test('download failures, oversized results and filesystem failures report failure without partial download writes', async (t) => {
  const ui = await setup(t);
  const request = await ui.attachment();
  for (const [requestId, behavior] of [
    ['network-failed', async () => { throw new Error('download interrupted'); }],
    ['oversized', async () => Buffer.alloc(MAX_FILE_BYTES + 1)],
  ]) {
    ui.client.downloadFile = behavior;
    vscode.window.nextSaveDialogResult = vscode.Uri.file(path.join(ui.directory, `${requestId}.txt`));
    await ui.send({ ...request, requestId });
    assert.equal(ui.result('attachmentStatus', requestId).fileStatus, 'failed');
  }
  assert.equal(workspaceWrites.length, 0);
  ui.client.downloadFile = async () => Buffer.from('payload');
  vscode.workspace.fs.writeError = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  vscode.window.nextSaveDialogResult = vscode.Uri.file(path.join(ui.directory, 'disk-full.txt'));
  await ui.send({ ...request, requestId: 'disk-full' });
  assert.equal(ui.result('attachmentStatus', 'disk-full').fileStatus, 'failed');
  assert.equal(workspaceWrites.length, 0);
});

test('invalid attachment positions and stale generations are rejected before dialogs or downloads', async (t) => {
  const ui = await setup(t);
  const request = await ui.attachment([{ type: 1, text: 'not a file' }, filePart()]);
  for (const [index, override] of [
    { partIndex: 0 }, { partIndex: -1 }, { partIndex: 100 }, { targetId: 0 }, { targetId: '../1' }, { generation: 'stale' },
  ].entries()) {
    await ui.send({ ...request, ...override, requestId: `invalid-position-${index}` });
    assert.equal(ui.result('attachmentStatus', `invalid-position-${index}`).fileStatus, 'failed');
  }
  assert.equal(saveDialogs.length, 0);
  assert.equal(ui.downloadCalls.length, 0);
});

test('clearing history while choosing or downloading prevents saving stale attachment bytes', async (t) => {
  const ui = await setup(t);
  const request = await ui.attachment();
  const choosing = deferred(), destination = deferred();
  vscode.window.nextSaveDialogResult = () => { choosing.resolve(); return destination.promise; };
  const first = ui.send(request);
  await choosing.promise;
  await ui.db.clearAll();
  destination.resolve(vscode.Uri.file(path.join(ui.directory, 'stale-dialog.txt')));
  await first;
  assert.equal(ui.result('attachmentStatus', 'save').fileStatus, 'failed');
  assert.equal(ui.downloadCalls.length, 0);

  const next = await ui.attachment();
  const downloading = deferred(), downloaded = deferred();
  ui.client.downloadFile = async () => { downloading.resolve(); return downloaded.promise; };
  vscode.window.nextSaveDialogResult = vscode.Uri.file(path.join(ui.directory, 'stale-download.txt'));
  const second = ui.send({ ...next, requestId: 'new-save' });
  await downloading.promise;
  await ui.db.clearAll();
  downloaded.resolve(Buffer.from('payload'));
  await second;
  assert.equal(ui.result('attachmentStatus', 'new-save').fileStatus, 'failed');
  assert.equal(workspaceWrites.length, 0);
});

test('all message surfaces strip private file descriptors and signed URLs while the host retains them', async (t) => {
  const ui = await setup(t);
  const request = await ui.attachment();
  await ui.provider.refreshSharedHistory(true);
  await ui.send({ command: 'searchHistory', requestId: 'search', query: 'report' });
  await ui.send({ command: 'loadMessageContext', requestId: 'context', targetId: request.targetId });
  for (const command of ['syncMessages', 'searchResults', 'messageContext']) {
    const result = ui.posted.filter(value => value.command === command && value.messages?.some(row => row.id === request.targetId)).at(-1);
    assert.ok(result, `${command} contains the file card`);
    const card = result.messages.find(row => row.id === request.targetId).parts[0];
    assert.equal(card.fileMedia, undefined);
    assert.equal(card.url, undefined);
    assert.equal(card.fileAction.canSave, true);
  }
  const wire = JSON.stringify(ui.posted);
  for (const secret of [mediaKey, privateUrl, 'private-file-query']) assert.equal(wire.includes(secret), false);
  const stored = (await ui.db.getRecentMessages())[0];
  assert.equal(stored.parts[0].fileMedia.aesKey, mediaKey);
  assert.equal(outputLines.some(line => line.includes(mediaKey) || line.includes(privateUrl)), false);
});

test('legacy WeChat JSON files retain host-only decryption metadata and missing metadata stays unavailable', async (t) => {
  const ui = await setup(t);
  const content = JSON.stringify({ file_item: { file_name: 'legacy.txt', len: '7', media: { full_url: privateUrl, aes_key: mediaKey } } });
  const targetId = await ui.db.insertMessage({ ...message('legacy-wx-file'), type: 4, content });
  const missingId = await ui.db.insertMessage({ ...message('missing-wx-file'), type: 4, content: '[文件]' });
  const generation = (await ui.db.getSyncSnapshot()).cursor.generation;
  await ui.provider.refreshSharedHistory(true);
  const cards = ui.posted.filter(value => value.command === 'syncMessages').at(-1).messages;
  assert.equal(cards.find(row => row.id === targetId).parts[0].fileAction.canSave, true);
  assert.equal(cards.find(row => row.id === missingId).parts[0].fileAction.canSave, false);
  assert.equal(JSON.stringify(cards).includes(mediaKey), false);
  vscode.window.nextSaveDialogResult = vscode.Uri.file(path.join(ui.directory, 'legacy-wx.txt'));
  await ui.send({ command: 'saveAttachment', requestId: 'legacy-wx', targetId, partIndex: 0, generation });
  assert.equal(ui.downloadCalls[0].part.fileMedia.aesKey, mediaKey);
  assert.equal(ui.result('attachmentStatus', 'legacy-wx').fileStatus, 'saved');
  await ui.send({ command: 'saveAttachment', requestId: 'missing-wx', targetId: missingId, partIndex: 0, generation });
  assert.equal(ui.result('attachmentStatus', 'missing-wx').fileStatus, 'failed');
  assert.equal(ui.downloadCalls.length, 1);
});

test('legacy QQ bare URLs resolve into sanitized cards and a remote save destination remains host-chosen', async (t) => {
  const ui = await setup(t, { channel: 'QQ' });
  const url = 'https://multimedia.nt.qq.com/path/legacy%20file.txt?secret=signed-value';
  const targetId = await ui.db.insertMessage({ ...message('legacy-qq-file'), type: 4, content: url });
  const generation = (await ui.db.getSyncSnapshot()).cursor.generation;
  await ui.provider.refreshSharedHistory(true);
  const row = ui.posted.filter(value => value.command === 'syncMessages').at(-1).messages[0];
  assert.equal(row.parts[0].fileName, 'legacy file.txt');
  assert.equal(row.parts[0].url, undefined);
  assert.equal(JSON.stringify(row).includes('signed-value'), false);
  const destination = vscode.Uri.parse('vscode-remote://ssh-remote+test/home/user/saved.txt');
  vscode.window.nextSaveDialogResult = destination;
  await ui.send({ command: 'saveAttachment', requestId: 'legacy-qq', targetId, partIndex: 0, generation });
  assert.equal(ui.downloadCalls[0].part.url, url);
  assert.equal(workspaceWrites[0].destination.scheme, 'vscode-remote');
  assert.equal(ui.result('attachmentStatus', 'legacy-qq').fileStatus, 'saved');
});
