import * as vscode from 'vscode';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as lockfile from 'proper-lockfile';
import { ChatMessage, MsgTypeValue } from './types';
import * as log from './logger';

export interface QqReplyContext {
  messageId: string;
  sequence: number;
  timestamp: number;
}

export class ChatDB {
  private SQL: SqlJsStatic | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private initialized = false;
  private dbPath: string;
  private channel: 'wechat' | 'qq';

  constructor(
    context: vscode.ExtensionContext,
    channel: 'wechat' | 'qq' = 'wechat'
  ) {
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

    await this.withDatabase((db) => {
      db.run(`
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
      db.run(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);
      this.migrate(db);
      if (this.channel === 'qq') this.initQqReplyContexts(db);
    }, true);
    this.initialized = true;
    log.info('[DB] database ready', {
      channel: this.channel,
      durationMs: Date.now() - startedAt,
    });
  }

  private initQqReplyContexts(db: Database): void {
    if (db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'qq_reply_contexts'").length) return;
    db.run(`CREATE TABLE qq_reply_contexts (
      app_id TEXT NOT NULL,
      open_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (app_id, open_id, message_id)
    );
    CREATE INDEX qq_reply_contexts_recent ON qq_reply_contexts(app_id, open_id, timestamp DESC)`);
    // Old versions reset their single global counter when switching messages.
    // Its value cannot reliably tell us which sequences QQ has already seen.
    // Retire pre-upgrade contexts instead of risking reusing an accepted pair.
    db.run(`INSERT OR IGNORE INTO qq_reply_contexts
      (app_id, open_id, message_id, timestamp, sequence)
      SELECT to_user_id, from_user_id, message_id, MAX(timestamp), 2147483647
      FROM messages WHERE direction = 'received' AND message_id IS NOT NULL
        AND to_user_id IS NOT NULL AND from_user_id IS NOT NULL
      GROUP BY to_user_id, from_user_id, message_id`);
  }

  private migrate(db: Database): void {
    const cols = db.exec('PRAGMA table_info(messages)');
    const existing = new Set<string>();
    for (const row of cols[0]?.values ?? []) {
      existing.add(String(row[1]));
    }
    let changed = false;
    if (!existing.has('message_id')) {
      db.run('ALTER TABLE messages ADD COLUMN message_id TEXT');
      changed = true;
    }
    if (!existing.has('reply_to')) {
      db.run('ALTER TABLE messages ADD COLUMN reply_to TEXT');
      changed = true;
    }
    if (!existing.has('reference_id')) {
      db.run('ALTER TABLE messages ADD COLUMN reference_id TEXT');
      changed = true;
    }
    if (changed) {
      log.info('[DB] schema migration applied', {
        channel: this.channel,
        columns: [...existing],
      });
    }
  }

  // Every operation reads the latest disk snapshot while holding a cross-process
  // lock. Never export an instance's long-lived, possibly stale in-memory copy.
  private withDatabase<T>(
    operation: (db: Database) => T,
    write = false
  ): Promise<T> {
    const SQL = this.SQL;
    if (!SQL || this.closed)
      return Promise.reject(new Error('DB not initialized or closed'));
    const task = this.pending.then(async () => {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      const startedAt = Date.now();
      const release = await lockfile.lock(this.dbPath, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
        retries: {
          // Wait longer than the stale threshold so a crashed owner's lock
          // can be reclaimed within this operation rather than failing early.
          retries: 360,
          factor: 1,
          minTimeout: 100,
          maxTimeout: 100,
          randomize: true,
        },
      });
      let db: Database | undefined;
      try {
        if (this.initialized && !fs.existsSync(this.dbPath)) {
          throw new Error(
            'Chat database file disappeared; refusing to overwrite history'
          );
        }
        db = new SQL.Database(
          fs.existsSync(this.dbPath) ? fs.readFileSync(this.dbPath) : undefined
        );
        const value = operation(db);
        if (write) this.save(db);
        log.debug('[DB] shared operation completed', {
          channel: this.channel,
          write,
          durationMs: Date.now() - startedAt,
        });
        return value;
      } finally {
        db?.close();
        await release();
      }
    });
    this.pending = task.catch(() => undefined);
    return task;
  }

  private save(db: Database): void {
    // Keep the pre-upgrade snapshot once; replacing the live file is atomic.
    const backupPath = `${this.dbPath}.bak`;
    if (fs.existsSync(this.dbPath) && !fs.existsSync(backupPath)) {
      fs.copyFileSync(this.dbPath, backupPath, fs.constants.COPYFILE_EXCL);
    }
    const temporaryPath = `${this.dbPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporaryPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, Buffer.from(db.export()));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporaryPath, this.dbPath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }

  async insertMessage(msg: Omit<ChatMessage, 'id'>): Promise<number> {
    const { id } = await this.withDatabase((db) => this.insertMessageRow(db, msg), true);
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

  private insertMessageRow(db: Database, msg: Omit<ChatMessage, 'id'>): { id: number; inserted: boolean } {
    // Two extension hosts may receive the same transport event concurrently.
    if (msg.message_id) {
      const existing = db.exec(
        'SELECT id FROM messages WHERE message_id = ? AND direction = ? LIMIT 1',
        [msg.message_id, msg.direction]
      );
      if (existing[0]?.values.length) return { id: Number(existing[0].values[0][0]), inserted: false };
    }
    db.run(
      `INSERT INTO messages (direction, type, content, timestamp, context_token, from_user_id, to_user_id, message_id, reference_id, reply_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msg.direction,
        msg.type,
        msg.content,
        msg.timestamp,
        msg.context_token || '',
        msg.from_user_id,
        msg.to_user_id,
        msg.message_id || null,
        msg.reference_id || null,
        msg.reply_to || null,
      ]
    );

    // Get the ID before save() — sql.js preserves last_insert_rowid()
    const row = db.exec('SELECT last_insert_rowid()');
    return { id: row[0]?.values[0]?.[0] as number, inserted: true };
  }

  /** Deduplication, inbound persistence and routing advance share one disk lock. */
  async storeQqInbound(msg: Omit<ChatMessage, 'id'>): Promise<{
    id: number; inserted: boolean; latestAdvanced: boolean;
  }> {
    if (this.channel !== 'qq' || msg.direction !== 'received' || !msg.message_id || !msg.from_user_id || !msg.to_user_id) {
      throw new Error('Invalid QQ inbound context');
    }
    return this.withDatabase((db) => {
      const result = this.insertMessageRow(db, msg);
      const known = db.exec(`SELECT 1 FROM qq_reply_contexts
        WHERE app_id = ? AND open_id = ? AND message_id = ?`,
      [msg.to_user_id, msg.from_user_id, msg.message_id!]);
      db.run(`INSERT OR IGNORE INTO qq_reply_contexts
        (app_id, open_id, message_id, timestamp) VALUES (?, ?, ?, ?)`,
      [msg.to_user_id, msg.from_user_id, msg.message_id!, msg.timestamp]);
      const latest = db.exec("SELECT value FROM metadata WHERE key = 'qq_last_inbound_timestamp'");
      const latestTimestamp = Number(latest[0]?.values[0]?.[0] || 0);
      const latestAdvanced = !known.length && msg.timestamp >= latestTimestamp;
      if (latestAdvanced) {
        for (const [key, value] of [
          ['qq_user_openid', msg.from_user_id],
          ['qq_last_inbound_message_id', msg.message_id!],
          ['qq_last_inbound_timestamp', String(msg.timestamp)],
        ]) db.run('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [key, value]);
      }
      return { ...result, latestAdvanced };
    }, true);
  }

  /** Reserve before HTTP, never roll back on failure: a timeout may mean delivered. */
  async reserveQqReply(options: {
    appId: string; openId: string; messageId?: string;
    nowSeconds: number; windowSeconds: number; maxReplies: number;
  }): Promise<QqReplyContext | null> {
    if (this.channel !== 'qq') throw new Error('QQ reply reservation requires QQ storage');
    return this.withDatabase((db) => {
      const { appId, openId, messageId, nowSeconds, windowSeconds, maxReplies } = options;
      const rows = db.exec(`SELECT message_id, sequence, timestamp FROM qq_reply_contexts
        WHERE app_id = ? AND open_id = ? AND timestamp BETWEEN ? AND ?
        ${messageId === undefined ? '' : 'AND message_id = ?'}
        ORDER BY timestamp DESC, rowid DESC LIMIT 1`,
      [appId, openId, nowSeconds - windowSeconds, nowSeconds, ...(messageId === undefined ? [] : [messageId])]);
      const row = rows[0]?.values[0];
      // Do not silently switch to an older inbound when the newest is exhausted.
      if (!row || Number(row[1]) >= maxReplies) return null;
      const sequence = Number(row[1]) + 1;
      db.run(`UPDATE qq_reply_contexts SET sequence = ?
        WHERE app_id = ? AND open_id = ? AND message_id = ?`,
      [sequence, appId, openId, String(row[0])]);
      return { messageId: String(row[0]), sequence, timestamp: Number(row[2]) };
    }, true);
  }

  async getRecentMessages(
    limit: number = 100,
    beforeId?: number
  ): Promise<ChatMessage[]> {
    return this.withDatabase((db) => {
      const results = db.exec(
        `SELECT id, direction, type, content, timestamp, context_token, from_user_id, to_user_id, message_id, reference_id, reply_to
       FROM messages ${beforeId === undefined ? '' : 'WHERE id < ?'} ORDER BY id DESC LIMIT ?`,
        beforeId === undefined ? [limit] : [beforeId, limit]
      );
      if (!results.length || !results[0].values.length) return [];
      const messages = this.mapRows(results[0].values);
      log.debug('[DB] recent messages loaded', {
        channel: this.channel,
        requested: limit,
        returned: messages.length,
      });
      return messages;
    });
  }

  async getMessagesFromId(firstId: number): Promise<ChatMessage[]> {
    return this.withDatabase((db) => {
      const result = db.exec(
        `SELECT id, direction, type, content, timestamp, context_token, from_user_id, to_user_id, message_id, reference_id, reply_to
         FROM messages WHERE id >= ? ORDER BY id DESC`,
        [firstId]
      );
      return this.mapRows(result[0]?.values ?? []);
    });
  }

  // Look up a message by its iLink message id (used to resolve quoted text
  // when the inbound ref_msg omits text_item — which iLink usually does)
  async findByMessageId(messageId: string): Promise<ChatMessage | null> {
    return this.withDatabase((db) => {
      const results = db.exec(
        `SELECT id, direction, type, content, timestamp, context_token, from_user_id, to_user_id, message_id, reference_id, reply_to
       FROM messages WHERE message_id = ? ORDER BY id DESC LIMIT 1`,
        [messageId]
      );
      if (!results.length || !results[0].values.length) return null;
      return this.mapRows(results[0].values)[0];
    });
  }

  // Fallback lookup for quote resolution: iLink ref_msg may carry only a
  // timestamp (no text, and the id may be a peer-side id we never stored).
  async findByTimestamp(
    timestamp: number,
    windowSec: number = 2
  ): Promise<ChatMessage | null> {
    return this.withDatabase((db) => {
      const results = db.exec(
        `SELECT id, direction, type, content, timestamp, context_token, from_user_id, to_user_id, message_id, reference_id, reply_to
       FROM messages WHERE timestamp BETWEEN ? AND ? ORDER BY id DESC LIMIT 1`,
        [timestamp - windowSec, timestamp + windowSec]
      );
      if (!results.length || !results[0].values.length) return null;
      return this.mapRows(results[0].values)[0];
    });
  }

  private mapRows(
    rows: (number | string | Uint8Array | null)[][]
  ): ChatMessage[] {
    return rows
      .map((row: (number | string | Uint8Array | null)[]) => ({
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
      }))
      .reverse();
  }

  async clearAll(): Promise<void> {
    await this.withDatabase((db) => db.run('DELETE FROM messages'), true);
    // "Clear Chat History" must not erase login/session routing metadata;
    // doing so disconnects the active transport and loses the current peer.
    log.info('[DB] chat history cleared', { channel: this.channel });
  }

  async normalizeMessageText(
    normalizer: (value: string) => string
  ): Promise<{
    scanned: number;
    contentUpdated: number;
    replyUpdated: number;
  }> {
    return this.withDatabase((db) => {
      const result = db.exec('SELECT id, content, reply_to FROM messages');
      const rows = result[0]?.values ?? [];
      let contentUpdated = 0;
      let replyUpdated = 0;

      db.run('BEGIN TRANSACTION');
      try {
        for (const row of rows) {
          const id = Number(row[0]);
          const content = String(row[1] ?? '');
          const replyTo = typeof row[2] === 'string' ? row[2] : null;
          const normalizedContent = normalizer(content);
          let normalizedReplyTo = replyTo;

          if (replyTo) {
            try {
              const parsed = JSON.parse(replyTo);
              if (parsed && typeof parsed.text === 'string') {
                const normalizedText = normalizer(parsed.text);
                if (normalizedText !== parsed.text) {
                  parsed.text = normalizedText;
                  normalizedReplyTo = JSON.stringify(parsed);
                  replyUpdated += 1;
                }
              }
            } catch {
              // Preserve malformed legacy reply metadata instead of discarding it.
            }
          }

          if (normalizedContent !== content) contentUpdated += 1;
          if (normalizedContent !== content || normalizedReplyTo !== replyTo) {
            db.run(
              'UPDATE messages SET content = ?, reply_to = ? WHERE id = ?',
              [normalizedContent, normalizedReplyTo, id]
            );
          }
        }
        db.run('COMMIT');
      } catch (err) {
        db.run('ROLLBACK');
        throw err;
      }

      return { scanned: rows.length, contentUpdated, replyUpdated };
    }, true);
  }

  async setMetadata(key: string, value: string): Promise<void> {
    await this.withDatabase((db) => {
      db.run(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`, [
        key,
        value,
      ]);
    }, true);
  }

  async getMetadata(key: string): Promise<string | null> {
    return this.withDatabase((db) => {
      const results = db.exec(`SELECT value FROM metadata WHERE key = ?`, [
        key,
      ]);
      if (!results.length || !results[0].values.length) return null;
      return results[0].values[0][0] as string;
    });
  }

  async close(): Promise<void> {
    log.info('[DB] closing database', { channel: this.channel });
    this.closed = true;
    await this.pending;
    this.SQL = null;
  }
}
