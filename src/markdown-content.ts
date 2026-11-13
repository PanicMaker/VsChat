import MarkdownIt from 'markdown-it';

export type MarkdownTag =
  | 'text' | 'p' | 'strong' | 'em' | 's' | 'code' | 'pre' | 'blockquote'
  | 'ul' | 'ol' | 'li' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'br' | 'hr' | 'a' | 'table' | 'thead' | 'tbody' | 'tr' | 'th' | 'td';

/** A data-only representation: neither HTML nor arbitrary attributes cross the Webview boundary. */
export interface MarkdownNode {
  tag: MarkdownTag;
  text?: string;
  children?: MarkdownNode[];
  href?: string;
  language?: string;
  start?: number;
}

export const MAX_MARKDOWN_LENGTH = 32_768;

/** Keep this allowlist in sync with webview/rich-content.js; both boundaries validate links. */
export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096 || !/^(?:https?:\/\/|mailto:)/i.test(value)
    || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return undefined;
  let decoded = value;
  // Repeated decoding catches nested encodings such as %250a without interpreting a URL as HTML.
  while (true) {
    if (/[\u0000-\u001f\u007f\\]/.test(decoded)) return undefined;
    const next = decoded.replace(/%([\da-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === decoded) break;
    decoded = next;
  }
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.hostname && !url.username && !url.password ? url.href : undefined;
    }
    if (url.protocol === 'mailto:' && url.pathname && !url.pathname.startsWith('//')) return url.href;
  } catch {
    // Malformed URLs are still displayed as ordinary text.
  }
  return undefined;
}

const parserOptions = { html: false, linkify: false, typographer: false, maxNesting: 20 };
const parser = new MarkdownIt(parserOptions);
type Token = ReturnType<MarkdownIt['parse']>[number];
const containerTags = new Set<MarkdownTag>([
  'p', 'strong', 'em', 's', 'blockquote', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
]);

function plainText(text: string): MarkdownNode {
  return { tag: 'text', text };
}

function imageAlt(tokens: Token[]): string {
  return tokens.map(token => {
    if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
    if (token.type === 'image') return imageAlt(token.children ?? []);
    return token.nesting === 0 ? token.content : '';
  }).join('');
}

function codeText(token: Token, lineEndings: string[]): string {
  if (!token.map) return token.content;
  let sourceLine = token.map[0] + (token.type === 'fence' ? 1 : 0);
  // CommonMark normalizes line endings and appends a newline to indented blocks.
  // Retain its de-indentation, but make copying preserve the actual source line endings.
  return token.content.replace(/\n/g, () => lineEndings[sourceLine++] ?? '');
}

function toNodes(tokens: Token[], lineEndings: string[]): MarkdownNode[] {
  const result: MarkdownNode[] = [];
  const stack: MarkdownNode[][] = [result];
  for (const token of tokens) {
    const target = stack[stack.length - 1];
    if (token.type === 'inline') {
      target.push(...toNodes(token.children ?? [], lineEndings));
    } else if (token.type === 'fence' || token.type === 'code_block') {
      target.push({
        tag: 'pre', text: codeText(token, lineEndings),
        ...(token.type === 'fence' && token.info.trim() ? { language: token.info.trim().split(/\s+/)[0].slice(0, 80) } : {}),
      });
    } else if (token.type === 'code_inline') {
      target.push({ tag: 'code', text: token.content });
    } else if (token.type === 'image') {
      target.push(plainText(`[图片：${imageAlt(token.children ?? []) || '未加载'}]`));
    } else if (token.type === 'softbreak') {
      target.push(plainText('\n'));
    } else if (token.type === 'hardbreak') {
      target.push({ tag: 'br' });
    } else if (token.type === 'hr') {
      target.push({ tag: 'hr' });
    } else if (token.nesting === 1 && containerTags.has(token.tag as MarkdownTag)) {
      const node: MarkdownNode = { tag: token.tag as MarkdownTag, children: [] };
      if (node.tag === 'a') node.href = safeExternalUrl(token.attrGet('href'));
      if (node.tag === 'ol') {
        const start = Number(token.attrGet('start') ?? 1);
        if (Number.isSafeInteger(start) && start > 0) node.start = start;
      }
      target.push(node);
      stack.push(node.children!);
    } else if (token.nesting === -1 && containerTags.has(token.tag as MarkdownTag)) {
      if (stack.length > 1) stack.pop();
    } else if (token.content) {
      // Unknown tokens never become arbitrary DOM tags or attributes.
      target.push(plainText(token.content));
    }
  }
  return result;
}

export function parseMarkdown(text: string): MarkdownNode[] {
  if (!text) return [];
  if (text.length > MAX_MARKDOWN_LENGTH) return [plainText(text)];
  try {
    return toNodes(parser.parse(text, {}), text.match(/\r\n?|\n/g) ?? []);
  } catch {
    return [plainText(text)];
  }
}
