const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ChatDB, message, vscode, configuration, configurationEvents, outputLines, resetVSCodeMocks,
} = require('./runtime.cjs');
const { ChatViewProvider } = require('../src/chat-view-provider.ts');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(t, { clientOverrides = {} } = {}) {
  resetVSCodeMocks();
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-search-provider-'));
  const context = { globalStorageUri: vscode.Uri.file(storage), extensionUri: vscode.Uri.file(path.resolve(__dirname, '..')) };
  const db = new ChatDB(context, 'qq'), writer = new ChatDB(context, 'qq');
  await db.init();
  await writer.init();
  const events = Object.fromEntries(['message', 'status', 'qrcode', 'login'].map(name => [name, new vscode.EventEmitter()]));
  const client = {
    channelName: 'QQ', connected: true,
    onMessage: events.message.event, onStatus: events.status.event,
    onQrCode: events.qrcode.event, onLoginSuccess: events.login.event,
    async getDecryptedImageUrl() {},
    async sendText() { assert.fail('history queries must never send chat messages'); },
    async sendImage() { assert.fail('history queries must never send chat images'); },
    ...clientOverrides,
  };
  const provider = new ChatViewProvider(context, client, db);
  t.after(async () => {
    provider.dispose();
    await provider.historyPending;
    await db.close();
    await writer.close();
    fs.rmSync(storage, { recursive: true, force: true });
  });

  function attachView() {
    const inbound = new vscode.EventEmitter(), disposed = new vscode.EventEmitter(), visibility = new vscode.EventEmitter();
    const posted = [];
    const view = {
      visible: true, show() {}, onDidChangeVisibility: visibility.event, onDidDispose: disposed.event,
      webview: {
        cspSource: 'vscode-webview:', asWebviewUri: value => value.toString(), onDidReceiveMessage: inbound.event,
        postMessage(value) { posted.push(value); return Promise.resolve(true); },
      },
    };
    provider.resolveWebviewView(view, {}, {});
    return {
      posted, send: value => inbound.fire(value), dispose: () => disposed.fire(),
      result: (command, requestId) => posted.find(value => value.command === command && value.requestId === requestId),
    };
  }
  async function ready() {
    await provider.start();
    const ui = attachView();
    await ui.send({ command: 'ready' });
    return ui;
  }
  return { provider, db, writer, attachView, ready };
}

test('search covers all history with descending pagination and forwards type and date filters', async (t) => {
  const { provider, writer, ready } = await setup(t);
  const baseTime = 1_700_000_000;
  const ids = await Promise.all(Array.from({ length: 125 }, (_, i) => writer.insertMessage({
    ...message(`match-${i}`), direction: 'received', content: `literal_% search marker ${i}`,
    type: i % 10 === 0 ? 2 : 1, timestamp: baseTime + i,
  })));
  const ui = await ready();
  const initialStart = provider.historyStartId;
  const initialCursor = { ...provider.syncCursor };
  const initialRead = (await writer.getSyncSnapshot()).readThroughId;
  const initialHistory = ui.posted.find(value => value.command === 'syncMessages');
  assert.equal(initialHistory.messages.length, 100);
  assert.ok(initialHistory.messages[0].id > ids[0]);
  const allMatches = [];
  let beforeId, generation;
  for (let page = 0; page < 3; page++) {
    const requestId = `search-page-${page}`;
    await ui.send({ command: 'searchHistory', requestId, query: 'literal_%', beforeId, generation });
    const result = ui.result('searchResults', requestId);
    assert.ok(result);
    assert.ok(result.messages.length <= 50);
    assert.deepEqual(result.messages.map(row => row.id), result.messages.map(row => row.id).sort((a, b) => b - a));
    allMatches.push(...result.messages.map(row => row.id));
    generation = result.generation;
    beforeId = result.messages.at(-1).id;
    assert.equal(result.hasMore, page < 2);
  }
  assert.deepEqual(allMatches, [...ids].reverse());
  await ui.send({ command: 'searchHistory', requestId: 'filtered', query: 'search marker', type: 2,
    fromTimestamp: baseTime + 50, toTimestamp: baseTime + 71 });
  assert.deepEqual(ui.result('searchResults', 'filtered').messages.map(row => row.id), [ids[70], ids[60], ids[50]]);
  assert.equal(provider.historyStartId, initialStart, 'search must not expand the live history range');
  assert.deepEqual(provider.syncCursor, initialCursor);
  assert.equal((await writer.getSyncSnapshot()).readThroughId, initialRead, 'search must not acknowledge unread chat');
});

test('unloaded quotes resolve by transport ID into a bounded hydrated context without moving live history or read state', async (t) => {
  const hydrated = [];
  const { provider, writer, ready } = await setup(t, {
    clientOverrides: { async getDecryptedImageUrl(id) { hydrated.push(id); return 'data:image/png;base64,YWJj'; } },
  });
  const ids = await Promise.all(Array.from({ length: 135 }, (_, i) => writer.insertMessage({
    ...message(`transport-${i + 1}`), direction: 'received', type: i === 14 ? 2 : 1,
    reference_id: i === 19 ? 'quote-reference' : undefined,
  })));
  const ui = await ready();
  const before = { start: provider.historyStartId, cursor: { ...provider.syncCursor }, read: (await writer.getSyncSnapshot()).readThroughId };
  hydrated.length = 0;
  await ui.send({ command: 'loadMessageContext', requestId: 'old-quote', messageId: 'v1:transport-20' });
  const result = ui.result('messageContext', 'old-quote');
  assert.equal(result.targetId, ids[19]);
  assert.equal(result.messages.length, 21);
  assert.deepEqual(result.messages.map(row => row.id), ids.slice(9, 30));
  assert.equal(result.hasBefore, true);
  assert.equal(result.hasAfter, true);
  assert.deepEqual(hydrated, [ids[14]]);
  assert.equal(result.messages.find(row => row.id === ids[14]).imageDataUrl, 'data:image/png;base64,YWJj');
  await ui.send({ command: 'loadMessageContext', requestId: 'ref-quote', messageId: 'quote-reference', generation: result.generation });
  assert.equal(ui.result('messageContext', 'ref-quote').targetId, ids[19]);
  await ui.send({ command: 'loadMessageContext', requestId: 'id-hit', targetId: ids[19], generation: result.generation });
  assert.equal(ui.result('messageContext', 'id-hit').targetId, ids[19]);
  assert.equal(provider.historyStartId, before.start);
  assert.deepEqual(provider.syncCursor, before.cursor);
  assert.equal((await writer.getSyncSnapshot()).readThroughId, before.read);
});

test('newer search and context requests suppress their own older outstanding results independently', async (t) => {
  const { db, writer, ready } = await setup(t);
  const firstId = await writer.insertMessage({ ...message('alpha'), content: 'alpha' });
  const secondId = await writer.insertMessage({ ...message('beta'), content: 'beta' });
  const ui = await ready();
  const searchStarted = deferred(), searchRelease = deferred();
  const originalSearch = db.searchMessages.bind(db);
  db.searchMessages = async options => {
    const result = await originalSearch(options);
    if (options.query === 'alpha') { searchStarted.resolve(); await searchRelease.promise; }
    return result;
  };
  const oldSearch = ui.send({ command: 'searchHistory', requestId: 'search-old', query: 'alpha' });
  await searchStarted.promise;
  const newSearch = ui.send({ command: 'searchHistory', requestId: 'search-new', query: 'beta' });
  const independentContext = ui.send({ command: 'loadMessageContext', requestId: 'context-independent', targetId: firstId });
  searchRelease.resolve();
  await Promise.all([oldSearch, newSearch, independentContext]);
  assert.equal(ui.posted.some(value => value.requestId === 'search-old'), false);
  assert.deepEqual(ui.result('searchResults', 'search-new').messages.map(row => row.id), [secondId]);
  assert.equal(ui.result('messageContext', 'context-independent').targetId, firstId);

  const contextStarted = deferred(), contextRelease = deferred();
  const originalContext = db.getMessageContext.bind(db);
  db.getMessageContext = async (...args) => {
    const result = await originalContext(...args);
    if (args[0].id === firstId) { contextStarted.resolve(); await contextRelease.promise; }
    return result;
  };
  const oldContext = ui.send({ command: 'loadMessageContext', requestId: 'context-old', targetId: firstId });
  await contextStarted.promise;
  const newContext = ui.send({ command: 'loadMessageContext', requestId: 'context-new', targetId: secondId });
  contextRelease.resolve();
  await Promise.all([oldContext, newContext]);
  assert.equal(ui.posted.some(value => value.requestId === 'context-old'), false);
  assert.equal(ui.result('messageContext', 'context-new').targetId, secondId);
});

test('clear invalidates an in-flight search and its old-generation pagination cursor', async (t) => {
  const { db, writer, ready } = await setup(t);
  const oldId = await writer.insertMessage({ ...message('old'), content: 'needle' });
  const ui = await ready();
  const oldGeneration = (await writer.getSyncSnapshot()).cursor.generation;
  const started = deferred(), release = deferred();
  const originalSearch = db.searchMessages.bind(db);
  let pause = true;
  db.searchMessages = async options => {
    const result = await originalSearch(options);
    if (pause) { started.resolve(); await release.promise; }
    return result;
  };
  const pending = ui.send({ command: 'searchHistory', requestId: 'cleared-search', query: 'needle' });
  await started.promise;
  await writer.clearAll();
  await writer.insertMessage({ ...message('new'), content: 'needle' });
  pause = false;
  release.resolve();
  await pending;
  assert.equal(ui.result('searchResults', 'cleared-search'), undefined);
  assert.ok(ui.result('searchError', 'cleared-search'));
  await ui.send({ command: 'searchHistory', requestId: 'stale-page', query: 'needle', beforeId: oldId, generation: oldGeneration });
  assert.equal(ui.result('searchResults', 'stale-page'), undefined);
  assert.ok(ui.result('searchError', 'stale-page'));
});

test('content normalization invalidates an already-read search snapshot before it reaches the view', async (t) => {
  const { db, writer, ready } = await setup(t);
  await writer.insertMessage({ ...message('old'), content: 'original needle' });
  const ui = await ready();
  const started = deferred(), release = deferred();
  const originalSearch = db.searchMessages.bind(db);
  db.searchMessages = async options => {
    const result = await originalSearch(options);
    started.resolve();
    await release.promise;
    return result;
  };
  const pending = ui.send({ command: 'searchHistory', requestId: 'normalized-search', query: 'needle' });
  await started.promise;
  await writer.normalizeMessageText(value => value.replace('original', 'updated'));
  release.resolve();
  await pending;
  assert.equal(ui.result('searchResults', 'normalized-search'), undefined);
  assert.ok(ui.result('searchError', 'normalized-search'));
});

test('clearing history during context image hydration suppresses the stale context', async (t) => {
  const started = deferred(), release = deferred();
  let pause = false;
  const { writer, ready } = await setup(t, {
    clientOverrides: { async getDecryptedImageUrl() { if (pause) { started.resolve(); await release.promise; } return 'data:image/png;base64,YWJj'; } },
  });
  const imageId = await writer.insertMessage({ ...message('image'), type: 2, content: '[Image]' });
  const ui = await ready();
  // A fresh media revision forces a read; unchanged snapshots now reuse the
  // bounded presentation cache instead of touching the same file again.
  await writer.markMessageMediaReady(imageId);
  pause = true;
  const pending = ui.send({ command: 'loadMessageContext', requestId: 'cleared-context', targetId: imageId });
  await started.promise;
  await writer.clearAll();
  release.resolve();
  await pending;
  assert.equal(ui.result('messageContext', 'cleared-context'), undefined);
  assert.ok(ui.result('contextError', 'cleared-context'));
});

test('query failures stay correlated, preserve unread state and never put query contents in diagnostic logs', async (t) => {
  const { db, writer, ready } = await setup(t);
  await writer.insertMessage({ ...message('unread'), direction: 'received' });
  const ui = await ready();
  const beforeRead = (await writer.getSyncSnapshot()).readThroughId;
  const secret = 'synthetic-private-search-phrase';
  db.searchMessages = async () => { throw new Error(`query failed for ${secret}`); };
  db.getMessageContext = async () => { throw new Error('context database unavailable'); };
  const start = ui.posted.length;
  await ui.send({ command: 'searchHistory', requestId: 'search-failed', query: secret });
  await ui.send({ command: 'loadMessageContext', requestId: 'context-failed', targetId: 1 });
  assert.ok(ui.result('searchError', 'search-failed'));
  assert.ok(ui.result('contextError', 'context-failed'));
  assert.equal(ui.posted.slice(start).some(value => value.command === 'error'), false);
  assert.equal((await writer.getSyncSnapshot()).readThroughId, beforeRead);
  assert.equal(outputLines.some(line => line.includes(secret)), false);
});

test('view replacement and provider disposal suppress outstanding query responses', async (t) => {
  const { provider, db, writer, ready, attachView } = await setup(t);
  const id = await writer.insertMessage(message('target'));
  const oldView = await ready();
  const started = deferred(), release = deferred();
  const originalSearch = db.searchMessages.bind(db);
  db.searchMessages = async options => {
    const result = await originalSearch(options);
    started.resolve();
    await release.promise;
    return result;
  };
  const pending = oldView.send({ command: 'searchHistory', requestId: 'replaced-view', query: '' });
  await started.promise;
  await oldView.dispose();
  const newView = attachView();
  const newReady = newView.send({ command: 'ready' });
  release.resolve();
  await Promise.all([pending, newReady]);
  assert.equal([...oldView.posted, ...newView.posted].some(value => value.requestId === 'replaced-view'), false);

  const contextStarted = deferred(), contextRelease = deferred();
  const originalContext = db.getMessageContext.bind(db);
  db.getMessageContext = async (...args) => {
    const result = await originalContext(...args);
    contextStarted.resolve();
    await contextRelease.promise;
    return result;
  };
  const contextPending = newView.send({ command: 'loadMessageContext', requestId: 'disposed-provider', targetId: id });
  await contextStarted.promise;
  provider.dispose();
  contextRelease.resolve();
  await contextPending;
  assert.equal(newView.posted.some(value => value.requestId === 'disposed-provider'), false);
});

test('send shortcut settings arrive on ready and change live only for the relevant configuration', async (t) => {
  const { provider, ready } = await setup(t);
  const ui = await ready();
  const settings = () => ui.posted.filter(value => value.command === 'settings');
  assert.equal(settings().at(-1).sendShortcut, 'enter');
  const previousCount = settings().length;
  configuration.set('vschat.sendShortcut', 'ctrlEnter');
  await configurationEvents.fire({ affectsConfiguration: name => name === 'editor.fontSize' });
  assert.equal(settings().length, previousCount);
  await configurationEvents.fire({ affectsConfiguration: name => name === 'vschat.sendShortcut' });
  assert.equal(settings().at(-1).sendShortcut, 'ctrlEnter');
  configuration.set('vschat.sendShortcut', 'invalid-shortcut');
  await configurationEvents.fire({ affectsConfiguration: name => name === 'vschat.sendShortcut' });
  assert.equal(settings().at(-1).sendShortcut, 'enter');
  provider.dispose();
  assert.equal(configurationEvents.listeners.size, 0);
});
