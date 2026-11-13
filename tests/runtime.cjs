const Module = require('node:module');
const fs = require('node:fs');
const esbuild = require('esbuild');
const path = require('node:path');

class EventEmitter {
  listeners = new Set();
  event = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  async fire(value) { await Promise.all([...this.listeners].map(listener => listener(value))); }
  dispose() { this.listeners.clear(); }
}

const windowStateEvents = new EventEmitter();
const configurationEvents = new EventEmitter();
const configuration = new Map([['vschat.sendShortcut', 'enter'], ['vschat.renderMarkdown', true]]);
const statusBarItems = [];
const notifications = [];
const outputLines = [];
const clipboardWrites = [];
const externalUrls = [];
const openDialogs = [], saveDialogs = [], workspaceWrites = [];
const registeredCommands = new Map();
const uri = (value, scheme = 'file') => ({ scheme, fsPath: value, path: value, toString: () => value });
const parseUri = value => {
  const parsed = new URL(value);
  return { scheme: parsed.protocol.slice(0, -1), fsPath: decodeURIComponent(parsed.pathname), path: parsed.pathname, toString: () => value };
};
const vscode = {
  env: {
    clipboard: {
      writeError: undefined,
      async writeText(value) {
        if (this.writeError) throw this.writeError;
        clipboardWrites.push(value);
      },
    },
    async openExternal(value) { externalUrls.push(value.toString()); return true; },
  },
  workspace: {
    fs: {
      writeError: undefined,
      async writeFile(destination, bytes) {
        if (this.writeError) throw this.writeError;
        workspaceWrites.push({ destination, bytes: Buffer.from(bytes) });
      },
    },
    onDidChangeConfiguration: configurationEvents.event,
    getConfiguration(section) {
      return {
        get(key, fallback) {
          const name = section ? `${section}.${key}` : key;
          return configuration.has(name) ? configuration.get(name) : fallback;
        },
      };
    },
  },
  window: {
    state: { focused: true },
    onDidChangeWindowState: windowStateEvents.event,
    createOutputChannel: () => ({ appendLine: value => outputLines.push(value), dispose() {} }),
    createStatusBarItem: () => {
      const item = {
        text: '', tooltip: '', command: undefined, visible: false, disposed: false,
        show() { this.visible = true; }, hide() { this.visible = false; },
        dispose() { this.disposed = true; this.visible = false; },
      };
      statusBarItems.push(item);
      return item;
    },
    nextNotificationAction: undefined,
    nextOpenDialogResult: undefined,
    nextSaveDialogResult: undefined,
    async showOpenDialog(options) {
      openDialogs.push(options);
      const result = vscode.window.nextOpenDialogResult;
      vscode.window.nextOpenDialogResult = undefined;
      return typeof result === 'function' ? result(options) : result;
    },
    async showSaveDialog(options) {
      saveDialogs.push(options);
      const result = vscode.window.nextSaveDialogResult;
      vscode.window.nextSaveDialogResult = undefined;
      return typeof result === 'function' ? result(options) : result;
    },
    async showInformationMessage(...args) {
      notifications.push(args);
      const action = vscode.window.nextNotificationAction;
      vscode.window.nextNotificationAction = undefined;
      return action;
    },
  },
  commands: {
    executed: [],
    registerCommand(name, callback) {
      registeredCommands.set(name, callback);
      return { dispose: () => registeredCommands.delete(name) };
    },
    async executeCommand(name, ...args) {
      vscode.commands.executed.push({ name, args });
      return registeredCommands.get(name)?.(...args);
    },
  },
  Uri: { file: value => uri(value), parse: parseUri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts), base.scheme || 'file') },
  StatusBarAlignment: { Left: 1, Right: 2 },
  Disposable: class {
    constructor(callback) { this.callback = callback; }
    dispose() { this.callback?.(); }
  },
  EventEmitter,
};

function resetVSCodeMocks() {
  windowStateEvents.dispose();
  configurationEvents.dispose();
  configuration.clear();
  configuration.set('vschat.sendShortcut', 'enter');
  configuration.set('vschat.renderMarkdown', true);
  statusBarItems.length = 0;
  notifications.length = 0;
  outputLines.length = 0;
  clipboardWrites.length = 0;
  externalUrls.length = 0;
  openDialogs.length = 0;
  saveDialogs.length = 0;
  workspaceWrites.length = 0;
  vscode.workspace.fs.writeError = undefined;
  vscode.env.clipboard.writeError = undefined;
  registeredCommands.clear();
  vscode.commands.executed.length = 0;
  vscode.window.state = { focused: true };
  vscode.window.nextNotificationAction = undefined;
  vscode.window.nextOpenDialogResult = undefined;
  vscode.window.nextSaveDialogResult = undefined;
}

// Load the production TypeScript with only VS Code's UI API stubbed out.
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return vscode;
  return originalLoad.call(this, name, ...args);
};
require.extensions['.ts'] = (module, filename) => {
  module._compile(esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node18',
  }).code, filename);
};

exports.ChatDB = require('../src/chat-db.ts').ChatDB;
Object.assign(exports, { vscode, windowStateEvents, configurationEvents, configuration, statusBarItems, notifications, outputLines, clipboardWrites, externalUrls, openDialogs, saveDialogs, workspaceWrites, resetVSCodeMocks });
exports.message = (id) => ({
  direction: 'sent', type: 1, content: `message ${id}`, timestamp: 1_700_000_000,
  context_token: '', from_user_id: 'bot', to_user_id: 'user', message_id: id,
});
