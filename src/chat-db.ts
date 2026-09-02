import * as vscode from 'vscode';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage, MsgTypeValue } from './types';
import * as log from './logger';

export class ChatDB {
  private db: Database | null = null;
  private SQL: SqlJsStatic | null = null;
  private dbPath: string;
  private channel: 'wechat' | 'qq';

  constructor(context: vscode.ExtensionContext, channel: 'wechat' | 'qq' = 'wechat') {
    this.channel = channel;
    // Keep the original filename for WeChat so existing history is preserved.
    this.dbPath = path.join(
      context.globalStorageUri.fsPath,
      channel === 'qq' ? 'vschat_qq_chats.db' : 'vschat_chats.db'
    );
  }

  async init(): Promise<void> {
    const startedAt = Date.now();
    const existed = fs.existsSync(this.dbPath);
    log.info('[DB] opening database', { channel: this.channel, existed });
    this.SQL = await initSqlJs();

    if (existed) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(buffer);
      log.debug('[DB] database file loaded', { channel: this.channel, bytes: buffer.length });
      // Migrate older DBs: add quote-related columns if missing
      await this.migrate();
    } else {
      this.db = new this.SQL.Database();
      this.db.run(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          direction TEXT NOT NULL,
          type INTEGER NOT NULL,
          content TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          context_token TEXT,
          from_user_id TEXT,
          to_user_id TEXT,
          message_id TEXT,
          reference_id TEXT,
          reply_to TEXT
        )
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);
      this.save();
    }
    log.info('[DB] database ready', { channel: this.channel, durationMs: Date.now() - startedAt });
  }

  private async migrate(): Promise<void> {
    if (!this.db) return;
    const cols = this.db.exec('PRAGMA table_info(messages)');
    const existing = new Set<string>();
    for (const row of cols[0]?.values ?? []) {
      existing.add(String(row[1]));
    }
    let changed = false;
    if (!existing.has('message_id')) {
      this.db.run('ALTER TABLE messages ADD COLUMN message_id TEXT');
      changed = true;
    }
    if (!existing.has('reply_to')) {
      this.db.run('ALTER TABLE messages ADD COLUMN reply_to TEXT');
      changed = true;
    }
    if (!existing.has('reference_id')) {
      this.db.run('ALTER TABLE messages ADD COLUMN reference_id TEXT');
      changed = true;
    }
    if (changed) {
      log.info('[DB] schema migration applied', { channel: this.channel, columns: [...existing] });
      this.save();
    }
  }

  private save(): void {
    if (!this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.writeFileSync(this.dbPath, buffer);
  }

  async insertMessage(msg: Omit<ChatMessage, 'id'>): Promise<number> {
    if (!this.db) throw new Error('DB not initialized');
    this.db.run(
      `INSERT INTO messages (direction, type, content, timestamp, context_token, from_user_id, to_user_id, message_id, reference_id, reply_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [msg.direction, msg.type, msg.content, msg.timestamp, msg.context_token || '', msg.from_user_id, msg.to_user_id, msg.message_id || null, msg.reference_id || null, msg.reply_to || null]
    );

    // Get the ID before save() — sql.js preserves last_insert_rowid()
    const row = this.db.exec('SELECT last_insert_rowid()');
    const id = row[0]?.values[0]?.[0] as number;

    this.save();
    log.debug('[DB] message inserted', {
      channel: this.channel,
      dbId: id,
      direction: msg.direction,
      type: msg.type,
      contentLength: msg.content.length,
      messageId: msg.message_id,
      hasReference: Boolean(msg.reference_id || msg.reply_to),
    });
    return id;
  }

  async getRecentMessages(limit: number = 100): Promise<ChatMessage[]> {
    if (!this.db) return [];
    const results = this.db.exec(
      `SELECT id, direction, type, content, timestamp, context_token, from_user_id, to_user_id, message_id, reference_id, reply_to
       FROM messages ORDER BY id DESC LIMIT ?`,
      [limit]
    );
    if (!results.length || !results[0].values.length) return [];
    const messages = this.mapRows(results[0].values);
    log.debug('[DB] recent messages loaded', { channel: this.channel, requested: limit, returned: messages.length });
    return messages;
  }

  // Look up a message by its iLink message id (used to resolve quoted text
  // when the inbound ref_msg omits text_item — which iLink usually does)
  async findByMessageId(messageId: string): Promise<ChatMessage | null> {
    if (!this.db) return null;
    const results = this.db.exec(
      `SELECT id, direction, type, content, timestamp, context_token, from_user_id, to_user_id, message_id, reference_id, reply_to
       FROM messages WHERE message_id = ? ORDER BY id DESC LIMIT 1`,
      [messageId]
    );
    if (!results.length || !results[0].values.length) return null;
    return this.mapRows(results[0].values)[0];
  }

  // Fallback lookup for quote resolution: iLink ref_msg may carry only a
  // timestamp (no text, and the id may be a peer-side id we never stored).
  async findByTimestamp(timestamp: number, windowSec: number = 2): Promise<ChatMessage | null> {
    if (!this.db) return null;
    const results = this.db.exec(
      `SELECT id, direction, type, content, timestamp, context_token, from_user_id, to_user_id, message_id, reference_id, reply_to
       FROM messages WHERE timestamp BETWEEN ? AND ? ORDER BY id DESC LIMIT 1`,
      [timestamp - windowSec, timestamp + windowSec]
    );
    if (!results.length || !results[0].values.length) return null;
    return this.mapRows(results[0].values)[0];
  }

  private mapRows(rows: (number | string | Uint8Array | null)[][]): ChatMessage[] {
    return rows.map((row: (number | string | Uint8Array | null)[]) => ({
      id: row[0] as number,
      direction: row[1] as 'sent' | 'received',
      type: row[2] as MsgTypeValue,
      content: row[3] as string,
      timestamp: row[4] as number,
      context_token: row[5] as string,
      from_user_id: row[6] as string,
      to_user_id: row[7] as string,
      message_id: (row[8] as string) || undefined,
      reference_id: (row[9] as string) || undefined,
      reply_to: row[10] as string | null,
    })).reverse();
  }

  async clearAll(): Promise<void> {
    if (!this.db) return;
    this.db.run('DELETE FROM messages');
    // "Clear Chat History" must not erase login/session routing metadata;
    // doing so disconnects the active transport and loses the current peer.
    this.save();
    log.info('[DB] chat history cleared', { channel: this.channel });
  }

  async setMetadata(key: string, value: string): Promise<void> {
    if (!this.db) return;
    this.db.run(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`, [key, value]);
    this.save();
  }

  async getMetadata(key: string): Promise<string | null> {
    if (!this.db) return null;
    const results = this.db.exec(`SELECT value FROM metadata WHERE key = ?`, [key]);
    if (!results.length || !results[0].values.length) return null;
    return results[0].values[0][0] as string;
  }

  async close(): Promise<void> {
    log.info('[DB] closing database', { channel: this.channel });
    this.save();
    this.db = null;
  }
}
