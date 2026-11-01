const Module = require('node:module');
const fs = require('node:fs');
const esbuild = require('esbuild');

// Load the production TypeScript with only VS Code's UI API stubbed out.
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'vscode') return {
    window: { createOutputChannel: () => ({ appendLine() {}, dispose() {} }) },
    Disposable: class {
      constructor(callback) { this.callback = callback; }
      dispose() { this.callback?.(); }
    },
    EventEmitter: class {
      listeners = new Set();
      event = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
      fire(value) { for (const listener of this.listeners) listener(value); }
      dispose() { this.listeners.clear(); }
    },
  };
  return originalLoad.call(this, name, ...args);
};
require.extensions['.ts'] = (module, filename) => {
  module._compile(esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node18',
  }).code, filename);
};

exports.ChatDB = require('../src/chat-db.ts').ChatDB;
exports.message = (id) => ({
  direction: 'sent', type: 1, content: `message ${id}`, timestamp: 1_700_000_000,
  context_token: '', from_user_id: 'bot', to_user_id: 'user', message_id: id,
});
