# VsChat — VSCode Extension

<p align="center">
  <img src="https://img.shields.io/badge/VSCode-%5E1.85.0-blue?logo=visual-studio-code" alt="VSCode Version" />
  <img src="https://img.shields.io/badge/TypeScript-5.3+-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License" />
  <img src="https://img.shields.io/badge/Version-0.9.0-orange" alt="Version" />
</p>

在 VSCode 侧边栏中通过微信或 QQ 直接聊天。微信通道基于腾讯 [OpenClaw iLink 协议](https://github.com/Tencent/openclaw-weixin)，QQ 通道基于官方 [QQ Bot API v2](https://bot.q.qq.com/wiki/develop/api-v2/)。两个通道共用聊天界面，但凭据、连接和历史记录彼此隔离。

## ✨ 功能特性

- 🔀 **双通道** — 可在 `wechat` 与 `qq` 之间切换，原微信方案保持可用
- 🔐 **微信扫码登录** — 微信通道在 VSCode 中扫描二维码登录
- 🤖 **QQ Bot 登录** — 使用 AppID/AppSecret 获取 Access Token，密钥保存在 VS Code SecretStorage
- 🔌 **QQ 实时事件** — Gateway WebSocket 心跳、Session 恢复和断线退避重连
- 💬 **实时消息收发** — 长轮询接收消息，即时发送文本
- 🖼️ **图片支持** — 微信使用 AES-128-ECB 媒体链路；QQ 使用官方分片上传接口
- ↩️ **引用回复** — 微信保留原引用逻辑；QQ 使用 `msg_id` 与 `message_reference`
- 🔍 **图片预览** — 点击接收的图片在 Lightbox 中全屏查看
- 💾 **消息持久化** — 基于 SQLite 的本地消息存储，重启后保留历史
- 🔄 **会话恢复** — 自动恢复上一次登录会话，无需重新扫码
- 🌐 **代理支持** — 可配置 HTTP 代理
- 📱 **Bark iPhone 推送** — 收到新消息时推送提醒到 iPhone，不再错过
- 🔄 **自动更新** — 基于 GitHub Release 检测新版本，一键下载安装

### 📱 iPhone 推送提醒（Bark）

1. iPhone 安装 [Bark](https://apps.apple.com/cn/app/bark-%E6%8E%A8%E9%80%81/id1403753865) 并获取设备 Key。
2. 在 VSCode 设置中配置 `vschat.barkUrl`，例如 `https://api.day.app/你的Key/`。
3. 执行命令 **VsChat: Test Push Notification** 验证手机能否收到通知。
4. 之后每条收到的微信或 QQ 消息都会触发 iPhone 通知。也支持带 `{title}` / `{message}` 占位符的完整 URL 模板，用于自定义提示音、分组等参数。

> 注意：推送依赖扩展运行，VSCode 窗口需要保持连接。消息内容超过 500 字符时会截断。

## 🐧 QQ Bot 接入

### 1. 创建机器人并开通事件

1. 前往 [QQ 开放平台](https://q.qq.com/#/) 创建机器人，取得 `AppID` 和 `AppSecret`。
2. 在机器人后台开通单聊能力，并申请/启用 `GROUP_AND_C2C_EVENT` 事件权限；插件只订阅该项（`1 << 25`），用于接收 `C2C_MESSAGE_CREATE`。
3. 发布或配置机器人测试环境，并在 QQ 中添加/使用机器人。具体后台选项以 [QQ Bot API v2 启动接入](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/getting-started.html) 为准。

> QQ 官方已弃用旧 Token 鉴权。本插件按当前文档使用 AppID/AppSecret 请求 `access_token`，并在到期前自动刷新；OpenAPI 与 Gateway 鉴权均使用 `QQBot ACCESS_TOKEN`。

### 2. 在 VSCode 中配置

1. 打开命令面板，执行 **VsChat: Configure QQ Bot**。
2. 输入 AppID 和 AppSecret。AppSecret 不写入 `settings.json`，而是保存到 VS Code SecretStorage。
3. 选择提示中的 **Reload Window**。命令会把 `vschat.channel` 切换为 `qq`。
4. 重载后插件会自动连接 Gateway。首次使用时，请先从 QQ 给机器人发送一条消息，插件会从事件中记录该用户的 `user_openid`，之后即可在侧边栏继续对话。

也可以通过扩展宿主环境变量 `VSCHAT_QQ_APP_ID`、`VSCHAT_QQ_APP_SECRET` 提供凭据。若需要在尚未收到消息前主动发送，可选填 `vschat.qqUserOpenId`；通常建议留空，让插件自动使用最近发来消息的用户。

### QQ 通道实现范围与平台规则

- 支持单聊文本、图片发送，以及文本、图片、语音转写和文件事件展示。
- 图片按官方流程执行 `upload_prepare` → 预签名 URL 分片 PUT → `upload_part_finish` → `/files` 合并 → `msg_type=7` 发送。
- 相同 QQ 消息可能重复推送，插件按事件消息 ID 去重；Gateway 序列号和 Session ID 会持久化以便断线恢复。
- 用户发来消息后的 60 分钟内，插件优先携带 `msg_id` 作为被动回复（每条最多 4 次）；更早的发送会转为主动消息，引用仍可使用 `message_reference`。主动消息受用户接收开关与 QQ 平台频控约束，详见 [消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)。
- 当前界面沿用单会话模型：未配置 `vschat.qqUserOpenId` 时，发送目标是最近与机器人单聊的用户。

### 切回微信

将 `vschat.channel` 改为 `wechat` 并重载 VSCode。微信历史仍保存在原数据库中，QQ 历史使用独立的 `vschat_qq_chats.db`，切换不会覆盖另一通道的数据。

### 🔄 自动更新（基于 GitHub Release）

每次向 `main`/`master` 推送时，GitHub Actions 会自动构建 `vschat.vsix` 并发布为 `v{版本号}` 的 Release。插件在此基础上实现自更新：

1. 启动后 10 秒自动检查一次，之后每 6 小时检查一次；也可随时执行 **VsChat: Check for Updates** 手动检查。
2. 发现新版本时弹出提示，确认后下载 VSIX 并自动安装，重载窗口即可生效。
3. 发布新版本前，记得先修改 `package.json` 中的 `version`，推送后等待 workflow 生成 Release（几分钟），插件下次检查即可发现。

可用 `vschat.autoUpdate` 设置（默认 `true`）关闭自动检查。注意：

- GitHub API 匿名访问有每小时 60 次的限制，检查失败会自动跳过，不影响插件使用。
- 第一次安装仍需要手动安装 VSIX，之后同一台机器上的更新即可自动完成。
- 若自动安装失败，会提示打开 Release 页面手动下载。

## 📁 项目结构

```
VsChat/
├── src/                          # TypeScript 源码
│   ├── extension.ts              # 扩展入口点：激活、注册命令与视图
│   ├── chat-client.ts           # 微信/QQ 共用客户端接口
│   ├── wx-client.ts             # 微信客户端：扫码、轮询、收发消息、CDN 上传
│   ├── wx-types.ts              # 微信 iLink 专用协议类型
│   ├── qq-bot-client.ts         # QQ 客户端：Token、Gateway、单聊与分片上传
│   ├── chat-view-provider.ts     # WebviewView 提供者：桥接 UI 与客户端
│   ├── chat-db.ts                # SQLite 数据库：消息与元数据持久化
│   └── types.ts                  # 微信/QQ 共用的聊天与 Webview 类型
├── webview/                      # Webview 前端（纯 HTML/CSS/JS）
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
│  │ ChatClient   │◀── 事件 ────▶│   Webview (UI)    │   │
│  │ 微信 / QQ    │   onMessage  │   main.js         │   │
│  │ 传输实现     │   onStatus   │   styles.css       │   │
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
                    │ HTTPS / WebSocket
                    ▼
          ┌──────────────────────────┐
          │ WeChat iLink / QQ Bot v2│
          │ API + Gateway + Media   │
          └──────────────────────────┘
```

### 核心模块说明

| 模块 | 文件 | 职责 |
|------|------|------|
| **入口** | `extension.ts` | 扩展激活/停用，初始化 DB 和客户端，注册命令 |
| **客户端接口** | `chat-client.ts` | 为 Webview 统一微信与 QQ 的连接、事件和发送能力 |
| **微信客户端** | `wx-client.ts` | QR 码登录、长轮询消息、文本/图片发送、AES 加解密、CDN 文件上传 |
| **微信协议类型** | `wx-types.ts` | iLink 消息、二维码登录、轮询和发送响应结构 |
| **QQ 客户端** | `qq-bot-client.ts` | Access Token 刷新、Gateway 心跳/恢复、C2C 消息、富媒体分片上传 |
| **视图桥接** | `chat-view-provider.ts` | 管理 Webview 生命周期，桥接客户端事件与 Webview 消息 |
| **数据库** | `chat-db.ts` | 基于 `sql.js` 的 SQLite 存储，管理消息和元数据 |
| **通用类型** | `types.ts` | 定义 `ChatMessage`、`ReplyTo`、`WebViewInbound/Outbound` 等跨通道接口 |
| **前端** | `webview/` | 聊天 UI：消息气泡、图片预览、输入栏、登录屏 |

### 数据流

1. **通道选择**：`extension.ts` 读取 `vschat.channel`，创建微信或 QQ 客户端，并使用各自独立的消息数据库。
2. **微信登录/收发**：保留原扫码、`getupdates` 长轮询、iLink `sendmessage` 与加密媒体链路。
3. **QQ 登录/接收**：AppID/AppSecret → Access Token → `/gateway` → Identify/Resume → `C2C_MESSAGE_CREATE` → 本地 DB → Webview。
4. **QQ 发送文本**：Webview → `QqBotClient.sendText()` → `/v2/users/{user_openid}/messages`。
5. **QQ 发送图片**：Webview → 临时文件 → QQ 分片上传/合并 → `msg_type=7` 消息。

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
2. 微信通道：打开聊天面板，执行 `VsChat: Login`，再用微信扫描二维码
3. QQ 通道：先执行 `VsChat: Configure QQ Bot`，按提示重载并从 QQ 给机器人发一条消息
4. 连接成功后自动进入聊天界面
5. 在输入框中输入文字发送，或点击 📎 附件按钮发送图片

### 可用命令

| 命令 | 说明 |
|------|------|
| `VsChat: Login` | 登录当前通道（微信扫码；QQ 校验凭据并连接） |
| `VsChat: Configure QQ Bot` | 安全保存 QQ AppID/AppSecret、切换到 QQ 通道 |
| `VsChat: Clear Chat History` | 清除所有聊天记录 |
| `VsChat: Disconnect` | 断开当前通道并清除该通道凭据 |
| `VsChat: Show Diagnostic Logs` | 打开 VsChat 诊断日志输出 |

### 配置项

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `vschat.channel` | `wechat \| qq` | `wechat` | 当前聊天通道，修改后需重载 VSCode |
| `vschat.proxyUrl` | string | `""` | HTTP 代理 URL，留空使用系统代理 |
| `vschat.fromUserId` | string | `""` | 指定聊天对象 ID，留空自动检测 |
| `vschat.qqUserOpenId` | string | `""` | QQ 主动消息目标；留空使用最近联系机器人的用户 |
| `vschat.logLevel` | `debug \| info \| warn \| error` | `debug` | 日志详细程度；排障结束后可改为 `info` |

### 诊断日志

出现连接、收发消息或媒体上传问题时，执行 **VsChat: Show Diagnostic Logs**。日志包含本次扩展运行标识、通道、请求编号、HTTP 状态、QQ 业务错误码与 Trace ID、请求耗时、Gateway 状态、重连/重试次数和消息类型等信息。

日志不会记录 AppSecret、Access Token、微信会话 Token、AES 密钥或消息正文；AppID、OpenID、消息 ID、Session ID 和 Trace ID 会脱敏显示。向开发者反馈问题时，建议从扩展启动位置开始复制完整日志，以便通过请求编号串联故障链路。

## 🔧 技术栈

| 技术 | 用途 |
|------|------|
| **TypeScript** | 扩展后端逻辑 |
| **VSCode Extension API** | Webview、命令、SecretStorage |
| **undici** | HTTP 请求（支持代理） |
| **sql.js** | 纯 JS 的 SQLite（无需原生模块） |
| **qrcode** | 微信 QR 码生成 |
| **QQ Bot API v2** | QQ Access Token、Gateway、单聊消息和富媒体上传 |
| **AES-128-ECB** | 媒体文件加解密（Node.js `crypto`） |
| **Vanilla JS/CSS** | Webview 前端 |

## 📄 License

MIT
