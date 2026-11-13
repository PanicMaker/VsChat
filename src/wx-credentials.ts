import { createHash } from 'crypto';
import type { SecretStorage } from 'vscode';

export const WX_ENDPOINT_SECRET = 'vschat_endpoint_v1';
export const DEFAULT_WX_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** Only official WeChat API origins can receive the bot's bearer credential. */
export function trustedWxBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\//i.test(value)
      || /[\u0000-\u0020\u007f-\u009f\\?#]/.test(value)) return undefined;
  // Do not let escaped controls or separators acquire a second interpretation
  // when a path prefix is combined with an API path later.
  let decoded = value;
  for (let iteration = 0; iteration < 8; iteration++) {
    if (/[\u0000-\u001f\u007f-\u009f\\]/.test(decoded)) return undefined;
    let next: string;
    try { next = decodeURIComponent(decoded); }
    catch { return undefined; }
    if (next === decoded) break;
    if (iteration === 7) return undefined;
    decoded = next;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || (url.port && url.port !== '443') || host.endsWith('.')
        || (host !== 'weixin.qq.com' && !host.endsWith('.weixin.qq.com'))) return undefined;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return undefined; }
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Add one secret binding; leave legacy credentials and the token key intact. */
export async function saveWxEndpoint(
  secrets: Pick<SecretStorage, 'store'>,
  token: string,
  baseUrl: string,
): Promise<void> {
  const trusted = trustedWxBaseUrl(baseUrl);
  if (typeof token !== 'string' || !token.trim() || !trusted) {
    throw new Error('微信登录凭据或 API 地址无效，未保存地址绑定。');
  }
  await secrets.store(WX_ENDPOINT_SECRET, JSON.stringify({ version: 1, tokenHash: tokenHash(token), baseUrl: trusted }));
}

/** Recover an endpoint only from data proven to belong to this exact token. */
export async function restoreWxEndpoint(
  secrets: Pick<SecretStorage, 'get'>,
  token: string,
  fileCredentials?: unknown,
): Promise<string> {
  if (typeof token !== 'string' || !token.trim()) return DEFAULT_WX_BASE_URL;
  try {
    const raw = await secrets.get(WX_ENDPOINT_SECRET);
    if (raw && raw.length <= 4096) {
      const saved: unknown = JSON.parse(raw);
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        const binding = saved as { version?: unknown; tokenHash?: unknown; baseUrl?: unknown };
        if (binding.version === 1 && binding.tokenHash === tokenHash(token)) {
          const trusted = trustedWxBaseUrl(binding.baseUrl);
          if (trusted) return trusted;
        }
      }
    }
  } catch {
    // An unavailable or corrupt binding never makes an unpaired URL trusted.
  }
  if (fileCredentials && typeof fileCredentials === 'object' && !Array.isArray(fileCredentials)) {
    const legacy = fileCredentials as { token?: unknown; baseUrl?: unknown };
    if (legacy.token === token) return trustedWxBaseUrl(legacy.baseUrl) || DEFAULT_WX_BASE_URL;
  }
  return DEFAULT_WX_BASE_URL;
}
