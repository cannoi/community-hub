'use strict';
// Online backup (owner-triggered) and offline restore (CLI / API zip).
// Posts live in community.db (posts + events). Optimized to:
//  - WAL checkpoint before snapshot (no silent loss)
//  - Human-readable posts/events export for verification
//  - Manifest inventory with counts
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { packDirToZip, unpackZip } = require('./backup-zip');
const { Db } = require('./db');

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name); const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p));
  }
  return out;
}

function safeCount(db, sql) {
  try { return Number(db.get(sql)?.c || 0); } catch { return 0; }
}

/** Collect inventory so operators can see posts are included. */
function collectInventory(db) {
  const inv = {
    users: safeCount(db, "SELECT COUNT(*) c FROM users WHERE status='local' OR status IS NULL OR status='legacy'"),
    posts: safeCount(db, 'SELECT COUNT(*) c FROM posts'),
    posts_not_deleted: safeCount(db, "SELECT COUNT(*) c FROM posts WHERE deleted_at IS NULL OR deleted_at=''"),
    comments: safeCount(db, 'SELECT COUNT(*) c FROM comments'),
    reactions: safeCount(db, 'SELECT COUNT(*) c FROM reactions'),
    events: safeCount(db, 'SELECT COUNT(*) c FROM events'),
    media: safeCount(db, 'SELECT COUNT(*) c FROM media'),
    groups: safeCount(db, 'SELECT COUNT(*) c FROM groups'),
    peers: safeCount(db, 'SELECT COUNT(*) c FROM peers'),
  };
  try {
    inv.post_create_events = safeCount(db, "SELECT COUNT(*) c FROM events WHERE event_type='post.create'");
  } catch {
    inv.post_create_events = 0;
  }
  return inv;
}

/** Export posts + post.create events as readable JSON (recovery / audit). */
function exportReadableData(db, dest) {
  const dataDir = path.join(dest, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  let posts = [];
  try {
    posts = db.all(
      `SELECT id, user_id, content, visibility, kind, event_id, parent_event, ref_event,
              media, file_url, created_at, edited_at, deleted_at, origin, client_id, sort_ts
       FROM posts ORDER BY id ASC`
    );
  } catch {
    try { posts = db.all('SELECT * FROM posts ORDER BY id ASC'); } catch { posts = []; }
  }
  fs.writeFileSync(
    path.join(dataDir, 'posts.json'),
    JSON.stringify({ exported_at: new Date().toISOString(), count: posts.length, posts }, null, 2),
    { mode: 0o600 }
  );

  let events = [];
  try {
    events = db.all(
      `SELECT lid, event_id, actor_id, sequence, event_type, created_at, body, source
       FROM events ORDER BY lid ASC`
    );
  } catch {
    try { events = db.all('SELECT * FROM events ORDER BY 1 ASC'); } catch { events = []; }
  }
  fs.writeFileSync(
    path.join(dataDir, 'events.json'),
    JSON.stringify({ exported_at: new Date().toISOString(), count: events.length, events }, null, 2),
    { mode: 0o600 }
  );

  // Lightweight index of post.create payloads for quick reading
  const postEvents = [];
  for (const ev of events) {
    if (ev.event_type !== 'post.create') continue;
    let payload = null;
    try {
      const body = typeof ev.body === 'string' ? JSON.parse(ev.body) : ev.body;
      payload = body && body.payload ? body.payload : body;
    } catch { /* ignore */ }
    postEvents.push({
      event_id: ev.event_id,
      actor_id: ev.actor_id,
      sequence: ev.sequence,
      created_at: ev.created_at,
      content: payload && payload.content ? String(payload.content).slice(0, 2000) : null,
      media: payload && payload.media ? payload.media : null,
    });
  }
  fs.writeFileSync(
    path.join(dataDir, 'posts-from-events.json'),
    JSON.stringify({ exported_at: new Date().toISOString(), count: postEvents.length, posts: postEvents }, null, 2),
    { mode: 0o600 }
  );

  return { posts: posts.length, events: events.length, post_events: postEvents.length };
}

function createBackup(cfg, dest, db) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const own = !db;
  if (own) db = new Db(cfg.dbFile);
  let inventory = {};
  let exportStats = {};
  try {
    // Flush WAL so every committed post is in the snapshot (critical).
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* older / locked */ }
    inventory = collectInventory(db);
    exportStats = exportReadableData(db, dest);
    // Consistent SQLite snapshot (VACUUM INTO) — includes posts, events, users, media rows
    db.snapshot(path.join(dest, 'community.db'));
  } finally {
    if (own) db.close();
  }

  const keyDir = cfg.keyDir || path.join(cfg.dataDir, 'keys');
  if (fs.existsSync(keyDir)) {
    for (const f of fs.readdirSync(keyDir).filter((x) => !x.startsWith('.'))) {
      fs.mkdirSync(path.join(dest, 'keys'), { recursive: true, mode: 0o700 });
      fs.copyFileSync(path.join(keyDir, f), path.join(dest, 'keys', f));
      fs.chmodSync(path.join(dest, 'keys', f), 0o600);
    }
  }
  if (fs.existsSync(cfg.uploadDir)) {
    for (const f of walk(cfg.uploadDir)) {
      const to = path.join(dest, 'uploads', f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(cfg.uploadDir, f), to);
    }
  }

  const files = {};
  for (const f of walk(dest)) if (f !== 'manifest.json') files[f] = sha(path.join(dest, f));

  const manifest = {
    format: 'community-hub-backup',
    version: 2,
    created_at: new Date().toISOString(),
    inventory,
    exports: exportStats,
    includes: {
      database: true,
      posts_table: true,
      events_ledger: true,
      posts_json: true,
      events_json: true,
      media_files: true,
      keys: true,
    },
    files,
  };
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return {
    dest,
    files: Object.keys(files).length,
    inventory,
    posts: inventory.posts,
    events: inventory.events,
    media: inventory.media,
  };
}

/** Create folder backup then zip it; returns zip path. */
function createBackupZip(cfg, zipPath, db) {
  const folder = zipPath.replace(/\.zip$/i, '') + '-work';
  try {
    const r = createBackup(cfg, folder, db);
    const z = packDirToZip(folder, zipPath);
    return { ...r, zip: zipPath, bytes: z.bytes };
  } finally {
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

function restoreBackup(cfg, src, { force = false } = {}) {
  const mf = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
  if (mf.format !== 'community-hub-backup' || (mf.version !== 1 && mf.version !== 2)) {
    throw new Error('Unsupported backup format');
  }
  for (const [f, h] of Object.entries(mf.files)) {
    if (f.includes('..')) throw new Error('Unsafe path in manifest');
    if (sha(path.join(src, f)) !== h) throw new Error(`Checksum mismatch for ${f}; backup is corrupted`);
  }
  if (fs.existsSync(cfg.dbFile) && !force) throw new Error('Target already contains a database; pass force to overwrite');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(cfg.dbFile + ext); } catch { /* none */ } }
  fs.copyFileSync(path.join(src, 'community.db'), cfg.dbFile);
  for (const f of Object.keys(mf.files).filter((x) => x.startsWith('keys/') || x.startsWith('keys' + path.sep))) {
    const to = path.join(cfg.dataDir, f);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(src, f), to);
    fs.chmodSync(to, 0o600);
  }
  for (const f of Object.keys(mf.files).filter((x) => x.startsWith('uploads/') || x.startsWith('uploads' + path.sep))) {
    const to = path.join(cfg.uploadDir, f.replace(/^uploads[/\\]/, ''));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(src, f), to);
  }
  // Optional: readable JSON exports are not required for restore (DB is source of truth)
  return {
    restored: Object.keys(mf.files).length,
    inventory: mf.inventory || null,
    version: mf.version,
  };
}

function restoreBackupZip(cfg, zipPath, opts) {
  const tmp = path.join(cfg.dataDir, 'restore-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  try {
    unpackZip(zipPath, tmp);
    return restoreBackup(cfg, tmp, opts);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

module.exports = { createBackup, createBackupZip, restoreBackup, restoreBackupZip, collectInventory };
