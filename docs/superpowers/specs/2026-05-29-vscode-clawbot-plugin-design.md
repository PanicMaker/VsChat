---
title: VSCode WeChat ClawBot Plugin Design
date: 2026-05-29
status: approved
---

# Design: VSCode WeChat ClawBot Plugin

## Goal

Create a VSCode extension that allows user A to communicate with WeChat user B through the ClawBot iLink protocol. User B scans a QR code to authenticate; user A uses the shared bot_token in VSCode to send and receive messages as B's identity. Text and images supported.

## Architecture

```
┌─────────────────────────────────────────┐
│  VSCode Extension Host                   │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │  ChatPanel (WebView)               │  │
│  │  - Message list (bubble layout)    │  │
│  │  - Input box + send button         │  │
│  │  - Image attach + inline preview   │  │
│  │  - Auto-scroll to new messages     │  │
│  │  - Markdown rendering for text     │  │
│  └─────────────────┬──────────────────┘  │
│                    │ postMessage         │
│  ┌─────────────────▼──────────────────┐  │
│  │  ChatViewProvider                  │  │
│  │  - Receive WebView events          │  │
│  │  - Forward to ClawBotClient        │  │
│  │  - Push incoming msgs to WebView   │  │
│  └─────────────────┬──────────────────┘  │
│                    │                     │
│  ┌─────────────────▼──────────────────┐  │
│  │  ClawBotClient                     │  │
│  │  - iLink protocol (fetch)          │  │
│  │  - QR login flow                   │  │
│  │  - Long-polling getupdates         │  │
│  │  - sendText / sendImage            │  │
│  │  - AES-128-ECB encryption          │  │
│  │  - Auto-reconnect                  │  │
│  └─────────────────┬──────────────────┘  │
│                    │                     │
│  ┌─────────────────▼──────────────────┐  │
│  │  SQLite (sql.js)                   │  │
│  │  - Persistent chat history         │  │
│  │  - Metadata: IDs, cursor, token    │  │
│  └─────────────────┬──────────────────┘  │
│                    │                     │
│  ┌─────────────────▼──────────────────┐  │
│  │  SecretStorage (VSCode)            │  │
│  │  - bot_token (encrypted)           │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
         │ HTTPS (supports HTTP proxy)
         ▼
    ilink.weixin.qq.com
```

## Components

### 1. ChatViewProvider

Registers via `vscode.WebviewViewProvider`. Provides a single webview panel in the Activity Bar.

- Receives `sendMessage`, `sendImage` events from WebView
- Routes events to `ClawBotClient`
- Subscribes to `ClawBotClient.onMessage` and pushes to WebView via `postMessage`
- Triggers VSCode Notification API on incoming messages
- Loads chat history from SQLite on panel open

### 2. ChatPanel (WebView HTML/JS/CSS)

- Message list with sent (right-aligned, blue) and received (left-aligned, white) bubbles
- Fixed bottom input bar: text input + send button + image attachment button
- Images displayed inline with click-to-preview (lightbox overlay)
- Text messages support basic Markdown rendering
- Auto-scroll to bottom on new message
- Login state screen: shows QR code (when not logged in) or connection status

### 3. ClawBotClient

TypeScript class wrapping the iLink protocol:

| Method | Description |
|--------|-------------|
| `constructor(ctx)` | Initialize with extension context, proxy config |
| `login()` | Fetch QR code → poll for scan confirmation → store bot_token |
| `startPolling()` | Long-poll loop calling `getupdates`, trigger `onMessage` event |
| `stopPolling()` | Cancel polling loop |
| `sendText(fromId, toId, contextToken, text)` | POST to `/ilink/bot/sendmessage` |
| `sendImage(fromId, toId, contextToken, filePath)` | Upload via CDN + AES encrypt + send |
| `setProxy(url)` | Configure HTTP proxy for all requests |
| `isConnected()` | Check login status |

Protocol details:
- Base URL: `https://ilinkai.weixin.qq.com`
- Headers: `AuthorizationType: ilink_bot_token`, `X-WECHAT-UIN: <base64 random uint32>`, `Authorization: Bearer <token>`
- `getupdates` cursor (`get_updates_buf`) persisted to DB to avoid duplicates
- `context_token` from inbound message required for outbound replies
- Long-poll timeout: 35 seconds

### 4. SQLite Storage (sql.js)

Database stored at `extensionContext.globalStorageUri / chats.db`.

**Schema:**
```sql
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL,      -- 'sent' | 'received'
    type INTEGER NOT NULL,        -- 1=text, 2=image, 3=voice, 4=file, 5=video
    content TEXT NOT NULL,        -- text content or image URL/path
    timestamp INTEGER NOT NULL,   -- unix timestamp (seconds)
    context_token TEXT,           -- from inbound message
    from_user_id TEXT,            -- sender ID
    to_user_id TEXT               -- receiver ID
);

CREATE TABLE metadata (
    key TEXT PRIMARY KEY,
    value TEXT
);
```

**Metadata keys:**
- `from_user_id` — the WeChat contact ID
- `to_user_id` — the bot ID
- `last_cursor` — polling cursor from last `getupdates` response
- `session_start` — when this chat session began

**Load behavior:** On panel open, load last 100 messages, then paginate on scroll-up.

### 5. SecretStorage

Use `vscode.SecretStorage` for bot_token (VSCode encrypts this at rest).
```typescript
context.secrets.store('clawbot_token', botToken)
const token = await context.secrets.get('clawbot_token')
```

### 6. Proxy Support

Two layers:
1. Check `process.env.HTTPS_PROXY` / `http_proxy` for system proxy
2. Override with extension setting `clawbot.proxyUrl`

All fetch requests use the configured proxy. In VSCode extensions, this is handled by setting `agent` option or relying on Node.js environment variables.

## Error Handling

- QR code expired → automatically request new QR code
- Polling disconnected → exponential backoff reconnect (1s, 2s, 4s, ... max 30s)
- Send message failed → retry once, then show error in chat panel
- Token invalid → clear secret, show login screen
- Image upload failed → show error, keep text in input

## Extension Manifest (package.json)

- **Activation**: `onStartupFinished`
- **Views**: `clawbot.chatView` — WebviewView in Activity Bar
- **Commands**:
  - `clawbot.login` — Re-trigger login flow
  - `clawbot.clearHistory` — Clear local chat history
  - `clawbot.disconnect` — Clear token and disconnect
- **Settings**:
  - `clawbot.proxyUrl` — HTTP proxy URL (string)
  - `clawbot.fromUserId` — WeChat contact ID (string, optional manual override)
- **Dependencies**: `sql.js`, `markdown-it` (for text rendering)

## Data Flow

```
[WeChat B] → iLink API → ClawBotClient.getupdates() → onMessage event
  → SQLite INSERT → ChatViewProvider.postMessage() → WebView append message
  → VSCode Notification

[User A types msg] → WebView sendMessage event → ChatViewProvider
  → ClawBotClient.sendText() → iLink API → SQLite INSERT → WebView append
```
