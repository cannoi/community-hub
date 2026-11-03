'use strict';
// SQLite access via Node's built-in node:sqlite (synchronous, no native build step).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

class Db {
  constructor(file) {
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=OFF;');
    this.cache = new Map();
    this.depth = 0;
    this.closed = false;
  }
  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      if (this.cache.size > 400) this.cache.clear();
      s = this.raw.prepare(sql); this.cache.set(sql, s);
    }
    return s;
  }
  run(sql, ...p) { return this.stmt(sql).run(...p); }
  get(sql, ...p) { const r = this.stmt(sql).get(...p); return r ? { ...r } : undefined; }
  all(sql, ...p) { return this.stmt(sql).all(...p).map((r) => ({ ...r })); }
  exec(sql) { this.raw.exec(sql); }
  /** Transaction with nested savepoints; rolls back on any thrown error. */
  tx(fn) {
    const top = this.depth === 0;
    const sp = `sp${this.depth}`;
    this.raw.exec(top ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const r = fn();
      this.depth--;
      this.raw.exec(top ? 'COMMIT' : `RELEASE ${sp}`);
      return r;
    } catch (e) {
      this.depth--;
      try { this.raw.exec(top ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`); } catch { /* already rolled back */ }
      throw e;
    }
  }
  hasColumn(table, col) { return this.all(`PRAGMA table_info(${table})`).some((c) => c.name === col); }
  addColumn(table, col, def) { if (!this.hasColumn(table, col)) this.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
  hasTable(t) { return !!this.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", t); }
  /** Consistent snapshot of the database into a new file. */
  snapshot(dest) {
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    this.raw.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    this.cache.clear();
    this.raw.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Migrations. Never edit an applied migration; append a new one. Migration 1 recreates the exact
// original schema (IF NOT EXISTS) so databases created by the old app are adopted as-is.
// ---------------------------------------------------------------------------------------------
const MIGRATIONS = [
  {
    id: 1, name: 'baseline-original-schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, avatar TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, description TEXT, owner_id INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS group_members (group_id INTEGER, user_id INTEGER, role TEXT, joined_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (group_id, user_id));
        CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER, user_id INTEGER, content TEXT, file_url TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, user_id INTEGER, content TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS reactions (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, user_id INTEGER, type TEXT, UNIQUE(post_id, user_id));
      `);
    },
  },
  {
    id: 2, name: 'accounts-posts-media-columns',
    up(db) {
      db.addColumn('users', 'account_id', 'TEXT');
      db.addColumn('users', 'pubkey', 'TEXT');
      db.addColumn('users', 'status', "TEXT DEFAULT 'legacy'"); // legacy | local | remote
      db.addColumn('users', 'is_primary', 'INTEGER DEFAULT 0');
      db.addColumn('users', 'display_name', 'TEXT');
      db.addColumn('users', 'bio', 'TEXT');
      db.addColumn('users', 'avatar_media', 'TEXT');
      db.addColumn('users', 'password_hash', 'TEXT');
      db.addColumn('users', 'lang', 'TEXT');
      db.addColumn('groups', 'visibility', "TEXT DEFAULT 'open'"); // open | private
      db.addColumn('posts', 'event_id', 'TEXT');
      db.addColumn('posts', 'kind', "TEXT DEFAULT 'post'"); // post | reply | repost | quote
      db.addColumn('posts', 'visibility', 'TEXT');
      db.addColumn('posts', 'parent_event', 'TEXT');
      db.addColumn('posts', 'ref_event', 'TEXT');
      db.addColumn('posts', 'media', 'TEXT');
      db.addColumn('posts', 'sort_ts', 'INTEGER');
      db.addColumn('posts', 'edited_at', 'INTEGER');
      db.addColumn('posts', 'deleted_at', 'INTEGER');
      db.addColumn('posts', 'origin', "TEXT DEFAULT 'local'");
      db.addColumn('posts', 'client_id', 'TEXT');
      db.addColumn('reactions', 'target_event', 'TEXT');
      db.addColumn('reactions', 'event_id', 'TEXT');
      // adopt legacy rows
      db.exec(`UPDATE users SET status='legacy' WHERE status IS NULL;
               UPDATE posts SET visibility='group' WHERE visibility IS NULL AND group_id IS NOT NULL;
               UPDATE posts SET visibility='public' WHERE visibility IS NULL;
               UPDATE posts SET origin='local' WHERE origin IS NULL;
               UPDATE posts SET kind='post' WHERE kind IS NULL;
               UPDATE posts SET sort_ts = CAST(strftime('%s', created_at) AS INTEGER) * 1000 WHERE sort_ts IS NULL;
               UPDATE groups SET visibility='open' WHERE visibility IS NULL;`);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS ux_users_account ON users(account_id) WHERE account_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS ux_posts_event ON posts(event_id) WHERE event_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS ux_posts_client ON posts(user_id, client_id) WHERE client_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS ux_react_event ON reactions(target_event, user_id) WHERE target_event IS NOT NULL;
        CREATE INDEX IF NOT EXISTS ix_posts_group ON posts(group_id, sort_ts DESC, id DESC);
        CREATE INDEX IF NOT EXISTS ix_posts_user ON posts(user_id, sort_ts DESC, id DESC);
        CREATE INDEX IF NOT EXISTS ix_posts_sort ON posts(sort_ts DESC, id DESC);
        CREATE INDEX IF NOT EXISTS ix_posts_parent ON posts(parent_event);
        CREATE INDEX IF NOT EXISTS ix_posts_ref ON posts(ref_event);
        CREATE INDEX IF NOT EXISTS ix_react_post ON reactions(post_id);
        CREATE INDEX IF NOT EXISTS ix_comments_post ON comments(post_id);
        CREATE INDEX IF NOT EXISTS ix_members_user ON group_members(user_id);
      `);
    },
  },
  {
    id: 3, name: 'ledger-peers-social',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

        CREATE TABLE IF NOT EXISTS events (
          lid INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          actor_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          previous_event_hash TEXT,
          created_at INTEGER NOT NULL,
          body TEXT NOT NULL,
          received_at INTEGER NOT NULL,
          source TEXT NOT NULL,
          UNIQUE(actor_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS ix_events_type ON events(event_type);
        CREATE TABLE IF NOT EXISTS actor_state (actor_id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, last_seq INTEGER NOT NULL, last_event_id TEXT NOT NULL, forked INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS event_conflicts (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, sequence INTEGER NOT NULL, kept_event_id TEXT, conflicting_event_id TEXT NOT NULL, kind TEXT NOT NULL, source TEXT, detected_at INTEGER NOT NULL, UNIQUE(conflicting_event_id));
        CREATE TABLE IF NOT EXISTS ledger_gaps (actor_id TEXT NOT NULL, expected_seq INTEGER NOT NULL, seen_seq INTEGER NOT NULL, source TEXT, detected_at INTEGER NOT NULL, PRIMARY KEY(actor_id));
        CREATE TABLE IF NOT EXISTS checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, lid INTEGER NOT NULL, event_count INTEGER NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL);

        CREATE TABLE IF NOT EXISTS follows (follower TEXT NOT NULL, followee TEXT NOT NULL, event_id TEXT, created_at INTEGER, PRIMARY KEY(follower, followee));
        CREATE INDEX IF NOT EXISTS ix_follows_followee ON follows(followee);
        CREATE TABLE IF NOT EXISTS endpoint_announces (actor_id TEXT PRIMARY KEY, endpoints TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS post_tags (post_id INTEGER NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(post_id, tag));
        CREATE INDEX IF NOT EXISTS ix_tags_tag ON post_tags(tag);
        CREATE TABLE IF NOT EXISTS post_media (post_id INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(post_id, hash));
        CREATE INDEX IF NOT EXISTS ix_post_media_hash ON post_media(hash);

        -- local-only (never federated) tables
        CREATE TABLE IF NOT EXISTS blocks (user_id INTEGER NOT NULL, account_id TEXT NOT NULL, created_at INTEGER, PRIMARY KEY(user_id, account_id));
        CREATE TABLE IF NOT EXISTS mutes (user_id INTEGER NOT NULL, account_id TEXT NOT NULL, created_at INTEGER, PRIMARY KEY(user_id, account_id));
        CREATE TABLE IF NOT EXISTS bookmarks (user_id INTEGER NOT NULL, post_id INTEGER NOT NULL, created_at INTEGER, PRIMARY KEY(user_id, post_id));
        CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL, actor_user_id INTEGER, post_id INTEGER, event_id TEXT, created_at INTEGER NOT NULL, read_at INTEGER, UNIQUE(user_id, type, event_id));
        CREATE INDEX IF NOT EXISTS ix_notif_user ON notifications(user_id, id DESC);
        CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, reporter_id INTEGER NOT NULL, post_id INTEGER, account_id TEXT, reason TEXT, created_at INTEGER NOT NULL, status TEXT DEFAULT 'open');
        CREATE TABLE IF NOT EXISTS media (
          hash TEXT PRIMARY KEY, mime TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, name TEXT,
          owner_user INTEGER, origin TEXT NOT NULL DEFAULT 'local', origin_actor TEXT, created_at INTEGER NOT NULL, last_access INTEGER);

        CREATE TABLE IF NOT EXISTS peers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id TEXT UNIQUE,
          pubkey TEXT,
          endpoint TEXT NOT NULL UNIQUE,
          pin TEXT,
          state TEXT NOT NULL DEFAULT 'discovered', -- bootstrap | trusted | discovered | blocked
          name TEXT,
          remote_cursor INTEGER NOT NULL DEFAULT 0,
          last_seen INTEGER, last_ok INTEGER, last_sync_at INTEGER,
          last_error TEXT, error_count INTEGER NOT NULL DEFAULT 0, fail_streak INTEGER NOT NULL DEFAULT 0,
          next_retry_at INTEGER NOT NULL DEFAULT 0,
          events_received INTEGER NOT NULL DEFAULT 0, events_rejected INTEGER NOT NULL DEFAULT 0,
          last_discovery_at INTEGER, created_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    id: 4, name: 'media-owners',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS media_owners (hash TEXT NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(hash, user_id));
               CREATE INDEX IF NOT EXISTS ix_media_owners_user ON media_owners(user_id);`);
    },
  },
  {
    id: 5, name: 'feedback_outbox',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS feedback_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );`);
    },
  },
  {
    id: 6, name: 'presence-remote-cache',
    up(db) {
      // Global Presence, Local Content: bulk content sync is opt-in per peer; remote content is fetched on demand
      // into a small, bounded cache that never becomes part of the local ledger or the local posts table.
      db.addColumn('peers', 'sync_content', 'INTEGER NOT NULL DEFAULT 0');
      db.exec(`
        CREATE TABLE IF NOT EXISTS remote_cache (
          event_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_type TEXT NOT NULL,
          created_at INTEGER NOT NULL, body TEXT NOT NULL, fetched_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS ix_rc_actor ON remote_cache(actor_id, sequence DESC);
        CREATE INDEX IF NOT EXISTS ix_rc_fetched ON remote_cache(fetched_at);
        CREATE TABLE IF NOT EXISTS remote_actors (actor_id TEXT PRIMARY KEY, head_seq INTEGER, fetched_at INTEGER NOT NULL, last_error TEXT);
        CREATE TABLE IF NOT EXISTS remote_media_refs (
          hash TEXT NOT NULL, actor_id TEXT NOT NULL, mime TEXT, size INTEGER, name TEXT, seen_at INTEGER NOT NULL,
          PRIMARY KEY(hash, actor_id));
        CREATE INDEX IF NOT EXISTS ix_rmr_seen ON remote_media_refs(seen_at);
      `);
    },
  },
];

function openDatabase(file, log = { info() {}, warn() {} }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file);
  const db = new Db(file);
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.all('SELECT id FROM schema_migrations').map((r) => r.id));
  const known = new Set(MIGRATIONS.map((m) => m.id));
  for (const id of applied) {
    if (!known.has(id)) { db.close(); throw new Error(`Database was migrated by a newer version (unknown migration ${id}); refusing to start`); }
  }
  const pending = MIGRATIONS.filter((m) => !applied.has(m.id));
  if (pending.length && existed && db.hasTable('users') && applied.size === 0 && db.get('SELECT COUNT(*) c FROM users').c > 0) {
    // First upgrade of a database created by the original app: keep a safety copy.
    const bak = `${file}.pre-upgrade-${Date.now()}.bak`;
    try { db.snapshot(bak); log.info(`Legacy database detected; safety copy written to ${path.basename(bak)}`); } catch (e) { log.warn('Could not write safety copy: ' + e.message); }
  }
  for (const m of pending) {
    try {
      db.tx(() => { m.up(db); db.run('INSERT INTO schema_migrations(id,name,applied_at) VALUES(?,?,?)', m.id, m.name, Date.now()); });
      log.info(`Applied migration ${m.id} (${m.name})`);
    } catch (e) {
      db.close();
      throw new Error(`Migration ${m.id} (${m.name}) failed and was rolled back: ${e.message}`);
    }
  }
  return db;
}

module.exports = { Db, openDatabase, MIGRATIONS };
