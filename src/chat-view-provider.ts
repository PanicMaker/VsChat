import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChatClient } from './chat-client';
import { ChatDB } from './chat-db';
import { previewForNotification } from './push';
import { WebViewOutbound, WebViewInbound, ChatMessage } from './types';
import * as log from './logger';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vschat.chatView';

  private view: vscode.WebviewView | null = null;
  private disposables: vscode.Disposable[] = [];
  private historyStartId: number | undefined;
  private historyPending: Promise<void> = Promise.resolve();
  private viewGeneration = 0;

  constructor(
    private context: vscode.ExtensionContext,
    private client: ChatClient,
    private db: ChatDB
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    this.viewGeneration += 1;
    this.historyStartId = undefined;
    log.info('[UI] chat view resolved', { channel: this.client.channelName, connected: this.client.connected });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'webview'),
      ],
    };

    webviewView.webview.html = this.getHtml();

    // Clean up old listeners before adding new ones
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];

    // Handle messages from WebView
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage(async (msg: WebViewOutbound) => {
        await this.handleWebViewMessage(msg);
      })
    );

    // Subscribe to client events
    this.disposables.push(
      this.client.onMessage(async (chatMsg: ChatMessage & { imageDataUrl?: string }) => {
        // Panel-only concerns: live UI updates and an editor notification.
        // Receive logging + Bark push live in extension.ts (panel-independent).
        this.postMessage({ command: 'newMessage', message: chatMsg, imageDataUrl: chatMsg.imageDataUrl });

        if (chatMsg.direction === 'received') {
          const preview = previewForNotification(chatMsg);
          vscode.window.showInformationMessage(`${this.client.channelName}: ${preview}`, { modal: false });
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
        try {
          await this.loadHistory();
        } catch (err) {
          log.warn('[UI] history load after login failed', { channel: this.client.channelName }, log.formatError(err));
        }
      })
    );

    // The webview's ready message loads persisted history even while offline.
  }

  private async handleWebViewMessage(msg: WebViewOutbound): Promise<void> {
    const operationId = log.nextId('ui');
    log.debug('[UI] command received', {
      operationId,
      command: msg.command,
      textLength: msg.text?.length || 0,
      imageDataLength: msg.imageData?.length || 0,
      hasReply: Boolean(msg.replyTo),
    });
    try {
      if (msg.command === 'sendMessage' && msg.text) {
        const warning = await this.client.sendText(msg.text, msg.replyTo);
        if (warning) this.postMessage({ command: 'warning', warning });
      } else if (msg.command === 'sendImage' && msg.imageData) {
        const tempDir = path.join(this.context.globalStorageUri.fsPath, 'temp');
        fs.mkdirSync(tempDir, { recursive: true });
        const requestedExtension = path.extname(msg.fileName || '').toLowerCase();
        const safeExtension = /^\.(png|jpe?g|gif|webp|bmp)$/.test(requestedExtension)
          ? requestedExtension
          : '.png';
        const tempPath = path.join(tempDir, `img_${Date.now()}${safeExtension}`);

        // Remove data URL prefix and validate size (max 10MB)
        const base64Data = msg.imageData.replace(/^data:image\/\w+;base64,/, '');
        if (base64Data.length > 10 * 1024 * 1024) {
          throw new Error('Image too large (max 10MB)');
        }

        try {
          fs.writeFileSync(tempPath, Buffer.from(base64Data, 'base64'));
          const warning = await this.client.sendImage(tempPath);
          if (warning) this.postMessage({ command: 'warning', warning });
        } finally {
          try { fs.unlinkSync(tempPath); } catch {}
        }
      } else if (msg.command === 'ready') {
        await this.loadHistory();
      } else if (msg.command === 'login') {
        vscode.commands.executeCommand('vschat.login');
      } else if (msg.command === 'openExternal' && msg.url) {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
      } else if (msg.command === 'loadMoreHistory') {
        if (Number.isSafeInteger(msg.beforeId) && msg.beforeId! > 0) {
          await this.loadHistory(msg.beforeId);
        }
      }
    } catch (err: any) {
      log.error('[UI] command failed', { operationId, command: msg.command, channel: this.client.channelName }, log.formatError(err));
      this.postMessage({ command: 'error', error: err.message });
      if (msg.command === 'loadMoreHistory') this.postMessage({ command: 'historyError' });
    }
  }

  loadHistory(beforeId?: number): Promise<void> {
    const generation = this.viewGeneration;
    const task = this.historyPending.then(() => this.loadHistoryPage(beforeId, generation));
    this.historyPending = task.catch(() => undefined);
    return task;
  }

  private async loadHistoryPage(beforeId: number | undefined, generation: number): Promise<void> {
    if (generation !== this.viewGeneration) return;
    const startedAt = Date.now();
    const older = beforeId !== undefined;
    let messages: ChatMessage[];
    let hasMore: boolean;
    if (!older && this.historyStartId !== undefined) {
      // Refresh the whole loaded range so reconnection fills gaps without
      // discarding history the user already paged through.
      messages = await this.db.getMessagesFromId(this.historyStartId);
      hasMore = (await this.db.getRecentMessages(1, this.historyStartId)).length > 0;
    } else {
      const page = await this.db.getRecentMessages(101, beforeId);
      hasMore = page.length > 100;
      messages = hasMore ? page.slice(1) : page;
    }
    // Attach persisted image data for image messages
    const messagesWithImages = await Promise.all(
      messages.map(async (msg) => {
        if (msg.type === 2) {
          const url = await this.client.getDecryptedImageUrl(msg.id)
            || (msg.content?.startsWith('http') ? msg.content : undefined);
          return url ? { ...msg, imageDataUrl: url } : msg;
        }
        return msg;
      })
    );
    if (generation !== this.viewGeneration) return;
    if (messages.length) {
      this.historyStartId = Math.min(this.historyStartId ?? Infinity, messages[0].id);
    }
    this.postMessage({ command: 'loadHistory', messages: messagesWithImages, hasMore, older });
    log.info('[UI] history loaded', {
      channel: this.client.channelName,
      messageCount: messagesWithImages.length,
      hasMore,
      older,
      durationMs: Date.now() - startedAt,
    });
  }

  async clearHistory(): Promise<void> {
    log.info('[UI] clearing history', { channel: this.client.channelName });
    this.viewGeneration += 1;
    await this.historyPending;
    await this.db.clearAll();
    this.historyStartId = undefined;
    // Clear only the active channel's media; the other channel's history and
    // files intentionally survive transport switching.
    try {
      const directoryName = this.client.channelName === 'QQ' ? 'qq-images' : 'images';
      const imgDir = path.join(this.context.globalStorageUri.fsPath, directoryName);
      await fs.promises.rm(imgDir, { recursive: true, force: true });
    } catch {
      // Directory doesn't exist — that's fine
    }
    this.postMessage({ command: 'clearHistory' });
    log.info('[UI] history cleared', { channel: this.client.channelName });
  }

  private postMessage(msg: WebViewInbound): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(): string {
    const webview = this.view!.webview;
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'styles.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'main.js'));

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: https:;">
        <link href="${stylesUri}" rel="stylesheet">
      </head>
      <body class="mode-chat">
        <div id="toolbar">
          <button class="toolbar-btn active" data-mode="chat">Chat</button>
          <button class="toolbar-btn" data-mode="log">Output</button>
          <button class="toolbar-btn" data-mode="git">Changes</button>
          <span class="toolbar-spacer"></span>
        </div>
        <div id="login-screen" class="hidden">
          <div id="login-status">Initializing...</div>
          <img id="qrcode" class="hidden" alt="Scan QR code">
        </div>
        <div id="chat-container">
          <button id="load-more-history" class="hidden" type="button">加载更早消息</button>
          <div id="messages"></div>
        </div>
        <div id="input-bar">
          <div id="quote-bar" class="hidden">
            <div id="quote-preview"></div>
            <button id="quote-cancel" title="取消引用">&times;</button>
          </div>
          <button id="emoji-btn" title="Emoji">😊</button>
          <button id="attach-btn" title="Attach">&#x1F4CE;</button>
          <input type="file" id="file-input" accept="image/*" class="hidden">
          <input type="text" id="text-input" placeholder="Type a message...">
          <button id="send-btn">Send</button>
          <div id="emoji-panel" class="hidden"></div>
        </div>
        <div id="lightbox" class="hidden">
          <img id="lightbox-img" src="" alt="Preview">
          <button id="lightbox-close">&times;</button>
          <div id="lightbox-zoom">100%</div>
        </div>
        <script src="${scriptUri}"></script>
      </body>
      </html>
    `;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.view = null;
  }
}
