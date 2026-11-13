import * as vscode from 'vscode';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as lockfile from 'proper-lockfile';
import { ChatMessage, ChatMessagePart, MsgTypeValue } from './types';
import { ArchiveMessage, ArchiveRecord, ArchiveSnapshot, RestorePlan, RestoreResult } from './archive-types';
import { validateArchiveRecords } from './chat-archive';
import { ConversationRef, recipientId } from './recipient-types';
import * as log from './logger';

export interface QqReplyContext {
  messageId: string;
  sequence: number;
  timestamp: number;
}

export interface QqGatewayCheckpoint {
  sessionId: string;
  sequence: number;
  credentialKey: string;
}

export interface ConversationSummary {
  conversation: ConversationRef;
  lastTimestamp: number;
  unreadCount: number;
  hasLiveInbound: boolean;
}

export interface QqRecipientSummary {
  conversations: Array<ConversationSummary & { replyContext: QqReplyContext | null }>;
  totalUnreadCount: number;
}

export interface ChatSyncCursor {
  generation: string;
  contentVersion: number;
  lastId: number;
  conversationId?: string;
}

export interface ChatSyncSnapshot {
  cursor: ChatSyncCursor;
  messages: ChatMessage[];
  reset: boolean;
  hasMore?: boolean;
  unreadCount: number;
  readThroughId: number;
}

export interface ChatHistoryPage {
  generation: string;
  contentVersion: number;
  messages: ChatMessage[];
  hasMore: boolean;
}

export interface ChatSearchOptions {
  query: string;
  type?: MsgTypeValue;
  fromTimestamp?: number;
  toTimestamp?: number;
  beforeId?: number;
  generation?: string;
  limit?: number;
  conversation?: ConversationRef;
}

export interface ChatMessageContext {
  generation: string;
  contentVersion: number;
  messages: ChatMessage[];
  targetId: number;
  hasBefore: boolean;
  hasAfter: boolean;
}

const SYNC_GENERATION = 'vschat_sync_generation';
const SYNC_CONTENT_VERSION = 'vschat_sync_content_version';
const SYNC_READ_THROUGH = 'vschat_sync_read_through';
const QQ_GATEWAY_CHECKPOINT = 'qq_gateway_checkpoint_v1';
const MESSAGE_COLUMNS = 'id, direction, type, content, timestamp, context_token, from_user_id, to_user_id, message_id, reference_id, reply_to, parts, imported';
const ACCOUNT_COLUMN = "CASE WHEN direction = 'received' THEN to_user_id WHEN direction = 'sent' THEN from_user_id END";
const PEER_COLUMN = "CASE WHEN direction = 'received' THEN from_user_id WHEN direction = 'sent' THEN to_user_id END";
// Both malformed legacy JSON and non-object array elements must remain safe to
// query. CASE prevents JSON extraction from evaluating invalid input.
const PART_TYPE_MATCH = `EXISTS (
  SELECT 1 FROM json_each(CASE WHEN json_valid(parts)
    THEN CASE WHEN json_type(parts) = 'array' THEN parts ELSE '[]' END
    ELSE '[]' END) AS part
  WHERE CASE WHEN part.type = 'object' THEN json_extract(part.value, '$.type') END = ?
)`;

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
          reply_to TEXT,
          parts TEXT,
          archive_key TEXT,
          imported INTEGER NOT NULL DEFAULT 0
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS metadata (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);
      this.migrate(db);
      db.run('CREATE INDEX IF NOT EXISTS messages_direction_id ON messages(direction, id)');
      db.run('CREATE UNIQUE INDEX IF NOT EXISTS messages_archive_key ON messages(archive_key)');
      db.run('CREATE INDEX IF NOT EXISTS messages_transport_identity ON messages(direction, message_id)');
      db.run('CREATE INDEX IF NOT EXISTS messages_conversation_identity ON messages(direction, message_id, from_user_id, to_user_id)');
      db.run('CREATE INDEX IF NOT EXISTS messages_conversation_history ON messages(direction, from_user_id, to_user_id, id)');
      // Matching these expressions in scopePredicate lets SQLite seek directly
      // in conversation order, without merging/sorting both message directions.
      db.run(`CREATE INDEX IF NOT EXISTS messages_conversation_order ON messages((${ACCOUNT_COLUMN}), (${PEER_COLUMN}), id)`);
      db.run("CREATE INDEX IF NOT EXISTS messages_live_inbound ON messages(to_user_id, from_user_id, id) WHERE direction = 'received' AND imported = 0");
      db.run('CREATE INDEX IF NOT EXISTS messages_message_lookup ON messages(message_id, id) WHERE message_id IS NOT NULL');
      db.run('CREATE INDEX IF NOT EXISTS messages_reference_lookup ON messages(reference_id, id) WHERE reference_id IS NOT NULL');
      if (this.channel === 'qq') {
        this.initQqReplyContexts(db);
        db.run('CREATE INDEX IF NOT EXISTS qq_reply_contexts_window ON qq_reply_contexts(app_id, timestamp DESC, open_id)');
      }
      this.initSyncState(db);
      this.initConversations(db);
    }, true);
    this.initialized = true;
    log.info('[DB] database ready', {
      channel: this.channel,
      durationMs: Date.now() - startedAt,
    });
  }

  private initSyncState(db: Database): void {
    // Existing history is a migration baseline, not a flood of new unread
    // messages. INSERT OR IGNORE preserves other windows' newer read progress.
    for (const [key, value] of [
      [SYNC_GENERATION, randomUUID()],
      [SYNC_CONTENT_VERSION, '0'],
      [SYNC_READ_THROUGH, String(this.latestMessageId(db))],
    ]) {
      db.run('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)', [key, value]);
    }
  }

  private latestMessageId(db: Database, conversation?: ConversationRef): number {
    const scope = this.scopePredicate(conversation);
    return Number(db.exec(`SELECT COALESCE(MAX(id), 0) FROM messages ${scope.sql ? `WHERE ${scope.sql}` : ''}`, scope.values)[0].values[0][0]);
  }

  private initConversations(db: Database): void {
    db.run(`CREATE TABLE IF NOT EXISTS conversation_reads (
      account_id TEXT NOT NULL, peer_id TEXT NOT NULL, read_through_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, peer_id)
    )`);
    // Preserve the old global frontier for every pre-existing conversation.
    // Never reset rows another window has already advanced independently.
    db.run(`INSERT OR IGNORE INTO conversation_reads (account_id, peer_id, read_through_id)
      SELECT ${ACCOUNT_COLUMN}, ${PEER_COLUMN}, ? FROM messages
      WHERE direction IN ('sent', 'received') AND COALESCE(from_user_id, '') <> '' AND COALESCE(to_user_id, '') <> ''
      GROUP BY ${ACCOUNT_COLUMN}, ${PEER_COLUMN}`, [this.syncState(db).readThroughId]);
    if (this.channel === 'wechat') db.run(`CREATE TABLE IF NOT EXISTS wx_recipient_routes (
      session_key TEXT NOT NULL, account_id TEXT NOT NULL, peer_id TEXT NOT NULL,
      context_token TEXT NOT NULL DEFAULT '', timestamp INTEGER NOT NULL,
      PRIMARY KEY (session_key, account_id, peer_id)
    )`);
    if (this.channel === 'wechat') db.run('CREATE INDEX IF NOT EXISTS wx_recipient_routes_account ON wx_recipient_routes(account_id, peer_id, timestamp)');
  }

  private conversation(value?: ConversationRef): ConversationRef | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid conversation');
    for (const field of [value.accountId, value.peerId]) {
      if (typeof field !== 'string' || !field.trim() || field.length > 1024 || /[\u0000-\u001f\u007f]/.test(field)) {
        throw new Error('Invalid conversation identifier');
      }
    }
    return { accountId: value.accountId, peerId: value.peerId };
  }

  private scopePredicate(conversation?: ConversationRef): { sql: string; values: string[] } {
    return conversation ? {
      sql: `(${ACCOUNT_COLUMN}) = ? AND (${PEER_COLUMN}) = ?`,
      values: [conversation.accountId, conversation.peerId],
    } : { sql: '', values: [] };
  }

  private readThrough(db: Database, conversation?: ConversationRef): number {
    if (conversation) {
      const row = db.exec('SELECT read_through_id FROM conversation_reads WHERE account_id = ? AND peer_id = ?',
        [conversation.accountId, conversation.peerId])[0]?.values[0];
      if (row) return Number(row[0]);
    }
    return this.syncState(db).readThroughId;
  }

  private unreadCount(db: Database, accountId?: string, peerId?: string): number {
    const conditions = ["m.direction = 'received'", 'm.imported = 0', 'm.id > COALESCE(r.read_through_id, ?)'];
    const values: (string | number)[] = [this.syncState(db).readThroughId];
    if (accountId !== undefined) { conditions.push('m.to_user_id = ?'); values.push(accountId); }
    if (peerId !== undefined) { conditions.push('m.from_user_id = ?'); values.push(peerId); }
    return Number(db.exec(`SELECT COUNT(*) FROM messages m LEFT JOIN conversation_reads r
      ON r.account_id = m.to_user_id AND r.peer_id = m.from_user_id WHERE ${conditions.join(' AND ')}`, values)[0].values[0][0]);
  }

  private syncState(db: Database): { generation: string; contentVersion: number; readThroughId: number } {
    const result = db.exec('SELECT key, value FROM metadata WHERE key IN (?, ?, ?)',
      [SYNC_GENERATION, SYNC_CONTENT_VERSION, SYNC_READ_THROUGH]);
    const values = new Map((result[0]?.values ?? []).map(row => [String(row[0]), String(row[1])]));
    return {
      generation: values.get(SYNC_GENERATION)!,
      contentVersion: Number(values.get(SYNC_CONTENT_VERSION)),
      readThroughId: Number(values.get(SYNC_READ_THROUGH)),
    };
  }

  private bumpContentVersion(db: Database): void {
    db.run('UPDATE metadata SET value = CAST(value AS INTEGER) + 1 WHERE key = ?', [SYNC_CONTENT_VERSION]);
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
      FROM messages WHERE direction = 'received' AND imported = 0 AND message_id IS NOT NULL
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
    if (!existing.has('parts')) {
      db.run('ALTER TABLE messages ADD COLUMN parts TEXT');
      changed = true;
    }
    if (!existing.has('archive_key')) {
      db.run('ALTER TABLE messages ADD COLUMN archive_key TEXT');
      changed = true;
    }
    if (!existing.has('imported')) {
      db.run('ALTER TABLE messages ADD COLUMN imported INTEGER NOT NULL DEFAULT 0');
      changed = true;
    }
    // Identity belongs to a stored record, not its content or current database
    // ID. Assign it once so identical ID-less messages survive backup/restore.
    const missingKeys = db.exec("SELECT id FROM messages WHERE archive_key IS NULL OR archive_key = ''");
    for (const row of missingKeys[0]?.values ?? []) {
      db.run('UPDATE messages SET archive_key = ? WHERE id = ?', [randomUUID(), row[0]]);
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
    operation: (db: Database) => T | Promise<T>,
    write: boolean | ((value: T) => boolean) = false
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
        const value = await operation(db);
        const shouldWrite = typeof write === 'function' ? write(value) : write;
        if (shouldWrite) this.save(db);
        log.debug('[DB] shared operation completed', {
          channel: this.channel,
          write: shouldWrite,
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

  private insertMessageRow(
    db: Database,
    msg: Omit<ChatMessage, 'id'>,
    archiveKey: string = randomUUID(),
    imported = false
  ): { id: number; inserted: boolean } {
    // Two extension hosts may receive the same transport event concurrently.
    if (msg.message_id) {
      const existing = db.exec(
        'SELECT id FROM messages WHERE message_id = ? AND direction = ? AND from_user_id = ? AND to_user_id = ? LIMIT 1',
        [msg.message_id, msg.direction, msg.from_user_id, msg.to_user_id]
      );
      if (existing[0]?.values.length) return { id: Number(existing[0].values[0][0]), inserted: false };
    }
    db.run(
      `INSERT INTO messages (direction, type, content, timestamp, context_token, from_user_id, to_user_id, message_id, reference_id, reply_to, parts, archive_key, imported)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        this.encodeParts(msg.parts),
        archiveKey,
        imported ? 1 : 0,
      ]
    );

    // Get the ID before save() — sql.js preserves last_insert_rowid()
    const row = db.exec('SELECT last_insert_rowid()');
    return { id: row[0]?.values[0]?.[0] as number, inserted: true };
  }

  /** Store one complete WeChat envelope before publishing its event. */
  async storeWxInbound(msg: Omit<ChatMessage, 'id'>, sessionKey?: string): Promise<{ id: number; inserted: boolean }> {
    if (this.channel !== 'wechat' || msg.direction !== 'received' || !msg.from_user_id || !msg.to_user_id) {
      throw new Error('Invalid WeChat inbound context');
    }
    this.validateId(msg.timestamp, 'inbound timestamp');
    if (sessionKey !== undefined) this.validateSessionKey(sessionKey);
    const stored = await this.withDatabase((db) => {
      const result = this.insertMessageRow(db, msg);
      let routeChanged = false;
      if (sessionKey !== undefined) {
        const known = db.exec('SELECT context_token, timestamp FROM wx_recipient_routes WHERE session_key = ? AND account_id = ? AND peer_id = ?',
          [sessionKey, msg.to_user_id, msg.from_user_id])[0]?.values[0];
        // A real receipt can establish a current-session route even when its
        // history was imported earlier. Replays cannot overwrite an existing route.
        if (!known || (result.inserted && msg.timestamp >= Number(known[1]))) {
          db.run(`INSERT OR REPLACE INTO wx_recipient_routes (session_key, account_id, peer_id, context_token, timestamp)
            VALUES (?, ?, ?, ?, ?)`, [sessionKey, msg.to_user_id, msg.from_user_id,
            msg.context_token || (known ? String(known[0]) : ''), msg.timestamp]);
          routeChanged = true;
        }
      }
      if (!result.inserted) return { ...result, routeChanged };
      const metadata = [
        ['from_user_id', msg.from_user_id], ['to_user_id', msg.to_user_id],
        ['last_inbound_ts', String(msg.timestamp)],
      ];
      if (msg.context_token) {
        metadata.push(['context_token', msg.context_token], ['context_token_stale', '']);
      }
      for (const [key, value] of metadata) {
        db.run('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [key, value]);
      }
      return { ...result, routeChanged };
    }, result => result.inserted || result.routeChanged);
    return { id: stored.id, inserted: stored.inserted };
  }

  private validateSessionKey(sessionKey: string): void {
    if (typeof sessionKey !== 'string' || !sessionKey.trim() || sessionKey.length > 1024
        || /[\u0000-\u001f\u007f]/.test(sessionKey)) throw new Error('Invalid WeChat session key');
  }

  async getWxRoutes(sessionKey: string): Promise<Array<ConversationRef & { contextToken: string; timestamp: number }>> {
    if (this.channel !== 'wechat') throw new Error('WeChat routes require WeChat storage');
    this.validateSessionKey(sessionKey);
    return this.withDatabase(db => (db.exec(`SELECT account_id, peer_id, context_token, timestamp FROM wx_recipient_routes
      WHERE session_key = ? ORDER BY timestamp DESC, account_id, peer_id`, [sessionKey])[0]?.values ?? []).map(row => ({
        accountId: String(row[0]), peerId: String(row[1]), contextToken: String(row[2]), timestamp: Number(row[3]),
      })));
  }

  async invalidateWxRecipientToken(sessionKey: string, conversation: ConversationRef, failedToken: string): Promise<void> {
    if (this.channel !== 'wechat') throw new Error('WeChat routes require WeChat storage');
    this.validateSessionKey(sessionKey);
    const scope = this.conversation(conversation)!;
    if (typeof failedToken !== 'string') throw new Error('Invalid WeChat context token');
    await this.withDatabase(db => {
      const current = db.exec('SELECT context_token FROM wx_recipient_routes WHERE session_key = ? AND account_id = ? AND peer_id = ?',
        [sessionKey, scope.accountId, scope.peerId])[0]?.values[0]?.[0];
      if (!current || current !== failedToken) return false;
      db.run("UPDATE wx_recipient_routes SET context_token = '' WHERE session_key = ? AND account_id = ? AND peer_id = ? AND context_token = ?",
        [sessionKey, scope.accountId, scope.peerId, failedToken]);
      return true;
    }, changed => changed);
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

  /** Inspect the latest eligible passive context without consuming its quota. */
  async peekQqReply(options: {
    appId: string; openId: string; messageId?: string;
    nowSeconds: number; windowSeconds: number; maxReplies: number;
  }): Promise<QqReplyContext | null> {
    if (this.channel !== 'qq') throw new Error('QQ reply inspection requires QQ storage');
    return this.withDatabase(db => {
      const { appId, openId, messageId, nowSeconds, windowSeconds, maxReplies } = options;
      const rows = db.exec(`SELECT message_id, sequence, timestamp FROM qq_reply_contexts
        WHERE app_id = ? AND open_id = ? AND timestamp BETWEEN ? AND ?
        ${messageId === undefined ? '' : 'AND message_id = ?'} ORDER BY timestamp DESC, rowid DESC LIMIT 1`,
      [appId, openId, nowSeconds - windowSeconds, nowSeconds, ...(messageId === undefined ? [] : [messageId])]);
      const row = rows[0]?.values[0];
      if (!row || Number(row[1]) >= maxReplies) return null;
      return { messageId: String(row[0]), sequence: Number(row[1]), timestamp: Number(row[2]) };
    });
  }

  private conversationSummary(db: Database, accountId: string): { conversations: ConversationSummary[]; totalUnreadCount: number } {
    const history = `SELECT ${ACCOUNT_COLUMN} AS account_id, ${PEER_COLUMN} AS peer_id, MAX(timestamp) AS timestamp,
      MAX(CASE WHEN direction = 'received' AND imported = 0 THEN 1 ELSE 0 END) AS live FROM messages
      WHERE (${ACCOUNT_COLUMN}) = ? AND (${PEER_COLUMN}) <> '' GROUP BY (${ACCOUNT_COLUMN}), (${PEER_COLUMN})`;
    const routes = this.channel === 'qq'
      ? 'SELECT app_id, open_id, MAX(timestamp), 1 FROM qq_reply_contexts WHERE app_id = ? GROUP BY app_id, open_id'
      : 'SELECT account_id, peer_id, MAX(timestamp), 1 FROM wx_recipient_routes WHERE account_id = ? GROUP BY account_id, peer_id';
    const rows = db.exec(`SELECT account_id, peer_id, MAX(timestamp), MAX(live) FROM (${history} UNION ALL ${routes})
      GROUP BY account_id, peer_id ORDER BY MAX(timestamp) DESC, peer_id`, [accountId, accountId])[0]?.values ?? [];
    // A single grouped unread query replaces one query per contact. The partial
    // index contains only real inbound rows, including legacy unclassified peers.
    const unreadRows = db.exec(`SELECT m.from_user_id, COUNT(*) FROM messages m LEFT JOIN conversation_reads r
      ON r.account_id = m.to_user_id AND r.peer_id = m.from_user_id
      WHERE m.direction = 'received' AND m.imported = 0 AND m.to_user_id = ?
        AND m.id > COALESCE(r.read_through_id, ?) GROUP BY m.from_user_id`,
    [accountId, this.syncState(db).readThroughId])[0]?.values ?? [];
    const unread = new Map(unreadRows.map(row => [String(row[0] ?? ''), Number(row[1])]));
    return {
      conversations: rows.map(row => ({
        conversation: { accountId: String(row[0]), peerId: String(row[1]) },
        lastTimestamp: Number(row[2]), unreadCount: unread.get(String(row[1])) ?? 0,
        hasLiveInbound: Number(row[3]) === 1,
      })),
      totalUnreadCount: unreadRows.reduce((total, row) => total + Number(row[1]), 0),
    };
  }

  async listConversations(accountId: string): Promise<ConversationSummary[]> {
    this.conversation({ accountId, peerId: 'validation' });
    return this.withDatabase(db => this.conversationSummary(db, accountId).conversations);
  }

  /** One disk snapshot supplies contact rows, unread totals and every passive quota. */
  async getQqRecipientSummary(options: {
    appId: string; nowSeconds: number; windowSeconds: number; maxReplies: number;
  }): Promise<QqRecipientSummary> {
    if (this.channel !== 'qq') throw new Error('QQ recipient summaries require QQ storage');
    const { appId, nowSeconds, windowSeconds, maxReplies } = options;
    this.conversation({ accountId: appId, peerId: 'validation' });
    this.validateId(nowSeconds, 'current timestamp');
    this.validateId(windowSeconds, 'reply window');
    this.validateId(maxReplies, 'reply limit', 1);
    return this.withDatabase(db => {
      const summary = this.conversationSummary(db, appId);
      const rows = db.exec(`SELECT open_id, message_id, sequence, timestamp FROM (
        SELECT open_id, message_id, sequence, timestamp,
          ROW_NUMBER() OVER (PARTITION BY open_id ORDER BY timestamp DESC, rowid DESC) AS newest
        FROM qq_reply_contexts WHERE app_id = ? AND timestamp BETWEEN ? AND ?
      ) WHERE newest = 1`, [appId, nowSeconds - windowSeconds, nowSeconds])[0]?.values ?? [];
      const replies = new Map(rows.map(row => [String(row[0]), Number(row[2]) >= maxReplies ? null : {
        messageId: String(row[1]), sequence: Number(row[2]), timestamp: Number(row[3]),
      }]));
      return { totalUnreadCount: summary.totalUnreadCount,
        conversations: summary.conversations.map(item => ({ ...item, replyContext: replies.get(item.conversation.peerId) ?? null })) };
    });
  }

  async getTotalUnreadCount(accountId?: string): Promise<number> {
    if (accountId !== undefined) this.conversation({ accountId, peerId: 'validation' });
    return this.withDatabase(db => this.unreadCount(db, accountId));
  }

  private gatewayCheckpoint(value: unknown): QqGatewayCheckpoint | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const item = value as Partial<QqGatewayCheckpoint>;
    if (!Number.isSafeInteger(item.sequence) || item.sequence! < 0) return undefined;
    for (const field of [item.sessionId, item.credentialKey]) {
      if (typeof field !== 'string' || !field.trim() || field.length > 4096 || /[\u0000-\u001f\u007f]/.test(field)) return undefined;
    }
    return { sessionId: item.sessionId!, sequence: item.sequence!, credentialKey: item.credentialKey! };
  }

  private readGatewayCheckpoint(db: Database): QqGatewayCheckpoint | undefined {
    const value = db.exec('SELECT value FROM metadata WHERE key = ?', [QQ_GATEWAY_CHECKPOINT])[0]?.values[0]?.[0];
    if (typeof value !== 'string') return undefined;
    try { return this.gatewayCheckpoint(JSON.parse(value)); } catch { return undefined; }
  }

  async getQqGatewayCheckpoint(): Promise<QqGatewayCheckpoint | undefined> {
    if (this.channel !== 'qq') throw new Error('QQ Gateway checkpoints require QQ storage');
    // Legacy separate keys cannot prove they came from the same session write.
    // A missing/invalid atomic checkpoint requires a fresh Gateway identify.
    return this.withDatabase(db => this.readGatewayCheckpoint(db));
  }

  async saveQqGatewayCheckpoint(checkpoint: QqGatewayCheckpoint): Promise<void> {
    if (this.channel !== 'qq') throw new Error('QQ Gateway checkpoints require QQ storage');
    const value = this.gatewayCheckpoint(checkpoint);
    if (!value) throw new Error('Invalid QQ Gateway checkpoint');
    await this.withDatabase(db => {
      const current = this.readGatewayCheckpoint(db);
      if (current?.sessionId === value.sessionId && current.credentialKey === value.credentialKey
          && current.sequence >= value.sequence) return false;
      db.run('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [QQ_GATEWAY_CHECKPOINT, JSON.stringify(value)]);
      return true;
    }, changed => changed);
  }

  async clearQqGatewayCheckpoint(expectedSessionId?: string): Promise<void> {
    if (this.channel !== 'qq') throw new Error('QQ Gateway checkpoints require QQ storage');
    if (expectedSessionId !== undefined && (typeof expectedSessionId !== 'string' || !expectedSessionId)) {
      throw new Error('Invalid QQ Gateway session');
    }
    await this.withDatabase(db => {
      const current = this.readGatewayCheckpoint(db);
      if (expectedSessionId !== undefined && current?.sessionId !== expectedSessionId) return false;
      if (!db.exec('SELECT 1 FROM metadata WHERE key = ?', [QQ_GATEWAY_CHECKPOINT]).length) return false;
      db.run('DELETE FROM metadata WHERE key = ?', [QQ_GATEWAY_CHECKPOINT]);
      return true;
    }, changed => changed);
  }

  /** Cheap invalidation check: atomic file replacement changes this stamp. */
  async getChangeStamp(): Promise<string> {
    const stat = await fs.promises.stat(this.dbPath);
    return `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  }

  private validateId(value: number, name: string, minimum = 0): void {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  }

  private recentPage(db: Database, beforeId: number | undefined, limit: number, conversation?: ConversationRef): { messages: ChatMessage[]; hasMore: boolean } {
    const scope = this.scopePredicate(conversation);
    const conditions = [scope.sql, beforeId === undefined ? '' : 'id < ?'].filter(Boolean);
    const result = db.exec(
      `SELECT ${MESSAGE_COLUMNS} FROM messages ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
      [...scope.values, ...(beforeId === undefined ? [] : [beforeId]), limit + 1]
    );
    const page = this.mapRows(result[0]?.values ?? []);
    const hasMore = page.length > limit;
    return { messages: hasMore ? page.slice(1) : page, hasMore };
  }

  /** Messages, clear generation and shared unread state come from one lock. */
  async getSyncSnapshot(
    cursor?: ChatSyncCursor,
    historyStartId?: number,
    limit = 100,
    forceReset = false,
    conversation?: ConversationRef
  ): Promise<ChatSyncSnapshot> {
    const selected = this.conversation(conversation);
    const scope = this.scopePredicate(selected);
    const conversationId = selected ? recipientId(selected) : undefined;
    this.validateId(limit, 'history limit', 1);
    if (historyStartId !== undefined) this.validateId(historyStartId, 'history start', 1);
    if (cursor) {
      this.validateId(cursor.lastId, 'sync cursor');
      this.validateId(cursor.contentVersion, 'content version');
      if (!cursor.generation) throw new Error('Invalid sync generation');
    }
    return this.withDatabase((db) => {
      const state = this.syncState(db);
      const lastId = this.latestMessageId(db, selected);
      const readThroughId = this.readThrough(db, selected);
      const sameGeneration = cursor?.generation === state.generation;
      const sameScope = cursor?.conversationId === conversationId;
      const reset = forceReset || !cursor || !sameGeneration || !sameScope
        || cursor.contentVersion !== state.contentVersion || cursor.lastId > lastId;
      let messages: ChatMessage[];
      let hasMore: boolean | undefined;
      if (reset) {
        if (sameGeneration && sameScope && cursor && cursor.lastId <= lastId && historyStartId !== undefined) {
          const result = db.exec(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id >= ? ${scope.sql ? `AND ${scope.sql}` : ''} ORDER BY id DESC`, [historyStartId, ...scope.values]);
          messages = this.mapRows(result[0]?.values ?? []);
          hasMore = Boolean(db.exec(`SELECT 1 FROM messages WHERE id < ? ${scope.sql ? `AND ${scope.sql}` : ''} LIMIT 1`, [historyStartId, ...scope.values]).length);
        } else {
          ({ messages, hasMore } = this.recentPage(db, undefined, limit, selected));
        }
      } else {
        const result = db.exec(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id > ? ${scope.sql ? `AND ${scope.sql}` : ''} ORDER BY id DESC`, [cursor.lastId, ...scope.values]);
        messages = this.mapRows(result[0]?.values ?? []);
      }
      const unreadCount = this.unreadCount(db, selected?.accountId, selected?.peerId);
      return {
        cursor: { generation: state.generation, contentVersion: state.contentVersion, lastId,
          ...(conversationId === undefined ? {} : { conversationId }) },
        messages, reset, ...(hasMore === undefined ? {} : { hasMore }),
        unreadCount, readThroughId,
      };
    });
  }

  /** A stale window cannot mark messages from a later clear generation read. */
  async markRead(generation: string, throughId: number, conversation?: ConversationRef): Promise<void> {
    const selected = this.conversation(conversation);
    const scope = this.scopePredicate(selected);
    this.validateId(throughId, 'read cursor');
    await this.withDatabase((db) => {
      const state = this.syncState(db);
      if (state.generation !== generation) return false;
      const next = selected ? throughId : Math.min(throughId, this.latestMessageId(db));
      if (next <= this.readThrough(db, selected)) return false;
      // Restored history can occupy the newest page. Its automatic display
      // must not acknowledge real inbound messages that the user never saw.
      const row = db.exec(`SELECT imported FROM messages WHERE id = ? ${scope.sql ? `AND ${scope.sql}` : ''}`, [next, ...scope.values])[0]?.values[0];
      if (!row || Number(row[0]) === 1) return false;
      if (selected) {
        db.run(`INSERT INTO conversation_reads (account_id, peer_id, read_through_id) VALUES (?, ?, ?)
          ON CONFLICT(account_id, peer_id) DO UPDATE SET read_through_id = MAX(read_through_id, excluded.read_through_id)`,
        [selected.accountId, selected.peerId, next]);
      } else {
        db.run('UPDATE metadata SET value = ? WHERE key = ?', [String(next), SYNC_READ_THROUGH]);
        db.run('UPDATE conversation_reads SET read_through_id = MAX(read_through_id, ?)', [next]);
      }
      return true;
    }, changed => changed);
  }

  /** Image bytes become readable after their message row is committed. */
  async markMessageMediaReady(messageId: number): Promise<void> {
    this.validateId(messageId, 'message ID', 1);
    await this.withDatabase((db) => {
      const exists = db.exec(`SELECT 1 FROM messages WHERE id = ? AND (type = ? OR ${PART_TYPE_MATCH}) LIMIT 1`, [messageId, 2, 2]);
      if (!exists.length) return false;
      this.bumpContentVersion(db);
      return true;
    }, changed => changed);
  }

  async getHistoryPage(beforeId: number, generation: string, limit = 100, conversation?: ConversationRef): Promise<ChatHistoryPage | null> {
    const selected = this.conversation(conversation);
    this.validateId(beforeId, 'history cursor', 1);
    this.validateId(limit, 'history limit', 1);
    return this.withDatabase((db) => {
      const state = this.syncState(db);
      if (state.generation !== generation) return null;
      return { generation: state.generation, contentVersion: state.contentVersion, ...this.recentPage(db, beforeId, limit, selected) };
    });
  }

  /** Search all stored history without advancing either the live or read cursor. */
  async searchMessages(options: ChatSearchOptions): Promise<ChatHistoryPage | null> {
    if (!options || typeof options.query !== 'string' || options.query.length > 200) {
      throw new Error('Search query must be a string of at most 200 characters');
    }
    if (options.query.includes('\0')) {
      throw new Error('Search query must not contain NUL characters');
    }
    const scope = this.scopePredicate(this.conversation(options.conversation));
    if (options.type !== undefined && ![1, 2, 3, 4, 5].includes(options.type)) {
      throw new Error('Invalid message type');
    }
    if (options.fromTimestamp !== undefined) this.validateId(options.fromTimestamp, 'start timestamp');
    if (options.toTimestamp !== undefined) this.validateId(options.toTimestamp, 'end timestamp');
    if (options.fromTimestamp !== undefined && options.toTimestamp !== undefined
      && options.fromTimestamp >= options.toTimestamp) throw new Error('Invalid timestamp range');
    if (options.beforeId !== undefined) this.validateId(options.beforeId, 'search cursor', 1);
    const requestedLimit = options.limit === undefined ? 50 : options.limit;
    this.validateId(requestedLimit, 'search limit', 1);
    const limit = Math.min(50, requestedLimit);
    const conditions: string[] = scope.sql ? [scope.sql] : [];
    const values: (string | number)[] = [...scope.values];
    if (options.query) {
      // User punctuation stays literal: a search for "%" must not match every
      // message, and bound values keep quotes and SQL fragments out of the query.
      conditions.push("content LIKE ? ESCAPE '\\'");
      values.push(`%${options.query.replace(/[\\%_]/g, char => `\\${char}`)}%`);
    }
    if (options.type !== undefined) {
      conditions.push(`(type = ? OR ${PART_TYPE_MATCH})`);
      values.push(options.type, options.type);
    }
    if (options.fromTimestamp !== undefined) { conditions.push('timestamp >= ?'); values.push(options.fromTimestamp); }
    if (options.toTimestamp !== undefined) { conditions.push('timestamp < ?'); values.push(options.toTimestamp); }
    if (options.beforeId !== undefined) { conditions.push('id < ?'); values.push(options.beforeId); }
    return this.withDatabase((db) => {
      const state = this.syncState(db);
      if (options.generation !== undefined && options.generation !== state.generation) return null;
      const rows = db.exec(
        `SELECT ${MESSAGE_COLUMNS} FROM messages ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
        [...values, limit + 1]
      );
      // mapRows is chronological for chat history; search explicitly presents
      // newest matches first and uses the last visible ID for the next page.
      const matches = this.mapRows(rows[0]?.values ?? []).reverse();
      return {
        generation: state.generation, contentVersion: state.contentVersion,
        messages: matches.slice(0, limit), hasMore: matches.length > limit,
      };
    });
  }

  /** Resolve an unloaded quote/search hit into a bounded chronological window. */
  async getMessageContext(
    target: { id?: number; messageId?: string },
    generation?: string,
    radiusOrConversation: number | ConversationRef = 10,
    conversation?: ConversationRef
  ): Promise<ChatMessageContext | null> {
    const radius = typeof radiusOrConversation === 'number' ? radiusOrConversation : 10;
    const selected = this.conversation(typeof radiusOrConversation === 'number' ? conversation : radiusOrConversation);
    const scope = this.scopePredicate(selected);
    this.validateId(radius, 'context radius');
    const count = Math.min(20, radius);
    if (!target || (target.id === undefined && (typeof target.messageId !== 'string' || !target.messageId))) {
      throw new Error('A message ID is required');
    }
    if (target.id !== undefined) this.validateId(target.id, 'message ID', 1);
    return this.withDatabase((db) => {
      const state = this.syncState(db);
      if (generation !== undefined && generation !== state.generation) return null;
      let targetRows;
      if (target.id !== undefined) {
        targetRows = db.exec(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ? ${scope.sql ? `AND ${scope.sql}` : ''}`, [target.id, ...scope.values]);
      } else {
        const supplied = target.messageId!;
        const bare = supplied.replace(/^v1:/, '');
        const candidates = [...new Set([supplied, bare, `v1:${bare}`])];
        const placeholders = candidates.map(() => '?').join(', ');
        targetRows = db.exec(
          `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE (message_id IN (${placeholders}) OR reference_id IN (${placeholders}))
           ${scope.sql ? `AND ${scope.sql}` : ''} ORDER BY id DESC LIMIT 1`,
          [...candidates, ...candidates, ...scope.values]
        );
      }
      const message = this.mapRows(targetRows[0]?.values ?? [])[0];
      if (!message) return null;
      const beforeRows = db.exec(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id < ? ${scope.sql ? `AND ${scope.sql}` : ''} ORDER BY id DESC LIMIT ?`, [message.id, ...scope.values, count + 1]);
      const afterRows = db.exec(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id > ? ${scope.sql ? `AND ${scope.sql}` : ''} ORDER BY id ASC LIMIT ?`, [message.id, ...scope.values, count + 1]);
      const before = this.mapRows(beforeRows[0]?.values ?? []);
      const after = this.mapRows(afterRows[0]?.values ?? []).reverse();
      return {
        generation: state.generation, contentVersion: state.contentVersion, targetId: message.id,
        messages: [...before.slice(Math.max(0, before.length - count)), message, ...after.slice(0, count)],
        hasBefore: before.length > count, hasAfter: after.length > count,
      };
    });
  }

  async getRecentMessages(
    limit: number = 100,
    beforeId?: number,
    conversation?: ConversationRef
  ): Promise<ChatMessage[]> {
    const scope = this.scopePredicate(this.conversation(conversation));
    const conditions = [scope.sql, beforeId === undefined ? '' : 'id < ?'].filter(Boolean);
    return this.withDatabase((db) => {
      const results = db.exec(
        `SELECT ${MESSAGE_COLUMNS}
       FROM messages ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
        [...scope.values, ...(beforeId === undefined ? [] : [beforeId]), limit]
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

  async getMessagesFromId(firstId: number, conversation?: ConversationRef): Promise<ChatMessage[]> {
    const scope = this.scopePredicate(this.conversation(conversation));
    return this.withDatabase((db) => {
      const result = db.exec(
        `SELECT ${MESSAGE_COLUMNS}
         FROM messages WHERE id >= ? ${scope.sql ? `AND ${scope.sql}` : ''} ORDER BY id DESC`,
        [firstId, ...scope.values]
      );
      return this.mapRows(result[0]?.values ?? []);
    });
  }

  // Look up a message by its iLink message id (used to resolve quoted text
  // when the inbound ref_msg omits text_item — which iLink usually does)
  async findByMessageId(messageId: string, conversation?: ConversationRef): Promise<ChatMessage | null> {
    const scope = this.scopePredicate(this.conversation(conversation));
    return this.withDatabase((db) => {
      const results = db.exec(
        `SELECT ${MESSAGE_COLUMNS}
       FROM messages WHERE message_id = ? ${scope.sql ? `AND ${scope.sql}` : ''} ORDER BY id DESC LIMIT 1`,
        [messageId, ...scope.values]
      );
      if (!results.length || !results[0].values.length) return null;
      return this.mapRows(results[0].values)[0];
    });
  }

  // Fallback lookup for quote resolution: iLink ref_msg may carry only a
  // timestamp (no text, and the id may be a peer-side id we never stored).
  async findByTimestamp(
    timestamp: number,
    windowSec: number = 2,
    conversation?: ConversationRef
  ): Promise<ChatMessage | null> {
    const scope = this.scopePredicate(this.conversation(conversation));
    return this.withDatabase((db) => {
      const results = db.exec(
        `SELECT ${MESSAGE_COLUMNS}
       FROM messages WHERE timestamp BETWEEN ? AND ? ${scope.sql ? `AND ${scope.sql}` : ''} ORDER BY id DESC LIMIT 1`,
        [timestamp - windowSec, timestamp + windowSec, ...scope.values]
      );
      if (!results.length || !results[0].values.length) return null;
      return this.mapRows(results[0].values)[0];
    });
  }

  private sanitizeParts(value: unknown): ChatMessagePart[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const validMediaString = (field: unknown, maxLength: number): field is string =>
      typeof field === 'string' && field.length > 0 && field.length <= maxLength
      && field.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(field);
    const parts: ChatMessagePart[] = [];
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object' || ![1, 2, 3, 4, 5].includes(candidate.type)) continue;
      const part: ChatMessagePart = { type: candidate.type };
      for (const key of ['text', 'url', 'fileName', 'mimeType'] as const) {
        if (typeof candidate[key] === 'string') part[key] = candidate[key];
      }
      if (Number.isSafeInteger(candidate.size) && candidate.size >= 0) part.size = candidate.size;
      const media = candidate.fileMedia;
      if (part.type === 4 && media && typeof media === 'object' && !Array.isArray(media)
          && validMediaString(media.aesKey, 512)) {
        // Host-only download metadata must survive restarts. Public message
        // payloads strip this separately; runtime fileAction stays unpersisted.
        part.fileMedia = { aesKey: media.aesKey };
        if (validMediaString(media.encryptQueryParam, 8192)) part.fileMedia.encryptQueryParam = media.encryptQueryParam;
        if (validMediaString(media.md5, 128)) part.fileMedia.md5 = media.md5;
      }
      parts.push(part);
    }
    return parts.length ? parts : undefined;
  }

  private encodeParts(value: unknown): string | null {
    const parts = this.sanitizeParts(value);
    return parts ? JSON.stringify(parts) : null;
  }

  private decodeParts(value: unknown): ChatMessagePart[] | undefined {
    if (typeof value !== 'string') return undefined;
    try { return this.sanitizeParts(JSON.parse(value)); } catch { return undefined; }
  }

  private mapRows(
    rows: (number | string | Uint8Array | null)[][]
  ): ChatMessage[] {
    return rows
      .map((row: (number | string | Uint8Array | null)[]) => {
        const parts = this.decodeParts(row[11]);
        return {
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
          ...(parts ? { parts } : {}),
          ...(Number(row[12]) === 1 ? { restored: true } : {}),
        };
      })
      .reverse();
  }

  async clearAll(): Promise<void> {
    await this.withDatabase((db) => {
      db.run('DELETE FROM messages');
      db.run('UPDATE metadata SET value = ? WHERE key = ?', [randomUUID(), SYNC_GENERATION]);
      db.run('UPDATE metadata SET value = ? WHERE key = ?', ['0', SYNC_READ_THROUGH]);
      db.run('UPDATE conversation_reads SET read_through_id = 0');
      this.bumpContentVersion(db);
    }, true);
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
    partsUpdated: number;
  }> {
    return this.withDatabase((db) => {
      const result = db.exec('SELECT id, content, reply_to, parts FROM messages');
      const rows = result[0]?.values ?? [];
      let contentUpdated = 0;
      let replyUpdated = 0;
      let partsUpdated = 0;

      db.run('BEGIN TRANSACTION');
      try {
        for (const row of rows) {
          const id = Number(row[0]);
          const content = String(row[1] ?? '');
          const replyTo = typeof row[2] === 'string' ? row[2] : null;
          const partsJson = typeof row[3] === 'string' ? row[3] : null;
          const normalizedContent = normalizer(content);
          let normalizedReplyTo = replyTo;
          let normalizedPartsJson = partsJson;
          const parts = this.decodeParts(partsJson);
          if (parts) {
            let changed = false;
            for (const part of parts) {
              if (typeof part.text !== 'string') continue;
              const normalizedText = normalizer(part.text);
              if (normalizedText !== part.text) {
                part.text = normalizedText;
                changed = true;
              }
            }
            if (changed) {
              normalizedPartsJson = JSON.stringify(parts);
              partsUpdated += 1;
            }
          }

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
          if (normalizedContent !== content || normalizedReplyTo !== replyTo || normalizedPartsJson !== partsJson) {
            db.run(
              'UPDATE messages SET content = ?, reply_to = ?, parts = ? WHERE id = ?',
              [normalizedContent, normalizedReplyTo, normalizedPartsJson, id]
            );
          }
        }
        if (contentUpdated || replyUpdated || partsUpdated) this.bumpContentVersion(db);
        db.run('COMMIT');
      } catch (err) {
        db.run('ROLLBACK');
        throw err;
      }

      return { scanned: rows.length, contentUpdated, replyUpdated, partsUpdated };
    }, true);
  }

  private archiveMessage(message: ArchiveMessage | ChatMessage): ArchiveMessage {
    const parts = this.sanitizeParts(message.parts);
    return {
      direction: message.direction,
      type: message.type,
      content: message.content,
      timestamp: message.timestamp,
      // Old schemas allowed NULL identities. Keep their stored rows untouched,
      // but represent missing ownership consistently in portable history.
      from_user_id: message.from_user_id ?? '',
      to_user_id: message.to_user_id ?? '',
      ...(message.message_id ? { message_id: message.message_id } : {}),
      ...(message.reference_id ? { reference_id: message.reference_id } : {}),
      reply_to: message.reply_to || null,
      ...(parts ? { parts } : {}),
    };
  }

  private historySnapshot(
    db: Database,
    filter: { fromTimestamp?: number; toTimestamp?: number } = {},
    maxRecords?: number
  ): ArchiveSnapshot {
    const conditions: string[] = [];
    const values: number[] = [];
    if (filter.fromTimestamp !== undefined) { conditions.push('timestamp >= ?'); values.push(filter.fromTimestamp); }
    if (filter.toTimestamp !== undefined) { conditions.push('timestamp < ?'); values.push(filter.toTimestamp); }
    if (maxRecords !== undefined) values.push(maxRecords + 1);
    const rows = db.exec(
      `SELECT ${MESSAGE_COLUMNS}, archive_key FROM messages ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY id DESC ${maxRecords === undefined ? '' : 'LIMIT ?'}`,
      values
    )[0]?.values ?? [];
    if (maxRecords !== undefined && rows.length > maxRecords) {
      throw new Error('一次最多导出 10000 条消息，请缩小日期范围。');
    }
    const keys = new Map(rows.map(row => [Number(row[0]), String(row[13])]));
    const state = this.syncState(db);
    return {
      channel: this.channel,
      generation: state.generation,
      contentVersion: state.contentVersion,
      records: this.mapRows(rows).map(message => ({
        key: keys.get(message.id)!, originalId: message.id, message: this.archiveMessage(message),
      })),
    };
  }

  /** Export logical records, never the DB file, session tokens or metadata. */
  async exportHistorySnapshot(
    filter: { fromTimestamp?: number; toTimestamp?: number } = {}
  ): Promise<ArchiveSnapshot> {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new Error('Invalid history filter');
    if (filter.fromTimestamp !== undefined) this.validateId(filter.fromTimestamp, 'start timestamp');
    if (filter.toTimestamp !== undefined) this.validateId(filter.toTimestamp, 'end timestamp');
    if (filter.fromTimestamp !== undefined && filter.toTimestamp !== undefined
        && filter.fromTimestamp >= filter.toTimestamp) throw new Error('Invalid timestamp range');
    return this.withDatabase(db => {
      const snapshot = this.historySnapshot(db, filter, 10000);
      return { ...snapshot, records: validateArchiveRecords(snapshot.records) };
    });
  }

  /** Hold the history lock while storage inspects all references; no package cap. */
  async withHistorySnapshot<T>(callback: (snapshot: ArchiveSnapshot) => Promise<T>): Promise<T> {
    if (typeof callback !== 'function') throw new Error('A history snapshot callback is required');
    // The callback must not call this DB again: it already owns its queue/lock.
    return this.withDatabase(db => callback(this.historySnapshot(db)));
  }

  private restoreRecords(db: Database, records: ArchiveRecord[], append: boolean): RestoreResult {
    const generation = this.syncState(db).generation;
    const result: RestoreResult = { generation, inserted: 0, skipped: 0, conflicts: 0, mapping: [] };
    type Candidate = { id: number; signature: string };
    const stagedKeys = new Map<string, Candidate>();
    const stagedIdentities = new Map<string, Candidate>();
    const query = db.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages
       WHERE archive_key = ? OR (direction = ? AND message_id = ?
         AND COALESCE(from_user_id, '') = ? AND COALESCE(to_user_id, '') = ?) ORDER BY id ASC`
    );
    try {
      for (const record of records) {
        const message = this.archiveMessage(record.message);
        const signature = JSON.stringify(message);
        const identity = message.message_id ? JSON.stringify([message.direction, message.message_id, message.from_user_id, message.to_user_id]) : undefined;
        const candidates = new Map<number, Candidate>();
        query.bind([record.key, message.direction, message.message_id || null, message.from_user_id, message.to_user_id]);
        while (query.step()) {
          const row = this.mapRows([query.get()])[0];
          candidates.set(row.id, { id: row.id, signature: JSON.stringify(this.archiveMessage(row)) });
        }
        query.reset();
        for (const candidate of [stagedKeys.get(record.key), identity === undefined ? undefined : stagedIdentities.get(identity)]) {
          if (candidate) candidates.set(candidate.id, candidate);
        }
        if (candidates.size) {
          result.skipped += 1;
          if ([...candidates.values()].some(candidate => candidate.signature !== signature)) {
            result.conflicts += 1;
            continue;
          }
          const existing = candidates.values().next().value!;
          result.mapping.push({ key: record.key, id: existing.id, inserted: false });
          continue;
        }
        let id = -(result.inserted + 1); // Preview-only identity for package-local deduplication.
        if (append) {
          const inserted = this.insertMessageRow(db, { ...message, context_token: '' }, record.key, true);
          if (!inserted.inserted) throw new Error('Restore identity changed while holding the database lock');
          id = inserted.id;
        }
        const candidate = { id, signature };
        stagedKeys.set(record.key, candidate);
        if (identity !== undefined) stagedIdentities.set(identity, candidate);
        result.inserted += 1;
        result.mapping.push({ key: record.key, id, inserted: true });
      }
      return result;
    } finally {
      query.free();
    }
  }

  /** Validate and count an append without changing history or read state. */
  async previewRestore(records: ArchiveRecord[]): Promise<RestorePlan> {
    const validated = validateArchiveRecords(records);
    return this.withDatabase(db => {
      const result = this.restoreRecords(db, validated, false);
      return {
        generation: result.generation, total: validated.length, newCount: result.inserted,
        duplicateCount: result.skipped - result.conflicts, conflictCount: result.conflicts,
      };
    });
  }

  /** Restore only message rows. Existing rows and all session metadata survive. */
  async appendRestore(records: ArchiveRecord[], expectedGeneration: string): Promise<RestoreResult> {
    const validated = validateArchiveRecords(records);
    if (typeof expectedGeneration !== 'string' || !expectedGeneration) throw new Error('Invalid restore generation');
    return this.withDatabase(db => {
      if (this.syncState(db).generation !== expectedGeneration) {
        throw new Error('聊天历史已清空，恢复预览已失效，请重新预览。');
      }
      db.run('BEGIN TRANSACTION');
      try {
        const result = this.restoreRecords(db, validated, true);
        if (result.inserted) this.bumpContentVersion(db);
        db.run('COMMIT');
        return result;
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      }
    }, result => result.inserted > 0);
  }

  /** Publish one content refresh after any number of restored image caches. */
  async notifyRestoredMedia(): Promise<void> {
    await this.withDatabase(db => this.bumpContentVersion(db), true);
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
