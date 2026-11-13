import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fetch, RequestInit, ProxyAgent } from 'undici';
import QRCode from 'qrcode';
import { ChatDB } from './chat-db';
import { RecipientState, SendTarget, recipientId } from './recipient-types';
import { persistImageCache } from './image-cache';
import { DEFAULT_WX_BASE_URL, WX_ENDPOINT_SECRET, trustedWxBaseUrl, saveWxEndpoint, restoreWxEndpoint } from './wx-credentials';
import {
  MAX_FILE_BYTES,
  FileSendError,
  sanitizeFileName,
  isSafeFileDownloadUrl,
  getFileDownloadSpec,
  downloadFileBytes,
  downloadImageBytes,
} from './file-transfer';
import * as log from './logger';
import {
  ChatMessage,
  ChatMessagePart,
  MsgType,
  ReplyTo,
  ConnectionHealth,
} from './types';
import {
  ILinkMessage,
  QRCodeResponse,
  QRCodeStatusResponse,
  GetUpdatesResponse,
  SendMessageResponse,
  GetUploadUrlResponse,
  WxMsgItem,
} from './wx-types';

function imageCacheKey(messageId: number, partIndex?: number): string {
  if (!Number.isSafeInteger(messageId) || messageId < 1
      || (partIndex !== undefined && (!Number.isSafeInteger(partIndex) || partIndex < 0))) {
    throw new Error('Invalid image cache identifier');
  }
  return partIndex === undefined ? String(messageId) : `${messageId}.part-${partIndex}`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function inboundFileSize(file: WxMsgItem['file_item']): number | undefined {
  if (typeof file?.len === 'string' && /^\d+$/.test(file.len)) {
    const size = Number(file.len);
    if (Number.isSafeInteger(size) && size >= 0) return size;
  }
  return typeof file?.file_size === 'number' && Number.isSafeInteger(file.file_size) && file.file_size >= 0
    ? file.file_size : undefined;
}

function messagePart(item: WxMsgItem): ChatMessagePart {
  const text = optionalString(item.text_item?.text);
  switch (item.type) {
    case MsgType.Text: return { type: item.type, text: text || '' };
    // Encrypted remote images are hydrated only by the guarded host downloader.
    // Never let a webview fall back to loading a URL whose download was rejected.
    case MsgType.Image: return { type: item.type, text };
    case MsgType.Voice: return {
      type: item.type,
      text: [text, optionalString(item.voice_item?.text) || optionalString(item.voice_item?.transcription)].filter(Boolean).join('\n') || undefined,
      url: optionalString(item.voice_item?.media?.full_url),
    };
    case MsgType.File: return {
      type: item.type, text,
      fileName: optionalString(item.file_item?.file_name),
      size: inboundFileSize(item.file_item),
      mimeType: optionalString(item.file_item?.mime_type),
      url: optionalString(item.file_item?.media?.full_url) || optionalString(item.file_item?.cdn_url),
      fileMedia: optionalString(item.file_item?.media?.aes_key) ? {
        aesKey: item.file_item!.media!.aes_key!,
        encryptQueryParam: optionalString(item.file_item?.media?.encrypt_query_param),
        md5: optionalString(item.file_item?.md5),
      } : undefined,
    };
    case MsgType.Video: return {
      type: item.type, text,
      fileName: optionalString(item.video_item?.file_name),
      size: item.video_item?.file_size,
      mimeType: optionalString(item.video_item?.mime_type),
      url: optionalString(item.video_item?.cdn_url) || optionalString(item.video_item?.media?.full_url),
    };
    default: return { type: MsgType.Text, text: text || '[不支持的消息]' };
  }
}

function partSummary(part: ChatMessagePart): string {
  if (part.type === MsgType.Text) return part.text || '';
  const label = { 2: '图片', 3: '语音消息', 4: '文件', 5: '视频' }[part.type];
  return [part.text, `[${label}${part.fileName ? `：${part.fileName}` : ''}]`].filter(Boolean).join(' ');
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

const BASE_URL = DEFAULT_WX_BASE_URL;

function randomUin(): string {
  const buf = crypto.randomBytes(4);
  return buf.toString('base64');
}

// Retry only explicit business rejections, always using the same recipient.
// Official iLink -14 denotes an expired login credential, not a context token.
const MAX_RATE_LIMIT_ATTEMPTS = 4;
const RATE_LIMIT_BACKOFF_MS = [1000, 3000, 9000];
const CONTEXT_TOKEN_STALE_FLAG = 'context_token_stale';

// iLink sendmessage business-error classification:
//  - 'rate-limit':    genuine throttling
//  - 'stale-session': expired context_token (recoverable by dropping the token)
//  - 'other':         anything else (or unparseable response)
type SendFailureKind = 'rate-limit' | 'stale-session' | 'login-expired' | 'other';

interface FrozenSendTarget extends SendTarget {
  baseUrl: string;
  legacy?: boolean;
}

interface SendAttemptResult {
  resp: SendMessageResponse | undefined;
  warning?: string;
  tokenUsed?: string;
}

export class WxClient extends vscode.Disposable {
  readonly channelName = 'WeChat';
  readonly fileCapabilities = Object.freeze({ canSend: true, maxBytes: MAX_FILE_BYTES });
  private botToken: string = '';
  private botBaseUrl: string = BASE_URL;
  private polling: boolean = false;
  private pollingAbort: AbortController | null = null;
  private pollTask: Promise<void> | undefined;
  private reconnectDelay: number = 1000;
  private maxReconnectDelay: number = 30000;
  private _connected: boolean = false;
  private outboundMsgCounter: number = 0;
  private loggingIn: boolean = false;
  private _connectionHealth: ConnectionHealth = Object.freeze({ state: 'offline', detail: '微信未连接。' });

  private _onConnectionHealth = new vscode.EventEmitter<ConnectionHealth>();
  readonly onConnectionHealth = this._onConnectionHealth.event;

  get connectionHealth(): ConnectionHealth {
    return this._connectionHealth;
  }

  private setConnectionHealth(health: ConnectionHealth): void {
    this._connectionHealth = Object.freeze({ ...health });
    this._onConnectionHealth.fire(this._connectionHealth);
  }

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

  private sessionKey(): string {
    // Only this digest is persisted with routes; login credentials never leave
    // the transport. The same credential can safely restore its routes.
    return crypto.createHash('sha256').update(this.botToken).digest('hex');
  }

  async getRecipients(): Promise<RecipientState> {
    if (!this._connected || !this.botToken) {
      return { recipients: [], reason: '微信尚未连接，请先登录。' };
    }
    const sessionKey = this.sessionKey();
    const routes = await this.db.getWxRoutes(sessionKey);
    if (!this._connected || sessionKey !== this.sessionKey()) {
      return { recipients: [], reason: '微信登录已变化，请刷新收件人。' };
    }
    const accounts = [...new Set(routes.map(route => route.accountId))];
    if (accounts.length !== 1) {
      return { recipients: [], reason: '请先让联系人向当前微信账号发送消息，以确认收件人。' };
    }
    const accountId = accounts[0];
    const conversations = await this.db.listConversations(accountId);
    if (!this._connected || sessionKey !== this.sessionKey()) {
      return { recipients: [], reason: '微信登录已变化，请刷新收件人。' };
    }
    // Historical/imported conversations are visible, but cannot establish a
    // live route. Only inbound traffic for this credential can do that.
    const peers = new Map(conversations.map(item => [item.conversation.peerId, item.unreadCount]));
    for (const route of routes) if (!peers.has(route.peerId)) peers.set(route.peerId, 0);
    return {
      accountId,
      recipients: [...peers].map(([peerId, unreadCount]) => {
        const conversation = { accountId, peerId };
        const canSend = routes.some(route => route.peerId === peerId && Boolean(route.contextToken));
        return {
          id: recipientId(conversation), label: peerId, conversation, canSend, unreadCount,
          ...(!canSend ? { reason: '请让该联系人先发送一条消息刷新当前登录会话。' } : {}),
        };
      }),
    };
  }

  async captureSendTarget(id: string): Promise<SendTarget> {
    if (!this._connected || !this.botToken) throw new Error('微信尚未连接，请先登录。');
    const sessionKey = this.sessionKey();
    const routes = await this.db.getWxRoutes(sessionKey);
    if (!this._connected || sessionKey !== this.sessionKey()) throw new Error('微信登录已变化，请重新选择收件人。');
    if (new Set(routes.map(route => route.accountId)).size !== 1) throw new Error('尚未确认当前微信账号，请先接收一条消息。');
    const route = routes.find(candidate => recipientId(candidate) === id && candidate.contextToken);
    if (!route) throw new Error('此收件人尚无可用会话，请让对方先发送一条消息。');
    return Object.freeze({
      channel: 'wechat', accountId: route.accountId, peerId: route.peerId,
      contextToken: route.contextToken, lastInboundTimestamp: route.timestamp, sessionKey,
    });
  }

  private assertSendSession(target: FrozenSendTarget): void {
    if (!this._connected || target.sessionKey !== this.sessionKey() || target.baseUrl !== this.botBaseUrl) {
      throw new Error('微信登录已变化，已停止发送；请重新选择收件人。');
    }
  }

  private async freezeSendTarget(target?: SendTarget): Promise<FrozenSendTarget> {
    if (!this._connected) throw new Error('Not connected');
    const sessionKey = this.sessionKey();
    const baseUrl = this.botBaseUrl;
    let captured: FrozenSendTarget;
    if (target) {
      // Copy before awaiting: callers cannot mutate an in-flight destination.
      captured = { ...target, baseUrl };
      if (captured.channel !== 'wechat' || captured.sessionKey !== sessionKey
          || !captured.accountId || !captured.peerId || !captured.contextToken) {
        throw new Error('微信收件人会话无效，请重新选择收件人。');
      }
      const routes = await this.db.getWxRoutes(sessionKey);
      if (!routes.some(route => route.accountId === captured.accountId && route.peerId === captured.peerId && route.contextToken)) {
        throw new Error('此收件人会话已失效，请让对方先发送一条消息。');
      }
    } else {
      // Compatibility for direct transport callers. Production provider sends
      // always supply a captured target; never consult these globals on retry.
      const [peerId, accountId, contextToken, timestamp] = await Promise.all([
        this.db.getMetadata('from_user_id'), this.db.getMetadata('to_user_id'),
        this.db.getMetadata('context_token'), this.db.getMetadata('last_inbound_ts'),
      ]);
      if (!peerId || !accountId) throw new Error('No conversation partner — wait for an incoming message first');
      captured = { channel: 'wechat', accountId, peerId, contextToken: contextToken || '',
        lastInboundTimestamp: Number(timestamp || 0), sessionKey, baseUrl, legacy: true };
    }
    this.assertSendSession(captured);
    return Object.freeze(captured);
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
      // API redirects must never forward message bodies to an unverified endpoint.
      redirect: 'error',
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
      throw Object.assign(new Error(`HTTP ${response.status}: ${response.statusText}`), { status: response.status });
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
      this.setConnectionHealth({ state: 'connecting', detail: '正在等待微信扫码登录。' });
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
      await saveWxEndpoint(this.context.secrets, this.botToken, this.botBaseUrl);
      await this.context.secrets.store('vschat_token', this.botToken);
      await this.saveCredentialsToFile();
      log.info('[WX Auth] login completed', { host: log.describeUrl(this.botBaseUrl) });
      this.setConnectionHealth({ state: 'connecting', detail: '微信已登录，等待首次轮询响应。' });
      this.emitStatus('Login successful — 请先让对方发一条消息刷新会话');
      this._onLoginSuccess.fire();
    } catch (error) {
      this.setConnectionHealth({ state: 'error', detail: '微信登录失败，请重新扫码登录。' });
      throw error;
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
      if (typeof data.token === 'string' && data.token.trim()) {
        return { token: data.token, baseUrl: trustedWxBaseUrl(data.baseUrl) || BASE_URL };
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
          if (typeof status.bot_token !== 'string' || !status.bot_token.trim()) {
            throw new Error('登录确认未返回凭据，请继续等待手机确认。');
          }
          const baseUrl = status.baseurl === undefined || status.baseurl === ''
            ? BASE_URL : trustedWxBaseUrl(status.baseurl);
          if (!baseUrl) throw new Error('登录确认返回的服务地址无效，请重新扫码。');
          this.botToken = status.bot_token;
          this.botBaseUrl = baseUrl;
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
      const fileCreds = await this.loadCredentialsFromFile();
      this.botBaseUrl = await restoreWxEndpoint(this.context.secrets, secretToken, fileCreds);
      this.botToken = secretToken;
      this._connected = true;
      this.setConnectionHealth({ state: 'connecting', detail: '已恢复微信凭据，等待轮询响应。' });
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
      this.setConnectionHealth({ state: 'connecting', detail: '已恢复微信凭据，等待轮询响应。' });
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
    if (!this._connected) {
      this.setConnectionHealth({ state: 'offline', detail: '微信尚未登录，请先登录。' });
      return;
    }
    this.polling = true;
    const controller = new AbortController();
    this.pollingAbort = controller;
    const sessionKey = this.sessionKey();
    this.reconnectDelay = 1000;
    this.setConnectionHealth({ state: 'connecting', detail: '正在连接微信消息服务。' });
    log.info('[WX Poll] polling started');
    // A stopped loop may still be completing a DB write. Join it before the
    // replacement reads a cursor, so two loops cannot process/commit in parallel.
    const previous = this.pollTask;
    this.pollTask = (async () => {
      await previous?.catch(err => log.error('[WX Poll] previous loop failed during handover', log.formatError(err)));
      if (!this.isCurrentPoll(controller, sessionKey)) return;
      try {
        await this.pollLoop(controller, sessionKey);
      } catch (err) {
        if (!this.isCurrentPoll(controller, sessionKey)) return;
        log.error('[WX Poll] polling loop stopped unexpectedly', log.formatError(err));
        this.setConnectionHealth({ state: 'error', detail: '微信消息接收已停止，请重新连接。' });
      } finally {
        if (this.pollingAbort === controller) {
          this.polling = false;
          if (sessionKey === this.sessionKey() && this.connectionHealth.state !== 'error') {
            this.setConnectionHealth({ state: 'offline', detail: '微信消息接收已停止。', lastAckAt: this.connectionHealth.lastAckAt });
          }
        }
      }
    })();
  }

  private isCurrentPoll(controller: AbortController | null, sessionKey: string): boolean {
    return Boolean(controller && this.polling && this.pollingAbort === controller
      && !controller.signal.aborted && this._connected && sessionKey === this.sessionKey());
  }

  private async pollLoop(controller = this.pollingAbort, sessionKey = this.sessionKey()): Promise<void> {
    if (!controller) return;
    // The old global cursor has no verifiable credential ownership. On first
    // upgrade, start empty and deduplicate replays rather than skip another
    // account's unseen messages. Later restarts resume this credential's cursor.
    const cursorKey = `wx_poll_cursor:${sessionKey}`;
    while (this.isCurrentPoll(controller, sessionKey)) {
      try {
        const cursor = await this.db.getMetadata(cursorKey) || '';
        if (!this.isCurrentPoll(controller, sessionKey)) break;
        log.debug('[WX Poll] requesting updates', { cursorLength: cursor.length });
        const raw = await this.requestRaw('/ilink/bot/getupdates', {
          method: 'POST',
          body: JSON.stringify({
            get_updates_buf: cursor,
            base_info: { channel_version: '1.0.2' },
          }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
        });
        if (!this.isCurrentPoll(controller, sessionKey)) break;
        const res = raw.json as GetUpdatesResponse & { errcode?: number };
        if (!res || typeof res !== 'object' || Array.isArray(res)) throw new Error('Invalid WeChat poll response');
        if (res.ret === -14 || res.errcode === -14) {
          this.expireLogin({ sessionKey });
          break;
        }
        if ((res.ret !== undefined && res.ret !== 0) || (res.errcode !== undefined && res.errcode !== 0)) {
          throw new Error('WeChat rejected polling request');
        }
        if ((res.msgs !== undefined && !Array.isArray(res.msgs))
            || (res.get_updates_buf !== undefined && typeof res.get_updates_buf !== 'string')) {
          throw new Error('Invalid WeChat polling batch');
        }
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
          await this.processMessages(res.msgs, sessionKey, controller.signal);
        }

        if (!this.isCurrentPoll(controller, sessionKey)) break;
        if (res.get_updates_buf) {
          await this.db.setMetadata(cursorKey, res.get_updates_buf);
        }
        if (!this.isCurrentPoll(controller, sessionKey)) break;
        this.reconnectDelay = 1000;
        this.setConnectionHealth({ state: 'online', detail: '微信轮询正常。', lastAckAt: Date.now() });
      } catch (err: any) {
        // AbortError can also be a transient request failure. Only our own
        // cancellation/session change ends the loop; timeouts keep retrying.
        if (!this.isCurrentPoll(controller, sessionKey)) {
          log.debug('[WX Poll] request aborted during shutdown');
          break;
        }
        if (err?.status === 401) {
          this.expireLogin({ sessionKey });
          break;
        }
        log.warn('[WX Poll] request failed; retry scheduled', {
          delayMs: this.reconnectDelay,
        }, log.formatError(err));
        this.setConnectionHealth({
          state: 'reconnecting', detail: '微信连接或消息保存暂时失败，正在恢复；未确认的批次将重试。',
          lastAckAt: this.connectionHealth.lastAckAt, retryAt: Date.now() + this.reconnectDelay,
        });
        this.emitStatus(`Connection lost, retrying in ${this.reconnectDelay / 1000}s...`);
        await this.sleep(this.reconnectDelay, controller.signal);
        if (!this.isCurrentPoll(controller, sessionKey)) break;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
    }
  }

  private async processMessages(msgs: ILinkMessage[], sessionKey = this.sessionKey(), signal?: AbortSignal): Promise<void> {
    const ensureActive = () => {
      if (sessionKey !== this.sessionKey() || signal?.aborted) {
        const error = new Error('WeChat batch processing cancelled');
        error.name = 'AbortError';
        throw error;
      }
    };
    for (const msg of msgs) {
      ensureActive();
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('Invalid WeChat message envelope');
      const conversation = { accountId: msg.to_user_id, peerId: msg.from_user_id };
      const items = Array.isArray(msg.item_list)
        ? msg.item_list.filter(item => item && typeof item === 'object' && !Array.isArray(item))
        : [];
      log.info('[WX Receive] message envelope', {
        messageId: msg._exactMessageId || msg.message_id,
        fromUserId: msg.from_user_id,
        toUserId: msg.to_user_id,
        messageType: msg.message_type,
        messageState: msg.message_state,
        itemCount: items.length,
        hasContextToken: Boolean(msg.context_token),
      });
      if (!items.length) continue;
      const parts = items.map(messagePart);
      const firstItem = items[0];
      // The peer quotes the envelope ID, not an item's internal v1 ID. Keep the
      // exact i64 recovered from the wire and use item IDs only as a last resort.
      const ownMessageId = String(msg._exactMessageId || msg.message_id || firstItem.msg_id
        || firstItem.message_id || firstItem.extra?.msg_id || '').replace(/^v1:/, '');
      let replyToJson: string | null = null;
      for (const item of items) {
        const reference = item.extra?.ref_msg ?? item.ref_msg;
        if (!reference) continue;
        const refItem = reference.message_item;
        let refText = optionalString(refItem?.text_item?.text) || optionalString(reference.title) || '';
        const refMsgId = String(refItem?.msg_id || '');
        let refType: number = refItem?.type || 0;
        if (!refText && refMsgId) {
          const local = await this.db.findByMessageId(refMsgId, conversation);
          if (local) {
            refText = local.type === MsgType.Text ? local.content : '';
            refType = refItem?.type ?? local.type;
          }
        }
        if (!refText && refItem?.create_time_ms) {
          const local = await this.db.findByTimestamp(Math.floor(refItem.create_time_ms / 1000), 2, conversation);
          if (local) {
            refText = local.type === MsgType.Text ? local.content : '';
            refType = refItem?.type ?? local.type;
          }
        }
        replyToJson = JSON.stringify({
          messageId: refMsgId,
          type: refType,
          text: refText,
          timestamp: refItem?.create_time_ms ? Math.floor(refItem.create_time_ms / 1000) : undefined,
        });
        break;
      }

      const onlyPart = parts.length === 1 ? parts[0] : undefined;
      const content = onlyPart
        ? onlyPart.type === MsgType.Image ? onlyPart.url || '[图片]'
          : onlyPart.type === MsgType.Voice ? onlyPart.text || '[语音消息]'
            : onlyPart.type === MsgType.Text ? onlyPart.text || '' : partSummary(onlyPart)
        : parts.map(partSummary).join('\n');
      const chatMsg: Omit<ChatMessage, 'id'> = {
        direction: 'received',
        type: onlyPart?.type || MsgType.Text,
        content,
        parts,
        timestamp: Math.floor(Date.now() / 1000),
        context_token: msg.context_token,
        from_user_id: msg.from_user_id,
        to_user_id: msg.to_user_id,
        message_id: ownMessageId || undefined,
        reply_to: replyToJson,
      };

      // Store the entire envelope and routing atomically before downloading.
      // A failed or slow media download must not lose text or other attachments.
      ensureActive();
      const { id, inserted } = await this.db.storeWxInbound(chatMsg, sessionKey);
      ensureActive();
      if (!inserted) {
        log.debug('[WX Receive] duplicate envelope already persisted', { dbId: id, messageId: ownMessageId });
        continue;
      }
      log.debug('[WX Receive] message persisted', { dbId: id, messageId: ownMessageId, partCount: parts.length });
      for (let index = 0; index < items.length; index++) {
        ensureActive();
        const item = items[index];
        const imageUrl = optionalString(item.image_item?.media?.full_url);
        if (item.type !== MsgType.Image || !imageUrl || !item.image_item?.media) continue;
        try {
          log.info('[WX Media] downloading inbound image', {
            messageId: ownMessageId, partIndex: index,
            host: log.describeUrl(imageUrl),
          });
          const imageDataUrl = await this.fetchImageAsDataUrl(imageUrl, optionalString(item.image_item.media.aes_key) || '', signal);
          ensureActive();
          if (imageDataUrl) {
            parts[index].imageDataUrl = imageDataUrl;
            await this.persistImage(id, imageDataUrl, index);
          }
          log.info('[WX Media] inbound image processed', {
            messageId: ownMessageId, partIndex: index, success: Boolean(imageDataUrl),
          });
        } catch (err) {
          log.error('[WX Media] failed inbound image part', {
            messageId: ownMessageId, partIndex: index,
          }, log.formatError(err));
        }
      }
      ensureActive();
      const imageDataUrl = onlyPart?.type === MsgType.Image ? onlyPart.imageDataUrl : undefined;
      this._onMessage.fire({ ...chatMsg, id, imageDataUrl } as ChatMessage & { imageDataUrl?: string });
    }
  }

  private async fetchImageAsDataUrl(cdnUrl: string, aesKeyBase64: string, signal?: AbortSignal): Promise<string | undefined> {
    const operationId = log.nextId('wx-media');
    const startedAt = Date.now();
    try {
      const agent = this.getProxyAgent();
      log.debug('[WX Media] encrypted download request', {
        operationId,
        host: log.describeUrl(cdnUrl),
        proxy: Boolean(agent),
      });
      const decrypted = await downloadImageBytes({ url: cdnUrl, aesKey: aesKeyBase64 }, { dispatcher: agent, signal });
      log.info('[WX Media] image decrypted', {
        operationId,
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
  private async persistImage(messageId: number, dataUrl: string, partIndex?: number): Promise<void> {
    try {
      await persistImageCache(this.context.globalStorageUri.fsPath, 'wechat', messageId, dataUrl, partIndex);
      // Release the media lock before taking the DB lock (DB -> media order).
      await this.db.markMessageMediaReady(messageId);
      log.debug('[WX Media] image persisted', { dbId: messageId, bytes: Buffer.byteLength(dataUrl) });
    } catch (err: any) {
      log.error('[WX Media] failed to persist image', { dbId: messageId }, log.formatError(err));
    }
  }

  // Load a persisted image data URL from disk
  async getDecryptedImageUrl(messageId: number, partIndex?: number): Promise<string | undefined> {
    try {
      const imgPath = path.join(this.context.globalStorageUri.fsPath, 'images', `${imageCacheKey(messageId, partIndex)}.png.url.json`);
      const raw = await fs.promises.readFile(imgPath, 'utf-8');
      return JSON.parse(raw).dataUrl;
    } catch {
      return undefined;
    }
  }

  stopPolling(): void {
    log.info('[WX Poll] stopping polling', { active: this.polling, connected: this._connected });
    this.polling = false;
    const controller = this.pollingAbort;
    this.pollingAbort = null;
    controller?.abort();
    this.setConnectionHealth({ state: 'offline', detail: '微信消息接收已停止。', lastAckAt: this.connectionHealth.lastAckAt });
  }

  async sendText(text: string, replyTo?: ReplyTo, target?: SendTarget): Promise<string | undefined> {
    const reference = replyTo ? { ...replyTo } : undefined;
    const recipient = await this.freezeSendTarget(target);
    log.info('[WX Send] text requested', {
      contentLength: text.length,
      hasReference: Boolean(replyTo?.messageId),
      referenceId: replyTo?.messageId,
    });
    const result = await this.sendWithRecovery(
      (opts) => this.sendTextOnce(text, reference, opts.tokenless, recipient),
      'message', recipient
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
    target: FrozenSendTarget,
  ): Promise<SendAttemptResult> {
    this.assertSendSession(target);
    const fromId = target.peerId;
    const toId = target.accountId;
    const contextToken = tokenless ? '' : target.contextToken || '';

    // Warn (but do not block) when the session may be stale: no inbound message
    // for over 24h means the context token is likely expired and iLink may
    // reject the send (observed: a token went bad ~1h37m after the last inbound
    // message; new inbound messages refresh it). The ret check below still
    // surfaces actual rejections.
    const lastInboundTs = target.lastInboundTimestamp || 0;
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
    if (this.classifySendFailure(resp) !== null) {
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

  async downloadFile(part: ChatMessagePart, signal?: AbortSignal): Promise<Buffer> {
    const spec = getFileDownloadSpec(part, this.channelName);
    if (!spec) throw new Error('此文件缺少有效下载信息、解密密钥，或超过 20 MiB 限制。');
    return downloadFileBytes(spec, { dispatcher: this.getProxyAgent(), signal });
  }

  async sendFile(filePath: string, originalName?: string, target?: SendTarget): Promise<string | undefined> {
    // Upload failures are known not to have created a chat message. Once the
    // final request starts, never retry automatically or call it "not sent"
    // unless the platform explicitly rejects it.
    let prepared: Awaited<ReturnType<WxClient['prepareFileMessage']>>;
    let recipient: FrozenSendTarget;
    try {
      recipient = await this.freezeSendTarget(target);
      prepared = await this.prepareFileMessage(filePath, originalName, recipient);
      this.assertSendSession(recipient);
    } catch (error) {
      if (error instanceof FileSendError) throw error;
      log.warn('[WX File] preparation failed', { errorType: error instanceof Error ? error.name : 'unknown' });
      throw new FileSendError('文件上传准备失败，文件消息尚未发送，请重试。');
    }
    if (!this._connected) throw new FileSendError('微信已断开连接，文件消息尚未发送。');

    let response: SendMessageResponse;
    try {
      response = await this.request<SendMessageResponse>('/ilink/bot/sendmessage', {
        method: 'POST', body: JSON.stringify(prepared.payload), signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('文件发送结果尚未确认，请先确认对方是否收到，避免重复发送。');
    }
    if ((typeof response?.ret === 'number' && response.ret !== 0)
        || (typeof response?.errcode === 'number' && response.errcode !== 0)) {
      log.warn('[WX File] message rejected', { ret: response.ret, errcode: response.errcode });
      if (this.classifySendFailure(response) === 'login-expired') {
        this.expireLogin(recipient);
        throw new FileSendError('微信登录已过期，文件消息未发送，请重新扫码登录。');
      }
      throw new FileSendError('微信拒绝了文件消息，请稍后重试；如会话已过期，请让对方先发一条消息。');
    }
    const responseId = response?.message_id;
    const hasMessageId = (typeof responseId === 'string' && responseId.trim().length > 0)
      || (typeof responseId === 'number' && Number.isFinite(responseId) && responseId > 0);
    if (!hasMessageId) {
      log.warn('[WX File] delivery unconfirmed; response omitted message ID');
      return '文件发送结果尚未确认：微信未返回 message_id。请先确认对方是否收到，避免重复发送。';
    }
    try {
      const id = await this.db.insertMessage(prepared.message);
      this._onMessage.fire({ ...prepared.message, id });
      log.info('[WX File] message persisted', { dbId: id, bytes: prepared.message.parts?.[0]?.size });
    } catch {
      throw new Error('微信已接受文件消息，但本地记录保存失败；请先确认对方是否收到，避免重复发送。');
    }
    return undefined;
  }

  private async prepareFileMessage(filePath: string, originalName: string | undefined, target: FrozenSendTarget): Promise<{
    payload: Record<string, unknown>;
    message: Omit<ChatMessage, 'id'>;
  }> {
    if (!this._connected) throw new FileSendError('微信尚未连接，文件消息未发送。');
    let fileData: Buffer;
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw new FileSendError('请选择普通文件，不能发送文件夹。');
      if (stat.size === 0) throw new FileSendError('不支持发送空文件，请选择包含内容的文件。');
      if (stat.size > MAX_FILE_BYTES) throw new FileSendError('文件超过 20 MiB 应用发送限制。');
      fileData = await fs.promises.readFile(filePath);
      // Recheck actual bytes in case the file changed after stat/selection.
      if (fileData.length === 0) throw new FileSendError('不支持发送空文件，请选择包含内容的文件。');
      if (fileData.length > MAX_FILE_BYTES) throw new FileSendError('文件超过 20 MiB 应用发送限制。');
    } catch (error) {
      if (error instanceof FileSendError) throw error;
      throw new FileSendError('无法读取待发送文件，请重新选择文件。');
    }
    this.assertSendSession(target);
    const fromId = target.peerId;
    const toId = target.accountId;
    const contextToken = target.contextToken || '';
    const fileName = sanitizeFileName(originalName || path.basename(filePath));
    const aesKey = crypto.randomBytes(16);
    const filekey = crypto.randomBytes(16).toString('hex');
    const md5 = crypto.createHash('md5').update(fileData).digest('hex');
    let upload: GetUploadUrlResponse;
    try {
      upload = await this.request<GetUploadUrlResponse>('/ilink/bot/getuploadurl', {
        method: 'POST', signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          filekey, media_type: 3, to_user_id: fromId,
          rawsize: fileData.length, rawfilemd5: md5,
          filesize: aesEcbPaddedSize(fileData.length), aeskey: aesKey.toString('hex'),
          no_need_thumb: true, base_info: { channel_version: '2.4.3' },
        }),
      });
    } catch {
      throw new FileSendError('微信未能准备文件上传，文件消息尚未发送，请稍后重试。');
    }
    if ((typeof upload?.ret === 'number' && upload.ret !== 0)
        || (typeof upload?.errcode === 'number' && upload.errcode !== 0)) {
      if (this.classifySendFailure(upload) === 'login-expired') this.expireLogin(target);
      throw new FileSendError('微信拒绝了文件上传，文件消息尚未发送。');
    }
    const fullUrl = optionalString(upload?.upload_full_url)?.trim();
    const uploadParam = optionalString(upload?.upload_param);
    const uploadUrl = fullUrl || (uploadParam
      ? `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
      : undefined);
    if (!isSafeFileDownloadUrl(uploadUrl)) {
      throw new FileSendError('微信返回的文件上传地址无效，文件消息尚未发送。');
    }
    let downloadParam: string;
    try {
      this.assertSendSession(target);
      const ciphertext = this.aesEncrypt(fileData, aesKey);
      const response = await fetch(uploadUrl, {
        method: 'POST', body: ciphertext, headers: { 'Content-Type': 'application/octet-stream' },
        dispatcher: this.getProxyAgent(), redirect: 'error', signal: AbortSignal.timeout(30_000),
      } as RequestInit);
      try {
        const value = response.headers.get('x-encrypted-param')?.trim();
        if (response.status !== 200 || !value) {
          throw new FileSendError('微信文件上传未完成，文件消息尚未发送，请重试。');
        }
        // The CDN's response is the download reference; upload_param cannot
        // substitute for a missing x-encrypted-param header.
        downloadParam = value;
      } finally {
        await response.body?.cancel().catch(() => {});
      }
    } catch (error) {
      if (error instanceof FileSendError) throw error;
      throw new FileSendError('微信文件上传失败，文件消息尚未发送，请重试。');
    }
    const mediaAesKey = Buffer.from(aesKey.toString('hex')).toString('base64');
    const messageId = this.nextMessageId();
    const payload = {
      msg: {
        to_user_id: fromId, from_user_id: toId, client_id: `vschat-${crypto.randomUUID()}`,
        message_id: Number(messageId), message_type: 2, message_state: 2,
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: [{ type: MsgType.File, file_item: {
          file_name: fileName, len: String(fileData.length), md5,
          media: { encrypt_query_param: downloadParam, aes_key: mediaAesKey, encrypt_type: 1 },
        } }],
      },
      base_info: { channel_version: '2.4.3' },
    };
    const message: Omit<ChatMessage, 'id'> = {
      direction: 'sent', type: MsgType.File, content: `[文件：${fileName}]`,
      timestamp: Math.floor(Date.now() / 1000), context_token: contextToken,
      from_user_id: toId, to_user_id: fromId, message_id: messageId,
      parts: [{ type: MsgType.File, fileName, size: fileData.length,
        fileMedia: { aesKey: mediaAesKey, encryptQueryParam: downloadParam, md5 } }],
    };
    return { payload, message };
  }

  async sendImage(imagePath: string, target?: SendTarget): Promise<string | undefined> {
    const recipient = await this.freezeSendTarget(target);
    const stat = await fs.promises.stat(imagePath);
    log.info('[WX Send] image requested', {
      bytes: stat.size,
      extension: path.extname(imagePath).toLowerCase(),
    });
    const result = await this.sendWithRecovery(
      (opts) => this.sendImageOnce(imagePath, opts.tokenless, recipient),
      'image', recipient
    );
    return result.warning;
  }

  private async sendImageOnce(imagePath: string, tokenless: boolean, target: FrozenSendTarget): Promise<SendAttemptResult> {
    this.assertSendSession(target);
    const fromId = target.peerId;
    const toId = target.accountId;
    const contextToken = tokenless ? '' : target.contextToken || '';

    const lastInboundTs = target.lastInboundTimestamp || 0;
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
    this.assertSendSession(target);
    const uploadUrlRes = await this.request<{
      ret?: number;
      errcode?: number;
      errmsg?: string;
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

    if (this.classifySendFailure(uploadUrlRes) === 'login-expired') {
      this.expireLogin(target);
      throw this.buildSendError('login-expired', 'image', uploadUrlRes);
    }

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
    this.assertSendSession(target);
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

    this.assertSendSession(target);
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
    if (this.classifySendFailure(resp) !== null) {
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
    const extension = path.extname(imagePath).toLowerCase();
    const mimeType = extension === '.jpg' || extension === '.jpeg'
      ? 'image/jpeg'
      : extension === '.gif' ? 'image/gif'
      : extension === '.webp' ? 'image/webp'
      : extension === '.bmp' ? 'image/bmp'
      : 'image/png';
    const imageDataUrl = `data:${mimeType};base64,${fileData.toString('base64')}`;
    await this.persistImage(id, imageDataUrl);
    this._onMessage.fire({ ...chatMsg, id, imageDataUrl } as ChatMessage & { imageDataUrl?: string });
    return { resp, warning, tokenUsed: contextToken };
  }

  // Bounded send loop shared by text/image sends:
  //  - stale context_token → clear it, one tokenless recovery send;
  //  - genuine rate limit → back off 1s/3s/9s and retry (max 4 attempts);
  //  - anything else / exhausted retries → throw a classified error.
  private async sendWithRecovery(
    attempt: (opts: { tokenless: boolean }) => Promise<SendAttemptResult>,
    label: string,
    target: FrozenSendTarget,
  ): Promise<SendAttemptResult> {
    let tokenless = false;
    let last: SendAttemptResult | undefined;

    for (let i = 0; i < MAX_RATE_LIMIT_ATTEMPTS; i++) {
      this.assertSendSession(target);
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

      if (kind === 'login-expired') {
        this.expireLogin(target);
        throw this.buildSendError(kind, label, result.resp);
      }

      if (kind === 'stale-session' && !tokenless) {
        // A rejected conversation token can recover once for this same peer.
        // Never treat login credential expiry (-14) as tokenless recovery.
        tokenless = true;
        await this.db.invalidateWxRecipientToken(target.sessionKey!, target, result.tokenUsed || '');
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

  // Both ret and errcode can independently report a rejection.
  private classifySendFailure(resp: SendMessageResponse | undefined): SendFailureKind | null {
    if (!resp) return 'other'; // HTTP 200 with unparseable body — unconfirmed delivery
    if (resp.errcode === -14 || resp.ret === -14) return 'login-expired';
    if ((resp.ret === undefined || resp.ret === 0) && (resp.errcode === undefined || resp.errcode === 0)) return null;

    const errmsg = String(resp.errmsg || '').toLowerCase();
    const errcode = resp.errcode;

    if (errmsg.includes('freq limit') || errmsg.includes('rate limit')) return 'rate-limit';
    if (resp.ret === -2 || errcode === -2) {
      if (!errmsg || errmsg.includes('prepare failed') || errmsg.includes('unknown error')) {
        return 'stale-session';
      }
    }
    return 'other';
  }

  private expireLogin(target: Pick<SendTarget, 'sessionKey'>): void {
    // An old request must not disconnect a newly established login.
    if (target.sessionKey !== this.sessionKey()) return;
    this._connected = false;
    this.stopPolling();
    this.setConnectionHealth({ state: 'error', detail: '微信登录已过期，请重新扫码登录。', lastAckAt: this.connectionHealth.lastAckAt });
    this.emitStatus('微信登录已过期，请重新扫码登录。');
  }

  private buildSendError(kind: SendFailureKind, label: string, resp: SendMessageResponse | undefined): Error {
    const detail = resp
      ? `ret=${resp.ret} errcode=${resp.errcode ?? 'none'} errmsg="${resp.errmsg || ''}"`
      : 'no response body';
    switch (kind) {
      case 'login-expired':
        return new Error('微信登录已过期，请重新扫码登录。消息未被接受，未自动重发。');
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

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', finish, { once: true });
    });
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
    await this.context.secrets.delete(WX_ENDPOINT_SECRET);
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
    this._onConnectionHealth.dispose();
  }
}
