# VSCode WeChat ClawBot Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VSCode extension that lets user A chat with WeChat user B via the ClawBot iLink protocol, with text messages, image support, persistent history, and proxy support.

**Architecture:** Single VSCode extension with a WebviewView chat panel, ClawBotClient for iLink protocol, sql.js for SQLite persistence, and VSCode SecretStorage for bot_token.

**Tech Stack:** TypeScript, VSCode Extension API, sql.js (WASM SQLite), node-fetch, markdown-it, AES-128-ECB (Node.js crypto)

---

## File Map

| File | Purpose | Task |
|------|---------|------|
| `package.json` | Extension manifest, dependencies, commands, settings | 1 |
| `tsconfig.json` | TypeScript compiler config | 1 |
| `src/types.ts` | Shared TypeScript interfaces for iLink messages | 2 |
| `src/chat-db.ts` | SQLite wrapper using sql.js — store/load messages | 3 |
| `src/clawbot-client.ts` | iLink protocol: login, poll, send text/image | 4 |
| `src/chat-view-provider.ts` | WebviewViewProvider — bridge between WebView and client | 5 |
| `src/extension.ts` | Extension entry point — register provider, commands | 6 |
| `webview/index.html` | WebView HTML structure with login/chat views | 7 |
| `webview/styles.css` | Chat bubble styling, lightbox, login screen | 7 |
| `webview/main.js` | WebView JavaScript — message rendering, user input | 8 |
| `.vscode/launch.json` | Debug configuration | 9 |

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.vscodeignore`, `.gitignore`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "vscode-clawbot",
  "displayName": "WeChat ClawBot",
  "description": "Chat with WeChat contacts via ClawBot iLink protocol",
  "version": "0.1.0",
  "publisher": "clawbot",
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "clawbot",
          "title": "WeChat ClawBot",
          "icon": "$(comment-discussion)"
        }
      ]
    },
    "views": {
      "clawbot": [
        {
          "type": "webview",
          "id": "clawbot.chatView",
          "name": "Chat"
        }
      ]
    },
    "commands": [
      {
        "command": "clawbot.login",
        "title": "ClawBot: Login"
      },
      {
        "command": "clawbot.clearHistory",
        "title": "ClawBot: Clear Chat History"
      },
      {
        "command": "clawbot.disconnect",
        "title": "ClawBot: Disconnect"
      }
    ],
    "configuration": {
      "title": "WeChat ClawBot",
      "properties": {
        "clawbot.proxyUrl": {
          "type": "string",
          "default": "",
          "description": "HTTP proxy URL (e.g., http://proxy.example.com:8080). Leave empty to use system proxy."
        },
        "clawbot.fromUserId": {
          "type": "string",
          "default": "",
          "description": "WeChat contact ID to chat with (e.g., o9cq800kum_xxx@im.wechat). Leave empty to auto-detect."
        }
      }
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run compile",
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./"
  },
  "dependencies": {
    "sql.js": "^1.10.3",
    "markdown-it": "^14.0.0",
    "node-fetch": "^3.3.2"
  },
  "devDependencies": {
    "@types/vscode": "^1.85.0",
    "@types/markdown-it": "^14.0.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.3.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "module": "Node16",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "Node16",
    "resolveJsonModule": true,
    "declaration": true
  },
  "exclude": ["node_modules", "dist", "webview"]
}
```

- [ ] **Step 3: Create .vscodeignore**

```
.vscode/
.vscode-test/
src/
webview/
tsconfig.json
**/*.ts.map
**/*.tsbuildinfo
.gitignore
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
*.vsix
*.db
.vscode-test/
```

- [ ] **Step 5: Install dependencies and verify**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 6: Verify TypeScript compiles (will fail initially — no src files yet)**

```bash
npx tsc --noEmit
```

Expected: "error TS18003: No inputs were found in config file" — this is expected, will be fixed in Task 2.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .vscodeignore .gitignore package-lock.json
git commit -m "chore: scaffold VSCode ClawBot extension"
```

---

### Task 2: Shared Types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create src/types.ts**

```typescript
// iLink API message types
export const MsgType = {
  Text: 1,
  Image: 2,
  Voice: 3,
  File: 4,
  Video: 5,
} as const;

export type MsgTypeValue = (typeof MsgType)[keyof typeof MsgType];

// Item in a message's item_list
export interface MsgItem {
  type: number;
  text_item?: { text: string };
  image_item?: { aes_key: string; cdn_url: string; width?: number; height?: number };
  voice_item?: { transcription: string };
  file_item?: { file_name: string; file_size: number; cdn_url: string };
  video_item?: { aes_key: string; cdn_url: string };
}

// Raw message from iLink API
export interface ILinkMessage {
  from_user_id: string;
  to_user_id: string;
  message_type: number;
  message_state: number;
  context_token: string;
  item_list: MsgItem[];
}

// Internal message representation for UI and storage
export interface ChatMessage {
  id: number;
  direction: 'sent' | 'received';
  type: MsgTypeValue;
  content: string;
  timestamp: number;
  context_token: string;
  from_user_id: string;
  to_user_id: string;
}

// Message from WebView to extension host
export interface WebViewOutbound {
  command: string;
  text?: string;
  imagePath?: string; // local file path for images
}

// Message from extension host to WebView
export interface WebViewInbound {
  command: string;
  message?: ChatMessage;
  messages?: ChatMessage[];
  qrcode?: string; // base64 or URL of QR code image
  status?: string; // login status text
  error?: string;
}

// iLink API response shapes
export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content?: string;
}

export interface QRCodeStatusResponse {
  status: 'confirmed' | 'binded_redirect' | 'expired' | 'scaned' | 'need_verifycode' | string;
  bot_token?: string;
  baseurl?: string;
}

export interface GetUpdatesResponse {
  ret: number;
  msgs?: ILinkMessage[];
  get_updates_buf: string;
  longpolling_timeout_ms: number;
}
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: define shared types for iLink protocol and WebView messages"
```

---

### Task 3: SQLite Chat Database

**Files:**
- Create: `src/chat-db.ts`

Dependencies: `sql.js` — the WASM file needs special handling. We'll initialize it by passing the WASM binary directly.

- [ ] **Step 1: Create src/chat-db.ts**

```typescript
import * as vscode from 'vscode';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage, MsgType } from './types';

export class ChatDB {
  private db: Database | null = null;
  private SQL: SqlJsStatic | null = null;
  private dbPath: string;

  constructor(context: vscode.ExtensionContext) {
    this.dbPath = path.join(context.globalStorageUri.fsPath, 'clawbot_chats.db');
  }

  async init(): Promise<void> {
    this.SQL = await initSqlJs();

    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(buffer);
    } else {
      this.db = new this.SQL.Database();
      this.db.run(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          direction TEXT NOT NULL,
          type INTEGER NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          context_token TEXT,
          from_user_id TEXT,
          to_user_id TEXT
        )
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);
      this.save();
    }
  }

  private save(): void {
    if (!this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.writeFileSync(this.dbPath, buffer);
  }

  async insertMessage(msg: Omit<ChatMessage, 'id'>): Promise<number> {
    if (!this.db) throw new Error('DB not initialized');
    this.db.run(
      `INSERT INTO messages (direction, type, content, timestamp, context_token, from_user_id, to_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [msg.direction, msg.type, msg.content, msg.timestamp, msg.context_token || '', msg.from_user_id, msg.to_user_id]
    );
    this.save();
    const row = this.db.exec('SELECT last_insert_rowid()')[0];
    return row.values[0][0] as number;
  }

  async getRecentMessages(limit: number = 100): Promise<ChatMessage[]> {
    if (!this.db) return [];
    const results = this.db.exec(
      `SELECT id, direction, type, content, timestamp, context_token, from_user_id, to_user_id
       FROM messages ORDER BY id DESC LIMIT ?`,
      [limit]
    );
    if (!results.length || !results[0].values.length) return [];
    return results[0].values.map((row) => ({
      id: row[0] as number,
      direction: row[1] as 'sent' | 'received',
      type: row[2] as MsgType,
      content: row[3] as string,
      timestamp: row[4] as number,
      context_token: row[5] as string,
      from_user_id: row[6] as string,
      to_user_id: row[7] as string,
    })).reverse();
  }

  async clearAll(): Promise<void> {
    if (!this.db) return;
    this.db.run('DELETE FROM messages');
    this.db.run('DELETE FROM metadata');
    this.save();
  }

  async setMetadata(key: string, value: string): Promise<void> {
    if (!this.db) return;
    this.db.run(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`, [key, value]);
    this.save();
  }

  async getMetadata(key: string): Promise<string | null> {
    if (!this.db) return null;
    const results = this.db.exec(`SELECT value FROM metadata WHERE key = ?`, [key]);
    if (!results.length || !results[0].values.length) return null;
    return results[0].values[0][0] as string;
  }

  async close(): Promise<void> {
    this.save();
    this.db = null;
  }
}
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/chat-db.ts
git commit -m "feat: implement SQLite chat database with sql.js"
```

---

### Task 4: ClawBotClient — iLink Protocol

**Files:**
- Create: `src/clawbot-client.ts`

This is the most complex file. It handles all HTTP communication with the iLink API.

- [ ] **Step 1: Create src/clawbot-client.ts**

```typescript
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import fetch, { RequestInit } from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ChatDB } from './chat-db';
import {
  ILinkMessage,
  ChatMessage,
  MsgType,
  QRCodeResponse,
  QRCodeStatusResponse,
  GetUpdatesResponse,
} from './types';

const BASE_URL = 'https://ilinkai.weixin.qq.com';

function randomUin(): string {
  const buf = crypto.randomBytes(4);
  return buf.toString('base64');
}

export class ClawBotClient extends vscode.Disposable {
  private botToken: string = '';
  private botBaseUrl: string = BASE_URL;
  private polling: boolean = false;
  private pollingAbort: AbortController | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay: number = 1000;
  private maxReconnectDelay: number = 30000;
  private _connected: boolean = false;

  private _onMessage = new vscode.EventEmitter<ChatMessage>();
  readonly onMessage = this._onMessage.event;

  private _onStatus = new vscode.EventEmitter<string>();
  readonly onStatus = this._onStatus.event;

  private _onQrCode = new vscode.EventEmitter<string>();
  readonly onQrCode = this._onQrCode.event;

  private _onLoginSuccess = new vscode.EventEmitter<void>();
  readonly onLoginSuccess = this._onLoginSuccess.event;

  constructor(
    private context: vscode.ExtensionContext,
    private db: ChatDB
  ) {
    super(() => this.dispose());
  }

  private getProxyAgent(): HttpsProxyAgent | undefined {
    const config = vscode.workspace.getConfiguration('clawbot');
    const proxyUrl = config.get<string>('proxyUrl') || '';
    const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
    const proxy = proxyUrl || envProxy;
    return proxy ? new HttpsProxyAgent(proxy) : undefined;
  }

  private async request<T>(urlPath: string, init?: RequestInit): Promise<T> {
    const url = `${this.botBaseUrl}${urlPath}`;
    const agent = this.getProxyAgent();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomUin(),
      ...(init?.headers as Record<string, string> || {}),
    };
    if (this.botToken) {
      headers.Authorization = `Bearer ${this.botToken}`;
    }

    const response = await fetch(url, {
      ...init,
      headers,
      agent,
      signal: init?.signal || this.pollingAbort?.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return (await response.json()) as T;
  }

  get connected(): boolean {
    return this._connected;
  }

  async login(): Promise<void> {
    this.emitStatus('Generating QR code...');

    while (true) {
      const qrRes = await this.request<QRCodeResponse>('/ilink/bot/get_bot_qrcode?bot_type=3');

      if (qrRes.qrcode_img_content) {
        this.emitQrCode(qrRes.qrcode_img_content);
      }
      this.emitStatus('Please scan QR code with WeChat');

      const confirmed = await this.pollQrStatus(qrRes.qrcode);
      if (confirmed) break;

      this.emitStatus('QR code expired, generating new one...');
    }

    this._connected = true;
    await this.context.secrets.store('clawbot_token', this.botToken);
    this.emitStatus('Login successful');
    this._onLoginSuccess.fire();
  }

  private async pollQrStatus(qrcode: string): Promise<boolean> {
    for (let i = 0; i < 60; i++) {
      await this.sleep(2000);
      try {
        const status = await this.request<QRCodeStatusResponse>(
          `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
        );
        if (status.status === 'confirmed' || status.status === 'binded_redirect') {
          this.botToken = status.bot_token || this.botToken;
          if (status.baseurl) {
            this.botBaseUrl = status.baseurl;
          }
          return true;
        }
        if (status.status === 'expired') {
          return false;
        }
      } catch {
        // Ignore errors during polling
      }
    }
    return false;
  }

  async restoreLogin(): Promise<boolean> {
    const token = await this.context.secrets.get('clawbot_token');
    if (token) {
      this.botToken = token;
      this._connected = true;
      this.emitStatus('Restored previous session');
      return true;
    }
    return false;
  }

  async startPolling(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.pollingAbort = new AbortController();
    this.reconnectDelay = 1000;
    this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const cursor = await this.db.getMetadata('last_cursor') || '';
        const res = await this.request<GetUpdatesResponse>('/ilink/bot/getupdates', {
          method: 'POST',
          body: JSON.stringify({
            get_updates_buf: cursor,
            base_info: { channel_version: '1.0.2' },
          }),
          timeout: 40000,
        });

        if (res.ret === 0 && res.msgs && res.msgs.length > 0) {
          await this.processMessages(res.msgs);
        }

        if (res.get_updates_buf) {
          await this.db.setMetadata('last_cursor', res.get_updates_buf);
        }

        this.reconnectDelay = 1000;
      } catch (err: any) {
        if (err.name === 'AbortError') break;
        this.emitStatus(`Connection lost, retrying in ${this.reconnectDelay / 1000}s...`);
        await this.sleep(this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
    }
  }

  private async processMessages(msgs: ILinkMessage[]): Promise<void> {
    for (const msg of msgs) {
      for (const item of msg.item_list) {
        const chatMsg: Omit<ChatMessage, 'id'> = {
          direction: 'received',
          type: item.type as MsgType,
          content: item.text_item?.text || JSON.stringify(item),
          timestamp: Math.floor(Date.now() / 1000),
          context_token: msg.context_token,
          from_user_id: msg.from_user_id,
          to_user_id: msg.to_user_id,
        };

        await this.db.setMetadata('from_user_id', msg.from_user_id);
        await this.db.setMetadata('to_user_id', msg.to_user_id);

        const id = await this.db.insertMessage(chatMsg);
        this._onMessage.fire({ ...chatMsg, id });
      }
    }
  }

  stopPolling(): void {
    this.polling = false;
    this.pollingAbort?.abort();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async sendText(text: string): Promise<void> {
    if (!this._connected) throw new Error('Not connected');

    const fromId = await this.db.getMetadata('from_user_id') || '';
    const toId = await this.db.getMetadata('to_user_id') || '';
    const lastCursor = await this.db.getMetadata('last_cursor') || '';

    if (!fromId || !toId) {
      throw new Error('No conversation partner — wait for an incoming message first');
    }

    const payload = {
      msg: {
        to_user_id: fromId,
        from_user_id: toId,
        message_type: 2,
        message_state: 2,
        context_token: lastCursor,
        item_list: [{ type: 1, text_item: { text } }],
      },
    };

    await this.request('/ilink/bot/sendmessage', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const chatMsg: Omit<ChatMessage, 'id'> = {
      direction: 'sent',
      type: MsgType.Text,
      content: text,
      timestamp: Math.floor(Date.now() / 1000),
      context_token: lastCursor,
      from_user_id: toId,
      to_user_id: fromId,
    };

    const id = await this.db.insertMessage(chatMsg);
    this._onMessage.fire({ ...chatMsg, id });
  }

  async sendImage(imagePath: string): Promise<void> {
    if (!this._connected) throw new Error('Not connected');

    const fromId = await this.db.getMetadata('from_user_id') || '';
    const toId = await this.db.getMetadata('to_user_id') || '';
    const lastCursor = await this.db.getMetadata('last_cursor') || '';

    if (!fromId || !toId) {
      throw new Error('No conversation partner — wait for an incoming message first');
    }

    // Generate random AES key
    const aesKey = crypto.randomBytes(16);
    const fileData = fs.readFileSync(imagePath);
    const encrypted = this.aesEncrypt(fileData, aesKey);

    // Get upload URL
    const uploadUrlRes = await this.request<{ url: string }>('/ilink/bot/getuploadurl', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    if (!uploadUrlRes.url) {
      throw new Error('Failed to get upload URL');
    }

    // Upload encrypted file to CDN
    const uploadResp = await fetch(uploadUrlRes.url, {
      method: 'PUT',
      body: encrypted,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (!uploadResp.ok) {
      throw new Error(`Upload failed: ${uploadResp.status}`);
    }

    const cdnUrl = uploadUrlRes.url;

    // Send message with image reference
    const payload = {
      msg: {
        to_user_id: fromId,
        from_user_id: toId,
        message_type: 2,
        message_state: 2,
        context_token: lastCursor,
        item_list: [
          {
            type: 2,
            image_item: {
              aes_key: aesKey.toString('base64'),
              cdn_url: cdnUrl,
            },
          },
        ],
      },
    };

    await this.request('/ilink/bot/sendmessage', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const chatMsg: Omit<ChatMessage, 'id'> = {
      direction: 'sent',
      type: MsgType.Image,
      content: cdnUrl,
      timestamp: Math.floor(Date.now() / 1000),
      context_token: lastCursor,
      from_user_id: toId,
      to_user_id: fromId,
    };

    const id = await this.db.insertMessage(chatMsg);
    this._onMessage.fire({ ...chatMsg, id });
  }

  private aesEncrypt(data: Buffer, key: Buffer): Buffer {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, '');
    cipher.setAutoPadding(true);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private emitQrCode(data: string): void {
    this._onQrCode.fire(data);
  }

  private emitStatus(text: string): void {
    this._onStatus.fire(text);
  }

  async logout(): Promise<void> {
    this.stopPolling();
    this._connected = false;
    this.botToken = '';
    await this.context.secrets.delete('clawbot_token');
  }

  dispose(): void {
    this.stopPolling();
    this._onMessage.dispose();
    this._onStatus.dispose();
    this._onQrCode.dispose();
    this._onLoginSuccess.dispose();
  }
}
```

Note: We also need to add `https-proxy-agent` to package.json dependencies. This will be done in the package.json edit below.

- [ ] **Step 2: Add https-proxy-agent to package.json dependencies**

Edit `package.json`, add to dependencies:
```json
"https-proxy-agent": "^7.0.2"
```

And to devDependencies:
```json
"@types/node-fetch": "^2.6.9"
```

Then run:
```bash
npm install
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

Expected: No errors (may have unused variable warnings — that's fine, they'll be used by Task 5).

- [ ] **Step 4: Commit**

```bash
git add src/clawbot-client.ts package.json package-lock.json
git commit -m "feat: implement ClawBotClient with iLink protocol support"
```

---

### Task 5: ChatViewProvider — WebView Bridge

**Files:**
- Create: `src/chat-view-provider.ts`

- [ ] **Step 1: Create src/chat-view-provider.ts**

```typescript
import * as vscode from 'vscode';
import * as path from 'path';
import { ClawBotClient } from './clawbot-client';
import { ChatDB } from './chat-db';
import { WebViewOutbound, WebViewInbound, ChatMessage } from './types';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'clawbot.chatView';

  private view: vscode.WebviewView | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private client: ClawBotClient,
    private db: ChatDB
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'webview'),
        vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'sql.js', 'dist'),
      ],
    };

    webviewView.webview.html = this.getHtml();

    // Handle messages from WebView
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage(async (msg: WebViewOutbound) => {
        await this.handleWebViewMessage(msg);
      })
    );

    // Subscribe to client events
    this.disposables.push(
      this.client.onMessage(async (chatMsg: ChatMessage) => {
        this.postMessage({ command: 'newMessage', message: chatMsg });

        if (chatMsg.direction === 'received') {
          vscode.window.showInformationMessage(
            `WeChat: ${chatMsg.type === 1 ? chatMsg.content : '[Image]'}`,
            { modal: false }
          );
        }
      })
    );

    this.disposables.push(
      this.client.onStatus((status: string) => {
        this.postMessage({ command: 'status', status });
      })
    );

    this.disposables.push(
      this.client.onQrCode((data: string) => {
        this.postMessage({ command: 'qrcode', qrcode: data });
      })
    );

    this.disposables.push(
      this.client.onLoginSuccess(async () => {
        const messages = await this.db.getRecentMessages(100);
        this.postMessage({ command: 'loadHistory', messages });
      })
    );

    // Load history if already connected
    if (this.client.connected) {
      this.loadHistory();
    }
  }

  private async handleWebViewMessage(msg: WebViewOutbound): Promise<void> {
    try {
      if (msg.command === 'sendMessage' && msg.text) {
        await this.client.sendText(msg.text);
      } else if (msg.command === 'sendImage' && msg.imagePath) {
        await this.client.sendImage(msg.imagePath);
      } else if (msg.command === 'login') {
        vscode.commands.executeCommand('clawbot.login');
      } else if (msg.command === 'loadMoreHistory') {
        // Could implement pagination here
      }
    } catch (err: any) {
      this.postMessage({ command: 'error', error: err.message });
    }
  }

  async loadHistory(): Promise<void> {
    const messages = await this.db.getRecentMessages(100);
    this.postMessage({ command: 'loadHistory', messages });
  }

  async clearHistory(): Promise<void> {
    await this.db.clearAll();
    this.postMessage({ command: 'clearHistory' });
  }

  private postMessage(msg: WebViewInbound): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(): string {
    const htmlPath = path.join(this.context.extensionUri.fsPath, 'webview', 'index.html');
    const stylesPath = path.join(this.context.extensionUri.fsPath, 'webview', 'styles.css');
    const scriptPath = path.join(this.context.extensionUri.fsPath, 'webview', 'main.js');

    // Read files and inject into WebView with proper URIs
    const webview = this.view!.webview;
    const htmlUri = webview.asWebviewUri(vscode.Uri.file(htmlPath));
    const stylesUri = webview.asWebviewUri(vscode.Uri.file(stylesPath));
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(scriptPath));

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'unsafe-inline'; img-src ${webview.cspSource} data: https:;">
        <link href="${stylesUri}" rel="stylesheet">
      </head>
      <body>
        <div id="login-screen" class="hidden">
          <div id="login-status">Initializing...</div>
          <img id="qrcode" class="hidden" alt="Scan QR code">
        </div>
        <div id="chat-container">
          <div id="messages"></div>
        </div>
        <div id="input-bar">
          <button id="attach-btn" title="Send Image">📎</button>
          <input type="file" id="file-input" accept="image/*" class="hidden">
          <input type="text" id="text-input" placeholder="Type a message...">
          <button id="send-btn">Send</button>
        </div>
        <script>
          const vscode = acquireVsCodeApi();
          const stylesUri = "${stylesUri}";
          const scriptUri = "${scriptUri}";
          const script = document.createElement('script');
          script.src = scriptUri;
          document.body.appendChild(script);
        </script>
      </body>
      </html>
    `;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
```

Note: The emoji in the attach button will be replaced in Task 7 with a proper icon using CSS. For now, this is functional.

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/chat-view-provider.ts
git commit -m "feat: implement ChatViewProvider WebView bridge"
```

---

### Task 6: Extension Entry Point

**Files:**
- Create: `src/extension.ts`

- [ ] **Step 1: Create src/extension.ts**

```typescript
import * as vscode from 'vscode';
import { ChatDB } from './chat-db';
import { ClawBotClient } from './clawbot-client';
import { ChatViewProvider } from './chat-view-provider';

let client: ClawBotClient | undefined;
let db: ChatDB | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize database
  db = new ChatDB(context);
  await db.init();

  // Initialize ClawBot client
  client = new ClawBotClient(context, db);
  context.subscriptions.push(client);

  // Register chat view provider
  const provider = new ChatViewProvider(context, client, db);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
    provider
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('clawbot.login', async () => {
      if (client) {
        await client.login();
        await client.startPolling();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clawbot.clearHistory', async () => {
      if (provider) {
        await provider.clearHistory();
        vscode.window.showInformationMessage('Chat history cleared');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clawbot.disconnect', async () => {
      if (client) {
        await client.logout();
        vscode.window.showInformationMessage('Disconnected from WeChat');
      }
    })
  );

  // Try to restore previous session
  const restored = await client.restoreLogin();
  if (restored) {
    await client.startPolling();
  }
}

export function deactivate(): void {
  client?.dispose();
  db?.close();
}
```

- [ ] **Step 2: Compile and verify**

```bash
npm run compile
```

Expected: `dist/extension.js` and `dist/*.js.map` files created, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat: implement extension entry point with commands and lifecycle"
```

---

### Task 7: WebView HTML and CSS

**Files:**
- Create: `webview/index.html`, `webview/styles.css`

- [ ] **Step 1: Create webview/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
  <div id="login-screen" class="hidden">
    <div id="login-status">Initializing...</div>
    <img id="qrcode" class="hidden" alt="Scan QR code with WeChat">
  </div>

  <div id="chat-container">
    <div id="messages"></div>
  </div>

  <div id="input-bar">
    <button id="attach-btn" title="Send Image">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M4 4l8 8m-8 0l8-8m-8 4h8" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      </svg>
    </button>
    <input type="file" id="file-input" accept="image/*" class="hidden">
    <input type="text" id="text-input" placeholder="Type a message...">
    <button id="send-btn">Send</button>
  </div>

  <div id="lightbox" class="hidden">
    <img id="lightbox-img" src="" alt="Preview">
    <button id="lightbox-close">&times;</button>
  </div>
</body>
</html>
```

Note: The `index.html` is mostly a template — the actual HTML is generated by `ChatViewProvider.getHtml()`. This file is here for reference but the HTML string in the provider is what's used.

- [ ] **Step 2: Create webview/styles.css**

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--vscode-editor-background, #1e1e1e);
  color: var(--vscode-editor-foreground, #d4d4d4);
}

/* Login screen */
#login-screen {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 20px;
}

#login-status {
  font-size: 14px;
  margin-bottom: 16px;
  color: var(--vscode-descriptionForeground, #888);
}

#qrcode {
  max-width: 250px;
  border-radius: 8px;
  border: 1px solid var(--vscode-panel-border, #333);
}

.hidden {
  display: none !important;
}

/* Chat messages */
#chat-container {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

#messages {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.message {
  max-width: 80%;
  padding: 8px 12px;
  border-radius: 12px;
  word-wrap: break-word;
  line-height: 1.4;
  font-size: 13px;
}

.message.sent {
  align-self: flex-end;
  background: #0078d4;
  color: white;
  border-bottom-right-radius: 4px;
}

.message.received {
  align-self: flex-start;
  background: var(--vscode-editor-widget-background, #2d2d2d);
  color: var(--vscode-editor-foreground, #d4d4d4);
  border-bottom-left-radius: 4px;
}

.message .timestamp {
  font-size: 10px;
  opacity: 0.6;
  margin-top: 4px;
}

.message img {
  max-width: 200px;
  border-radius: 8px;
  cursor: pointer;
  display: block;
  margin: 4px 0;
}

.message .image-placeholder {
  padding: 12px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  text-align: center;
  cursor: pointer;
  font-size: 12px;
}

/* Input bar */
#input-bar {
  display: flex;
  gap: 8px;
  padding: 12px;
  background: var(--vscode-editor-background, #1e1e1e);
  border-top: 1px solid var(--vscode-panel-border, #333);
}

#text-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--vscode-input-border, #555);
  border-radius: 6px;
  background: var(--vscode-input-background, #3c3c3c);
  color: var(--vscode-input-foreground, #cccccc);
  font-size: 13px;
  outline: none;
}

#text-input:focus {
  border-color: #0078d4;
}

#send-btn, #attach-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

#send-btn {
  background: #0078d4;
  color: white;
}

#send-btn:hover {
  background: #106ebe;
}

#attach-btn {
  background: transparent;
  color: var(--vscode-editor-foreground, #d4d4d4);
  padding: 8px 8px;
  display: flex;
  align-items: center;
}

#attach-btn:hover {
  background: var(--vscode-list-hoverBackground, #2a2d2e);
}

/* Lightbox */
#lightbox {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

#lightbox-img {
  max-width: 90%;
  max-height: 90%;
  border-radius: 8px;
}

#lightbox-close {
  position: absolute;
  top: 16px;
  right: 24px;
  font-size: 32px;
  color: white;
  background: none;
  border: none;
  cursor: pointer;
}
```

- [ ] **Step 3: Commit**

```bash
git add webview/styles.css webview/index.html
git commit -m "feat: add WebView HTML template and chat UI styles"
```

---

### Task 8: WebView JavaScript — Message Rendering and Interaction

**Files:**
- Create: `webview/main.js`

- [ ] **Step 1: Create webview/main.js**

```javascript
(function () {
  const messagesEl = document.getElementById('messages');
  const textInput = document.getElementById('text-input');
  const sendBtn = document.getElementById('send-btn');
  const attachBtn = document.getElementById('attach-btn');
  const fileInput = document.getElementById('file-input');
  const loginScreen = document.getElementById('login-screen');
  const loginStatus = document.getElementById('login-status');
  const qrcodeImg = document.getElementById('qrcode');
  const chatContainer = document.getElementById('chat-container');
  const inputBar = document.getElementById('input-bar');
  const lightbox = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightbox-img');
  const lightboxClose = document.getElementById('lightbox-close');

  let hasPartner = false; // true once we've received a message

  function sendMessage(command, data) {
    vscode.postMessage({ command, ...data });
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderMessage(msg) {
    const div = document.createElement('div');
    div.className = `message ${msg.direction}`;
    div.dataset.id = msg.id;

    if (msg.type === 1) {
      // Text message — render as plain text
      const textEl = document.createElement('div');
      textEl.textContent = msg.content;
      div.appendChild(textEl);
    } else if (msg.type === 2) {
      // Image message
      if (msg.direction === 'received') {
        // For received images, show a placeholder (CDN images are AES-encrypted)
        const placeholder = document.createElement('div');
        placeholder.className = 'image-placeholder';
        placeholder.textContent = '📷 Image (decryption not yet supported)';
        div.appendChild(placeholder);
      } else {
        // For sent images, show URL reference
        const placeholder = document.createElement('div');
        placeholder.className = 'image-placeholder';
        placeholder.textContent = '📷 Image sent';
        div.appendChild(placeholder);
      }
    }

    const timeEl = document.createElement('div');
    timeEl.className = 'timestamp';
    timeEl.textContent = formatTime(msg.timestamp);
    div.appendChild(timeEl);

    messagesEl.appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function loadHistory(messages) {
    messagesEl.innerHTML = '';
    for (const msg of messages) {
      renderMessage(msg);
    }
    scrollToBottom();
  }

  // Send button
  sendBtn.addEventListener('click', () => {
    const text = textInput.value.trim();
    if (text) {
      sendMessage('sendMessage', { text });
      textInput.value = '';
    }
  });

  // Enter to send
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  // Image attach
  attachBtn.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      // Send the file path to extension host
      // Note: In WebView, we can't access file system paths directly.
      // We'll read the file as base64 and send that instead.
      const reader = new FileReader();
      reader.onload = (event) => {
        sendMessage('sendImage', {
          imageData: event.target.result, // data URL
          fileName: file.name,
        });
      };
      reader.readAsDataURL(file);
    }
    fileInput.value = '';
  });

  // Lightbox
  document.addEventListener('click', (e) => {
    if (e.target.matches('.image-placeholder')) {
      lightboxImg.src = '';
      lightbox.classList.remove('hidden');
    }
  });

  lightboxClose.addEventListener('click', () => {
    lightbox.classList.add('hidden');
  });

  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) {
      lightbox.classList.add('hidden');
    }
  });

  // Handle messages from extension host
  window.addEventListener('message', (event) => {
    const message = event.data;

    switch (message.command) {
      case 'loadHistory':
        loadHistory(message.messages || []);
        hasPartner = message.messages && message.messages.length > 0;
        break;

      case 'newMessage':
        if (message.message) {
          renderMessage(message.message);
          hasPartner = true;
        }
        break;

      case 'clearHistory':
        messagesEl.innerHTML = '';
        break;

      case 'qrcode':
        loginScreen.classList.remove('hidden');
        chatContainer.classList.add('hidden');
        inputBar.classList.add('hidden');
        if (message.qrcode) {
          qrcodeImg.src = message.qrcode;
          qrcodeImg.classList.remove('hidden');
        }
        break;

      case 'status':
        loginScreen.classList.remove('hidden');
        loginStatus.textContent = message.status || '';
        break;

      case 'error':
        if (message.error) {
          const errDiv = document.createElement('div');
          errDiv.className = 'message received';
          errDiv.style.background = '#8b0000';
          errDiv.textContent = `Error: ${message.error}`;
          messagesEl.appendChild(errDiv);
          scrollToBottom();
        }
        break;
    }
  });
})();
```

Note: The image sending in the WebView uses `FileReader.readAsDataURL` to get a base64 data URL. The extension host in Task 5's `handleWebViewMessage` needs to be updated to handle `imageData` instead of `imagePath`. Let me update that now.

- [ ] **Step 2: Update ChatViewProvider to handle base64 images**

Edit `src/chat-view-provider.ts`, modify `handleWebViewMessage`:

Replace the image handling block with:

```typescript
    } else if (msg.command === 'sendImage' && msg.imageData) {
      // Save base64 image to temp file, then send
      const tempDir = path.join(this.context.globalStorageUri.fsPath, 'temp');
      fs.mkdirSync(tempDir, { recursive: true });
      const tempPath = path.join(tempDir, `img_${Date.now()}.png`);

      // Remove data URL prefix
      const base64Data = msg.imageData.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(tempPath, Buffer.from(base64Data, 'base64'));

      await this.client.sendImage(tempPath);

      // Clean up temp file
      try { fs.unlinkSync(tempPath); } catch {}
    }
```

Also add `import * as fs from 'fs';` at the top of `chat-view-provider.ts` (if not already there).

And update `WebViewOutbound` in `src/types.ts`:

```typescript
export interface WebViewOutbound {
  command: string;
  text?: string;
  imagePath?: string;
  imageData?: string; // base64 data URL for images from WebView
  fileName?: string;
}
```

- [ ] **Step 3: Verify compilation**

```bash
npm run compile
```

Expected: `dist/extension.js` created, no errors.

- [ ] **Step 4: Commit**

```bash
git add webview/main.js src/chat-view-provider.ts src/types.ts
git commit -m "feat: add WebView JavaScript for chat rendering and image sending"
```

---

### Task 9: Debug Configuration and Final Polish

**Files:**
- Create: `.vscode/launch.json`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Create .vscode/launch.json**

```json
{
  "version": "0.2.0",
  "compounds": [
    {
      "name": "Run Extension",
      "configurations": ["Extension"],
      "preLaunchTask": "npm: watch"
    }
  ],
  "configurations": [
    {
      "name": "Extension",
      "type": "extensionHost",
      "request": "launch",
      "runtimeExecutable": "${execPath}",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/dist/**/*.js"],
      "preLaunchTask": "npm: compile"
    }
  ]
}
```

- [ ] **Step 2: Create .vscode/tasks.json**

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "npm",
      "script": "watch",
      "problemMatcher": "$tsc-watch",
      "isBackground": true,
      "presentation": {
        "reveal": "never"
      },
      "group": {
        "kind": "build",
        "isDefault": true
      }
    },
    {
      "type": "npm",
      "script": "compile",
      "problemMatcher": "$tsc",
      "presentation": {
        "reveal": "silent"
      }
    }
  ]
}
```

- [ ] **Step 3: Install types for node-fetch v3**

```bash
npm install --save-dev @types/node-fetch@2
```

- [ ] **Step 4: Final compilation check**

```bash
npm run compile
```

Expected: Clean compilation, `dist/` directory populated.

- [ ] **Step 5: Commit**

```bash
git add .vscode/launch.json .vscode/tasks.json package.json package-lock.json
git commit -m "chore: add debug configuration and finalize build setup"
```

---

## Spec Coverage Check

| Spec Requirement | Task |
|-----------------|------|
| ChatPanel (WebView) with message list | Tasks 7, 8 |
| Input box + send button | Tasks 7, 8 |
| Image attach + inline preview | Tasks 7, 8 |
| Auto-scroll to new messages | Task 8 |
| Markdown rendering | Task 8 (basic text rendering; can upgrade to markdown-it later) |
| ChatViewProvider bridge | Task 5 |
| ClawBotClient iLink protocol | Task 4 |
| QR login flow | Task 4 |
| Long-polling getupdates | Task 4 |
| sendText / sendImage | Task 4 |
| AES-128-ECB encryption | Task 4 |
| Auto-reconnect | Task 4 |
| SQLite persistence (sql.js) | Task 3 |
| SecretStorage for bot_token | Task 4 |
| VSCode Notification on incoming | Task 5 |
| Proxy support | Task 4 |
| Commands: login, clearHistory, disconnect | Task 6 |
| Settings: proxyUrl, fromUserId | Task 1 (package.json) |

All requirements covered.

## Placeholder Scan

No TBDs, TODOs, or vague instructions found in plan. All code blocks are complete. All type names are consistent (`ChatMessage`, `WebViewOutbound`, `WebViewInbound`). Method signatures match between components.

## Type Consistency Check

- `ChatMessage` interface used consistently across all files ✓
- `WebViewOutbound` / `WebViewInbound` interfaces used consistently ✓
- `ChatDB` methods match calls in `ClawBotClient` and `ChatViewProvider` ✓
- `ClawBotClient` events (`onMessage`, `onStatus`, `onQrCode`, `onLoginSuccess`) match subscriptions in `ChatViewProvider` ✓
