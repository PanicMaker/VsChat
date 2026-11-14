// Transport-neutral message types shared by WeChat and QQ.
export const MsgType = {
  Text: 1,
  Image: 2,
  Voice: 3,
  File: 4,
  Video: 5,
} as const;

export type MsgTypeValue = (typeof MsgType)[keyof typeof MsgType];

export interface ChatMessagePart {
  type: MsgTypeValue;
  text?: string;
  url?: string;
  fileName?: string;
  size?: number;
  mimeType?: string;
  fileMedia?: { aesKey: string; encryptQueryParam?: string; md5?: string }; // host-only download metadata
  fileAction?: { canSave: boolean; reason?: string }; // runtime-only card capability
  imageDataUrl?: string; // hydrated for display; never persisted in the message row
  markdown?: import('./markdown-content').MarkdownNode[]; // runtime-only rendering tokens
}

// Internal message representation for UI and storage
export interface ChatMessage {
  id: number;
  restored?: boolean; // historical import, excluded from unread counts and notifications
  direction: 'sent' | 'received';
  type: MsgTypeValue;
  content: string;
  parts?: ChatMessagePart[]; // ordered contents of one transport envelope
  markdown?: import('./markdown-content').MarkdownNode[]; // runtime-only rendering tokens
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

export interface FileCapabilities {
  canSend: boolean;
  maxBytes: number;
  reason?: string;
}

export interface ConnectionHealth {
  state: 'offline' | 'connecting' | 'online' | 'reconnecting' | 'error';
  detail: string;
  lastAckAt?: number;
  retryAt?: number;
}

export interface FileDraft {
  fileId: string;
  fileName: string;
  size: number;
}

// Message from WebView to extension host
export interface WebViewOutbound {
  command: string;
  recipientId?: string;
  selectionId?: string;
  requestId?: string; // correlates one send attempt with its result
  text?: string;
  imagePath?: string; // local file path for images
  fileData?: string; // bounded base64 data URL from a user-selected client file
  imageData?: string; // base64 data URL for images from WebView
  fileName?: string;
  url?: string;
  replyTo?: ReplyTo;
  beforeId?: number; // exclusive cursor for older history pages
  generation?: string; // identifies the current shared history after clears
  throughId?: number; // last rendered message acknowledged as read
  query?: string;
  type?: MsgTypeValue;
  fromTimestamp?: number;
  toTimestamp?: number;
  targetId?: number;
  messageId?: string;
  fileId?: string;
  partIndex?: number;
  format?: 'markdown' | 'json';
  previewId?: string;
  includeImages?: boolean;
}

// Message from extension host to WebView
export interface WebViewInbound {
  command: string;
  connectionHealth?: ConnectionHealth;
  recipientId?: string;
  selectionId?: string;
  recipients?: import('./recipient-types').RecipientOption[];
  recipientReason?: string;
  totalUnreadCount?: number;
  requestId?: string;
  sendStatus?: 'sending' | 'sent' | 'failed' | 'uncertain';
  channel?: string;
  message?: ChatMessage;
  messages?: ChatMessage[];
  qrcode?: string; // base64 or URL of QR code image
  status?: string; // login status text
  error?: string;
  warning?: string; // non-blocking warning (e.g. stale session)
  imageDataUrl?: string | null; // decrypted image data URL for webview
  hasMore?: boolean;
  older?: boolean;
  generation?: string;
  reset?: boolean;
  unreadCount?: number;
  readThroughId?: number;
  focused?: boolean;
  sendShortcut?: 'enter' | 'ctrlEnter';
  renderMarkdown?: boolean;
  targetId?: number;
  hasBefore?: boolean;
  hasAfter?: boolean;
  fileCapabilities?: FileCapabilities;
  fileDraft?: FileDraft;
  fileId?: string;
  valid?: boolean;
  cancelled?: boolean;
  fileStatus?: 'saving' | 'saved' | 'failed' | 'cancelled';
  operation?: 'export' | 'backup' | 'restorePreview' | 'restoreConfirm' | 'storage' | 'cleanupPreview' | 'cleanupConfirm';
  previewId?: string;
  data?: Record<string, unknown>;
}
