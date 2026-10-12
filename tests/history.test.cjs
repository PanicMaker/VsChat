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
    async getRecentMessages(limit, beforeId) {
      return records.filter((msg) => beforeId === undefined || msg.id < beforeId).slice(-limit);
    },
    async getMessagesFromId(firstId) { return records.filter((msg) => msg.id >= firstId); },
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
function webview() {
  class Element {
    constructor() {
      this.children = []; this.dataset = {}; this.style = {}; this.events = {};
      this.value = ''; this.scrollTop = 0; this.clientHeight = 40;
      const classes = new Set();
      this.classList = {
        add: (x) => classes.add(x), remove: (x) => classes.delete(x), contains: (x) => classes.has(x),
        toggle: (x, enabled) => {
          if (enabled === undefined) enabled = !classes.has(x);
          enabled ? classes.add(x) : classes.delete(x);
        },
      };
    }
    set innerHTML(value) { this.children = []; }
    get scrollHeight() { return this.children.length * 20; }
    appendChild(el) { this.children.push(el); }
    addEventListener(name, callback) { this.events[name] = callback; }
    querySelector() { return null; }
    click() { if (!this.disabled) this.events.click?.({}); }
  }
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const container = element('chat-container');
  Object.defineProperty(container, 'scrollHeight', {
    get: () => element('messages').scrollHeight + 20,
  });
  const events = {}, outbound = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../webview/main.js'), 'utf8'), {
    acquireVsCodeApi: () => ({ getState() {}, setState() {}, postMessage: (msg) => outbound.push(msg) }),
    document: {
      body: new Element(), getElementById: element, createElement: () => new Element(),
      querySelectorAll: () => [], addEventListener() {},
    },
    window: { addEventListener: (name, callback) => { events[name] = callback; } },
    setTimeout, clearTimeout, console,
  });
  return {
    element, outbound,
    receive: (data) => events.message({ data }),
    ids: () => element('messages').children.filter((el) => el.dataset.id).map((el) => el.dataset.id),
  };
}

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
