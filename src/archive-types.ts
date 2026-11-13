import { ChatMessage } from './types';

export type ArchiveChannel = 'wechat' | 'qq';
export type ArchiveMessage = Omit<ChatMessage, 'id' | 'context_token' | 'restored' | 'markdown'>;
export interface ArchiveRecord { key: string; originalId: number; message: ArchiveMessage }
export interface ArchiveImage { messageKey: string; partIndex?: number; dataUrl: string }
export interface ArchiveSnapshot {
  channel: ArchiveChannel;
  generation: string;
  contentVersion: number;
  records: ArchiveRecord[];
}
export interface ChatBackup {
  format: 'vschat-backup';
  version: 1;
  channel: ArchiveChannel;
  createdAt: string;
  records: ArchiveRecord[];
  images: ArchiveImage[];
}
export interface RestorePlan { generation: string; total: number; newCount: number; duplicateCount: number; conflictCount: number }
export interface RestoreResult {
  generation: string;
  inserted: number;
  skipped: number;
  conflicts: number;
  mapping: Array<{ key: string; id: number; inserted: boolean }>;
}
