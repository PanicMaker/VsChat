import { createDecipheriv, createHash } from 'crypto';
import { isIP } from 'net';
import { fetch, Dispatcher, Response } from 'undici';
import { ChatMessagePart, MsgType } from './types';

/** An application limit, not a claim about either platform's maximum. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
const FILE_HOST_SUFFIXES = ['qq.com', 'qq.com.cn', 'qpic.cn', 'gtimg.cn'];

/** Definite non-delivery: preparation failed, or the platform explicitly rejected the message. */
export class FileSendError extends Error {
  readonly deliveryState = 'not_sent';
  constructor(message: string) {
    super(message);
    this.name = 'FileSendError';
  }
}

export interface FileDownloadSpec {
  url: string;
  aesKey?: string;
  expectedSize?: number;
  md5?: string;
}

class FileDownloadError extends Error {}

export function sanitizeFileName(input: unknown): string {
  if (typeof input !== 'string') return 'attachment';
  // Treat both platforms' separators as paths, regardless of the extension host OS.
  const basename = input.replace(/\\/g, '/').split('/').pop() || '';
  let name = basename.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff<>:"|?*]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '');
  // Reserved Windows device names remain special even when an extension is present.
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  let bounded = '';
  for (const character of name) {
    if (Buffer.byteLength(bounded + character, 'utf8') > 180) break;
    bounded += character;
  }
  name = bounded.replace(/[. ]+$/g, '');
  if (!name) return 'attachment';
  return name;
}

/**
 * Deliberately limited to known Tencent CDN domain families. Other hosts need
 * an explicit future capability addition, rather than a background fetch.
 */
export function isSafeFileDownloadUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 16_384 || !/^https:\/\//i.test(value)
    || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return false;
  let decoded = value;
  for (let iteration = 0; iteration < 8; iteration++) {
    if (/[\u0000-\u001f\u007f-\u009f\\]/.test(decoded)) return false;
    let next: string;
    try { next = decodeURIComponent(decoded); }
    catch {
      // Malformed UTF-8 still must not hide ASCII header/path controls.
      next = decoded.replace(/%([\da-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
    if (next === decoded) break;
    if (iteration === 7) return false;
    decoded = next;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    const host = url.hostname.toLowerCase();
    if (isIP(host.replace(/^\[|\]$/g, '')) || host.endsWith('.')) return false;
    return FILE_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function decodeAesKey(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || value.length > 128 || !/^[a-z\d+/]+={0,2}$/i.test(value)
    || value.length % 4 !== 0) return undefined;
  const bytes = Buffer.from(value, 'base64');
  // Accept both encodings used by iLink: base64(raw16) and base64(hex32).
  if (bytes.length === 16) return bytes;
  if (bytes.length === 32 && /^[\da-f]{32}$/i.test(bytes.toString('ascii'))) return Buffer.from(bytes.toString('ascii'), 'hex');
  return undefined;
}

function validSize(value: unknown, limit = MAX_FILE_BYTES): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= limit;
}

export function getFileDownloadSpec(part: ChatMessagePart, channelName: string): FileDownloadSpec | undefined {
  if (part.type !== MsgType.File || (part.size !== undefined && !validSize(part.size))) return undefined;
  const spec: FileDownloadSpec = { url: '', ...(part.size !== undefined ? { expectedSize: part.size } : {}) };
  if (channelName.toLowerCase() === 'wechat') {
    if (!part.fileMedia || !decodeAesKey(part.fileMedia.aesKey)) return undefined;
    if (part.fileMedia.md5 !== undefined && !/^[\da-f]{32}$/i.test(part.fileMedia.md5)) return undefined;
    if (part.url) spec.url = part.url;
    else if (typeof part.fileMedia.encryptQueryParam === 'string' && part.fileMedia.encryptQueryParam) {
      spec.url = `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(part.fileMedia.encryptQueryParam)}`;
    }
    spec.aesKey = part.fileMedia.aesKey;
    if (part.fileMedia.md5) spec.md5 = part.fileMedia.md5;
  } else if (channelName.toLowerCase() === 'qq') {
    // A malformed/misrouted encrypted descriptor must never be saved as plaintext.
    if (part.fileMedia) return undefined;
    spec.url = part.url || '';
  } else return undefined;
  return isSafeFileDownloadUrl(spec.url) ? spec : undefined;
}

async function cancelBody(response: Response): Promise<void> {
  try { await response.body?.cancel(); } catch { /* The stream may already be aborted. */ }
}

async function readBounded(response: Response, limit: number, limitMessage: string): Promise<Buffer> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await cancelBody(response);
    throw new FileDownloadError(`${limitMessage}，或服务器返回了无效长度。`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Buffer[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > limit) throw new FileDownloadError(`${limitMessage}。`);
      chunks.push(Buffer.from(result.value));
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    try { await reader.cancel(); } catch { /* Keep the original failure. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function downloadFileBytes(
  spec: FileDownloadSpec,
  options: { dispatcher?: Dispatcher; signal?: AbortSignal } = {},
): Promise<Buffer> {
  return downloadMediaBytes(spec, options, MAX_FILE_BYTES, '文件');
}

/** Automatic image hydration uses the same guarded CDN boundary as file saves. */
export async function downloadImageBytes(
  spec: FileDownloadSpec,
  options: { dispatcher?: Dispatcher; signal?: AbortSignal } = {},
): Promise<Buffer> {
  return downloadMediaBytes(spec, options, MAX_IMAGE_BYTES, '图片');
}

async function downloadMediaBytes(
  spec: FileDownloadSpec,
  options: { dispatcher?: Dispatcher; signal?: AbortSignal },
  maxBytes: number,
  kind: '文件' | '图片',
): Promise<Buffer> {
  const limitLabel = `${maxBytes / (1024 * 1024)} MiB`;
  const limitMessage = `${kind}超过 ${limitLabel} 下载限制`;
  if (!isSafeFileDownloadUrl(spec.url)) throw new FileDownloadError(`暂不支持从该地址下载${kind}。`);
  if (spec.expectedSize !== undefined && !validSize(spec.expectedSize, maxBytes)) throw new FileDownloadError(`${kind}大小无效或超过 ${limitLabel} 下载限制。`);
  if (spec.md5 !== undefined && !/^[\da-f]{32}$/i.test(spec.md5)) throw new FileDownloadError(`${kind}校验信息无效。`);
  const aesKey = spec.aesKey === undefined ? undefined : decodeAesKey(spec.aesKey);
  if (spec.aesKey !== undefined && !aesKey) throw new FileDownloadError(`该${kind}缺少有效的解密信息。`);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();
  try {
    let url = spec.url;
    let response: Response | undefined;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (!isSafeFileDownloadUrl(url)) throw new FileDownloadError(`${kind}下载跳转到了不支持的地址。`);
      response = await fetch(url, {
        method: 'GET', redirect: 'manual', signal: controller.signal, dispatcher: options.dispatcher,
        // No chat credentials, cookies, or copied response headers reach CDN requests.
        headers: { 'Accept-Encoding': 'identity' },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await cancelBody(response);
      if (redirects === MAX_REDIRECTS || !location) throw new FileDownloadError(`${kind}下载重定向过多或地址无效。`);
      try { url = new URL(location, url).href; } catch { throw new FileDownloadError(`${kind}下载跳转地址无效。`); }
    }
    if (!response || response.status !== 200) {
      if (response) await cancelBody(response);
      if (response?.status === 401 || response?.status === 403 || response?.status === 404) {
        throw new FileDownloadError(`${kind}链接已失效或无权访问，请让对方重新发送。`);
      }
      throw new FileDownloadError(`${kind}下载失败${response ? `（HTTP ${response.status}）` : ''}，请重试。`);
    }
    const payload = await readBounded(response, maxBytes + (aesKey ? 16 : 0), limitMessage);
    let plain = payload;
    if (aesKey) {
      try {
        const decipher = createDecipheriv('aes-128-ecb', aesKey, null);
        plain = Buffer.concat([decipher.update(payload), decipher.final()]);
      } catch {
        throw new FileDownloadError(`${kind}解密失败，请让对方重新发送。`);
      }
    }
    if (plain.length > maxBytes) throw new FileDownloadError(`${limitMessage}。`);
    if (spec.expectedSize !== undefined && plain.length !== spec.expectedSize) throw new FileDownloadError(`${kind}长度校验失败，下载内容可能不完整。`);
    if (spec.md5 && createHash('md5').update(plain).digest('hex') !== spec.md5.toLowerCase()) {
      throw new FileDownloadError(`${kind}校验失败，下载内容可能已损坏。`);
    }
    return plain;
  } catch (error) {
    if (error instanceof FileDownloadError) throw error;
    if (timedOut) throw new FileDownloadError(`${kind}下载超时，请重试。`);
    if (options.signal?.aborted) throw new FileDownloadError(`${kind}下载已取消。`);
    // Fetch/decrypt errors can contain signed URLs. Never forward their raw text.
    throw new FileDownloadError(`${kind}下载失败，请检查网络后重试。`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}
