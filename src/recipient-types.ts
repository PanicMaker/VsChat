/** A conversation is scoped to both the bot account and its direct-message peer. */
export interface ConversationRef { accountId: string; peerId: string }

export interface RecipientOption {
  id: string;
  label: string;
  conversation?: ConversationRef;
  canSend: boolean;
  reason?: string;
  unreadCount?: number;
}

export interface RecipientState {
  accountId?: string;
  recipients: RecipientOption[];
  reason?: string;
  totalUnreadCount?: number;
}

/** Host-only snapshot. Never serialize this object to the webview. */
export interface SendTarget extends ConversationRef {
  channel: 'wechat' | 'qq';
  contextToken?: string;
  lastInboundTimestamp?: number;
  sessionKey?: string;
}

export function recipientId(conversation: ConversationRef): string {
  return JSON.stringify([conversation.accountId, conversation.peerId]);
}

export function sameConversation(left: ConversationRef, right: ConversationRef): boolean {
  return left.accountId === right.accountId && left.peerId === right.peerId;
}
