import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fetch, RequestInit, ProxyAgent } from 'undici';
import QRCode from 'qrcode';
import { ChatDB } from './chat-db';
import * as log from './logger';
import {
  ChatMessage,
  MsgType,
  MsgTypeValue,
  ReplyTo,
} from './types';
import {
  ILinkMessage,
  QRCodeResponse,
  QRCodeStatusResponse,
  GetUpdatesResponse,
  SendMessageResponse,
} from './wx-types';

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// Recover exact i64 message_id strings from raw JSON: JSON.parse silently rounds
// numbers above Number.MAX_SAFE_INTEGER, and iLink quote-replies echo these ids
// back as exact strings, so precision must be preserved.
function extractExactMessageIds(raw: string): string[] {
  const out: string[] = [];
  const re = /"message_id"\s*:\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    out.push(m[1]);
  }
  return out;
}

const BASE_URL = 'https://ilinkai.weixin.qq.com';

function randomUin(): string {
  const buf = crypto.randomBytes(4);
  return buf.toString('base64');
}

// iLink sendmessage retry policy (bounded, no retry storm — see hermes-agent
// issue #26828 for why unbounded retries are dangerous):
//  - genuine rate limits ("rate limited" / "freq limit") get up to
//    MAX_RATE_LIMIT_ATTEMPTS total attempts, backing off 1s → 3s → 9s;
//  - stale context_token ("prepare failed" / "unknown error" / errcode=-14)
//    gets ONE extra tokenless recovery send instead (hermes-agent #80426).
const MAX_RATE_LIMIT_ATTEMPTS = 4;
const RATE_LIMIT_BACKOFF_MS = [1000, 3000, 9000];
const CONTEXT_TOKEN_STALE_FLAG = 'context_token_stale';

// iLink sendmessage business-error classification:
//  - 'rate-limit':    genuine throttling
//  - 'stale-session': expired context_token (recoverable by dropping the token)
//  - 'other':         anything else (or unparseable response)
type SendFailureKind = 'rate-limit' | 'stale-session' | 'other';

interface SendAttemptResult {
  resp: SendMessageResponse | undefined;
  warning?: string;
  tokenUsed?: string;
}

export class WxClient extends vscode.Disposable {
  readonly channelName = 'WeChat';
  private botToken: string = '';
  private botBaseUrl: string = BASE_URL;
  private polling: boolean = false;
  private pollingAbort: AbortController | null = null;
  private reconnectDelay: number = 1000;
  private maxReconnectDelay: number = 30000;
  private _connected: boolean = false;
  private outboundMsgCounter: number = 0;
  private loggingIn: boolean = false;

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

  private _cachedProxyUrl: string = '';
  private _cachedProxyAgent: ProxyAgent | undefined;

  private getProxyAgent(): ProxyAgent | undefined {
    const config = vscode.workspace.getConfiguration('vschat');
    const proxyUrl = config.get<string>('proxyUrl') || '';
    const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
    const proxy = proxyUrl || envProxy;

    // Reuse cached agent if proxy URL hasn't changed
    if (proxy === this._cachedProxyUrl) {
      return this._cachedProxyAgent;
    }

    // Proxy changed — log and recreate
    if (proxy) {
      const source = proxyUrl ? 'settings' : 'env';
      log.info('[WX Network] proxy configured', { source, endpoint: log.describeUrl(proxy) });
    } else if (this._cachedProxyUrl) {
      log.info('[WX Network] proxy removed; using direct connection');
    }

    this._cachedProxyUrl = proxy;
    this._cachedProxyAgent = proxy ? new ProxyAgent(proxy) : undefined;
    return this._cachedProxyAgent;
  }

  private async requestRaw(urlPath: string, init?: RequestInit): Promise<{ json: any; text: string }> {
    const url = `${this.botBaseUrl}${urlPath}`;
    const agent = this.getProxyAgent();
    const method = (init?.method || 'GET').toUpperCase();
    const requestId = log.nextId('wx-http');
    const startedAt = Date.now();
    const safePath = this.safeRequestPath(urlPath);
    log.debug('[WX HTTP] request', {
      requestId,
      method,
      path: safePath,
      host: log.describeUrl(this.botBaseUrl),
      proxy: Boolean(agent),
      hasSessionToken: Boolean(this.botToken),
    });

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
    } as RequestInit).catch((err) => {
      log.error('[WX HTTP] network failure', {
        requestId,
        method,
        path: safePath,
        durationMs: Date.now() - startedAt,
      }, log.formatError(err));
      throw err;
    });

    if (!response.ok) {
      log.error('[WX HTTP] request rejected', {
        requestId,
        method,
        path: safePath,
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - startedAt,
      });
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    log.debug('[WX HTTP] response', {
      requestId,
      method,
      path: safePath,
      status: response.status,
      durationMs: Date.now() - startedAt,
      responseBytes: Buffer.byteLength(text),
      jsonParsed: json !== undefined,
    });
    return { json, text };
  }

  private async request<T>(urlPath: string, init?: RequestInit): Promise<T> {
    const { json } = await this.requestRaw(urlPath, init);
    return json as T;
  }

  get connected(): boolean {
    return this._connected;
  }

  // iLink preserves a Hub/sender-assigned message_id verbatim and echoes it back
  // as ref_msg.message_item.msg_id when the peer quotes the message (verified in
  // ilink-hub). Match the magnitude (~unix_millis * 1e6) confirmed to be
  // preserved by the live iLink service. JS Number loses some low bits at this
  // magnitude, but the rounding is deterministic, so the value we store locally
  // always equals the string iLink echoes back.
  private nextMessageId(): string {
    const counter = this.outboundMsgCounter++ % 1000000;
    return String(Date.now() * 1000000 + counter);
  }

  async login(): Promise<void> {
    // Guard against overlapping login flows: each invocation starts its own QR
    // polling loop, so repeated Login commands used to pile up multiple
    // parallel loops polling different QR codes (and none of them confirming).
    if (this.loggingIn) {
      log.warn('[WX Auth] overlapping login request ignored');
      this.emitStatus('正在登录中，请等待当前二维码确认或过期…');
      return;
    }
    this.loggingIn = true;
    log.info('[WX Auth] QR login started');

    // Re-login: stop any active polling so the old session can't keep sending
    // with a stale token while the QR flow runs (previously this produced a
    // misleading "logged in but still on the old session" state).
    try {
      this.stopPolling();
      this._connected = false;
      this.emitStatus('Generating QR code...');

      while (true) {
        log.debug('[WX Auth] requesting QR code');
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

        log.info('[WX Auth] QR code expired; requesting replacement');
        this.emitStatus('QR code expired, generating new one...');
      }

      this._connected = true;
      // Clear per-session metadata — the new session's peer ids / context_token
      // only become known after the first inbound message. Chat history (the
      // messages table) and the polling cursor are intentionally preserved.
      await this.db.setMetadata('from_user_id', '');
      await this.db.setMetadata('to_user_id', '');
      await this.db.setMetadata('context_token', '');
      await this.db.setMetadata(CONTEXT_TOKEN_STALE_FLAG, '');
      await this.db.setMetadata('last_inbound_ts', '');
      await this.context.secrets.store('vschat_token', this.botToken);
      await this.saveCredentialsToFile();
      log.info('[WX Auth] login completed', { host: log.describeUrl(this.botBaseUrl) });
      this.emitStatus('Login successful — 请先让对方发一条消息刷新会话');
      this._onLoginSuccess.fire();
    } finally {
      this.loggingIn = false;
      log.debug('[WX Auth] QR login flow finished', { connected: this._connected });
    }
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
      log.debug('[WX Auth] fallback credential file saved', { directory: this.context.globalStorageUri.fsPath });
    } catch (err: any) {
      log.error('[WX Auth] failed to save fallback credential file', log.formatError(err));
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
    } catch (err) {
      log.debug('[WX Auth] fallback credential file unavailable', log.formatError(err));
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
      log.error('[WX Auth] QR generation failed', log.formatError(err));
      return null;
    }
  }

  private async pollQrStatus(qrcode: string): Promise<boolean> {
    let lastStatus = '';
    for (let i = 0; i < 60; i++) {
      await this.sleep(2000);
      try {
        const status = await this.request<QRCodeStatusResponse>(
          `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
        );
        // Log state transitions (not every poll) so the login flow is debuggable
        if (status.status !== lastStatus) {
          lastStatus = status.status;
          log.info('[WX Auth] QR status changed', {
            status: status.status,
            tokenPresent: Boolean(status.bot_token),
            baseUrlPresent: Boolean(status.baseurl),
          });
          if (status.status === 'scaned') {
            this.emitStatus('已扫码 — 请在手机上确认登录');
          } else if (status.status === 'need_verifycode') {
            this.emitStatus('需要验证码 — 请在手机上完成验证');
          }
        }
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
        log.warn('[WX Auth] QR status poll failed', { attempt: i + 1 }, log.formatError(err));
        this.emitStatus(`QR polling error: ${err.message}`);
      }
    }
    return false;
  }

  async restoreLogin(): Promise<boolean> {
    // Try SecretStorage first
    const secretToken = await this.context.secrets.get('vschat_token');
    if (secretToken) {
      this.botToken = secretToken;
      this._connected = true;
      this.emitStatus('Restored previous session');
      log.info('[WX Auth] session restored from SecretStorage');
      return true;
    }

    // Fall back to file-based credentials
    const fileCreds = await this.loadCredentialsFromFile();
    if (fileCreds) {
      this.botToken = fileCreds.token;
      this.botBaseUrl = fileCreds.baseUrl;
      this._connected = true;
      this.emitStatus('Restored previous session (file)');
      log.info('[WX Auth] session restored from fallback credential file', {
        host: log.describeUrl(this.botBaseUrl),
      });
      return true;
    }

    log.info('[WX Auth] no saved session found');
    return false;
  }

  async startPolling(): Promise<void> {
    if (this.polling) {
      log.debug('[WX Poll] start ignored; polling already active');
      return;
    }
    this.polling = true;
    this.pollingAbort = new AbortController();
    this.reconnectDelay = 1000;
    log.info('[WX Poll] polling started');
    this.pollLoop().catch((err) => {
      log.error('[WX Poll] polling loop stopped unexpectedly', log.formatError(err));
      this.emitStatus(`Polling error: ${err.message}`);
    });
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const cursor = await this.db.getMetadata('last_cursor') || '';
        log.debug('[WX Poll] requesting updates', { cursorLength: cursor.length });
        const raw = await this.requestRaw('/ilink/bot/getupdates', {
          method: 'POST',
          body: JSON.stringify({
            get_updates_buf: cursor,
            base_info: { channel_version: '1.0.2' },
          }),
          signal: this.pollingAbort?.signal,
        });
        const res = raw.json as GetUpdatesResponse;
        const messageCount = res.msgs?.length ?? 0;
        log.debug('[WX Poll] updates received', {
          messageCount,
          cursorLength: res.get_updates_buf?.length ?? 0,
          ret: res.ret,
        });
        if (messageCount > 0) {
          log.info('[WX Poll] inbound batch received', { messageCount });
        }

        if (res.msgs && res.msgs.length > 0) {
          // Re-attach exact message_id strings (in order) before processing
          const exactIds = extractExactMessageIds(raw.text);
          res.msgs.forEach((msg, i) => {
            if (exactIds[i]) msg._exactMessageId = exactIds[i];
          });
          await this.processMessages(res.msgs);
        }

        if (res.get_updates_buf) {
          await this.db.setMetadata('last_cursor', res.get_updates_buf);
        }

        this.reconnectDelay = 1000;
      } catch (err: any) {
        if (err.name === 'AbortError') {
          log.debug('[WX Poll] request aborted during shutdown');
          break;
        }
        log.warn('[WX Poll] request failed; retry scheduled', {
          delayMs: this.reconnectDelay,
        }, log.formatError(err));
        this.emitStatus(`Connection lost, retrying in ${this.reconnectDelay / 1000}s...`);
        await this.sleep(this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
    }
  }

  private async processMessages(msgs: ILinkMessage[]): Promise<void> {
    for (const msg of msgs) {
      log.info('[WX Receive] message envelope', {
        messageId: msg._exactMessageId || msg.message_id,
        fromUserId: msg.from_user_id,
        toUserId: msg.to_user_id,
        messageType: msg.message_type,
        messageState: msg.message_state,
        itemCount: msg.item_list.length,
        hasContextToken: Boolean(msg.context_token),
      });
      for (const item of msg.item_list) {
        let content = item.text_item?.text || '';
        if (item.type === 2 && item.image_item) {
          content = item.image_item.media?.full_url || JSON.stringify(item);
        } else if (item.type === 3 && item.voice_item) {
          // 语音消息：优先用微信返回的转写文本，缺失时给个占位而不是整段 JSON
          content = item.voice_item.text || item.voice_item.transcription || '[语音消息]';
        } else if (!content) {
          content = JSON.stringify(item);
        }

        // Own message id: the peer-side id is the envelope's message_id (i64,
        // recovered exactly from raw JSON). item.msg_id ("v1:<digits>") is an
        // iLink-internal id and must NOT be used for quote-replies.
        const itemAny = item as any;
        const rawOwnMessageId: string =
          msg._exactMessageId ||
          item.msg_id ||
          itemAny.message_id?.toString() ||
          itemAny.extra?.msg_id ||
          msg.message_id?.toString() ||
          '';
        const ownMessageId: string = rawOwnMessageId.replace(/^v1:/, '');
        log.debug('[WX Receive] processing item', {
          messageId: ownMessageId,
          itemType: item.type,
          contentLength: item.text_item?.text?.length || item.voice_item?.text?.length || 0,
          hasImage: Boolean(item.image_item),
          hasVoice: Boolean(item.voice_item),
          hasFile: Boolean(item.file_item),
          hasVideo: Boolean(item.video_item),
          hasReference: Boolean(itemAny.extra?.ref_msg ?? itemAny.ref_msg),
        });

        // Quoted message: iLink nests it under item.extra.ref_msg (some clients flatten to item.ref_msg)
        const refAny = itemAny.extra?.ref_msg ?? itemAny.ref_msg;
        let replyToJson: string | null = null;
        if (refAny) {
          const refItem = refAny.message_item ?? {};
          // iLink usually omits text_item in quote-replies; fall back to the
          // title summary, then to the locally-stored message content
          let refText = refItem.text_item?.text ?? '';
          if (!refText && typeof refAny.title === 'string') {
            refText = refAny.title;
          }
          const refMsgId = refItem.msg_id ?? '';
          let refType = refItem.type ?? 0;
          if (!refText && refMsgId) {
            const local = await this.db.findByMessageId(String(refMsgId));
            if (local) {
              refText = local.type === 1 ? local.content : '';
              refType = refItem.type ?? local.type;
            }
          }
          // Some quote-replies carry neither text nor a locally-matching id; fall
          // back to the quoted message timestamp (same ±window trick as ilink-hub)
          if (!refText && refItem.create_time_ms) {
            const localTs = await this.db.findByTimestamp(Math.floor(refItem.create_time_ms / 1000));
            if (localTs) {
              refText = localTs.type === 1 ? localTs.content : '';
              refType = refItem.type ?? localTs.type;
            }
          }
          replyToJson = JSON.stringify({
            messageId: refMsgId,
            type: refType,
            text: refText,
            timestamp: refItem.create_time_ms ? Math.floor(refItem.create_time_ms / 1000) : undefined,
          });
        }

        const chatMsg: Omit<ChatMessage, 'id'> = {
          direction: 'received',
          type: item.type as MsgTypeValue,
          content,
          timestamp: Math.floor(Date.now() / 1000),
          context_token: msg.context_token,
          from_user_id: msg.from_user_id,
          to_user_id: msg.to_user_id,
          message_id: ownMessageId || undefined,
          reply_to: replyToJson,
        };

        await this.db.setMetadata('from_user_id', msg.from_user_id);
        await this.db.setMetadata('to_user_id', msg.to_user_id);
        // Track the freshest inbound session token + timestamp so outbound
        // messages use a valid context token instead of the polling cursor
        // (the cursor goes stale when no messages arrive for a long time,
        // and iLink rejects sends with it — ret != 0, silently ignored before)
        if (msg.context_token) {
          await this.db.setMetadata('context_token', msg.context_token);
          // A fresh inbound session token is available again: re-enable the
          // normal (non-tokenless) send path after a stale-session recovery.
          await this.db.setMetadata(CONTEXT_TOKEN_STALE_FLAG, '');
        }
        await this.db.setMetadata('last_inbound_ts', String(Math.floor(Date.now() / 1000)));

        // For images, fetch and decrypt before firing so webview has the data
        let imageDataUrl: string | undefined;
        if (item.type === 2 && item.image_item) {
          log.info('[WX Media] downloading inbound image', {
            messageId: ownMessageId,
            host: log.describeUrl(item.image_item.media?.full_url),
          });
          imageDataUrl = await this.fetchImageAsDataUrl(item.image_item.media.full_url, item.image_item.media.aes_key);
          log.info('[WX Media] inbound image processed', {
            messageId: ownMessageId,
            success: Boolean(imageDataUrl),
            dataUrlBytes: imageDataUrl ? Buffer.byteLength(imageDataUrl) : 0,
          });
        }

        const id = await this.db.insertMessage(chatMsg);
        log.debug('[WX Receive] message persisted', { dbId: id, messageId: ownMessageId, type: item.type });

        if (imageDataUrl) {
          await this.persistImage(id, imageDataUrl);
        }

        this._onMessage.fire({ ...chatMsg, id, imageDataUrl } as ChatMessage & { imageDataUrl?: string });
      }
    }
  }

  private async fetchImageAsDataUrl(cdnUrl: string, aesKeyBase64: string): Promise<string | undefined> {
    const operationId = log.nextId('wx-media');
    const startedAt = Date.now();
    try {
      // media.aes_key is base64 of a 32-char hex string
      // Decode: base64 → hex string → 16 raw bytes (matching official openclaw-weixin)
      const hexStr = Buffer.from(aesKeyBase64, 'base64').toString('ascii');
      const key = Buffer.from(hexStr, 'hex');
      const agent = this.getProxyAgent();
      log.debug('[WX Media] encrypted download request', {
        operationId,
        host: log.describeUrl(cdnUrl),
        keyBytes: key.length,
        proxy: Boolean(agent),
      });
      const resp = await fetch(cdnUrl, { dispatcher: agent } as RequestInit);
      if (!resp.ok) {
        log.error('[WX Media] encrypted download rejected', {
          operationId,
          status: resp.status,
          durationMs: Date.now() - startedAt,
        });
        return undefined;
      }
      const encrypted = Buffer.from(await resp.arrayBuffer());
      const decrypted = decryptAesEcb(encrypted, key);
      log.info('[WX Media] image decrypted', {
        operationId,
        status: resp.status,
        encryptedBytes: encrypted.length,
        decryptedBytes: decrypted.length,
        durationMs: Date.now() - startedAt,
      });
      return `data:image/png;base64,${decrypted.toString('base64')}`;
    } catch (err: any) {
      log.error('[WX Media] image download/decrypt failed', {
        operationId,
        durationMs: Date.now() - startedAt,
      }, log.formatError(err));
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
      log.debug('[WX Media] image persisted', { dbId: messageId, bytes: Buffer.byteLength(dataUrl) });
    } catch (err: any) {
      log.error('[WX Media] failed to persist image', { dbId: messageId }, log.formatError(err));
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
    log.info('[WX Poll] stopping polling', { active: this.polling, connected: this._connected });
    this.polling = false;
    this.pollingAbort?.abort();
  }

  async sendText(text: string, replyTo?: ReplyTo): Promise<string | undefined> {
    if (!this._connected) throw new Error('Not connected');
    log.info('[WX Send] text requested', {
      contentLength: text.length,
      hasReference: Boolean(replyTo?.messageId),
      referenceId: replyTo?.messageId,
    });
    const result = await this.sendWithRecovery(
      (opts) => this.sendTextOnce(text, replyTo, opts.tokenless),
      'message'
    );
    return result.warning;
  }

  // Single outbound send attempt. Classification / bounded retry / tokenless
  // recovery is handled by sendWithRecovery; on ret != 0 the message is NOT
  // inserted locally, so a rejected message never looks delivered.
  private async sendTextOnce(
    text: string,
    replyTo: ReplyTo | undefined,
    tokenless: boolean,
  ): Promise<SendAttemptResult> {
    const fromId = await this.db.getMetadata('from_user_id') || '';
    const toId = await this.db.getMetadata('to_user_id') || '';
    const contextToken = tokenless ? '' : await this.readContextToken();

    if (!fromId || !toId) {
      throw new Error('No conversation partner — wait for an incoming message first');
    }

    // Warn (but do not block) when the session may be stale: no inbound message
    // for over 24h means the context token is likely expired and iLink may
    // reject the send (observed: a token went bad ~1h37m after the last inbound
    // message; new inbound messages refresh it). The ret check below still
    // surfaces actual rejections.
    const lastInboundTs = Number(await this.db.getMetadata('last_inbound_ts') || 0);
    const staleSecs = Math.floor(Date.now() / 1000) - lastInboundTs;
    let warning: string | undefined;
    if (lastInboundTs > 0 && staleSecs > 86400) {
      warning = `会话可能已过期（距上次收到消息约 ${Math.floor(staleSecs / 3600)} 小时），对方可能收不到。发送已继续，建议先让对方发一条消息刷新会话。`;
      log.warn('[WX Send] session may be stale', { messageType: 'text', inboundAgeSeconds: staleSecs });
    }

    const msgId = this.nextMessageId();
    const item: any = { type: 1, text_item: { text } };
    if (replyTo?.messageId) {
      const refMsgId = replyTo.messageId.replace(/^v1:/, '');
      const refItem: any = {
        type: replyTo.type ?? MsgType.Text,
        msg_id: refMsgId,
        is_completed: true,
      };
      if (replyTo.text) refItem.text_item = { text: replyTo.text };
      if (replyTo.timestamp) refItem.create_time_ms = Math.round(replyTo.timestamp * 1000);
      const refMsg: any = {
        message_item: refItem,
        title: replyTo.text || '',
      };
      // Per official iLink TS types. Note: as of iLink/WeChat current behavior,
      // outbound quote-replies are delivered without a visible quote on the
      // WeChat client (server accepts the message but ignores/strips ref_msg).
      item.ref_msg = refMsg;
    }

    const payload = {
      msg: {
        to_user_id: fromId,
        from_user_id: toId,
        client_id: `vschat-${crypto.randomUUID()}`,
        message_id: Number(msgId),
        message_type: 2,
        message_state: 2,
        // tokenless recovery (stale session): omit context_token entirely so
        // the rejected stale value isn't echoed back to iLink
        ...(tokenless ? {} : { context_token: contextToken }),
        item_list: [item],
      },
      base_info: { channel_version: '2.4.3' },
    };

    const startedAt = Date.now();
    log.debug('[WX Send] sending text attempt', {
      messageId: msgId,
      toUserId: fromId,
      fromUserId: toId,
      contentLength: text.length,
      tokenless,
      hasContextToken: Boolean(contextToken),
      hasReference: Boolean(replyTo?.messageId),
    });
    const resp = await this.request<SendMessageResponse>('/ilink/bot/sendmessage', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    log.info('[WX Send] text response', {
      messageId: msgId,
      responseMessageId: resp?.message_id,
      ret: resp?.ret,
      errcode: resp?.errcode,
      errmsg: resp?.errmsg,
      durationMs: Date.now() - startedAt,
    });
    // iLink omits `ret` on success (observed: {"message_id":...}); only an
    // explicit ret != 0 is a business error. HTTP 200 with an unparseable body
    // (resp undefined) is treated as failure — never insert a message we can't
    // confirm was accepted.
    if (!resp || (typeof resp.ret === 'number' && resp.ret !== 0)) {
      return { resp, warning, tokenUsed: contextToken };
    }
    // Normal successful deliveries always echo message_id. ret:0 without it is
    // a "silent drop" — the API accepted the request but did not deliver.
    if (resp.message_id === undefined) {
      const notDelivered =
        `文本消息可能未送达：iLink 返回 ${JSON.stringify(resp)} 但无 message_id，通常表示接口接受后未真正投递。` +
        `请让对方确认是否收到；若持续如此，可能是 bot 账号被平台风控，建议重新扫码登录并降低发送频率。`;
      log.warn('[WX Send] text accepted without message_id; delivery is unconfirmed', {
        messageId: msgId,
        ret: resp.ret,
        errcode: resp.errcode,
      });
      warning = warning ? `${warning}\n${notDelivered}` : notDelivered;
    }

    const chatMsg: Omit<ChatMessage, 'id'> = {
      direction: 'sent',
      type: MsgType.Text,
      content: text,
      timestamp: Math.floor(Date.now() / 1000),
      context_token: contextToken,
      from_user_id: toId,
      to_user_id: fromId,
      message_id: msgId,
      reply_to: replyTo
        ? JSON.stringify({
            messageId: replyTo.messageId.replace(/^v1:/, ''),
            type: replyTo.type ?? MsgType.Text,
            text: replyTo.text ?? '',
            timestamp: replyTo.timestamp,
          })
        : null,
    };

    const id = await this.db.insertMessage(chatMsg);
    log.debug('[WX Send] text persisted', { dbId: id, messageId: msgId });
    this._onMessage.fire({ ...chatMsg, id });
    return { resp, warning, tokenUsed: contextToken };
  }

  async sendImage(imagePath: string): Promise<string | undefined> {
    if (!this._connected) throw new Error('Not connected');
    const stat = await fs.promises.stat(imagePath);
    log.info('[WX Send] image requested', {
      bytes: stat.size,
      extension: path.extname(imagePath).toLowerCase(),
    });
    const result = await this.sendWithRecovery(
      (opts) => this.sendImageOnce(imagePath, opts.tokenless),
      'image'
    );
    return result.warning;
  }

  private async sendImageOnce(imagePath: string, tokenless: boolean): Promise<SendAttemptResult> {
    const fromId = await this.db.getMetadata('from_user_id') || '';
    const toId = await this.db.getMetadata('to_user_id') || '';
    const contextToken = tokenless ? '' : await this.readContextToken();

    if (!fromId || !toId) {
      throw new Error('No conversation partner — wait for an incoming message first');
    }

    const lastInboundTs = Number(await this.db.getMetadata('last_inbound_ts') || 0);
    const staleSecs = Math.floor(Date.now() / 1000) - lastInboundTs;
    let warning: string | undefined;
    if (lastInboundTs > 0 && staleSecs > 86400) {
      warning = `会话可能已过期（距上次收到消息约 ${Math.floor(staleSecs / 3600)} 小时），对方可能收不到。发送已继续，建议先让对方发一条消息刷新会话。`;
      log.warn('[WX Send] session may be stale', { messageType: 'image', inboundAgeSeconds: staleSecs });
    }

    // Generate random AES key and file metadata
    const aesKey = crypto.randomBytes(16);
    const fileData = await fs.promises.readFile(imagePath);
    const fileMd5 = crypto.createHash('md5').update(fileData).digest('hex');
    const filekey = crypto.randomBytes(16).toString('hex');
    const filesize = aesEcbPaddedSize(fileData.length);
    const operationId = log.nextId('wx-upload');
    const uploadStartedAt = Date.now();
    log.info('[WX Media] requesting upload URL', {
      operationId,
      rawBytes: fileData.length,
      encryptedBytes: filesize,
      toUserId: fromId,
      tokenless,
    });

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
        filesize: filesize,
        aeskey: aesKey.toString('hex'),
        no_need_thumb: true,
      }),
    });

    const uploadUrl = uploadUrlRes.upload_full_url || uploadUrlRes.upload_url || uploadUrlRes.upload_param;
    if (!uploadUrl) {
      throw new Error('Failed to get upload URL: ' + JSON.stringify(uploadUrlRes));
    }

    // Encrypt with AES-128-ECB before uploading (matching official openclaw-weixin)
    const ciphertext = this.aesEncrypt(fileData, aesKey);
    const agent = this.getProxyAgent();
    log.info('[WX Media] CDN upload started', {
      operationId,
      host: log.describeUrl(uploadUrl),
      bytes: ciphertext.length,
      proxy: Boolean(agent),
    });
    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      body: ciphertext,
      headers: { 'Content-Type': 'application/octet-stream' },
      dispatcher: agent,
    } as RequestInit);
    if (!uploadResp.ok) {
      const body = await uploadResp.text().catch(() => '');
      log.error('[WX Media] CDN upload rejected', {
        operationId,
        status: uploadResp.status,
        durationMs: Date.now() - uploadStartedAt,
        responseLength: body.length,
      });
      throw new Error(`Upload failed: ${uploadResp.status} - ${body}`);
    }

    // Get download encrypted param from CDN response (official pattern)
    const downloadEncryptedParam = uploadResp.headers.get('x-encrypted-param')
      || uploadUrlRes.upload_param
      || '';
    // aes_key: base64-encode the hex string (matching official openclaw-weixin)
    const mediaAesKey = Buffer.from(aesKey.toString('hex')).toString('base64');

    log.info('[WX Media] CDN upload completed', {
      operationId,
      status: uploadResp.status,
      encryptedParamLength: downloadEncryptedParam.length,
      durationMs: Date.now() - uploadStartedAt,
    });

    // Send message with image reference (matching official openclaw-weixin format)
    const msgId = this.nextMessageId();
    const payload = {
      msg: {
        to_user_id: fromId,
        from_user_id: toId,
        client_id: `vschat-${crypto.randomUUID()}`,
        message_id: Number(msgId),
        message_type: 2,
        message_state: 2,
        // tokenless recovery (stale session): omit context_token entirely
        ...(tokenless ? {} : { context_token: contextToken }),
        item_list: [
          {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: downloadEncryptedParam,
                aes_key: mediaAesKey,
                encrypt_type: 1,
              },
              mid_size: filesize,
            },
          },
        ],
      },
      base_info: { channel_version: '2.4.3' },
    };

    const resp = await this.request<SendMessageResponse>('/ilink/bot/sendmessage', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    log.info('[WX Send] image response', {
      operationId,
      messageId: msgId,
      responseMessageId: resp?.message_id,
      ret: resp?.ret,
      errcode: resp?.errcode,
      errmsg: resp?.errmsg,
    });
    // iLink omits `ret` on success; only an explicit ret != 0 is an error.
    if (!resp || (typeof resp.ret === 'number' && resp.ret !== 0)) {
      return { resp, warning, tokenUsed: contextToken };
    }
    // Normal successful deliveries always echo message_id. ret:0 without it is
    // a "silent drop" — the API accepted the request but did not deliver.
    if (resp.message_id === undefined) {
      const notDelivered =
        `图片消息可能未送达：iLink 返回 ${JSON.stringify(resp)} 但无 message_id，通常表示接口接受后未真正投递。` +
        `请让对方确认是否收到；若持续如此，可能是 bot 账号被平台风控，建议重新扫码登录并降低发送频率。`;
      log.warn('[WX Send] image accepted without message_id; delivery is unconfirmed', {
        operationId,
        messageId: msgId,
        ret: resp.ret,
        errcode: resp.errcode,
      });
      warning = warning ? `${warning}\n${notDelivered}` : notDelivered;
    }

    const chatMsg: Omit<ChatMessage, 'id'> = {
      direction: 'sent',
      type: MsgType.Image,
      content: '[Image]',
      timestamp: Math.floor(Date.now() / 1000),
      context_token: contextToken,
      from_user_id: toId,
      to_user_id: fromId,
      message_id: msgId,
    };

    const id = await this.db.insertMessage(chatMsg);
    log.debug('[WX Send] image persisted', { dbId: id, messageId: msgId, operationId });
    this._onMessage.fire({ ...chatMsg, id });
    return { resp, warning, tokenUsed: contextToken };
  }

  // Bounded send loop shared by text/image sends:
  //  - stale context_token → clear it, one tokenless recovery send;
  //  - genuine rate limit → back off 1s/3s/9s and retry (max 4 attempts);
  //  - anything else / exhausted retries → throw a classified error.
  private async sendWithRecovery(
    attempt: (opts: { tokenless: boolean }) => Promise<SendAttemptResult>,
    label: string,
  ): Promise<SendAttemptResult> {
    let tokenless = false;
    let last: SendAttemptResult | undefined;

    for (let i = 0; i < MAX_RATE_LIMIT_ATTEMPTS; i++) {
      log.debug('[WX Send] attempt started', { label, attempt: i + 1, tokenless });
      const result = await attempt({ tokenless });
      last = result;
      const kind = this.classifySendFailure(result.resp);
      log.debug('[WX Send] attempt classified', {
        label,
        attempt: i + 1,
        result: kind || 'accepted',
        ret: result.resp?.ret,
        errcode: result.resp?.errcode,
      });
      if (kind === null) return result; // confirmed accepted

      if (kind === 'stale-session' && !tokenless) {
        // iLink rejected the cached context_token (ret=-2 "prepare failed" /
        // "unknown error", or errcode=-14). Drop it and retry once without a
        // token — the session itself may still be alive (hermes-agent #80426).
        tokenless = true;
        await this.invalidateStaleContextToken(result.tokenUsed || '');
        log.warn('[WX Send] stale context token; retrying without token', { label, attempt: i + 1 });
        continue;
      }

      if (kind === 'rate-limit' && i < MAX_RATE_LIMIT_ATTEMPTS - 1) {
        const delay = RATE_LIMIT_BACKOFF_MS[i] ?? RATE_LIMIT_BACKOFF_MS[RATE_LIMIT_BACKOFF_MS.length - 1];
        log.warn('[WX Send] rate limited; retry scheduled', {
          label,
          attempt: i + 1,
          nextAttempt: i + 2,
          delayMs: delay,
        });
        await this.sleep(delay);
        continue;
      }

      // Retries exhausted, or a non-recoverable error.
      throw this.buildSendError(kind, label, result.resp);
    }

    throw this.buildSendError('other', label, last?.resp);
  }

  // iLink sendmessage business-error classification. Note the intentional
  // ordering: "rate limited" / "freq limit" are genuine throttling (issue
  // #21011); "prepare failed" / "unknown error" / empty errmsg with ret=-2,
  // and errcode=-14 are stale context_token signals (#80426, #74572).
  private classifySendFailure(resp: SendMessageResponse | undefined): SendFailureKind | null {
    if (!resp) return 'other'; // HTTP 200 with unparseable body — unconfirmed delivery
    // iLink omits `ret` on success (observed: {"message_id":...})
    if (resp.ret === undefined || resp.ret === 0) return null;

    const errmsg = String(resp.errmsg || '').toLowerCase();
    const errcode = resp.errcode;

    if (errmsg.includes('freq limit') || errmsg.includes('rate limit')) return 'rate-limit';
    if (errcode === -14 || resp.ret === -14) return 'stale-session';
    if (resp.ret === -2 || errcode === -2) {
      if (!errmsg || errmsg.includes('prepare failed') || errmsg.includes('unknown error')) {
        return 'stale-session';
      }
    }
    return 'other';
  }

  // Reads the freshest context_token, falling back to the legacy polling
  // cursor unless a stale-session recovery marked the cached token invalid.
  private async readContextToken(): Promise<string> {
    const fresh = await this.db.getMetadata('context_token');
    if (fresh) return fresh;
    // After a stale-session recovery the cached token is invalid; don't fall
    // back to the polling cursor until a new inbound message refreshes it.
    if (await this.db.getMetadata(CONTEXT_TOKEN_STALE_FLAG)) return '';
    return (await this.db.getMetadata('last_cursor')) || '';
  }

  // Compare-and-delete the failed context_token so a concurrently refreshed
  // token (new inbound message) is preserved, and mark the cached token invalid
  // so the legacy last_cursor fallback isn't reused until refresh.
  private async invalidateStaleContextToken(failedToken: string): Promise<void> {
    const stored = await this.db.getMetadata('context_token');
    const cleared = !!stored && stored === failedToken;
    if (cleared) {
      await this.db.setMetadata('context_token', '');
    }
    if (cleared || !stored) {
      await this.db.setMetadata(CONTEXT_TOKEN_STALE_FLAG, '1');
    }
  }

  private buildSendError(kind: SendFailureKind, label: string, resp: SendMessageResponse | undefined): Error {
    const detail = resp
      ? `ret=${resp.ret} errcode=${resp.errcode ?? 'none'} errmsg="${resp.errmsg || ''}"`
      : 'no response body';
    switch (kind) {
      case 'stale-session':
        return new Error(
          `WeChat 会话已过期（${detail}）：已丢弃缓存的 context_token 并尝试不带 token 重发，仍被拒绝。` +
          `请让对方先发一条消息刷新会话后再试。`
        );
      case 'rate-limit':
        return new Error(
          `WeChat 限流（${detail}）：已退避重试 ${MAX_RATE_LIMIT_ATTEMPTS - 1} 次仍被拒绝。` +
          `建议等待约 60 秒后重发；若会话已很久没有互动，也可能同时是 token 过期，可让对方先发一条消息。`
        );
      default:
        return new Error(
          `WeChat rejected ${label}: ${detail}. If this is a session/token error, ask the contact to send a message first.`
        );
    }
  }

  // iLink protocol requires AES-128-ECB for media encryption
  private aesEncrypt(data: Buffer, key: Buffer): Buffer {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private safeRequestPath(value: string): string {
    return value.replace(/([?&]qrcode=)[^&]+/gi, '$1[REDACTED]');
  }

  private emitQrCode(data: string): void {
    this._onQrCode.fire(data);
  }

  private emitStatus(text: string): void {
    log.debug('[WX Status]', text);
    this._onStatus.fire(text);
  }

  async logout(): Promise<void> {
    log.info('[WX Auth] logout requested; clearing session credentials');
    this.stopPolling();
    this._connected = false;
    this.botToken = '';
    this.botBaseUrl = BASE_URL;
    await this.context.secrets.delete('vschat_token');
    try {
      const filePath = path.join(this.context.globalStorageUri.fsPath, 'credentials.json');
      await fs.promises.unlink(filePath);
    } catch (err) {
      log.debug('[WX Auth] fallback credential file was already absent', log.formatError(err));
    }
  }

  dispose(): void {
    log.debug('[WX] disposing client');
    this.stopPolling();
    this._onMessage.dispose();
    this._onStatus.dispose();
    this._onQrCode.dispose();
    this._onLoginSuccess.dispose();
  }
}
