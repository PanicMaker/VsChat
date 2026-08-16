# VsChat 功能建议清单

> 基于 2026-08-12 的代码现状整理，按性价比排序。

## 现状摘要

- 单会话：`from_user_id` / `to_user_id` 存在 DB metadata 中，全局只有一对
- 消息类型只实现文本（type 1）和图片（type 2），语音/文件/视频有类型定义但走 JSON 兜底渲染
- 引用回复已实现（v0.5.0）：入站解析 `ref_msg`（含 `item.extra.ref_msg` 兼容），出站携带标准 `ref_msg`
- `markdown-it` 已依赖但未使用
- `loadMoreHistory` 是留了注释的空 stub
- 聊天记录为明文 SQLite，无退出即清空选项

## 高价值，改动可控

### 1. 多会话 / 联系人列表

从单会话升级为按联系人维度存储和展示：

- 消息按 conversation 维度存取，DB 表结构基本可复用
- 侧边栏加联系人切换、未读角标
- 架构上把 metadata 单值改成会话维度即可

改动量：中等偏大。是插件从"能用"到"好用"的关键一步。

### 2. 文件收发（最适合 VSCode 的能力）

- `MsgType.File = 4` 和 `file_item`（文件名、大小、CDN 地址）已在 types.ts 定义
- 现在收文件只显示 `JSON.stringify(item)` 的原始 JSON
- 实现：收到文件 → 解密下载 → 在编辑器打开；右键本地文件 → 发送给微信
- 图片的 AES 解密管线可直接复用

改动量：中等，价值极高。

### 3. 消息内 Markdown 渲染

- `markdown-it` 已在依赖中但无人使用
- 渲染收到的消息，支持代码块
- 立刻提升"程序员向"观感

改动量：很小。

### 4. 历史消息分页加载

- `chat-view-provider.ts` 中 `loadMoreHistory` 是空 stub（注释写着 "Could implement pagination here"）
- `chat-db.ts` 的 `getRecentMessages(limit)` 已支持 limit
- 滚动到顶部加载更早消息

改动量：小。

## 中价值，锦上添花

### 5. 语音消息（type 3）

- `voice_item` 带 `transcription` 转写文本，现在走 JSON 兜底
- 至少渲染转写文本；更进一步可像图片一样解密下载音频并播放

改动量：中等。

### 6. 引用 / 回复消息

- ✅ 已实现（v0.5.0）：hover ↩ 按钮 → 引用条 → 发送；气泡内渲染引用块，点击跳转
- 入站引用：iLink 引用消息通常省略 `text_item`，只带 `msg_id`/时间戳；实现按 `text_item → title → 本地 message_id → 本地时间戳(±2s)` 逐级回填
- 出站引用：**已知平台限制** —— iLink/微信客户端不渲染 bot 发送的 `ref_msg`（消息正常投递但无引用条；`item.ref_msg` 与 `item.extra.ref_msg` 两种位置均实测无效，社区亦无成功先例）。保留标准位置字段，未来平台支持后自动生效
- 技术要点：微信端消息 ID 是顶层 `message_id`（i64），JS `JSON.parse` 会丢精度，需从原始响应文本提取精确字符串；`item.msg_id` 的 `v1:` 前缀是 iLink 内部 ID，不可用于引用

### 7. 消息搜索

- SQLite `LIKE` 即可实现
- 搜索框 + 命中高亮 + 点击跳转

### 8. 导出聊天记录

- 一键导出 Markdown / HTML / JSON 到工作区
- 读 DB + 生成文件，改动不大

### 9. VSCode 原生集成

- 状态栏显示未读数，点击聚焦面板
- 收到消息的通知可点击直达（现在是纯展示的 `showInformationMessage`）
- 编辑器选中代码 → 右键"发送到微信"，自动包成代码块
- 发送失败自动重试队列（现在失败只抛错误到 UI）

### 10. 多行输入

- 现在 Enter 发送、Shift+Enter 无多行行为
- 改成 textarea 支持多行

改动量：很小，高频体验改进。

## 值得警惕的方向

- **隐私与安全**：聊天记录明文存储在 `globalStorage`，无"退出即清空"。可加存储加密或退出清空开关。
- **群聊**：iLink 机器人协议（openclaw-weixin）不支持群聊，不要投入。

## 建议路线

1. 文件收发（复用现有解密管线，价值直接）
2. Markdown 渲染（激活已有依赖，立刻提升观感）
3. 多会话（大工程，最后投入）
