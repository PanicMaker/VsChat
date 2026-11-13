import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { ChatDB } from './chat-db';
import { ArchiveChannel, ChatBackup } from './archive-types';
import { MAX_ARCHIVE_BYTES, createBackup, exportHistory, parseBackup, summarizeBackup } from './chat-archive';
import { collectBackupImages, executeCacheCleanup, getStorageUsage, previewCacheCleanup, restoreBackupImages, CleanupPlan } from './storage-maintenance';
import { WebViewInbound, WebViewOutbound } from './types';

const operations: Record<string, NonNullable<WebViewInbound['operation']>> = {
  dataExport: 'export', dataBackup: 'backup', dataRestorePreview: 'restorePreview',
  dataRestoreConfirm: 'restoreConfirm', dataStorage: 'storage',
  dataCleanupPreview: 'cleanupPreview', dataCleanupConfirm: 'cleanupConfirm',
};
const PREVIEW_LIFETIME_MS = 10 * 60_000;

/** Native dialogs own every path. Previews own immutable, validated host snapshots. */
export class ArchiveActions {
  private busy = false;
  private disposed = false;
  private previewEpoch = 0;
  private seen = new Set<string>();
  private results = new Map<string, WebViewInbound>();
  private restore?: { id: string; backup: ChatBackup; generation: string; expires: number };
  private cleanup?: { id: string; plan: CleanupPlan; generation: string; expires: number };

  constructor(private context: vscode.ExtensionContext, private db: ChatDB, private channel: ArchiveChannel,
    private post: (message: WebViewInbound) => void, private afterChange: () => Promise<void>) {}

  /** A recreated view must obtain its own preview before it can confirm. */
  invalidatePreviews(): void {
    this.previewEpoch++;
    this.restore = undefined;
    this.cleanup = undefined;
    for (const [requestId, result] of this.results) {
      if (result.operation === 'restorePreview' || result.operation === 'cleanupPreview') {
        this.results.set(requestId, { command: 'dataResult', requestId, operation: result.operation, cancelled: true });
      }
    }
  }

  async handle(message: WebViewOutbound): Promise<void> {
    if (this.disposed) return;
    if (message.command === 'dataDismissPreview') {
      if (message.previewId === this.restore?.id) this.restore = undefined;
      if (message.previewId === this.cleanup?.id) this.cleanup = undefined;
      return;
    }
    const operation = operations[message.command];
    const requestId = message.requestId;
    if (!operation || typeof requestId !== 'string' || !requestId || requestId.length > 128) return;
    if (this.seen.has(requestId)) {
      const previous = this.results.get(requestId);
      if (previous) this.post(previous);
      // An in-flight replay never starts a second dialog or mutation.
      else if (!this.busy) this.post({ command: 'dataResult', requestId, operation, error: '该操作已处理，请重新发起操作。' });
      return;
    }
    this.seen.add(requestId);
    const finish = (result: Omit<WebViewInbound, 'command' | 'requestId' | 'operation'>) => {
      const reply: WebViewInbound = { command: 'dataResult', requestId, operation, ...result };
      this.results.set(requestId, reply);
      while (this.results.size > 100) this.results.delete(this.results.keys().next().value!);
      if (!this.disposed) this.post(reply);
    };
    if (this.busy) { finish({ error: '另一个数据操作正在进行，请等待完成。' }); return; }
    this.busy = true;
    const previewEpoch = this.previewEpoch;
    const isPreview = operation === 'restorePreview' || operation === 'cleanupPreview';
    const previewInvalidated = () => this.disposed || previewEpoch !== this.previewEpoch;
    try {
      switch (operation) {
        case 'export': {
          if (message.format !== 'markdown' && message.format !== 'json') throw new Error('导出格式无效。');
          const snapshot = await this.db.exportHistorySnapshot({ fromTimestamp: message.fromTimestamp, toTimestamp: message.toTimestamp });
          const bytes = exportHistory(snapshot, message.format);
          const saved = await this.saveNewFile(bytes, `VsChat-${this.channel}-${this.date()}.${message.format === 'markdown' ? 'md' : 'json'}`);
          finish(saved ? { data: { messageCount: snapshot.records.length, bytes: bytes.length } } : { cancelled: true });
          break;
        }
        case 'backup': {
          const snapshot = await this.db.exportHistorySnapshot();
          const media = message.includeImages !== false
            ? await collectBackupImages(this.root, snapshot) : { images: [], missing: 0, skipped: 0 };
          const bytes = createBackup(snapshot, media.images);
          const saved = await this.saveNewFile(bytes, `VsChat-${this.channel}-backup-${this.date()}.json`);
          finish(saved ? { data: { messageCount: snapshot.records.length, imageCount: media.images.length,
            missingImages: media.missing, skippedImages: media.skipped, bytes: bytes.length } } : { cancelled: true });
          break;
        }
        case 'restorePreview': {
          this.restore = undefined;
          const picked = await vscode.window.showOpenDialog({ title: '选择 VsChat 备份以预览恢复', openLabel: '预览备份',
            canSelectMany: false, canSelectFiles: true, canSelectFolders: false, filters: { 'VsChat JSON 备份': ['json'] } });
          if (!picked?.length || previewInvalidated()) { finish({ cancelled: true }); break; }
          if (picked.length !== 1 || picked[0].scheme !== 'file') throw new Error('请选择扩展宿主中的备份文件。');
          const bytes = await this.readBounded(picked[0].fsPath);
          if (previewInvalidated()) { finish({ cancelled: true }); break; }
          const backup = parseBackup(bytes, this.channel);
          const plan = await this.db.previewRestore(backup.records);
          if (previewInvalidated()) { finish({ cancelled: true }); break; }
          const id = randomUUID();
          this.restore = { id, backup, generation: plan.generation, expires: Date.now() + PREVIEW_LIFETIME_MS };
          finish({ previewId: id, generation: plan.generation, data: { ...summarizeBackup(backup),
            newCount: plan.newCount, duplicateCount: plan.duplicateCount, conflictCount: plan.conflictCount } });
          break;
        }
        case 'restoreConfirm': {
          const preview = this.restore;
          if (!preview || message.previewId !== preview.id || Date.now() > preview.expires) throw new Error('恢复预览已失效，请重新选择备份并预览。');
          // Consume before touching storage: a second click cannot repeat a restore.
          this.restore = undefined;
          const result = await this.db.appendRestore(preview.backup.records, preview.generation);
          let media = { restored: 0, existing: 0, failed: preview.backup.images.length };
          try { media = await restoreBackupImages(this.root, this.channel, preview.backup.images, result.mapping); } catch { /* Report committed rows and incomplete media separately. */ }
          let refreshFailed = false;
          if (media.restored) await this.db.notifyRestoredMedia().catch(() => { refreshFailed = true; });
          await this.afterChange().catch(() => { refreshFailed = true; });
          finish({ generation: result.generation, data: { inserted: result.inserted, skipped: result.skipped,
            conflicts: result.conflicts, imagesRestored: media.restored, imagesExisting: media.existing, imagesFailed: media.failed,
            ...(refreshFailed ? { refreshPending: true } : {}) } });
          break;
        }
        case 'storage': {
          finish({ data: { ...await getStorageUsage(this.root, this.channel) } });
          break;
        }
        case 'cleanupPreview': {
          this.cleanup = undefined;
          const result = await this.db.withHistorySnapshot(async snapshot => ({ generation: snapshot.generation,
            plan: await previewCacheCleanup(this.root, snapshot) }));
          if (previewInvalidated()) { finish({ cancelled: true }); break; }
          const id = randomUUID();
          this.cleanup = { id, plan: result.plan, generation: result.generation, expires: Date.now() + PREVIEW_LIFETIME_MS };
          finish({ previewId: id, generation: result.generation, data: { count: result.plan.count, bytes: result.plan.bytes } });
          break;
        }
        case 'cleanupConfirm': {
          const preview = this.cleanup;
          if (!preview || message.previewId !== preview.id || Date.now() > preview.expires) throw new Error('缓存预览已失效，请重新预览。');
          this.cleanup = undefined;
          const result = await this.db.withHistorySnapshot(async snapshot => {
            if (snapshot.generation !== preview.generation) throw new Error('聊天历史已变化，请重新预览缓存。');
            return executeCacheCleanup(this.root, snapshot, preview.plan);
          });
          finish({ generation: preview.generation, data: { ...result } });
          break;
        }
      }
    } catch (error) {
      if (isPreview && previewInvalidated()) finish({ cancelled: true });
      else finish({ error: error instanceof Error && !('code' in error) ? error.message : '数据操作失败，请检查文件位置与权限后重试。' });
    } finally { this.busy = false; }
  }

  private get root(): string { return this.context.globalStorageUri.fsPath; }
  private date(): string { return new Date().toISOString().slice(0, 10); }

  private async readBounded(filePath: string): Promise<Buffer> {
    const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size <= 0 || before.size > MAX_ARCHIVE_BYTES) throw new Error('备份必须是非空普通文件，最大 64 MiB。');
      const bytes = Buffer.alloc(before.size + 1);
      let total = 0;
      while (total < bytes.length) {
        const read = await handle.read(bytes, total, bytes.length - total, total);
        if (!read.bytesRead) break;
        total += read.bytesRead;
      }
      const after = await handle.stat();
      if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('备份文件读取期间发生变化，请重新选择。');
      }
      return bytes.subarray(0, total);
    } finally { await handle.close(); }
  }

  private async saveNewFile(bytes: Buffer, fileName: string): Promise<boolean> {
    if (this.disposed) return false;
    const destination = await vscode.window.showSaveDialog({ title: '保存到新文件（不覆盖已有文件）', saveLabel: '保存新文件',
      defaultUri: vscode.Uri.file(path.join(os.homedir(), fileName)) });
    if (!destination || this.disposed) return false;
    if (destination.scheme !== 'file') throw new Error('请选择扩展宿主中的新文件位置。');
    const parent = await fs.promises.realpath(path.dirname(destination.fsPath));
    const root = await fs.promises.realpath(this.root);
    const relative = path.relative(root, path.join(parent, path.basename(destination.fsPath)));
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('请保存在 VsChat 数据目录之外，避免影响现有数据。');
    }
    let handle: fs.promises.FileHandle;
    try { handle = await fs.promises.open(destination.fsPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('目标文件已经存在，请选择新的文件名；已有文件未修改。');
      throw error;
    }
    try { await handle.writeFile(bytes); }
    catch { throw new Error('导出写入失败，可能留下不完整的新文件，请更换位置重新导出。'); }
    finally { await handle.close(); }
    return true;
  }

  dispose(): void { this.disposed = true; this.invalidatePreviews(); }
}
