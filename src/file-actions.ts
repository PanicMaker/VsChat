import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { ChatClient } from './chat-client';
import { ChatDB } from './chat-db';
import { ChatMessage, ChatMessagePart, FileDraft, WebViewInbound, WebViewOutbound } from './types';
import { FileSendError, MAX_FILE_BYTES, getFileDownloadSpec, sanitizeFileName } from './file-transfer';
import { recipientId as conversationRecipientId, SendTarget } from './recipient-types';

/** Older rows stored either a bare QQ URL or a serialized WeChat file item. */
export function attachmentParts(message: ChatMessage, channel: string): ChatMessagePart[] | undefined {
  if (message.parts?.length) return message.parts;
  if (message.type !== 4) return undefined;
  const part: ChatMessagePart = { type: 4 };
  if (channel.toLowerCase() === 'qq') {
    if (/^https?:\/\//i.test(message.content)) {
      part.url = message.content;
      try { part.fileName = sanitizeFileName(decodeURIComponent(new URL(message.content).pathname.split('/').pop() || 'attachment')); } catch {}
    } else part.fileName = sanitizeFileName(message.content);
  } else {
    try {
      const item = JSON.parse(message.content)?.file_item;
      if (item && typeof item === 'object') {
        part.fileName = typeof item.file_name === 'string' ? item.file_name : undefined;
        const size = Number(item.len ?? item.file_size);
        if (Number.isSafeInteger(size) && size >= 0) part.size = size;
        part.url = typeof item.media?.full_url === 'string' ? item.media.full_url
          : typeof item.cdn_url === 'string' ? item.cdn_url : undefined;
        if (typeof item.media?.aes_key === 'string') part.fileMedia = {
          aesKey: item.media.aes_key,
          encryptQueryParam: typeof item.media.encrypt_query_param === 'string' ? item.media.encrypt_query_param : undefined,
          md5: typeof item.md5 === 'string' ? item.md5 : undefined,
        };
      }
    } catch { /* Missing legacy metadata remains an unavailable file card. */ }
  }
  return [part];
}

interface StagedFile extends FileDraft { filePath: string; active: boolean; recipientId?: string }

export class FileActions {
  private staged = new Map<string, StagedFile>();
  private transfers = new Map<string, { controller: AbortController; key: string; status: WebViewInbound }>();
  private seenTransfers = new Set<string>();
  private disposed = false;
  private selecting = false;

  constructor(private context: vscode.ExtensionContext, private client: ChatClient, private db: ChatDB,
    private post: (message: WebViewInbound) => void, private viewGeneration: () => number) {}

  capabilities() {
    return this.client.fileCapabilities && this.client.sendFile
      ? { ...this.client.fileCapabilities, maxBytes: Math.min(this.client.fileCapabilities.maxBytes, MAX_FILE_BYTES) }
      : { canSend: false, maxBytes: MAX_FILE_BYTES, reason: '当前通道暂不支持文件发送。' };
  }

  availability(part: ChatMessagePart): { canSave: boolean; reason?: string } {
    if (!this.client.downloadFile) return { canSave: false, reason: '当前通道暂不支持保存文件。' };
    if (typeof part.size === 'number' && part.size > MAX_FILE_BYTES) return { canSave: false, reason: '超过本插件 20 MiB 文件限制。' };
    if (this.client.channelName.toLowerCase() !== 'qq' && !part.fileMedia) {
      return { canSave: false, reason: '历史文件缺少解密信息，无法下载。' };
    }
    if (!getFileDownloadSpec(part, this.client.channelName)) {
      return { canSave: false, reason: part.url ? '此下载地址不在支持范围内。' : '未提供有效下载信息，暂不能保存。' };
    }
    return { canSave: true };
  }

  private validRequest(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 128;
  }

  async select(message: WebViewOutbound): Promise<void> {
    if (!this.validRequest(message.requestId) || this.disposed) return;
    const requestId = message.requestId;
    const recipientId = typeof message.recipientId === 'string' ? message.recipientId : undefined;
    const selectionId = typeof message.selectionId === 'string' ? message.selectionId : undefined;
    const scope = { ...(recipientId === undefined ? {} : { recipientId }), ...(selectionId === undefined ? {} : { selectionId }) };
    if ((message.recipientId !== undefined && !recipientId) || (message.selectionId !== undefined && !selectionId)) {
      this.post({ command: 'fileSelected', requestId, ...scope, error: '文件草稿的联系人信息无效，请重新选择联系人。' });
      return;
    }
    if (this.selecting) {
      this.post({ command: 'fileSelected', requestId, ...scope, error: '文件选择窗口已打开。' });
      return;
    }
    const generation = this.viewGeneration();
    const current = () => !this.disposed && generation === this.viewGeneration();
    this.selecting = true;
    let snapshot: string | undefined;
    try {
      const capability = this.capabilities();
      if (!capability.canSend) throw new Error(capability.reason || '当前通道暂不支持文件发送。');
      const selected = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true,
        canSelectFolders: false, openLabel: '选择文件', title: '选择待发送文件（最多 20 MiB）' });
      if (!current()) return;
      if (!selected?.length) { this.post({ command: 'fileSelected', requestId, ...scope, cancelled: true }); return; }
      if (selected.length !== 1 || selected[0].scheme !== 'file') throw new Error('请选择扩展宿主中的普通文件。');
      const handle = await fs.promises.open(selected[0].fsPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size <= 0 || stat.size > capability.maxBytes) throw new Error('请选择非空且不超过 20 MiB 的普通文件。');
        const buffer = Buffer.alloc(Math.min(capability.maxBytes, MAX_FILE_BYTES) + 1);
        let count = 0;
        while (count < buffer.length) {
          const read = await handle.read(buffer, count, buffer.length - count, count);
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        if (!count || count > capability.maxBytes) throw new Error('文件为空或超过 20 MiB 限制。');
        bytes = buffer.subarray(0, count);
      } finally { await handle.close(); }
      if (!current()) return;
      const directory = path.join(this.context.globalStorageUri.fsPath, 'file-drafts');
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      snapshot = path.join(directory, `${randomUUID()}.bin`);
      await fs.promises.writeFile(snapshot, bytes, { flag: 'wx', mode: 0o600 });
      if (!current()) return;
      const draft: StagedFile = { fileId: randomUUID(), fileName: sanitizeFileName(selected[0].fsPath),
        size: bytes.length, filePath: snapshot, active: false, recipientId };
      // Each recipient owns a draft; an in-flight send retains its snapshot.
      for (const file of this.staged.values()) {
        if (!file.active && file.recipientId === recipientId) this.destroy(file);
      }
      this.staged.set(draft.fileId, draft);
      snapshot = undefined;
      this.post({ command: 'fileSelected', requestId, ...scope, fileDraft: { fileId: draft.fileId, fileName: draft.fileName, size: draft.size } });
    } catch (error) {
      if (current()) this.post({ command: 'fileSelected', requestId, ...scope,
        error: error instanceof Error && !('code' in error) ? error.message : '无法读取或暂存文件，请重新选择。' });
    } finally {
      this.selecting = false;
      if (snapshot) await fs.promises.unlink(snapshot).catch(() => undefined);
    }
  }

  status(fileId?: string, recipientId?: string, selectionId?: string): void {
    const file = typeof fileId === 'string' ? this.staged.get(fileId) : undefined;
    const valid = !!file && this.owns(file, recipientId);
    this.post({ command: 'fileDraftStatus', fileId, valid,
      ...(recipientId === undefined ? {} : { recipientId }), ...(selectionId === undefined ? {} : { selectionId }),
      ...(!valid ? { error: '文件草稿已失效或不属于当前联系人，请重新选择文件。' } : {}) });
  }

  private owns(file: StagedFile, recipientId?: string): boolean {
    return file.recipientId === undefined || file.recipientId === recipientId;
  }

  private destroy(file: StagedFile): void {
    this.staged.delete(file.fileId);
    void fs.promises.unlink(file.filePath).catch(() => undefined);
  }

  remove(fileId?: string, recipientId?: string): void {
    const file = typeof fileId === 'string' ? this.staged.get(fileId) : undefined;
    if (!file || file.active || !this.owns(file, recipientId)) return;
    this.destroy(file);
  }

  async send(fileId?: string, target?: SendTarget, recipientId?: string): Promise<string | undefined> {
    const file = typeof fileId === 'string' ? this.staged.get(fileId) : undefined;
    if (!this.capabilities().canSend || !this.client.sendFile) throw new FileSendError('当前通道暂不支持文件发送。');
    if (!file || file.active || this.disposed) throw new FileSendError('文件草稿已失效或正在发送，请重新选择。');
    const destination = target === undefined ? undefined : Object.freeze({ ...target });
    if (!this.owns(file, recipientId)
        || (file.recipientId !== undefined && (!destination || conversationRecipientId(destination) !== file.recipientId))
        || (destination && destination.channel !== this.client.channelName.toLowerCase())) {
      throw new FileSendError('文件草稿不属于当前联系人，请重新选择文件。');
    }
    file.active = true;
    let confirmed = false;
    try {
      const stat = await fs.promises.stat(file.filePath).catch(() => undefined);
      if (!stat?.isFile() || stat.size !== file.size || stat.size > MAX_FILE_BYTES) throw new FileSendError('文件草稿无法读取，请重新选择。');
      const warning = await this.client.sendFile(file.filePath, file.fileName, destination);
      confirmed = !warning;
      return warning;
    } finally {
      file.active = false;
      if (confirmed || this.disposed) this.destroy(file);
    }
  }

  async save(message: WebViewOutbound): Promise<void> {
    const { requestId, targetId, partIndex, generation } = message;
    if (!this.validRequest(requestId) || this.disposed) return;
    const scope = {
      ...(typeof message.recipientId === 'string' ? { recipientId: message.recipientId } : {}),
      ...(typeof message.selectionId === 'string' ? { selectionId: message.selectionId } : {}),
    };
    const previous = this.transfers.get(requestId);
    if (previous) { this.post(previous.status); return; }
    if (this.seenTransfers.has(requestId)) {
      this.post({ command: 'attachmentStatus', requestId, ...scope, fileStatus: 'failed', error: '该保存请求已处理，请重新点击另存为。' });
      return;
    }
    this.seenTransfers.add(requestId);
    const key = `${generation}:${targetId}:${partIndex}`;
    const controller = new AbortController();
    const transfer = { key, controller, status: { command: 'attachmentStatus', requestId, ...scope, fileStatus: 'saving' } as WebViewInbound };
    this.transfers.set(requestId, transfer);
    const report = (fileStatus: WebViewInbound['fileStatus'], error?: string) => {
      transfer.status = { command: 'attachmentStatus', requestId, ...scope, fileStatus, ...(error ? { error } : {}) };
      if (!this.disposed) this.post(transfer.status);
      for (const [id, item] of this.transfers) {
        if (this.transfers.size <= 100) break;
        if (item.status.fileStatus !== 'saving') this.transfers.delete(id);
      }
    };
    try {
      if ([...this.transfers.values()].filter(item => item.status.fileStatus === 'saving').length > 2) {
        throw new Error('最多同时保存两个文件，请等待其他文件完成后重试。');
      }
      if ([...this.transfers.values()].some(other => other !== transfer && other.key === key && other.status.fileStatus === 'saving')) {
        throw new Error('该附件正在保存，请等待完成。');
      }
      if (!Number.isSafeInteger(targetId) || targetId! <= 0 || !Number.isSafeInteger(partIndex) || partIndex! < 0
        || typeof generation !== 'string' || !generation) throw new Error('文件定位信息无效。');
      const read = () => this.db.getMessageContext({ id: targetId }, generation, 0);
      const result = await read();
      const messageRow = result?.messages.find(row => row.id === targetId);
      const part = messageRow && attachmentParts(messageRow, this.client.channelName)?.[partIndex!];
      if (!part || part.type !== 4 || result?.generation !== generation) throw new Error('文件不存在或聊天历史已更新。');
      const availability = this.availability(part);
      if (!availability.canSave || !this.client.downloadFile) throw new Error(availability.reason || '文件不可下载。');
      if (controller.signal.aborted) { report('cancelled'); return; }
      const destination = await vscode.window.showSaveDialog({ title: '保存聊天文件', saveLabel: '保存',
        defaultUri: vscode.Uri.file(path.join(os.homedir(), sanitizeFileName(part.fileName))) });
      if (!destination || controller.signal.aborted) { report('cancelled'); return; }
      if (!['file', 'vscode-remote'].includes(destination.scheme)) throw new Error('请选择本地或远程工作区文件位置。');
      if (!(await read())) throw new Error('聊天历史已更新，请重新打开文件卡片。');
      report('saving');
      const bytes = await this.client.downloadFile(part, controller.signal);
      if (controller.signal.aborted) { report('cancelled'); return; }
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) throw new Error('下载内容无效或超过 20 MiB 限制。');
      if (!(await read())) throw new Error('聊天历史已更新，文件未保存。');
      if (controller.signal.aborted) { report('cancelled'); return; }
      // The user chooses the destination. Only complete, verified bytes reach it.
      await vscode.workspace.fs.writeFile(destination, bytes);
      report('saved');
    } catch (error) {
      report(controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? undefined
        : error instanceof Error && !('code' in error) ? error.message : '文件保存失败，请重试或更换保存位置。');
    }
  }

  cancel(requestId?: string): void { if (requestId) this.transfers.get(requestId)?.controller.abort(); }

  dispose(): void {
    this.disposed = true;
    for (const transfer of this.transfers.values()) transfer.controller.abort();
    for (const file of this.staged.values()) if (!file.active) this.destroy(file);
  }
}
