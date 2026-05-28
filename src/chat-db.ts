import * as vscode from 'vscode';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage, MsgTypeValue } from './types';

export class ChatDB {
  private db: Database | null = null;
  private SQL: SqlJsStatic | null = null;
  private dbPath: string;

  constructor(context: vscode.ExtensionContext) {
    this.dbPath = path.join(context.globalStorageUri.fsPath, 'clawbot_chats.db');
  }

  async init(): Promise<void> {
    this.SQL = await initSqlJs();

    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(buffer);
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
          to_user_id TEXT
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
      `INSERT INTO messages (direction, type, content, timestamp, context_token, from_user_id, to_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [msg.direction, msg.type, msg.content, msg.timestamp, msg.context_token || '', msg.from_user_id, msg.to_user_id]
    );
    this.save();
    const row = this.db.exec('SELECT last_insert_rowid()')[0];
    return row.values[0][0] as number;
  }

  async getRecentMessages(limit: number = 100): Promise<ChatMessage[]> {
    if (!this.db) return [];
    const results = this.db.exec(
      `SELECT id, direction, type, content, timestamp, context_token, from_user_id, to_user_id
       FROM messages ORDER BY id DESC LIMIT ?`,
      [limit]
    );
    if (!results.length || !results[0].values.length) return [];
    return results[0].values.map((row: (number | string | Uint8Array | null)[]) => ({
      id: row[0] as number,
      direction: row[1] as 'sent' | 'received',
      type: row[2] as MsgTypeValue,
      content: row[3] as string,
      timestamp: row[4] as number,
      context_token: row[5] as string,
      from_user_id: row[6] as string,
      to_user_id: row[7] as string,
    })).reverse();
  }

  async clearAll(): Promise<void> {
    if (!this.db) return;
    this.db.run('DELETE FROM messages');
    this.db.run('DELETE FROM metadata');
    this.save();
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
    this.save();
    this.db = null;
  }
}
