import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fetch, RequestInit, ProxyAgent } from 'undici';
import QRCode from 'qrcode';
import { ChatDB } from './chat-db';
import {
  ILinkMessage,
  ChatMessage,
  MsgType,
  MsgTypeValue,
  QRCodeResponse,
  QRCodeStatusResponse,
  GetUpdatesResponse,
} from './types';

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

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

  private getProxyAgent(): ProxyAgent | undefined {
    const config = vscode.workspace.getConfiguration('clawbot');
    const proxyUrl = config.get<string>('proxyUrl') || '';
    const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
    const proxy = proxyUrl || envProxy;
    return proxy ? new ProxyAgent(proxy) : undefined;
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
      dispatcher: agent,
    } as RequestInit);

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
        const base64 = await this.fetchQrAsBase64(qrRes.qrcode_img_content);
        if (base64) {
          this.emitQrCode(base64);
        }
      }
      this.emitStatus('Please scan QR code with WeChat');

      const confirmed = await this.pollQrStatus(qrRes.qrcode);
      if (confirmed) break;

      this.emitStatus('QR code expired, generating new one...');
    }

    this._connected = true;
    await this.context.secrets.store('clawbot_token', this.botToken);
    await this.saveCredentialsToFile();
    this.emitStatus('Login successful');
    this._onLoginSuccess.fire();
  }

  private async saveCredentialsToFile(): Promise<void> {
    try {
      const filePath = path.join(this.context.globalStorageUri.fsPath, 'credentials.json');
      const data = {
        token: this.botToken,
        baseUrl: this.botBaseUrl,
        savedAt: new Date().toISOString(),
      };
      await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error('[ClawBot] Failed to save credentials file:', err.message);
    }
  }

  private async loadCredentialsFromFile(): Promise<{ token: string; baseUrl: string } | null> {
    try {
      const filePath = path.join(this.context.globalStorageUri.fsPath, 'credentials.json');
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (data.token) {
        return { token: data.token, baseUrl: data.baseUrl || BASE_URL };
      }
    } catch {
      // File doesn't exist or is invalid — that's fine
    }
    return null;
  }

  private async fetchQrAsBase64(url: string): Promise<string | null> {
    try {
      // Generate QR code from the full URL - this is what WeChat needs to scan
      const base64 = await QRCode.toDataURL(url, {
        errorCorrectionLevel: 'M',
        width: 256,
        margin: 1,
      });
      return base64;
    } catch (err: any) {
      console.error('[ClawBot] QR generation error:', err.message);
      return null;
    }
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
      } catch (err: any) {
        this.emitStatus(`QR polling error: ${err.message}`);
      }
    }
    return false;
  }

  async restoreLogin(): Promise<boolean> {
    // Try SecretStorage first
    const secretToken = await this.context.secrets.get('clawbot_token');
    if (secretToken) {
      this.botToken = secretToken;
      this._connected = true;
      this.emitStatus('Restored previous session');
      return true;
    }

    // Fall back to file-based credentials
    const fileCreds = await this.loadCredentialsFromFile();
    if (fileCreds) {
      this.botToken = fileCreds.token;
      this.botBaseUrl = fileCreds.baseUrl;
      this._connected = true;
      this.emitStatus('Restored previous session (file)');
      return true;
    }

    return false;
  }

  async startPolling(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.pollingAbort = new AbortController();
    this.reconnectDelay = 1000;
    console.log('[ClawBot] Polling started');
    this.pollLoop().catch((err) => {
      this.emitStatus(`Polling error: ${err.message}`);
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const cursor = await this.db.getMetadata('last_cursor') || '';
        console.log('[ClawBot] Polling getupdates, cursor length:', cursor.length);
        const res = await this.request<GetUpdatesResponse>('/ilink/bot/getupdates', {
          method: 'POST',
          body: JSON.stringify({
            get_updates_buf: cursor,
            base_info: { channel_version: '1.0.2' },
          }),
          signal: this.pollingAbort?.signal,
        });
        console.log('[ClawBot] getupdates response:', JSON.stringify({ msgCount: res.msgs?.length ?? 'null', cursorLen: res.get_updates_buf?.length ?? 0 }));

        if (res.msgs && res.msgs.length > 0) {
          await this.processMessages(res.msgs);
        }

        if (res.get_updates_buf) {
          await this.db.setMetadata('last_cursor', res.get_updates_buf);
        }

        this.reconnectDelay = 1000;
      } catch (err: any) {
        console.log('[ClawBot] Poll error:', err.name, err.message);
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
        console.log('[ClawBot] processMessage item:', JSON.stringify(item));
        let content = item.text_item?.text || '';
        if (item.type === 2 && item.image_item) {
          content = item.image_item.media?.full_url || JSON.stringify(item);
        } else if (!content) {
          content = JSON.stringify(item);
        }

        const chatMsg: Omit<ChatMessage, 'id'> = {
          direction: 'received',
          type: item.type as MsgTypeValue,
          content,
          timestamp: Math.floor(Date.now() / 1000),
          context_token: msg.context_token,
          from_user_id: msg.from_user_id,
          to_user_id: msg.to_user_id,
        };

        await this.db.setMetadata('from_user_id', msg.from_user_id);
        await this.db.setMetadata('to_user_id', msg.to_user_id);

        // For images, fetch and decrypt before firing so webview has the data
        let imageDataUrl: string | undefined;
        if (item.type === 2 && item.image_item) {
          console.log('[ClawBot] Fetching image:', item.image_item.media?.full_url?.substring(0, 50));
          imageDataUrl = await this.fetchImageAsDataUrl(item.image_item.media.full_url, item.image_item.media.aes_key);
          console.log('[ClawBot] Image fetched:', imageDataUrl ? imageDataUrl.length + ' bytes data url' : 'failed');
        }

        const id = await this.db.insertMessage(chatMsg);

        if (imageDataUrl) {
          await this.persistImage(id, imageDataUrl);
        }

        this._onMessage.fire({ ...chatMsg, id, imageDataUrl } as ChatMessage & { imageDataUrl?: string });
      }
    }
  }

  private async fetchImageAsDataUrl(cdnUrl: string, aesKeyBase64: string): Promise<string | undefined> {
    try {
      console.log('[ClawBot] fetchImage: cdnUrl=', cdnUrl.substring(0, 80));
      console.log('[ClawBot] fetchImage: aesKeyBase64=', aesKeyBase64.substring(0, 40));
      // media.aes_key is base64 of a 32-char hex string
      // Decode: base64 → hex string → 16 raw bytes (matching official openclaw-weixin)
      const hexStr = Buffer.from(aesKeyBase64, 'base64').toString('ascii');
      console.log('[ClawBot] fetchImage: hexStr=', hexStr, 'length=', hexStr.length);
      const key = Buffer.from(hexStr, 'hex');
      console.log('[ClawBot] fetchImage: key length=', key.length);
      const agent = this.getProxyAgent();
      console.log('[ClawBot] fetchImage: agent=', agent ? 'proxy set' : 'no proxy');
      const resp = await fetch(cdnUrl, { dispatcher: agent } as RequestInit);
      console.log('[ClawBot] fetchImage: resp.status=', resp.status, 'resp.ok=', resp.ok);
      if (!resp.ok) return undefined;
      const encrypted = Buffer.from(await resp.arrayBuffer());
      console.log('[ClawBot] fetchImage: encrypted length=', encrypted.length);
      const decrypted = decryptAesEcb(encrypted, key);
      console.log('[ClawBot] fetchImage: decrypted length=', decrypted.length);
      return `data:image/png;base64,${decrypted.toString('base64')}`;
    } catch (err: any) {
      console.error('[ClawBot] fetchImage error:', err.message, err.stack);
      return undefined;
    }
  }

  // Persist decrypted image to disk for cross-session retrieval
  private async persistImage(messageId: number, dataUrl: string): Promise<void> {
    try {
      const imgDir = path.join(this.context.globalStorageUri.fsPath, 'images');
      await fs.promises.mkdir(imgDir, { recursive: true });
      const imgPath = path.join(imgDir, `${messageId}.png`);
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      await fs.promises.writeFile(imgPath, Buffer.from(base64, 'base64'));
      // Also store the data URL in a JSON sidecar for easy retrieval
      await fs.promises.writeFile(`${imgPath}.url.json`, JSON.stringify({ dataUrl }));
    } catch (err: any) {
      console.error('[ClawBot] Failed to persist image:', err.message);
    }
  }

  // Load a persisted image data URL from disk
  async getDecryptedImageUrl(messageId: number): Promise<string | undefined> {
    try {
      const imgPath = path.join(this.context.globalStorageUri.fsPath, 'images', `${messageId}.png.url.json`);
      const raw = await fs.promises.readFile(imgPath, 'utf-8');
      return JSON.parse(raw).dataUrl;
    } catch {
      return undefined;
    }
  }

  stopPolling(): void {
    this.polling = false;
    this.pollingAbort?.abort();
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
        client_id: `openclaw-vscode-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        context_token: lastCursor,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: '2.4.3' },
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

    // Generate random AES key and file metadata
    const aesKey = crypto.randomBytes(16);
    const fileData = await fs.promises.readFile(imagePath);
    const encrypted = this.aesEncrypt(fileData, aesKey);
    const fileMd5 = crypto.createHash('md5').update(fileData).digest('hex');
    const filekey = crypto.randomBytes(16).toString('hex');

    // Get upload URL with proper parameters (matching official openclaw-weixin)
    const uploadUrlRes = await this.request<{
      upload_full_url?: string;
      upload_url?: string;
      upload_param?: string;
      thumb_upload_param?: string;
      filekey?: string;
      aeskey?: string;
    }>('/ilink/bot/getuploadurl', {
      method: 'POST',
      body: JSON.stringify({
        filekey,
        media_type: 1,
        to_user_id: fromId,
        rawsize: fileData.length,
        rawfilemd5: fileMd5,
        filesize: encrypted.length,
        aeskey: aesKey.toString('hex'),
        no_need_thumb: true,
      }),
    });

    const uploadUrl = uploadUrlRes.upload_full_url || uploadUrlRes.upload_url || uploadUrlRes.upload_param;
    if (!uploadUrl) {
      throw new Error('Failed to get upload URL: ' + JSON.stringify(uploadUrlRes));
    }

    // Upload encrypted file to CDN (official uses POST, not PUT)
    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      body: encrypted,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (!uploadResp.ok) {
      const body = await uploadResp.text().catch(() => '');
      throw new Error(`Upload failed: ${uploadResp.status} - ${body}`);
    }

    // Get download encrypted_query_param from response header (official pattern)
    const downloadEncryptedParam = uploadResp.headers.get('x-encrypted-param') || '';
    const mediaAesKey = aesKey.toString('base64');

    // Build the full CDN download URL
    const fullUrl = downloadEncryptedParam
      ? `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(downloadEncryptedParam)}`
      : uploadUrl.replace('/upload', '/download');

    // Send message with image reference (matching official openclaw-weixin format)
    const payload = {
      msg: {
        to_user_id: fromId,
        from_user_id: toId,
        client_id: `openclaw-vscode-${crypto.randomUUID()}`,
        message_type: 2,
        message_state: 2,
        context_token: lastCursor,
        item_list: [
          {
            type: 2,
            image_item: {
              aeskey: aesKey.toString('hex'),
              media: {
                aes_key: mediaAesKey,
                full_url: fullUrl,
                encrypt_query_param: downloadEncryptedParam,
              },
            },
          },
        ],
      },
      base_info: { channel_version: '2.4.3' },
    };

    await this.request('/ilink/bot/sendmessage', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const chatMsg: Omit<ChatMessage, 'id'> = {
      direction: 'sent',
      type: MsgType.Image,
      content: fullUrl,
      timestamp: Math.floor(Date.now() / 1000),
      context_token: lastCursor,
      from_user_id: toId,
      to_user_id: fromId,
    };

    const id = await this.db.insertMessage(chatMsg);
    this._onMessage.fire({ ...chatMsg, id });
  }

  // iLink protocol requires AES-128-ECB for media encryption
  private aesEncrypt(data: Buffer, key: Buffer): Buffer {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
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
    this.botBaseUrl = BASE_URL;
    await this.context.secrets.delete('clawbot_token');
    try {
      const filePath = path.join(this.context.globalStorageUri.fsPath, 'credentials.json');
      await fs.promises.unlink(filePath);
    } catch {
      // File doesn't exist — that's fine
    }
  }

  dispose(): void {
    this.stopPolling();
    this._onMessage.dispose();
    this._onStatus.dispose();
    this._onQrCode.dispose();
    this._onLoginSuccess.dispose();
  }
}
