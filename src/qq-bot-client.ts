import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isIP } from 'net';
import * as vscode from 'vscode';
import { fetch, ProxyAgent, RequestInit, WebSocket } from 'undici';
import { ChatDB } from './chat-db';
import { persistImageCache } from './image-cache';
import { ChatMessage, ChatMessagePart, ConnectionHealth, MsgType, MsgTypeValue, ReplyTo } from './types';
import * as log from './logger';
import { parseQqContent } from './qq-content';
import { FileSendError, MAX_FILE_BYTES, sanitizeFileName, getFileDownloadSpec, downloadFileBytes } from './file-transfer';
import { RecipientState, SendTarget, recipientId } from './recipient-types';

const API_BASE_URL = 'https://api.bot.qq.com';
const ACCESS_TOKEN_URL = `${API_BASE_URL}/app/getAppAccessToken`;
const GROUP_AND_C2C_EVENT = 1 << 25;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MD5_10M_BYTES = 10_002_432;
const C2C_PASSIVE_REPLY_WINDOW_SECONDS = 60 * 60;
const C2C_MAX_PASSIVE_REPLIES = 4;
const FILE_REQUEST_TIMEOUT_MS = 30_000;
const GATEWAY_CONNECT_TIMEOUT_MS = 30_000;
const GATEWAY_DISPATCH_TIMEOUT_MS = 30_000;
const GATEWAY_MAX_QUEUED_EVENTS = 256;
const GATEWAY_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const GATEWAY_MAX_PAYLOAD_BYTES = 1024 * 1024;

interface GatewayCheckpoint { sessionId: string; sequence: number; credentialKey: string }
interface QueuedDispatch {
  payload: GatewayPayload;
  bytes: number;
  resolve(): void;
  reject(error: Error): void;
}
interface GatewayConnection {
  generation: number;
  controller: AbortController;
  socket: InstanceType<typeof WebSocket>;
  closed: boolean;
  helloStarted: boolean;
  accountId: string;
  credentialKey: string;
  sessionId: string;
  sequence: number | null;
  receivedSequence: number | null;
  heartbeatInterval: number;
  heartbeatTimer?: NodeJS.Timeout;
  ackTimer?: NodeJS.Timeout;
  readyTimer?: NodeJS.Timeout;
  awaitingAck: boolean;
  queue: QueuedDispatch[];
  queuedBytes: number;
  processing: boolean;
}

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
  size?: number;
}

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

function partSummary(part: ChatMessagePart): string {
  if (part.type === MsgType.Text) return part.text || '';
  const label = { 2: '图片', 3: '语音消息', 4: '文件', 5: '视频' }[part.type];
  return [part.text, `[${label}${part.fileName ? `：${part.fileName}` : ''}]`].filter(Boolean).join(' ');
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
  constructor(message: string, readonly retryable: boolean, readonly definitelyRejected = false) {
    super(message);
    this.name = 'QqBotError';
  }
}

/** QQ Bot API v2 transport (C2C / single-user chat). */
export class QqBotClient extends vscode.Disposable {
  readonly channelName = 'QQ';
  readonly fileCapabilities = { canSend: true, maxBytes: MAX_FILE_BYTES };

  private accessToken = '';
  private accessTokenExpiresAt = 0;
  private accessTokenCredentialKey = '';
  private socket: InstanceType<typeof WebSocket> | null = null;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelay = 1_000;
  private shouldRun = false;
  private connecting = false;
  private _connected = false;
  private sequence: number | null = null;
  private sessionId = '';
  private gatewayAccountId = '';
  private gatewayCredentialKey = '';
  private gatewayGeneration = 0;
  private activeGateway: GatewayConnection | undefined;
  private connectController: AbortController | undefined;
  private resumeCheckpoint: GatewayCheckpoint | undefined;
  private forceIdentify = false;
  private pendingDispatchWork: Promise<void> | undefined;
  private disposed = false;
  private _connectionHealth: ConnectionHealth = { state: 'offline', detail: 'QQ Bot 未连接' };

  private _onConnectionHealth = new vscode.EventEmitter<ConnectionHealth>();
  readonly onConnectionHealth = this._onConnectionHealth.event;
  get connectionHealth(): ConnectionHealth { return { ...this._connectionHealth }; }

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
    if (this.shouldRun || this.disposed) return;
    this.shouldRun = true;
    this.reconnectDelay = 1_000;
    this.setHealth('connecting', '正在连接 QQ Gateway…');
    await this.connectGateway();
  }

  stopPolling(): void {
    this.shouldRun = false;
    this.gatewayGeneration++;
    this.connectController?.abort();
    this.connectController = undefined;
    this.connecting = false;
    if (this.reconnectTimer) this.cancelTimer(this.reconnectTimer);
    this.reconnectTimer = undefined;
    if (this.activeGateway) this.detachGateway(this.activeGateway, 'client disconnect');
    this._connected = false;
    this.setHealth('offline', 'QQ Bot 已断开');
  }

  private now(): number { return Date.now(); }
  private after(ms: number, callback: () => void): NodeJS.Timeout { return setTimeout(callback, ms); }
  private cancelTimer(timer: NodeJS.Timeout): void { clearTimeout(timer); }

  private setHealth(state: ConnectionHealth['state'], detail: string, retryAt?: number): void {
    this._connectionHealth = { state, detail, ...(this._connectionHealth.lastAckAt === undefined ? {} : {
      lastAckAt: this._connectionHealth.lastAckAt,
    }), ...(retryAt === undefined ? {} : { retryAt }) };
    this._onConnectionHealth.fire(this.connectionHealth);
    this.emitStatus(detail);
  }

  private isCurrent(connection: GatewayConnection): boolean {
    return !this.disposed && this.shouldRun && !connection.closed
      && this.activeGateway === connection && connection.generation === this.gatewayGeneration;
  }

  private createGatewaySocket(url: string): InstanceType<typeof WebSocket> {
    const agent = this.getProxyAgent();
    return new WebSocket(url, {
      ...(agent ? { dispatcher: agent } : {}),
      headers: { 'User-Agent': 'VsChat/0.9.5' },
    });
  }

  private async connectGateway(): Promise<void> {
    if (!this.shouldRun || this.disposed || this.connecting || this.activeGateway) return;
    // An uncooperative old DB handler cannot be cancelled midway through an
    // atomic save. Keep at most one such handler; reconnect once it settles.
    if (this.pendingDispatchWork) {
      this.setHealth('reconnecting', 'QQ 已断开，等待上一条消息处理完成后重连…');
      return;
    }
    this.connecting = true;
    const generation = ++this.gatewayGeneration;
    const controller = new AbortController();
    this.connectController = controller;
    const deadline = this.after(GATEWAY_CONNECT_TIMEOUT_MS, () => controller.abort());
    this.setHealth(this._connectionHealth.state === 'reconnecting' ? 'reconnecting' : 'connecting', '正在连接 QQ Gateway…');
    try {
      const gateway = await this.requestApi<GatewayResponse>('/gateway', { signal: controller.signal });
      if (!this.shouldRun || this.disposed || generation !== this.gatewayGeneration) return;
      if (controller.signal.aborted) throw new Error('QQ Gateway 连接超时');
      if (!gateway.url || new URL(gateway.url).protocol !== 'wss:') throw new Error('QQ Gateway 未返回有效 WSS 地址');
      const socket = this.createGatewaySocket(gateway.url);
      socket.binaryType = 'arraybuffer';
      const connection: GatewayConnection = {
        generation, controller, socket, closed: false, helloStarted: false,
        accountId: '', credentialKey: '', sessionId: '', sequence: null, receivedSequence: null,
        heartbeatInterval: 0, awaitingAck: false, queue: [], queuedBytes: 0, processing: false,
      };
      this.socket = socket;
      this.activeGateway = connection;
      connection.readyTimer = this.after(GATEWAY_CONNECT_TIMEOUT_MS, () => {
        this.failGateway(connection, 'QQ Gateway 握手超时');
      });
      socket.addEventListener('message', event => {
        if (!this.isCurrent(connection)) return;
        void this.handleGatewayMessage(event.data, connection).catch(error => {
          this.failGateway(connection, 'QQ 消息处理失败', error);
        });
      });
      socket.addEventListener('error', () => this.failGateway(connection, 'QQ Gateway 连接异常'));
      socket.addEventListener('close', (event: any) => {
        if (!this.isCurrent(connection)) return;
        this.detachGateway(connection, 'server close', false);
        void this.handleGatewayClose(Number(event.code || 0), connection).catch(error => {
          log.error('[QQ Gateway] close handling failed', log.formatError(error));
          if (generation === this.gatewayGeneration) this.scheduleReconnect('QQ 会话恢复信息保存失败');
        });
      });
    } catch (error) {
      if (!this.shouldRun || this.disposed || generation !== this.gatewayGeneration) return;
      log.error('[QQ Gateway] connection attempt failed', log.formatError(error));
      if (error instanceof QqBotError && !error.retryable) {
        this.shouldRun = false;
        this.setHealth('error', 'QQ Gateway 拒绝连接，请检查机器人凭据与权限后重新连接');
      } else this.scheduleReconnect(controller.signal.aborted ? 'QQ Gateway 连接超时' : 'QQ Gateway 连接失败');
    } finally {
      this.cancelTimer(deadline);
      if (generation === this.gatewayGeneration) {
        this.connecting = false;
        this.connectController = undefined;
      }
    }
  }

  private async handleGatewayMessage(raw: unknown, connection = this.activeGateway): Promise<void> {
    if (!connection || !this.isCurrent(connection)) return;
    const text = typeof raw === 'string' ? raw
      : raw instanceof ArrayBuffer ? Buffer.from(raw).toString('utf8')
        : ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8') : '';
    const bytes = Buffer.byteLength(text);
    if (!bytes || bytes > GATEWAY_MAX_PAYLOAD_BYTES) throw new Error('Invalid QQ Gateway payload size');
    const payload = JSON.parse(text) as GatewayPayload;
    if (!payload || !Number.isSafeInteger(payload.op)) throw new Error('Invalid QQ Gateway opcode');
    log.debug('[QQ Gateway] payload received', { op: payload.op, event: payload.t, sequence: payload.s, bytes });
    // Control frames never join the dispatch queue: a slow DB write must not
    // block ACKs, heartbeat requests, or a server-requested reconnect.
    switch (payload.op) {
      case 0:
        if (!Number.isSafeInteger(payload.s) || payload.s! < 0) throw new Error('Invalid QQ dispatch sequence');
        connection.receivedSequence = Math.max(connection.receivedSequence ?? 0, payload.s!);
        return this.enqueueDispatch(connection, payload, bytes);
      case 1:
        this.sendHeartbeat(connection, true);
        return;
      case 7:
        this.failGateway(connection, 'QQ Gateway 要求重新连接');
        return;
      case 9:
        this.detachGateway(connection, 'invalid session');
        if (!payload.d) await this.clearSession(connection.sessionId);
        if (connection.generation === this.gatewayGeneration) this.scheduleReconnect(payload.d ? 'QQ 会话暂时失效' : 'QQ 会话失效，将重新鉴权');
        return;
      case 10:
        if (connection.helloStarted) throw new Error('Duplicate QQ Gateway hello');
        connection.helloStarted = true;
        await this.handleHello(payload.d?.heartbeat_interval, connection);
        return;
      case 11:
        if (!connection.awaitingAck) return;
        connection.awaitingAck = false;
        if (connection.ackTimer) this.cancelTimer(connection.ackTimer);
        connection.ackTimer = undefined;
        if (this._connected) this.reconnectDelay = 1_000;
        this._connectionHealth = { ...this._connectionHealth, lastAckAt: this.now() };
        this._onConnectionHealth.fire(this.connectionHealth);
        return;
    }
  }

  private async handleHello(intervalValue: unknown, connection = this.activeGateway): Promise<void> {
    if (!connection || !this.isCurrent(connection)) return;
    const interval = Number(intervalValue);
    if (!Number.isSafeInteger(interval) || interval < 100 || interval > 300_000) {
      throw new Error('QQ Gateway 返回了无效心跳周期');
    }
    connection.heartbeatInterval = interval;
    this.armHeartbeat(connection);
    const token = `QQBot ${await this.getAccessToken(false, connection.controller.signal)}`;
    const credentials = await this.getCredentials();
    const credentialKey = this.credentialKey(credentials);
    if (credentialKey !== this.accessTokenCredentialKey) throw new Error('QQ Bot 凭据已变化，请重新连接');
    const saved = this.forceIdentify ? undefined : this.resumeCheckpoint || await this.db.getQqGatewayCheckpoint();
    if (!this.isCurrent(connection)) return;
    connection.accountId = credentials.appId;
    connection.credentialKey = credentialKey;
    this.gatewayAccountId = credentials.appId;
    this.gatewayCredentialKey = credentialKey;
    if (saved && saved.credentialKey === credentialKey) {
      connection.sessionId = saved.sessionId;
      connection.sequence = saved.sequence;
      connection.receivedSequence = saved.sequence;
      this.sendGateway({ op: 6, d: { token, session_id: saved.sessionId, seq: saved.sequence } }, connection);
    } else {
      this.sendGateway({ op: 2, d: {
        token, intents: GROUP_AND_C2C_EVENT, shard: [0, 1],
        properties: { '$os': process.platform, '$browser': 'vschat', '$device': 'vscode' },
      } }, connection);
    }
  }

  private armHeartbeat(connection: GatewayConnection): void {
    connection.heartbeatTimer = this.after(connection.heartbeatInterval, () => {
      if (!this.isCurrent(connection)) return;
      this.sendHeartbeat(connection);
      if (this.isCurrent(connection)) this.armHeartbeat(connection);
    });
  }

  private sendHeartbeat(connection: GatewayConnection, requested = false): void {
    if (!this.isCurrent(connection)) return;
    // An extra server request does not extend the oldest unanswered heartbeat.
    if (connection.awaitingAck && !requested) return;
    if (!this.sendGateway({ op: 1, d: connection.receivedSequence }, connection)) return;
    if (!connection.awaitingAck) {
      connection.awaitingAck = true;
      connection.ackTimer = this.after(connection.heartbeatInterval || GATEWAY_CONNECT_TIMEOUT_MS, () => {
        if (this.isCurrent(connection) && connection.awaitingAck) this.failGateway(connection, 'QQ 心跳确认超时');
      });
    }
  }

  private enqueueDispatch(connection: GatewayConnection, payload: GatewayPayload, bytes: number): Promise<void> {
    if (connection.sequence !== null && payload.s! <= connection.sequence) return Promise.resolve();
    if (connection.queue.length + Number(connection.processing) >= GATEWAY_MAX_QUEUED_EVENTS
        || connection.queuedBytes + bytes > GATEWAY_MAX_QUEUED_BYTES) {
      this.failGateway(connection, 'QQ 消息积压超过上限，将从已保存位置恢复');
      return Promise.reject(new Error('QQ dispatch queue limit exceeded'));
    }
    return new Promise((resolve, reject) => {
      connection.queue.push({ payload, bytes, resolve, reject });
      connection.queuedBytes += bytes;
      if (!connection.processing) void this.drainDispatch(connection);
    });
  }

  private async drainDispatch(connection: GatewayConnection): Promise<void> {
    connection.processing = true;
    while (this.isCurrent(connection) && connection.queue.length) {
      const item = connection.queue.shift()!;
      let deadline: NodeJS.Timeout | undefined;
      let cancel: (() => void) | undefined;
      const work = this.handleDispatch(item.payload, connection);
      this.pendingDispatchWork = work;
      // Observe settlement even if a timeout detaches this connection. Only one
      // physical handler may survive cancellation; its checkpoint is fenced.
      void work.catch(() => {}).finally(() => {
        if (this.pendingDispatchWork === work) this.pendingDispatchWork = undefined;
        if (this.shouldRun && !this.activeGateway && !this.connecting) this.scheduleReconnect('QQ 消息处理已结束，准备恢复连接');
      });
      try {
        await Promise.race([work, new Promise<never>((_, reject) => {
          cancel = () => reject(new Error('QQ dispatch cancelled with its connection'));
          if (connection.controller.signal.aborted) cancel();
          else connection.controller.signal.addEventListener('abort', cancel, { once: true });
          deadline = this.after(GATEWAY_DISPATCH_TIMEOUT_MS, () => reject(new Error('QQ dispatch processing timed out')));
        })]);
        item.resolve();
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
        this.failGateway(connection, 'QQ 消息处理失败或超时，将从已保存位置恢复', error);
      } finally {
        if (deadline) this.cancelTimer(deadline);
        if (cancel) connection.controller.signal.removeEventListener('abort', cancel);
        connection.queuedBytes -= item.bytes;
      }
    }
    connection.processing = false;
  }

  private async handleDispatch(payload: GatewayPayload, connection: GatewayConnection): Promise<void> {
    if (!this.isCurrent(connection)) return;
    if (connection.sequence !== null && payload.s! <= connection.sequence) return;
    let sessionId = connection.sessionId;
    if (payload.t === 'READY') {
      sessionId = typeof payload.d?.session_id === 'string' ? payload.d.session_id : '';
      if (!sessionId) throw new Error('QQ READY 未返回 session_id');
    } else if (payload.t === 'C2C_MESSAGE_CREATE') {
      await this.processC2CMessage(payload.d as QqC2CMessage, connection.accountId, () => this.isCurrent(connection));
    }
    if (!this.isCurrent(connection)) return;
    if (!sessionId || !connection.credentialKey) throw new Error('QQ Gateway 尚未建立会话身份');
    const checkpoint = { sessionId, sequence: payload.s!, credentialKey: connection.credentialKey };
    await this.db.saveQqGatewayCheckpoint(checkpoint);
    if (!this.isCurrent(connection)) return;
    connection.sessionId = sessionId;
    connection.sequence = checkpoint.sequence;
    this.sessionId = sessionId;
    this.sequence = checkpoint.sequence;
    this.resumeCheckpoint = checkpoint;
    this.forceIdentify = false;
    if (payload.t === 'READY' || payload.t === 'RESUMED') {
      if (connection.readyTimer) this.cancelTimer(connection.readyTimer);
      connection.readyTimer = undefined;
      this._connected = true;
      this.setHealth('online', payload.t === 'READY' ? 'QQ Bot 已连接' : 'QQ Bot 连接已恢复');
      this._onLoginSuccess.fire();
    }
  }

  private async processC2CMessage(message: QqC2CMessage, authenticatedAccount?: string, stillCurrent?: () => boolean): Promise<void> {
    if (!message?.id) {
      log.warn('[QQ Receive] ignored event without message ID');
      return;
    }
    const openId = message.author?.user_openid || message.author?.id || '';
    if (!openId) {
      log.warn('[QQ Receive] message skipped; user_openid missing', { messageId: message.id });
      return;
    }
    // Incoming identity belongs to the authenticated socket, not credentials
    // that the user might have edited while that socket is still connected.
    const accountId = authenticatedAccount || this.gatewayAccountId || await this.getAppId();

    const parsedContent = parseQqContent(optionalString(message.content) || '');
    const attachments = Array.isArray(message.attachments)
      ? message.attachments.filter(attachment => attachment && typeof attachment === 'object' && !Array.isArray(attachment))
      : [];
    const parts: ChatMessagePart[] = [];
    if (parsedContent.text) parts.push({ type: MsgType.Text, text: parsedContent.text });
    for (const attachment of attachments) {
      const contentType = optionalString(attachment.content_type) || '';
      const voiceUrl = optionalString(attachment.voice_wav_url);
      const type = contentType.startsWith('image/') ? MsgType.Image
        : contentType === 'voice' || contentType.startsWith('audio/') || voiceUrl ? MsgType.Voice
          : contentType.startsWith('video/') ? MsgType.Video : MsgType.File;
      parts.push({
        type,
        url: type === MsgType.Voice ? voiceUrl || optionalString(attachment.url) : optionalString(attachment.url),
        text: type === MsgType.Voice ? optionalString(attachment.asr_refer_text) : undefined,
        fileName: optionalString(attachment.filename),
        size: typeof attachment.size === 'number' && Number.isFinite(attachment.size) && attachment.size >= 0 ? attachment.size : undefined,
        mimeType: contentType || undefined,
      });
    }
    if (!parts.length) {
      parts.push({ type: MsgType.Text, text: message.message_type === 3 ? '[卡片消息]' : '[QQ 消息]' });
    }
    // Single-part fields remain compatible with legacy consumers; multipart
    // content is a readable search/notification summary of the complete envelope.
    const onlyPart = parts.length === 1 ? parts[0] : undefined;
    const type: MsgTypeValue = onlyPart?.type || MsgType.Text;
    const content = onlyPart
      ? onlyPart.type === MsgType.Image ? onlyPart.url || '[图片]'
        : onlyPart.type === MsgType.Voice ? onlyPart.text || '[语音消息]'
          : onlyPart.type === MsgType.File ? onlyPart.url || onlyPart.fileName || '[文件]'
            : onlyPart.type === MsgType.Text ? onlyPart.text || '' : partSummary(onlyPart)
      : parts.map(partSummary).join('\n');
    const imageDataUrl = onlyPart?.type === MsgType.Image ? onlyPart.url : undefined;
    log.info('[QQ Receive] C2C message', {
      messageId: message.id,
      openId,
      messageType: message.message_type,
      contentLength: message.content?.length || 0,
      attachmentCount: attachments.length,
      attachmentType: optionalString(attachments[0]?.content_type),
      hasQuote: Boolean(message.message_scene?.ext?.some((value) => value.startsWith('ref_msg_idx='))),
      faceCount: parsedContent.faceCount,
      faceFallbackCount: parsedContent.fallbackCount,
      timestamp: message.timestamp,
    });

    const ext = message.message_scene?.ext || [];
    const referenceId = this.extValue(ext, 'msg_idx');
    const quotedReferenceId = this.extValue(ext, 'ref_msg_idx');
    const quotedText = parseQqContent(message.msg_elements?.[0]?.content || '').text;
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
      parts,
      timestamp: Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : Math.floor(Date.now() / 1000),
      context_token: '',
      from_user_id: openId,
      to_user_id: accountId,
      message_id: message.id,
      reference_id: referenceId || undefined,
      reply_to: replyTo,
    };

    if (stillCurrent && !stillCurrent()) return;
    const { id, inserted, latestAdvanced } = await this.db.storeQqInbound(chatMessage);
    if (stillCurrent && !stillCurrent()) return;
    if (!inserted) {
      log.info('[QQ Receive] duplicate event already persisted; routing unchanged', {
        dbId: id,
        eventKey: this.messageKey(message.id),
      });
      return;
    }
    log.info('[QQ Receive] message persisted', {
      dbId: id, eventKey: this.messageKey(message.id), type, latestAdvanced,
    });
    this._onMessage.fire({ ...chatMessage, id, imageDataUrl } as ChatMessage & { imageDataUrl?: string });
  }

  async getRecipients(): Promise<RecipientState> {
    let accountId: string;
    try { accountId = await this.getAppId(); }
    catch { return { recipients: [], reason: '请先配置 QQ Bot 凭据' }; }
    const { conversations, totalUnreadCount } = await this.db.getQqRecipientSummary({
      appId: accountId, nowSeconds: Math.floor(Date.now() / 1000),
      windowSeconds: C2C_PASSIVE_REPLY_WINDOW_SECONDS, maxReplies: C2C_MAX_PASSIVE_REPLIES,
    });
    const configured = (vscode.workspace.getConfiguration('vschat').get<string>('qqUserOpenId') || '').trim();
    const peers = new Map(conversations.map(item => [item.conversation.peerId, item]));
    if (configured && !peers.has(configured)) {
      peers.set(configured, { conversation: { accountId, peerId: configured }, lastTimestamp: 0, unreadCount: 0, hasLiveInbound: false, replyContext: null });
    }
    const recipients = [...peers.values()].map(item => {
      const conversation = { accountId, peerId: item.conversation.peerId };
      const canSend = this._connected && Boolean(item.replyContext);
      return {
        id: recipientId(conversation), conversation,
        label: `QQ · ${conversation.peerId}${configured === conversation.peerId ? '（配置）' : ''}`,
        canSend, unreadCount: item.unreadCount,
        reason: canSend ? undefined : !this._connected ? 'QQ Bot 尚未连接'
          : '暂无可用被动回复额度，请让此联系人给机器人发送一条新消息',
      };
    });
    return { accountId, recipients, totalUnreadCount, reason: recipients.length ? undefined : '请先在 QQ 中给机器人发送一条消息' };
  }

  async captureSendTarget(id: string): Promise<SendTarget> {
    const state = await this.getRecipients();
    const selected = state.recipients.find(item => item.id === id);
    if (!selected?.conversation || !selected.canSend) {
      throw new FileSendError(selected?.reason || '请选择当前 QQ Bot 的有效收件人');
    }
    const credentials = await this.getCredentials();
    if (credentials.appId !== selected.conversation.accountId) throw new FileSendError('QQ Bot 账号已变化，请重新选择收件人');
    return Object.freeze({ ...selected.conversation, channel: 'qq', sessionKey: this.credentialKey(credentials) });
  }

  private async freezeSendTarget(target?: SendTarget): Promise<SendTarget> {
    // Copy before the first await: callers cannot redirect an in-flight operation.
    const frozen = target && Object.freeze({ ...target });
    if (frozen) {
      if (frozen.channel !== 'qq' || typeof frozen.accountId !== 'string' || !frozen.accountId
          || typeof frozen.peerId !== 'string' || !frozen.peerId
          || typeof frozen.sessionKey !== 'string' || !/^[a-f0-9]{64}$/.test(frozen.sessionKey)) {
        throw new FileSendError('QQ 收件人快照无效，请重新选择收件人');
      }
      await this.assertTargetAccount(frozen);
      if (!await this.db.peekQqReply(this.replyOptions(frozen.accountId, frozen.peerId))) {
        throw new FileSendError('此 QQ 联系人的被动回复额度已用尽或过期，请等待对方的新消息');
      }
      return frozen;
    }
    // Legacy direct callers retain automatic routing. The production provider
    // always supplies a captured target; even legacy calls resolve it only once.
    const accountId = await this.getAppId();
    const peerId = await this.getTargetOpenId();
    return Object.freeze({ channel: 'qq', accountId, peerId });
  }

  private credentialKey(credentials: { appId: string; appSecret: string }): string {
    return crypto.createHash('sha256').update(JSON.stringify([credentials.appId, credentials.appSecret])).digest('hex');
  }

  private async assertTargetAccount(target?: SendTarget): Promise<void> {
    if (!target) return;
    if (!this._connected) throw new FileSendError('QQ Bot 已断开，请重新连接后发送');
    if (target.sessionKey) {
      let credentials: { appId: string; appSecret: string };
      try { credentials = await this.getCredentials(); }
      catch { throw new FileSendError('QQ Bot 凭据已移除，请重新配置后选择收件人'); }
      if (credentials.appId !== target.accountId || this.credentialKey(credentials) !== target.sessionKey) {
        throw new FileSendError('QQ Bot 凭据已变化，请重新选择收件人');
      }
    } else if (await this.getAppId() !== target.accountId) {
      throw new FileSendError('QQ Bot 账号已变化，请重新选择收件人');
    }
  }

  async sendText(text: string, replyTo?: ReplyTo, target?: SendTarget): Promise<string | undefined> {
    if (!this._connected) throw new Error('QQ Bot 尚未连接');
    const frozen = await this.freezeSendTarget(target);
    const openId = frozen.peerId;
    const body: Record<string, unknown> = { content: text, msg_type: 0 };
    const operationId = log.nextId('qq-send');
    const startedAt = Date.now();

    const replyAgeSeconds = replyTo?.timestamp
      ? Math.floor(Date.now() / 1000) - replyTo.timestamp
      : Number.POSITIVE_INFINITY;
    if (replyTo?.messageId && replyTo.direction === 'received' && replyAgeSeconds <= C2C_PASSIVE_REPLY_WINDOW_SECONDS) {
      // A quoted inbound QQ message can simultaneously be a passive reply.
      const reply = await this.reserveReply(openId, replyTo.messageId, frozen);
      if (reply) {
        body.msg_id = reply.messageId;
        body.msg_seq = reply.sequence;
      } else {
        await this.applyRecentPassiveReply(openId, body, frozen, Boolean(target));
      }
    } else {
      await this.applyRecentPassiveReply(openId, body, frozen, Boolean(target));
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
      replyContextKey: this.messageKey(body.msg_id),
      hasReference: Boolean(body.message_reference),
    });
    const response = await this.sendMessage(openId, body, true, undefined, frozen);
    log.info('[QQ Send] text accepted', {
      operationId,
      durationMs: Date.now() - startedAt,
      messageId: response.id,
      referenceId: response.ext_info?.ref_idx,
    });
    const appId = frozen.accountId;
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

  async sendImage(imagePath: string, target?: SendTarget): Promise<string | undefined> {
    let sendStarted = false;
    try {
      if (!this._connected) throw new Error('QQ Bot 尚未连接');
      const frozen = await this.freezeSendTarget(target);
      const openId = frozen.peerId;
      const file = await fs.promises.readFile(imagePath);
      const fileName = path.basename(imagePath);
      const operationId = log.nextId('qq-media');
      const startedAt = Date.now();
      log.info('[QQ Media] image upload started', {
        operationId,
        openId,
        bytes: file.length,
        extension: path.extname(fileName).toLowerCase(),
      });

      const fileInfo = await this.uploadMedia(openId, file, fileName, 1, operationId, frozen);

      const sendBody: Record<string, unknown> = {
        msg_type: 7,
        media: { file_info: fileInfo },
      };
      await this.applyRecentPassiveReply(openId, sendBody, frozen, Boolean(target));
      log.info('[QQ Send] sending image message', {
        operationId,
        openId,
        mode: sendBody.msg_id ? 'passive' : 'proactive',
        replySequence: sendBody.msg_seq,
        replyContextKey: this.messageKey(sendBody.msg_id),
      });
      sendStarted = true;
      const response = await this.sendMessage(openId, sendBody, true, FILE_REQUEST_TIMEOUT_MS, frozen);
      log.info('[QQ Send] image accepted', {
        operationId,
        durationMs: Date.now() - startedAt,
        messageId: response.id,
        referenceId: response.ext_info?.ref_idx,
      });
      const appId = frozen.accountId;
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
    } catch (error) {
      if (sendStarted || error instanceof FileSendError) throw error;
      // Upload/merge use srv_send_msg=false; no peer message exists yet.
      const message = error instanceof Error ? error.message : '图片准备失败';
      throw new FileSendError(message.replace(/https?:\/\/[^\s"'<>]+/gi, '[链接已隐藏]'));
    }
  }

  async sendFile(filePath: string, originalName?: string, target?: SendTarget): Promise<string | undefined> {
    let sendStarted = false;
    try {
      if (!this._connected) throw new Error('QQ Bot 尚未连接');
      const frozen = await this.freezeSendTarget(target);
      let file: Buffer;
      try {
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) throw new FileSendError('请选择普通文件');
        if (stat.size <= 0) throw new FileSendError('文件为空，无法发送');
        if (stat.size > MAX_FILE_BYTES) throw new FileSendError('文件超过 20 MiB 发送限制');
        file = await fs.promises.readFile(filePath);
      } catch (error) {
        if (error instanceof FileSendError) throw error;
        throw new FileSendError('无法读取待发送文件，请重新选择文件。');
      }
      if (!file.length) throw new Error('文件为空，无法发送');
      if (file.length > MAX_FILE_BYTES) throw new Error('文件超过 20 MiB 发送限制');
      const fileName = sanitizeFileName(originalName ?? path.basename(filePath));
      const openId = frozen.peerId;
      const appId = frozen.accountId;
      const operationId = log.nextId('qq-file');
      const startedAt = Date.now();
      log.info('[QQ Media] file upload started', {
        operationId, bytes: file.length, extension: path.extname(fileName).toLowerCase(),
      });
      const fileInfo = await this.uploadMedia(openId, file, fileName, 4, operationId, frozen);
      const sendBody: Record<string, unknown> = { msg_type: 7, media: { file_info: fileInfo } };
      await this.applyRecentPassiveReply(openId, sendBody, frozen, Boolean(target));
      // The upload uses srv_send_msg=false, so failures above cannot have sent a chat message.
      // From this boundary a timeout or persistence error may follow an accepted message.
      sendStarted = true;
      const response = await this.sendMessage(openId, sendBody, false, FILE_REQUEST_TIMEOUT_MS, frozen);
      if (typeof response?.id !== 'string' || !response.id.trim()) return 'QQ 文件消息未返回消息 ID，无法确认是否已送达；请先在 QQ 中核实，避免重复发送。';
      log.info('[QQ Send] file accepted', {
        operationId, durationMs: Date.now() - startedAt, messageId: response.id,
      });
      const chatMessage: Omit<ChatMessage, 'id'> = {
        direction: 'sent', type: MsgType.File, content: `[文件：${fileName}]`,
        parts: [{ type: MsgType.File, fileName, size: file.length }],
        timestamp: this.responseTimestamp(response.timestamp), context_token: '',
        from_user_id: appId, to_user_id: openId, message_id: response.id,
        reference_id: response.ext_info?.ref_idx, reply_to: null,
      };
      const id = await this.db.insertMessage(chatMessage);
      this._onMessage.fire({ ...chatMessage, id });
      return undefined;
    } catch (error) {
      if (sendStarted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new FileSendError(message.replace(/https?:\/\/[^\s"'<>]+/gi, '[链接已隐藏]'));
    }
  }

  async downloadFile(part: ChatMessagePart, signal?: AbortSignal): Promise<Buffer> {
    const spec = getFileDownloadSpec(part, this.channelName);
    if (!spec) throw new Error('该 QQ 附件没有可用的下载地址');
    return downloadFileBytes(spec, { dispatcher: this.getProxyAgent(), signal });
  }

  private async uploadMedia(openId: string, file: Buffer, fileName: string, fileType: 1 | 4, operationId: string, target?: SendTarget): Promise<string> {
    const userPath = `/v2/users/${encodeURIComponent(openId)}`;
    const prepared = await this.requestApi<UploadPrepareResponse>(`${userPath}/upload_prepare`, {
      method: 'POST',
      signal: AbortSignal.timeout(FILE_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        file_type: fileType,
        file_size: String(file.length),
        file_name: fileName,
        md5: crypto.createHash('md5').update(file).digest('hex'),
        sha1: crypto.createHash('sha1').update(file).digest('hex'),
        md5_10m: crypto.createHash('md5').update(file.subarray(0, MD5_10M_BYTES)).digest('hex'),
      }),
    }, true, target);
    if (typeof prepared.upload_id !== 'string' || !prepared.upload_id) {
      throw new Error('QQ 媒体预上传未返回 upload_id');
    }
    log.info('[QQ Media] upload prepared', {
      operationId,
      uploadId: prepared.upload_id,
      partCount: prepared.parts?.length || 0,
      blockSize: prepared.block_size,
    });

    const defaultBlockSize = Number(prepared.block_size);
    if (!Number.isSafeInteger(defaultBlockSize) || defaultBlockSize <= 0) {
      throw new Error('QQ 媒体预上传返回了无效 block_size');
    }
    const parts = (Array.isArray(prepared.parts) ? prepared.parts : []).map((part) => ({
      ...part,
      resolvedIndex: Number(part.index ?? part.part_index),
      resolvedUrl: part.presigned_url || part.upload_url || '',
    }));
    if (!parts.length) throw new Error('QQ 媒体预上传未返回分片地址');
    if (parts.some((part) => !Number.isSafeInteger(part.resolvedIndex) || !part.resolvedUrl)) {
      throw new Error('QQ 媒体预上传返回了无效分片信息');
    }
    const indexBase = parts.some((part) => part.resolvedIndex === 0) ? 0 : 1;
    parts.sort((a, b) => a.resolvedIndex - b.resolvedIndex);
    if (parts.length !== Math.ceil(file.length / defaultBlockSize)) throw new Error('QQ 媒体预上传分片未覆盖完整文件');
    for (const [offset, part] of parts.entries()) {
      const partSize = part.block_size === undefined ? defaultBlockSize : Number(part.block_size);
      const requiredSize = Math.min(defaultBlockSize, file.length - offset * defaultBlockSize);
      if (part.resolvedIndex !== indexBase + offset || !Number.isSafeInteger(partSize)
          || partSize < requiredSize || partSize > defaultBlockSize) {
        throw new Error('QQ 媒体预上传返回了重复、缺失或无效分片');
      }
      const url = new URL(part.resolvedUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('QQ 媒体预上传返回了无效分片地址');
      }
      if (fileType === 4) {
        // COS presigned uploads can use hosts outside the inbound QQ CDN list.
        // Only accept HTTPS public-looking hostnames from the authenticated API;
        // literal IPs, local names and redirects must never receive file bytes.
        const host = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || (url.port && url.port !== '443')
            || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || host.endsWith('.')
            || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home)$/.test(host)
            || /[\u0000-\u0020\u007f\\]/.test(part.resolvedUrl)) {
          throw new Error('QQ 文件预上传返回了不安全的分片地址');
        }
      }
    }
    for (const [offset, part] of parts.entries()) {
      const start = offset * defaultBlockSize;
      const chunk = file.subarray(start, Math.min(start + defaultBlockSize, file.length));
      await this.assertTargetAccount(target);
      await this.putUploadPart(part.resolvedUrl, chunk, part.resolvedIndex, FILE_REQUEST_TIMEOUT_MS, target);
      await this.finishUploadPart(userPath, {
        upload_id: prepared.upload_id,
        part_index: part.resolvedIndex,
        block_size: String(chunk.length),
        md5: crypto.createHash('md5').update(chunk).digest('hex'),
      }, FILE_REQUEST_TIMEOUT_MS, target);
    }

    const media = await this.requestApi<MediaUploadResponse>(`${userPath}/files`, {
      method: 'POST',
      signal: AbortSignal.timeout(FILE_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({ upload_id: prepared.upload_id, file_type: fileType, file_name: fileName, srv_send_msg: false }),
    }, true, target);
    const fileInfo = media.file_info;
    if (typeof fileInfo !== 'string' || !fileInfo.trim()) throw new Error('QQ 媒体合并未返回 file_info');
    log.info('[QQ Media] upload merged', { operationId });
    return fileInfo;
  }

  async getDecryptedImageUrl(messageId: number, partIndex?: number): Promise<string | undefined> {
    try {
      const filePath = path.join(this.context.globalStorageUri.fsPath, 'qq-images', `${imageCacheKey(messageId, partIndex)}.json`);
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
    this.accessTokenCredentialKey = '';
    await this.clearSession();
    await this.context.secrets.delete(QQ_APP_ID_SECRET);
    await this.context.secrets.delete(QQ_APP_SECRET_SECRET);
    this.emitStatus('QQ Bot 已断开，凭据已清除');
  }

  private async sendMessage(openId: string, body: Record<string, unknown>, requireMessageId = true, timeoutMs?: number, target?: SendTarget): Promise<SendMessageResponse> {
    await this.assertTargetAccount(target);
    let response: SendMessageResponse;
    try {
      response = await this.requestApi<SendMessageResponse>(
        `/v2/users/${encodeURIComponent(openId)}/messages`,
        { method: 'POST', body: JSON.stringify(body), ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}) }, true, target
      );
    } catch (error) {
      if (error instanceof QqBotError && error.definitelyRejected) throw new FileSendError(error.message);
      throw error;
    }
    if (requireMessageId && !response.id) throw new Error('QQ 消息接口未返回消息 ID，无法确认已送达');
    return response;
  }

  private async requestApi<T>(urlPath: string, init: RequestInit = {}, retryAuth = true, target?: SendTarget): Promise<T> {
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
    await this.assertTargetAccount(target);
    const token = await this.getAccessToken(false, init.signal, target);
    await this.assertTargetAccount(target);
    const response = await fetch(`${API_BASE_URL}${urlPath}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': 'VsChat/0.9.5',
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
      await this.assertTargetAccount(target);
      await this.getAccessToken(true, init.signal, target);
      return this.requestApi<T>(urlPath, init, false, target);
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
        retryable,
        (response.status >= 400 && response.status < 500 && response.status !== 408)
          || (response.ok && businessCode !== 0)
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

  private async getAccessToken(force = false, signal?: AbortSignal | null, target?: SendTarget): Promise<string> {
    await this.assertTargetAccount(target);
    const credentials = await this.getCredentials();
    const credentialKey = this.credentialKey(credentials);
    if (target && (credentials.appId !== target.accountId || (target.sessionKey && target.sessionKey !== credentialKey))) {
      throw new FileSendError('QQ Bot 凭据已变化，请重新选择收件人');
    }
    if (!force && this.accessToken && this.accessTokenCredentialKey === credentialKey
        && Date.now() < this.accessTokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      log.debug('[QQ Auth] using cached access token', {
        expiresInSeconds: Math.max(0, Math.floor((this.accessTokenExpiresAt - Date.now()) / 1000)),
      });
      return this.accessToken;
    }
    const { appId, appSecret } = credentials;
    const requestId = log.nextId('qq-auth');
    const startedAt = Date.now();
    log.info('[QQ Auth] requesting access token', { requestId, appId, force });
    const response = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'VsChat/0.9.5',
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
    if (this.credentialKey(await this.getCredentials()) !== credentialKey) {
      throw new FileSendError('QQ Bot 凭据在刷新期间变化，请重新选择收件人');
    }
    this.accessToken = data.access_token;
    this.accessTokenExpiresAt = Date.now() + expiresIn * 1000;
    this.accessTokenCredentialKey = credentialKey;
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
  private async applyRecentPassiveReply(openId: string, body: Record<string, unknown>, target?: SendTarget, requirePassive = false): Promise<void> {
    const reply = await this.reserveReply(openId, undefined, target);
    if (!reply) {
      if (requirePassive) throw new FileSendError('此 QQ 联系人的被动回复额度已用尽或过期，请等待对方的新消息');
      log.warn('[QQ Send] no usable passive reply context; falling back to proactive mode', {
        openId, hint: '请在 QQ 中给机器人发送一条新消息以获得新的被动回复额度',
      });
      return;
    }
    body.msg_id = reply.messageId;
    body.msg_seq = reply.sequence;
    log.debug('[QQ Send] passive reply selected', {
      openId,
      replyContextKey: this.messageKey(reply.messageId),
      sequence: reply.sequence,
      inboundAgeSeconds: Math.floor(Date.now() / 1000) - reply.timestamp,
    });
  }

  private replyOptions(appId: string, openId: string, messageId?: string) {
    return {
      appId, openId, messageId,
      nowSeconds: Math.floor(Date.now() / 1000),
      windowSeconds: C2C_PASSIVE_REPLY_WINDOW_SECONDS,
      maxReplies: C2C_MAX_PASSIVE_REPLIES,
    };
  }

  private async reserveReply(openId: string, messageId?: string, target?: SendTarget) {
    await this.assertTargetAccount(target);
    return this.db.reserveQqReply(this.replyOptions(target?.accountId || await this.getAppId(), openId, messageId));
  }

  private messageKey(value: unknown): string | undefined {
    return typeof value === 'string' && value
      ? crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)
      : undefined;
  }

  private async putUploadPart(url: string, chunk: Buffer, index: number, timeoutMs?: number, target?: SendTarget): Promise<void> {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.assertTargetAccount(target);
      const startedAt = Date.now();
      try {
        const response = await fetch(url, {
          method: 'PUT',
          body: chunk,
          redirect: 'error',
          ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
          headers: {
            'Content-Type': 'application/octet-stream',
            // fetch computes Content-Length from the Buffer body. Avoid supplying
            // a second length header through VS Code's networking integration.
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
      } catch (error) {
        const safeCode = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : undefined;
        const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown; message?: unknown } }).cause : undefined;
        const parameterReasons: Record<string, string> = {
          'duplicate content-length header': 'duplicate_content_length',
          'invalid content-length header': 'invalid_content_length',
          'invalid transfer-encoding header': 'invalid_transfer_encoding',
          'invalid connection header': 'invalid_connection',
          'invalid keep-alive header': 'invalid_keep_alive',
          'invalid upgrade header': 'invalid_upgrade',
          'invalid header key': 'invalid_header_key',
          'invalid header value': 'invalid_header_value',
          'invalid path': 'invalid_path',
          'Proxy Authentication Required (407)': 'proxy_auth_required',
          'Proxy-Authorization should be sent in ProxyAgent constructor': 'proxy_auth_header',
        };
        const parameterReason = typeof cause?.message === 'string'
          ? parameterReasons[cause.message] : undefined;
        const failureReason = parameterReason || (cause?.message === 'bad port' ? 'blocked_port'
          : cause?.message === 'unexpected redirect' ? 'redirect_blocked' : undefined);
        const networkCode = safeCode(cause?.code) || safeCode((error as { code?: unknown })?.code);
        log.warn('[QQ Media] upload part network failure', {
          networkCode, failureReason,
          errorType: error instanceof TypeError ? 'TypeError' : error instanceof Error && error.name === 'AbortError' ? 'AbortError' : 'Error',
          index,
          attempt: attempt + 1,
          durationMs: Date.now() - startedAt,
        });
        if (networkCode === 'UND_ERR_INVALID_ARG') {
          throw new Error(`QQ 媒体分片 ${index} 上传请求参数错误（${networkCode}${parameterReason ? ` / ${parameterReason}` : ''}），已停止重试，请提供此错误代码以便排查`);
        }
        if (attempt === 2) throw new Error(`QQ 媒体分片 ${index} 上传失败${networkCode ? `（${networkCode}）` : ''}，请检查网络后重试`);
      }
      if (attempt < 2) {
        const delayMs = 1_000 * (2 ** attempt);
        log.debug('[QQ Media] retrying upload part', { index, nextAttempt: attempt + 2, delayMs });
        await this.sleep(delayMs);
      }
    }
    throw new Error(`QQ 媒体分片 ${index} 上传失败：HTTP ${lastStatus || 'network error'}`);
  }

  private async finishUploadPart(userPath: string, body: Record<string, unknown>, timeoutMs?: number, target?: SendTarget): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.requestApi(`${userPath}/upload_part_finish`, {
          method: 'POST',
          ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
          body: JSON.stringify(body),
        }, true, target);
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

  private sendGateway(payload: GatewayPayload, connection = this.activeGateway): boolean {
    if (!connection || !this.isCurrent(connection)) return false;
    if (connection.socket.readyState !== WebSocket.OPEN) {
      this.failGateway(connection, 'QQ Gateway 连接已不可用');
      return false;
    }
    try {
      connection.socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      this.failGateway(connection, 'QQ Gateway 发送控制帧失败', error);
      return false;
    }
  }

  private detachGateway(connection: GatewayConnection, reason: string, closeSocket = true): void {
    if (connection.closed) return;
    connection.closed = true;
    connection.controller.abort();
    for (const timer of [connection.heartbeatTimer, connection.ackTimer, connection.readyTimer]) {
      if (timer) this.cancelTimer(timer);
    }
    connection.heartbeatTimer = connection.ackTimer = connection.readyTimer = undefined;
    connection.awaitingAck = false;
    for (const item of connection.queue.splice(0)) {
      connection.queuedBytes -= item.bytes;
      item.reject(new Error('QQ Gateway connection ended before dispatch completed'));
    }
    if (this.activeGateway === connection) {
      this.activeGateway = undefined;
      this.socket = null;
      this._connected = false;
    }
    if (closeSocket && connection.socket.readyState < WebSocket.CLOSING) {
      try { connection.socket.close(4000, reason.slice(0, 80)); }
      catch { /* The connection is fenced even if its transport cannot close. */ }
    }
  }

  private failGateway(connection: GatewayConnection, detail: string, error?: unknown): void {
    if (!this.isCurrent(connection)) return;
    log.warn('[QQ Gateway] reconnecting after failure', { detail }, error ? log.formatError(error) : undefined);
    this.detachGateway(connection, 'connection recovery');
    this.scheduleReconnect(detail);
  }

  private async handleGatewayClose(code: number, connection: GatewayConnection): Promise<void> {
    if (!this.shouldRun || connection.generation !== this.gatewayGeneration) return;
    log.warn('[QQ Gateway] socket closed', { code, sequence: connection.sequence });
    if ([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915].includes(code)) {
      this.shouldRun = false;
      this.setHealth('error', `QQ Gateway 拒绝连接（${code}），请检查机器人权限、分片或平台状态后重新连接`);
      return;
    }
    if (code === 4006 || code === 4007 || (code >= 4900 && code <= 4913)) {
      await this.clearSession(connection.sessionId);
    }
    if (!this.shouldRun || connection.generation !== this.gatewayGeneration) return;
    if (code === 4008) this.reconnectDelay = Math.max(this.reconnectDelay, 60_000);
    this.scheduleReconnect(`QQ 连接中断（${code || '网络异常'}）`);
  }

  private scheduleReconnect(detail = 'QQ 连接中断'): void {
    if (!this.shouldRun || this.disposed || this.reconnectTimer || this.activeGateway) return;
    if (this.pendingDispatchWork) {
      this.setHealth('reconnecting', `${detail}；等待未完成消息处理结束后重连…`);
      return;
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    this.setHealth('reconnecting', `${detail}，${delay / 1000} 秒后重连…`, this.now() + delay);
    this.reconnectTimer = this.after(delay, () => {
      this.reconnectTimer = undefined;
      void this.connectGateway();
    });
  }

  private async clearSession(expectedSessionId?: string): Promise<void> {
    this.forceIdentify = true;
    this.resumeCheckpoint = undefined;
    this.sessionId = '';
    this.sequence = null;
    // A cancelled handler may already be inside the atomic DB write. Its
    // completion must precede clearing an invalid checkpoint.
    await this.pendingDispatchWork?.catch(() => {});
    if (expectedSessionId) await this.db.clearQqGatewayCheckpoint(expectedSessionId);
    else if (expectedSessionId === undefined) await this.db.clearQqGatewayCheckpoint();
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

  private async persistImage(messageId: number, dataUrl: string, partIndex?: number): Promise<void> {
    await persistImageCache(this.context.globalStorageUri.fsPath, 'qq', messageId, dataUrl, partIndex);
    // Release the media lock before taking the DB lock (DB -> media order).
    await this.db.markMessageMediaReady(messageId);
    log.debug('[QQ Media] image persisted', { dbId: messageId, bytes: Buffer.byteLength(dataUrl) });
  }

  private emitStatus(status: string): void {
    log.debug('[QQ Status]', status);
    this._onStatus.fire(status);
  }

  dispose(): void {
    log.debug('[QQ] disposing client');
    this.stopPolling();
    this.disposed = true;
    this._onConnectionHealth.dispose();
    this._onMessage.dispose();
    this._onStatus.dispose();
    this._onQrCode.dispose();
    this._onLoginSuccess.dispose();
  }
}
