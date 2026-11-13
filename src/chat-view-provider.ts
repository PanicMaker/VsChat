import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { ChatClient } from './chat-client';
import { ChatDB, ChatSyncCursor, ChatSyncSnapshot } from './chat-db';
import { previewForNotification } from './push';
import { WebViewOutbound, WebViewInbound, ChatMessage } from './types';
import * as log from './logger';
import { safeExternalUrl } from './markdown-content';
import { HistoryPresentation } from './history-presentation';
import { attachmentParts, FileActions } from './file-actions';
import { FileSendError, sanitizeFileName } from './file-transfer';
import { ArchiveActions } from './archive-actions';
import { ConversationRef, RecipientOption, SendTarget, sameConversation } from './recipient-types';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vschat.chatView';

  private view: vscode.WebviewView | null = null;
  private disposables: vscode.Disposable[] = [];
  private lifetimeDisposables: vscode.Disposable[] = [];
  private statusBar: vscode.StatusBarItem | undefined;
  private syncTimer: ReturnType<typeof setInterval> | undefined;
  private syncCursor: ChatSyncCursor | undefined;
  private syncStamp: string | undefined;
  private viewReady = false;
  private started = false;
  private disposed = false;
  private pendingReveal = false;
  private pendingRecipientReveal: string | undefined;
  private backgroundSyncPending = false;
  private searchRequestId: string | undefined;
  private contextRequestId: string | undefined;
  private historyStartId: number | undefined;
  private historyPending: Promise<void> = Promise.resolve();
  private viewGeneration = 0;
  private sendResults = new Map<string, WebViewInbound>();
  // Keep only IDs after result eviction; a replay must never deliver twice.
  private seenSendRequests = new Set<string>();
  private static readonly maxSendResults = 100;
  private readonly files: FileActions;
  private readonly archives: ArchiveActions;
  private readonly presentation: HistoryPresentation;
  private recipientOptions = new Map<string, RecipientOption>();
  private selectedRecipientId: string | undefined;
  private selectionId: string | undefined;
  private selectionRequestId: string | undefined;
  private recipientAccount: string | undefined;
  private lastRecipientsRefresh = 0;
  private totalUnreadCount = 0;
  private recipientUnreadBaseline: Map<string, number> | undefined;
  private recipientRefreshVersion = 0;

  private get recipientMode(): boolean { return !!this.client.getRecipients && !!this.client.captureSendTarget; }
  private get conversation(): ConversationRef | undefined {
    return this.selectedRecipientId ? this.recipientOptions.get(this.selectedRecipientId)?.conversation : undefined;
  }
  private matchesSelection(message: WebViewOutbound): boolean {
    return !this.recipientMode || (!!this.selectedRecipientId && message.recipientId === this.selectedRecipientId
      && message.selectionId === this.selectionId && this.selectionRequestId === this.selectionId);
  }

  private async refreshRecipients(): Promise<void> {
    if (!this.client.getRecipients || !this.recipientMode) return;
    const version = ++this.recipientRefreshVersion;
    const state = await this.client.getRecipients();
    const totalUnreadCount = Number.isSafeInteger(state.totalUnreadCount) && state.totalUnreadCount! >= 0
      ? state.totalUnreadCount! : state.accountId ? await this.db.getTotalUnreadCount(state.accountId) : 0;
    if (this.disposed || version !== this.recipientRefreshVersion) return;
    const sameAccount = this.recipientAccount === state.accountId;
    const previousUnread = sameAccount ? this.recipientUnreadBaseline : undefined;
    this.recipientAccount = state.accountId;
    this.recipientOptions = new Map(state.recipients.map(option => [option.id, option]));
    this.recipientOptions.set('__history__', { id: '__history__', label: '全部历史（只读）', canSend: false,
      reason: '这里包含当前通道全部联系人及旧记录。请选择明确的联系人后发送。', unreadCount: 0 });
    this.totalUnreadCount = totalUnreadCount;
    this.lastRecipientsRefresh = Date.now();
    if (this.selectedRecipientId && !this.recipientOptions.has(this.selectedRecipientId)) {
      this.selectedRecipientId = undefined;
      this.selectionId = undefined;
      this.viewGeneration++;
      this.syncCursor = undefined;
      this.historyStartId = undefined;
      this.postMessage({ command: 'recipientInvalidated', error: '当前账号或联系人已变化，请重新选择收件人；原草稿仍保留。' });
    }
    this.updateUnreadStatus(this.totalUnreadCount);
    this.postMessage({ command: 'recipients', recipients: [...this.recipientOptions.values()],
      recipientReason: state.reason, totalUnreadCount: this.totalUnreadCount });
    this.recipientUnreadBaseline = new Map(state.recipients.map(option => [option.id, option.unreadCount || 0]));
    const incoming = previousUnread && state.recipients.find(option => (option.unreadCount || 0) > (previousUnread.get(option.id) || 0));
    if (incoming && vscode.window.state.focused && !this.view?.visible) {
      void Promise.resolve(vscode.window.showInformationMessage(`${this.client.channelName} · ${incoming.label}：有新消息`, '打开聊天'))
        .then(async action => {
          if (action !== '打开聊天' || this.disposed) return;
          this.pendingRecipientReveal = incoming.id;
          await this.revealLatest();
        }).catch(error => this.reportSyncError(error));
    }
  }

  private selectRecipient(message: WebViewOutbound): Promise<void> {
    const requestId = message.requestId;
    if (!this.recipientMode || typeof requestId !== 'string' || !requestId || requestId.length > 128) return Promise.resolve();
    this.selectionRequestId = requestId;
    return this.enqueueHistory(async () => {
      if (this.selectionRequestId !== requestId) return;
      try {
        await this.refreshRecipients();
        if (this.selectionRequestId !== requestId) return;
        if (typeof message.recipientId !== 'string' || !this.recipientOptions.has(message.recipientId)) {
          throw new Error('该联系人已不可用，请刷新列表后重新选择。');
        }
        this.selectedRecipientId = message.recipientId;
        this.selectionId = requestId;
        this.viewGeneration++;
        this.syncCursor = undefined;
        this.syncStamp = undefined;
        this.historyStartId = undefined;
        this.searchRequestId = undefined;
        this.contextRequestId = undefined;
        this.postMessage({ command: 'recipientSelected', requestId, recipientId: message.recipientId, selectionId: requestId });
        await this.loadHistoryPage(undefined, this.viewGeneration);
      } catch (error) {
        if (this.selectionRequestId === requestId) {
          this.selectionRequestId = this.selectionId;
          this.postMessage({ command: 'recipientSelectionError', requestId,
            error: this.publicError(error, '联系人选择失败，请重试。') });
        }
      }
    });
  }

  constructor(
    private context: vscode.ExtensionContext,
    private client: ChatClient,
    private db: ChatDB
  ) {
    this.files = new FileActions(context, client, db, message => this.postMessage(message), () => this.viewGeneration);
    this.archives = new ArchiveActions(context, db, client.channelName.toLowerCase() === 'qq' ? 'qq' : 'wechat',
      message => this.postMessage(message), () => this.refreshSharedHistory(true));
    this.presentation = new HistoryPresentation((id, partIndex) => this.client.getDecryptedImageUrl(id, partIndex),
      (id, partIndex, error) => log.warn('[UI] image unavailable during history synchronization',
        { dbId: id, partIndex }, log.formatError(error)), undefined, client.channelName.toLowerCase() === 'qq');
  }

  /** Keep shared history and unread state current even before a panel exists. */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    this.statusBar = vscode.window.createStatusBarItem('vschat.unread', vscode.StatusBarAlignment.Left, 100);
    this.statusBar.name = `VsChat · ${this.client.channelName}`;
    this.statusBar.command = 'vschat.openChat';
    this.updateUnreadStatus(0);
    this.statusBar.show();
    this.lifetimeDisposables.push(
      this.client.onMessage(() => this.scheduleSync(true)),
      this.client.onStatus(status => { this.postMessage({ command: 'status', status }); this.scheduleSync(true); }),
      this.client.onQrCode(qrcode => this.postMessage({ command: 'qrcode', qrcode })),
      this.client.onLoginSuccess(() => {
        // A count-only delta must not leave a successful login on the QR screen.
        void this.loadHistory().catch(err => this.reportSyncError(err));
      }),
      vscode.window.onDidChangeWindowState(state => {
        this.postMessage({ command: 'hostFocus', focused: state.focused });
        if (state.focused) this.scheduleSync(true);
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('vschat.sendShortcut') || event.affectsConfiguration('vschat.renderMarkdown')) this.sendSettings();
        if (event.affectsConfiguration('vschat.qqUserOpenId')) this.scheduleSync(true);
      })
    );
    if (this.client.onConnectionHealth) {
      this.lifetimeDisposables.push(this.client.onConnectionHealth(health => {
        this.postMessage({ command: 'connectionHealth', connectionHealth: health });
      }));
    }
    try {
      await this.refreshSharedHistory(true);
    } catch (err) {
      this.reportSyncError(err);
    }
    if (!this.disposed) {
      this.syncTimer = setInterval(() => this.scheduleSync(false), 1500);
      this.syncTimer.unref?.();
    }
  }

  private scheduleSync(force: boolean): void {
    if (this.disposed || this.backgroundSyncPending) return;
    this.backgroundSyncPending = true;
    void this.refreshSharedHistory(force).catch(err => this.reportSyncError(err))
      .finally(() => { this.backgroundSyncPending = false; });
  }

  private reportSyncError(err: unknown): void {
    log.warn('[UI] shared history synchronization failed', { channel: this.client.channelName }, log.formatError(err));
    if (this.statusBar && !this.disposed) {
      this.statusBar.tooltip = `VsChat · ${this.client.channelName}：同步暂时失败，将自动重试；点击打开聊天`;
    }
  }

  private updateUnreadStatus(count: number): void {
    if (!this.statusBar || this.disposed) return;
    this.statusBar.text = `$(comment-discussion) ${this.client.channelName}${count ? ` · ${count}` : ''}`;
    this.statusBar.tooltip = count
      ? `VsChat · ${this.client.channelName}：${count} 条未读消息，点击打开聊天`
      : `VsChat · ${this.client.channelName}：没有未读消息，点击打开聊天`;
    this.statusBar.accessibilityInformation = { label: this.statusBar.tooltip };
  }

  private sendSettings(): void {
    const configured = vscode.workspace.getConfiguration('vschat').get<string>('sendShortcut', 'enter');
    const renderMarkdown = vscode.workspace.getConfiguration('vschat').get<boolean>('renderMarkdown', true) !== false;
    this.postMessage({ command: 'settings', sendShortcut: configured === 'ctrlEnter' ? 'ctrlEnter' : 'enter', renderMarkdown });
  }

  private enqueueHistory(operation: () => Promise<void>): Promise<void> {
    const task = this.historyPending.then(async () => {
      if (!this.disposed) await operation();
    });
    this.historyPending = task.catch(() => undefined);
    return task;
  }

  refreshSharedHistory(force = false): Promise<void> {
    return this.enqueueHistory(() => this.syncSharedHistory(force));
  }

  private async syncSharedHistory(force: boolean): Promise<void> {
    // Stat before reading: a write during hydration must still trigger the next
    // pass. Watching a single file inode would miss our atomic file replacements.
    const stamp = await this.db.getChangeStamp();
    const changed = stamp !== this.syncStamp;
    if (this.recipientMode && (force || changed || Date.now() - this.lastRecipientsRefresh > 15_000)) await this.refreshRecipients();
    if (!force && !changed) return;
    if (this.recipientMode && !this.selectedRecipientId) { this.syncStamp = stamp; return; }
    const generation = this.viewGeneration;
    const snapshot = await this.db.getSyncSnapshot(this.syncCursor, this.historyStartId, 100, false, this.conversation);
    await this.applySnapshot(snapshot, generation);
    this.syncStamp = stamp;
  }

  private withImages(messages: ChatMessage[], revision: { generation: string; contentVersion: number }): Promise<ChatMessage[]> {
    return this.presentation.hydrate(messages, JSON.stringify([revision.generation, revision.contentVersion]));
  }

  private async applySnapshot(snapshot: ChatSyncSnapshot, generation: number): Promise<void> {
    const previousCursor = this.syncCursor;
    const messages = this.viewReady ? await this.withImages(snapshot.messages, snapshot.cursor) : [];
    if (this.disposed || generation !== this.viewGeneration) return;
    this.syncCursor = snapshot.cursor;
    this.updateUnreadStatus(this.recipientMode ? this.totalUnreadCount : snapshot.unreadCount);
    if (generation === this.viewGeneration && this.viewReady) {
      if (snapshot.reset) this.historyStartId = messages[0]?.id;
      this.postMessage({
        command: 'syncMessages', generation: snapshot.cursor.generation,
        reset: snapshot.reset, messages, hasMore: snapshot.hasMore,
        unreadCount: this.recipientMode && !this.conversation ? 0 : snapshot.unreadCount,
        readThroughId: snapshot.readThroughId,
      });
    }
    // Only the focused window can toast; catch-up snapshots and read updates
    // never replay old notifications. Bark remains owned by the transport event.
    const incoming = previousCursor?.generation === snapshot.cursor.generation
      ? snapshot.messages.filter(msg => msg.direction === 'received'
        && !msg.restored
        && msg.id > Math.max(snapshot.readThroughId, previousCursor.lastId)) : [];
    if (!this.recipientMode && incoming.length && vscode.window.state.focused && !this.view?.visible) {
      const preview = previewForNotification(incoming[incoming.length - 1]);
      void Promise.resolve(vscode.window.showInformationMessage(`${this.client.channelName}: ${preview}`, '打开聊天'))
        .then(async action => { if (action === '打开聊天' && !this.disposed) await this.revealLatest(); })
        .catch(err => this.reportSyncError(err));
    }
  }

  async revealLatest(): Promise<void> {
    if (this.disposed) return;
    this.pendingReveal = true;
    await vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    this.view?.show(false);
    await this.refreshSharedHistory(true);
    this.revealWhenReady();
  }

  private revealWhenReady(): void {
    if (!this.pendingReveal || !this.viewReady) return;
    this.pendingReveal = false;
    if (this.pendingRecipientReveal) {
      const recipientId = this.pendingRecipientReveal;
      this.pendingRecipientReveal = undefined;
      this.postMessage({ command: 'revealRecipient', recipientId });
      return;
    }
    this.postMessage({ command: 'revealLatest' });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.archives.invalidatePreviews();
    this.view = webviewView;
    this.viewReady = false;
    this.searchRequestId = undefined;
    this.contextRequestId = undefined;
    this.viewGeneration += 1;
    this.historyStartId = undefined;
    if (this.recipientMode) {
      this.selectedRecipientId = undefined;
      this.selectionId = undefined;
      this.selectionRequestId = undefined;
      this.syncCursor = undefined;
    }
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

    // View listeners are separate from the panel-independent sync lifecycle.
    this.disposables.push(
      webviewView.onDidChangeVisibility(() => {
        this.postMessage({ command: 'hostFocus', focused: vscode.window.state.focused });
        if (this.client.connectionHealth) this.postMessage({ command: 'connectionHealth', connectionHealth: this.client.connectionHealth });
        if (webviewView.visible) this.scheduleSync(true);
      }),
      webviewView.onDidDispose(() => {
        if (this.view !== webviewView) return;
        this.archives.invalidatePreviews();
        this.view = null;
        this.viewReady = false;
        this.historyStartId = undefined;
        this.viewGeneration += 1;
      })
    );

    // The webview's ready message loads persisted history even while offline.
  }

  private async handleWebViewMessage(msg: WebViewOutbound): Promise<void> {
    if (!msg || typeof msg.command !== 'string') return;
    const operationId = log.nextId('ui');
    log.debug('[UI] command received', {
      operationId,
      command: msg.command,
      textLength: msg.text?.length || 0,
      imageDataLength: msg.imageData?.length || 0,
      hasReply: Boolean(msg.replyTo),
    });
    try {
      if (msg.command === 'selectRecipient') {
        await this.selectRecipient(msg);
      } else if (msg.command === 'refreshRecipients') {
        await this.refreshSharedHistory(true);
      } else if (msg.command === 'sendMessage' || msg.command === 'sendImage' || msg.command === 'sendFile') {
        await this.handleSend(msg, operationId);
      } else if (msg.command === 'selectFile') {
        if (!this.matchesSelection(msg) || (this.recipientMode && !this.conversation)) return;
        await this.files.select(msg);
      } else if (msg.command === 'getFileDraft') {
        if (!this.matchesSelection(msg)) return;
        this.files.status(msg.fileId, msg.recipientId, msg.selectionId);
      } else if (msg.command === 'removeFileDraft') {
        // A late selection result may be released after the user switched.
        // FileActions checks its immutable owner; only staged copies are removed.
        this.files.remove(msg.fileId, msg.recipientId);
      } else if (msg.command === 'saveAttachment') {
        try {
          if (!this.matchesSelection(msg)) throw new Error('会话已变化，请在原联系人中重新保存附件。');
          if (this.recipientMode) {
            if (!msg.generation || msg.generation !== this.syncCursor?.generation) {
              throw new Error('聊天历史已变化，请重新定位附件。');
            }
            const version = this.viewGeneration;
            const found = await this.db.getMessageContext({ id: msg.targetId }, msg.generation, 0, this.conversation);
            if (!found || version !== this.viewGeneration || !this.matchesSelection(msg)) {
              throw new Error('该附件不属于当前联系人，或会话已变化。');
            }
          }
          await this.files.save(msg);
        } catch (error) {
          this.postMessage({ command: 'attachmentStatus', requestId: msg.requestId, fileStatus: 'failed',
            recipientId: msg.recipientId, selectionId: msg.selectionId,
            error: error instanceof Error ? error.message : '无法保存附件，请重试。' });
        }
      } else if (msg.command === 'cancelAttachment') {
        this.files.cancel(msg.requestId);
      } else if (msg.command.startsWith('data')) {
        await this.archives.handle(msg);
      } else if (msg.command === 'getSendStatus' && typeof msg.requestId === 'string') {
        this.postMessage(this.sendResults.get(msg.requestId) || { ...this.unknownSendResult(msg.requestId),
          recipientId: msg.recipientId, selectionId: msg.selectionId });
      } else if (msg.command === 'copyText') {
        await this.copyText(msg);
      } else if (msg.command === 'ready') {
        this.viewReady = true;
        this.sendSettings();
        if (this.client.connectionHealth) this.postMessage({ command: 'connectionHealth', connectionHealth: this.client.connectionHealth });
        this.postMessage({ command: 'channel', channel: this.client.channelName });
        this.postMessage({ command: 'fileCapabilities', fileCapabilities: this.files.capabilities() });
        this.postMessage({ command: 'hostFocus', focused: vscode.window.state.focused });
        if (this.recipientMode) await this.refreshRecipients();
        await this.loadHistory();
        this.revealWhenReady();
      } else if (msg.command === 'requestSync') {
        await this.refreshSharedHistory(true);
      } else if (msg.command === 'searchHistory' || msg.command === 'loadMessageContext') {
        if (!this.matchesSelection(msg)) return;
        await this.handleHistoryQuery(msg);
      } else if (msg.command === 'markRead') {
        await this.enqueueHistory(async () => {
          if (!this.matchesSelection(msg) || (this.recipientMode && !this.conversation)
            || !this.view?.visible || !vscode.window.state.focused || !this.viewReady
            || !this.syncCursor
            || msg.generation !== this.syncCursor?.generation
            || !Number.isSafeInteger(msg.throughId) || msg.throughId! < 0
            || msg.throughId! > this.syncCursor.lastId) return;
          await this.db.markRead(msg.generation!, msg.throughId!, this.conversation);
          await this.syncSharedHistory(true);
        });
      } else if (msg.command === 'login') {
        vscode.commands.executeCommand('vschat.login');
      } else if (msg.command === 'openExternal' && msg.url) {
        const url = safeExternalUrl(msg.url);
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
      } else if (msg.command === 'loadMoreHistory') {
        if (!this.matchesSelection(msg)) return;
        if (Number.isSafeInteger(msg.beforeId) && msg.beforeId! > 0) {
          if (!msg.generation || msg.generation === this.syncCursor?.generation) await this.loadHistory(msg.beforeId);
        }
      }
    } catch (err: any) {
      log.error('[UI] command failed', { operationId, command: msg.command, channel: this.client.channelName }, log.formatError(err));
      const scope = { recipientId: msg.recipientId, selectionId: msg.selectionId };
      this.postMessage({ command: 'error', error: this.publicError(err), ...scope });
      if (msg.command === 'loadMoreHistory') this.postMessage({ command: 'historyError', ...scope });
      if (msg.command === 'markRead') this.postMessage({ command: 'readStateError', ...scope });
    }
  }

  private publicError(error: unknown, fallback = '操作失败，请重试。'): string {
    // Node errors and transport wrappers can embed private storage paths.
    // Keep these details in host diagnostics, never in the webview protocol.
    const fileCodes = /\b(?:ENOENT|EACCES|EPERM|ENOTDIR|EISDIR|EIO|ENOSPC|EROFS|EMFILE|ENFILE|EEXIST|ELOOP|ENAMETOOLONG|EBADF)(?=[:\s]|$)/;
    const message = error instanceof Error ? error.message : '';
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (fileCodes.test(code) || fileCodes.test(message)) {
      return '无法读取或写入本地文件，请检查文件与权限后重试。';
    }
    return message || fallback;
  }

  private async copyText(msg: WebViewOutbound): Promise<void> {
    if (typeof msg.requestId !== 'string' || !msg.requestId || msg.requestId.length > 128) return;
    const generation = this.viewGeneration;
    try {
      if (typeof msg.text !== 'string' || msg.text.length > 1_000_000) {
        throw new Error('复制内容无效或超过 100 万字符。');
      }
      await vscode.env.clipboard.writeText(msg.text);
      if (!this.disposed && generation === this.viewGeneration) this.postMessage({ command: 'copyResult', requestId: msg.requestId });
    } catch {
      if (!this.disposed && generation === this.viewGeneration) {
        this.postMessage({ command: 'copyResult', requestId: msg.requestId, error: '复制失败，请重试或手动选择代码。' });
      }
    }
  }

  private handleHistoryQuery(msg: WebViewOutbound): Promise<void> {
    const requestId = msg.requestId;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 128) return Promise.resolve();
    const context = msg.command === 'loadMessageContext';
    if (context) this.contextRequestId = requestId;
    else this.searchRequestId = requestId;
    const viewGeneration = this.viewGeneration;
    const stillCurrent = () => !this.disposed && this.viewReady && viewGeneration === this.viewGeneration
      && requestId === (context ? this.contextRequestId : this.searchRequestId);
    return this.enqueueHistory(async () => {
      if (!stillCurrent()) return;
      try {
        if (!context) {
          const result = await this.db.searchMessages({
            query: msg.query ?? '', type: msg.type, fromTimestamp: msg.fromTimestamp,
            toTimestamp: msg.toTimestamp, beforeId: msg.beforeId, generation: msg.generation,
            conversation: this.conversation,
          });
          if (!stillCurrent()) return;
          await this.syncSharedHistory(false);
          if (!stillCurrent()) return;
          if (!result || result.generation !== this.syncCursor?.generation
            || result.contentVersion !== this.syncCursor.contentVersion) {
            throw new Error('聊天历史已更新，请重新搜索。');
          }
          this.postMessage({ command: 'searchResults', requestId, generation: result.generation,
            messages: result.messages, hasMore: result.hasMore });
        } else {
          const result = await this.db.getMessageContext({ id: msg.targetId, messageId: msg.messageId }, msg.generation, this.conversation);
          if (!stillCurrent()) return;
          const messages = result ? await this.withImages(result.messages, result) : [];
          await this.syncSharedHistory(false);
          if (!stillCurrent()) return;
          if (!result || result.generation !== this.syncCursor?.generation
            || result.contentVersion !== this.syncCursor.contentVersion) {
            throw new Error('无法定位这条消息，历史可能已清空或更新。');
          }
          this.postMessage({ command: 'messageContext', requestId, generation: result.generation,
            messages, targetId: result.targetId, hasBefore: result.hasBefore, hasAfter: result.hasAfter });
        }
      } catch (err) {
        // Queries and message text must not enter diagnostic logs.
        if (stillCurrent()) this.postMessage({ command: context ? 'contextError' : 'searchError', requestId,
          error: this.publicError(err, '历史查询失败，请重试。') });
      }
    });
  }

  private unknownSendResult(requestId: string): WebViewInbound {
    return {
      command: 'sendStatus', requestId, sendStatus: 'uncertain',
      error: '无法确认这次发送结果，请先检查聊天记录或收件端，再决定是否重发。',
    };
  }

  private reportSendResult(result: WebViewInbound): void {
    this.sendResults.set(result.requestId!, result);
    // Evict completed results first, retaining every in-flight request.
    for (const [id, previous] of this.sendResults) {
      if (this.sendResults.size <= ChatViewProvider.maxSendResults) break;
      if (previous.sendStatus !== 'sending') this.sendResults.delete(id);
    }
    this.postMessage(result);
  }

  private async handleSend(msg: WebViewOutbound, operationId: string): Promise<void> {
    if ((msg.command === 'sendFile' || this.recipientMode) && (typeof msg.requestId !== 'string' || !msg.requestId || msg.requestId.length > 128)) {
      this.postMessage({ command: 'error', error: '文件发送请求无效，请重新选择文件。' });
      return;
    }
    const requestId = typeof msg.requestId === 'string' && msg.requestId.length > 0
      ? msg.requestId : undefined;
    const scope = this.recipientMode ? { recipientId: msg.recipientId, selectionId: msg.selectionId } : {};
    if (requestId && this.seenSendRequests.has(requestId)) {
      this.postMessage(this.sendResults.get(requestId) || this.unknownSendResult(requestId));
      return;
    }
    if (requestId) {
      this.seenSendRequests.add(requestId);
      this.reportSendResult({ command: 'sendStatus', requestId, sendStatus: 'sending', ...scope });
    }

    let transportStarted = false;
    let tempPath: string | undefined;
    try {
      if (!this.client.connected) throw new Error('当前通道尚未连接，请连接后重试。');
      const version = this.viewGeneration;
      let target: SendTarget | undefined;
      let reply = msg.replyTo;
      if (this.recipientMode) {
        if (!this.matchesSelection(msg)) throw new Error('收件人尚未选择或正在切换，请确认发送目标后重试。');
        const option = this.recipientOptions.get(msg.recipientId!);
        if (!option?.conversation || !option.canSend) throw new Error(option?.reason || '该联系人当前不可发送。');
        target = await this.client.captureSendTarget!(option.id);
        if (!sameConversation(target, option.conversation)
          || target.channel !== (this.client.channelName.toLowerCase() === 'qq' ? 'qq' : 'wechat')) {
          throw new Error('发送目标校验失败，请重新选择联系人。');
        }
        target = Object.freeze({ ...target });
        if (reply) {
          if (typeof reply.messageId !== 'string' || !reply.messageId) throw new Error('引用消息无效。');
          const found = await this.db.getMessageContext({ messageId: reply.messageId }, msg.generation, 0, option.conversation);
          const original = found?.messages.find(message => message.id === found.targetId);
          if (!original || original.restored || (reply.direction && reply.direction !== original.direction)) {
            throw new Error('引用必须来自当前联系人的真实聊天记录，请重新选择引用。');
          }
          reply = { messageId: original.message_id!, referenceId: original.reference_id, direction: original.direction,
            type: original.type, text: original.type === 1 ? original.content : '[附件]', timestamp: original.timestamp };
        }
        if (version !== this.viewGeneration || !this.matchesSelection(msg)) {
          throw new Error('发送前收件人已切换，本次未发送；原联系人的草稿仍保留。');
        }
      }
      let warning: string | undefined;
      if (msg.command === 'sendMessage') {
        if (typeof msg.text !== 'string' || !msg.text.trim()) {
          throw new Error('Message is empty');
        }
        if (msg.replyTo !== undefined && (!msg.replyTo || typeof msg.replyTo.messageId !== 'string')) {
          throw new Error('Invalid reply reference');
        }
        transportStarted = true;
        warning = await this.client.sendText(msg.text, reply, target);
      } else if (msg.command === 'sendFile') {
        transportStarted = true;
        warning = await this.files.send(msg.fileId, target, msg.recipientId);
      } else {
        if (typeof msg.imageData !== 'string') throw new Error('Invalid image data');
        const match = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(msg.imageData);
        if (!match || match[1].length % 4 !== 0) throw new Error('Invalid image data');
        const image = Buffer.from(match[1], 'base64');
        if (image.length > 10 * 1024 * 1024) throw new Error('Image too large (max 10MB)');
        if (!image.length) throw new Error('Image is empty');
        const tempDir = path.join(this.context.globalStorageUri.fsPath, 'temp');
        fs.mkdirSync(tempDir, { recursive: true });
        const requestedExtension = path.extname(typeof msg.fileName === 'string' ? msg.fileName : '').toLowerCase();
        const safeExtension = /^\.(png|jpe?g|gif|webp|bmp)$/.test(requestedExtension)
          ? requestedExtension : '.png';
        tempPath = path.join(tempDir, `img_${randomUUID()}${safeExtension}`);
        fs.writeFileSync(tempPath, image);
        transportStarted = true;
        warning = await this.client.sendImage(tempPath, target);
      }
      if (requestId) {
        // The existing transport contract uses warnings for unconfirmed iLink
        // delivery (including accepted replies without message_id).
        this.reportSendResult({ command: 'sendStatus', requestId, sendStatus: warning ? 'uncertain' : 'sent', warning, ...scope });
      } else if (warning) {
        this.postMessage({ command: 'warning', warning });
      }
    } catch (err: any) {
      log.error('[UI] send failed', { operationId, command: msg.command, channel: this.client.channelName, transportStarted }, log.formatError(err));
      const error = this.publicError(err, '发送失败，请重试。');
      if (requestId) {
        this.reportSendResult({
          command: 'sendStatus', requestId, sendStatus: transportStarted && !(err instanceof FileSendError) ? 'uncertain' : 'failed', error, ...scope,
        });
      } else {
        this.postMessage({ command: 'error', error });
      }
    } finally {
      if (tempPath) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
    }
  }

  loadHistory(beforeId?: number): Promise<void> {
    const generation = this.viewGeneration;
    return this.enqueueHistory(() => this.loadHistoryPage(beforeId, generation));
  }

  private async loadHistoryPage(beforeId: number | undefined, generation: number): Promise<void> {
    if (generation !== this.viewGeneration) return;
    if (this.recipientMode && !this.selectedRecipientId) return;
    if (beforeId === undefined) {
      // Force a complete snapshot of the loaded range for ready/reconnection.
      const cursor = this.historyStartId !== undefined && this.syncCursor
        ? this.syncCursor : undefined;
      const stamp = await this.db.getChangeStamp();
      await this.applySnapshot(await this.db.getSyncSnapshot(cursor, this.historyStartId, 100, true, this.conversation), generation);
      this.syncStamp = stamp;
      return;
    }
    if (!this.syncCursor) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await this.db.getHistoryPage(beforeId, this.syncCursor.generation, 100, this.conversation);
      if (!page) {
        await this.syncSharedHistory(true);
        return;
      }
      const messages = await this.withImages(page.messages, page);
      // A clear or content change during image hydration invalidates this page.
      await this.syncSharedHistory(false);
      if (generation !== this.viewGeneration || page.generation !== this.syncCursor.generation || this.disposed) return;
      if (page.contentVersion !== this.syncCursor.contentVersion) continue;
      if (messages.length) this.historyStartId = Math.min(this.historyStartId ?? Infinity, messages[0].id);
      this.postMessage({ command: 'loadHistory', generation: page.generation, messages, hasMore: page.hasMore, older: true });
      return;
    }
    this.postMessage({ command: 'historyError' });
  }

  async clearHistory(): Promise<void> {
    log.info('[UI] clearing history', { channel: this.client.channelName });
    await this.enqueueHistory(async () => {
      await this.db.clearAll();
      this.historyStartId = undefined;
      // Do not recursively delete a shared media directory: another window can
      // already be receiving new images. Orphan cleanup needs its own GC pass.
      await this.syncSharedHistory(true);
    });
    log.info('[UI] history cleared', { channel: this.client.channelName });
  }

  private postMessage(msg: WebViewInbound): void {
    // This is the only Webview output boundary, including raw search results.
    // Download keys and signed file addresses belong exclusively to the host.
    const present = (message: ChatMessage): ChatMessage => {
      // Session tokens are transport state, never presentation data.
      message = { ...message, context_token: '' };
      const sourceParts = attachmentParts(message, this.client.channelName);
      if (!sourceParts) return message;
      const parts = sourceParts.map(part => {
        const { fileMedia: _private, fileAction: _oldAction, ...publicPart } = part;
        if (part.type !== 4) return publicPart;
        const { url: _fileUrl, ...metadata } = publicPart;
        return { ...metadata, fileName: sanitizeFileName(part.fileName), fileAction: this.files.availability(part) };
      });
      return { ...message, parts, ...(message.type === 4 ? { content: `[文件] ${parts[0]?.fileName || 'attachment'}` } : {}) };
    };
    const scoped = this.recipientMode && ['syncMessages', 'loadHistory', 'searchResults', 'messageContext',
      'searchError', 'contextError', 'historyError', 'readStateError', 'revealLatest'].includes(msg.command)
      && !Object.prototype.hasOwnProperty.call(msg, 'recipientId')
      ? { recipientId: this.selectedRecipientId, selectionId: this.selectionId } : {};
    this.view?.webview.postMessage({ ...scoped, ...msg,
      ...(msg.messages ? { messages: msg.messages.map(present) } : {}),
      ...(msg.message ? { message: present(msg.message) } : {}),
    });
  }

  private getHtml(): string {
    const webview = this.view!.webview;
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'styles.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'main.js'));
    const richContentUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'rich-content.js'));

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource}; img-src ${webview.cspSource} data: https:;">
        <link href="${stylesUri}" rel="stylesheet">
      </head>
      <body class="mode-chat">
        <div id="toolbar">
          <button class="toolbar-btn active" data-mode="chat">Chat</button>
          <button class="toolbar-btn" data-mode="log">Output</button>
          <button class="toolbar-btn" data-mode="git">Changes</button>
          <span class="toolbar-spacer"></span>
          <button id="search-toggle" type="button" aria-expanded="false" aria-controls="search-panel">搜索</button>
          <button id="data-toggle" type="button" aria-expanded="false" aria-controls="data-panel">数据</button>
        </div>
        <div id="chat-workspace">
        <section id="search-panel" class="hidden" aria-label="历史消息搜索">
          <div class="search-heading">
            <strong>搜索当前联系人历史</strong>
            <button id="search-close" type="button" aria-label="关闭历史搜索">关闭</button>
          </div>
          <form id="search-form">
            <label class="search-query-field">关键词
              <input id="search-query" type="search" maxlength="200" placeholder="消息内容（留空可按日期或类型筛选）">
            </label>
            <label>开始日期<input id="search-from" type="date"></label>
            <label>结束日期<input id="search-to" type="date"></label>
            <label>消息类型
              <select id="search-type">
                <option value="">全部</option><option value="1">文字</option><option value="2">图片</option>
                <option value="3">语音</option><option value="4">文件</option><option value="5">视频</option>
              </select>
            </label>
            <button id="search-submit" type="submit">搜索</button>
          </form>
          <div id="search-status" role="status" aria-live="polite"></div>
          <div id="search-results"></div>
          <button id="search-more" class="hidden" type="button">加载更多结果</button>
          <div id="search-context" class="hidden">
            <button id="search-context-back" type="button">返回搜索结果</button>
            <div id="search-context-title"></div>
            <div id="search-context-messages"></div>
          </div>
        </section>
        <div id="login-screen" class="hidden">
          <div id="login-status">Initializing...</div>
          <img id="qrcode" class="hidden" alt="Scan QR code">
        </div>
        <div id="data-panel" class="hidden" aria-label="聊天数据管理">
          <div class="data-heading"><strong>当前通道数据管理</strong><button id="data-close" type="button">关闭</button></div>
          <p class="data-note">导出、备份与恢复覆盖当前通道全部联系人，不受当前收件人选择影响。容量总计覆盖整个 VsChat 存储目录；缓存隔离仅处理当前通道。</p>
          <div class="data-section">
            <strong>导出聊天记录</strong>
            <div class="data-dates"><label>开始日期<input id="data-from" type="date"></label><label>结束日期<input id="data-to" type="date"></label></div>
            <div class="data-buttons"><button id="export-markdown" type="button">导出 Markdown</button><button id="export-json" type="button">导出 JSON</button></div>
            <span class="data-note">仅导出可读文字和附件说明；不包含登录或附件解密信息。</span>
          </div>
          <div class="data-section">
            <strong>备份与恢复</strong>
            <label class="data-checkbox"><input id="backup-images" type="checkbox" checked>备份本地已缓存图片</label>
            <span class="data-note">备份包含聊天内容和附件解密信息，请妥善保存。不会下载远程附件。</span>
            <div class="data-buttons"><button id="backup-create" type="button">创建备份</button><button id="restore-select" type="button">选择备份并预览</button></div>
            <div id="restore-preview" class="data-preview hidden"></div>
            <button id="restore-confirm" type="button" disabled>确认追加恢复</button>
            <span class="data-note">仅追加历史，重复或冲突记录跳过；不覆盖现有记录，不恢复登录状态。预览有效期 10 分钟。</span>
          </div>
          <div class="data-section">
            <strong>容量与缓存</strong>
            <button id="storage-refresh" type="button">查看 / 刷新容量</button>
            <div id="storage-summary"></div>
            <button id="cleanup-preview" type="button">预览可整理缓存</button>
            <div id="cleanup-summary" class="data-preview hidden"></div>
            <button id="cleanup-confirm" type="button" disabled>确认移入保留目录</button>
            <span class="data-note">仅移动超过 7 天且无历史引用的图片缓存；不删除聊天、凭据或草稿。保留目录仍占用磁盘，不会立即释放空间。</span>
          </div>
          <div id="data-status" role="status" aria-live="polite"></div>
        </div>
        <div id="chat-container">
          <button id="load-more-history" class="hidden" type="button">加载更早消息</button>
          <div id="messages"></div>
        </div>
        </div>
        <button id="new-messages" class="hidden" type="button" aria-live="polite"></button>
        <div id="send-feedback" class="hidden">
          <span id="send-status" role="status" aria-live="polite"></span>
          <button id="retry-send" class="hidden" type="button">重试发送</button>
          <button id="confirm-send" class="hidden" type="button">已确认对方收到</button>
        </div>
        <div id="input-bar">
          <div id="file-draft" class="hidden">
            <span id="file-draft-name"></span>
            <button id="file-draft-cancel" type="button" aria-label="移除待发送文件">×</button>
          </div>
          <div id="paste-draft" class="hidden">
            <img id="paste-preview" class="hidden" alt="待发送图片">
            <span id="paste-status" role="status"></span>
            <button id="paste-cancel" type="button" aria-label="移除粘贴的图片">×</button>
          </div>
          <div id="quote-bar" class="hidden">
            <div id="quote-preview"></div>
            <button id="quote-cancel" title="取消引用">&times;</button>
          </div>
          <input type="file" id="file-input" accept="image/*" class="hidden">
          <textarea id="text-input" rows="2" aria-label="消息内容" title="Enter 发送，Shift+Enter 换行" placeholder="Type a message..."></textarea>
          <div class="composer-actions">
            <button id="emoji-btn" type="button" title="插入表情" aria-label="插入表情">😊</button>
            <details id="attachment-picker" class="composer-picker"><summary title="添加附件" aria-label="添加附件">📎</summary><div class="composer-menu">
            <button id="attach-btn" type="button" title="选择图片" aria-label="选择图片">图片</button>
            <button id="attach-file-btn" type="button" title="选择文件（最多 20 MiB）" aria-label="选择文件" disabled>文件</button>
            </div></details>
            <details id="recipient-picker" class="composer-picker"><summary id="recipient-summary" title="选择收件人">收件人</summary><div class="composer-menu">
        <div id="recipient-bar" class="recipient-bar hidden">
          <label for="recipient-select">发送给</label>
          <select id="recipient-select" aria-label="选择明确收件人"><option value="">请选择联系人</option></select>
          <button id="recipient-refresh" type="button" title="刷新联系人" aria-label="刷新联系人">↻</button>
          <div id="recipient-status" role="status" aria-live="polite"></div>
          <label class="alias-field">本地备注<input id="recipient-alias" type="text" maxlength="40" placeholder="给这个联系人起个名字"></label>
          <button id="recipient-alias-save" type="button">保存备注</button>
          <span id="recipient-alias-status" role="status"></span>
        </div>
            </div></details>
            <span class="composer-spacer"></span>
            <details id="connection-picker" class="composer-picker"><summary id="connection-status" class="hidden" role="status" aria-live="polite"></summary><div id="connection-detail" class="composer-menu"></div></details>
            <button id="send-btn" type="button">Send</button>
          </div>
          <div id="emoji-panel" class="hidden"></div>
        </div>
        <div id="lightbox" class="hidden">
          <img id="lightbox-img" src="" alt="Preview">
          <button id="lightbox-close">&times;</button>
          <div id="lightbox-zoom">100%</div>
        </div>
        <script src="${richContentUri}"></script>
        <script src="${scriptUri}"></script>
      </body>
      </html>
    `;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.files.dispose();
    this.archives.dispose();
    this.presentation.clear();
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.lifetimeDisposables.forEach(d => d.dispose());
    this.disposables.forEach((d) => d.dispose());
    this.statusBar?.dispose();
    this.view = null;
    this.viewReady = false;
    this.viewGeneration += 1;
  }
}
