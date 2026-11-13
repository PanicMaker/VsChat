const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('./runtime.cjs');
const { ChatViewProvider } = require('../src/chat-view-provider.ts');
const { FileSendError } = require('../src/file-transfer.ts');

function setup(t, overrides = {}) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-send-'));
  t.after(() => fs.rmSync(storage, { recursive: true, force: true }));
  const outbound = [], calls = [];
  const client = {
    channelName: 'QQ', connected: true,
    async sendText(text, replyTo) { calls.push({ text, replyTo }); },
    async sendImage(imagePath) { calls.push({ image: fs.readFileSync(imagePath), imagePath }); },
    ...overrides,
  };
  const provider = new ChatViewProvider({ globalStorageUri: { fsPath: storage } }, client, {
    async getChangeStamp() { return 'unchanged'; },
    async getSyncSnapshot() {
      return { cursor: { generation: 'send-test', contentVersion: 0, lastId: 0 },
        reset: true, messages: [], hasMore: false, unreadCount: 0, readThroughId: 0 };
    },
  });
  provider.view = { webview: { postMessage: (msg) => outbound.push(msg) } };
  return { provider, calls, outbound, storage, send: (msg) => provider.handleWebViewMessage(msg) };
}

test('send acknowledgements correlate each attempt, keep whitespace and preserve reply references', async (t) => {
  const ui = setup(t);
  const replyTo = { messageId: '123', direction: 'received', text: 'quote' };
  await ui.send({ command: 'sendMessage', requestId: 'text-1', text: 'first\n  second\n', replyTo });
  assert.deepEqual(ui.calls, [{ text: 'first\n  second\n', replyTo }]);
  assert.deepEqual(ui.outbound.map(({ requestId, sendStatus }) => [requestId, sendStatus]), [
    ['text-1', 'sending'], ['text-1', 'sent'],
  ]);
  await ui.send({ command: 'getSendStatus', requestId: 'text-1' });
  assert.equal(ui.outbound.at(-1).sendStatus, 'sent');
  await ui.send({ command: 'sendMessage', requestId: 'text-1', text: 'must not send twice' });
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.outbound.at(-1).sendStatus, 'sent');
});

test('duplicate in-flight requests replay sending without starting a second transport call', async (t) => {
  let complete, calls = 0;
  const ui = setup(t, { sendText() { calls++; return new Promise((resolve) => { complete = resolve; }); } });
  const pending = ui.send({ command: 'sendMessage', requestId: 'pending', text: 'hello' });
  await ui.send({ command: 'sendMessage', requestId: 'pending', text: 'hello' });
  await ui.send({ command: 'getSendStatus', requestId: 'pending' });
  assert.equal(calls, 1);
  assert.equal(ui.outbound.at(-1).sendStatus, 'sending');
  complete('Platform warning');
  await pending;
  assert.equal(ui.outbound.at(-1).sendStatus, 'uncertain');
  assert.equal(ui.outbound.at(-1).warning, 'Platform warning');
});

test('invalid drafts fail before reaching the transport', async (t) => {
  const ui = setup(t);
  for (const [index, msg] of [
    { command: 'sendMessage', text: '  \n' },
    { command: 'sendMessage', text: 12 },
    { command: 'sendMessage', text: 'hello', replyTo: { messageId: 12 } },
    { command: 'sendImage' },
    { command: 'sendImage', imageData: 'data:image/png;base64,!!!' },
    { command: 'sendImage', imageData: 'data:text/html;base64,YWJj' },
    { command: 'sendImage', imageData: 'data:image/png;base64,' },
    { command: 'sendImage', imageData: `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')}` },
  ].entries()) {
    await ui.send({ ...msg, requestId: `invalid-${index}` });
    assert.equal(ui.outbound.at(-1).sendStatus, 'failed');
    assert.equal(ui.outbound.at(-1).requestId, `invalid-${index}`);
  }
  assert.equal(ui.calls.length, 0);
});

test('transport errors and missing results remain uncertain and never trigger an automatic retry', async (t) => {
  let calls = 0;
  const ui = setup(t, { async sendText() { calls++; throw new Error('Network timeout'); } });
  await ui.send({ command: 'sendMessage', requestId: 'timeout', text: 'hello' });
  assert.equal(ui.outbound.at(-1).sendStatus, 'uncertain');
  assert.equal(ui.outbound.at(-1).error, 'Network timeout');
  await ui.send({ command: 'sendMessage', requestId: 'timeout', text: 'hello' });
  assert.equal(calls, 1);
  await ui.send({ command: 'getSendStatus', requestId: 'previous-host' });
  assert.equal(ui.outbound.at(-1).sendStatus, 'uncertain');
  assert.equal(calls, 1);
});

test('filesystem transport errors never expose private paths in correlated or legacy send errors', async (t) => {
  const privatePath = '/synthetic/private/file-drafts/secret.bin';
  for (const code of ['ENOENT', 'EACCES']) {
    let calls = 0;
    const ui = setup(t, {
      async sendText() {
        calls++;
        throw Object.assign(new Error(`${code}: cannot open '${privatePath}'`), { code, path: privatePath });
      },
    });
    const requestId = `private-path-${code}`;
    await ui.send({ command: 'sendMessage', requestId, text: 'synthetic transport fixture' });
    assert.equal(ui.outbound.at(-1).sendStatus, 'uncertain', 'redacting errors must not claim a known delivery outcome');
    assert.ok(ui.outbound.at(-1).error);
    assert.ok(!JSON.stringify(ui.outbound).includes(privatePath));
    await ui.send({ command: 'getSendStatus', requestId });
    assert.equal(ui.outbound.at(-1).sendStatus, 'uncertain');
    assert.ok(!JSON.stringify(ui.outbound.at(-1)).includes(privatePath), 'cached results must remain safe');
    await ui.send({ command: 'sendMessage', text: 'legacy transport fixture' });
    assert.equal(ui.outbound.at(-1).command, 'error');
    assert.ok(ui.outbound.at(-1).error);
    assert.ok(!JSON.stringify(ui.outbound.at(-1)).includes(privatePath));
    assert.equal(calls, 2);
  }
});

test('file preparation errno text is redacted while retaining failed delivery and the retryable draft', async (t) => {
  const privatePath = '/synthetic/private/file-drafts/secret.bin';
  for (const code of ['ENOENT', 'EACCES']) {
    let calls = 0;
    const ui = setup(t, {
      fileCapabilities: { canSend: true, maxBytes: 20 * 1024 * 1024 },
      async sendFile() {
        calls++;
        // A transport may wrap the original Node error and no longer expose `code`.
        throw new FileSendError(`${code}: cannot read '${privatePath}'`);
      },
    });
    const filePath = path.join(ui.storage, 'staged-file.bin');
    fs.writeFileSync(filePath, 'fixture');
    ui.provider.files.staged.set('opaque-file-token', {
      fileId: 'opaque-file-token', fileName: 'fixture.bin', filePath, size: 7, active: false,
    });
    await ui.send({ command: 'sendFile', requestId: `file-${code}`, fileId: 'opaque-file-token' });
    assert.equal(ui.outbound.at(-1).sendStatus, 'failed', 'known pre-send failures must remain certain');
    assert.ok(ui.outbound.at(-1).error);
    assert.ok(!JSON.stringify(ui.outbound).includes(privatePath));
    assert.equal(ui.provider.files.staged.has('opaque-file-token'), true);
    assert.equal(fs.existsSync(filePath), true);
    await ui.send({ command: 'sendFile', fileId: 'opaque-file-token' });
    assert.equal(ui.outbound.at(-1).command, 'error');
    assert.ok(ui.outbound.at(-1).error);
    assert.ok(!JSON.stringify(ui.outbound.at(-1)).includes(privatePath));
    assert.equal(calls, 1, 'a file attempt without a request ID must not reach the transport');
    const retry = { command: 'sendFile', requestId: `file-retry-${code}`, fileId: 'opaque-file-token' };
    await ui.send(retry);
    assert.equal(ui.outbound.at(-1).sendStatus, 'failed');
    assert.ok(!JSON.stringify(ui.outbound.at(-1)).includes(privatePath));
    await ui.send(retry);
    assert.equal(ui.outbound.at(-1).sendStatus, 'failed');
    assert.equal(calls, 2, 'only an explicit new request may retry; replaying its ID must not resend');
  }
});

test('known offline sends fail before transport without claiming an uncertain delivery', async (t) => {
  const ui = setup(t, { connected: false });
  await ui.send({ command: 'sendMessage', requestId: 'offline', text: 'hello' });
  assert.equal(ui.outbound.at(-1).sendStatus, 'failed');
  assert.equal(ui.calls.length, 0);
});

test('image attempts use unique temp files and remove them on success and uncertain failure', async (t) => {
  const ui = setup(t);
  await ui.send({ command: 'sendImage', requestId: 'image', imageData: 'data:image/png;base64,YWJj', fileName: '../image.png' });
  assert.equal(ui.outbound.at(-1).sendStatus, 'sent');
  assert.equal(ui.calls[0].image.toString(), 'abc');
  assert.equal(fs.existsSync(ui.calls[0].imagePath), false);
  assert.equal(path.dirname(ui.calls[0].imagePath), path.join(ui.storage, 'temp'));

  let failedPath;
  const failed = setup(t, { async sendImage(imagePath) { failedPath = imagePath; throw new Error('Timeout'); } });
  await failed.send({ command: 'sendImage', requestId: 'image-failed', imageData: 'data:image/png;base64,YWJj' });
  assert.equal(failed.outbound.at(-1).sendStatus, 'uncertain');
  assert.equal(fs.existsSync(failedPath), false);
});

test('local image staging failure is certain and does not reach transport', async (t) => {
  const ui = setup(t);
  fs.writeFileSync(path.join(ui.storage, 'temp'), 'not a directory');
  await ui.send({ command: 'sendImage', requestId: 'local-failure', imageData: 'data:image/png;base64,YWJj' });
  assert.equal(ui.outbound.at(-1).sendStatus, 'failed');
  assert.equal(ui.calls.length, 0);
});

test('result eviction preserves active sends and old request IDs never send again', async (t) => {
  let finish;
  const calls = [];
  const ui = setup(t, {
    sendText(text) {
      calls.push(text);
      if (text === 'pending') return new Promise((resolve) => { finish = resolve; });
      return Promise.resolve();
    },
  });
  const pending = ui.send({ command: 'sendMessage', requestId: 'active', text: 'pending' });
  for (let i = 0; i < 105; i++) {
    await ui.send({ command: 'sendMessage', requestId: `result-${i}`, text: `text-${i}` });
  }
  assert.equal(ui.provider.sendResults.size, 100);
  await ui.send({ command: 'getSendStatus', requestId: 'active' });
  assert.equal(ui.outbound.at(-1).sendStatus, 'sending');
  await ui.send({ command: 'sendMessage', requestId: 'result-0', text: 'must not resend' });
  assert.equal(ui.outbound.at(-1).sendStatus, 'uncertain');
  assert.equal(calls.length, 106);
  finish();
  await pending;
  assert.equal(ui.outbound.at(-1).sendStatus, 'sent');
});

test('legacy sends retain errors and warnings, and ready announces the channel before history', async (t) => {
  const ui = setup(t, { async sendText() { return 'Warning'; } });
  await ui.send({ command: 'sendMessage', text: 'legacy' });
  assert.deepEqual(ui.outbound.at(-1), { command: 'warning', warning: 'Warning' });
  await ui.send({ command: 'sendMessage', text: '' });
  assert.equal(ui.outbound.at(-1).command, 'error');
  const readyStart = ui.outbound.length;
  await ui.send({ command: 'ready' });
  const readyMessages = ui.outbound.slice(readyStart);
  assert.deepEqual(readyMessages.find(msg => msg.command === 'channel'), { command: 'channel', channel: 'QQ' });
  assert.ok(readyMessages.some(msg => msg.command === 'hostFocus'));
  assert.ok(readyMessages.findIndex(msg => msg.command === 'channel')
    < readyMessages.findIndex(msg => msg.command === 'syncMessages'));
});
