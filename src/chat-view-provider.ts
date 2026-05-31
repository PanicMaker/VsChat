import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { VsChatClient } from './vschat-client';
import { ChatDB } from './chat-db';
import { WebViewOutbound, WebViewInbound, ChatMessage } from './types';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vschat.chatView';

  private view: vscode.WebviewView | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private context: vscode.ExtensionContext,
    private client: VsChatClient,
    private db: ChatDB
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

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
        console.log('[provider] onMessage fired:', JSON.stringify({ id: chatMsg.id, type: chatMsg.type, direction: chatMsg.direction, contentLen: chatMsg.content.length, imageDataUrlLen: chatMsg.imageDataUrl?.length ?? 'none' }));
        this.postMessage({ command: 'newMessage', message: chatMsg, imageDataUrl: chatMsg.imageDataUrl });

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
        try {
          const messages = await this.db.getRecentMessages(100);
          this.postMessage({ command: 'loadHistory', messages });
        } catch {
          // Ignore DB errors on login success — history will load on next panel open
        }
      })
    );

    // Load history if already connected
    if (this.client.connected) {
      // Delay slightly to ensure webview JS is ready
      setTimeout(() => this.loadHistory(), 100);
    }
  }

  private async handleWebViewMessage(msg: WebViewOutbound): Promise<void> {
    try {
      if (msg.command === 'sendMessage' && msg.text) {
        await this.client.sendText(msg.text);
      } else if (msg.command === 'sendImage' && msg.imageData) {
        const tempDir = path.join(this.context.globalStorageUri.fsPath, 'temp');
        fs.mkdirSync(tempDir, { recursive: true });
        const tempPath = path.join(tempDir, `img_${Date.now()}.png`);

        // Remove data URL prefix and validate size (max 10MB)
        const base64Data = msg.imageData.replace(/^data:image\/\w+;base64,/, '');
        if (base64Data.length > 10 * 1024 * 1024) {
          throw new Error('Image too large (max 10MB)');
        }

        try {
          fs.writeFileSync(tempPath, Buffer.from(base64Data, 'base64'));
          await this.client.sendImage(tempPath);
        } finally {
          try { fs.unlinkSync(tempPath); } catch {}
        }
      } else if (msg.command === 'ready') {
        // Webview is loaded and ready — load history if connected
        if (this.client.connected) {
          await this.loadHistory();
        }
      } else if (msg.command === 'login') {
        vscode.commands.executeCommand('vschat.login');
      } else if (msg.command === 'openExternal' && msg.url) {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
      } else if (msg.command === 'loadMoreHistory') {
        // Could implement pagination here
      }
    } catch (err: any) {
      this.postMessage({ command: 'error', error: err.message });
    }
  }

  async loadHistory(): Promise<void> {
    const messages = await this.db.getRecentMessages(100);
    // Attach persisted image data for image messages
    const messagesWithImages = await Promise.all(
      messages.map(async (msg) => {
        if (msg.type === 2) {
          const url = await this.client.getDecryptedImageUrl(msg.id);
          return url ? { ...msg, imageDataUrl: url } : msg;
        }
        return msg;
      })
    );
    this.postMessage({ command: 'loadHistory', messages: messagesWithImages });
  }

  async clearHistory(): Promise<void> {
    await this.db.clearAll();
    // Also clear persisted images
    try {
      const imgDir = path.join(this.context.globalStorageUri.fsPath, 'images');
      await fs.promises.rm(imgDir, { recursive: true, force: true });
    } catch {
      // Directory doesn't exist — that's fine
    }
    this.postMessage({ command: 'clearHistory' });
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
          <div id="messages"></div>
        </div>
        <div id="input-bar">
          <button id="attach-btn" title="Attach">&#x1F4CE;</button>
          <input type="file" id="file-input" accept="image/*" class="hidden">
          <input type="text" id="text-input" placeholder="Type a message...">
          <button id="send-btn">Send</button>
        </div>
        <div id="lightbox" class="hidden">
          <img id="lightbox-img" src="" alt="Preview">
          <button id="lightbox-close">&times;</button>
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
