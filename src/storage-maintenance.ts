import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as lockfile from 'proper-lockfile';
import { ArchiveChannel, ArchiveImage, ArchiveSnapshot, RestoreResult } from './archive-types';

export const MAX_CACHED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_BACKUP_IMAGES_BYTES = 64 * 1024 * 1024;
const MAX_SIDECAR_BYTES = Math.ceil(MAX_CACHED_IMAGE_BYTES / 3) * 4 + 256;
const CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface ImageReference { stem: string; messageKey: string; partIndex?: number }
interface Fingerprint { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number }
interface CacheFile { name: string; fingerprint: Fingerprint }
interface CacheGroup { stem: string; files: CacheFile[]; unsafe: boolean }
/** Candidates stay in host memory; callers cannot replace them with arbitrary paths. */
export interface CleanupPlan { readonly count: number; readonly bytes: number; readonly createdAt: number }
interface InternalPlan { root: string; channel: ArchiveChannel; generation: string; groups: CacheGroup[]; used: boolean }
const cleanupPlans = new WeakMap<CleanupPlan, InternalPlan>();

function requireChannel(channel: ArchiveChannel): void {
  if (channel !== 'wechat' && channel !== 'qq') throw new Error('存储通道无效。');
}
function storagePath(root: string): string {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('存储目录无效。');
  return path.resolve(root);
}
function cacheDirectory(channel: ArchiveChannel): string { return channel === 'wechat' ? 'images' : 'qq-images'; }
function positiveId(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function validIndex(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}
function imageStem(id: number, index?: number): string { return index === undefined ? String(id) : `${id}.part-${index}`; }
function imageNames(channel: ArchiveChannel, stem: string): string[] {
  return channel === 'wechat' ? [`${stem}.png`, `${stem}.png.url.json`] : [`${stem}.json`];
}
async function lstatOptional(file: string): Promise<fs.Stats | undefined> {
  try { return await fs.promises.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function directory(root: string, create = false): Promise<boolean> {
  const stat = await lstatOptional(root);
  if (!stat) {
    if (!create) return false;
    try { await fs.promises.mkdir(root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return directory(root);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('存储目录包含非目录文件或符号链接，已停止操作。');
  return true;
}
function fingerprint(stat: fs.Stats): Fingerprint {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev };
}
function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.ino === right.ino && left.dev === right.dev;
}

/** Lock order is DB -> media. Media writers must release this lock before marking DB readiness. */
export async function withMediaLock<T>(root: string, channel: ArchiveChannel, operation: () => Promise<T>): Promise<T> {
  requireChannel(channel);
  const resolved = storagePath(root);
  // A caller may be initializing a fresh extension storage directory.
  if (!(await lstatOptional(resolved))) await fs.promises.mkdir(resolved, { recursive: true, mode: 0o700 });
  await directory(resolved);
  const canonical = await fs.promises.realpath(resolved);
  const target = path.join(canonical, `.media-${channel}`);
  const existingLock = await lstatOptional(`${target}.lock`);
  if (existingLock && (!existingLock.isDirectory() || existingLock.isSymbolicLink())) throw new Error('媒体锁路径无效。');
  const release = await lockfile.lock(target, {
    realpath: false, stale: 30_000, update: 10_000,
    retries: { retries: 360, factor: 1, minTimeout: 100, maxTimeout: 100, randomize: true },
  });
  try { return await operation(); }
  finally { await release(); }
}

function references(snapshot: ArchiveSnapshot, protectLegacyWithParts = true): ImageReference[] {
  requireChannel(snapshot.channel);
  const result = new Map<string, ImageReference>();
  for (const record of snapshot.records) {
    if (!positiveId(record.originalId)) continue;
    if (record.message.type === 2 && (protectLegacyWithParts || record.message.parts === undefined)) {
      const stem = imageStem(record.originalId);
      result.set(stem, { stem, messageKey: record.key });
    }
    record.message.parts?.forEach((part, index) => {
      if (part.type !== 2) return;
      const stem = imageStem(record.originalId, index);
      result.set(stem, { stem, messageKey: record.key, partIndex: index });
    });
  }
  return [...result.values()];
}
function decodeImage(dataUrl: unknown): Buffer | undefined {
  if (typeof dataUrl !== 'string' || Buffer.byteLength(dataUrl) > MAX_SIDECAR_BYTES) return undefined;
  const match = /^data:image\/(png|jpeg|gif|webp|bmp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4) return undefined;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_CACHED_IMAGE_BYTES || bytes.toString('base64') !== match[2]) return undefined;
  const mime = match[1];
  const valid = mime === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === 'gif' ? /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString('ascii'))
        : mime === 'webp' ? bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
          : bytes.length >= 2 && bytes.toString('ascii', 0, 2) === 'BM';
  return valid ? bytes : undefined;
}
async function readSidecar(file: string): Promise<string | undefined> {
  const stat = await lstatOptional(file);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SIDECAR_BYTES) throw new Error('图片缓存无效或过大。');
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameFingerprint(fingerprint(stat), fingerprint(before))) throw new Error('图片缓存已变化。');
    // Never read more than the verified size plus one detection byte.
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstatOptional(file);
    if (length !== before.size || !sameFingerprint(fingerprint(before), fingerprint(after))
        || !current?.isFile() || current.isSymbolicLink() || !sameFingerprint(fingerprint(after), fingerprint(current))) {
      throw new Error('图片缓存读取期间发生变化。');
    }
    const dataUrl: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8')).dataUrl;
    if (!decodeImage(dataUrl)) throw new Error('图片缓存格式无效。');
    return dataUrl as string;
  } finally { await handle.close(); }
}

export async function collectBackupImages(root: string, snapshot: ArchiveSnapshot): Promise<{
  images: ArchiveImage[]; missing: number; skipped: number;
}> {
  return withMediaLock(root, snapshot.channel, async () => {
    const refs = references(snapshot, false);
    const images: ArchiveImage[] = [];
    let missing = 0, skipped = 0, bytes = 0;
    const cache = path.join(storagePath(root), cacheDirectory(snapshot.channel));
    if (!(await directory(cache))) return { images, missing: refs.length, skipped };
    for (const ref of refs) {
      const name = imageNames(snapshot.channel, ref.stem).at(-1)!;
      try {
        const dataUrl = await readSidecar(path.join(cache, name));
        if (dataUrl === undefined) { missing++; continue; }
        const size = Buffer.byteLength(dataUrl);
        if (bytes + size > MAX_BACKUP_IMAGES_BYTES) { skipped++; continue; }
        images.push({ messageKey: ref.messageKey, ...(ref.partIndex === undefined ? {} : { partIndex: ref.partIndex }), dataUrl });
        bytes += size;
      } catch { skipped++; }
    }
    return { images, missing, skipped };
  });
}

export async function restoreBackupImages(root: string, channel: ArchiveChannel, images: ArchiveImage[], mapping: RestoreResult['mapping']): Promise<{
  restored: number; existing: number; failed: number;
}> {
  requireChannel(channel);
  if (!images.length) return { restored: 0, existing: 0, failed: 0 };
  return withMediaLock(root, channel, async () => {
    const result = { restored: 0, existing: 0, failed: 0 };
    const ids = new Map<string, number | undefined>();
    for (const item of mapping) {
      if (!positiveId(item.id) || typeof item.key !== 'string') continue;
      ids.set(item.key, ids.has(item.key) && ids.get(item.key) !== item.id ? undefined : item.id);
    }
    const cache = path.join(storagePath(root), cacheDirectory(channel));
    try { await directory(cache, true); }
    catch { return { ...result, failed: images.length }; }
    let total = 0;
    for (const image of images) {
      const id = ids.get(image.messageKey);
      const data = decodeImage(image.dataUrl);
      const size = typeof image.dataUrl === 'string' ? Buffer.byteLength(image.dataUrl) : 0;
      if (!id || !validIndex(image.partIndex) || !data || total + size > MAX_BACKUP_IMAGES_BYTES) { result.failed++; continue; }
      total += size;
      const names = imageNames(channel, imageStem(id, image.partIndex));
      const handles: fs.promises.FileHandle[] = [];
      const created: Array<{ file: string; dev: number; ino: number }> = [];
      let committed = false;
      try {
        if ((await Promise.all(names.map(name => lstatOptional(path.join(cache, name))))).some(Boolean)) {
          result.existing++; continue;
        }
        // Exclusive opens reserve every target before writing; existing cache
        // files, links and directories are never overwritten or removed.
        for (const name of names) {
          const file = path.join(cache, name);
          const handle = await fs.promises.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          handles.push(handle);
          const stat = await handle.stat();
          created.push({ file, dev: stat.dev, ino: stat.ino });
        }
        for (let index = 0; index < names.length; index++) {
          await handles[index].writeFile(names[index].endsWith('.json') ? JSON.stringify({ dataUrl: image.dataUrl }) : data);
        }
        committed = true;
        result.restored++;
      } catch (error) {
        if (!handles.length && (error as NodeJS.ErrnoException).code === 'EEXIST') result.existing++;
        else result.failed++;
      } finally {
        await Promise.all(handles.map(handle => handle.close().catch(() => undefined)));
        if (!committed) {
          // Roll back only this attempt's uncommitted exclusive creations. A
          // pre-existing file or a replacement inode must never be removed.
          for (const owned of created) {
            try {
              const current = await lstatOptional(owned.file);
              if (current?.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) {
                await fs.promises.unlink(owned.file);
              }
            } catch { /* Keep unremovable partial files; the failed count is already reported. */ }
          }
        }
      }
    }
    return result;
  });
}

export interface StorageUsage {
  databaseBytes: number; cacheBytes: number; draftBytes: number; temporaryBytes: number;
  quarantineBytes: number; otherBytes: number; totalBytes: number; fileCount: number;
}
export async function getStorageUsage(root: string, channel: ArchiveChannel): Promise<StorageUsage> {
  requireChannel(channel);
  const resolved = storagePath(root);
  const result: StorageUsage = { databaseBytes: 0, cacheBytes: 0, draftBytes: 0, temporaryBytes: 0,
    quarantineBytes: 0, otherBytes: 0, totalBytes: 0, fileCount: 0 };
  if (!(await directory(resolved))) return result;
  const database = channel === 'qq' ? 'vschat_qq_chats.db' : 'vschat_chats.db';
  let entries = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (++entries > 100_000 || depth > 64) throw new Error('存储目录过大，无法完整统计。');
    const absolute = path.join(resolved, relative);
    const stat = await lstatOptional(absolute);
    if (!stat || stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of await fs.promises.readdir(absolute)) await walk(path.join(relative, name), depth + 1);
    } else if (stat.isFile()) {
      const top = relative.split(path.sep)[0];
      const category = relative === database || relative === `${database}.bak` ? 'databaseBytes'
        : top === cacheDirectory(channel) ? 'cacheBytes'
          : top === 'file-drafts' ? 'draftBytes'
            : top === 'temp' ? 'temporaryBytes'
              : top === 'cache-quarantine' ? 'quarantineBytes' : 'otherBytes';
      result[category] += stat.size;
      result.totalBytes += stat.size;
      result.fileCount++;
    }
  };
  for (const name of await fs.promises.readdir(resolved)) await walk(name, 0);
  return result;
}

function parsedStem(channel: ArchiveChannel, name: string): string | undefined {
  const pattern = channel === 'wechat'
    ? /^([1-9]\d*)(?:\.part-(0|[1-9]\d*))?\.png(?:\.url\.json)?$/
    : /^([1-9]\d*)(?:\.part-(0|[1-9]\d*))?\.json$/;
  const match = pattern.exec(name);
  if (!match || !positiveId(Number(match[1])) || !validIndex(match[2] === undefined ? undefined : Number(match[2]))) return undefined;
  return imageStem(Number(match[1]), match[2] === undefined ? undefined : Number(match[2]));
}
async function cacheGroups(cache: string, channel: ArchiveChannel): Promise<CacheGroup[]> {
  if (!(await directory(cache))) return [];
  const groups = new Map<string, CacheGroup>();
  for (const name of await fs.promises.readdir(cache)) {
    const stem = parsedStem(channel, name);
    if (!stem) continue;
    const group = groups.get(stem) || { stem, files: [], unsafe: false };
    groups.set(stem, group);
    const stat = await lstatOptional(path.join(cache, name));
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) group.unsafe = true;
    else group.files.push({ name, fingerprint: fingerprint(stat) });
  }
  return [...groups.values()].map(group => ({ ...group, files: group.files.sort((a, b) => a.name.localeCompare(b.name)) }));
}
async function currentGroup(cache: string, channel: ArchiveChannel, stem: string): Promise<CacheGroup> {
  const group: CacheGroup = { stem, files: [], unsafe: false };
  for (const name of imageNames(channel, stem)) {
    const stat = await lstatOptional(path.join(cache, name));
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) group.unsafe = true;
    else group.files.push({ name, fingerprint: fingerprint(stat) });
  }
  group.files.sort((a, b) => a.name.localeCompare(b.name));
  return group;
}
function oldGroup(group: CacheGroup, now: number): boolean {
  return !group.unsafe && group.files.length > 0 && group.files.every(file => file.fingerprint.mtimeMs < now - CACHE_RETENTION_MS);
}
function unchangedGroup(before: CacheGroup, current: CacheGroup): boolean {
  return !current.unsafe && before.files.length === current.files.length
    && before.files.every((file, index) => file.name === current.files[index].name
      && sameFingerprint(file.fingerprint, current.files[index].fingerprint));
}

export async function previewCacheCleanup(root: string, snapshot: ArchiveSnapshot, now = Date.now()): Promise<CleanupPlan> {
  if (!Number.isFinite(now) || now < 0) throw new Error('清理预览时间无效。');
  return withMediaLock(root, snapshot.channel, async () => {
    const refs = new Set(references(snapshot).map(ref => ref.stem));
    const groups = (await cacheGroups(path.join(storagePath(root), cacheDirectory(snapshot.channel)), snapshot.channel))
      .filter(group => !refs.has(group.stem) && oldGroup(group, now));
    const plan: CleanupPlan = Object.freeze({
      count: groups.reduce((count, group) => count + group.files.length, 0),
      bytes: groups.reduce((bytes, group) => bytes + group.files.reduce((sum, file) => sum + file.fingerprint.size, 0), 0),
      createdAt: now,
    });
    cleanupPlans.set(plan, { root: storagePath(root), channel: snapshot.channel, generation: snapshot.generation, groups, used: false });
    return plan;
  });
}

export async function executeCacheCleanup(root: string, snapshot: ArchiveSnapshot, plan: CleanupPlan): Promise<{
  moved: number; skipped: number; failed: number; bytes: number;
}> {
  const saved = cleanupPlans.get(plan);
  if (!saved || saved.used || saved.root !== storagePath(root) || saved.channel !== snapshot.channel) {
    throw new Error('缓存清理预览已失效，请重新预览。');
  }
  saved.used = true;
  return withMediaLock(root, snapshot.channel, async () => {
    const result = { moved: 0, skipped: 0, failed: 0, bytes: 0 };
    if (saved.generation !== snapshot.generation) return { ...result, skipped: plan.count };
    const refs = new Set(references(snapshot).map(ref => ref.stem));
    const cache = path.join(storagePath(root), cacheDirectory(snapshot.channel));
    if (!(await directory(cache))) return { ...result, skipped: plan.count };
    let destination: string | undefined;
    for (const group of saved.groups) {
      let current: CacheGroup;
      try { current = await currentGroup(cache, snapshot.channel, group.stem); }
      catch { result.failed += group.files.length; continue; }
      if (refs.has(group.stem) || !oldGroup(current, Date.now()) || !unchangedGroup(group, current)) {
        result.skipped += group.files.length; continue;
      }
      try {
        if (!destination) {
          const quarantine = path.join(storagePath(root), 'cache-quarantine');
          await directory(quarantine, true);
          const run = path.join(quarantine, randomUUID());
          // A fresh private directory reserves an empty destination namespace.
          await fs.promises.mkdir(run, { mode: 0o700 });
          const scoped = path.join(run, cacheDirectory(snapshot.channel));
          await fs.promises.mkdir(scoped, { mode: 0o700 });
          destination = scoped;
        }
        await directory(path.join(storagePath(root), 'cache-quarantine'));
        await directory(path.dirname(destination));
        await directory(destination);
      } catch { result.failed += group.files.length; continue; }
      // Check both members together immediately before moving either, including
      // a partner sidecar that appeared after the preview.
      let checked: CacheGroup;
      try { checked = await currentGroup(cache, snapshot.channel, group.stem); }
      catch { result.failed += group.files.length; continue; }
      if (!oldGroup(checked, Date.now()) || !unchangedGroup(group, checked)) {
        result.skipped += group.files.length; continue;
      }
      for (const file of group.files) {
        try {
          const source = path.join(cache, file.name), target = path.join(destination, file.name);
          const stat = await lstatOptional(source);
          if (!stat?.isFile() || stat.isSymbolicLink() || !sameFingerprint(file.fingerprint, fingerprint(stat))) {
            result.skipped++; continue;
          }
          if (await lstatOptional(target)) { result.failed++; continue; }
          await fs.promises.rename(source, target);
          result.moved++; result.bytes += file.fingerprint.size;
        } catch { result.failed++; }
      }
    }
    return result;
  });
}
