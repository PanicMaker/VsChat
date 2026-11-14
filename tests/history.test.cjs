const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
require('./runtime.cjs');
const { ChatViewProvider } = require('../src/chat-view-provider.ts');

const message = (id) => ({ id, direction: 'sent', type: 1, content: `text ${id}`, timestamp: 1_700_000_000 });

test('host pagination preserves loaded range on reconnect and loads history while offline', async () => {
  let records = Array.from({ length: 205 }, (_, i) => message(i + 1));
  const sent = [];
  const db = {
    async getChangeStamp() { return String(records.length); },
    async getSyncSnapshot(cursor, historyStartId, _limit, forceReset) {
      const reset = Boolean(forceReset) || !cursor || cursor.contentVersion !== 0;
      const messages = reset
        ? historyStartId === undefined ? records.slice(-100) : records.filter(msg => msg.id >= historyStartId)
        : records.filter(msg => msg.id > cursor.lastId);
      return {
        cursor: { generation: 'fixture-generation', contentVersion: 0, lastId: records.at(-1)?.id || 0 },
        reset, messages, unreadCount: 0, readThroughId: 0,
        ...(reset ? { hasMore: records.some(msg => msg.id < messages[0]?.id) } : {}),
      };
    },
    async getHistoryPage(beforeId, generation) {
      const recordsBefore = records.filter(msg => msg.id < beforeId);
      return { generation, contentVersion: 0, messages: recordsBefore.slice(-100), hasMore: recordsBefore.length > 100 };
    },
  };
  const provider = new ChatViewProvider({}, { connected: false, channelName: 'QQ' }, db);
  provider.view = { webview: { postMessage: (msg) => { sent.push(msg); } } };
  await provider.handleWebViewMessage({ command: 'ready' });
  assert.equal(sent.at(-1).messages[0].id, 106);
  assert.equal(sent.at(-1).hasMore, true);
  await provider.handleWebViewMessage({ command: 'loadMoreHistory', beforeId: 106 });
  assert.equal(sent.at(-1).messages[0].id, 6);
  assert.equal(sent.at(-1).older, true);
  // More than one page arrives while disconnected; reconnect must fill the gap.
  records.push(...Array.from({ length: 150 }, (_, i) => message(206 + i)));
  await provider.loadHistory();
  assert.equal(sent.at(-1).messages.length, 350);
  assert.equal(sent.at(-1).messages[0].id, 6);
  assert.equal(sent.at(-1).messages.at(-1).id, 355);
  await provider.loadHistory(6);
  assert.equal(sent.at(-1).hasMore, false);
  assert.equal(sent.at(-1).messages.length, 5);
});

// Run the actual webview script with a small DOM implementing the APIs it uses.
function webview({ state: initialState, channel = 'QQ', deferFileReads = false } = {}) {
  const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  let state = clone(initialState);
  const resizeObservers = [];
  function listen(target, name, callback) {
    const previous = target[name];
    target[name] = previous ? (event) => { previous(event); callback(event); } : callback;
  }
  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase();
      this.children = []; this.dataset = {}; this.style = {}; this.events = {};
      this.value = ''; this._scrollTop = 0; this.clientHeight = 40;
      this.attributes = {};
      const classes = new Set();
      Object.defineProperty(this, 'className', {
        get: () => [...classes].join(' '),
        set: (value) => {
          classes.clear();
          String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
        },
      });
      this.classList = {
        add: (x) => classes.add(x), remove: (x) => classes.delete(x), contains: (x) => classes.has(x),
        toggle: (x, enabled) => {
          if (enabled === undefined) enabled = !classes.has(x);
          enabled ? classes.add(x) : classes.delete(x);
        },
      };
    }
    set innerHTML(value) { this.replaceChildren(); }
    get ownerDocument() { return document; }
    get childNodes() { return this.children; }
    get firstChild() { return this.children[0] || null; }
    get firstElementChild() { return this.children[0] || null; }
    replaceChildren(...nodes) {
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      nodes.forEach(node => this.appendChild(node));
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this[name]; delete this.attributes[name]; }
    get scrollHeight() { return this.children.reduce((height, child) => height + (child.layoutHeight || 20), 0); }
    get scrollTop() { return this._scrollTop; }
    set scrollTop(value) { this._scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
    getBoundingClientRect() {
      if (this === container) return { top: 0, bottom: this.clientHeight };
      const rowIndex = element('messages').children.indexOf(this);
      const top = rowIndex < 0 ? 0 : 20 + element('messages').children.slice(0, rowIndex)
        .reduce((height, child) => height + (child.layoutHeight || 20), 0) - container.scrollTop;
      return { top, bottom: top + (this.layoutHeight || 20) };
    }
    appendChild(el) { return this.insertBefore(el, null); }
    insertBefore(el, reference) {
      if (el.tagName === '#FRAGMENT') {
        [...el.children].forEach(child => this.insertBefore(child, reference));
        return el;
      }
      if (el.parentNode) el.parentNode.removeChild(el);
      const index = reference === null ? this.children.length : this.children.indexOf(reference);
      assert.notEqual(index, -1, 'insertBefore reference must belong to the parent');
      this.children.splice(index, 0, el);
      el.parentNode = this;
      return el;
    }
    removeChild(el) {
      const index = this.children.indexOf(el);
      assert.notEqual(index, -1, 'removeChild target must belong to the parent');
      this.children.splice(index, 1);
      el.parentNode = null;
      return el;
    }
    addEventListener(name, callback) { listen(this.events, name, callback); }
    querySelector() { return null; }
    focus() { this.focused = true; }
    scrollIntoView(options) { this.scrolledIntoView = options; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    click() {
      if (!this.disabled) this.events.click?.({ target: this, stopPropagation() {}, preventDefault() {} });
    }
  }
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const container = element('chat-container');
  for (const id of ['search-panel', 'search-context', 'search-more', 'data-panel', 'restore-preview', 'cleanup-summary']) element(id).classList.add('hidden');
  element('backup-images').checked = true;
  Object.defineProperty(container, 'scrollHeight', {
    get: () => element('messages').scrollHeight + 20,
  });
  const events = {}, documentEvents = {}, outbound = [], readers = [], timers = new Map();
  let nextTimer = 0;
  const document = {
    body: new Element(), getElementById: element, createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element('#fragment'),
    createTextNode: (text) => { const node = new Element('#text'); node.textContent = text; return node; },
    querySelectorAll: () => [], addEventListener: (name, callback) => listen(documentEvents, name, callback),
    hidden: false, visibilityState: 'visible',
  };
  const context = vm.createContext({
    acquireVsCodeApi: () => ({
      getState: () => clone(state), setState: (value) => { state = clone(value); },
      postMessage: (msg) => outbound.push(clone(msg)),
    }),
    document,
    window: { addEventListener: (name, callback) => listen(events, name, callback) },
    FileReader: class {
      readAsDataURL(file) {
        this.complete = () => { this.result = file.data; this.onload({ target: this }); };
        if (deferFileReads) readers.push(this); else this.complete();
      }
    },
    crypto: require('node:crypto').webcrypto,
    URL,
    ResizeObserver: class {
      constructor(callback) { resizeObservers.push(callback); }
      observe() {}
      disconnect() {}
    },
    setTimeout: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id) => timers.delete(id), console,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../webview/rich-content.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../webview/main.js'), 'utf8'), context);
  const ui = {
    element, outbound, readers,
    state: () => clone(state),
    receive: (data) => events.message({ data }),
    ids: () => element('messages').children.filter((el) => el.dataset.id).map((el) => el.dataset.id),
    setHidden: (hidden) => {
      document.hidden = hidden;
      document.visibilityState = hidden ? 'hidden' : 'visible';
      documentEvents.visibilitychange?.({});
    },
    focusWindow: () => events.focus?.({}),
    dropFiles: (files, name = 'drop') => {
      let prevented = false;
      const dataTransfer = { files, types: ['Files'] };
      events[name]?.({ dataTransfer, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
      return { prevented, dataTransfer };
    },
    keyDown: (key, details = {}) => {
      let prevented = false;
      documentEvents.keydown?.({ key, ...details, preventDefault() { prevented = true; }, stopPropagation() {} });
      return prevented;
    },
    resize: () => resizeObservers.forEach(callback => callback([])),
    runTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(callback => callback());
    },
  };
  if (channel) ui.receive({ command: 'channel', channel });
  return ui;
}

function writeDraft(ui, text) {
  const input = ui.element('text-input');
  input.value = text;
  input.events.input?.({ target: input });
}

function selectQuote(ui) {
  ui.receive({ command: 'newMessage', message: { ...message(1), direction: 'received', message_id: 'quoted-message' } });
  const row = ui.element('messages').children.find(el => el.dataset.id === 1);
  row.children.find(el => el.className === 'quote-action').click();
}

function sends(ui) {
  return ui.outbound.filter(msg => ['sendMessage', 'sendImage', 'sendFile'].includes(msg.command));
}

function pasteImage(ui, data = 'data:image/png;base64,YWJj') {
  const file = { type: 'image/png', size: 3, data };
  ui.element('text-input').events.paste({ clipboardData: { files: [file] }, preventDefault() {} });
  return file;
}

test('pasting an image stages bytes until confirmed and preserves the text draft', () => {
  const ui = webview(), input = ui.element('text-input');
  input.value = 'draft';
  const file = { type: 'image/png', size: 3, data: 'data:image/png;base64,YWJj' };
  const paste = () => input.events.paste({ clipboardData: { files: [file] }, preventDefault() {} });
  input.events.paste({ clipboardData: { files: [] }, preventDefault() { assert.fail('plain text paste blocked'); } });
  paste();
  assert.equal(ui.element('paste-preview').src, file.data);
  ui.element('paste-cancel').click();
  assert.equal(ui.element('paste-preview').src, undefined);
  paste();
  assert.equal(ui.outbound.filter(m => m.command === 'sendImage').length, 0);
  ui.element('send-btn').click();
  assert.equal(ui.outbound.at(-1).imageData, file.data);
  assert.equal(ui.outbound.at(-1).command, 'sendImage');
  assert.equal(input.value, 'draft');
});

test('sent images render inline live and after history reload, with full-size preview', () => {
  const data = 'data:image/png;base64,AA==';
  const msg = { id: 1, direction: 'sent', type: 2, content: '[Image]', timestamp: 1_700_000_000, imageDataUrl: data };
  function images(el) {
    return [...(el.className === 'message-image' ? [el] : []), ...el.children.flatMap(images)];
  }
  const ui = webview();
  ui.receive({ command: 'newMessage', message: msg });
  const rendered = images(ui.element('messages'));
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].src, data);
  rendered[0].click();
  assert.equal(ui.element('lightbox-img').src, data);
  const reloaded = webview();
  reloaded.receive({ command: 'loadHistory', messages: [msg], hasMore: false });
  assert.equal(images(reloaded.element('messages'))[0].src, data);
  reloaded.receive({ command: 'newMessage', message: { ...msg, id: 2, imageDataUrl: undefined } });
  assert.equal(images(reloaded.element('messages')).length, 1);
});

test('webview merges live messages, older pages and reconnect snapshots without dropping or duplicating rows', () => {
  const ui = webview();
  ui.receive({ command: 'loadHistory', messages: [message(3), message(4)], hasMore: true });
  ui.receive({ command: 'newMessage', message: message(5) });
  ui.receive({ command: 'loadHistory', messages: [message(3), message(4)], hasMore: true });
  assert.deepEqual(ui.ids(), [3, 4, 5]);
  const container = ui.element('chat-container');
  container.scrollTop = 5;
  const oldHeight = container.scrollHeight;
  ui.element('load-more-history').click();
  assert.equal(ui.outbound.at(-1).beforeId, 3);
  ui.receive({ command: 'loadHistory', messages: [message(1), message(2)], hasMore: false, older: true });
  assert.deepEqual(ui.ids(), [1, 2, 3, 4, 5]);
  assert.equal(container.scrollTop, 5 + container.scrollHeight - oldHeight);
  ui.receive({ command: 'newMessage', message: message(5) });
  assert.deepEqual(ui.ids(), [1, 2, 3, 4, 5]);
  ui.receive({ command: 'newMessage', message: message(8) });
  ui.receive({ command: 'newMessage', message: message(7) });
  ui.receive({ command: 'loadHistory', messages: [message(4), message(5), message(6)], hasMore: false });
  assert.deepEqual(ui.ids(), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(ui.element('load-more-history').classList.contains('hidden'));
});

test('pagination failure allows retry; clearing history resets the list', () => {
  const ui = webview();
  ui.receive({ command: 'loadHistory', messages: [message(10)], hasMore: true });
  ui.element('load-more-history').click();
  assert.equal(ui.element('load-more-history').disabled, true);
  ui.receive({ command: 'historyError' });
  assert.equal(ui.element('load-more-history').disabled, false);
  ui.element('load-more-history').click();
  assert.equal(ui.outbound.at(-1).beforeId, 10);
  ui.receive({ command: 'clearHistory' });
  assert.deepEqual(ui.ids(), []);
  ui.receive({ command: 'newMessage', message: message(11) });
  assert.deepEqual(ui.ids(), [11]);
});

test('text and quote survive sending and unrelated results; matching success clears them once', () => {
  const ui = webview();
  writeDraft(ui, 'first line\nsecond line');
  selectQuote(ui);
  ui.element('send-btn').click();
  ui.element('send-btn').click();
  assert.equal(sends(ui).length, 1, 'a second click while sending must not submit again');
  const request = sends(ui)[0];
  assert.ok(request.requestId);
  assert.equal(request.text, 'first line\nsecond line');
  assert.equal(request.replyTo.messageId, 'quoted-message');
  assert.equal(ui.element('text-input').value, request.text);
  assert.equal(ui.element('quote-bar').classList.contains('hidden'), false);
  ui.receive({ command: 'sendStatus', requestId: 'another-request', sendStatus: 'sent' });
  assert.equal(ui.element('text-input').value, request.text);
  ui.receive({ command: 'sendStatus', requestId: request.requestId, sendStatus: 'sent' });
  assert.equal(ui.element('text-input').value, '');
  assert.equal(ui.element('quote-bar').classList.contains('hidden'), true);
  writeDraft(ui, 'next message');
  ui.receive({ command: 'sendStatus', requestId: request.requestId, sendStatus: 'sent' });
  assert.equal(ui.element('text-input').value, 'next message');
});

test('success for an older text snapshot does not erase a newer editor value', () => {
  const ui = webview();
  writeDraft(ui, 'original');
  ui.element('send-btn').click();
  const request = sends(ui)[0];
  // A stale acknowledgement must not erase input even if code changed a locked editor.
  ui.element('text-input').value = 'newer draft';
  ui.receive({ command: 'sendStatus', requestId: request.requestId, sendStatus: 'sent' });
  assert.equal(ui.element('text-input').value, 'newer draft');
});

test('failed and uncertain sends retain draft and quote until an explicit retry', () => {
  const ui = webview();
  writeDraft(ui, 'keep this');
  selectQuote(ui);
  ui.element('send-btn').click();
  const first = sends(ui)[0];
  ui.receive({ command: 'sendStatus', requestId: first.requestId, sendStatus: 'failed', error: 'Disconnected' });
  assert.equal(ui.element('text-input').value, 'keep this');
  assert.equal(ui.element('quote-bar').classList.contains('hidden'), false);
  assert.equal(sends(ui).length, 1);
  assert.equal(ui.element('retry-send').classList.contains('hidden'), false);
  ui.element('retry-send').click();
  const second = sends(ui).at(-1);
  assert.equal(sends(ui).length, 2);
  assert.notEqual(second.requestId, first.requestId);
  assert.equal(second.replyTo.messageId, 'quoted-message');
  ui.receive({ command: 'sendStatus', requestId: second.requestId, sendStatus: 'uncertain', error: 'Timeout' });
  assert.equal(ui.element('text-input').value, 'keep this');
  assert.equal(sends(ui).length, 2, 'uncertain results must never automatically resend');
  assert.match(ui.element('retry-send').textContent, /重复/);
});

test('confirming an uncertain delivery releases the draft without sending again', () => {
  const ui = webview();
  writeDraft(ui, 'already received');
  ui.element('send-btn').click();
  const request = sends(ui)[0];
  ui.receive({ command: 'sendStatus', requestId: request.requestId, sendStatus: 'uncertain' });
  assert.equal(ui.element('confirm-send').classList.contains('hidden'), false);
  ui.element('confirm-send').click();
  assert.equal(sends(ui).length, 1);
  assert.equal(ui.element('text-input').value, '');
  assert.equal(ui.element('send-btn').disabled, false);
  assert.equal(ui.element('confirm-send').classList.contains('hidden'), true);
  assert.match(ui.element('send-status').textContent, /已确认/);
  const restored = webview({ state: ui.state() });
  assert.equal(restored.outbound.some(msg => msg.command === 'getSendStatus'), false);
});

test('image send failure preserves bytes; image success keeps the separate text and quote draft', () => {
  const ui = webview();
  writeDraft(ui, 'separate text');
  selectQuote(ui);
  const file = pasteImage(ui);
  ui.element('send-btn').click();
  const first = sends(ui)[0];
  assert.equal(first.command, 'sendImage');
  assert.equal(ui.element('paste-preview').src, file.data);
  ui.receive({ command: 'sendStatus', requestId: first.requestId, sendStatus: 'failed', error: 'Invalid image' });
  assert.equal(ui.element('paste-preview').src, file.data);
  ui.element('retry-send').click();
  const retry = sends(ui).at(-1);
  assert.equal(retry.imageData, file.data);
  ui.receive({ command: 'sendStatus', requestId: retry.requestId, sendStatus: 'sent' });
  assert.equal(ui.element('paste-preview').src, undefined);
  assert.equal(ui.element('text-input').value, 'separate text');
  assert.equal(ui.element('quote-bar').classList.contains('hidden'), false);
});

test('file selection stages an image and a cancelled read cannot replace a later draft', () => {
  const ui = webview({ deferFileReads: true });
  const file = { name: 'chosen.png', type: 'image/png', size: 3, data: 'data:image/png;base64,YWJj' };
  ui.element('file-input').events.change({ target: { files: [file] } });
  assert.equal(sends(ui).length, 0);
  ui.element('paste-cancel').click();
  const later = pasteImage(ui, 'data:image/png;base64,ZGVm');
  ui.readers[1].complete();
  ui.readers[0].complete();
  assert.equal(ui.element('paste-preview').src, later.data);
  assert.equal(sends(ui).length, 0);
});

test('drafts survive recreation and display mode changes while remaining isolated by channel', () => {
  const ui = webview();
  writeDraft(ui, 'QQ multiline\ndraft');
  selectQuote(ui);
  const file = pasteImage(ui);
  const modeButton = { dataset: { mode: 'log' } };
  ui.element('toolbar').events.click({ target: { closest: () => modeButton } });
  const restored = webview({ state: ui.state() });
  assert.equal(restored.element('text-input').value, 'QQ multiline\ndraft');
  assert.equal(restored.element('paste-preview').src, file.data);
  const wechat = webview({ state: restored.state(), channel: 'WeChat' });
  assert.equal(wechat.element('text-input').value, '');
  assert.equal(wechat.element('paste-preview').src, undefined);
  writeDraft(wechat, 'WeChat draft');
  const qqAgain = webview({ state: wechat.state() });
  assert.equal(qqAgain.element('text-input').value, 'QQ multiline\ndraft');
  qqAgain.element('toolbar').events.click({ target: { closest: () => ({ dataset: { mode: 'chat' } }) } });
  assert.equal(qqAgain.element('quote-bar').classList.contains('hidden'), false);
});

test('recreated pending sends query the original request without resending and clear after known success', () => {
  const ui = webview();
  writeDraft(ui, 'awaiting acknowledgement');
  ui.element('send-btn').click();
  const request = sends(ui)[0];
  const restored = webview({ state: ui.state() });
  assert.equal(sends(restored).length, 0);
  assert.equal(restored.outbound.find(msg => msg.command === 'getSendStatus')?.requestId, request.requestId);
  assert.equal(restored.element('text-input').value, 'awaiting acknowledgement');
  restored.receive({ command: 'sendStatus', requestId: request.requestId, sendStatus: 'sent' });
  assert.equal(restored.element('text-input').value, '');
});

test('Enter sends multiline text while Shift+Enter and IME confirmation stay in the editor', () => {
  const ui = webview();
  writeDraft(ui, 'line one\nline two');
  const input = ui.element('text-input');
  for (const modifiers of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    input.events.keydown({ key: 'Enter', ...modifiers, preventDefault() { assert.fail('editing key was intercepted'); } });
  }
  assert.equal(sends(ui).length, 0);
  let prevented = false;
  input.events.keydown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(sends(ui)[0].text, 'line one\nline two');
});

test('incoming messages preserve reading position and count unique unread messages until opened', () => {
  const ui = webview();
  ui.receive({ command: 'loadHistory', messages: Array.from({ length: 20 }, (_, i) => message(i + 1)), hasMore: true });
  const container = ui.element('chat-container');
  container.scrollTop = 35;
  container.events.scroll?.({});
  const incoming = { ...message(21), direction: 'received' };
  ui.receive({ command: 'newMessage', message: incoming });
  assert.equal(container.scrollTop, 35);
  assert.match(ui.element('new-messages').textContent, /1/);
  ui.receive({ command: 'newMessage', message: incoming });
  ui.receive({ command: 'newMessage', message: message(22) });
  assert.match(ui.element('new-messages').textContent, /1/);
  assert.equal(container.scrollTop, 35);
  ui.receive({ command: 'newMessage', message: { ...message(23), direction: 'received' } });
  assert.match(ui.element('new-messages').textContent, /2/);
  ui.element('new-messages').click();
  assert.equal(container.scrollTop, container.scrollHeight - container.clientHeight);
  assert.equal(ui.element('new-messages').classList.contains('hidden'), true);
  ui.receive({ command: 'newMessage', message: { ...message(24), direction: 'received' } });
  assert.equal(container.scrollTop, container.scrollHeight - container.clientHeight);
  assert.equal(ui.element('new-messages').classList.contains('hidden'), true);
});

test('reconnect and older pages preserve position without counting existing or historical rows as unread', () => {
  const ui = webview();
  const records = Array.from({ length: 20 }, (_, i) => message(i + 10));
  ui.receive({ command: 'loadHistory', messages: records, hasMore: true });
  const container = ui.element('chat-container');
  container.scrollTop = 30;
  const incoming = { ...message(31), direction: 'received' };
  ui.receive({ command: 'newMessage', message: incoming });
  ui.receive({ command: 'loadHistory', messages: [...records, incoming, { ...message(32), direction: 'received' }], hasMore: true });
  assert.equal(container.scrollTop, 30);
  assert.match(ui.element('new-messages').textContent, /2/);
  const oldHeight = container.scrollHeight;
  ui.receive({ command: 'loadHistory', messages: [{ ...message(9), direction: 'received' }], older: true, hasMore: false });
  assert.equal(container.scrollTop, 30 + container.scrollHeight - oldHeight);
  assert.match(ui.element('new-messages').textContent, /2/);
  container.scrollTop = container.scrollHeight;
  container.events.scroll({});
  assert.equal(ui.element('new-messages').classList.contains('hidden'), true);
});

test('reconnect counts a missed received message even when a newer live message arrived first', () => {
  const ui = webview();
  const records = Array.from({ length: 20 }, (_, i) => message(i + 1));
  ui.receive({ command: 'loadHistory', messages: records, hasMore: false });
  const container = ui.element('chat-container');
  container.scrollTop = 35;
  container.events.scroll({});
  const missed = { ...message(21), direction: 'received' };
  const latest = { ...message(22), direction: 'received' };
  ui.receive({ command: 'newMessage', message: latest });
  ui.receive({ command: 'loadHistory', messages: [...records, missed, latest], hasMore: false });
  assert.match(ui.element('new-messages').textContent, /2/);
  assert.equal(container.scrollTop, 35);
  ui.receive({ command: 'loadHistory', messages: [...records, missed, latest], hasMore: false });
  assert.match(ui.element('new-messages').textContent, /2/);
});

test('first hydration after an early live event does not count historical messages as new', () => {
  const ui = webview();
  ui.setHidden(true);
  const latest = { ...message(21), direction: 'received' };
  ui.receive({ command: 'newMessage', message: latest });
  const records = Array.from({ length: 20 }, (_, i) => ({ ...message(i + 1), direction: 'received' }));
  ui.receive({ command: 'loadHistory', messages: [...records, latest], hasMore: false });
  assert.match(ui.element('new-messages').textContent, /\b1\b/);
});

test('an out-of-order insertion above the viewport keeps the same message at the same offset', () => {
  const ui = webview();
  ui.receive({ command: 'loadHistory', messages: Array.from({ length: 20 }, (_, i) => message((i + 1) * 10)), hasMore: false });
  const container = ui.element('chat-container');
  container.scrollTop = 135;
  container.events.scroll({});
  const before = ui.element('messages').children.find(el => el.dataset.id === 60).getBoundingClientRect().top;
  ui.receive({ command: 'newMessage', message: { ...message(15), direction: 'received' } });
  const after = ui.element('messages').children.find(el => el.dataset.id === 60).getBoundingClientRect().top;
  assert.equal(after, before);
  assert.equal(container.scrollTop, 155);
  assert.match(ui.element('new-messages').textContent, /1/);
});

test('hidden views retain unread arrivals and clearing history resets counters and date separators', () => {
  const ui = webview();
  ui.receive({ command: 'loadHistory', messages: [message(1)], hasMore: false });
  ui.setHidden(true);
  ui.receive({ command: 'newMessage', message: { ...message(2), direction: 'received' } });
  assert.equal(ui.element('new-messages').classList.contains('hidden'), false);
  assert.match(ui.element('new-messages').textContent, /1/);
  ui.receive({ command: 'clearHistory' });
  assert.equal(ui.element('new-messages').classList.contains('hidden'), true);
  ui.receive({ command: 'newMessage', message: message(3) });
  assert.equal(ui.element('messages').children.filter(el => el.className === 'date-separator').length, 1);
});

function sync(ui, overrides = {}) {
  ui.receive({
    command: 'syncMessages', generation: 'generation-a', reset: false,
    messages: [], unreadCount: 0, readThroughId: 0, ...overrides,
  });
}

const readReports = ui => ui.outbound.filter(msg => msg.command === 'markRead');

test('shared deltas append without rebuilding earlier rows and unread waits for the host acknowledgement', () => {
  const ui = webview();
  const records = Array.from({ length: 20 }, (_, i) => message(i + 1));
  sync(ui, { reset: true, messages: records, hasMore: true });
  const container = ui.element('chat-container');
  container.scrollTop = 35;
  container.events.scroll({});
  ui.receive({ command: 'hostFocus', focused: true });
  const originalRow = ui.element('messages').children.find(el => el.dataset.id === 20);
  const incoming = { ...message(21), direction: 'received' };
  sync(ui, { messages: [incoming], unreadCount: 3 });
  assert.equal(ui.element('messages').children.find(el => el.dataset.id === 20), originalRow);
  assert.equal(container.scrollTop, 35);
  assert.match(ui.element('new-messages').textContent, /3 条/);
  assert.equal(ui.element('load-more-history').classList.contains('hidden'), false);
  assert.equal(readReports(ui).length, 0);
  ui.element('new-messages').click();
  assert.deepEqual(readReports(ui), [{ command: 'markRead', generation: 'generation-a', throughId: 21 }]);
  assert.match(ui.element('new-messages').textContent, /3 条/, 'scrolling does not optimistically clear a shared unread count');
  container.events.scroll({});
  assert.equal(readReports(ui).length, 1, 'the same rendered range is acknowledged only once');
  sync(ui, { unreadCount: 0, readThroughId: 21 });
  assert.equal(ui.element('new-messages').classList.contains('hidden'), true);
  assert.equal(readReports(ui).length, 1);
});

test('duplicate and updated shared messages merge by ID without double counting unread or shifting the viewport', () => {
  const ui = webview();
  const records = Array.from({ length: 20 }, (_, i) => message((i + 1) * 10));
  sync(ui, { reset: true, messages: records, unreadCount: 2 });
  const container = ui.element('chat-container');
  container.scrollTop = 135;
  container.events.scroll({});
  const originalTop = ui.element('messages').children.find(el => el.dataset.id === 60).getBoundingClientRect().top;
  sync(ui, { messages: [{ ...message(15), direction: 'received' }, { ...message(60), content: 'updated text' }], unreadCount: 3 });
  const updatedRow = ui.element('messages').children.find(el => el.dataset.id === 60);
  assert.equal(updatedRow.getBoundingClientRect().top, originalTop);
  assert.equal(updatedRow.children.find(el => el.className === 'msg-text').textContent, 'updated text');
  sync(ui, { messages: [message(15)], unreadCount: 3 });
  assert.equal(ui.ids().filter(id => id === 15).length, 1);
  assert.match(ui.element('new-messages').textContent, /3 条/);
});

test('shared reads require host focus, document visibility and a visible chat at the latest message', () => {
  const ui = webview();
  sync(ui, { reset: true, messages: [message(7)], unreadCount: 1 });
  assert.equal(readReports(ui).length, 0, 'focus is unknown until the host explicitly supplies it');
  ui.focusWindow();
  assert.equal(ui.outbound.at(-1).command, 'requestSync');
  assert.equal(readReports(ui).length, 0, 'webview focus cannot stand in for host focus');
  ui.setHidden(true);
  ui.receive({ command: 'hostFocus', focused: true });
  assert.equal(readReports(ui).length, 0);
  ui.setHidden(false);
  assert.equal(readReports(ui).at(-1).throughId, 7);
  sync(ui, { readThroughId: 7, unreadCount: 0 });
  ui.receive({ command: 'hostFocus', focused: false });
  sync(ui, { messages: [message(8)], unreadCount: 1, readThroughId: 7 });
  assert.equal(readReports(ui).length, 1);
  ui.element('chat-container').classList.add('hidden');
  ui.receive({ command: 'hostFocus', focused: true });
  assert.equal(readReports(ui).length, 1);
  ui.receive({ command: 'revealLatest' });
  assert.equal(readReports(ui).at(-1).throughId, 8);
  assert.equal(ui.element('text-input').focused, true);
});

test('reading progress is bounded by rendered messages and a storage error retries only on later interaction', () => {
  const ui = webview();
  ui.receive({ command: 'hostFocus', focused: true });
  sync(ui, { reset: true, messages: [message(9), message(10)], unreadCount: 50 });
  assert.equal(readReports(ui).at(-1).throughId, 10);
  ui.receive({ command: 'readStateError', generation: 'generation-a' });
  assert.equal(readReports(ui).length, 1, 'failure does not immediately resubmit');
  ui.element('chat-container').events.scroll({});
  assert.equal(readReports(ui).length, 2);
  assert.equal(readReports(ui).at(-1).throughId, 10);
  sync(ui, { unreadCount: 0, readThroughId: 50 });
  ui.receive({ command: 'readStateError', generation: 'generation-a' });
  ui.element('chat-container').events.scroll({});
  assert.equal(readReports(ui).length, 2, 'another window already read beyond our loaded range');
});

test('a shared clear replaces history but preserves drafts and rejects retired snapshots and pages', () => {
  const ui = webview();
  writeDraft(ui, 'preserved text');
  selectQuote(ui);
  const image = pasteImage(ui);
  sync(ui, { reset: true, messages: [message(10), message(11)], hasMore: true, unreadCount: 2 });
  ui.element('load-more-history').click();
  assert.deepEqual(ui.outbound.at(-1), { command: 'loadMoreHistory', beforeId: 10, generation: 'generation-a' });
  sync(ui, { generation: 'generation-b', reset: true, messages: [], hasMore: false });
  assert.deepEqual(ui.ids(), []);
  assert.equal(ui.element('text-input').value, 'preserved text');
  assert.equal(ui.element('paste-preview').src, image.data);
  assert.equal(ui.element('quote-bar').classList.contains('hidden'), false);
  assert.equal(ui.element('load-more-history').disabled, false);
  ui.receive({ command: 'loadHistory', generation: 'generation-a', messages: [message(2)], older: true, hasMore: false });
  sync(ui, { generation: 'generation-a', reset: true, messages: [message(10)], unreadCount: 8 });
  ui.receive({ command: 'newMessage', message: message(30) });
  assert.deepEqual(ui.ids(), []);
  assert.equal(ui.element('new-messages').classList.contains('hidden'), true);
  sync(ui, { generation: 'generation-b', messages: [message(12)], unreadCount: 1 });
  assert.deepEqual(ui.ids(), [12]);
  assert.equal(ui.element('messages').children.filter(el => el.className === 'date-separator').length, 1);
});

test('unknown-generation deltas request a fresh snapshot and cannot resurrect a cleared list', () => {
  const ui = webview();
  sync(ui, { reset: true, messages: [message(2)] });
  sync(ui, { generation: 'generation-b', messages: [message(3)], unreadCount: 9 });
  assert.deepEqual(ui.ids(), [2]);
  assert.equal(ui.outbound.at(-1).command, 'requestSync');
  sync(ui, { generation: 'generation-b', reset: true, messages: [message(3)] });
  sync(ui, { generation: 'generation-a', messages: [message(4)] });
  assert.deepEqual(ui.ids(), [3]);
});

test('same-generation replacement preserves the visible anchor and versioned pagination keeps shared unread', () => {
  const ui = webview();
  const records = Array.from({ length: 20 }, (_, i) => message(i + 10));
  sync(ui, { reset: true, messages: records, hasMore: true, unreadCount: 3 });
  const container = ui.element('chat-container');
  container.scrollTop = 135;
  container.events.scroll({});
  const originalTop = ui.element('messages').children.find(el => el.dataset.id === 15).getBoundingClientRect().top;
  ui.element('load-more-history').click();
  assert.equal(ui.element('load-more-history').disabled, true);
  sync(ui, { reset: true, messages: records.map(msg => ({ ...msg, content: 'normalized ' + msg.id })), hasMore: true, unreadCount: 3 });
  assert.equal(ui.element('load-more-history').disabled, false, 'a replacement releases an invalidated older-page request');
  assert.equal(ui.element('messages').children.find(el => el.dataset.id === 15).getBoundingClientRect().top, originalTop);
  ui.receive({ command: 'loadHistory', generation: 'generation-a', messages: [message(9)], older: true, hasMore: false });
  assert.deepEqual(ui.ids(), [9, ...records.map(msg => msg.id)]);
  assert.equal(ui.element('messages').children.find(el => el.dataset.id === 15).getBoundingClientRect().top, originalTop);
  assert.match(ui.element('new-messages').textContent, /3 条/);
  assert.equal(readReports(ui).length, 0);
});

test('empty shared unread updates do not replace a QR login screen or rebuild message rows', () => {
  const ui = webview();
  sync(ui, { reset: true, messages: [message(1)] });
  const row = ui.element('messages').children.find(el => el.dataset.id === 1);
  ui.receive({ command: 'qrcode', qrcode: 'data:image/png;base64,AA==' });
  sync(ui, { unreadCount: 1 });
  assert.equal(ui.element('chat-container').classList.contains('hidden'), true);
  assert.equal(ui.element('login-screen').classList.contains('hidden'), false);
  assert.equal(ui.element('messages').children.find(el => el.dataset.id === 1), row);
});

test('being near the bottom does not mark messages below the viewport read until actually reaching the end', () => {
  const ui = webview();
  sync(ui, { reset: true, messages: Array.from({ length: 20 }, (_, i) => message(i + 1)), unreadCount: 2 });
  const container = ui.element('chat-container');
  container.scrollTop = container.scrollHeight - container.clientHeight - 50;
  container.events.scroll({});
  ui.receive({ command: 'hostFocus', focused: true });
  assert.equal(readReports(ui).length, 0);
  ui.receive({ command: 'revealLatest' });
  assert.equal(readReports(ui).at(-1).throughId, 20);
});

test('focus transitions retry an unacknowledged read that the host may have ignored during a hide race', () => {
  const ui = webview();
  ui.receive({ command: 'hostFocus', focused: true });
  sync(ui, { reset: true, messages: [message(10)], unreadCount: 1 });
  assert.equal(readReports(ui).length, 1);
  // The host might ignore that report if its panel has already become hidden.
  ui.receive({ command: 'hostFocus', focused: false });
  ui.receive({ command: 'hostFocus', focused: true });
  assert.equal(readReports(ui).length, 2);
  assert.equal(readReports(ui).at(-1).throughId, 10);
  sync(ui, { readThroughId: 10, unreadCount: 0 });
  ui.receive({ command: 'hostFocus', focused: false });
  ui.receive({ command: 'hostFocus', focused: true });
  assert.equal(readReports(ui).length, 2, 'an acknowledged range does not need another report');
});

function submitHistorySearch(ui, values = {}) {
  if (ui.element('search-panel').classList.contains('hidden')) ui.element('search-toggle').click();
  for (const [name, value] of Object.entries(values)) {
    const field = ui.element('search-' + name);
    field.value = value;
    field.events.input?.({ target: field });
  }
  ui.element('search-form').events.submit({ preventDefault() {} });
  return ui.outbound.filter(msg => msg.command === 'searchHistory').at(-1);
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

const nodeText = element => (element.textContent || '') + element.children.map(nodeText).join('');

test('send shortcut settings distinguish plain Enter from Ctrl/Cmd+Enter and never send IME confirmation', () => {
  for (const [shortcut, modifiers, shouldSend] of [
    ['enter', {}, true], ['enter', { ctrlKey: true }, false], ['enter', { metaKey: true }, false],
    ['enter', { altKey: true }, false], ['enter', { shiftKey: true }, false],
    ['ctrlEnter', {}, false], ['ctrlEnter', { ctrlKey: true }, true], ['ctrlEnter', { metaKey: true }, true],
    ['ctrlEnter', { ctrlKey: true, shiftKey: true }, false], ['ctrlEnter', { metaKey: true, altKey: true }, false],
    ['ctrlEnter', { ctrlKey: true, isComposing: true }, false], ['ctrlEnter', { metaKey: true, keyCode: 229 }, false],
  ]) {
    const ui = webview();
    writeDraft(ui, 'first\nsecond');
    ui.receive({ command: 'settings', sendShortcut: shortcut });
    let prevented = 0;
    const event = { key: 'Enter', ...modifiers, preventDefault() { prevented++; } };
    ui.element('text-input').events.keydown(event);
    assert.equal(sends(ui).length, shouldSend ? 1 : 0, JSON.stringify({ shortcut, modifiers }));
    assert.equal(prevented, shouldSend ? 1 : 0);
    if (shouldSend) {
      ui.element('text-input').events.keydown(event);
      assert.equal(sends(ui).length, 1, 'repeated keydown cannot duplicate an in-flight send');
    }
  }
});

test('shortcut updates refresh composer and image hints without altering drafts or pending send state', () => {
  const ui = webview();
  writeDraft(ui, 'keep my draft');
  selectQuote(ui);
  const file = pasteImage(ui);
  ui.receive({ command: 'settings', sendShortcut: 'ctrlEnter' });
  assert.match(ui.element('text-input').title, /Ctrl\/Cmd\+Enter/);
  assert.match(ui.element('paste-status').title, /Ctrl\/Cmd\+Enter/);
  assert.equal(ui.element('text-input').value, 'keep my draft');
  assert.equal(ui.element('paste-preview').src, file.data);
  ui.element('send-btn').click();
  const request = sends(ui).at(-1);
  ui.receive({ command: 'settings', sendShortcut: 'enter' });
  assert.equal(ui.state().drafts.QQ.send.requestId, request.requestId);
  assert.equal(ui.element('send-btn').disabled, true);
  assert.match(ui.element('paste-status').title, /Enter 发送/);
  assert.equal(ui.element('quote-bar').classList.contains('hidden'), false);
});

test('search submits explicit literal filters, ignores mismatched responses and pages newest-first without duplicates', () => {
  const ui = webview();
  sync(ui, { reset: true, messages: [message(100), message(101)] });
  const query = ui.element('search-query');
  query.value = '100%_[x]';
  query.events.input({ target: query });
  assert.equal(ui.outbound.filter(msg => msg.command === 'searchHistory').length, 0, 'typing never auto-searches');
  const first = submitHistorySearch(ui, { type: '1' });
  assert.equal(first.query, '100%_[x]');
  assert.equal(first.type, 1);
  assert.equal(first.generation, 'generation-a');
  ui.receive({ command: 'searchResults', requestId: 'unrelated', generation: 'generation-a', messages: [message(99)], hasMore: false });
  assert.equal(ui.element('search-results').children.length, 0);
  ui.receive({ command: 'searchResults', requestId: first.requestId, generation: 'generation-a', messages: [message(40), message(20)], hasMore: true });
  assert.deepEqual(ui.element('search-results').children.map(el => el.dataset.id), [40, 20]);
  ui.element('search-more').click();
  const page = ui.outbound.at(-1);
  assert.equal(page.beforeId, 20);
  assert.equal(page.query, first.query);
  assert.notEqual(page.requestId, first.requestId);
  ui.receive({ command: 'searchResults', requestId: first.requestId, generation: 'generation-a', messages: [message(50)], hasMore: false });
  ui.receive({ command: 'searchResults', requestId: page.requestId, generation: 'generation-a', messages: [message(20), message(10)], hasMore: false });
  assert.deepEqual(ui.element('search-results').children.map(el => el.dataset.id), [40, 20, 10]);
  assert.deepEqual(ui.ids(), [100, 101], 'search does not replace the main timeline');
  assert.equal(ui.element('search-more').classList.contains('hidden'), true);
});

test('editing filters invalidates pending results and errors remain inline with explicit retry', () => {
  const ui = webview();
  const first = submitHistorySearch(ui, { query: 'old query' });
  ui.element('search-query').value = 'new query';
  ui.element('search-query').events.input({});
  ui.receive({ command: 'searchResults', requestId: first.requestId, generation: 'generation-a', messages: [message(1)], hasMore: false });
  assert.equal(ui.element('search-results').children.length, 0);
  assert.match(ui.element('search-status').textContent, /条件已修改/);
  const second = submitHistorySearch(ui);
  ui.receive({ command: 'searchError', requestId: first.requestId, error: 'stale failure' });
  assert.equal(ui.element('search-submit').disabled, true);
  ui.receive({ command: 'searchError', requestId: second.requestId, error: 'temporary storage failure' });
  assert.match(ui.element('search-status').textContent, /temporary storage failure/);
  assert.equal(ui.element('search-submit').disabled, false);
  assert.deepEqual(ui.ids(), []);
  submitHistorySearch(ui);
  assert.equal(ui.outbound.filter(msg => msg.command === 'searchHistory').length, 3);
});

test('search calendar date filters use local midnight and an exclusive next day across DST', () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const ui = webview();
    const request = submitHistorySearch(ui, { from: '2026-03-08', to: '2026-03-08' });
    assert.equal(request.fromTimestamp, Date.UTC(2026, 2, 8, 5) / 1000);
    assert.equal(request.toTimestamp, Date.UTC(2026, 2, 9, 4) / 1000);
    assert.equal(request.toTimestamp - request.fromTimestamp, 23 * 3600);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
  }
});

test('invalid date ranges and overlong queries do not reach the host', () => {
  const ui = webview();
  submitHistorySearch(ui, { from: '2026-11-13', to: '2026-11-12' });
  assert.match(ui.element('search-status').textContent, /不能晚于/);
  submitHistorySearch(ui, { from: '2026-02-31', to: '' });
  assert.match(ui.element('search-status').textContent, /有效日期/);
  submitHistorySearch(ui, { from: '', query: 'x'.repeat(201) });
  assert.match(ui.element('search-status').textContent, /200/);
  assert.equal(ui.outbound.filter(msg => msg.command === 'searchHistory').length, 0);
});

test('search highlights literal untrusted text with nodes and bounds long snippets', () => {
  const ui = webview();
  const query = '<img src=x onerror=alert(1)>.*[]';
  const request = submitHistorySearch(ui, { query });
  ui.receive({ command: 'searchResults', requestId: request.requestId, generation: 'generation-a', messages: [
    { ...message(1), content: 'before '.repeat(40) + query + ' after'.repeat(100) },
  ], hasMore: false });
  const result = ui.element('search-results').children[0];
  const snippet = result.children.find(el => el.className === 'search-result-snippet');
  assert.equal(descendants(result).filter(el => el.tagName === 'IMG').length, 0);
  assert.equal(descendants(snippet).find(el => el.tagName === 'MARK').textContent, query);
  assert.ok(nodeText(snippet).length <= 162);
  assert.match(result.children[0].textContent, /我 · 文字/);
});

test('message context is separate from live history, highlights the target and never marks it read', () => {
  const ui = webview();
  sync(ui, { reset: true, messages: [message(100), message(101)], unreadCount: 1 });
  ui.receive({ command: 'hostFocus', focused: true });
  writeDraft(ui, 'unchanged composer');
  const readCount = readReports(ui).length;
  const request = submitHistorySearch(ui, { query: 'target' });
  ui.receive({ command: 'searchResults', requestId: request.requestId, generation: 'generation-a', messages: [message(10)], hasMore: false });
  ui.element('search-results').children[0].click();
  const context = ui.outbound.at(-1);
  assert.equal(context.command, 'loadMessageContext');
  assert.equal(context.targetId, 10);
  ui.receive({ command: 'messageContext', requestId: context.requestId, generation: 'generation-a', targetId: 10,
    messages: [message(9), { ...message(10), content: '<script>unsafe</script>' }, message(11)], hasBefore: true, hasAfter: true });
  const target = ui.element('search-context-messages').children.find(el => el.dataset.id === 10);
  assert.equal(target.classList.contains('search-context-target'), true);
  assert.equal(target.scrolledIntoView.block, 'center');
  assert.match(nodeText(target), /<script>unsafe<\/script>/);
  assert.deepEqual(ui.ids(), [100, 101]);
  assert.equal(ui.element('text-input').value, 'unchanged composer');
  ui.element('chat-container').events.scroll({});
  ui.focusWindow();
  assert.equal(readReports(ui).length, readCount);
  ui.element('search-context-back').click();
  assert.equal(ui.element('search-results').children.length, 1);
  assert.equal(ui.element('search-context').classList.contains('hidden'), true);
  ui.element('search-close').click();
  assert.equal(ui.element('text-input').value, 'unchanged composer');
});

test('a history generation change invalidates search and reference context without automatically repeating requests', () => {
  const ui = webview();
  sync(ui, { reset: true, messages: [message(100)] });
  const request = submitHistorySearch(ui, { query: 'target' });
  ui.receive({ command: 'searchResults', requestId: request.requestId, generation: 'generation-a', messages: [message(10)], hasMore: false });
  ui.element('search-results').children[0].click();
  const context = ui.outbound.at(-1);
  const requestsBefore = ui.outbound.length;
  sync(ui, { generation: 'generation-b', reset: true, messages: [], hasMore: false });
  ui.receive({ command: 'messageContext', requestId: context.requestId, generation: 'generation-a', targetId: 10, messages: [message(10)] });
  ui.receive({ command: 'searchResults', requestId: request.requestId, generation: 'generation-a', messages: [message(10)], hasMore: false });
  assert.equal(ui.element('search-results').children.length, 0);
  assert.equal(ui.element('search-context-messages').children.length, 0);
  assert.match(ui.element('search-status').textContent, /已变化/);
  assert.equal(ui.outbound.length, requestsBefore);
  const next = submitHistorySearch(ui);
  assert.equal(next.generation, 'generation-b');
});

test('unloaded quote targets request bounded reference context while loaded targets still jump locally', () => {
  const ui = webview();
  const referenced = { ...message(10), message_id: 'loaded-id' };
  const quote = { ...message(11), reply_to: JSON.stringify({ messageId: 'loaded-id', text: 'quoted' }) };
  ui.receive({ command: 'loadHistory', messages: [referenced, quote], hasMore: false });
  const findQuote = id => ui.element('messages').children.find(el => el.dataset.id === id).children.find(el => el.className === 'quote-preview');
  findQuote(11).click();
  assert.equal(ui.element('messages').children.find(el => el.dataset.id === 10).scrolledIntoView.block, 'center');
  assert.equal(ui.outbound.filter(msg => msg.command === 'loadMessageContext').length, 0);
  ui.receive({ command: 'newMessage', message: { ...message(12), reply_to: JSON.stringify({ messageId: 'unloaded-id', text: 'older' }) } });
  findQuote(12).click();
  const request = ui.outbound.at(-1);
  assert.equal(request.command, 'loadMessageContext');
  assert.equal(request.messageId, 'unloaded-id');
  assert.equal(ui.element('search-panel').classList.contains('hidden'), false);
  ui.receive({ command: 'contextError', requestId: 'wrong', error: 'ignore me' });
  assert.match(ui.element('search-context-title').textContent, /正在读取/);
  ui.receive({ command: 'contextError', requestId: request.requestId, error: 'message removed' });
  assert.match(ui.element('search-context-title').textContent, /message removed/);
  assert.deepEqual(ui.ids(), [10, 11, 12]);
});

test('closing an in-flight search updates accessibility and shows a cancellable retry state on reopen', () => {
  const ui = webview();
  const request = submitHistorySearch(ui, { query: 'pending' });
  assert.equal(ui.element('search-toggle').attributes['aria-expanded'], 'true');
  ui.element('search-close').click();
  assert.equal(ui.element('search-toggle').attributes['aria-expanded'], 'false');
  assert.match(ui.element('search-status').textContent, /已取消/);
  assert.equal(ui.element('search-submit').disabled, false);
  ui.element('search-toggle').click();
  assert.match(ui.element('search-status').textContent, /已取消/);
  ui.receive({ command: 'searchResults', requestId: request.requestId, generation: 'generation-a', messages: [message(1)], hasMore: true });
  assert.equal(ui.element('search-results').children.length, 0);
  const retry = submitHistorySearch(ui);
  assert.notEqual(retry.requestId, request.requestId);
});

test('opening context cancels active search pagination and closing its pending request returns to usable results', () => {
  const ui = webview();
  const request = submitHistorySearch(ui, { query: 'target' });
  ui.receive({ command: 'searchResults', requestId: request.requestId, generation: 'generation-a', messages: [message(20)], hasMore: true });
  ui.element('search-more').click();
  const page = ui.outbound.at(-1);
  ui.element('search-results').children[0].click();
  const context = ui.outbound.at(-1);
  assert.equal(ui.element('search-submit').disabled, false);
  ui.receive({ command: 'searchResults', requestId: page.requestId, generation: 'generation-a', messages: [message(10)], hasMore: true });
  assert.equal(ui.element('search-results').children.length, 1);
  assert.equal(ui.element('search-more').classList.contains('hidden'), true);
  ui.element('search-close').click();
  ui.element('search-toggle').click();
  assert.match(ui.element('search-status').textContent, /读取已取消/);
  assert.equal(ui.element('search-context').classList.contains('hidden'), true);
  assert.equal(ui.element('search-results').classList.contains('hidden'), false);
  ui.receive({ command: 'messageContext', requestId: context.requestId, generation: 'generation-a', targetId: 20, messages: [message(20)] });
  assert.equal(ui.element('search-context-messages').children.length, 0);
  ui.element('search-more').click();
  assert.equal(ui.outbound.at(-1).command, 'searchHistory');
  assert.equal(ui.outbound.at(-1).beforeId, 20);
});

const { parseMarkdown } = require('../src/markdown-content.ts');
const withMarkdown = (id, content) => ({ ...message(id), content, markdown: parseMarkdown(content) });
const rowFor = (ui, id) => ui.element('messages').children.find(el => el.dataset.id === id);

test('Chat renders structured Markdown while Output and Changes keep the original plain text', () => {
  const ui = webview();
  const content = '**bold** and `code`\n<script>alert(1)</script>\n![tracking](https://example.com/pixel.png)';
  ui.receive({ command: 'newMessage', message: withMarkdown(1, content) });
  let nodes = descendants(rowFor(ui, 1));
  assert.equal(nodes.find(el => el.tagName === 'STRONG').children[0].textContent, 'bold');
  assert.ok(nodeText(rowFor(ui, 1)).includes('<script>alert(1)</script>'));
  assert.equal(nodes.filter(el => ['SCRIPT', 'IMG'].includes(el.tagName)).length, 0, 'HTML and Markdown images cannot create executable elements or tracking images');
  for (const mode of ['log', 'git']) {
    ui.element('toolbar').events.click({ target: { closest: () => ({ dataset: { mode } }) } });
    nodes = descendants(rowFor(ui, 1));
    assert.equal(nodes.filter(el => el.tagName === 'STRONG').length, 0);
    assert.equal(nodes.find(el => el.className === 'msg-text').textContent, content);
  }
});

test('dense Markdown falls back to the complete literal source in messages, parts and search context', () => {
  const ui = webview();
  const content = '**x** '.repeat(4000) + '<img src=x onerror=alert(1)>END_OF_MESSAGE';
  const markdown = parseMarkdown(content);
  writeDraft(ui, 'preserved draft');
  sync(ui, { reset: true, messages: [
    { ...message(100), content, markdown },
    { ...message(101), content: 'legacy summary', parts: [{ type: 1, text: content, markdown }] },
  ], unreadCount: 3 });
  for (const id of [100, 101]) {
    const nodes = descendants(rowFor(ui, id));
    assert.equal(nodes.find(el => el.className === 'msg-text').textContent, content);
    assert.equal(nodes.filter(el => ['STRONG', 'IMG'].includes(el.tagName)).length, 0);
  }
  const reports = readReports(ui).length;
  const search = submitHistorySearch(ui, { query: 'END_OF_MESSAGE' });
  ui.receive({ command: 'searchResults', requestId: search.requestId, generation: 'generation-a', messages: [message(10)], hasMore: false });
  ui.element('search-results').children[0].click();
  const request = ui.outbound.at(-1);
  ui.receive({ command: 'messageContext', requestId: request.requestId, generation: 'generation-a', targetId: 10,
    messages: [{ ...message(10), content, markdown }], hasBefore: false, hasAfter: false });
  const contextNodes = descendants(ui.element('search-context-messages'));
  assert.equal(contextNodes.find(el => el.className === 'msg-text').textContent, content);
  assert.equal(contextNodes.filter(el => ['STRONG', 'IMG'].includes(el.tagName)).length, 0);
  assert.equal(ui.element('text-input').value, 'preserved draft');
  assert.equal(readReports(ui).length, reports);
  assert.match(ui.element('new-messages').textContent, /3 条/);
  assert.equal(sends(ui).length, 0);
});

test('hot Markdown changes preserve draft, unread count and reading anchor without sending or marking read', () => {
  const ui = webview();
  const records = Array.from({ length: 20 }, (_, i) => withMarkdown(i + 1, '**row ' + (i + 1) + '**'));
  sync(ui, { reset: true, messages: records, unreadCount: 4 });
  writeDraft(ui, 'unchanged\ncomposer');
  const container = ui.element('chat-container');
  container.scrollTop = 135;
  container.events.scroll({});
  ui.receive({ command: 'hostFocus', focused: true });
  const offset = rowFor(ui, 6).getBoundingClientRect().top;
  const savedDraft = ui.state().drafts.QQ;
  const reports = readReports(ui).length;
  ui.receive({ command: 'settings', renderMarkdown: false });
  assert.equal(rowFor(ui, 6).getBoundingClientRect().top, offset);
  assert.equal(descendants(rowFor(ui, 6)).find(el => el.className === 'msg-text').textContent, '**row 6**');
  assert.deepEqual(ui.state().drafts.QQ, savedDraft);
  assert.match(ui.element('new-messages').textContent, /4 条/);
  assert.equal(readReports(ui).length, reports);
  assert.equal(sends(ui).length, 0);
  // A settings rerender at the bottom must not itself acknowledge a newer range.
  container.scrollTop = container.scrollHeight;
  ui.receive({ command: 'settings', renderMarkdown: true });
  container.events.scroll({});
  assert.equal(readReports(ui).length, reports);
  assert.ok(descendants(rowFor(ui, 6)).some(el => el.tagName === 'STRONG'));
  ui.runTimers();
  container.events.scroll({});
  assert.equal(readReports(ui).at(-1).throughId, 20, 'later reading interaction remains functional');
});

test('code copying uses exact source text and correlated success or retry controls without touching drafts', () => {
  const ui = webview();
  const code = 'const text = "<tag>";\n\n  // trailing spaces  \n';
  ui.receive({ command: 'newMessage', message: withMarkdown(1, '```js\n' + code + '```') });
  writeDraft(ui, 'draft remains');
  const copy = descendants(rowFor(ui, 1)).find(el => el.className === 'rich-code-copy');
  const codeNode = descendants(rowFor(ui, 1)).find(el => el.tagName === 'CODE');
  assert.equal(codeNode.textContent, code);
  copy.click();
  copy.click();
  const request = ui.outbound.at(-1);
  assert.equal(request.command, 'copyText');
  assert.equal(request.text, code);
  assert.equal(ui.outbound.filter(msg => msg.command === 'copyText').length, 1);
  ui.receive({ command: 'copyResult', requestId: 'wrong-result' });
  assert.equal(copy.disabled, true);
  ui.receive({ command: 'copyResult', requestId: request.requestId, error: 'clipboard unavailable' });
  assert.equal(copy.disabled, false);
  assert.equal(copy.textContent, '重试复制');
  copy.click();
  const retry = ui.outbound.at(-1);
  assert.notEqual(retry.requestId, request.requestId);
  assert.equal(retry.text, code);
  ui.receive({ command: 'copyResult', requestId: retry.requestId });
  assert.equal(copy.textContent, '已复制');
  assert.equal(ui.element('text-input').value, 'draft remains');
  assert.equal(sends(ui).length, 0);
});

test('ordered parts retain all captions, attachments and voice text without duplicating the legacy summary', () => {
  const ui = webview();
  const parts = [
    { type: 1, text: '**caption**', markdown: parseMarkdown('**caption**') },
    { type: 2, url: 'https://example.com/photo.png', text: '<image caption>' },
    { type: 3, text: 'voice transcript' },
    { type: 4, fileName: '<report>.txt', size: 2048, url: 'https://example.com/report.txt', text: 'file caption' },
    { type: 5, fileName: 'clip.mp4', size: 0, url: 'https://example.com/clip.mp4', text: 'video caption' },
  ];
  ui.receive({ command: 'newMessage', message: { ...message(1), content: 'LEGACY SUMMARY SHOULD NOT REPEAT', parts } });
  const row = rowFor(ui, 1);
  const wrappers = row.children.filter(el => el.className === 'message-part');
  assert.deepEqual(wrappers.map(el => el.dataset.type), [1, 2, 3, 4, 5]);
  assert.equal(descendants(row).filter(el => el.tagName === 'IMG').length, 1);
  assert.equal(descendants(row).filter(el => ['VIDEO', 'IFRAME', 'AUDIO'].includes(el.tagName)).length, 0);
  const text = nodeText(row);
  for (const caption of ['caption', '<image caption>', 'voice transcript', '<report>.txt', 'file caption', 'video caption', '2.0 KB', '0 B']) assert.ok(text.includes(caption));
  assert.equal(text.includes('LEGACY SUMMARY'), false);
  assert.equal(descendants(wrappers[3]).filter(el => el.tagName === 'BUTTON').length, 0);
  assert.ok(nodeText(wrappers[3]).includes('此文件暂不支持保存'));
  const videoButton = descendants(wrappers[4]).find(el => el.tagName === 'BUTTON');
  videoButton.click();
  assert.equal(ui.outbound.at(-1).url, 'https://example.com/clip.mp4');
  ui.element('toolbar').events.click({ target: { closest: () => ({ dataset: { mode: 'log' } }) } });
  assert.equal(nodeText(rowFor(ui, 1)).includes('**caption**'), true);
  assert.equal(rowFor(ui, 1).children.filter(el => el.className === 'message-part').length, 5);
});

test('unsafe image and attachment schemes are inert and HTTP images require explicit opening', () => {
  const ui = webview();
  const parts = [
    { type: 2, imageDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=', url: 'javascript:alert(1)' },
    { type: 2, url: 'command:workbench.action.closeWindow' },
    { type: 2, url: 'file:///etc/passwd' },
    { type: 2, url: 'mailto:person@example.com' },
    { type: 2, url: 'http://example.com/photo.png', text: 'HTTP picture' },
    { type: 2, imageDataUrl: 'data:image/png;base64,YWJj' },
    { type: 4, fileName: 'bad.txt', url: 'command:bad' },
    { type: 5, fileName: 'bad.mp4', url: 'data:text/html,unsafe' },
  ];
  ui.receive({ command: 'newMessage', message: { ...message(1), direction: 'received', parts } });
  const wrappers = rowFor(ui, 1).children.filter(el => el.className === 'message-part');
  assert.equal(descendants(rowFor(ui, 1)).filter(el => el.tagName === 'IMG').length, 1);
  for (const wrapper of [wrappers[0], wrappers[1], wrappers[2], wrappers[3], wrappers[6], wrappers[7]]) {
    assert.equal(descendants(wrapper).filter(el => el.tagName === 'BUTTON').length, 0);
    descendants(wrapper).forEach(el => el.click());
  }
  assert.equal(ui.outbound.filter(msg => msg.command === 'openExternal').length, 0);
  const httpButton = descendants(wrappers[4]).find(el => el.tagName === 'BUTTON');
  httpButton.click();
  assert.equal(ui.outbound.at(-1).url, 'http://example.com/photo.png');
  ui.receive({ command: 'newMessage', message: { ...message(2), type: 2, imageDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' } });
  assert.equal(descendants(rowFor(ui, 2)).filter(el => el.tagName === 'IMG').length, 0);
});

test('Markdown links are host-mediated and malformed AST safely falls back to original plain text', () => {
  const ui = webview();
  ui.receive({ command: 'newMessage', message: { ...message(1), markdown: [
    { tag: 'a', href: 'javascript:alert(1)', text: 'unsafe' },
    { tag: 'a', href: 'https://example.com/path', text: 'safe' },
    { tag: 'a', href: 'mailto:person@example.com', text: 'email' },
    { tag: 'img', text: 'blocked image', href: 'https://example.com/pixel.png' },
  ] } });
  const links = descendants(rowFor(ui, 1)).filter(el => el.tagName === 'A');
  assert.equal(links.length, 2);
  assert.equal(links[0].attributes.href, undefined);
  links[0].click();
  assert.equal(ui.outbound.at(-1).url, 'https://example.com/path');
  links[1].events.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(ui.outbound.at(-1).url, 'mailto:person@example.com');
  assert.equal(descendants(rowFor(ui, 1)).filter(el => el.tagName === 'IMG').length, 0);
  ui.receive({ command: 'newMessage', message: { ...message(2), content: '**keep original**', markdown: [{ unexpected: 'bad' }] } });
  assert.equal(descendants(rowFor(ui, 2)).find(el => el.className === 'msg-text').textContent, '**keep original**');
  ui.receive({ command: 'newMessage', message: { ...message(3), content: 'legacy text', parts: [] } });
  assert.equal(descendants(rowFor(ui, 3)).find(el => el.className === 'msg-text').textContent, 'legacy text');
});

test('search context renders multipart Markdown and rerenders settings without changing the live timeline', () => {
  const ui = webview();
  sync(ui, { reset: true, messages: [message(100)] });
  const search = submitHistorySearch(ui, { query: 'context' });
  ui.receive({ command: 'searchResults', requestId: search.requestId, generation: 'generation-a', messages: [message(10)], hasMore: false });
  ui.element('search-results').children[0].click();
  const request = ui.outbound.at(-1);
  ui.receive({ command: 'messageContext', requestId: request.requestId, generation: 'generation-a', targetId: 10, messages: [
    { ...message(10), parts: [{ type: 1, text: '**context**', markdown: parseMarkdown('**context**') }, { type: 4, fileName: 'context.txt', text: 'attached caption' }] },
  ], hasBefore: false, hasAfter: false });
  assert.equal(descendants(ui.element('search-context-messages')).filter(el => el.tagName === 'STRONG').length, 1);
  assert.ok(nodeText(ui.element('search-context-messages')).includes('attached caption'));
  writeDraft(ui, 'still here');
  const reports = readReports(ui).length;
  ui.receive({ command: 'settings', renderMarkdown: false });
  assert.equal(descendants(ui.element('search-context-messages')).filter(el => el.tagName === 'STRONG').length, 0);
  assert.ok(nodeText(ui.element('search-context-messages')).includes('**context**'));
  assert.deepEqual(ui.ids(), [100]);
  assert.equal(readReports(ui).length, reports);
  assert.equal(ui.element('text-input').value, 'still here');
});

function enableFiles(ui, overrides = {}) {
  ui.receive({ command: 'fileCapabilities', fileCapabilities: { canSend: true, maxBytes: 20 * 1024 * 1024, ...overrides } });
}

function chooseClientFile(ui) {
  const count = ui.readers.length;
  ui.element('file-input').events.change({ target: { files: [{name: 'report.txt', type: 'text/plain', size: 3, data: 'data:text/plain;base64,YWJj'}] } });
  if (ui.readers.length > count) ui.readers.pop().complete();
}

function selectFileDraft(ui, fileId = 'opaque-file', fileName = 'report.txt', size = 1024) {
  chooseClientFile(ui);
  const request = ui.outbound.at(-1);
  assert.equal(request.command, 'stageFile');
  ui.receive({ command: 'fileSelected', requestId: request.requestId, fileDraft: { fileId, fileName, size } });
  return request;
}

const fileStatusText = ui => ui.element('file-draft').children.find(el => el.className === 'file-draft-status').textContent;
const saveButton = root => descendants(root).find(el => el.className === 'attachment-save');
const attachment = (id, overrides = {}) => ({ ...message(id), type: 4, parts: [
  { type: 4, fileName: 'received.txt', size: 2048, fileAction: { canSave: true }, ...overrides },
] });

test('client file selection waits for capabilities, stages only opaque metadata and sends explicitly', () => {
  const ui = webview();
  writeDraft(ui, 'independent text');
  selectQuote(ui);
  assert.equal(ui.element('attach-btn').disabled, false, 'images remain available');
  enableFiles(ui, { canSend: false, reason: 'QQ 当前不支持文件发送' });
  chooseClientFile(ui);
  assert.match(ui.element('send-status').textContent, /QQ 当前不支持/);
  assert.equal(ui.outbound.some(msg => msg.command === 'stageFile'), false);
  enableFiles(ui);
  selectFileDraft(ui, 'opaque-1', '<report & notes>.txt');
  assert.equal(sends(ui).length, 0);
  assert.equal(ui.element('file-draft-name').textContent, '<report & notes>.txt · 1.0 KB');
  assert.match(fileStatusText(ui), /待发送/);
  assert.deepEqual(ui.state().drafts.QQ.file, { fileId: 'opaque-1', fileName: '<report & notes>.txt', size: 1024 });
  ui.element('send-btn').click();
  const request = sends(ui).at(-1);
  assert.deepEqual(Object.keys(request).sort(), ['command', 'fileId', 'requestId']);
  assert.equal(request.command, 'sendFile');
  assert.equal(request.fileId, 'opaque-1');
  ui.element('send-btn').click();
  assert.equal(sends(ui).length, 1);
  ui.receive({ command: 'sendStatus', requestId: request.requestId, sendStatus: 'sent' });
  assert.equal(ui.state().drafts.QQ.file, null);
  assert.equal(ui.element('text-input').value, 'independent text');
  assert.equal(ui.element('quote-bar').classList.contains('hidden'), false);
});

test('cancelled or failed attachment staging preserves the old image or file and ignores unrelated results', () => {
  const ui = webview();
  enableFiles(ui);
  const image = pasteImage(ui);
  chooseClientFile(ui);
  let request = ui.outbound.at(-1);
  ui.receive({ command: 'fileSelected', requestId: 'unrelated', fileDraft: { fileId: 'bad', fileName: 'bad', size: 1 } });
  assert.equal(ui.element('send-btn').disabled, true);
  ui.receive({ command: 'fileSelected', requestId: request.requestId, cancelled: true });
  assert.equal(ui.element('paste-preview').src, image.data);
  selectFileDraft(ui, 'first');
  assert.equal(ui.element('paste-preview').src, undefined);
  chooseClientFile(ui);
  request = ui.outbound.at(-1);
  ui.receive({ command: 'fileSelected', requestId: request.requestId, error: 'file too large' });
  assert.equal(ui.state().drafts.QQ.file.fileId, 'first');
  assert.ok(nodeText(ui.element('input-bar')).includes('file too large'));
  chooseClientFile(ui);
  request = ui.outbound.at(-1);
  ui.receive({ command: 'fileSelected', requestId: request.requestId, cancelled: true });
  assert.equal(ui.state().drafts.QQ.file.fileId, 'first');
  selectFileDraft(ui, 'second');
  assert.equal(ui.outbound.filter(msg => msg.command === 'removeFileDraft' && msg.fileId === 'first').length, 1);
  ui.element('file-draft-cancel').click();
  assert.equal(ui.outbound.at(-1).command, 'removeFileDraft');
  assert.equal(ui.outbound.at(-1).fileId, 'second');
  assert.equal(ui.state().drafts.QQ.file, null);
});

test('file draft remains selected during failed or cancelled image reads and is removed only on success', () => {
  const ui = webview({ deferFileReads: true });
  enableFiles(ui);
  selectFileDraft(ui);
  ui.element('file-input').events.change({ target: { files: [] } });
  assert.equal(ui.state().drafts.QQ.file.fileId, 'opaque-file');
  pasteImage(ui);
  assert.equal(ui.element('send-btn').disabled, true);
  assert.equal(ui.state().drafts.QQ.file.fileId, 'opaque-file');
  ui.readers[0].onerror();
  assert.equal(ui.state().drafts.QQ.file.fileId, 'opaque-file');
  pasteImage(ui);
  ui.element('paste-cancel').click();
  ui.readers[1].complete();
  assert.equal(ui.state().drafts.QQ.file.fileId, 'opaque-file');
  const image = pasteImage(ui);
  ui.readers[2].complete();
  assert.equal(ui.state().drafts.QQ.file, null);
  assert.equal(ui.element('paste-preview').src, image.data);
  assert.equal(ui.outbound.filter(msg => msg.command === 'removeFileDraft').length, 1);
});

test('restored file drafts validate before sending and invalid tokens never overwrite pending send recovery', () => {
  const ui = webview();
  enableFiles(ui);
  selectFileDraft(ui);
  const restored = webview({ state: ui.state() });
  enableFiles(restored);
  assert.equal(restored.element('send-btn').disabled, true);
  assert.match(fileStatusText(restored), /正在检查/);
  assert.equal(restored.outbound.find(msg => msg.command === 'getFileDraft').fileId, 'opaque-file');
  restored.receive({ command: 'fileDraftStatus', fileId: 'other', valid: true });
  assert.equal(restored.element('send-btn').disabled, true);
  restored.receive({ command: 'fileDraftStatus', fileId: 'opaque-file', valid: true });
  restored.element('send-btn').click();
  const request = sends(restored).at(-1);
  const pending = webview({ state: restored.state() });
  enableFiles(pending);
  assert.equal(pending.outbound.find(msg => msg.command === 'getSendStatus').requestId, request.requestId);
  pending.receive({ command: 'fileDraftStatus', fileId: 'opaque-file', valid: false, error: '文件已失效' });
  assert.equal(pending.state().drafts.QQ.send.status, 'sending');
  pending.receive({ command: 'sendStatus', requestId: request.requestId, sendStatus: 'uncertain', error: 'delivery unknown' });
  assert.match(pending.element('send-status').textContent, /发送结果待确认.*delivery unknown/);
  assert.match(fileStatusText(pending), /文件已失效.*重新选择/);
  assert.equal(pending.element('retry-send').disabled, true);
  pending.element('retry-send').click();
  assert.equal(sends(pending).length, 0);
  assert.equal(pending.state().drafts.QQ.send.status, 'uncertain');
  pending.element('confirm-send').click();
  assert.equal(pending.state().drafts.QQ.file, null);
  assert.equal(sends(pending).length, 0);
});

test('file failures retry only by explicit action and late success cannot erase a replacement file', () => {
  const ui = webview();
  enableFiles(ui);
  selectFileDraft(ui, 'first');
  writeDraft(ui, 'text survives');
  ui.element('send-btn').click();
  const first = sends(ui).at(-1);
  ui.receive({ command: 'sendStatus', requestId: first.requestId, sendStatus: 'failed', error: 'network' });
  assert.equal(ui.state().drafts.QQ.file.fileId, 'first');
  assert.equal(sends(ui).length, 1);
  ui.element('retry-send').click();
  const retry = sends(ui).at(-1);
  assert.notEqual(retry.requestId, first.requestId);
  assert.equal(retry.fileId, 'first');
  ui.receive({ command: 'sendStatus', requestId: retry.requestId, sendStatus: 'uncertain' });
  selectFileDraft(ui, 'replacement');
  ui.receive({ command: 'sendStatus', requestId: first.requestId, sendStatus: 'sent' });
  assert.equal(ui.state().drafts.QQ.send.requestId, retry.requestId);
  ui.receive({ command: 'sendStatus', requestId: retry.requestId, sendStatus: 'sent' });
  assert.equal(ui.state().drafts.QQ.file.fileId, 'replacement');
  assert.equal(ui.element('text-input').value, 'text survives');
  assert.equal(sends(ui).length, 2);
});

test('file send capability and the 20 MiB application limit are enforced after selection and restoration', () => {
  const ui = webview();
  enableFiles(ui, { maxBytes: 100 * 1024 * 1024 });
  selectFileDraft(ui, 'too-large', 'large.bin', 20 * 1024 * 1024 + 1);
  assert.equal(ui.element('send-btn').disabled, true);
  assert.match(fileStatusText(ui), /超过 20 MiB/);
  ui.element('send-btn').click();
  assert.equal(sends(ui).length, 0);
  selectFileDraft(ui, 'limit-size', 'limit.bin', 20 * 1024 * 1024);
  assert.equal(ui.element('send-btn').disabled, false);
  enableFiles(ui, { canSend: false, reason: '当前通道不可用' });
  assert.equal(ui.element('send-btn').disabled, true);
  assert.match(fileStatusText(ui), /当前通道不可用/);
  ui.receive({ command: 'settings', renderMarkdown: false, sendShortcut: 'ctrlEnter' });
  assert.equal(ui.state().drafts.QQ.file.fileId, 'limit-size');
  assert.equal(sends(ui).length, 0);
});

test('explicitly replacing a failed file with an image or removing it does not trap send recovery', () => {
  const ui = webview();
  enableFiles(ui);
  selectFileDraft(ui);
  ui.element('send-btn').click();
  const original = sends(ui).at(-1);
  ui.receive({ command: 'sendStatus', requestId: original.requestId, sendStatus: 'failed' });
  const image = pasteImage(ui);
  assert.equal(ui.element('retry-send').disabled, false);
  assert.equal(sends(ui).length, 1);
  ui.element('retry-send').click();
  const retry = sends(ui).at(-1);
  assert.equal(retry.command, 'sendImage');
  assert.equal(retry.imageData, image.data);
  ui.receive({ command: 'sendStatus', requestId: retry.requestId, sendStatus: 'sent' });
  selectFileDraft(ui, 'second-file');
  ui.element('send-btn').click();
  const second = sends(ui).at(-1);
  ui.receive({ command: 'sendStatus', requestId: second.requestId, sendStatus: 'uncertain' });
  ui.element('file-draft-cancel').click();
  assert.equal(ui.element('retry-send').disabled, true);
  writeDraft(ui, 'new text after removing file');
  assert.equal(ui.element('retry-send').disabled, false);
  assert.equal(ui.state().drafts.QQ.send.status, 'uncertain');
  ui.element('retry-send').click();
  assert.equal(sends(ui).at(-1).command, 'sendMessage');
  assert.equal(sends(ui).at(-1).text, 'new text after removing file');
});

test('attachment saving is correlated, keeps progress across rerenders and retries failures without URL or path', () => {
  const ui = webview();
  const msg = attachment(5, { url: 'https://example.com/never-open', fileName: '<unsafe>.txt' });
  msg.parts.unshift({ type: 1, text: 'caption' });
  sync(ui, { reset: true, messages: [msg], unreadCount: 3 });
  writeDraft(ui, 'keep draft');
  const reports = readReports(ui).length;
  let button = saveButton(rowFor(ui, 5));
  button.click();
  button.click();
  let request = ui.outbound.at(-1);
  assert.deepEqual(request, { command: 'saveAttachment', requestId: request.requestId, targetId: 5, partIndex: 1, generation: 'generation-a' });
  assert.equal(ui.outbound.filter(msg => msg.command === 'saveAttachment').length, 1);
  ui.receive({ command: 'attachmentStatus', requestId: 'wrong', fileStatus: 'saved' });
  assert.equal(button.disabled, true);
  ui.element('toolbar').events.click({ target: { closest: () => ({ dataset: { mode: 'log' } }) } });
  button = saveButton(rowFor(ui, 5));
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '保存中…');
  ui.receive({ command: 'attachmentStatus', requestId: request.requestId, fileStatus: 'failed', error: 'download failed' });
  assert.equal(button.textContent, '重试保存');
  assert.match(nodeText(rowFor(ui, 5)), /保存失败：download failed/);
  button.click();
  const retry = ui.outbound.at(-1);
  assert.notEqual(retry.requestId, request.requestId);
  ui.receive({ command: 'attachmentStatus', requestId: request.requestId, fileStatus: 'saved' });
  assert.equal(button.disabled, true);
  ui.receive({ command: 'attachmentStatus', requestId: retry.requestId, fileStatus: 'saved' });
  assert.equal(button.textContent, '再次保存…');
  assert.match(nodeText(rowFor(ui, 5)), /已保存/);
  assert.equal(ui.element('text-input').value, 'keep draft');
  assert.equal(readReports(ui).length, reports);
  assert.equal(ui.outbound.filter(msg => msg.command === 'openExternal').length, 0);
  assert.equal(sends(ui).length, 0);
});

test('attachment cancellation waits for acknowledgement and a new generation never reuses old saving state', () => {
  const ui = webview();
  sync(ui, { reset: true, messages: [attachment(5)] });
  saveButton(rowFor(ui, 5)).click();
  const request = ui.outbound.at(-1);
  let cancel = descendants(rowFor(ui, 5)).find(el => el.classList.contains('attachment-cancel'));
  cancel.click();
  cancel.click();
  assert.deepEqual(ui.outbound.at(-1), { command: 'cancelAttachment', requestId: request.requestId });
  assert.equal(cancel.disabled, true);
  ui.receive({ command: 'attachmentStatus', requestId: request.requestId, fileStatus: 'saving' });
  assert.equal(cancel.disabled, true);
  ui.receive({ command: 'attachmentStatus', requestId: request.requestId, fileStatus: 'cancelled' });
  assert.equal(saveButton(rowFor(ui, 5)).textContent, '另存为…');
  assert.equal(cancel.classList.contains('hidden'), true);
  saveButton(rowFor(ui, 5)).click();
  const old = ui.outbound.at(-1);
  sync(ui, { generation: 'generation-b', reset: true, messages: [attachment(5)] });
  ui.receive({ command: 'attachmentStatus', requestId: old.requestId, fileStatus: 'saved' });
  assert.equal(saveButton(rowFor(ui, 5)).textContent, '另存为…');
  saveButton(rowFor(ui, 5)).click();
  assert.equal(ui.outbound.at(-1).generation, 'generation-b');
});

test('file cards require host permission and never open legacy or multipart file URLs directly', () => {
  const ui = webview();
  sync(ui, { reset: true, messages: [
    attachment(1, { url: 'https://example.com/file', fileAction: undefined }),
    attachment(2, { url: 'https://example.com/file', fileAction: { canSave: false, reason: '此通道不可下载文件' } }),
    { ...message(3), type: 4, content: 'https://example.com/legacy-file' },
  ] });
  for (const id of [1, 2, 3]) {
    assert.equal(saveButton(rowFor(ui, id)), undefined);
    descendants(rowFor(ui, id)).forEach(el => el.click());
  }
  assert.match(nodeText(rowFor(ui, 2)), /此通道不可下载文件/);
  assert.equal(ui.outbound.filter(msg => ['openExternal', 'saveAttachment'].includes(msg.command)).length, 0);
});

test('context file saving uses its own generation without loading history or marking live messages read', () => {
  const ui = webview();
  const search = submitHistorySearch(ui, { query: 'file' });
  ui.receive({ command: 'searchResults', requestId: search.requestId, generation: 'context-generation', messages: [message(9)], hasMore: false });
  ui.element('search-results').children[0].click();
  const request = ui.outbound.at(-1);
  ui.receive({ command: 'messageContext', requestId: request.requestId, generation: 'context-generation', messages: [attachment(9)], targetId: 9, hasBefore: false, hasAfter: false });
  const before = readReports(ui).length;
  saveButton(ui.element('search-context-messages')).click();
  const save = ui.outbound.at(-1);
  assert.equal(save.command, 'saveAttachment');
  assert.equal(save.generation, 'context-generation');
  assert.equal(save.targetId, 9);
  ui.receive({ command: 'settings', renderMarkdown: false });
  assert.equal(saveButton(ui.element('search-context-messages')).disabled, true);
  ui.receive({ command: 'attachmentStatus', requestId: save.requestId, fileStatus: 'saved' });
  assert.equal(saveButton(ui.element('search-context-messages')).textContent, '再次保存…');
  assert.deepEqual(ui.ids(), []);
  assert.equal(readReports(ui).length, before);
});

const dataRequests = ui => ui.outbound.filter(msg => msg.command.startsWith('data') && msg.command !== 'dataDismissPreview');
const dataSummary = {
  export: { messageCount: 12, bytes: 2048 },
  backup: { messageCount: 12, imageCount: 3, missingImages: 1, skippedImages: 2, bytes: 4096 },
  restorePreview: { messageCount: 12, imageCount: 3, imageBytes: 2048, fromTimestamp: 1700000000, toTimestamp: 1700100000, newCount: 8, duplicateCount: 3, conflictCount: 1 },
  restoreConfirm: { inserted: 8, skipped: 3, conflicts: 1, imagesRestored: 1, imagesExisting: 1, imagesFailed: 1 },
  storage: { databaseBytes: 1024, cacheBytes: 2048, draftBytes: 512, temporaryBytes: 0, quarantineBytes: 1024, otherBytes: 512, totalBytes: 5120, fileCount: 8 },
  cleanupPreview: { count: 3, bytes: 1024 },
  cleanupConfirm: { moved: 1, skipped: 1, failed: 1, bytes: 512 },
};

function openData(ui) {
  sync(ui, { reset: true, messages: [message(1)] });
  ui.element('data-toggle').click();
}

function finishData(ui, request, operation, overrides = {}) {
  ui.receive({ command: 'dataResult', requestId: request.requestId, operation, data: dataSummary[operation], ...overrides });
}

test('data exports use explicit local date filters and one correlated request at a time', () => {
  const ui = webview();
  openData(ui);
  assert.equal(dataRequests(ui).length, 0, 'opening data tools does not start a native dialog or operation');
  ui.element('data-from').value = '2026-05-10';
  ui.element('data-to').value = '2026-05-11';
  ui.element('export-markdown').click();
  const request = dataRequests(ui).at(-1);
  assert.deepEqual(request, { command: 'dataExport', requestId: request.requestId, format: 'markdown',
    fromTimestamp: new Date(2026, 4, 10).getTime() / 1000, toTimestamp: new Date(2026, 4, 12).getTime() / 1000 });
  ui.element('export-json').click();
  ui.element('backup-create').click();
  assert.equal(dataRequests(ui).length, 1);
  assert.equal(ui.element('data-from').disabled, true);
  finishData(ui, { requestId: 'unrelated' }, 'export');
  finishData(ui, request, 'backup');
  assert.equal(ui.element('export-json').disabled, true);
  finishData(ui, request, 'export');
  assert.match(ui.element('data-status').textContent, /已导出 12 条消息，2.0 KiB/);
  assert.equal(ui.element('export-json').disabled, false);
  ui.element('data-from').value = '';
  ui.element('data-to').value = '';
  ui.element('export-json').click();
  const json = dataRequests(ui).at(-1);
  assert.deepEqual(Object.keys(json).sort(), ['command', 'format', 'requestId']);
  assert.equal(json.format, 'json');
});

test('export validates calendar ranges and handles DST without a fixed-day offset', () => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const ui = webview();
    openData(ui);
    for (const [from, to] of [['2026-05-12', '2026-05-10'], ['2026-02-30', ''], ['not-a-date', '']]) {
      ui.element('data-from').value = from;
      ui.element('data-to').value = to;
      ui.element('export-json').click();
      assert.equal(dataRequests(ui).length, 0);
      assert.match(ui.element('data-status').textContent, /日期/);
    }
    ui.element('data-from').value = '2026-03-08';
    ui.element('data-to').value = '2026-03-08';
    ui.element('export-json').click();
    const request = dataRequests(ui).at(-1);
    assert.equal(request.toTimestamp - request.fromTimestamp, 23 * 3600);
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test('backup image options are explicit and cancelled, failed or malformed results never imply success', () => {
  const ui = webview();
  openData(ui);
  ui.element('backup-create').click();
  let request = dataRequests(ui).at(-1);
  assert.deepEqual(request, { command: 'dataBackup', requestId: request.requestId, includeImages: true });
  finishData(ui, request, 'backup', { cancelled: true });
  assert.match(ui.element('data-status').textContent, /已取消备份/);
  ui.element('backup-images').checked = false;
  ui.element('backup-create').click();
  request = dataRequests(ui).at(-1);
  assert.equal(request.includeImages, false);
  finishData(ui, request, 'backup', { error: 'disk unavailable' });
  assert.match(ui.element('data-status').textContent, /备份失败：disk unavailable/);
  ui.element('backup-create').click();
  request = dataRequests(ui).at(-1);
  finishData(ui, request, 'backup', { data: { messageCount: 1 } });
  assert.match(ui.element('data-status').textContent, /无法确认完成/);
  ui.element('backup-create').click();
  request = dataRequests(ui).at(-1);
  finishData(ui, request, 'backup');
  assert.match(ui.element('data-status').textContent, /备份完成.*12 条消息.*3 张图片.*缺失图片 1 张，跳过 2 张/);
});

test('restore previews show only safe summary fields and require a separate one-time confirmation', () => {
  const ui = webview();
  openData(ui);
  writeDraft(ui, 'keep text');
  ui.element('restore-select').click();
  const request = dataRequests(ui).at(-1);
  assert.deepEqual(Object.keys(request).sort(), ['command', 'requestId']);
  assert.equal(request.command, 'dataRestorePreview');
  finishData(ui, request, 'restorePreview', { previewId: 'opaque-preview', generation: 'generation-a',
    data: { ...dataSummary.restorePreview, filePath: '/private/secret.json', credentials: 'TOP_SECRET', text: '<script>unsafe</script>' } });
  const text = ui.element('restore-preview').textContent;
  assert.match(text, /可追加 8 条，重复 3 条，冲突 1 条/);
  assert.match(text, /仅追加.*跳过.*不覆盖.*不恢复登录/);
  assert.equal(/TOP_SECRET|secret.json|<script>/.test(text), false);
  assert.equal(ui.element('restore-confirm').disabled, false);
  assert.equal(ui.element('restore-preview').classList.contains('hidden'), false);
  assert.equal(dataRequests(ui).length, 1);
  ui.element('restore-confirm').click();
  const confirm = dataRequests(ui).at(-1);
  assert.deepEqual(confirm, { command: 'dataRestoreConfirm', requestId: confirm.requestId, previewId: 'opaque-preview' });
  ui.element('restore-confirm').click();
  assert.equal(dataRequests(ui).length, 2);
  finishData(ui, confirm, 'restoreConfirm', { data: { ...dataSummary.restoreConfirm, refreshPending: true } });
  assert.match(ui.element('data-status').textContent, /部分图片未恢复.*新增 8 条.*失败 1 张/);
  assert.match(ui.element('data-status').textContent, /恢复数据已保存，聊天列表暂未刷新.*重新打开视图.*无需重复导入/);
  assert.equal(ui.element('restore-preview').textContent, ui.element('data-status').textContent);
  assert.equal(ui.element('restore-confirm').disabled, true);
  assert.equal(ui.element('text-input').value, 'keep text');
  assert.equal(sends(ui).length, 0);
  assert.equal(JSON.stringify(ui.state()).includes('opaque-preview'), false, 'preview tokens remain memory-only');
});

test('failed restore confirmation consumes its preview and demands a new explicit preview before retry', () => {
  const ui = webview();
  openData(ui);
  ui.element('restore-select').click();
  finishData(ui, dataRequests(ui).at(-1), 'restorePreview', { previewId: 'restore-token', generation: 'generation-a' });
  ui.element('restore-confirm').click();
  const confirm = dataRequests(ui).at(-1);
  finishData(ui, confirm, 'restoreConfirm', { error: 'preview expired' });
  assert.match(ui.element('data-status').textContent, /追加恢复失败：preview expired/);
  ui.element('restore-confirm').click();
  assert.equal(dataRequests(ui).length, 2);
  assert.equal(ui.element('restore-select').disabled, false);
});

test('closing data tools releases unconfirmed previews but lets submitted work finish without cancellation', () => {
  const ui = webview();
  openData(ui);
  ui.element('restore-select').click();
  finishData(ui, dataRequests(ui).at(-1), 'restorePreview', { previewId: 'close-token', generation: 'generation-a' });
  ui.element('data-close').click();
  assert.equal(ui.outbound.at(-1).command, 'dataDismissPreview');
  assert.equal(ui.outbound.at(-1).previewId, 'close-token');
  assert.equal(ui.element('data-toggle').attributes['aria-expanded'], 'false');
  ui.element('data-toggle').click();
  assert.equal(ui.element('restore-confirm').disabled, true);
  ui.element('backup-create').click();
  const request = dataRequests(ui).at(-1);
  ui.element('data-close').click();
  ui.element('data-toggle').click();
  assert.equal(ui.element('backup-create').disabled, true);
  finishData(ui, request, 'backup');
  assert.match(ui.element('data-status').textContent, /备份完成/);
  assert.equal(ui.element('backup-create').disabled, false);
});

test('closed or changed-generation preview replies are dismissed and cannot re-enable confirmation', () => {
  const ui = webview();
  openData(ui);
  ui.element('restore-select').click();
  let request = dataRequests(ui).at(-1);
  ui.element('data-close').click();
  ui.element('data-toggle').click();
  finishData(ui, request, 'restorePreview', { previewId: 'closed-token', generation: 'generation-a' });
  assert.equal(ui.outbound.at(-1).previewId, 'closed-token');
  assert.equal(ui.element('restore-confirm').disabled, true);
  assert.match(ui.element('data-status').textContent, /预览已失效或已关闭/);
  ui.element('cleanup-preview').click();
  request = dataRequests(ui).at(-1);
  sync(ui, { reset: true, generation: 'generation-b', messages: [message(1)] });
  finishData(ui, request, 'cleanupPreview', { previewId: 'old-generation', generation: 'generation-a' });
  assert.equal(ui.outbound.at(-1).previewId, 'old-generation');
  assert.equal(ui.element('cleanup-confirm').disabled, true);
  ui.element('cleanup-preview').click();
  request = dataRequests(ui).at(-1);
  finishData(ui, request, 'cleanupPreview', { previewId: 'current-generation', generation: 'generation-b' });
  assert.equal(ui.element('cleanup-confirm').disabled, false);
  sync(ui, { reset: true, generation: 'generation-c', messages: [] });
  assert.equal(ui.outbound.at(-1).previewId, 'current-generation');
  assert.equal(ui.element('cleanup-confirm').disabled, true);
});

test('replacing a preview releases its token and cache isolation clearly preserves data and disk usage', () => {
  const ui = webview();
  openData(ui);
  ui.element('restore-select').click();
  finishData(ui, dataRequests(ui).at(-1), 'restorePreview', { previewId: 'replace-me', generation: 'generation-a' });
  ui.element('cleanup-preview').click();
  const request = dataRequests(ui).at(-1);
  assert.ok(ui.outbound.some(msg => msg.command === 'dataDismissPreview' && msg.previewId === 'replace-me'));
  assert.equal(ui.element('restore-confirm').disabled, true);
  finishData(ui, request, 'cleanupPreview', { previewId: 'quarantine-token', generation: 'generation-a' });
  assert.match(ui.element('cleanup-summary').textContent, /3 个旧缓存文件.*1.0 KiB/);
  assert.equal(ui.element('cleanup-summary').classList.contains('hidden'), false);
  assert.match(ui.element('cleanup-summary').textContent, /保留目录.*不删除任何数据.*不释放磁盘空间.*草稿和登录凭据保持不变/s);
  assert.equal(dataRequests(ui).filter(msg => msg.command === 'dataCleanupConfirm').length, 0);
  ui.element('cleanup-confirm').click();
  const confirm = dataRequests(ui).at(-1);
  assert.deepEqual(confirm, { command: 'dataCleanupConfirm', requestId: confirm.requestId, previewId: 'quarantine-token' });
  ui.element('cleanup-confirm').click();
  finishData(ui, confirm, 'cleanupConfirm');
  assert.match(ui.element('data-status').textContent, /部分失败.*移入保留目录 1 个.*跳过 1 个，失败 1 个.*未释放磁盘空间/);
  assert.equal(ui.element('cleanup-confirm').disabled, true);
});

test('storage shows only numeric categories and leaves credentials and paths out of the rendered summary', () => {
  const ui = webview();
  openData(ui);
  ui.element('storage-refresh').click();
  const request = dataRequests(ui).at(-1);
  assert.deepEqual(Object.keys(request).sort(), ['command', 'requestId']);
  finishData(ui, request, 'storage', { data: { ...dataSummary.storage, secret: 'SECRET_KEY', path: '/private/cache' } });
  const summary = ui.element('storage-summary').textContent;
  assert.match(summary, /总计 5.0 KiB，8 个文件/);
  for (const label of ['聊天数据库', '媒体缓存', '文件草稿', '临时文件', '隔离保留目录', '其他']) assert.ok(summary.includes(label));
  assert.equal(/SECRET_KEY|\/private/.test(summary), false);
  assert.match(ui.element('data-status').textContent, /保留文件，不释放磁盘空间/);
});

test('data and search panels are exclusive and preserve reading position, draft and authoritative unread', () => {
  const ui = webview();
  writeDraft(ui, 'draft with\nmultiple lines');
  selectQuote(ui);
  const image = pasteImage(ui);
  sync(ui, { reset: true, messages: Array.from({ length: 20 }, (_, i) => message(i + 1)), unreadCount: 7 });
  const container = ui.element('chat-container');
  container.scrollTop = 35;
  container.events.scroll({});
  ui.receive({ command: 'hostFocus', focused: true });
  ui.element('search-toggle').click();
  assert.equal(container.inert, true);
  assert.equal(container.attributes['aria-hidden'], 'true');
  ui.element('data-toggle').click();
  assert.equal(ui.element('search-panel').classList.contains('hidden'), true);
  assert.equal(ui.element('data-panel').classList.contains('hidden'), false);
  assert.equal(ui.element('data-toggle').attributes['aria-expanded'], 'true');
  assert.equal(container.inert, true, 'switching tools must not expose the covered timeline');
  assert.equal(container.scrollTop, 35);
  ui.element('toolbar').events.click({ target: { closest: () => ({ dataset: { mode: 'git' } }) } });
  ui.element('storage-refresh').click();
  finishData(ui, dataRequests(ui).at(-1), 'storage');
  container.scrollTop = container.scrollHeight;
  container.events.scroll({});
  ui.focusWindow();
  assert.equal(readReports(ui).length, 0);
  assert.match(ui.element('new-messages').textContent, /7 条/);
  assert.equal(ui.element('text-input').value, 'draft with\nmultiple lines');
  assert.equal(ui.element('paste-preview').src, image.data);
  assert.equal(ui.state().drafts.QQ.quote.messageId, 'quoted-message');
  ui.element('search-toggle').click();
  assert.equal(ui.element('data-panel').classList.contains('hidden'), true);
  assert.equal(ui.element('search-panel').classList.contains('hidden'), false);
  assert.equal(container.inert, true);
  assert.equal(readReports(ui).length, 0);
  assert.equal(sends(ui).length, 0);
});

test('Escape closes only the active tool, releases its preview and restores chat without changing the draft or unread', () => {
  const ui = webview();
  sync(ui, { reset: true, messages: Array.from({ length: 20 }, (_, i) => message(i + 1)), unreadCount: 7 });
  const container = ui.element('chat-container');
  container.scrollTop = 35;
  container.events.scroll({});
  ui.receive({ command: 'hostFocus', focused: true });
  writeDraft(ui, 'keep this\nmultiline draft');
  const rows = [...ui.element('messages').children];

  ui.element('search-toggle').click();
  assert.equal(container.inert, true);
  assert.equal(ui.keyDown('ArrowDown'), false);
  assert.equal(ui.element('search-panel').classList.contains('hidden'), false);
  assert.equal(ui.keyDown('Escape', { isComposing: true }), false);
  assert.equal(ui.keyDown('Escape', { defaultPrevented: true }), false);
  assert.equal(ui.element('search-panel').classList.contains('hidden'), false, 'IME and an already handled key must not close the tool');
  assert.equal(ui.keyDown('Escape'), true);
  assert.equal(ui.element('search-panel').classList.contains('hidden'), true);
  assert.equal(ui.element('search-toggle').attributes['aria-expanded'], 'false');
  assert.equal(container.inert, false);
  assert.notEqual(container.attributes['aria-hidden'], 'true');
  assert.equal(ui.element('text-input').focused, true);
  assert.equal(container.scrollTop, 35);

  ui.element('data-toggle').click();
  ui.element('restore-select').click();
  finishData(ui, dataRequests(ui).at(-1), 'restorePreview', { previewId: 'escape-preview', generation: 'generation-a' });
  assert.equal(ui.element('restore-confirm').disabled, false);
  assert.equal(container.inert, true);
  assert.equal(ui.keyDown('Escape'), true);
  assert.equal(ui.element('data-panel').classList.contains('hidden'), true);
  assert.equal(ui.element('data-toggle').attributes['aria-expanded'], 'false');
  assert.equal(ui.element('restore-confirm').disabled, true);
  assert.ok(ui.outbound.some(msg => msg.command === 'dataDismissPreview' && msg.previewId === 'escape-preview'));
  assert.equal(dataRequests(ui).filter(msg => msg.command === 'dataRestoreConfirm').length, 0);
  assert.equal(container.inert, false);
  assert.notEqual(container.attributes['aria-hidden'], 'true');
  assert.equal(ui.element('text-input').value, 'keep this\nmultiline draft');
  assert.equal(container.scrollTop, 35);
  assert.ok(rows.every((row, index) => ui.element('messages').children[index] === row));
  assert.match(ui.element('new-messages').textContent, /7 条/);
  assert.equal(readReports(ui).length, 0);
  assert.equal(sends(ui).length, 0);
  assert.equal(ui.keyDown('Escape'), false, 'Escape outside tools must remain available to other interactions');
});

test('restored tail records neither scroll to the end nor acknowledge existing unread deliveries', () => {
  const ui = webview();
  sync(ui, { reset: true, messages: Array.from({ length: 10 }, (_, i) => message(i + 1)), unreadCount: 2 });
  const container = ui.element('chat-container');
  container.scrollTop = 35;
  container.events.scroll({});
  ui.receive({ command: 'hostFocus', focused: true });
  const imported = Array.from({ length: 12 }, (_, i) => ({ ...message(i + 11), restored: true, direction: 'received' }));
  sync(ui, { messages: imported, unreadCount: 2 });
  assert.equal(container.scrollTop, 35);
  assert.equal(readReports(ui).length, 0);
  container.scrollTop = container.scrollHeight;
  container.events.scroll({});
  ui.focusWindow();
  ui.setHidden(true);
  ui.setHidden(false);
  ui.receive({ command: 'revealLatest' });
  sync(ui, { unreadCount: 2 });
  assert.equal(readReports(ui).length, 0);
  assert.match(ui.element('new-messages').textContent, /2 条/);
  sync(ui, { messages: [{ ...message(23), direction: 'received' }], unreadCount: 3 });
  assert.deepEqual(readReports(ui).at(-1), { command: 'markRead', generation: 'generation-a', throughId: 23 });
  assert.equal(readReports(ui).some(msg => msg.throughId >= 11 && msg.throughId <= 22), false);
});

const recipientOptions = [
  { id: 'alice', label: 'Alice <team>', canSend: true, unreadCount: 2 },
  { id: 'bob', label: 'Bob', canSend: true, unreadCount: 4 },
  { id: '__history__', label: '全部历史（只读）', canSend: false, unreadCount: 0 },
];
const recipientDraft = (ui, id) => ui.state().drafts[JSON.stringify(['QQ', id])];

function manageRecipients(ui, options = recipientOptions) {
  ui.receive({ command: 'recipients', recipients: options, totalUnreadCount: 6 });
}

function requestRecipient(ui, recipientId) {
  ui.element('recipient-select').value = recipientId;
  ui.element('recipient-select').events.change({});
  const request = ui.outbound.filter(msg => msg.command === 'selectRecipient').at(-1);
  assert.equal(request.recipientId, recipientId);
  return request;
}

function acknowledgeRecipient(ui, request, messages = []) {
  const scope = { recipientId: request.recipientId, selectionId: request.requestId };
  ui.receive({ command: 'recipientSelected', requestId: request.requestId, ...scope });
  sync(ui, { ...scope, reset: true, messages });
  return scope;
}

function chooseRecipient(ui, recipientId, messages = []) {
  return acknowledgeRecipient(ui, requestRecipient(ui, recipientId), messages);
}

test('managed recipients never auto-select a new contact and keep legacy drafts in read-only history', () => {
  const ui = webview({ state: { drafts: { QQ: { text: 'old unbound draft', quote: { messageId: 'old-quote' },
    send: { requestId: 'old-send', kind: 'text', text: 'old unbound draft', status: 'uncertain' } } } } });
  manageRecipients(ui);
  assert.equal(ui.outbound.some(msg => msg.command === 'selectRecipient'), false);
  assert.equal(ui.element('send-btn').disabled, true);
  assert.equal(ui.element('text-input').value, '');
  assert.equal(recipientDraft(ui, '__history__').text, 'old unbound draft');
  assert.equal(ui.state().drafts.QQ.text, 'old unbound draft');
  assert.equal(ui.element('recipient-select').children[1].textContent, 'Alice <team> · 2 未读');
  const scope = chooseRecipient(ui, '__history__', [message(1)]);
  assert.equal(ui.element('text-input').value, 'old unbound draft');
  assert.equal(ui.element('text-input').readOnly, true);
  assert.equal(ui.element('retry-send').disabled, true);
  assert.equal(ui.element('confirm-send').disabled, true);
  assert.match(ui.element('recipient-status').textContent, /只读.*不能发送/);
  ui.receive({ command: 'hostFocus', focused: true });
  ui.receive({ command: 'revealLatest', ...scope });
  ui.element('retry-send').click();
  ui.element('send-btn').click();
  assert.equal(sends(ui).length, 0);
  assert.equal(readReports(ui).length, 0);
  chooseRecipient(ui, 'alice');
  assert.equal(ui.element('text-input').value, '');
  assert.equal(ui.element('quote-bar').classList.contains('hidden'), true);
});

test('recipient selection locks input until its exact acknowledgement and sends bind to the selected scope', () => {
  const ui = webview();
  manageRecipients(ui);
  const request = requestRecipient(ui, 'alice');
  assert.equal(ui.element('text-input').readOnly, true);
  ui.receive({ command: 'recipientSelected', requestId: 'wrong', recipientId: 'alice', selectionId: request.requestId });
  assert.equal(ui.element('send-btn').disabled, true);
  const scope = acknowledgeRecipient(ui, request);
  writeDraft(ui, 'only Alice');
  ui.element('send-btn').click();
  const send = sends(ui).at(-1);
  assert.equal(send.recipientId, 'alice');
  assert.equal(send.selectionId, scope.selectionId);
  assert.equal(recipientDraft(ui, 'alice').send.recipientId, 'alice');
  manageRecipients(ui, [...recipientOptions, { id: 'newest', label: 'Newest inbound', canSend: true, unreadCount: 8 }]);
  assert.equal(ui.element('recipient-select').value, 'alice');
  assert.equal(ui.element('recipient-status').textContent, '');
  assert.equal(ui.element('recipient-status').classList.contains('hidden'), true);
  assert.match(ui.element('recipient-select').title, /发送给：Alice.*全部未读 6 条/);
  assert.equal(ui.element('recipient-bar').classList.contains('hidden'), false);
  assert.equal(ui.state().selectedRecipients.QQ, 'alice');
  ui.element('recipient-refresh').click();
  assert.equal(ui.outbound.at(-1).command, 'refreshRecipients');
});

test('contact switching isolates text, quotes, images and file drafts without releasing another contact token', () => {
  const ui = webview();
  manageRecipients(ui);
  const alice = chooseRecipient(ui, 'alice', [{ ...message(1), message_id: 'alice-quote' }]);
  writeDraft(ui, 'Alice draft');
  rowFor(ui, 1).children.find(el => el.className === 'quote-action').click();
  const image = pasteImage(ui);
  const bob = chooseRecipient(ui, 'bob', [message(2)]);
  assert.equal(ui.element('text-input').value, '');
  assert.equal(ui.element('paste-preview').src, undefined);
  assert.equal(ui.element('quote-bar').classList.contains('hidden'), true);
  writeDraft(ui, 'Bob draft');
  enableFiles(ui);
  chooseClientFile(ui);
  const select = ui.outbound.at(-1);
  assert.equal(select.recipientId, 'bob');
  ui.receive({ command: 'fileSelected', requestId: select.requestId, ...bob,
    fileDraft: { fileId: 'bob-file', fileName: 'bob.txt', size: 7 } });
  chooseRecipient(ui, 'alice', [{ ...message(1), message_id: 'alice-quote' }]);
  assert.equal(ui.element('text-input').value, 'Alice draft');
  assert.equal(ui.element('paste-preview').src, image.data);
  assert.equal(ui.element('quote-preview').textContent, '回复: text 1');
  assert.equal(ui.outbound.some(msg => msg.command === 'removeFileDraft' && msg.fileId === 'bob-file'), false);
  const bobAgain = chooseRecipient(ui, 'bob', [message(2)]);
  assert.equal(ui.element('text-input').value, 'Bob draft');
  assert.equal(ui.element('file-draft-name').textContent, 'bob.txt · 7 B');
  const validation = ui.outbound.filter(msg => msg.command === 'getFileDraft').at(-1);
  assert.equal(validation.selectionId, bobAgain.selectionId);
  assert.equal(ui.element('send-btn').disabled, true);
  ui.receive({ command: 'fileDraftStatus', fileId: 'bob-file', valid: true, ...alice });
  assert.equal(ui.element('send-btn').disabled, true);
  ui.receive({ command: 'fileDraftStatus', fileId: 'bob-file', valid: true, ...bobAgain });
  ui.element('send-btn').click();
  assert.equal(sends(ui).at(-1).recipientId, 'bob');
  assert.equal(sends(ui).at(-1).fileId, 'bob-file');
});

test('late send failures stay with the original contact and explicit retry uses that contact with the new selection', () => {
  const ui = webview();
  manageRecipients(ui);
  const alice = chooseRecipient(ui, 'alice');
  writeDraft(ui, 'Alice pending');
  ui.element('send-btn').click();
  const first = sends(ui).at(-1);
  const bob = chooseRecipient(ui, 'bob');
  writeDraft(ui, 'Bob untouched');
  ui.receive({ command: 'sendStatus', requestId: first.requestId, sendStatus: 'failed', error: 'wrong scope', ...bob });
  assert.equal(recipientDraft(ui, 'alice').send.status, 'sending');
  ui.receive({ command: 'sendStatus', requestId: first.requestId, sendStatus: 'uncertain', error: 'unknown delivery', ...alice });
  assert.equal(recipientDraft(ui, 'alice').send.status, 'uncertain');
  assert.equal(ui.element('text-input').value, 'Bob untouched');
  assert.equal(ui.element('send-feedback').classList.contains('hidden'), true);
  assert.equal(sends(ui).length, 1);
  const aliceAgain = chooseRecipient(ui, 'alice');
  assert.equal(ui.element('text-input').value, 'Alice pending');
  assert.match(ui.element('send-status').textContent, /发送结果待确认.*unknown delivery/);
  const statusRequest = ui.outbound.filter(msg => msg.command === 'getSendStatus').at(-1);
  assert.equal(statusRequest.requestId, first.requestId);
  assert.equal(statusRequest.recipientId, 'alice');
  assert.equal(statusRequest.selectionId, aliceAgain.selectionId);
  ui.element('retry-send').click();
  const retry = sends(ui).at(-1);
  assert.equal(retry.recipientId, 'alice');
  assert.equal(retry.selectionId, aliceAgain.selectionId);
  assert.notEqual(retry.requestId, first.requestId);
  assert.equal(recipientDraft(ui, 'bob').text, 'Bob untouched');
});

test('background success clears only the original matching draft and attachment success preserves its separate text', () => {
  for (const kind of ['text', 'image', 'file']) {
    const ui = webview();
    manageRecipients(ui);
    const alice = chooseRecipient(ui, 'alice');
    writeDraft(ui, 'Alice independent text');
    if (kind === 'image') pasteImage(ui);
    if (kind === 'file') {
      enableFiles(ui);
      chooseClientFile(ui);
      ui.receive({ command: 'fileSelected', requestId: ui.outbound.at(-1).requestId, ...alice,
        fileDraft: { fileId: 'alice-file', fileName: 'a.txt', size: 1 } });
    }
    ui.element('send-btn').click();
    const request = sends(ui).at(-1);
    chooseRecipient(ui, 'bob');
    writeDraft(ui, 'Bob separate draft');
    ui.receive({ command: 'sendStatus', requestId: request.requestId, sendStatus: 'sent', ...alice });
    assert.equal(ui.element('text-input').value, 'Bob separate draft');
    assert.equal(recipientDraft(ui, 'alice').send, null);
    assert.equal(recipientDraft(ui, 'alice').text, kind === 'text' ? '' : 'Alice independent text');
    if (kind === 'file') assert.equal(recipientDraft(ui, 'alice').file, null);
    if (kind === 'image') assert.equal(recipientDraft(ui, 'alice').image, null);
    chooseRecipient(ui, 'alice');
    assert.equal(ui.element('text-input').value, kind === 'text' ? '' : 'Alice independent text');
    assert.match(ui.element('send-status').textContent, /已发送/);
  }
});

test('A to B to A selection IDs reject old snapshots, history pages, errors and context replies', () => {
  const ui = webview();
  manageRecipients(ui);
  const alice = chooseRecipient(ui, 'alice', [message(1)]);
  const search = submitHistorySearch(ui, { query: 'Alice search' });
  assert.equal(search.recipientId, 'alice');
  assert.equal(search.selectionId, alice.selectionId);
  const pendingBob = requestRecipient(ui, 'bob');
  const currentAlice = requestRecipient(ui, 'alice');
  ui.receive({ command: 'recipientSelected', requestId: pendingBob.requestId, recipientId: 'bob', selectionId: pendingBob.requestId });
  assert.equal(ui.element('text-input').readOnly, true);
  const aliceAgain = acknowledgeRecipient(ui, currentAlice, [message(2)]);
  sync(ui, { ...alice, reset: true, messages: [message(99)], unreadCount: 99 });
  ui.receive({ command: 'loadHistory', ...alice, generation: 'generation-a', messages: [message(98)], older: true, hasMore: true });
  ui.receive({ command: 'searchResults', ...alice, generation: 'generation-a', requestId: search.requestId, messages: [message(99)] });
  ui.receive({ command: 'error', ...alice, error: 'old Alice error' });
  assert.deepEqual(ui.ids(), [2]);
  assert.equal(ui.element('search-results').children.length, 0);
  assert.equal(nodeText(ui.element('messages')).includes('old Alice error'), false);
  const query = submitHistorySearch(ui, { query: 'current' });
  assert.equal(query.selectionId, aliceAgain.selectionId);
  ui.receive({ command: 'searchResults', ...aliceAgain, generation: 'generation-a', requestId: query.requestId, messages: [message(2)] });
  ui.element('search-results').children[0].click();
  const context = ui.outbound.at(-1);
  assert.equal(context.recipientId, 'alice');
  const bob = chooseRecipient(ui, 'bob', [message(3)]);
  ui.receive({ command: 'messageContext', ...aliceAgain, generation: 'generation-a', requestId: context.requestId, targetId: 2, messages: [message(2)] });
  assert.deepEqual(ui.ids(), [3]);
  assert.equal(ui.element('search-context-messages').children.length, 0);
  assert.notEqual(bob.selectionId, aliceAgain.selectionId);
});

test('switching rejects image reads and late native selection results without contaminating the new contact', () => {
  const ui = webview({ deferFileReads: true });
  manageRecipients(ui);
  const alice = chooseRecipient(ui, 'alice');
  writeDraft(ui, 'Alice keep');
  enableFiles(ui);
  chooseClientFile(ui);
  const select = ui.outbound.at(-1);
  pasteImage(ui);
  const bob = chooseRecipient(ui, 'bob');
  writeDraft(ui, 'Bob keep');
  ui.readers[0].complete();
  ui.receive({ command: 'fileSelected', ...alice, requestId: select.requestId,
    fileDraft: { fileId: 'late-alice-file', fileName: 'late.txt', size: 10 } });
  assert.equal(ui.element('paste-preview').src, undefined);
  assert.equal(ui.element('file-draft').classList.contains('hidden'), true);
  assert.equal(ui.element('text-input').value, 'Bob keep');
  assert.equal(recipientDraft(ui, 'alice').image, null);
  assert.equal(ui.outbound.at(-1).command, 'removeFileDraft');
  assert.equal(ui.outbound.at(-1).recipientId, 'alice');
  assert.equal(ui.outbound.at(-1).selectionId, alice.selectionId);
  assert.notEqual(ui.outbound.at(-1).selectionId, bob.selectionId);
});

test('recreation restores only a previously selected contact and queries its original pending send without resending', () => {
  const ui = webview();
  manageRecipients(ui);
  const alice = chooseRecipient(ui, 'alice');
  writeDraft(ui, 'pending through reload');
  ui.element('send-btn').click();
  const request = sends(ui).at(-1);
  const recreated = webview({ state: ui.state() });
  manageRecipients(recreated);
  const restoreSelection = recreated.outbound.filter(msg => msg.command === 'selectRecipient').at(-1);
  assert.equal(restoreSelection.recipientId, 'alice');
  assert.notEqual(restoreSelection.requestId, alice.selectionId);
  acknowledgeRecipient(recreated, restoreSelection);
  assert.equal(recreated.element('text-input').value, 'pending through reload');
  assert.equal(sends(recreated).length, 0);
  assert.equal(recreated.outbound.filter(msg => msg.command === 'getSendStatus').at(-1).requestId, request.requestId);
  recreated.receive({ command: 'sendStatus', requestId: request.requestId, sendStatus: 'sent', ...alice });
  assert.equal(recreated.element('text-input').value, '');
});

test('recipient invalidation and failed selection retain drafts, clear unsafe view state and require another explicit choice', () => {
  const ui = webview();
  manageRecipients(ui);
  const alice = chooseRecipient(ui, 'alice', [message(1)]);
  writeDraft(ui, 'preserve Alice');
  const pending = requestRecipient(ui, 'bob');
  ui.receive({ command: 'recipientSelectionError', requestId: pending.requestId, error: 'not available' });
  assert.equal(ui.element('send-btn').disabled, true);
  assert.equal(ui.element('recipient-select').value, '');
  assert.match(ui.element('recipient-status').textContent, /切换失败.*not available/);
  const confirmed = chooseRecipient(ui, 'alice', [message(1)]);
  ui.receive({ command: 'recipientSelectionError', requestId: confirmed.selectionId, error: 'history load failed' });
  assert.match(ui.element('recipient-status').textContent, /history load failed/);
  assert.equal(ui.element('send-btn').disabled, true);
  chooseRecipient(ui, 'alice', [message(1)]);
  ui.receive({ command: 'recipientInvalidated', error: 'account changed' });
  assert.deepEqual(ui.ids(), []);
  assert.equal(ui.element('text-input').value, '');
  assert.equal(recipientDraft(ui, 'alice').text, 'preserve Alice');
  assert.equal(ui.state().selectedRecipients.QQ, undefined);
  sync(ui, { ...alice, reset: true, messages: [message(99)] });
  assert.deepEqual(ui.ids(), []);
  const count = ui.outbound.filter(msg => msg.command === 'selectRecipient').length;
  manageRecipients(ui, [{ id: 'charlie', label: 'New account peer', canSend: true }]);
  assert.equal(ui.outbound.filter(msg => msg.command === 'selectRecipient').length, count);
  assert.equal(ui.element('send-btn').disabled, true);
});

test('recipient capability and unread updates keep the target stable and history actions carry exact scope', () => {
  const ui = webview();
  manageRecipients(ui);
  const alice = chooseRecipient(ui, 'alice', Array.from({ length: 20 }, (_, i) => message(i + 1)));
  const container = ui.element('chat-container');
  container.scrollTop = 35;
  container.events.scroll({});
  ui.receive({ command: 'hostFocus', focused: true });
  ui.element('load-more-history').click();
  const older = ui.outbound.at(-1);
  assert.equal(older.recipientId, 'alice');
  assert.equal(older.selectionId, alice.selectionId);
  writeDraft(ui, 'paused target');
  manageRecipients(ui, recipientOptions.map(option => option.id === 'alice'
    ? { ...option, canSend: false, reason: '回复窗口已过期' } : { ...option, unreadCount: 10 }));
  assert.equal(ui.element('recipient-select').value, 'alice');
  assert.equal(ui.element('send-btn').disabled, true);
  assert.match(ui.element('recipient-status').textContent, /回复窗口已过期/);
  assert.equal(ui.element('recipient-status').classList.contains('hidden'), false);
  assert.equal(ui.element('text-input').readOnly, false, 'an unavailable delivery window still allows a local draft');
  assert.equal(ui.element('text-input').value, 'paused target');
  manageRecipients(ui);
  assert.equal(ui.element('recipient-status').classList.contains('hidden'), true);
  assert.equal(ui.element('recipient-status').textContent, '');
  container.scrollTop = container.scrollHeight;
  container.events.scroll({});
  assert.deepEqual(readReports(ui).at(-1), { command: 'markRead', ...alice, generation: 'generation-a', throughId: 20 });
  const bob = chooseRecipient(ui, 'bob', [message(2)]);
  ui.receive({ command: 'revealLatest', ...alice });
  assert.deepEqual(ui.ids(), [2]);
  assert.equal(ui.element('recipient-select').value, 'bob');
  assert.equal(readReports(ui).at(-1).recipientId, 'bob');
  assert.equal(readReports(ui).at(-1).selectionId, bob.selectionId);
});

test('contact switches restore per-contact reading anchors and dismiss unconfirmed data previews', () => {
  const ui = webview();
  manageRecipients(ui);
  const records = Array.from({ length: 20 }, (_, i) => message(i + 1));
  chooseRecipient(ui, 'alice', records);
  const container = ui.element('chat-container');
  container.scrollTop = 35;
  container.events.scroll({});
  ui.element('data-toggle').click();
  ui.element('restore-select').click();
  finishData(ui, dataRequests(ui).at(-1), 'restorePreview', { previewId: 'alice-visible-preview', generation: 'generation-a' });
  chooseRecipient(ui, 'bob', [message(30)]);
  assert.equal(ui.element('data-panel').classList.contains('hidden'), true);
  assert.equal(ui.element('restore-confirm').disabled, true);
  assert.ok(ui.outbound.some(msg => msg.command === 'dataDismissPreview' && msg.previewId === 'alice-visible-preview'));
  chooseRecipient(ui, 'alice', records);
  assert.equal(container.scrollTop, 35);
  ui.receive({ command: 'revealRecipient', recipientId: 'bob' });
  const reveal = ui.outbound.filter(msg => msg.command === 'selectRecipient').at(-1);
  assert.equal(reveal.recipientId, 'bob');
  acknowledgeRecipient(ui, reveal, records);
  assert.equal(container.scrollTop, container.scrollHeight - container.clientHeight);
  assert.equal(ui.element('recipient-select').value, 'bob');
});

test('attachment operations retain their original recipient and same-ID cards in another conversation stay independent', () => {
  const ui = webview();
  manageRecipients(ui);
  const alice = chooseRecipient(ui, 'alice', [attachment(1)]);
  const aliceButton = saveButton(rowFor(ui, 1));
  aliceButton.click();
  const request = ui.outbound.at(-1);
  assert.equal(request.command, 'saveAttachment');
  assert.equal(request.recipientId, 'alice');
  assert.equal(request.selectionId, alice.selectionId);
  const bob = chooseRecipient(ui, 'bob', [attachment(1)]);
  const bobButton = saveButton(rowFor(ui, 1));
  assert.equal(bobButton.textContent, '另存为…');
  ui.receive({ command: 'attachmentStatus', ...bob, requestId: request.requestId, fileStatus: 'saved' });
  assert.equal(bobButton.textContent, '另存为…');
  ui.receive({ command: 'attachmentStatus', ...alice, requestId: request.requestId, fileStatus: 'saved' });
  assert.equal(bobButton.textContent, '另存为…');
  const before = ui.outbound.length;
  aliceButton.click();
  assert.equal(ui.outbound.length, before, 'a detached old-scope card cannot start another operation');
  chooseRecipient(ui, 'alice', [attachment(1)]);
  assert.equal(saveButton(rowFor(ui, 1)).textContent, '再次保存…');
});

test('quotes exclude restored and read-only history records and stale contact buttons cannot change another draft', () => {
  const ui = webview();
  manageRecipients(ui, recipientOptions.map(option => option.id === 'alice'
    ? { ...option, canSend: false, reason: '回复窗口已过期' } : option));
  const aliceMessage = { ...message(1), message_id: 'alice-message' };
  const imported = { ...message(2), message_id: 'imported-message', restored: true };
  chooseRecipient(ui, 'alice', [aliceMessage, imported]);
  assert.equal(descendants(rowFor(ui, 2)).some(el => el.className === 'quote-action'), false);
  const oldButton = descendants(rowFor(ui, 1)).find(el => el.className === 'quote-action');
  assert.ok(oldButton, 'an unavailable delivery window still supports a local quote draft');
  oldButton.click();
  assert.equal(recipientDraft(ui, 'alice').quote.messageId, 'alice-message');
  chooseRecipient(ui, 'bob', [{ ...message(3), message_id: 'bob-message' }]);
  descendants(rowFor(ui, 3)).find(el => el.className === 'quote-action').click();
  oldButton.click();
  assert.equal(recipientDraft(ui, 'bob').quote.messageId, 'bob-message');
  assert.equal(recipientDraft(ui, 'alice').quote.messageId, 'alice-message');
  chooseRecipient(ui, '__history__', [aliceMessage, imported]);
  assert.equal(descendants(ui.element('messages')).some(el => el.className === 'quote-action'), false);
  assert.equal(sends(ui).length, 0);
});

test('older pages prepend only new rows and preserve existing code-copy and quote handlers across duplicate boundaries', () => {
  const ui = webview();
  const records = Array.from({ length: 20 }, (_, index) => ({ ...message(index + 10), message_id: `server-${index + 10}` }));
  records[0] = { ...withMarkdown(10, '```js\nkeep exact code\n```'), message_id: 'server-10' };
  sync(ui, { reset: true, messages: records, hasMore: true, unreadCount: 3 });
  const container = ui.element('chat-container');
  container.scrollTop = 35;
  container.events.scroll({});
  const oldRows = records.map(msg => rowFor(ui, msg.id));
  const anchorTop = oldRows[0].getBoundingClientRect().top;
  const copy = descendants(oldRows[0]).find(el => el.className === 'rich-code-copy');
  copy.click();
  const copyRequest = ui.outbound.at(-1);
  ui.receive({ command: 'loadHistory', generation: 'generation-a', older: true, hasMore: true,
    messages: [message(8), message(9), message(9), JSON.parse(JSON.stringify(records[0]))] });
  assert.deepEqual(ui.ids(), [8, 9, ...records.map(msg => msg.id)]);
  records.forEach((msg, index) => assert.equal(rowFor(ui, msg.id), oldRows[index]));
  assert.equal(rowFor(ui, 10).getBoundingClientRect().top, anchorTop);
  assert.equal(descendants(rowFor(ui, 10)).find(el => el.className === 'rich-code-copy'), copy);
  assert.equal(copy.disabled, true);
  ui.receive({ command: 'copyResult', requestId: copyRequest.requestId });
  assert.equal(copy.textContent, '已复制');
  descendants(oldRows[1]).find(el => el.className === 'quote-action').click();
  assert.equal(ui.state().drafts.QQ.quote.messageId, 'server-11');
  const nodes = [...ui.element('messages').children];
  ui.receive({ command: 'loadHistory', generation: 'generation-a', older: true, hasMore: false,
    messages: [message(8), message(9), JSON.parse(JSON.stringify(records[0]))] });
  assert.deepEqual(ui.element('messages').children, nodes);
  assert.equal(ui.element('load-more-history').classList.contains('hidden'), true);
  assert.match(ui.element('new-messages').textContent, /3 条/);
});

const datedMessage = (id, day) => ({ ...message(id), timestamp: new Date(2026, 0, day, 12).getTime() / 1000 });
const timelineDates = ui => ui.element('messages').children.filter(el => el.classList.contains('date-separator')).map(el => el.dataset.date);

test('prepend merges only the adjacent same-day boundary and preserves the tail date for subsequent live messages', () => {
  const ui = webview();
  const records = [datedMessage(10, 2), datedMessage(11, 3)];
  ui.receive({ command: 'loadHistory', messages: records, hasMore: true });
  const row = rowFor(ui, 10);
  ui.receive({ command: 'loadHistory', older: true, hasMore: true, messages: [datedMessage(8, 1), datedMessage(9, 2)] });
  assert.equal(rowFor(ui, 10), row);
  assert.deepEqual(timelineDates(ui), ['2026-01-01', '2026-01-02', '2026-01-03']);
  const children = ui.element('messages').children;
  const dayTwoIndex = children.findIndex(el => el.dataset.date === '2026-01-02');
  assert.equal(children[dayTwoIndex + 1].dataset.id, 9, 'the shared day heading precedes every row in the group');
  assert.equal(children[dayTwoIndex + 2].dataset.id, 10);
  ui.receive({ command: 'newMessage', message: datedMessage(12, 3) });
  assert.deepEqual(timelineDates(ui), ['2026-01-01', '2026-01-02', '2026-01-03']);
  ui.receive({ command: 'newMessage', message: datedMessage(13, 4) });
  assert.deepEqual(timelineDates(ui), ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
});

test('pagination keeps non-adjacent repeated dates and leaves duplicate-only pages completely intact', () => {
  const ui = webview();
  const records = [datedMessage(10, 3), datedMessage(11, 4)];
  ui.receive({ command: 'loadHistory', messages: records, hasMore: true });
  ui.receive({ command: 'loadHistory', older: true, hasMore: true, messages: [datedMessage(8, 3), datedMessage(9, 2)] });
  assert.deepEqual(timelineDates(ui), ['2026-01-03', '2026-01-02', '2026-01-03', '2026-01-04']);
  const nodes = [...ui.element('messages').children];
  ui.receive({ command: 'loadHistory', older: true, hasMore: false, messages: [datedMessage(8, 3), datedMessage(9, 2)] });
  assert.equal(ui.element('messages').children.length, nodes.length);
  nodes.forEach((node, index) => assert.equal(ui.element('messages').children[index], node));
});

test('overlapping history updates hydrate changed records and out-of-order pages and resets keep correct rows and dates', () => {
  const ui = webview();
  const photo = { ...datedMessage(10, 2), type: 2, direction: 'received' };
  sync(ui, { reset: true, messages: [photo, datedMessage(20, 3)], hasMore: true });
  ui.receive({ command: 'loadHistory', generation: 'generation-a', older: true, hasMore: true,
    messages: [datedMessage(1, 1), { ...photo, imageDataUrl: 'data:image/png;base64,YWJj' }] });
  assert.equal(descendants(rowFor(ui, 10)).find(el => el.tagName === 'IMG').src, 'data:image/png;base64,YWJj');
  ui.receive({ command: 'loadHistory', generation: 'generation-a', older: true, hasMore: false,
    messages: [datedMessage(15, 2), datedMessage(1, 1)] });
  assert.deepEqual(ui.ids(), [1, 10, 15, 20]);
  assert.deepEqual(timelineDates(ui), ['2026-01-01', '2026-01-02', '2026-01-03']);
  sync(ui, { generation: 'generation-b', reset: true, messages: [datedMessage(2, 5)] });
  assert.deepEqual(ui.ids(), [2]);
  assert.deepEqual(timelineDates(ui), ['2026-01-05']);
});

test('lazy images loaded above a paginated viewport preserve its message anchor and shared unread state', () => {
  const ui = webview();
  sync(ui, { reset: true, messages: Array.from({ length: 20 }, (_, index) => message(index + 10)), unreadCount: 4 });
  const container = ui.element('chat-container');
  container.scrollTop = 35;
  container.events.scroll({});
  ui.receive({ command: 'hostFocus', focused: true });
  const anchor = rowFor(ui, 10);
  const offset = anchor.getBoundingClientRect().top;
  ui.receive({ command: 'loadHistory', generation: 'generation-a', older: true, hasMore: true,
    messages: [{ ...message(9), type: 2, imageDataUrl: 'data:image/png;base64,YWJj' }] });
  const image = descendants(rowFor(ui, 9)).find(el => el.tagName === 'IMG');
  assert.equal(image.loading, 'lazy');
  assert.equal(image.decoding, 'async');
  container.events.scroll({}); // Browser scroll event from the preceding anchor restoration.
  const before = container.scrollTop;
  rowFor(ui, 9).layoutHeight = 120;
  ui.resize();
  container.events.scroll({});
  assert.equal(container.scrollTop, before + 100);
  assert.equal(rowFor(ui, 10), anchor);
  assert.equal(anchor.getBoundingClientRect().top, offset);
  assert.equal(readReports(ui).length, 0);
  assert.match(ui.element('new-messages').textContent, /4 条/);
  image.click();
  assert.equal(ui.element('lightbox-img').src, 'data:image/png;base64,YWJj');
});

test('connection health stays visible with literal details and millisecond times without disturbing the current conversation', () => {
  const ui = webview();
  assert.equal(ui.element('connection-status').classList.contains('hidden'), true);
  manageRecipients(ui);
  chooseRecipient(ui, 'alice', Array.from({ length: 20 }, (_, index) => message(index + 1)));
  const container = ui.element('chat-container');
  container.scrollTop = 35;
  container.events.scroll({});
  ui.receive({ command: 'hostFocus', focused: true });
  writeDraft(ui, 'keep my draft');
  const row = rowFor(ui, 1);
  const lastAckAt = 1_700_000_000_000;
  const retryAt = lastAckAt + 60_000;
  for (const state of ['offline', 'connecting', 'online', 'reconnecting', 'error']) {
    ui.receive({ command: 'connectionHealth', connectionHealth: { state, detail: '<literal & status>', lastAckAt, retryAt } });
    const health = ui.element('connection-status');
    assert.equal(health.classList.contains('hidden'), false);
    assert.equal(health.dataset.state, state);
    assert.ok(health.title.includes('<literal & status>'));
    assert.ok(health.title.includes(new Date(lastAckAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
    assert.ok(health.title.includes(new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })));
    assert.equal(health.attributes['aria-label'], health.title);
    if (state === 'online') assert.equal(health.textContent, '在线');
    else assert.equal(health.textContent, health.title, 'disconnection and errors must remain visible without hovering');
    assert.equal(health.children.length, 0);
    ui.resize();
    assert.equal(container.scrollTop, 35);
    assert.equal(ui.element('chat-container').classList.contains('hidden'), false);
    assert.equal(ui.element('recipient-select').value, 'alice');
    assert.equal(ui.element('text-input').value, 'keep my draft');
    assert.equal(rowFor(ui, 1), row);
    assert.equal(readReports(ui).length, 0);
    assert.equal(sends(ui).length, 0);
    ui.runTimers();
  }
  const prior = ui.element('connection-status').textContent;
  ui.receive({ command: 'connectionHealth', connectionHealth: { state: 'unknown', detail: 'bad update' } });
  assert.equal(ui.element('connection-status').textContent, prior);
  ui.receive({ command: 'connectionHealth', connectionHealth: { state: 'online', lastAckAt: Infinity, retryAt: -1 } });
  assert.equal(ui.element('connection-status').textContent, '在线');
});

test('Output and Changes support quoting, cancellation and the original reply payload', () => {
  for (const mode of ['log', 'git']) {
    const ui = webview();
    ui.element('toolbar').events.click({ target: { closest: () => ({ dataset: { mode } }) } });
    selectQuote(ui);
    assert.equal(ui.element('quote-bar').classList.contains('hidden'), false);
    assert.match(ui.element('quote-preview').textContent, /回复/);
    ui.element('quote-cancel').click();
    assert.equal(ui.element('quote-bar').classList.contains('hidden'), true);
    const row = ui.element('messages').children.find(el => el.dataset.id === 1);
    row.children.find(el => el.className === 'quote-action').click();
    writeDraft(ui, 'reply from alternate view');
    ui.element('send-btn').click();
    assert.equal(sends(ui).length, 1);
    assert.equal(sends(ui)[0].replyTo.messageId, 'quoted-message');
  }
});

test('image drops stage one image without sending or losing text, and reject unsupported batches', () => {
  const ui = webview();
  writeDraft(ui, 'keep text');
  const file = { type: 'image/png', size: 3, name: 'drop.png', data: 'data:image/png;base64,YWJj' };
  const over = ui.dropFiles([file], 'dragover');
  assert.equal(over.prevented, true);
  assert.equal(over.dataTransfer.dropEffect, 'copy');
  assert.equal(ui.dropFiles([file]).prevented, true);
  assert.equal(ui.element('paste-preview').src, file.data);
  assert.equal(ui.element('text-input').value, 'keep text');
  assert.equal(sends(ui).length, 0);
  ui.dropFiles([file, file]);
  assert.match(ui.element('send-status').textContent, /一次添加一个/);
  assert.equal(ui.element('paste-preview').src, file.data);
  ui.dropFiles([{ type: 'text/plain', size: 2 }]);
  assert.equal(sends(ui).length, 0);
});

test('drops while tools are open or during sending do not replace the draft', () => {
  const ui = webview();
  const file = { type: 'image/png', size: 3, data: 'data:image/png;base64,YWJj' };
  ui.element('data-toggle').click();
  ui.dropFiles([file]);
  assert.equal(ui.element('paste-preview').src, undefined);
  ui.element('data-close').click();
  writeDraft(ui, 'sending text');
  ui.element('send-btn').click();
  ui.dropFiles([file]);
  assert.equal(ui.element('paste-preview').src, undefined);
  assert.equal(sends(ui).length, 1);
});

test('late dropped-image reads cannot leak to a different recipient', () => {
  const ui = webview({ deferFileReads: true });
  manageRecipients(ui); chooseRecipient(ui, 'alice');
  ui.dropFiles([{ type: 'image/png', size: 3, data: 'data:image/png;base64,YWJj' }]);
  const reader = ui.readers.at(-1);
  chooseRecipient(ui, 'bob');
  reader.result = 'data:image/png;base64,YWJj'; reader.onload();
  assert.equal(ui.element('paste-preview').src, undefined);
  assert.equal(sends(ui).length, 0);
});

test('recipient aliases survive view restoration but never change the actual destination', () => {
  const ui = webview(); manageRecipients(ui); chooseRecipient(ui, 'alice');
  ui.element('recipient-alias').value = '项目负责人';
  ui.element('recipient-alias-save').click();
  assert.equal(ui.element('recipient-summary').textContent, '给：项目负责人');
  assert.match(ui.element('recipient-summary').title, /Alice/);
  chooseRecipient(ui, 'bob');
  assert.equal(ui.element('recipient-alias').value, '');
  chooseRecipient(ui, 'alice');
  assert.equal(ui.element('recipient-alias').value, '项目负责人');
  writeDraft(ui, 'hello'); ui.element('send-btn').click();
  assert.equal(sends(ui).at(-1).recipientId, 'alice');
  const reopened = webview({ state: ui.state() }); manageRecipients(reopened);
  const selection = reopened.outbound.filter(m => m.command === 'selectRecipient').at(-1);
  acknowledgeRecipient(reopened, selection);
  assert.equal(reopened.element('recipient-summary').textContent, '给：项目负责人');
});

test('success feedback no longer occupies a row while failed delivery stays actionable', () => {
  const ui = webview(); writeDraft(ui, 'hello'); ui.element('send-btn').click();
  ui.receive({ command: 'sendStatus', requestId: sends(ui).at(-1).requestId, sendStatus: 'sent' });
  assert.equal(ui.element('send-feedback').classList.contains('hidden'), true);
  assert.equal(ui.element('send-btn').title, '已发送');
  writeDraft(ui, 'next'); ui.element('send-btn').click();
  ui.receive({ command: 'sendStatus', requestId: sends(ui).at(-1).requestId, sendStatus: 'failed', error: 'offline' });
  assert.equal(ui.element('send-feedback').classList.contains('hidden'), false);
  assert.equal(ui.element('retry-send').classList.contains('hidden'), false);
});

test('sending updates immediately without an extra status row and preserves failure recovery', () => {
  const ui = webview();
  writeDraft(ui, 'pending request');
  ui.element('send-btn').click();
  assert.equal(sends(ui).length, 1, 'request is posted synchronously, without a timer');
  assert.equal(ui.element('send-btn').textContent, '发送中…');
  assert.equal(ui.element('send-feedback').classList.contains('hidden'), true);
  assert.equal(ui.element('text-input').value, 'pending request');
  ui.receive({ command: 'sendStatus', requestId: sends(ui)[0].requestId, sendStatus: 'failed' });
  assert.equal(ui.element('send-feedback').classList.contains('hidden'), false);
  assert.equal(ui.element('retry-send').classList.contains('hidden'), false);
});

test('unified attachment selection dispatches images and files to separate safe transports', () => {
  const ui = webview();
  enableFiles(ui);
  const image = { type: 'image/png', size: 3, name: 'local.png', data: 'data:image/png;base64,YWJj' };
  ui.element('file-input').events.change({ target: { files: [image] } });
  assert.equal(ui.element('paste-preview').src, image.data);
  assert.equal(sends(ui).length, 0);
  selectFileDraft(ui);
  assert.equal(ui.element('paste-preview').src, undefined);
  assert.equal(ui.state().drafts.QQ.file.fileId, 'opaque-file');
  assert.equal(sends(ui).length, 0);
});


test('external image dragenter is claimed before VS Code can activate its editor overlay', () => {
  const ui = webview();
  const file = { type: 'image/png', size: 3, name: 'fixture.png', data: 'data:image/png;base64,YWJj' };
  const entered = ui.dropFiles([file], 'dragenter');
  assert.equal(entered.prevented, true);
  assert.equal(entered.dataTransfer.dropEffect, 'copy');
  assert.equal(ui.element('input-bar').classList.contains('drag-over'), true);
  assert.equal(sends(ui).length, 0);
  ui.dropFiles([file]);
  assert.equal(ui.element('paste-preview').src, file.data);
});

test('image-only attachment returns focus and follows Enter or Cmd+Enter without requiring text', () => {
  for (const [shortcut, modifiers] of [['enter', {}], ['ctrlEnter', { metaKey: true }]]) {
    const ui = webview();
    ui.receive({ command: 'settings', sendShortcut: shortcut });
    const file = { type: 'image/png', size: 3, name: 'fixture.png', data: 'data:image/png;base64,YWJj' };
    ui.dropFiles([file]);
    assert.equal(ui.element('text-input').focused, true);
    assert.equal(ui.element('text-input').value, '');
    if (shortcut === 'ctrlEnter') {
      ui.element('text-input').events.keydown({ key: 'Enter', preventDefault() { assert.fail('plain Enter should edit'); } });
      assert.equal(sends(ui).length, 0);
    }
    ui.element('text-input').events.keydown({ key: 'Enter', ...modifiers, preventDefault() {} });
    assert.equal(sends(ui).length, 1);
    assert.equal(sends(ui)[0].command, 'sendImage');
    assert.equal(sends(ui)[0].imageData, file.data);
  }
});

test('image-only shortcut and button both respect expired recipient quota with a visible explanation', () => {
  const ui = webview();
  manageRecipients(ui);
  chooseRecipient(ui, 'alice');
  manageRecipients(ui, recipientOptions.map(option => option.id === 'alice'
    ? { ...option, canSend: false, reason: '暂无可用被动回复额度，请让此联系人给机器人发送一条新消息' } : option));
  const file = { type: 'image/png', size: 3, name: 'fixture.png', data: 'data:image/png;base64,YWJj' };
  ui.dropFiles([file]);
  assert.equal(ui.element('send-btn').disabled, true);
  assert.match(ui.element('send-btn').title, /被动回复额度/);
  assert.match(ui.element('send-status').textContent, /被动回复额度/);
  assert.equal(ui.element('send-feedback').classList.contains('hidden'), false);
  ui.element('text-input').events.keydown({ key: 'Enter', preventDefault() {} });
  ui.element('send-btn').click();
  assert.equal(sends(ui).length, 0);
  assert.equal(ui.element('paste-preview').src, file.data);
});
