import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { withMediaLock } from './storage-maintenance';

interface CacheWrite {
  target: string;
  stage: string;
  backup: string;
  bytes: Buffer | string;
  original?: fs.Stats;
  staged?: fs.Stats;
  committed?: boolean;
}

async function stat(file: string): Promise<fs.Stats | undefined> {
  try { return await fs.promises.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function sameFile(a: fs.Stats | undefined, b: fs.Stats | undefined): boolean {
  return Boolean(a && b && a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink()
    && a.dev === b.dev && a.ino === b.ino);
}
function unchanged(a: fs.Stats | undefined, b: fs.Stats | undefined): boolean {
  return !a && !b || sameFile(a, b) && a!.size === b!.size && a!.mtimeMs === b!.mtimeMs;
}

/** Publish complete cache files under the shared media lock; never truncate a live cache. */
export async function persistImageCache(
  root: string, channel: 'wechat' | 'qq', messageId: number, dataUrl: string, partIndex?: number,
): Promise<void> {
  if (!Number.isSafeInteger(messageId) || messageId < 1
      || partIndex !== undefined && (!Number.isSafeInteger(partIndex) || partIndex < 0)) {
    throw new Error('Invalid image cache identifier');
  }
  const key = partIndex === undefined ? String(messageId) : `${messageId}.part-${partIndex}`;
  await withMediaLock(root, channel, async () => {
    const directory = path.join(root, channel === 'wechat' ? 'images' : 'qq-images');
    try { await fs.promises.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const directoryStat = await fs.promises.lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('图片缓存目录无效。');
    // A private staging directory keeps incomplete files out of normal cache readers.
    const transaction = path.join(directory, `.cache-write-${randomUUID()}`);
    await fs.promises.mkdir(transaction, { mode: 0o700 });
    const contents = channel === 'wechat'
      ? [{ name: `${key}.png`, bytes: Buffer.from(dataUrl.replace(/^data:image\/[\w.+-]+;base64,/, ''), 'base64') },
        { name: `${key}.png.url.json`, bytes: JSON.stringify({ dataUrl }) }]
      : [{ name: `${key}.json`, bytes: JSON.stringify({ dataUrl }) }];
    const writes: CacheWrite[] = contents.map(({ name, bytes }) => ({
      target: path.join(directory, name), stage: path.join(transaction, name),
      backup: path.join(transaction, `${name}.previous`), bytes,
    }));
    let keepRecovery = false;
    try {
      for (const write of writes) {
        write.original = await stat(write.target);
        if (write.original && (!write.original.isFile() || write.original.isSymbolicLink())) {
          throw new Error('图片缓存文件无效。');
        }
        const handle = await fs.promises.open(write.stage,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        try {
          await handle.writeFile(write.bytes);
          write.staged = await handle.stat();
        } finally { await handle.close(); }
        if (write.original) {
          // A hard link retains the original inode for rollback without reading through a symlink.
          await fs.promises.link(write.target, write.backup);
          if (!sameFile(write.original, await stat(write.backup))) throw new Error('图片缓存已改变，请重试。');
        }
      }
      // All writes and backups finish before either member of the WeChat pair is published.
      for (const write of writes) {
        if (!unchanged(write.original, await stat(write.target))) throw new Error('图片缓存已改变，请重试。');
      }
      for (const write of writes) {
        if (!unchanged(write.original, await stat(write.target))) throw new Error('图片缓存已改变，请重试。');
        await fs.promises.rename(write.stage, write.target);
        write.committed = true;
      }
    } catch (error) {
      for (const write of [...writes].reverse()) {
        if (!write.committed) continue;
        try {
          // Never delete or overwrite a different writer's replacement during rollback.
          if (!sameFile(write.staged, await stat(write.target))) { keepRecovery = true; continue; }
          if (write.original) await fs.promises.rename(write.backup, write.target);
          else await fs.promises.unlink(write.target);
        } catch { keepRecovery = true; }
      }
      if (keepRecovery) throw new Error('图片缓存更新失败，原缓存备份已保留，需重新加载后检查。');
      throw error;
    } finally {
      // Only our exclusive temporary directory is removed. If rollback failed, preserve its backup.
      if (!keepRecovery) await fs.promises.rm(transaction, { recursive: true, force: true });
    }
  });
}
