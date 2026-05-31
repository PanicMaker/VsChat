# VsChat — VSCode Extension

<p align="center">
  <img src="https://img.shields.io/badge/VSCode-%5E1.85.0-blue?logo=visual-studio-code" alt="VSCode Version" />
  <img src="https://img.shields.io/badge/TypeScript-5.3+-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/Version-0.1.0-orange" alt="Version" />
</p>

在 VSCode 侧边栏中直接与微信联系人聊天。基于腾讯 [OpenClaw iLink 协议](https://github.com/Tencent/openclaw-weixin) 构建，支持文本消息和图片的收发。

## ✨ 功能特性

- 🔐 **微信扫码登录** — 在 VSCode 中扫描二维码即可登录
- 💬 **实时消息收发** — 长轮询接收消息，即时发送文本
- 🖼️ **图片支持** — 发送和接收图片，AES-128-ECB 加解密
- 🔍 **图片预览** — 点击接收的图片在 Lightbox 中全屏查看
- 💾 **消息持久化** — 基于 SQLite 的本地消息存储，重启后保留历史
- 🔄 **会话恢复** — 自动恢复上一次登录会话，无需重新扫码
- 🌐 **代理支持** — 可配置 HTTP 代理

## 📁 项目结构

```
VsChat/
├── src/                          # TypeScript 源码
│   ├── extension.ts              # 扩展入口点：激活、注册命令与视图
│   ├── vschat-client.ts         # 核心客户端：登录、轮询、收发消息、CDN 上传
│   ├── chat-view-provider.ts     # WebviewView 提供者：桥接 UI 与客户端
│   ├── chat-db.ts                # SQLite 数据库：消息与元数据持久化
│   └── types.ts                  # 类型定义：消息、API 响应等接口
├── webview/                      # Webview 前端（纯 HTML/CSS/JS）
│   ├── index.html                # 聊天界面 HTML 结构
│   ├── main.js                   # 前端逻辑：消息渲染、事件处理
│   └── styles.css                # 聊天界面样式（适配 VSCode 主题）
├── dist/                         # TypeScript 编译输出
├── docs/                         # 项目文档
│   └── superpowers/
│       ├── specs/                # 设计规格文档
│       └── plans/                # 开发计划文档
├── package.json                  # VSCode 扩展清单 & npm 配置
├── tsconfig.json                 # TypeScript 编译配置
└── .vscodeignore                 # 打包排除文件列表
```

## 🏗️ 架构设计

```
┌─────────────────────────────────────────────────────────┐
│                    VSCode Extension Host                │
│                                                         │
│  ┌──────────────┐   事件驱动    ┌───────────────────┐   │
│  │  extension.ts │──注册/绑定──▶│ ChatViewProvider  │   │
│  │  (入口)       │              │ (Webview 桥接)    │   │
│  └──────┬───────┘              └────────┬──────────┘   │
│         │                               │               │
│         │ 创建                    postMessage            │
│         ▼                               ▼               │
│  ┌──────────────┐              ┌───────────────────┐   │
│  │ VsChatClient│◀── 事件 ────▶│   Webview (UI)    │   │
│  │ (核心客户端)  │   onMessage  │   main.js         │   │
│  │              │   onStatus   │   styles.css       │   │
│  └──────┬───────┘   onQrCode  └───────────────────┘   │
│         │                                               │
│         │ 读写                                          │
│         ▼                                               │
│  ┌──────────────┐                                       │
│  │   ChatDB     │  SQLite (sql.js)                     │
│  │  (消息存储)   │  messages + metadata 表              │
│  └──────────────┘                                       │
└─────────────────────────────────────────────────────────┘
                    │
                    │ HTTPS (iLink 协议)
                    ▼
          ┌──────────────────┐
          │  WeChat iLink    │
          │  Bot Server      │
          │  (CDN + API)     │
          └──────────────────┘
```

### 核心模块说明

| 模块 | 文件 | 职责 |
|------|------|------|
| **入口** | `extension.ts` | 扩展激活/停用，初始化 DB 和客户端，注册命令 |
| **客户端** | `vschat-client.ts` | QR 码登录、长轮询消息、文本/图片发送、AES 加解密、CDN 文件上传 |
| **视图桥接** | `chat-view-provider.ts` | 管理 Webview 生命周期，桥接客户端事件与 Webview 消息 |
| **数据库** | `chat-db.ts` | 基于 `sql.js` 的 SQLite 存储，管理消息和元数据 |
| **类型** | `types.ts` | 定义 `ChatMessage`、`ILinkMessage`、`WebViewInbound/Outbound` 等接口 |
| **前端** | `webview/` | 聊天 UI：消息气泡、图片预览、输入栏、登录屏 |

### 数据流

1. **登录流程**: `extension.ts` → `VsChatClient.login()` → 获取 QR 码 → Webview 展示 → 用户扫码 → 获取 `bot_token` → 存入 SecretStorage + 文件
2. **接收消息**: `VsChatClient.pollLoop()` → `getupdates` API → `processMessages()` → 解密图片 → 存入 DB → 触发 `onMessage` 事件 → `ChatViewProvider` → Webview `renderMessage()`
3. **发送文本**: Webview `sendMessage` → `ChatViewProvider.handleWebViewMessage()` → `VsChatClient.sendText()` → `sendmessage` API
4. **发送图片**: Webview 选择文件 → base64 传递 → 写入临时文件 → `VsChatClient.sendImage()` → AES 加密 → CDN 上传 → `sendmessage` API

## 🚀 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) >= 18
- [VSCode](https://code.visualstudio.com/) >= 1.85.0

### 安装依赖

```bash
git clone <repo-url> VsChat
cd VsChat
npm install
```

### 编译

```bash
npm run compile
```

### 开发模式

```bash
npm run watch
```

然后在 VSCode 中按 `F5` 启动扩展开发宿主。

### 打包发布

```bash
npx vsce package
```

## 📖 使用方式

1. 安装扩展后，VSCode 活动栏出现 💬 **VsChat** 图标
2. 打开聊天面板，执行命令 `VsChat: Login`
3. 用微信扫描 VSCode 中显示的二维码
4. 扫码成功后自动进入聊天界面
5. 在输入框中输入文字发送，或点击 📎 附件按钮发送图片

### 可用命令

| 命令 | 说明 |
|------|------|
| `VsChat: Login` | 扫码登录微信 |
| `VsChat: Clear Chat History` | 清除所有聊天记录 |
| `VsChat: Disconnect` | 断开连接并登出 |

### 配置项

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `vschat.proxyUrl` | string | `""` | HTTP 代理 URL，留空使用系统代理 |
| `vschat.fromUserId` | string | `""` | 指定聊天对象 ID，留空自动检测 |

## 🔧 技术栈

| 技术 | 用途 |
|------|------|
| **TypeScript** | 扩展后端逻辑 |
| **VSCode Extension API** | Webview、命令、SecretStorage |
| **undici** | HTTP 请求（支持代理） |
| **sql.js** | 纯 JS 的 SQLite（无需原生模块） |
| **qrcode** | QR 码生成 |
| **AES-128-ECB** | 媒体文件加解密（Node.js `crypto`） |
| **Vanilla JS/CSS** | Webview 前端 |

## 📄 License

MIT
