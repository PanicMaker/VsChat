const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ChatDB, message, vscode, configuration, configurationEvents, outputLines,
  clipboardWrites, externalUrls, resetVSCodeMocks,
} = require('./runtime.cjs');
const { ChatViewProvider } = require('../src/chat-view-provider.ts');

async function setup(t, { getDecryptedImageUrl = async () => undefined } = {}) {
  resetVSCodeMocks();
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-rich-provider-'));
  const context = { globalStorageUri: vscode.Uri.file(storage), extensionUri: vscode.Uri.file(path.resolve(__dirname, '..')) };
  const db = new ChatDB(context, 'qq');
  await db.init();
  const clientEvents = Array.from({ length: 4 }, () => new vscode.EventEmitter());
  const provider = new ChatViewProvider(context, {
    channelName: 'QQ', connected: true,
    onMessage: clientEvents[0].event, onStatus: clientEvents[1].event,
    onQrCode: clientEvents[2].event, onLoginSuccess: clientEvents[3].event,
    getDecryptedImageUrl,
    async sendText() { assert.fail('rich-content checks must not send chat messages'); },
    async sendImage() { assert.fail('rich-content checks must not send chat images'); },
  }, db);
  const inbound = new vscode.EventEmitter(), disposed = new vscode.EventEmitter(), visibility = new vscode.EventEmitter();
  const posted = [];
  provider.resolveWebviewView({
    visible: true, show() {}, onDidChangeVisibility: visibility.event, onDidDispose: disposed.event,
    webview: {
      cspSource: 'vscode-webview:', asWebviewUri: value => value.toString(), onDidReceiveMessage: inbound.event,
      postMessage(value) { posted.push(value); return Promise.resolve(true); },
    },
  }, {}, {});
  t.after(async () => {
    provider.dispose();
    await provider.historyPending;
    await db.close();
    fs.rmSync(storage, { recursive: true, force: true });
  });
  return {
    provider, db, posted,
    send: value => inbound.fire(value),
    async ready() { await provider.start(); await inbound.fire({ command: 'ready' }); },
    copyResult: requestId => posted.find(value => value.command === 'copyResult' && value.requestId === requestId),
    latestMessages: () => posted.filter(value => value.command === 'syncMessages').at(-1).messages,
  };
}

test('host opens only explicitly allowed external URL protocols', async (t) => {
  const ui = await setup(t);
  const rejected = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd', 'command:workbench.action.terminal.new', 'vscode://publisher.extension/command',
    '//example.com/path', '/relative/path', 'C:\\secret.txt', 'about:blank', 'ftp://example.com/file',
  ];
  for (const url of rejected) await ui.send({ command: 'openExternal', url });
  assert.deepEqual(externalUrls, []);
  const allowed = ['https://example.com/docs?q=hello#example', 'http://localhost:8080/page', 'mailto:dev@example.com?subject=Hello'];
  for (const url of allowed) await ui.send({ command: 'openExternal', url });
  assert.deepEqual(externalUrls.map(value => new URL(value).href), allowed.map(value => new URL(value).href));
});

test('copy preserves exact code and whitespace with a correlated success and no diagnostic content', async (t) => {
  const ui = await setup(t);
  const code = '\n  const 私密标记 = "<script>literal</script>";\n\treturn 私密标记;\n';
  await ui.send({ command: 'copyText', requestId: 'copy-code', text: code });
  assert.deepEqual(clipboardWrites, [code]);
  assert.deepEqual(ui.copyResult('copy-code'), { command: 'copyResult', requestId: 'copy-code' });
  assert.equal(outputLines.some(line => line.includes('私密标记')), false);
  assert.equal(ui.posted.some(value => value.command === 'error'), false);
});

test('clipboard failures and invalid payloads return inline correlated errors without logging copied text', async (t) => {
  const ui = await setup(t);
  const secret = 'synthetic-copy-secret';
  vscode.env.clipboard.writeError = new Error(`clipboard denied for ${secret}`);
  await ui.send({ command: 'copyText', requestId: 'copy-failed', text: secret });
  assert.ok(ui.copyResult('copy-failed').error);
  vscode.env.clipboard.writeError = undefined;
  await ui.send({ command: 'copyText', requestId: 'copy-invalid', text: { value: 'not a string' } });
  await ui.send({ command: 'copyText', requestId: 'copy-oversized', text: 'x'.repeat(1_000_001) });
  assert.ok(ui.copyResult('copy-invalid').error);
  assert.ok(ui.copyResult('copy-oversized').error);
  assert.deepEqual(clipboardWrites, []);
  assert.equal(ui.posted.some(value => value.command === 'error'), false);
  assert.equal(outputLines.some(line => line.includes(secret)), false);
});

test('mixed message parts hydrate independently in their original order alongside legacy images', async (t) => {
  const calls = [];
  const imageDataUrl = 'data:image/png;base64,YWJj';
  const ui = await setup(t, {
    async getDecryptedImageUrl(id, partIndex) {
      calls.push([id, partIndex]);
      if (partIndex === 3) throw new Error('one cached image is missing');
      return imageDataUrl;
    },
  });
  const parts = [
    { type: 1, text: 'intro **bold**' },
    { type: 2, url: 'https://example.com/one.png', fileName: 'one.png' },
    { type: 4, url: 'https://example.com/manual.txt', fileName: 'manual.txt', size: 123, mimeType: 'text/plain' },
    { type: 2, fileName: 'missing.png' },
    { type: 3, text: 'transcribed voice' },
  ];
  const mixedId = await ui.db.insertMessage({ ...message('mixed'), type: 1, content: 'mixed summary', parts });
  const legacyId = await ui.db.insertMessage({ ...message('legacy-image'), type: 2, content: '[Image]' });
  await ui.ready();
  const mixed = ui.latestMessages().find(row => row.id === mixedId);
  const legacy = ui.latestMessages().find(row => row.id === legacyId);
  assert.deepEqual(mixed.parts.map(part => part.type), [1, 2, 4, 2, 3]);
  assert.equal(mixed.parts[0].text, parts[0].text);
  assert.equal(mixed.parts[1].imageDataUrl, imageDataUrl);
  assert.equal(mixed.parts[2].fileName, 'manual.txt');
  assert.equal(mixed.parts[2].size, 123);
  assert.equal(mixed.parts[3].imageDataUrl, undefined);
  assert.equal(mixed.parts[4].text, 'transcribed voice');
  assert.equal(legacy.imageDataUrl, imageDataUrl);
  assert.deepEqual(calls, [[mixedId, 1], [mixedId, 3], [legacyId, undefined]]);
  assert.equal(ui.posted.some(value => value.command === 'error'), false);
});

test('Markdown and hydrated media remain view-only and are available while Markdown rendering is disabled', async (t) => {
  const ui = await setup(t, { async getDecryptedImageUrl() { return 'data:image/png;base64,YWJj'; } });
  configuration.set('vschat.renderMarkdown', false);
  const content = '**title**\n\n```js\nconst answer = 42;\n```';
  const id = await ui.db.insertMessage({
    ...message('markdown'), content,
    parts: [{ type: 1, text: 'part **text**' }, { type: 2, fileName: 'image.png' }],
  });
  const legacyId = await ui.db.insertMessage({ ...message('legacy-markdown'), content });
  const before = await ui.db.getRecentMessages();
  await ui.ready();
  const hydrated = ui.latestMessages().find(row => row.id === id);
  const legacy = ui.latestMessages().find(row => row.id === legacyId);
  assert.equal(hydrated.content, content);
  assert.ok(Array.isArray(legacy.markdown));
  assert.ok(Array.isArray(hydrated.parts[0].markdown));
  assert.ok(JSON.stringify(legacy.markdown).includes('const answer = 42;'));
  assert.equal(ui.posted.find(value => value.command === 'settings').renderMarkdown, false);
  assert.deepEqual(await ui.db.getRecentMessages(), before, 'rendering must never persist parsed AST or decoded media into SQLite');
  assert.equal(before[0].markdown, undefined);
  assert.equal(before[0].parts[0].markdown, undefined);
  assert.equal(before[0].parts[1].imageDataUrl, undefined);
});

test('Markdown configuration updates live together with the existing send shortcut without reloading history', async (t) => {
  const ui = await setup(t);
  await ui.ready();
  const settings = () => ui.posted.filter(value => value.command === 'settings').at(-1);
  const snapshotCount = () => ui.posted.filter(value => value.command === 'syncMessages').length;
  assert.equal(settings().renderMarkdown, true);
  assert.equal(settings().sendShortcut, 'enter');
  const beforeSnapshots = snapshotCount();
  configuration.set('vschat.renderMarkdown', false);
  await configurationEvents.fire({ affectsConfiguration: name => name === 'vschat.renderMarkdown' });
  assert.equal(settings().renderMarkdown, false);
  assert.equal(settings().sendShortcut, 'enter');
  configuration.set('vschat.sendShortcut', 'ctrlEnter');
  await configurationEvents.fire({ affectsConfiguration: name => name === 'vschat.sendShortcut' });
  assert.equal(settings().renderMarkdown, false);
  assert.equal(settings().sendShortcut, 'ctrlEnter');
  assert.equal(snapshotCount(), beforeSnapshots);
});
