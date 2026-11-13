import { ArchiveChannel, ArchiveImage, ArchiveMessage, ArchiveRecord, ArchiveSnapshot, ChatBackup } from './archive-types';
import { ChatMessagePart, MsgTypeValue } from './types';

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_RECORDS = 10_000;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PARTS = 100;
const MAX_TIMESTAMP = 8_640_000_000_000;

function invalid(detail: string): never { throw new Error(`归档格式无效：${detail}`); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(label);
  return value as Record<string, unknown>;
}
function array(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(label);
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) invalid(label);
  if (Object.keys(value).length !== value.length) invalid(label);
  return value;
}
function onlyKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) invalid(label);
}
function channel(value: unknown): ArchiveChannel {
  if (value !== 'qq' && value !== 'wechat') invalid('聊天通道');
  return value;
}
function positiveId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(label);
  return value as number;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_TIMESTAMP) invalid('时间戳');
  return value;
}
function type(value: unknown): MsgTypeValue {
  if (![1, 2, 3, 4, 5].includes(value as number)) invalid('消息类型');
  return value as MsgTypeValue;
}
function archiveKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value) || value.includes('..')) invalid('消息标识');
  return value;
}
function createdAt(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40) invalid('创建时间');
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) invalid('创建时间');
  return value;
}

class TextBudget {
  used = 0;
  text(value: unknown, label: string, max = MAX_TEXT_BYTES): string {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max) invalid(label);
    // Account for JSON escaping before constructing a large aggregate string.
    this.used += Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (this.used > MAX_ARCHIVE_BYTES) throw new Error('归档超过 64 MiB 限制');
    return value;
  }
}

function part(value: unknown, budget: TextBudget): ChatMessagePart {
  const input = object(value, '消息附件');
  const output: ChatMessagePart = { type: type(input.type) };
  for (const field of ['text', 'url', 'fileName', 'mimeType'] as const) {
    if (input[field] !== undefined) output[field] = budget.text(input[field], `附件 ${field}`);
  }
  if (input.size !== undefined) {
    if (!Number.isSafeInteger(input.size) || (input.size as number) < 0) invalid('附件大小');
    output.size = input.size as number;
  }
  if (input.fileMedia !== undefined) {
    if (output.type !== 4) invalid('文件解密描述');
    const media = object(input.fileMedia, '文件解密描述');
    const aesKey = budget.text(media.aesKey, '文件解密密钥', 512);
    if (!aesKey || /[\u0000-\u001f\u007f]/.test(aesKey)) invalid('文件解密密钥');
    output.fileMedia = { aesKey };
    if (media.encryptQueryParam !== undefined) output.fileMedia.encryptQueryParam = budget.text(media.encryptQueryParam, '文件下载参数', 8192);
    if (media.md5 !== undefined) output.fileMedia.md5 = budget.text(media.md5, '文件校验值', 128);
  }
  return output;
}

/** Rebuild data-only records; credentials, context tokens and runtime fields are never copied. */
export function validateArchiveRecords(value: unknown): ArchiveRecord[] {
  const input = array(value, MAX_ARCHIVE_RECORDS, '消息数量（最多 10000 条）');
  const keys = new Set<string>(), originalIds = new Set<number>();
  const budget = new TextBudget();
  return input.map(candidate => {
    const record = object(candidate, '消息记录');
    const key = archiveKey(record.key);
    const originalId = positiveId(record.originalId, '原消息编号');
    if (keys.has(key) || originalIds.has(originalId)) invalid('重复的消息标识或原编号');
    keys.add(key); originalIds.add(originalId);
    const source = object(record.message, '消息正文');
    if (source.direction !== 'sent' && source.direction !== 'received') invalid('消息方向');
    const message: ArchiveMessage = {
      direction: source.direction, type: type(source.type),
      content: budget.text(source.content, '消息正文（最多 1 MiB）'), timestamp: timestamp(source.timestamp),
      from_user_id: budget.text(source.from_user_id, '历史发送者'),
      to_user_id: budget.text(source.to_user_id, '历史接收者'),
    };
    for (const field of ['message_id', 'reference_id'] as const) {
      if (source[field] !== undefined) message[field] = budget.text(source[field], field);
    }
    if (source.reply_to !== undefined) message.reply_to = source.reply_to === null ? null : budget.text(source.reply_to, '引用正文');
    if (source.parts !== undefined) message.parts = array(source.parts, MAX_PARTS, '附件数量（最多 100 项）').map(value => part(value, budget));
    return { key, originalId, message };
  });
}

function imageData(value: unknown): { dataUrl: string; bytes: number } {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64) invalid('缓存图片大小（最多 10 MiB）');
  const match = /^data:image\/(png|jpeg|gif|webp|bmp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) invalid('缓存图片必须是规范的内嵌位图');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== match[2]) invalid('缓存图片 Base64 或大小');
  const magic = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : match[1] === 'jpeg' ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      : match[1] === 'gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
        : match[1] === 'webp' ? bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
          : bytes.subarray(0, 2).toString('ascii') === 'BM';
  if (!magic) invalid('缓存图片内容与位图类型不符');
  return { dataUrl: value, bytes: bytes.length };
}

function images(value: unknown, records: ArchiveRecord[]): ArchiveImage[] {
  const recordMap = new Map(records.map(record => [record.key, record.message]));
  const seen = new Set<string>();
  let bytes = 0;
  return array(value, MAX_ARCHIVE_RECORDS * (MAX_PARTS + 1), '缓存图片数量').map(candidate => {
    const input = object(candidate, '缓存图片');
    onlyKeys(input, ['messageKey', 'partIndex', 'dataUrl'], '缓存图片不得包含路径或额外字段');
    const messageKey = archiveKey(input.messageKey);
    const message = recordMap.get(messageKey);
    if (!message) invalid('缓存图片引用不存在的消息');
    const output: ArchiveImage = { messageKey, dataUrl: '' };
    if (input.partIndex !== undefined) {
      if (!Number.isSafeInteger(input.partIndex) || (input.partIndex as number) < 0
        || message.parts?.[input.partIndex as number]?.type !== 2) invalid('缓存图片附件索引');
      output.partIndex = input.partIndex as number;
    } else if (message.type !== 2 || message.parts !== undefined) invalid('缓存图片不对应旧版图片消息；多附件消息须指定图片索引');
    const cacheKey = `${messageKey}/${output.partIndex ?? 'legacy'}`;
    if (seen.has(cacheKey)) invalid('重复的缓存图片');
    seen.add(cacheKey);
    output.dataUrl = imageData(input.dataUrl).dataUrl;
    bytes += Buffer.byteLength(output.dataUrl);
    if (bytes > MAX_ARCHIVE_BYTES) throw new Error('归档超过 64 MiB 限制');
    return output;
  });
}

function backup(value: unknown, expectedChannel: ArchiveChannel): ChatBackup {
  const source = object(value, '备份对象');
  onlyKeys(source, ['format', 'version', 'channel', 'createdAt', 'records', 'images'], '备份包含未知字段');
  if (source.format !== 'vschat-backup' || source.version !== 1) invalid('不支持的备份格式或版本');
  const targetChannel = channel(source.channel);
  if (targetChannel !== channel(expectedChannel)) invalid('备份通道与当前聊天通道不同');
  const records = validateArchiveRecords(source.records);
  return { format: 'vschat-backup', version: 1, channel: targetChannel, createdAt: createdAt(source.createdAt), records, images: images(source.images, records) };
}

export function parseBackup(bytes: Uint8Array, expectedChannel: ArchiveChannel): ChatBackup {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('备份超过 64 MiB 限制或不是有效字节数据');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { invalid('备份不是有效 UTF-8 JSON'); }
  return backup(value, expectedChannel);
}

function outputBytes(value: string): Buffer {
  if (Buffer.byteLength(value, 'utf8') > MAX_ARCHIVE_BYTES) throw new Error('归档超过 64 MiB 限制');
  return Buffer.from(value, 'utf8');
}

export function createBackup(snapshot: ArchiveSnapshot, cachedImages: ArchiveImage[], date = new Date().toISOString()): Buffer {
  const output = backup({ format: 'vschat-backup', version: 1, channel: snapshot.channel, createdAt: date, records: snapshot.records, images: cachedImages }, snapshot.channel);
  return outputBytes(JSON.stringify(output, null, 2));
}

const labels: Record<MsgTypeValue, string> = { 1: '文本', 2: '图片', 3: '语音', 4: '文件', 5: '视频' };
function attachmentLabel(messageType: MsgTypeValue, name?: string): string {
  return `[${labels[messageType]}${name ? `：${name.replace(/\\/g, '/').split('/').pop()}` : ''}]`;
}

/** Old rows stored whole protocol file objects as their display text. Never share those secrets. */
function publicText(text: string, messageType?: MsgTypeValue, name?: string, fileBody = true): string {
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { /* Ordinary prose stays unchanged. */ }
  const protocol = decoded && typeof decoded === 'object'
    && /"(?:file_item|image_item|video_item|voice_item|fileMedia|aes_key|encrypt_query_param|cdn_url|full_url)"\s*:/.test(text);
  if (protocol) {
    const source = decoded as Record<string, unknown>;
    const file = source.file_item && typeof source.file_item === 'object' ? source.file_item as Record<string, unknown> : source;
    return attachmentLabel(messageType && messageType !== 1 ? messageType : 4, name || (typeof file.file_name === 'string' ? file.file_name : undefined));
  }
  const possibleUrl = typeof decoded === 'string' ? decoded : text;
  if (messageType && messageType !== 1 && /^https?:\/\/[^\s]+$/i.test(possibleUrl.trim())) return attachmentLabel(messageType, name);
  if (messageType === 4 && fileBody) return attachmentLabel(4, name);
  return text;
}

interface PublicPart { type: MsgTypeValue; text?: string; fileName?: string; size?: number; mimeType?: string }
interface PublicMessage {
  direction: 'sent' | 'received'; type: MsgTypeValue; content: string; timestamp: number; parts?: PublicPart[];
  reply?: { text: string; type?: MsgTypeValue; timestamp?: number; direction?: 'sent' | 'received' };
}
function publicMessage(source: ArchiveMessage): PublicMessage {
  const fileName = source.parts?.find(part => part.type === 4)?.fileName;
  const output: PublicMessage = {
    direction: source.direction, type: source.type,
    content: publicText(source.content, source.type, fileName), timestamp: source.timestamp,
  };
  if (source.parts) output.parts = source.parts.map(part => {
    const output: PublicPart = { type: part.type };
    if (part.text !== undefined) output.text = publicText(part.text, part.type, part.fileName, false);
    for (const field of ['fileName', 'mimeType'] as const) if (part[field] !== undefined) output[field] = part[field];
    if (part.size !== undefined) output.size = part.size;
    return output;
  });
  if (source.reply_to) {
    try {
      const reply = object(JSON.parse(source.reply_to), '引用正文');
      if (typeof reply.text === 'string') {
        const replyType = [1, 2, 3, 4, 5].includes(reply.type as number) ? reply.type as MsgTypeValue : undefined;
        output.reply = { text: publicText(reply.text, replyType) };
        if (replyType) output.reply.type = replyType;
        if (typeof reply.timestamp === 'number' && Number.isFinite(reply.timestamp) && reply.timestamp >= 0 && reply.timestamp <= MAX_TIMESTAMP) output.reply.timestamp = reply.timestamp;
        if (reply.direction === 'sent' || reply.direction === 'received') output.reply.direction = reply.direction;
      }
    } catch { /* Malformed old quote metadata is not needed by a shareable export. */ }
  }
  return output;
}

function fenced(text: string): string {
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
}

export function exportHistory(snapshot: ArchiveSnapshot, format: 'markdown' | 'json'): Buffer {
  const targetChannel = channel(snapshot.channel);
  const records = validateArchiveRecords(snapshot.records).map(record => publicMessage(record.message));
  if (format === 'json') return outputBytes(JSON.stringify({ format: 'vschat-export', version: 1, channel: targetChannel, records }, null, 2));
  if (format !== 'markdown') invalid('导出格式');
  const blocks = [`# VsChat 聊天记录 (${targetChannel === 'qq' ? 'QQ' : 'WeChat'})`];
  for (const message of records) {
    blocks.push(`## ${new Date(message.timestamp * 1000).toISOString()} · ${message.direction === 'sent' ? '发送' : '接收'}`);
    if (message.reply) blocks.push(`引用：\n\n${fenced(message.reply.text)}`);
    blocks.push(fenced(message.content));
    for (const part of message.parts || []) {
      if (part.type === 1 && (!part.text || part.text === message.content)) continue;
      const details = part.type === 1 ? [] : [attachmentLabel(part.type, part.fileName), ...(part.size === undefined ? [] : [`${part.size} bytes`]), ...(part.mimeType ? [part.mimeType] : [])];
      if (part.text) details.push(part.text);
      if (details.length) blocks.push(fenced(details.join('\n')));
    }
  }
  return outputBytes(`${blocks.join('\n\n')}\n`);
}

export function summarizeBackup(value: ChatBackup): { messageCount: number; imageCount: number; imageBytes: number; fromTimestamp?: number; toTimestamp?: number } {
  let imageBytes = 0;
  for (const image of value.images) {
    const base64 = image.dataUrl.slice(image.dataUrl.indexOf(',') + 1);
    imageBytes += base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  }
  const result: ReturnType<typeof summarizeBackup> = { messageCount: value.records.length, imageCount: value.images.length, imageBytes };
  for (const record of value.records) {
    result.fromTimestamp = result.fromTimestamp === undefined ? record.message.timestamp : Math.min(result.fromTimestamp, record.message.timestamp);
    result.toTimestamp = result.toTimestamp === undefined ? record.message.timestamp : Math.max(result.toTimestamp, record.message.timestamp);
  }
  return result;
}
