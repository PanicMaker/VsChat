import * as vscode from 'vscode';
import { ChatMessage, ReplyTo } from './types';

/**
 * Transport-neutral contract used by the webview.  WeChat/iLink and QQ Bot
 * have very different login and event protocols, but expose the same chat
 * operations to the rest of the extension.
 */
export interface ChatClient extends vscode.Disposable {
  readonly channelName: string;
  readonly connected: boolean;
  readonly onMessage: vscode.Event<ChatMessage>;
  readonly onStatus: vscode.Event<string>;
  readonly onQrCode: vscode.Event<string>;
  readonly onLoginSuccess: vscode.Event<void>;

  login(): Promise<void>;
  restoreLogin(): Promise<boolean>;
  startPolling(): Promise<void>;
  stopPolling(): void;
  sendText(text: string, replyTo?: ReplyTo): Promise<string | undefined>;
  sendImage(imagePath: string): Promise<string | undefined>;
  getDecryptedImageUrl(messageId: number): Promise<string | undefined>;
  logout(): Promise<void>;
}
