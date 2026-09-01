// iLink API message types
export const MsgType = {
  Text: 1,
  Image: 2,
  Voice: 3,
  File: 4,
  Video: 5,
} as const;

export type MsgTypeValue = (typeof MsgType)[keyof typeof MsgType];

// Item in a message's item_list
export interface MsgItem {
  type: MsgTypeValue;
  text_item?: { text: string };
  image_item?: { aeskey: string; media: { aes_key: string; full_url: string; encrypt_query_param?: string }; thumb_size?: number; mid_size?: number; thumb_width?: number; thumb_height?: number };
  voice_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string };
    encode_type?: number;
    bits_per_sample?: number;
    sample_rate?: number;
    playtime?: number;
    text?: string; // 微信返回的语音转写文本
    transcription?: string; // 兼容旧字段
  };
  file_item?: { file_name: string; file_size: number; cdn_url: string };
  video_item?: { aes_key: string; cdn_url: string };
  msg_id?: string;
  create_time_ms?: number;
  ref_msg?: RefMessage;
}

// Quoted (referenced) message, per iLink protocol
export interface RefMessage {
  message_item?: MsgItem;
  title?: string; // 摘要
}

// Raw message from iLink API
export interface ILinkMessage {
  from_user_id: string;
  to_user_id: string;
  message_type: MsgTypeValue;
  message_state: number;
  context_token: string;
  item_list: MsgItem[];
  message_id?: number;
  // Exact string form of the peer-side message_id recovered from the raw JSON
  // body (i64 overflows JS numbers, so JSON.parse loses precision)
  _exactMessageId?: string;
}

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
  message_id?: string; // iLink msg id (only for received messages)
  reply_to?: string | null; // JSON: { messageId, type, text, timestamp }
}

// Outbound quote reference (from WebView to extension host)
export interface ReplyTo {
  messageId: string;
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

// iLink API response shapes
export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content?: string;
}

export interface QRCodeStatusResponse {
  status: 'confirmed' | 'binded_redirect' | 'expired' | 'scaned' | 'need_verifycode';
  bot_token?: string;
  baseurl?: string;
}

export interface GetUpdatesResponse {
  ret: number;
  msgs?: ILinkMessage[];
  get_updates_buf: string;
  longpolling_timeout_ms: number;
}

// sendMessage response: HTTP 200 does NOT mean the message was accepted —
// business errors come back as ret != 0 (e.g. expired session token)
export interface SendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  // Normal successful deliveries echo back the assigned message_id. A
  // response with ret:0 but no message_id means iLink accepted the request
  // without actually delivering it (observed 2026-08-31 platform behavior).
  message_id?: number;
}
