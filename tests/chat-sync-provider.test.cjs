const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ChatDB, message, vscode, windowStateEvents, statusBarItems, notifications, resetVSCodeMocks,
} = require('./runtime.cjs');
const { ChatViewProvider } = require('../src/chat-view-provider.ts');

const received = (id) => ({ ...message(id), direction: 'received', from_user_id: 'user', to_user_id: 'bot' });

async function settle(provider) {
  // Event callbacks enqueue work and notification actions may enqueue another pass.
  for (let pass = 0; pass < 3; pass++) {
    await provider.historyPending;
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function setup(t, { focused = true, clientOverrides = {} } = {}) {
  resetVSCodeMocks();
  vscode.window.state.focused = focused;
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-provider-sync-'));
  const context = { globalStorageUri: vscode.Uri.file(storage), extensionUri: vscode.Uri.file(path.resolve(__dirname, '..')) };
  const db = new ChatDB(context, 'qq');
  const writer = new ChatDB(context, 'qq');
  await db.init();
  await writer.init();
  const clientEvents = Object.fromEntries(['message', 'status', 'qrcode', 'login'].map(name => [name, new vscode.EventEmitter()]));
  const client = {
    channelName: 'QQ', connected: true,
    onMessage: clientEvents.message.event, onStatus: clientEvents.status.event,
    onQrCode: clientEvents.qrcode.event, onLoginSuccess: clientEvents.login.event,
    async getDecryptedImageUrl() {},
    async sendText() { assert.fail('sync must never send a real message'); },
    async sendImage() { assert.fail('sync must never send a real image'); },
    ...clientOverrides,
  };
  const provider = new ChatViewProvider(context, client, db);
  t.after(async () => {
    provider.dispose();
    await settle(provider);
    await db.close();
    await writer.close();
    fs.rmSync(storage, { recursive: true, force: true });
  });

  function attachView(visible = true) {
    const inbound = new vscode.EventEmitter();
    const visibility = new vscode.EventEmitter();
    const disposed = new vscode.EventEmitter();
    const posted = [];
    const view = {
      visible,
      onDidChangeVisibility: visibility.event,
      onDidDispose: disposed.event,
      shows: [],
      show(preserveFocus) { this.shows.push(preserveFocus); this.visible = true; },
      webview: {
        cspSource: 'vscode-webview:',
        asWebviewUri: value => value.toString(),
        onDidReceiveMessage: inbound.event,
        postMessage(value) { posted.push(value); return Promise.resolve(true); },
      },
    };
    provider.resolveWebviewView(view, {}, {});
    return {
      view, posted, inbound, visibility, disposed,
      send: value => inbound.fire(value),
      async setVisible(value) { view.visible = value; await visibility.fire(); await settle(provider); },
      async dispose() { await disposed.fire(); },
      syncs: () => posted.filter(value => value.command === 'syncMessages'),
    };
  }
  return { provider, db, writer, clientEvents, attachView };
}

test('startup unread status works without a panel and unchanged polling skips database hydration', async (t) => {
  const { provider, writer, db } = await setup(t, { focused: false });
  await writer.insertMessage(received('before-panel-1'));
  await writer.insertMessage(received('before-panel-2'));
  let snapshots = 0;
  const originalSnapshot = db.getSyncSnapshot.bind(db);
  db.getSyncSnapshot = (...args) => { snapshots++; return originalSnapshot(...args); };
  await provider.start();
  await provider.start();
  assert.equal(statusBarItems.length, 1, 'starting twice must not create duplicate lifecycle subscriptions');
  assert.equal(statusBarItems[0].visible, true);
  assert.equal(statusBarItems[0].command, 'vschat.openChat');
  assert.match(statusBarItems[0].text, /QQ.*2/);
  assert.equal(snapshots, 1);
  await provider.refreshSharedHistory();
  assert.equal(snapshots, 1, 'unchanged file stamp should avoid reloading SQLite');
  await writer.insertMessage(received('other-window'));
  await provider.refreshSharedHistory();
  assert.equal(snapshots, 2);
  assert.match(statusBarItems[0].text, /QQ.*3/);
  assert.equal(notifications.length, 0, 'unfocused windows do not show duplicate editor notifications');
  const shared = await writer.getSyncSnapshot();
  await writer.markRead(shared.cursor.generation, shared.cursor.lastId);
  await provider.refreshSharedHistory();
  assert.equal(statusBarItems[0].text, '$(comment-discussion) QQ', 'another window can clear the shared unread badge');
  assert.equal(notifications.length, 0);
});

test('other-window inserts arrive as deltas; clear resets the view and late cached events cannot resurrect rows', async (t) => {
  const { provider, writer, clientEvents, attachView } = await setup(t);
  await provider.start();
  const ui = attachView();
  await ui.send({ command: 'ready' });
  assert.equal(ui.syncs().at(-1).reset, true);
  const initialGeneration = ui.syncs().at(-1).generation;
  const firstId = await writer.insertMessage(received('external-1'));
  const sentId = await writer.insertMessage(message('external-sent'));
  await provider.refreshSharedHistory();
  assert.equal(ui.syncs().at(-1).reset, false);
  assert.deepEqual(ui.syncs().at(-1).messages.map(row => row.id), [firstId, sentId]);
  assert.equal(ui.syncs().at(-1).unreadCount, 1);
  await writer.clearAll();
  const newId = await writer.insertMessage(received('after-clear'));
  await provider.refreshSharedHistory();
  const reset = ui.syncs().at(-1);
  assert.equal(reset.reset, true);
  assert.notEqual(reset.generation, initialGeneration);
  assert.deepEqual(reset.messages.map(row => row.id), [newId]);
  await clientEvents.message.fire({ ...received('external-1'), id: firstId });
  await settle(provider);
  assert.equal(ui.posted.some(value => value.command === 'newMessage'), false);
  assert.deepEqual(ui.syncs().at(-1).messages, [], 'cached transport events must trigger an authoritative DB sync');
  assert.equal(ui.syncs().at(-1).generation, reset.generation);
});

test('markRead requires a visible focused view and valid synced generation and cursor', async (t) => {
  const { provider, writer, attachView } = await setup(t);
  const firstId = await writer.insertMessage(received('unread-first'));
  const lastId = await writer.insertMessage(received('unread-last'));
  await provider.start();
  const ui = attachView();
  await ui.send({ command: 'ready' });
  const generation = ui.syncs().at(-1).generation;
  const read = (overrides = {}) => ui.send({ command: 'markRead', generation, throughId: lastId, ...overrides });
  await read({ generation: 'stale-generation' });
  await read({ throughId: lastId + 1 });
  await ui.setVisible(false);
  await read();
  await ui.setVisible(true);
  vscode.window.state.focused = false;
  await read();
  assert.equal((await writer.getSyncSnapshot()).unreadCount, 2);
  vscode.window.state.focused = true;
  await read({ throughId: firstId });
  assert.equal((await writer.getSyncSnapshot()).unreadCount, 1);
  assert.match(statusBarItems[0].text, /QQ.*1/);
  await read();
  assert.equal((await writer.getSyncSnapshot()).unreadCount, 0);
  await read({ throughId: firstId });
  assert.equal((await writer.getSyncSnapshot()).readThroughId, lastId, 'old views cannot move read progress backwards');
  await writer.clearAll();
  await writer.insertMessage(received('new-generation'));
  await provider.refreshSharedHistory();
  await read();
  assert.equal((await writer.getSyncSnapshot()).unreadCount, 1, 'a pre-clear read event must not read later messages');
});

test('window focus and panel visibility catch up changes without waiting for the periodic poll', async (t) => {
  const { provider, writer, attachView } = await setup(t, { focused: false });
  await provider.start();
  const ui = attachView(false);
  await ui.send({ command: 'ready' });
  const firstId = await writer.insertMessage(received('while-unfocused'));
  vscode.window.state.focused = true;
  await windowStateEvents.fire(vscode.window.state);
  await settle(provider);
  assert.deepEqual(ui.syncs().at(-1).messages.map(row => row.id), [firstId]);
  assert.ok(ui.posted.some(value => value.command === 'hostFocus' && value.focused));
  const secondId = await writer.insertMessage(received('while-hidden'));
  await ui.setVisible(true);
  assert.deepEqual(ui.syncs().at(-1).messages.map(row => row.id), [secondId]);
});

test('successful login restores an unchanged empty chat with a reset snapshot', async (t) => {
  const { provider, clientEvents, attachView } = await setup(t);
  await provider.start();
  const ui = attachView();
  await ui.send({ command: 'ready' });
  await clientEvents.qrcode.fire('data:image/png;base64,YWJj');
  assert.equal(ui.posted.at(-1).command, 'qrcode');
  const snapshotCount = ui.syncs().length;
  await clientEvents.login.fire();
  await settle(provider);
  assert.equal(ui.syncs().length, snapshotCount + 1);
  assert.equal(ui.syncs().at(-1).reset, true, 'an unchanged login must still dismiss the QR screen');
  assert.deepEqual(ui.syncs().at(-1).messages, []);
});

test('opening from status bar before panel creation waits for ready before revealing the latest message', async (t) => {
  const { provider, writer, attachView } = await setup(t);
  await writer.insertMessage(received('startup-unread'));
  await provider.start();
  // Extension command registration is represented without activating transport code.
  vscode.commands.registerCommand('vschat.openChat', () => provider.revealLatest());
  await vscode.commands.executeCommand(statusBarItems[0].command);
  assert.ok(vscode.commands.executed.some(value => value.name === 'vschat.chatView.focus'));
  const ui = attachView();
  assert.equal(ui.posted.some(value => value.command === 'revealLatest'), false);
  await ui.send({ command: 'ready' });
  const commands = ui.posted.map(value => value.command);
  assert.ok(commands.indexOf('channel') < commands.indexOf('syncMessages'));
  assert.ok(commands.indexOf('hostFocus') < commands.indexOf('syncMessages'));
  assert.ok(commands.indexOf('syncMessages') < commands.indexOf('revealLatest'));
  assert.equal(ui.posted.filter(value => value.command === 'revealLatest').length, 1);
});

test('notification open action reveals the hidden view and does not replay notifications on read-only sync', async (t) => {
  const { provider, writer, attachView } = await setup(t);
  await provider.start();
  const ui = attachView(false);
  await ui.send({ command: 'ready' });
  vscode.window.nextNotificationAction = '打开聊天';
  await writer.insertMessage(received('notification-message'));
  await provider.refreshSharedHistory();
  await settle(provider);
  assert.equal(notifications.length, 1);
  assert.ok(notifications[0].includes('打开聊天'));
  assert.equal(ui.view.visible, true);
  assert.ok(ui.view.shows.includes(false));
  assert.ok(ui.posted.some(value => value.command === 'revealLatest'));
  await provider.refreshSharedHistory(true);
  assert.equal(notifications.length, 1);
});

test('a disposed webview cannot receive an in-flight image snapshot and its replacement gets a fresh reset', async (t) => {
  let releaseImage;
  const imagePending = new Promise(resolve => { releaseImage = resolve; });
  let imageStarted;
  const started = new Promise(resolve => { imageStarted = resolve; });
  const { provider, writer, attachView } = await setup(t, {
    clientOverrides: { async getDecryptedImageUrl() { imageStarted(); return imagePending; } },
  });
  await provider.start();
  const oldView = attachView();
  await oldView.send({ command: 'ready' });
  const imageId = await writer.insertMessage({ ...received('pending-image'), type: 2, content: '[Image]' });
  const syncing = provider.refreshSharedHistory();
  await started;
  const previousPostCount = oldView.posted.length;
  await oldView.dispose();
  const newView = attachView();
  const ready = newView.send({ command: 'ready' });
  releaseImage('data:image/png;base64,YWJj');
  await syncing;
  await ready;
  assert.equal(oldView.posted.length, previousPostCount);
  assert.equal(newView.syncs().at(-1).reset, true);
  assert.deepEqual(newView.syncs().at(-1).messages.map(row => row.id), [imageId]);
});

test('an unreadable image cache does not block text, placeholders or shared unread state', async (t) => {
  const { provider, writer, attachView } = await setup(t, {
    clientOverrides: { async getDecryptedImageUrl() { throw new Error('cache file unavailable'); } },
  });
  await provider.start();
  const ui = attachView();
  await ui.send({ command: 'ready' });
  const textId = await writer.insertMessage(received('text-beside-broken-image'));
  const imageId = await writer.insertMessage({ ...received('broken-image'), type: 2, content: '[Image]' });
  await provider.refreshSharedHistory();
  const update = ui.syncs().at(-1);
  assert.deepEqual(update.messages.map(row => row.id), [textId, imageId]);
  assert.equal(update.messages[1].imageDataUrl, undefined);
  assert.equal(update.messages[1].content, '[Image]');
  assert.equal(update.unreadCount, 2);
  assert.match(statusBarItems[0].text, /QQ.*2/);
  assert.equal(ui.posted.some(value => value.command === 'error'), false);
});

test('media-ready resets still notify for a new received image once without replaying older notifications', async (t) => {
  const imageDataUrl = 'data:image/png;base64,YWJj';
  const { provider, writer, attachView } = await setup(t, {
    clientOverrides: { async getDecryptedImageUrl() { return imageDataUrl; } },
  });
  await provider.start();
  const ui = attachView(false);
  await ui.send({ command: 'ready' });
  const imageId = await writer.insertMessage({ ...received('new-image'), type: 2, content: '[Image]' });
  await writer.markMessageMediaReady(imageId);
  await provider.refreshSharedHistory();
  await settle(provider);
  const update = ui.syncs().at(-1);
  assert.equal(update.reset, true);
  assert.equal(update.messages.find(row => row.id === imageId).imageDataUrl, imageDataUrl);
  assert.equal(notifications.length, 1, 'content-version reset must not suppress a newly arrived image');
  await writer.markMessageMediaReady(imageId);
  await provider.refreshSharedHistory();
  await settle(provider);
  assert.equal(ui.syncs().at(-1).reset, true);
  assert.equal(notifications.length, 1, 're-hydrating an existing image must not notify again');
});

async function seedOlderImagePage(writer) {
  const imageId = await writer.insertMessage({ ...received('older-image'), type: 2, content: '[Image]' });
  const textId = await writer.insertMessage({ ...received('older-text'), content: 'old text' });
  const ids = await Promise.all(Array.from({ length: 100 }, (_, i) => writer.insertMessage(message(`recent-${i}`))));
  return { imageId, textId, beforeId: ids[0] };
}

test('older history refetches normalized text when content changes during image hydration', async (t) => {
  let releaseImage, imageStarted;
  const blockedImage = new Promise(resolve => { releaseImage = resolve; });
  const started = new Promise(resolve => { imageStarted = resolve; });
  let hydrationCount = 0;
  const { provider, writer, db, attachView } = await setup(t, {
    clientOverrides: {
      async getDecryptedImageUrl() {
        hydrationCount++;
        if (hydrationCount === 1) { imageStarted(); return blockedImage; }
        return 'data:image/png;base64,YWJj';
      },
    },
  });
  const { textId, beforeId } = await seedOlderImagePage(writer);
  let pageReads = 0;
  const originalPage = db.getHistoryPage.bind(db);
  db.getHistoryPage = (...args) => { pageReads++; return originalPage(...args); };
  await provider.start();
  const ui = attachView();
  await ui.send({ command: 'ready' });
  const loading = ui.send({ command: 'loadMoreHistory', generation: ui.syncs().at(-1).generation, beforeId });
  await started;
  await writer.normalizeMessageText(value => value === 'old text' ? 'normalized text' : value);
  releaseImage('data:image/png;base64,YWJj');
  await loading;
  const pages = ui.posted.filter(value => value.command === 'loadHistory' && value.older);
  assert.equal(pageReads, 2);
  assert.equal(pages.length, 1, 'the stale page must never reach the UI');
  assert.equal(pages[0].messages.find(row => row.id === textId).content, 'normalized text');
  assert.equal(ui.posted.some(value => value.command === 'historyError'), false);
});

test('repeated content changes stop older-page retry after two attempts and allow a later manual retry', async (t) => {
  let writer, mutate = true, version = 0;
  const context = await setup(t, {
    clientOverrides: {
      async getDecryptedImageUrl() {
        if (mutate) {
          version++;
          await writer.normalizeMessageText(value => value === 'old text' || value.startsWith('changed text ')
            ? `changed text ${version}` : value);
        }
        return 'data:image/png;base64,YWJj';
      },
    },
  });
  ({ writer } = context);
  const { provider, db, attachView } = context;
  const { textId, beforeId } = await seedOlderImagePage(writer);
  let pageReads = 0;
  const originalPage = db.getHistoryPage.bind(db);
  db.getHistoryPage = (...args) => { pageReads++; return originalPage(...args); };
  await provider.start();
  const ui = attachView();
  await ui.send({ command: 'ready' });
  const request = { command: 'loadMoreHistory', generation: ui.syncs().at(-1).generation, beforeId };
  await ui.send(request);
  assert.equal(pageReads, 2);
  assert.equal(ui.posted.filter(value => value.command === 'historyError').length, 1);
  assert.equal(ui.posted.filter(value => value.command === 'loadHistory' && value.older).length, 0);
  mutate = false;
  await ui.send(request);
  const page = ui.posted.find(value => value.command === 'loadHistory' && value.older);
  assert.equal(page.messages.find(row => row.id === textId).content, 'changed text 2');
});

test('disposing the provider releases polling, view listeners and panel-independent subscriptions', async (t) => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const intervals = new Set();
  global.setInterval = callback => {
    const handle = { callback, unref() {} };
    intervals.add(handle);
    return handle;
  };
  global.clearInterval = handle => intervals.delete(handle);
  t.after(() => { global.setInterval = originalSetInterval; global.clearInterval = originalClearInterval; });
  const { provider, writer, clientEvents, attachView } = await setup(t);
  await provider.start();
  const ui = attachView();
  await ui.send({ command: 'ready' });
  assert.equal(intervals.size, 1);
  const poll = [...intervals][0].callback;
  provider.dispose();
  assert.equal(intervals.size, 0);
  assert.equal(statusBarItems[0].disposed, true);
  assert.equal(windowStateEvents.listeners.size, 0);
  for (const event of Object.values(clientEvents)) assert.equal(event.listeners.size, 0);
  assert.equal(ui.inbound.listeners.size, 0);
  const count = ui.posted.length;
  await writer.insertMessage(received('after-disposal'));
  poll();
  await clientEvents.message.fire({ ...received('after-disposal'), id: 1 });
  await settle(provider);
  assert.equal(ui.posted.length, count);
});
