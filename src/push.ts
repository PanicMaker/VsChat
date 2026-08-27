import * as vscode from 'vscode';
import { fetch } from 'undici';
import * as log from './logger';
import { ChatMessage } from './types';

const MAX_CONTENT_LENGTH = 500;

// 通知/提示条用的消息预览：文本直接显示，语音优先显示转写文本（兼容
// content 是整段 JSON 的旧记录），其余沿用 [Image] 占位。
export function previewForNotification(msg: ChatMessage): string {
  if (msg.type === 1) return msg.content;
  if (msg.type === 3) {
    const content = msg.content || '';
    return content.startsWith('{') ? '[语音消息]' : `[语音] ${content}`;
  }
  return '[Image]';
}

/**
 * Send a push notification to iPhone via Bark.
 *
 * The `vschat.barkUrl` setting accepts either:
 *  - a base URL (e.g. https://api.day.app/YOUR_KEY/), title/message are
 *    URL-encoded and appended as path segments; or
 *  - a template containing {title} and {message} placeholders for more
 *    control (query params, custom sound, etc.).
 *
 * Returns true when a push was sent successfully, false when disabled or failed.
 */
export async function sendBarkPush(title: string, message: string): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('vschat');
  const barkUrl = (config.get<string>('barkUrl') || '').trim();
  if (!barkUrl) {
    log.info('Bark push skipped: vschat.barkUrl not configured');
    return false;
  }

  const safeMessage = message.length > MAX_CONTENT_LENGTH
    ? `${message.slice(0, MAX_CONTENT_LENGTH)}…`
    : message;

  let url: string;
  if (barkUrl.includes('{title}') || barkUrl.includes('{message}')) {
    url = barkUrl
      .replace(/\{title\}/g, encodeURIComponent(title))
      .replace(/\{message\}/g, encodeURIComponent(safeMessage));
  } else {
    const base = barkUrl.replace(/\/+$/, '');
    url = `${base}/${encodeURIComponent(title)}/${encodeURIComponent(safeMessage)}`;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) {
        log.error('Bark push failed, HTTP', resp.status);
        return false;
      }
      const body = await resp.text();
      log.info('Bark push sent, response:', body.slice(0, 200));
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    log.error('Bark push error:', err instanceof Error ? err.message : String(err));
    return false;
  }
}
