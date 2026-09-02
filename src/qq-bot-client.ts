import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { fetch, ProxyAgent, RequestInit, WebSocket } from 'undici';
import { ChatDB } from './chat-db';
import { ChatMessage, MsgType, MsgTypeValue, ReplyTo } from './types';
import * as log from './logger';

const API_BASE_URL = 'https://api.bot.qq.com';
const ACCESS_TOKEN_URL = `${API_BASE_URL}/app/getAppAccessToken`;
const GROUP_AND_C2C_EVENT = 1 << 25;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MD5_10M_BYTES = 10_002_432;
const C2C_PASSIVE_REPLY_WINDOW_SECONDS = 60 * 60;
const C2C_MAX_PASSIVE_REPLIES = 4;

export const QQ_APP_ID_SECRET = 'vschat_qq_app_id';
export const QQ_APP_SECRET_SECRET = 'vschat_qq_app_secret';

interface AccessTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  code?: number;
  message?: string;
}

interface GatewayResponse {
  url: string;
}

interface GatewayPayload {
  id?: string;
  op: number;
  d?: any;
  s?: number;
  t?: string;
}

interface QqAttachment {
  url?: string;
  filename?: string;
  content_type?: string;
  voice_wav_url?: string;
  asr_refer_text?: string;
}

interface QqC2CMessage {
  id: string;
  author?: { id?: string; user_openid?: string };
  content?: string;
  timestamp?: string;
  message_type?: number;
  message_scene?: { ext?: string[] };
  attachments?: QqAttachment[];
  msg_elements?: Array<{ content?: string; msg_idx?: string }>;
}

interface SendMessageResponse {
  id?: string;
  timestamp?: string;
  ext_info?: { ref_idx?: string };
  err_code?: number;
  message?: string;
  trace_id?: string;
}

interface UploadPrepareResponse {
  upload_id: string;
  block_size: string;
  parts: Array<{
    index?: number;
    part_index?: number;
    presigned_url?: string;
    upload_url?: string;
    block_size: string;
  }>;
}

interface MediaUploadResponse {
  file_info?: string;
  file_uuid?: string;
}

class QqBotError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'QqBotError';
  }
}

/** QQ Bot API v2 transport (C2C / single-user chat). */
export class QqBotClient extends vscode.Disposable {
  readonly channelName = 'QQ';

  private accessToken = '';
  private accessTokenExpiresAt = 0;
  private socket: InstanceType<typeof WebSocket> | null = null;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = 1_000;
  private shouldRun = false;
  private connecting = false;
  private _connected = false;
  private sequence: number | null = null;
  private sessionId = '';

  private _onMessage = new vscode.EventEmitter<ChatMessage>();
  readonly onMessage = this._onMessage.event;

  private _onStatus = new vscode.EventEmitter<string>();
  readonly onStatus = this._onStatus.event;

  // QQ uses AppID/AppSecret rather than QR login.  Keeping this event in the
  // common client contract lets the existing webview remain transport-neutral.
  private _onQrCode = new vscode.EventEmitter<string>();
  readonly onQrCode = this._onQrCode.event;

  private _onLoginSuccess = new vscode.EventEmitter<void>();
  readonly onLoginSuccess = this._onLoginSuccess.event;

  private cachedProxyUrl = '';
  private cachedProxyAgent: ProxyAgent | undefined;

  constructor(
    private context: vscode.ExtensionContext,
    private db: ChatDB
  ) {
    super(() => this.dispose());
  }

  get connected(): boolean {
    return this._connected;
  }

  async login(): Promise<void> {
    log.info('[QQ Auth] login requested');
    this.emitStatus('正在使用 QQ Bot 凭据连接…');
    const credentials = await this.getCredentials();
    log.debug('[QQ Auth] credentials available', { appId: credentials.appId });
    await this.getAccessToken(true);
  }

  async restoreLogin(): Promise<boolean> {
    const credentials = await this.readCredentials();
    if (!credentials) {
      log.info('[QQ Auth] no stored credentials; restore skipped');
      return false;
    }
    log.info('[QQ Auth] stored credentials found', { appId: credentials.appId });
    this.emitStatus('已找到 QQ Bot 凭据，正在恢复连接…');
    return true;
  }

  async startPolling(): Promise<void> {
    if (this.shouldRun) {
      log.debug('[QQ Gateway] start ignored; client already running');
      return;
    }
    this.shouldRun = true;
    this.reconnectDelay = 1_000;
    log.info('[QQ Gateway] starting connection loop');
    await this.connectGateway();
  }

  stopPolling(): void {
    log.info('[QQ Gateway] stopping connection', {
      connected: this._connected,
      socketState: this.socket?.readyState,
      sequence: this.sequence,
    });
    this.shouldRun = false;
    this._connected = false;
    this.clearHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, 'client disconnect');
    }
  }

  private async connectGateway(): Promise<void> {
    if (!this.shouldRun || this.connecting) {
      log.debug('[QQ Gateway] connect skipped', { shouldRun: this.shouldRun, connecting: this.connecting });
      return;
    }
    this.connecting = true;
    const operationId = log.nextId('qq-gw');
    const startedAt = Date.now();
    log.info('[QQ Gateway] resolving gateway', { operationId, resumeAvailable: Boolean(this.sessionId) });

    try {
      const gateway = await this.requestApi<GatewayResponse>('/gateway');
      if (!gateway.url) throw new Error('QQ Gateway 未返回 WebSocket 地址');

      this.emitStatus('正在连接 QQ Gateway…');
      const agent = this.getProxyAgent();
      log.info('[QQ Gateway] opening WebSocket', {
        operationId,
        host: log.describeUrl(gateway.url),
        proxy: Boolean(agent),
      });
      const socket = new WebSocket(gateway.url, {
        ...(agent ? { dispatcher: agent } : {}),
        headers: { 'User-Agent': 'VsChat/0.9.0' },
      });
      this.socket = socket;

      socket.addEventListener('message', (event) => {
        void this.handleGatewayMessage(event.data).catch((err: Error) => {
          log.error('[QQ Gateway] message processing failed', { operationId }, log.formatError(err));
          this.emitStatus(`QQ 消息处理失败：${err.message}`);
        });
      });

      socket.addEventListener('error', (event: any) => {
        log.error('[QQ Gateway] socket error', { operationId, message: event?.message || 'unknown error' });
      });

      socket.addEventListener('close', (event: any) => {
        if (this.socket === socket) this.socket = null;
        this.clearHeartbeat();
        this._connected = false;
        this.handleGatewayClose(Number(event.code || 0), String(event.reason || ''));
      });
    } catch (err: any) {
      log.error('[QQ Gateway] connection attempt failed', {
        operationId,
        durationMs: Date.now() - startedAt,
        retryable: !(err instanceof QqBotError) || err.retryable,
      }, log.formatError(err));
      this.emitStatus(`QQ 连接失败：${err.message}`);
      if (err instanceof QqBotError && !err.retryable) {
        this.shouldRun = false;
        return;
      }
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private async handleGatewayMessage(raw: unknown): Promise<void> {
    const text = typeof raw === 'string'
      ? raw
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw).toString('utf8')
        : String(raw);
    const payload = JSON.parse(text) as GatewayPayload;
    log.debug('[QQ Gateway] payload received', {
      op: payload.op,
      event: payload.t,
      sequence: payload.s,
      bytes: Buffer.byteLength(text),
    });
    if (typeof payload.s === 'number') {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case 0:
        await this.handleDispatch(payload);
        break;
      case 1:
        log.debug('[QQ Gateway] server requested heartbeat', { sequence: this.sequence });
        this.sendGateway({ op: 1, d: this.sequence });
        break;
      case 7:
        log.warn('[QQ Gateway] reconnect requested by server', { sequence: this.sequence });
        this.emitStatus('QQ Gateway 要求重新连接…');
        this.socket?.close(4009, 'server requested reconnect');
        break;
      case 9:
        log.warn('[QQ Gateway] invalid session', { resumable: Boolean(payload.d), sequence: this.sequence });
        if (!payload.d) await this.clearSession();
        this.emitStatus(payload.d
          ? 'QQ Gateway 会话暂时失效，正在恢复…'
          : 'QQ Gateway 会话失效，正在重新鉴权…');
        this.socket?.close(payload.d ? 4009 : 4006, 'invalid session');
        break;
      case 10:
        await this.handleHello(payload.d?.heartbeat_interval);
        break;
      case 11:
        log.debug('[QQ Gateway] heartbeat acknowledged', { sequence: this.sequence });
        break;
      default:
        log.debug('[QQ Gateway] unhandled opcode', { op: payload.op });
    }

    // Persist the resume cursor only after the event was processed successfully;
    // otherwise a crash during processing could permanently skip that event.
    if (typeof payload.s === 'number') {
      await this.db.setMetadata('qq_gateway_seq', String(payload.s));
    }
  }

  private async handleHello(intervalValue: unknown): Promise<void> {
    const interval = Number(intervalValue);
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new Error('QQ Gateway 返回了无效心跳周期');
    }

    this.clearHeartbeat();
    log.info('[QQ Gateway] hello received', {
      heartbeatIntervalMs: interval,
      scheduledIntervalMs: Math.floor(interval * 0.8),
    });
    this.heartbeatTimer = setInterval(() => {
      log.debug('[QQ Gateway] heartbeat sent', { sequence: this.sequence });
      this.sendGateway({ op: 1, d: this.sequence });
    }, Math.floor(interval * 0.8));

    const token = `QQBot ${await this.getAccessToken()}`;
    this.sessionId = (await this.db.getMetadata('qq_gateway_session_id')) || '';
    const storedSeq = Number(await this.db.getMetadata('qq_gateway_seq'));
    if (this.sessionId && Number.isFinite(storedSeq)) {
      log.info('[QQ Gateway] resuming session', { sessionId: this.sessionId, sequence: storedSeq });
      this.sequence = storedSeq;
      this.sendGateway({
        op: 6,
        d: { token, session_id: this.sessionId, seq: storedSeq },
      });
    } else {
      log.info('[QQ Gateway] identifying new session', { intents: GROUP_AND_C2C_EVENT, shard: '0/1' });
      this.sendGateway({
        op: 2,
        d: {
          token,
          intents: GROUP_AND_C2C_EVENT,
          shard: [0, 1],
          properties: {
            '$os': process.platform,
            '$browser': 'vschat',
            '$device': 'vscode',
          },
        },
      });
    }
  }

  private async handleDispatch(payload: GatewayPayload): Promise<void> {
    if (payload.t === 'READY') {
      this.sessionId = String(payload.d?.session_id || '');
      if (this.sessionId) {
        await this.db.setMetadata('qq_gateway_session_id', this.sessionId);
      }
      this.reconnectDelay = 1_000;
      this._connected = true;
      log.info('[QQ Gateway] ready', { sessionId: this.sessionId, sequence: this.sequence });
      this.emitStatus('QQ Bot 已连接');
      this._onLoginSuccess.fire();
      return;
    }

    if (payload.t === 'RESUMED') {
      this.reconnectDelay = 1_000;
      this._connected = true;
      log.info('[QQ Gateway] session resumed', { sessionId: this.sessionId, sequence: this.sequence });
      this.emitStatus('QQ Bot 连接已恢复');
      this._onLoginSuccess.fire();
      return;
    }

    if (payload.t === 'C2C_MESSAGE_CREATE') {
      await this.processC2CMessage(payload.d as QqC2CMessage);
    }
  }

  private async processC2CMessage(message: QqC2CMessage): Promise<void> {
    if (!message?.id) {
      log.warn('[QQ Receive] ignored event without message ID');
      return;
    }
    if (await this.db.findByMessageId(message.id)) {
      log.info('[QQ Receive] duplicate message skipped', { messageId: message.id });
      return;
    }

    const openId = message.author?.user_openid || message.author?.id || '';
    if (!openId) {
      log.warn('[QQ Receive] message skipped; user_openid missing', { messageId: message.id });
      return;
    }

    const attachment = message.attachments?.[0];
    const contentType = attachment?.content_type || '';
    let type: MsgTypeValue = MsgType.Text;
    let content = message.content || '';
    let imageDataUrl: string | undefined;
    log.info('[QQ Receive] C2C message', {
      messageId: message.id,
      openId,
      messageType: message.message_type,
      contentLength: message.content?.length || 0,
      attachmentCount: message.attachments?.length || 0,
      attachmentType: contentType || undefined,
      hasQuote: Boolean(message.message_scene?.ext?.some((value) => value.startsWith('ref_msg_idx='))),
      timestamp: message.timestamp,
    });

    if (attachment && contentType.startsWith('image/')) {
      type = MsgType.Image;
      content = attachment.url || '[图片]';
      imageDataUrl = attachment.url;
    } else if (attachment && (contentType === 'voice' || attachment.voice_wav_url)) {
      type = MsgType.Voice;
      content = attachment.asr_refer_text || '[语音消息]';
    } else if (attachment) {
      type = MsgType.File;
      content = attachment.url || attachment.filename || '[文件]';
    } else if (!content) {
      content = message.message_type === 3 ? '[卡片消息]' : '[QQ 消息]';
    }

    const ext = message.message_scene?.ext || [];
    const referenceId = this.extValue(ext, 'msg_idx');
    const quotedReferenceId = this.extValue(ext, 'ref_msg_idx');
    const quotedText = message.msg_elements?.[0]?.content || '';
    const replyTo = quotedReferenceId || quotedText
      ? JSON.stringify({
          messageId: quotedReferenceId || '',
          referenceId: quotedReferenceId || '',
          type: MsgType.Text,
          text: quotedText,
        })
      : null;

    const timestamp = message.timestamp ? Date.parse(message.timestamp) : NaN;
    const chatMessage: Omit<ChatMessage, 'id'> = {
      direction: 'received',
      type,
      content,
      timestamp: Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : Math.floor(Date.now() / 1000),
      context_token: '',
      from_user_id: openId,
      to_user_id: await this.getAppId(),
      message_id: message.id,
      reference_id: referenceId || undefined,
      reply_to: replyTo,
    };

    await this.db.setMetadata('qq_user_openid', openId);
    await this.db.setMetadata('qq_last_inbound_message_id', message.id);
    await this.db.setMetadata('qq_last_inbound_timestamp', String(chatMessage.timestamp));
    const id = await this.db.insertMessage(chatMessage);
    log.debug('[QQ Receive] message persisted', { dbId: id, messageId: message.id, type });
    this._onMessage.fire({ ...chatMessage, id, imageDataUrl } as ChatMessage & { imageDataUrl?: string });
  }

  async sendText(text: string, replyTo?: ReplyTo): Promise<string | undefined> {
    if (!this._connected) throw new Error('QQ Bot 尚未连接');
    const openId = await this.getTargetOpenId();
    const body: Record<string, unknown> = { content: text, msg_type: 0 };
    const operationId = log.nextId('qq-send');
    const startedAt = Date.now();

    const replyAgeSeconds = replyTo?.timestamp
      ? Math.floor(Date.now() / 1000) - replyTo.timestamp
      : Number.POSITIVE_INFINITY;
    if (replyTo?.messageId && replyTo.direction === 'received' && replyAgeSeconds <= C2C_PASSIVE_REPLY_WINDOW_SECONDS) {
      // A quoted inbound QQ message can simultaneously be a passive reply.
      body.msg_id = replyTo.messageId;
      const sequence = await this.nextReplySequence(replyTo.messageId);
      if (sequence) body.msg_seq = sequence;
      else delete body.msg_id;
    } else {
      await this.applyRecentPassiveReply(openId, body);
    }
    if (replyTo?.referenceId) {
      body.message_reference = { message_id: replyTo.referenceId };
    }

    log.info('[QQ Send] sending text', {
      operationId,
      openId,
      contentLength: text.length,
      mode: body.msg_id ? 'passive' : 'proactive',
      replySequence: body.msg_seq,
      hasReference: Boolean(body.message_reference),
    });
    const response = await this.sendMessage(openId, body);
    log.info('[QQ Send] text accepted', {
      operationId,
      durationMs: Date.now() - startedAt,
      messageId: response.id,
      referenceId: response.ext_info?.ref_idx,
    });
    const appId = await this.getAppId();
    const chatMessage: Omit<ChatMessage, 'id'> = {
      direction: 'sent',
      type: MsgType.Text,
      content: text,
      timestamp: this.responseTimestamp(response.timestamp),
      context_token: '',
      from_user_id: appId,
      to_user_id: openId,
      message_id: response.id,
      reference_id: response.ext_info?.ref_idx,
      reply_to: replyTo ? JSON.stringify(replyTo) : null,
    };
    const id = await this.db.insertMessage(chatMessage);
    this._onMessage.fire({ ...chatMessage, id });
    return undefined;
  }

  async sendImage(imagePath: string): Promise<string | undefined> {
    if (!this._connected) throw new Error('QQ Bot 尚未连接');
    const openId = await this.getTargetOpenId();
    const file = await fs.promises.readFile(imagePath);
    const fileName = path.basename(imagePath);
    const userPath = `/v2/users/${encodeURIComponent(openId)}`;
    const operationId = log.nextId('qq-media');
    const startedAt = Date.now();
    log.info('[QQ Media] image upload started', {
      operationId,
      openId,
      bytes: file.length,
      extension: path.extname(fileName).toLowerCase(),
    });

    const prepared = await this.requestApi<UploadPrepareResponse>(`${userPath}/upload_prepare`, {
      method: 'POST',
      body: JSON.stringify({
        file_type: 1,
        file_size: String(file.length),
        file_name: fileName,
        md5: crypto.createHash('md5').update(file).digest('hex'),
        sha1: crypto.createHash('sha1').update(file).digest('hex'),
        md5_10m: crypto.createHash('md5').update(file.subarray(0, MD5_10M_BYTES)).digest('hex'),
      }),
    });
    if (!prepared.upload_id) {
      throw new Error('QQ 图片预上传未返回 upload_id');
    }
    log.info('[QQ Media] upload prepared', {
      operationId,
      uploadId: prepared.upload_id,
      partCount: prepared.parts?.length || 0,
      blockSize: prepared.block_size,
    });

    const defaultBlockSize = Number(prepared.block_size);
    if (prepared.parts?.length && (!Number.isFinite(defaultBlockSize) || defaultBlockSize <= 0)) {
      throw new Error('QQ 图片预上传返回了无效 block_size');
    }
    const parts = (prepared.parts || []).map((part) => ({
      ...part,
      resolvedIndex: Number(part.index ?? part.part_index),
      resolvedUrl: part.presigned_url || part.upload_url || '',
    }));
    if (!parts.length) throw new Error('QQ 图片预上传未返回分片地址');
    if (parts.some((part) => !Number.isFinite(part.resolvedIndex) || !part.resolvedUrl)) {
      throw new Error('QQ 图片预上传返回了无效分片信息');
    }
    const indexBase = parts.some((part) => part.resolvedIndex === 0) ? 0 : 1;
    for (const part of parts.sort((a, b) => a.resolvedIndex - b.resolvedIndex)) {
      const partSize = Number(part.block_size) || defaultBlockSize;
      const start = (part.resolvedIndex - indexBase) * defaultBlockSize;
      const chunk = file.subarray(start, Math.min(start + partSize, file.length));
      await this.putUploadPart(part.resolvedUrl, chunk, part.resolvedIndex);
      await this.finishUploadPart(userPath, {
        upload_id: prepared.upload_id,
        part_index: part.resolvedIndex,
        block_size: String(chunk.length),
        md5: crypto.createHash('md5').update(chunk).digest('hex'),
      });
    }

    const media = await this.requestApi<MediaUploadResponse>(`${userPath}/files`, {
      method: 'POST',
      body: JSON.stringify({ upload_id: prepared.upload_id }),
    });
    const fileInfo = media.file_info || media.file_uuid;
    if (!fileInfo) throw new Error('QQ 图片合并未返回 file_info');
    log.info('[QQ Media] upload merged', { operationId, fileInfo });

    const sendBody: Record<string, unknown> = {
      msg_type: 7,
      media: { file_info: fileInfo },
    };
    await this.applyRecentPassiveReply(openId, sendBody);
    log.info('[QQ Send] sending image message', {
      operationId,
      openId,
      mode: sendBody.msg_id ? 'passive' : 'proactive',
      replySequence: sendBody.msg_seq,
    });
    const response = await this.sendMessage(openId, sendBody);
    log.info('[QQ Send] image accepted', {
      operationId,
      durationMs: Date.now() - startedAt,
      messageId: response.id,
      referenceId: response.ext_info?.ref_idx,
    });
    const appId = await this.getAppId();
    const chatMessage: Omit<ChatMessage, 'id'> = {
      direction: 'sent',
      type: MsgType.Image,
      content: '[Image]',
      timestamp: this.responseTimestamp(response.timestamp),
      context_token: '',
      from_user_id: appId,
      to_user_id: openId,
      message_id: response.id,
      reference_id: response.ext_info?.ref_idx,
      reply_to: null,
    };
    const id = await this.db.insertMessage(chatMessage);
    const extension = path.extname(imagePath).toLowerCase();
    const mimeType = extension === '.jpg' || extension === '.jpeg'
      ? 'image/jpeg'
      : extension === '.gif'
        ? 'image/gif'
        : extension === '.webp'
          ? 'image/webp'
          : extension === '.bmp'
            ? 'image/bmp'
            : 'image/png';
    const imageDataUrl = `data:${mimeType};base64,${file.toString('base64')}`;
    await this.persistImage(id, imageDataUrl);
    this._onMessage.fire({ ...chatMessage, id, imageDataUrl } as ChatMessage & { imageDataUrl?: string });
    return undefined;
  }

  async getDecryptedImageUrl(messageId: number): Promise<string | undefined> {
    try {
      const filePath = path.join(this.context.globalStorageUri.fsPath, 'qq-images', `${messageId}.json`);
      const raw = await fs.promises.readFile(filePath, 'utf8');
      return JSON.parse(raw).dataUrl;
    } catch {
      return undefined;
    }
  }

  async logout(): Promise<void> {
    log.info('[QQ Auth] logout requested; clearing session and credentials');
    this.stopPolling();
    this.accessToken = '';
    this.accessTokenExpiresAt = 0;
    await this.clearSession();
    await this.context.secrets.delete(QQ_APP_ID_SECRET);
    await this.context.secrets.delete(QQ_APP_SECRET_SECRET);
    this.emitStatus('QQ Bot 已断开，凭据已清除');
  }

  private async sendMessage(openId: string, body: Record<string, unknown>): Promise<SendMessageResponse> {
    const response = await this.requestApi<SendMessageResponse>(
      `/v2/users/${encodeURIComponent(openId)}/messages`,
      { method: 'POST', body: JSON.stringify(body) }
    );
    if (!response.id) throw new Error('QQ 消息接口未返回消息 ID，无法确认已送达');
    return response;
  }

  private async requestApi<T>(urlPath: string, init: RequestInit = {}, retryAuth = true): Promise<T> {
    const requestId = log.nextId('qq-http');
    const startedAt = Date.now();
    const method = String(init.method || 'GET').toUpperCase();
    const safePath = this.safeApiPath(urlPath);
    log.debug('[QQ HTTP] request', {
      requestId,
      method,
      path: safePath,
      retryAuth,
      proxy: Boolean(this.getProxyAgent()),
    });
    const token = await this.getAccessToken();
    const response = await fetch(`${API_BASE_URL}${urlPath}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'VsChat/0.9.0',
        Authorization: `QQBot ${token}`,
        ...(init.headers as Record<string, string> || {}),
      },
      dispatcher: this.getProxyAgent(),
    } as RequestInit).catch((err) => {
      log.error('[QQ HTTP] network failure', {
        requestId,
        method,
        path: safePath,
        durationMs: Date.now() - startedAt,
      }, log.formatError(err));
      throw err;
    });

    if (response.status === 401 && retryAuth) {
      log.warn('[QQ HTTP] access token rejected; refreshing once', {
        requestId,
        method,
        path: safePath,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      await this.getAccessToken(true);
      return this.requestApi<T>(urlPath, init, false);
    }

    const text = await response.text();
    let data: any = {};
    if (text) {
      try { data = JSON.parse(text); } catch { data = { message: text }; }
    }
    const businessCode = Number(data.err_code ?? data.biz_code ?? data.code ?? 0);
    const trace = data.trace_id || response.headers.get('x-tps-trace-id');
    if (!response.ok || businessCode !== 0) {
      const retryable = businessCode === 40093001 || response.status === 429 || response.status >= 500;
      log.error('[QQ HTTP] request rejected', {
        requestId,
        method,
        path: safePath,
        status: response.status,
        businessCode,
        traceId: trace,
        retryAfter: response.headers.get('retry-after'),
        durationMs: Date.now() - startedAt,
        retryable,
        responseMessage: data.message || response.statusText,
      });
      throw new QqBotError(
        `QQ API ${response.status}${businessCode ? `/${businessCode}` : ''}: ` +
        `${data.message || response.statusText}${trace ? ` (trace: ${trace})` : ''}`,
        retryable
      );
    }
    log.debug('[QQ HTTP] response', {
      requestId,
      method,
      path: safePath,
      status: response.status,
      traceId: trace,
      durationMs: Date.now() - startedAt,
      responseBytes: Buffer.byteLength(text),
    });
    return data as T;
  }

  private async getAccessToken(force = false): Promise<string> {
    if (!force && this.accessToken && Date.now() < this.accessTokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      log.debug('[QQ Auth] using cached access token', {
        expiresInSeconds: Math.max(0, Math.floor((this.accessTokenExpiresAt - Date.now()) / 1000)),
      });
      return this.accessToken;
    }
    const { appId, appSecret } = await this.getCredentials();
    const requestId = log.nextId('qq-auth');
    const startedAt = Date.now();
    log.info('[QQ Auth] requesting access token', { requestId, appId, force });
    const response = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'VsChat/0.9.0',
      },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
      dispatcher: this.getProxyAgent(),
    } as RequestInit).catch((err) => {
      log.error('[QQ Auth] token request network failure', { requestId, appId }, log.formatError(err));
      throw err;
    });
    const data = await response.json() as AccessTokenResponse;
    if (!response.ok || !data.access_token) {
      const code = Number(data.code || 0);
      log.error('[QQ Auth] token request rejected', {
        requestId,
        appId,
        status: response.status,
        businessCode: code,
        durationMs: Date.now() - startedAt,
        responseMessage: data.message,
      });
      throw new QqBotError(
        `获取 QQ access_token 失败${code ? `（${code}）` : ''}：${data.message || `HTTP ${response.status}`}`,
        code === 100001 || response.status === 429 || response.status >= 500
      );
    }
    const expiresIn = Number(data.expires_in || 7200);
    this.accessToken = data.access_token;
    this.accessTokenExpiresAt = Date.now() + expiresIn * 1000;
    log.info('[QQ Auth] access token refreshed', {
      requestId,
      appId,
      expiresInSeconds: expiresIn,
      durationMs: Date.now() - startedAt,
    });
    return this.accessToken;
  }

  private async getCredentials(): Promise<{ appId: string; appSecret: string }> {
    const credentials = await this.readCredentials();
    if (!credentials) {
      throw new Error('尚未配置 QQ Bot。请先执行 “VsChat: Configure QQ Bot”');
    }
    return credentials;
  }

  private async readCredentials(): Promise<{ appId: string; appSecret: string } | null> {
    const appId = process.env.VSCHAT_QQ_APP_ID || await this.context.secrets.get(QQ_APP_ID_SECRET) || '';
    const appSecret = process.env.VSCHAT_QQ_APP_SECRET || await this.context.secrets.get(QQ_APP_SECRET_SECRET) || '';
    return appId && appSecret ? { appId, appSecret } : null;
  }

  private async getAppId(): Promise<string> {
    return (await this.getCredentials()).appId;
  }

  private async getTargetOpenId(): Promise<string> {
    const configured = vscode.workspace.getConfiguration('vschat').get<string>('qqUserOpenId') || '';
    const detected = await this.db.getMetadata('qq_user_openid') || '';
    const openId = configured || detected;
    if (!openId) {
      log.warn('[QQ Send] no target OpenID available', { configured: Boolean(configured), detected: Boolean(detected) });
      throw new Error('尚未发现 QQ 会话对象；请先在 QQ 中给机器人发送一条消息');
    }
    log.debug('[QQ Send] target selected', { openId, source: configured ? 'settings' : 'last-inbound' });
    return openId;
  }

  /** Prefer a recent passive reply, avoiding proactive-message restrictions. */
  private async applyRecentPassiveReply(openId: string, body: Record<string, unknown>): Promise<void> {
    const latestUser = await this.db.getMetadata('qq_user_openid') || '';
    const latestMessageId = await this.db.getMetadata('qq_last_inbound_message_id') || '';
    const latestTimestamp = Number(await this.db.getMetadata('qq_last_inbound_timestamp') || 0);
    const ageSeconds = Math.floor(Date.now() / 1000) - latestTimestamp;
    if (openId !== latestUser || !latestMessageId || latestTimestamp <= 0 || ageSeconds > C2C_PASSIVE_REPLY_WINDOW_SECONDS) {
      log.debug('[QQ Send] proactive mode selected', {
        openId,
        sameUser: openId === latestUser,
        hasInboundMessage: Boolean(latestMessageId),
        inboundAgeSeconds: latestTimestamp > 0 ? ageSeconds : undefined,
      });
      return;
    }

    const sequence = await this.nextReplySequence(latestMessageId);
    if (!sequence) {
      log.warn('[QQ Send] passive reply quota exhausted; falling back to proactive mode', {
        openId,
        messageId: latestMessageId,
      });
      return;
    }
    body.msg_id = latestMessageId;
    body.msg_seq = sequence;
    log.debug('[QQ Send] passive reply selected', {
      openId,
      messageId: latestMessageId,
      sequence,
      inboundAgeSeconds: ageSeconds,
    });
  }

  private async nextReplySequence(messageId: string): Promise<number | null> {
    const previousMessageId = await this.db.getMetadata('qq_reply_message_id') || '';
    const previousSequence = previousMessageId === messageId
      ? Number(await this.db.getMetadata('qq_reply_sequence') || 0)
      : 0;
    const sequence = previousSequence + 1;
    // QQ allows at most four passive replies to one single-chat message.
    if (sequence > C2C_MAX_PASSIVE_REPLIES) return null;
    await this.db.setMetadata('qq_reply_message_id', messageId);
    await this.db.setMetadata('qq_reply_sequence', String(sequence));
    return sequence;
  }

  private async putUploadPart(url: string, chunk: Buffer, index: number): Promise<void> {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const startedAt = Date.now();
      try {
        const response = await fetch(url, {
          method: 'PUT',
          body: chunk,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(chunk.length),
          },
          dispatcher: this.getProxyAgent(),
        } as RequestInit);
        lastStatus = response.status;
        if (response.ok) {
          log.debug('[QQ Media] upload part completed', {
            index,
            attempt: attempt + 1,
            bytes: chunk.length,
            status: response.status,
            durationMs: Date.now() - startedAt,
          });
          return;
        }
        log.warn('[QQ Media] upload part rejected', {
          index,
          attempt: attempt + 1,
          status: response.status,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        log.warn('[QQ Media] upload part network failure', {
          index,
          attempt: attempt + 1,
          durationMs: Date.now() - startedAt,
        }, log.formatError(err));
        if (attempt === 2) throw err;
      }
      if (attempt < 2) {
        const delayMs = 1_000 * (2 ** attempt);
        log.debug('[QQ Media] retrying upload part', { index, nextAttempt: attempt + 2, delayMs });
        await this.sleep(delayMs);
      }
    }
    throw new Error(`QQ 图片分片 ${index} 上传失败：HTTP ${lastStatus || 'network error'}`);
  }

  private async finishUploadPart(userPath: string, body: Record<string, unknown>): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.requestApi(`${userPath}/upload_part_finish`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return;
      } catch (err) {
        if (!(err instanceof QqBotError) || !err.retryable || attempt === 2) throw err;
        const delayMs = 1_000 * (attempt + 1);
        log.warn('[QQ Media] upload part confirmation retry', {
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          delayMs,
        }, log.formatError(err));
        await this.sleep(delayMs);
      }
    }
  }

  private getProxyAgent(): ProxyAgent | undefined {
    const configUrl = vscode.workspace.getConfiguration('vschat').get<string>('proxyUrl') || '';
    const environmentUrl = process.env.WSS_PROXY || process.env.wss_proxy
      || process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || process.env.ALL_PROXY || process.env.all_proxy || '';
    const proxyUrl = configUrl || environmentUrl;
    if (proxyUrl === this.cachedProxyUrl) return this.cachedProxyAgent;
    log.info('[QQ Network] proxy changed', {
      enabled: Boolean(proxyUrl),
      source: configUrl ? 'settings' : environmentUrl ? 'environment' : 'direct',
      endpoint: proxyUrl ? log.describeUrl(proxyUrl) : undefined,
    });
    this.cachedProxyUrl = proxyUrl;
    this.cachedProxyAgent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
    return this.cachedProxyAgent;
  }

  private sendGateway(payload: GatewayPayload): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      log.warn('[QQ Gateway] payload not sent; socket is not open', {
        op: payload.op,
        socketState: this.socket?.readyState,
      });
      return;
    }
    this.socket.send(JSON.stringify(payload));
  }

  private handleGatewayClose(code: number, reason: string): void {
    log.warn('[QQ Gateway] socket closed', {
      code,
      reason: reason || 'none',
      shouldRun: this.shouldRun,
      sequence: this.sequence,
    });
    if (!this.shouldRun) return;
    if (code === 4006 || code === 4007 || (code >= 4900 && code <= 4913)) {
      void this.clearSession();
    }
    if (code === 4008) this.reconnectDelay = Math.max(this.reconnectDelay, 60_000);
    if ([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915].includes(code)) {
      this.shouldRun = false;
      log.error('[QQ Gateway] reconnect disabled after fatal close', { code, reason: reason || 'none' });
      this.emitStatus(`QQ Gateway 拒绝连接（${code}）：${reason || '请检查事件权限或机器人状态'}`);
      return;
    }
    this.emitStatus(`QQ 连接中断，${this.reconnectDelay / 1000} 秒后重连…`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun || this.reconnectTimer) {
      log.debug('[QQ Gateway] reconnect not scheduled', {
        shouldRun: this.shouldRun,
        alreadyScheduled: Boolean(this.reconnectTimer),
      });
      return;
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    log.info('[QQ Gateway] reconnect scheduled', { delayMs: delay, nextDelayMs: this.reconnectDelay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectGateway();
    }, delay);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async clearSession(): Promise<void> {
    log.info('[QQ Gateway] clearing persisted resume session', {
      hadSession: Boolean(this.sessionId),
      sequence: this.sequence,
    });
    this.sessionId = '';
    this.sequence = null;
    await this.db.setMetadata('qq_gateway_session_id', '');
    await this.db.setMetadata('qq_gateway_seq', '');
  }

  private extValue(values: string[], key: string): string {
    const prefix = `${key}=`;
    return values.find((value) => value.startsWith(prefix))?.slice(prefix.length) || '';
  }

  private safeApiPath(value: string): string {
    return value.replace(/(\/v2\/users\/)[^/]+/g, '$1{user_openid}');
  }

  private responseTimestamp(timestamp?: string): number {
    const parsed = timestamp ? Date.parse(timestamp) : NaN;
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async persistImage(messageId: number, dataUrl: string): Promise<void> {
    const directory = path.join(this.context.globalStorageUri.fsPath, 'qq-images');
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, `${messageId}.json`), JSON.stringify({ dataUrl }));
    log.debug('[QQ Media] image persisted', { dbId: messageId, bytes: Buffer.byteLength(dataUrl) });
  }

  private emitStatus(status: string): void {
    log.debug('[QQ Status]', status);
    this._onStatus.fire(status);
  }

  dispose(): void {
    log.debug('[QQ] disposing client');
    this.stopPolling();
    this._onMessage.dispose();
    this._onStatus.dispose();
    this._onQrCode.dispose();
    this._onLoginSuccess.dispose();
  }
}
