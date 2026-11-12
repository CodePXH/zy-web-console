import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
const WC_DATA_DIR = path.join(ZYLOS_DIR, 'web-console');
const DB_PATH = path.join(WC_DATA_DIR, 'web-console.db');

const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_TTL_MS = 30 * 60 * 1000;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: crypto.scryptSync(String(password), salt, 64).toString('hex')
  };
}

function openDb(dbPath = DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      disabled_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      session_token TEXT,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      size_label TEXT,
      mime TEXT,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      project_id TEXT,
      conversation_id TEXT,
      details_json TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name);
  if (!sessionColumns.includes('user_id')) db.exec('ALTER TABLE sessions ADD COLUMN user_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)');
  const uploadColumns = db.prepare("PRAGMA table_info(uploads)").all().map((column) => column.name);
  if (!uploadColumns.includes('user_id')) db.exec('ALTER TABLE uploads ADD COLUMN user_id TEXT');
  if (!uploadColumns.includes('conversation_id')) db.exec('ALTER TABLE uploads ADD COLUMN conversation_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_uploads_access ON uploads(path, user_id, conversation_id, consumed)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON usage_events(user_id, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at DESC)');
  return db;
}

export class SessionStore {
  constructor(db, { maxAgeMs = SESSION_MAX_AGE_MS } = {}) {
    this.db = db;
    this.maxAgeMs = maxAgeMs;
    this._stmts = {
      get: db.prepare('SELECT token, user_id FROM sessions WHERE token = ? AND last_seen_at >= ?'),
      add: db.prepare('INSERT OR REPLACE INTO sessions (token, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)'),
      del: db.prepare('DELETE FROM sessions WHERE token = ?'),
      delStale: db.prepare('DELETE FROM sessions WHERE token = ? AND last_seen_at < ?'),
      touch: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?'),
      cleanup: db.prepare('DELETE FROM sessions WHERE last_seen_at < ?'),
    };
    this.cleanup();
  }

  get(token) {
    const cutoff = Date.now() - this.maxAgeMs;
    const session = this._stmts.get.get(token, cutoff);
    if (session) return session;
    this._stmts.delStale.run(token, cutoff);
    return null;
  }

  has(token) {
    return Boolean(this.get(token));
  }

  add(token, userId) {
    const now = Date.now();
    this._stmts.add.run(token, userId || null, now, now);
  }

  create(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    this.add(token, userId);
    return token;
  }

  delete(token) {
    this._stmts.del.run(token);
  }

  touch(token) {
    this._stmts.touch.run(Date.now(), token);
  }

  cleanup() {
    this._stmts.cleanup.run(Date.now() - this.maxAgeMs);
  }

  get maxAgeSec() {
    return Math.floor(this.maxAgeMs / 1000);
  }
}

export class UserStore {
  constructor(db) {
    this.db = db;
    this._stmts = {
      byUsername: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND disabled_at IS NULL'),
      byId: db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ? AND disabled_at IS NULL'),
      count: db.prepare('SELECT COUNT(*) AS count FROM users WHERE disabled_at IS NULL'),
      list: db.prepare('SELECT id, username, role, created_at FROM users WHERE disabled_at IS NULL ORDER BY created_at ASC'),
      insert: db.prepare('INSERT INTO users (id, username, password_hash, password_salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
      disable: db.prepare("UPDATE users SET disabled_at = ? WHERE id = ? AND role != 'admin'"),
      deleteSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    };
  }

  static validateUsername(username) {
    const value = String(username || '').trim();
    if (!/^[A-Za-z0-9_.-]{3,48}$/.test(value)) throw new Error('Username must be 3–48 characters: letters, numbers, dot, underscore, or hyphen');
    return value;
  }

  static validatePassword(password) {
    const value = String(password || '');
    if (value.length < 10) throw new Error('Password must contain at least 10 characters');
    return value;
  }

  create({ username, password, role = 'user' }) {
    const safeUsername = UserStore.validateUsername(username);
    const safePassword = UserStore.validatePassword(password);
    if (!['admin', 'user'].includes(role)) throw new Error('Invalid role');
    const { salt, hash } = hashPassword(safePassword);
    const user = { id: crypto.randomUUID(), username: safeUsername, role, created_at: Date.now() };
    try {
      this._stmts.insert.run(user.id, user.username, hash, salt, user.role, user.created_at);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new Error('Username already exists');
      throw err;
    }
    return user;
  }

  authenticate(username, password) {
    const user = this._stmts.byUsername.get(String(username || '').trim());
    if (!user) return null;
    const candidate = hashPassword(password, user.password_salt).hash;
    if (candidate.length !== user.password_hash.length || !crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(user.password_hash))) return null;
    return { id: user.id, username: user.username, role: user.role, created_at: user.created_at };
  }

  get(id) { return this._stmts.byId.get(id) || null; }
  list() { return this._stmts.list.all(); }
  count() { return this._stmts.count.get().count; }

  disable(id) {
    const user = this.get(id);
    if (!user) throw new Error('User not found');
    if (user.role === 'admin') throw new Error('Administrator accounts cannot be removed');
    this._stmts.disable.run(Date.now(), id);
    this._stmts.deleteSessions.run(id);
  }
}

export class PersistentUploadRegistry {
  constructor(db, { ttlMs = UPLOAD_TTL_MS } = {}) {
    this.db = db;
    this.ttlMs = ttlMs;
    this._stmts = {
      add: db.prepare(`INSERT INTO uploads (id, session_token, user_id, path, name, size, size_label, mime, kind, created_at, consumed)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`),
      get: db.prepare('SELECT * FROM uploads WHERE id = ? AND consumed = 0 AND user_id = ?'),
      consume: db.prepare('UPDATE uploads SET consumed = 1, conversation_id = ? WHERE id = ? AND consumed = 0 AND user_id = ?'),
      restore: db.prepare('UPDATE uploads SET consumed = 0, conversation_id = NULL WHERE id = ?'),
      accessible: db.prepare('SELECT id FROM uploads WHERE path = ? AND user_id = ? AND conversation_id = ? AND consumed = 1'),
      cleanup: db.prepare('DELETE FROM uploads WHERE consumed = 0 AND created_at < ?'),
    };
  }

  add(entry) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this._stmts.add.run(
      id, entry.sessionId || null, entry.userId || null, entry.path, entry.name,
      entry.size, entry.sizeLabel || null, entry.mime || null,
      entry.kind, now
    );
    return { ...entry, id };
  }

  cleanup() {
    this._stmts.cleanup.run(Date.now() - this.ttlMs);
  }

  getMany(ids, sessionId, userId) {
    this.cleanup();
    if (!Array.isArray(ids)) return [];
    if (new Set(ids).size !== ids.length) return [];
    const results = [];
    for (const id of ids) {
      const row = this._stmts.get.get(id, userId);
      if (!row || row.session_token !== sessionId) return [];
      results.push({
        id: row.id,
        sessionId: row.session_token,
        path: row.path,
        name: row.name,
        size: row.size,
        sizeLabel: row.size_label,
        mime: row.mime,
        kind: row.kind,
      });
    }
    return results;
  }

  consumeMany(ids, sessionId, userId, conversationId) {
    const entries = this.getMany(ids, sessionId, userId);
    if (entries.length !== ids.length) return null;
    for (const id of ids) {
      if (this._stmts.consume.run(conversationId, id, userId).changes !== 1) return null;
    }
    return entries;
  }

  restoreMany(entries) {
    for (const entry of entries || []) {
      if (entry?.id) this._stmts.restore.run(entry.id);
    }
  }

  isAccessible(filePath, userId, conversationId) {
    return Boolean(this._stmts.accessible.get(filePath, userId, conversationId));
  }
}

export class UsageAuditStore {
  constructor(db) {
    this.db = db;
    this._insert = db.prepare(`INSERT INTO usage_events
      (user_id, event_type, project_id, conversation_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
  }

  log({ userId, eventType, projectId = null, conversationId = null, details = null }) {
    if (!userId || !eventType) return;
    const safeDetails = details && typeof details === 'object' ? JSON.stringify(details) : null;
    this._insert.run(userId, eventType, projectId || null, conversationId || null, safeDetails, Date.now());
  }

  personalUsage(userId, limit = 20) {
    const summary = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM projects WHERE owner_id = ?) AS projects,
        (SELECT COUNT(*) FROM conversations WHERE owner_id = ?) AS conversations,
        (SELECT COUNT(*) FROM usage_events WHERE user_id = ? AND event_type = 'message_sent') AS messages_sent,
        (SELECT COUNT(*) FROM usage_events WHERE user_id = ? AND event_type = 'attachment_uploaded') AS attachments_uploaded
    `).get(userId, userId, userId, userId);
    const events = this.db.prepare(`
      SELECT event_type, project_id, conversation_id, details_json, created_at
      FROM usage_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    `).all(userId, limit);
    const normalizedEvents = events.map(normalizeEvent);
    summary.uploaded_bytes = normalizedEvents
      .filter((event) => event.event_type === 'attachment_uploaded')
      .reduce((sum, event) => sum + (Number.isFinite(event.details?.bytes) ? event.details.bytes : 0), 0);
    return { summary, events: normalizedEvents };
  }

  adminUsage({ userId = null, limit = 100 } = {}) {
    const users = this.db.prepare(`
      SELECT u.id, u.username, u.role, u.created_at,
        (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id) AS projects,
        (SELECT COUNT(*) FROM conversations c WHERE c.owner_id = u.id) AS conversations,
        (SELECT COUNT(*) FROM usage_events e WHERE e.user_id = u.id AND e.event_type = 'message_sent') AS messages_sent,
        (SELECT COUNT(*) FROM usage_events e WHERE e.user_id = u.id AND e.event_type = 'attachment_uploaded') AS attachments_uploaded,
        (SELECT MAX(e.created_at) FROM usage_events e WHERE e.user_id = u.id) AS last_active_at
      FROM users u WHERE u.disabled_at IS NULL ORDER BY last_active_at DESC, u.username COLLATE NOCASE
    `).all();
    const events = this.db.prepare(`
      SELECT e.event_type, e.project_id, e.conversation_id, e.details_json, e.created_at,
        u.id AS user_id, u.username
      FROM usage_events e JOIN users u ON u.id = e.user_id
      WHERE (? IS NULL OR e.user_id = ?) AND u.disabled_at IS NULL
      ORDER BY e.created_at DESC LIMIT ?
    `).all(userId, userId, limit);
    return { users, events: events.map(normalizeEvent) };
  }
}

function normalizeEvent(event) {
  let details = null;
  try { details = event.details_json ? JSON.parse(event.details_json) : null; } catch { /* Legacy malformed details are ignored. */ }
  const { details_json: _details, ...rest } = event;
  return { ...rest, details };
}

export { openDb, DB_PATH, SESSION_MAX_AGE_MS, UPLOAD_TTL_MS };
