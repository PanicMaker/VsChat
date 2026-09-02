// Transport-neutral message types shared by WeChat and QQ.
export const MsgType = {
  Text: 1,
  Image: 2,
  Voice: 3,
  File: 4,
  Video: 5,
} as const;

export type MsgTypeValue = (typeof MsgType)[keyof typeof MsgType];

// Internal message representation for UI and storage
export interface ChatMessage {
  id: number;
  direction: 'sent' | 'received';
  type: MsgTypeValue;
  content: string;
  timestamp: number;
  context_token: string;
  from_user_id: string;
  to_user_id: string;
  message_id?: string; // transport message id (used for replies/deduplication)
  reference_id?: string; // transport-specific quote reference (QQ msg_idx/ref_idx)
  reply_to?: string | null; // JSON: { messageId, type, text, timestamp }
}

// Outbound quote reference (from WebView to extension host)
export interface ReplyTo {
  messageId: string;
  referenceId?: string;
  direction?: 'sent' | 'received';
  type?: MsgTypeValue;
  text?: string;
  timestamp?: number; // seconds
}

// Message from WebView to extension host
export interface WebViewOutbound {
  command: string;
  text?: string;
  imagePath?: string; // local file path for images
  imageData?: string; // base64 data URL for images from WebView
  fileName?: string;
  url?: string;
  replyTo?: ReplyTo;
}

// Message from extension host to WebView
export interface WebViewInbound {
  command: string;
  message?: ChatMessage;
  messages?: ChatMessage[];
  qrcode?: string; // base64 or URL of QR code image
  status?: string; // login status text
  error?: string;
  warning?: string; // non-blocking warning (e.g. stale session)
  imageDataUrl?: string | null; // decrypted image data URL for webview
}
