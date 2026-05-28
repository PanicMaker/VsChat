import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fetch, RequestInit } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
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

  private getProxyAgent(): HttpsProxyAgent<string> | undefined {
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
    this.emitStatus('Login successful');
    this._onLoginSuccess.fire();
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
    this.pollLoop().catch((err) => {
      this.emitStatus(`Polling error: ${err.message}`);
    });
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
          signal: this.pollingAbort?.signal,
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
          type: item.type as MsgTypeValue,
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
    const fileData = await fs.promises.readFile(imagePath);
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

  // iLink protocol requires AES-128-ECB for media encryption
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
