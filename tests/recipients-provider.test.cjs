const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ChatDB, message, vscode, openDialogs, saveDialogs, notifications, resetVSCodeMocks,
} = require('./runtime.cjs');
const { ChatViewProvider } = require('../src/chat-view-provider.ts');
const { recipientId } = require('../src/recipient-types.ts');
const { MAX_FILE_BYTES } = require('../src/file-transfer.ts');

const a = { accountId: 'bot', peerId: 'peer-a' }, b = { accountId: 'bot', peerId: 'peer-b' };
const idA = recipientId(a), idB = recipientId(b);
const option = conversation => ({ id: recipientId(conversation), label: conversation.peerId, conversation, canSend: true });
const received = (id, peer, content = `needle ${peer}`) => ({ ...message(id), direction: 'received', content, from_user_id: peer, to_user_id: 'bot' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function setup(t, { rows = [], visible = true } = {}) {
  resetVSCodeMocks();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vschat-recipients-provider-'));
  const context = { globalStorageUri: vscode.Uri.file(root), extensionUri: vscode.Uri.file(path.resolve(__dirname, '..')) };
  const db = new ChatDB(context, 'wechat');
  await db.init();
  const ids = [];
  for (const row of rows) ids.push(await db.insertMessage(row));
  const events = Object.fromEntries(['message', 'status', 'qr', 'login'].map(name => [name, new vscode.EventEmitter()]));
  const sends = [], captures = [], downloads = [];
  const state = { accountId: 'bot', recipients: [option(a), option(b)] };
  const client = {
    channelName: 'WeChat', connected: true, fileCapabilities: { canSend: true, maxBytes: MAX_FILE_BYTES },
    onMessage: events.message.event, onStatus: events.status.event, onQrCode: events.qr.event, onLoginSuccess: events.login.event,
    async getRecipients() {
      const counts = new Map((await db.listConversations(state.accountId)).map(item => [recipientId(item.conversation), item.unreadCount]));
      return { ...state, recipients: state.recipients.map(item => ({ ...item, unreadCount: counts.get(item.id) || 0 })) };
    },
    async captureSendTarget(id) {
      captures.push(id);
      const selected = state.recipients.find(item => item.id === id && item.canSend);
      if (!selected) throw new Error('Recipient is unavailable');
      return Object.freeze({ ...selected.conversation, channel: 'wechat', contextToken: `PRIVATE-${id}`, sessionKey: 'PRIVATE-SESSION' });
    },
    async sendText(text, replyTo, target) { sends.push({ kind: 'text', text, replyTo, target }); },
    async sendImage(filePath, target) { sends.push({ kind: 'image', bytes: fs.readFileSync(filePath), target }); },
    async sendFile(filePath, fileName, target) { sends.push({ kind: 'file', bytes: fs.readFileSync(filePath), fileName, target }); },
    async downloadFile(part) { downloads.push(part); return Buffer.from('payload'); },
    async getDecryptedImageUrl() {},
  };
  const provider = new ChatViewProvider(context, client, db);
  const posted = [], inbound = new vscode.EventEmitter();
  const visibility = new vscode.EventEmitter(), disposed = new vscode.EventEmitter();
  const view = {
    visible, show() { this.visible = true; }, onDidChangeVisibility: visibility.event, onDidDispose: disposed.event,
    webview: { cspSource: 'vscode-webview:', asWebviewUri: value => value.toString(), onDidReceiveMessage: inbound.event,
      postMessage(value) { posted.push(value); return Promise.resolve(true); } },
  };
  provider.resolveWebviewView(view, {}, {});
  await provider.start();
  await inbound.fire({ command: 'ready' });
  t.after(async () => {
    provider.dispose();
    await provider.historyPending;
    await db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let sequence = 0, selection;
  const ui = {
    root, db, ids, client, provider, posted, state, sends, captures, downloads, events, view,
    result: (command, requestId) => posted.filter(value => value.command === command && (requestId === undefined || value.requestId === requestId)).at(-1),
    send: value => inbound.fire(value),
    async scoped(command, fields = {}) {
      const requestId = fields.requestId || `request-${++sequence}`;
      await inbound.fire({ command, ...selection, ...fields, requestId });
      return requestId;
    },
    async select(id, requestId = `selection-${++sequence}`) {
      await inbound.fire({ command: 'selectRecipient', recipientId: id, requestId });
      const result = ui.result('recipientSelected', requestId);
      assert.ok(result, `selection acknowledged: ${id}`);
      selection = { recipientId: result.recipientId, selectionId: result.selectionId };
      return selection;
    },
    async snapshot(conversation) { return db.getSyncSnapshot(undefined, undefined, 100, false, conversation); },
  };
  return ui;
}

test('startup requires an explicit recipient and each selection receives only its own history', async t => {
  const ui = await setup(t, { rows: [received('a', 'peer-a'), received('b', 'peer-b')] });
  assert.equal(ui.posted.some(value => value.command === 'recipientSelected'), false);
  assert.equal(ui.posted.some(value => value.command === 'syncMessages' && value.messages?.length), false);
  assert.ok(ui.result('recipients').recipients.some(item => item.id === '__history__' && !item.canSend));
  await ui.send({ command: 'sendMessage', requestId: 'no-selection', text: 'must not send' });
  assert.equal(ui.result('sendStatus', 'no-selection').sendStatus, 'failed');
  assert.equal(ui.sends.length, 0);
  const selectedA = await ui.select(idA);
  let sync = ui.result('syncMessages');
  assert.deepEqual(sync.messages.map(row => row.id), [ui.ids[0]]);
  assert.equal(sync.recipientId, idA);
  assert.equal(sync.selectionId, selectedA.selectionId);
  await ui.select(idB);
  sync = ui.result('syncMessages');
  assert.deepEqual(sync.messages.map(row => row.id), [ui.ids[1]]);
  assert.equal(sync.recipientId, idB);
  assert.equal(JSON.stringify(ui.posted).includes('PRIVATE-SESSION'), false);
});

test('search, context, file saving and read acknowledgements stay within the selected conversation', async t => {
  const file = { ...received('b-file', 'peer-b'), type: 4, content: 'needle report', parts: [{ type: 4, fileName: 'report.txt', size: 7,
    url: 'https://cdn.qq.com/file', fileMedia: { aesKey: Buffer.alloc(16, 7).toString('base64') } }] };
  const ui = await setup(t, { rows: [received('a', 'peer-a'), received('b', 'peer-b'), file] });
  const selectedA = await ui.select(idA);
  const generation = ui.result('syncMessages').generation;
  const search = await ui.scoped('searchHistory', { query: 'needle' });
  assert.deepEqual(ui.result('searchResults', search).messages.map(row => row.id), [ui.ids[0]]);
  const context = await ui.scoped('loadMessageContext', { targetId: ui.ids[1], generation });
  assert.ok(ui.result('contextError', context));
  const save = await ui.scoped('saveAttachment', { targetId: ui.ids[2], partIndex: 0, generation });
  assert.equal(ui.result('attachmentStatus', save).fileStatus, 'failed');
  assert.equal(saveDialogs.length, 0);
  assert.equal(ui.downloads.length, 0);
  await ui.scoped('markRead', { generation, throughId: ui.ids[0] });
  assert.equal((await ui.snapshot(a)).unreadCount, 0);
  assert.equal((await ui.snapshot(b)).unreadCount, 2);
  await ui.select(idB);
  await ui.send({ command: 'markRead', ...selectedA, generation, throughId: ui.ids[2] });
  assert.equal((await ui.snapshot(b)).unreadCount, 2, 'stale A read acknowledgement cannot clear B unread');
});

test('all-history is a read-only selection and cannot send or acknowledge unrelated unread messages', async t => {
  const ui = await setup(t, { rows: [received('a', 'peer-a'), received('b', 'peer-b')] });
  await ui.select('__history__');
  const sync = ui.result('syncMessages');
  assert.deepEqual(sync.messages.map(row => row.id), ui.ids);
  assert.equal(sync.unreadCount, 0);
  const request = await ui.scoped('sendMessage', { text: 'must not use most recent peer' });
  assert.equal(ui.result('sendStatus', request).sendStatus, 'failed');
  await ui.scoped('markRead', { generation: sync.generation, throughId: ui.ids[1] });
  assert.equal((await ui.snapshot(a)).unreadCount, 1);
  assert.equal((await ui.snapshot(b)).unreadCount, 1);
  assert.equal(ui.sends.length, 0);
});

test('switching recipient while target capture waits cancels before transport', async t => {
  const ui = await setup(t);
  const selectedA = await ui.select(idA);
  const capturing = deferred(), release = deferred();
  ui.client.captureSendTarget = async () => { capturing.resolve(); await release.promise; return { ...a, channel: 'wechat', contextToken: 'SECRET-A' }; };
  const pending = ui.send({ command: 'sendMessage', requestId: 'capture-a', ...selectedA, text: 'for A only' });
  await capturing.promise;
  await ui.select(idB);
  release.resolve();
  await pending;
  assert.equal(ui.sends.length, 0);
  const result = ui.result('sendStatus', 'capture-a');
  assert.equal(result.sendStatus, 'failed');
  assert.equal(result.recipientId, idA);
  assert.equal(result.selectionId, selectedA.selectionId);
});

test('a send already in transport retains its original recipient and status through a contact switch and replay', async t => {
  const ui = await setup(t);
  const selectedA = await ui.select(idA);
  const sending = deferred(), release = deferred();
  ui.client.sendText = async (text, replyTo, target) => { ui.sends.push({ text, replyTo, target }); sending.resolve(); await release.promise; };
  const pending = ui.send({ command: 'sendMessage', requestId: 'sending-a', ...selectedA, text: 'for A only' });
  await sending.promise;
  await ui.select(idB);
  release.resolve();
  await pending;
  await ui.scoped('getSendStatus', { requestId: 'sending-a' });
  assert.equal(ui.sends.length, 1);
  assert.equal(ui.sends[0].target.peerId, a.peerId);
  const results = ui.posted.filter(value => value.command === 'sendStatus' && value.requestId === 'sending-a');
  assert.ok(results.some(value => value.sendStatus === 'sent'));
  for (const result of results) { assert.equal(result.recipientId, idA); assert.equal(result.selectionId, selectedA.selectionId); }
  assert.equal(JSON.stringify(ui.posted).includes('PRIVATE-SESSION'), false);
});

test('pending selection rejects old-recipient sends before its queued selection finishes', async t => {
  const ui = await setup(t);
  const selectedA = await ui.select(idA);
  const refreshing = deferred(), release = deferred();
  const original = ui.client.getRecipients;
  ui.client.getRecipients = async () => { refreshing.resolve(); await release.promise; return original(); };
  const switching = ui.send({ command: 'selectRecipient', recipientId: idB, requestId: 'pending-b' });
  await refreshing.promise;
  await ui.send({ command: 'sendMessage', requestId: 'old-a-during-selection', ...selectedA, text: 'stale draft' });
  release.resolve();
  await switching;
  assert.equal(ui.result('sendStatus', 'old-a-during-selection').sendStatus, 'failed');
  assert.equal(ui.sends.length, 0);
});

test('quoted messages from another recipient cannot be sent even with a valid captured target', async t => {
  const ui = await setup(t, { rows: [received('a-message', 'peer-a'), received('b-message', 'peer-b')] });
  await ui.select(idA);
  const request = await ui.scoped('sendMessage', { text: 'reply', replyTo: { messageId: 'b-message', direction: 'received', text: 'forged B quote' } });
  assert.equal(ui.result('sendStatus', request).sendStatus, 'failed');
  assert.equal(ui.sends.length, 0);
  const valid = await ui.scoped('sendMessage', { text: 'reply', replyTo: { messageId: 'a-message', direction: 'received', text: 'A quote' } });
  assert.equal(ui.result('sendStatus', valid).sendStatus, 'sent');
  assert.equal(ui.sends[0].target.peerId, a.peerId);
});

test('image and staged file sends receive the same explicit captured target as text', async t => {
  const ui = await setup(t);
  const selectedA = await ui.select(idA);
  const image = await ui.scoped('sendImage', { imageData: 'data:image/png;base64,YWJj' });
  assert.equal(ui.result('sendStatus', image).sendStatus, 'sent');
  const file = path.join(ui.root, 'attachment.txt');
  fs.writeFileSync(file, 'file contents');
  vscode.window.nextOpenDialogResult = [vscode.Uri.file(file)];
  const choose = await ui.scoped('selectFile');
  const draft = ui.result('fileSelected', choose).fileDraft;
  await ui.select(idB);
  const wrongOwner = await ui.scoped('sendFile', { fileId: draft.fileId });
  assert.equal(ui.result('sendStatus', wrongOwner).sendStatus, 'failed');
  await ui.select(idA);
  const correct = await ui.scoped('sendFile', { fileId: draft.fileId });
  assert.equal(ui.result('sendStatus', correct).sendStatus, 'sent');
  assert.deepEqual(ui.sends.map(send => [send.kind, send.target.peerId]), [['image', a.peerId], ['file', a.peerId]]);
  assert.equal(ui.result('fileSelected', choose).selectionId, selectedA.selectionId);
});

test('account changes invalidate the selected recipient and never silently choose another account or peer', async t => {
  const ui = await setup(t, { rows: [received('a-message', 'peer-a')] });
  const selectedA = await ui.select(idA);
  ui.state.accountId = 'other-bot';
  ui.state.recipients = [option({ accountId: 'other-bot', peerId: 'peer-a' })];
  await ui.provider.refreshSharedHistory(true);
  assert.ok(ui.result('recipientInvalidated'));
  assert.equal(ui.posted.filter(value => value.command === 'recipientSelected').length, 1);
  await ui.send({ command: 'sendMessage', requestId: 'stale-account', ...selectedA, text: 'old account draft' });
  assert.equal(ui.result('sendStatus', 'stale-account').sendStatus, 'failed');
  assert.equal(ui.sends.length, 0);
});

test('A to B to A does not revive a send authorized by the earlier A selection', async t => {
  const ui = await setup(t);
  const oldA = await ui.select(idA, 'old-a');
  const capturing = deferred(), release = deferred();
  ui.client.captureSendTarget = async () => { capturing.resolve(); await release.promise; return { ...a, channel: 'wechat' }; };
  const pending = ui.send({ command: 'sendMessage', requestId: 'old-a-send', ...oldA, text: 'old A draft' });
  await capturing.promise;
  await ui.select(idB, 'middle-b');
  const newA = await ui.select(idA, 'new-a');
  release.resolve();
  await pending;
  const result = ui.result('sendStatus', 'old-a-send');
  assert.equal(result.sendStatus, 'failed');
  assert.equal(result.recipientId, idA);
  assert.equal(result.selectionId, oldA.selectionId);
  assert.notEqual(result.selectionId, newA.selectionId);
  assert.equal(ui.sends.length, 0);
});

test('switching during quote lookup cancels before transport, while imported quotes are always rejected', async t => {
  const ui = await setup(t, { rows: [received('a-message', 'peer-a')] });
  const selectedA = await ui.select(idA);
  const original = ui.db.getMessageContext.bind(ui.db);
  const reading = deferred(), release = deferred();
  ui.db.getMessageContext = async (...args) => { reading.resolve(); await release.promise; return original(...args); };
  const pending = ui.send({ command: 'sendMessage', requestId: 'quote-before-switch', ...selectedA, text: 'reply',
    replyTo: { messageId: 'a-message', direction: 'received' } });
  await reading.promise;
  await ui.select(idB);
  release.resolve();
  await pending;
  ui.db.getMessageContext = original;
  assert.equal(ui.result('sendStatus', 'quote-before-switch').sendStatus, 'failed');
  assert.equal(ui.sends.length, 0);
  const generation = (await ui.snapshot(a)).cursor.generation;
  await ui.db.appendRestore([{ key: 'archive:imported-quote', originalId: 999,
    message: received('imported-message', 'peer-a', 'imported history') }], generation);
  await ui.select(idA);
  const request = await ui.scoped('sendMessage', { text: 'reply to imported history',
    replyTo: { messageId: 'imported-message', direction: 'received' } });
  assert.equal(ui.result('sendStatus', request).sendStatus, 'failed');
  assert.equal(ui.sends.length, 0);
});

test('the provider freezes a captured target before awaiting authoritative quote lookup', async t => {
  const ui = await setup(t, { rows: [received('a-message', 'peer-a')] });
  const selectedA = await ui.select(idA);
  const target = { ...a, channel: 'wechat', contextToken: 'PRIVATE-A' };
  ui.client.captureSendTarget = async () => target;
  const original = ui.db.getMessageContext.bind(ui.db), reading = deferred(), release = deferred();
  ui.db.getMessageContext = async (...args) => { reading.resolve(); await release.promise; return original(...args); };
  const pending = ui.send({ command: 'sendMessage', requestId: 'frozen-target', ...selectedA, text: 'reply',
    replyTo: { messageId: 'a-message', direction: 'received', text: 'untrusted supplied quote text' } });
  await reading.promise;
  target.peerId = b.peerId;
  target.contextToken = 'PRIVATE-B';
  release.resolve();
  await pending;
  ui.db.getMessageContext = original;
  assert.equal(ui.result('sendStatus', 'frozen-target').sendStatus, 'sent');
  assert.equal(ui.sends[0].target.peerId, a.peerId);
  assert.equal(ui.sends[0].target.contextToken, 'PRIVATE-A');
  assert.equal(Object.isFrozen(ui.sends[0].target), true);
  assert.equal(ui.sends[0].replyTo.text, 'needle peer-a', 'quote body comes from the selected conversation database');
  assert.equal(JSON.stringify(ui.posted).includes('PRIVATE-A'), false);
});

test('a newer selection suppresses an older request still refreshing its recipient list', async t => {
  const ui = await setup(t, { rows: [received('a-message', 'peer-a'), received('b-message', 'peer-b')] });
  const original = ui.client.getRecipients, refreshing = deferred(), release = deferred();
  let calls = 0;
  ui.client.getRecipients = async () => {
    if (++calls === 1) { refreshing.resolve(); await release.promise; }
    return original();
  };
  const first = ui.send({ command: 'selectRecipient', recipientId: idA, requestId: 'slow-a' });
  await refreshing.promise;
  const second = ui.send({ command: 'selectRecipient', recipientId: idB, requestId: 'latest-b' });
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(ui.result('recipientSelected', 'slow-a'), undefined);
  assert.equal(ui.result('recipientSelected', 'latest-b').recipientId, idB);
  assert.deepEqual(ui.result('syncMessages').messages.map(row => row.id), [ui.ids[1]]);
});

test('older history pages remain scoped and stale selection requests cannot page into the new recipient', async t => {
  const rows = Array.from({ length: 105 }, (_, index) => received(`a-${index}`, a.peerId));
  rows.splice(50, 0, received('interleaved-b', b.peerId));
  const ui = await setup(t, { rows });
  const selectedA = await ui.select(idA);
  const sync = ui.result('syncMessages');
  assert.equal(sync.messages.length, 100);
  assert.equal(sync.hasMore, true);
  await ui.scoped('loadMoreHistory', { generation: sync.generation, beforeId: sync.messages[0].id });
  const page = ui.result('loadHistory');
  assert.equal(page.messages.length, 5);
  assert.equal(page.messages.every(row => row.from_user_id === a.peerId), true);
  assert.equal(page.recipientId, idA);
  await ui.select(idB);
  const before = ui.posted.filter(value => value.command === 'loadHistory').length;
  await ui.send({ command: 'loadMoreHistory', ...selectedA, generation: sync.generation, beforeId: sync.messages[0].id });
  assert.equal(ui.posted.filter(value => value.command === 'loadHistory').length, before);
  assert.equal(ui.result('syncMessages').messages.every(row => row.from_user_id === b.peerId), true);
});

test('recipient totals exclude other accounts and a hidden-view notification identifies the actual new recipient', async t => {
  const ui = await setup(t, { visible: false, rows: [received('a-message', a.peerId), received('b-message', b.peerId),
    { ...received('other-account', a.peerId), to_user_id: 'other-bot' }] });
  await ui.select(idA);
  assert.equal(ui.result('recipients').totalUnreadCount, 2);
  notifications.length = 0;
  await ui.db.insertMessage(received('new-for-b', b.peerId));
  vscode.window.nextNotificationAction = '打开聊天';
  await ui.provider.refreshSharedHistory(true);
  for (let i = 0; i < 3; i++) { await ui.provider.historyPending; await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(notifications.length, 1);
  assert.match(notifications[0][0], /peer-b/);
  assert.equal(ui.result('revealRecipient').recipientId, idB);
  assert.equal(ui.result('recipients').totalUnreadCount, 3);
  assert.equal(ui.result('recipientSelected').recipientId, idA, 'notification intent does not silently retarget an existing draft');
});

test('a late ready refresh cannot replace the newer account unread total', async t => {
  const ui = await setup(t, { rows: [received('a', a.peerId), received('b', b.peerId),
    { ...received('other-account', a.peerId), to_user_id: 'other-bot' }] });
  ui.client.getRecipients = async () => ({ accountId: ui.state.accountId, recipients: [...ui.state.recipients] });
  const original = ui.db.getTotalUnreadCount.bind(ui.db), reading = deferred(), release = deferred();
  let blocked = false;
  ui.db.getTotalUnreadCount = async accountId => {
    if (accountId === 'bot' && !blocked) { blocked = true; reading.resolve(); await release.promise; }
    return original(accountId);
  };
  const pending = ui.send({ command: 'ready' });
  await reading.promise;
  ui.state.accountId = 'other-bot';
  ui.state.recipients = [option({ accountId: 'other-bot', peerId: a.peerId })];
  await ui.provider.refreshSharedHistory(true);
  assert.equal(ui.result('recipients').totalUnreadCount, 1);
  release.resolve();
  await pending;
  assert.equal(ui.result('recipients').totalUnreadCount, 1);
  const peers = ui.result('recipients').recipients.filter(item => item.conversation);
  assert.equal(peers.every(item => item.conversation.accountId === 'other-bot'), true);
});
