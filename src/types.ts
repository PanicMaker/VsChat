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
  voice_item?: { transcription: string };
  file_item?: { file_name: string; file_size: number; cdn_url: string };
  video_item?: { aes_key: string; cdn_url: string };
}

// Raw message from iLink API
export interface ILinkMessage {
  from_user_id: string;
  to_user_id: string;
  message_type: MsgTypeValue;
  message_state: number;
  context_token: string;
  item_list: MsgItem[];
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
}

// Message from WebView to extension host
export interface WebViewOutbound {
  command: string;
  text?: string;
  imagePath?: string; // local file path for images
  imageData?: string; // base64 data URL for images from WebView
  fileName?: string;
  url?: string;
}

// Message from extension host to WebView
export interface WebViewInbound {
  command: string;
  message?: ChatMessage;
  messages?: ChatMessage[];
  qrcode?: string; // base64 or URL of QR code image
  status?: string; // login status text
  error?: string;
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
