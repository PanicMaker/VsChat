import * as vscode from 'vscode';
import { ChatMessage, ChatMessagePart, ConnectionHealth, FileCapabilities, ReplyTo } from './types';
import { RecipientState, SendTarget } from './recipient-types';

/**
 * Transport-neutral contract used by the webview.  WeChat/iLink and QQ Bot
 * have very different login and event protocols, but expose the same chat
 * operations to the rest of the extension.
 */
export interface ChatClient extends vscode.Disposable {
  readonly channelName: string;
  readonly connected: boolean;
  readonly fileCapabilities?: FileCapabilities;
  readonly connectionHealth?: ConnectionHealth;
  readonly onConnectionHealth?: vscode.Event<ConnectionHealth>;
  readonly onMessage: vscode.Event<ChatMessage>;
  readonly onStatus: vscode.Event<string>;
  readonly onQrCode: vscode.Event<string>;
  readonly onLoginSuccess: vscode.Event<void>;

  login(): Promise<void>;
  restoreLogin(): Promise<boolean>;
  startPolling(): Promise<void>;
  stopPolling(): void;
  getRecipients?(): Promise<RecipientState>;
  captureSendTarget?(recipientId: string): Promise<SendTarget>;
  sendText(text: string, replyTo?: ReplyTo, target?: SendTarget): Promise<string | undefined>;
  sendImage(imagePath: string, target?: SendTarget): Promise<string | undefined>;
  sendFile?(filePath: string, originalName?: string, target?: SendTarget): Promise<string | undefined>;
  downloadFile?(part: ChatMessagePart, signal?: AbortSignal): Promise<Buffer>;
  getDecryptedImageUrl(messageId: number, partIndex?: number): Promise<string | undefined>;
  logout(): Promise<void>;
}
