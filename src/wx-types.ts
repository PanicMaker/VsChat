import { MsgTypeValue } from './types';

/** WeChat iLink item in a message's item_list. */
export interface WxMsgItem {
  type: MsgTypeValue;
  text_item?: { text: string };
  image_item?: { aeskey: string; media: { aes_key: string; full_url: string; encrypt_query_param?: string }; thumb_size?: number; mid_size?: number; thumb_width?: number; thumb_height?: number };
  voice_item?: {
    media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string };
    encode_type?: number;
    bits_per_sample?: number;
    sample_rate?: number;
    playtime?: number;
    text?: string;
    transcription?: string;
  };
  file_item?: { file_name: string; file_size: number; cdn_url: string };
  video_item?: { aes_key: string; cdn_url: string };
  msg_id?: string;
  create_time_ms?: number;
  ref_msg?: WxRefMessage;
}

/** Quoted WeChat message in the iLink protocol. */
export interface WxRefMessage {
  message_item?: WxMsgItem;
  title?: string;
}

/** Raw message received from the WeChat iLink API. */
export interface ILinkMessage {
  from_user_id: string;
  to_user_id: string;
  message_type: MsgTypeValue;
  message_state: number;
  context_token: string;
  item_list: WxMsgItem[];
  message_id?: number;
  // Exact string recovered from raw JSON because i64 exceeds JS safe integers.
  _exactMessageId?: string;
}

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

/** WeChat send response; HTTP 200 can still contain a business failure. */
export interface SendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  message_id?: number;
}
