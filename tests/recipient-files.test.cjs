const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { vscode, openDialogs, resetVSCodeMocks } = require('./runtime.cjs');
const { FileActions } = require('../src/file-actions.ts');
const { FileSendError, MAX_FILE_BYTES } = require('../src/file-transfer.ts');
const { recipientId } = require('../src/recipient-types.ts');

const targetA = { channel: 'wechat', accountId: 'bot', peerId: 'peer-a', contextToken: 'token-a', sessionKey: 'session-a' };
const targetB = { channel: 'wechat', accountId: 'bot', peerId: 'peer-b', contextToken: 'token-b', sessionKey: 'session-b' };
const ownerA = recipientId(targetA), ownerB = recipientId(targetB);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function setup(t, overrides = {}) {
  resetVSCodeMocks();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-recipient-files-'));
  const posted = [], sends = [];
  let generation = 1, sequence = 0;
  const client = {
    channelName: 'WeChat', fileCapabilities: { canSend: true, maxBytes: MAX_FILE_BYTES },
    async sendFile(filePath, name, target) { sends.push({ bytes: fs.readFileSync(filePath).toString(), name, target }); },
    ...overrides,
  };
  const db = {};
  const actions = new FileActions({ globalStorageUri: vscode.Uri.file(root) }, client, db, value => posted.push(value), () => generation);
  t.after(() => { actions.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    root, actions, posted, sends, client, db,
    switchView() { generation++; },
    create(name, content = name) { const file = path.join(root, name); fs.writeFileSync(file, content); return file; },
    async select(file, owner, selectionId = `selection-${++sequence}`) {
      const requestId = `select-${++sequence}`;
      vscode.window.nextOpenDialogResult = [vscode.Uri.file(file)];
      await actions.select({ command: 'selectFile', requestId, recipientId: owner, selectionId });
      const result = posted.find(value => value.requestId === requestId);
      assert.equal(result?.error, undefined);
      return { ...result.fileDraft, result };
    },
    status(fileId, owner, selectionId = 'current-selection') {
      actions.status(fileId, owner, selectionId);
      return posted.at(-1);
    },
  };
}

test('each recipient retains a separate file draft and replacement only removes the same recipient draft', async t => {
  const ui = setup(t);
  const a = await ui.select(ui.create('a.txt'), ownerA, 'a-selection');
  const b = await ui.select(ui.create('b.txt'), ownerB, 'b-selection');
  assert.equal(a.result.recipientId, ownerA);
  assert.equal(a.result.selectionId, 'a-selection');
  assert.equal(b.result.recipientId, ownerB);
  assert.equal(ui.status(a.fileId, ownerA).valid, true);
  assert.equal(ui.status(b.fileId, ownerB).valid, true);
  const replacement = await ui.select(ui.create('a-new.txt'), ownerA, 'a-returned');
  assert.equal(ui.status(a.fileId, ownerA).valid, false);
  assert.equal(ui.status(b.fileId, ownerB).valid, true);
  const status = ui.status(replacement.fileId, ownerA, 'a-current-selection');
  assert.equal(status.valid, true);
  assert.equal(status.recipientId, ownerA);
  assert.equal(status.selectionId, 'a-current-selection');
  assert.equal(JSON.stringify(ui.posted).includes('token-a'), false);
});

test('a bound draft rejects another owner, missing ownership, and mismatched captured destinations before transport', async t => {
  const ui = setup(t);
  const a = await ui.select(ui.create('a.txt'), ownerA);
  const b = await ui.select(ui.create('b.txt'), ownerB);
  assert.equal(ui.status(a.fileId, ownerB).valid, false);
  assert.equal(ui.status(a.fileId, undefined).valid, false);
  ui.actions.remove(a.fileId, ownerB);
  ui.actions.remove(a.fileId);
  assert.equal(ui.status(a.fileId, ownerA).valid, true);
  for (const [target, owner] of [[targetA, ownerB], [targetA, undefined], [targetB, ownerA], [undefined, ownerA],
    [{ ...targetA, channel: 'qq' }, ownerA]]) {
    await assert.rejects(ui.actions.send(a.fileId, target, owner), error => error instanceof FileSendError && error.deliveryState === 'not_sent');
  }
  assert.equal(ui.sends.length, 0);
  await ui.actions.send(b.fileId, targetB, ownerB);
  assert.equal(ui.sends[0].bytes, 'b.txt');
  assert.equal(ui.sends[0].target.peerId, 'peer-b');
  assert.equal(ui.status(b.fileId, ownerB).valid, false);
  assert.equal(ui.status(a.fileId, ownerA).valid, true);
  ui.actions.remove(a.fileId, ownerA);
  assert.equal(ui.status(a.fileId, ownerA).valid, false);
});

test('send captures and freezes its destination before filesystem awaits and contact switches', async t => {
  const ui = setup(t);
  const a = await ui.select(ui.create('a.txt'), ownerA);
  const target = { ...targetA };
  const pending = ui.actions.send(a.fileId, target, ownerA);
  target.peerId = 'peer-b';
  target.contextToken = 'token-b';
  ui.switchView();
  await pending;
  assert.equal(ui.sends.length, 1);
  assert.equal(ui.sends[0].target.peerId, 'peer-a');
  assert.equal(ui.sends[0].target.contextToken, 'token-a');
  assert.equal(Object.isFrozen(ui.sends[0].target), true);
  assert.notEqual(ui.sends[0].target, target);
});

test('a file dialog completed after a contact switch cannot replace either recipient draft', async t => {
  const ui = setup(t);
  const a = await ui.select(ui.create('a.txt'), ownerA);
  const b = await ui.select(ui.create('b.txt'), ownerB);
  const opened = deferred(), selected = deferred();
  vscode.window.nextOpenDialogResult = () => { opened.resolve(); return selected.promise; };
  const pending = ui.actions.select({ command: 'selectFile', requestId: 'late-dialog', recipientId: ownerA, selectionId: 'old-selection' });
  await opened.promise;
  ui.switchView();
  selected.resolve([vscode.Uri.file(ui.create('late.txt'))]);
  await pending;
  assert.equal(ui.posted.some(value => value.requestId === 'late-dialog'), false);
  assert.equal(ui.status(a.fileId, ownerA).valid, true);
  assert.equal(ui.status(b.fileId, ownerB).valid, true);
  assert.equal(fs.readdirSync(path.join(ui.root, 'file-drafts')).length, 2);
});

test('a selection that becomes stale during snapshot writing removes only its unclaimed snapshot', async t => {
  const ui = setup(t);
  const b = await ui.select(ui.create('b.txt'), ownerB);
  const late = ui.create('late.txt');
  const writing = deferred(), release = deferred();
  const writeFile = fs.promises.writeFile;
  fs.promises.writeFile = async (file, ...args) => {
    const result = await writeFile.call(fs.promises, file, ...args);
    if (path.dirname(String(file)) === path.join(ui.root, 'file-drafts')) { writing.resolve(); await release.promise; }
    return result;
  };
  vscode.window.nextOpenDialogResult = [vscode.Uri.file(late)];
  const pending = ui.actions.select({ command: 'selectFile', requestId: 'late-write', recipientId: ownerA, selectionId: 'old-selection' });
  try {
    await writing.promise;
    ui.switchView();
    release.resolve();
    await pending;
  } finally {
    release.resolve();
    fs.promises.writeFile = writeFile;
    await pending;
  }
  assert.equal(ui.posted.some(value => value.requestId === 'late-write'), false);
  assert.equal(ui.status(b.fileId, ownerB).valid, true);
  assert.equal(fs.readdirSync(path.join(ui.root, 'file-drafts')).length, 1);
});

test('an active send owns its snapshot while a new same-recipient draft and another recipient are retained', async t => {
  const sending = deferred(), release = deferred();
  const ui = setup(t, { async sendFile() { sending.resolve(); await release.promise; } });
  const a = await ui.select(ui.create('a.txt'), ownerA);
  const b = await ui.select(ui.create('b.txt'), ownerB);
  const pending = ui.actions.send(a.fileId, targetA, ownerA);
  await sending.promise;
  const nextA = await ui.select(ui.create('a-next.txt'), ownerA);
  ui.actions.remove(a.fileId, ownerA);
  assert.equal(ui.status(a.fileId, ownerA).valid, true);
  release.resolve();
  await pending;
  assert.equal(ui.status(a.fileId, ownerA).valid, false);
  assert.equal(ui.status(nextA.fileId, ownerA).valid, true);
  assert.equal(ui.status(b.fileId, ownerB).valid, true);
});

test('selection cancellation, busy errors and invalid scopes remain correlated to their initiating contact', async t => {
  const ui = setup(t);
  await ui.actions.select({ command: 'selectFile', requestId: 'cancel', recipientId: ownerA, selectionId: 'selection-a' });
  assert.deepEqual(ui.posted.at(-1), { command: 'fileSelected', requestId: 'cancel', recipientId: ownerA, selectionId: 'selection-a', cancelled: true });
  const opened = deferred(), selected = deferred();
  vscode.window.nextOpenDialogResult = () => { opened.resolve(); return selected.promise; };
  const pending = ui.actions.select({ command: 'selectFile', requestId: 'first', recipientId: ownerA, selectionId: 'selection-a' });
  await opened.promise;
  await ui.actions.select({ command: 'selectFile', requestId: 'busy', recipientId: ownerB, selectionId: 'selection-b' });
  assert.equal(ui.posted.at(-1).recipientId, ownerB);
  assert.equal(ui.posted.at(-1).selectionId, 'selection-b');
  assert.ok(ui.posted.at(-1).error);
  selected.resolve(undefined);
  await pending;
  const count = openDialogs.length;
  await ui.actions.select({ command: 'selectFile', requestId: 'invalid-owner', recipientId: null, selectionId: 'selection-a' });
  assert.ok(ui.posted.at(-1).error);
  assert.equal(openDialogs.length, count);
});

test('legacy drafts without an owner retain the optional single-channel contract', async t => {
  const ui = setup(t);
  const legacy = await ui.select(ui.create('legacy.txt'), undefined);
  assert.equal(ui.status(legacy.fileId, undefined).valid, true);
  await ui.actions.send(legacy.fileId);
  assert.equal(ui.sends.length, 1);
  assert.equal(ui.sends[0].target, undefined);
  assert.equal(ui.status(legacy.fileId, undefined).valid, false);
});

test('attachment download results and replay preserve the initiating contact and selection', async t => {
  const downloading = deferred(), downloaded = deferred();
  const ui = setup(t, { async downloadFile() { downloading.resolve(); return downloaded.promise; } });
  ui.db.getMessageContext = async () => ({ generation: 'history-generation', messages: [{ id: 1, type: 4,
    parts: [{ type: 4, fileName: 'report.txt', size: 7, url: 'https://cdn.qq.com/file',
      fileMedia: { aesKey: Buffer.alloc(16, 7).toString('base64') } }] }] });
  vscode.window.nextSaveDialogResult = vscode.Uri.file(path.join(ui.root, 'chosen.txt'));
  const request = { command: 'saveAttachment', requestId: 'download-a', targetId: 1, partIndex: 0,
    generation: 'history-generation', recipientId: ownerA, selectionId: 'selection-a' };
  const pending = ui.actions.save(request);
  await downloading.promise;
  ui.switchView();
  request.recipientId = ownerB;
  request.selectionId = 'selection-b';
  downloaded.resolve(Buffer.from('payload'));
  await pending;
  await ui.actions.save(request);
  const results = ui.posted.filter(value => value.command === 'attachmentStatus');
  assert.ok(results.some(value => value.fileStatus === 'saved'));
  for (const result of results) {
    assert.equal(result.recipientId, ownerA);
    assert.equal(result.selectionId, 'selection-a');
  }
});
