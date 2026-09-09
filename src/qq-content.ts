const QQ_FACE_TAG_PATTERN = /<faceType\s*=\s*[^>]*>/gi;
const MAX_FACE_NAME_LENGTH = 64;
const MAX_EXT_LENGTH = 8_192;

export interface QqContentParseResult {
  text: string;
  faceCount: number;
  fallbackCount: number;
  changed: boolean;
}

function readAttribute(tag: string, name: string): string {
  const pattern = new RegExp(
    `${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^,>\\s]+))`,
    'i'
  );
  const match = pattern.exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

function decodeFaceName(ext: string): string {
  if (!ext || ext.length > MAX_EXT_LENGTH) return '';
  try {
    const normalized = ext.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(normalized, 'base64').toString('utf8');
    const value = JSON.parse(decoded);
    if (!value || typeof value.text !== 'string') return '';
    return value.text
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, MAX_FACE_NAME_LENGTH);
  } catch {
    return '';
  }
}

/** Convert QQ Bot face markup into a stable, readable text label. */
export function parseQqContent(input: string): QqContentParseResult {
  let faceCount = 0;
  let fallbackCount = 0;
  const text = input.replace(QQ_FACE_TAG_PATTERN, (tag) => {
    faceCount += 1;
    const faceId = readAttribute(tag, 'faceId');
    const faceName = decodeFaceName(readAttribute(tag, 'ext'));
    if (faceName) return `[${faceName}]`;
    fallbackCount += 1;
    return faceId ? `[QQ表情 #${faceId}]` : '[QQ表情]';
  });

  return {
    text,
    faceCount,
    fallbackCount,
    changed: text !== input,
  };
}

export function normalizeQqContent(input: string): string {
  return parseQqContent(input).text;
}
