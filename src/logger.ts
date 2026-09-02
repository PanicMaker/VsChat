import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY = /(secret|password|authorization|credential|(?:^|_)token|token$|aes_?key|qrcode|context_?token|upload_?url|presigned_?url|full_?url|bark_?url|proxy_?url)/i;
const IDENTIFIER_KEY = /(^|_)(app_?id|open_?id|user_?id|from_?user_?id|to_?user_?id|message_?id|response_?message_?id|reference_?id|session_?id|client_?id|upload_?id|file_?info|file_?uuid|trace_?id)$/i;
const MAX_STRING_LENGTH = 2_000;
const MAX_DEPTH = 5;

let outputChannel: vscode.OutputChannel | undefined;
let minimumLevel: LogLevel = 'debug';
let activationId = createId('run');

function getChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel('VsChat');
  }
  return outputChannel;
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function nextId(prefix = 'op'): string {
  return createId(prefix);
}

export function configure(level: LogLevel, details?: Record<string, unknown>): void {
  minimumLevel = level;
  activationId = createId('run');
  write('info', '[Core] logger initialized', { activationId, level, ...details });
}

export function maskId(value: unknown, visible = 4): string {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length <= visible * 2) return `${text.slice(0, 1)}***${text.slice(-1)}`;
  return `${text.slice(0, visible)}…${text.slice(-visible)}`;
}

export function describeUrl(value: unknown): string {
  try {
    const parsed = new URL(String(value));
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return value ? '[invalid-url]' : '';
  }
}

export function formatError(value: unknown): Record<string, unknown> {
  if (value instanceof Error) {
    const cause = (value as Error & { cause?: unknown }).cause;
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      ...(cause ? { cause: formatValue(cause, '', 1, new WeakSet<object>()) } : {}),
    };
  }
  return { error: formatValue(value, '', 0, new WeakSet<object>()) };
}

function redactString(value: string): string {
  const truncated = value.length > MAX_STRING_LENGTH
    ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${value.length - MAX_STRING_LENGTH} chars]`
    : value;
  return truncated
    .replace(/\b(Bearer|QQBot)\s+[^\s"']+/gi, '$1 [REDACTED]')
    .replace(/("(?:appSecret|clientSecret|token|authorization|context_token|aes_?key|qrcode)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@');
}

function formatValue(value: unknown, key: string, depth: number, seen: WeakSet<object>): unknown {
  if (SENSITIVE_KEY.test(key)) return typeof value === 'boolean' ? value : '[REDACTED]';
  if (IDENTIFIER_KEY.test(key) && (typeof value === 'string' || typeof value === 'number')) {
    return maskId(value);
  }
  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return formatError(value);
  if (depth >= MAX_DEPTH) return '[max-depth]';
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 50).map((item) => formatValue(item, key, depth + 1, seen));
    }
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      result[childKey] = formatValue(childValue, childKey, depth + 1, seen);
    }
    return result;
  }
  return String(value);
}

function render(args: unknown[]): string {
  return args.map((arg) => {
    if (typeof arg === 'string') return redactString(arg);
    try {
      return JSON.stringify(formatValue(arg, '', 0, new WeakSet<object>()));
    } catch {
      return '[unserializable]';
    }
  }).join(' ');
}

function write(level: LogLevel, ...args: unknown[]): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minimumLevel]) return;
  getChannel().appendLine(`[${timestamp()}] [${level.toUpperCase()}] ${render(args)}`);
}

export function debug(...args: unknown[]): void {
  write('debug', ...args);
}

export function info(...args: unknown[]): void {
  write('info', ...args);
}

export function warn(...args: unknown[]): void {
  write('warn', ...args);
}

export function error(...args: unknown[]): void {
  write('error', ...args);
}

export function show(): void {
  getChannel().show(true);
}

export function dispose(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
}
