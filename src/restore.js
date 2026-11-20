'use strict';
// Account restore from a backup ZIP into a RUNNING Hub (used by the "Restore from ZIP" option of the setup screen).
//
// Why not just copy community.db over the live file? The running process keeps the old SQLite file open: the swap leaves the
// process writing to an unlinked inode while keys/ on disk come from the backup. Later backups then mix a DB from one state with
// keys from another (an account without its private key). This module therefore IMPORTS the backup into the open database inside
// one transaction, re-encrypts the backup's private keys under this Hub's own key-encryption key, copies the media files, then
// verifies every signed event and rebuilds derived views (posts) from the ledger when something is missing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { unpackZip, walk } = require('./backup-zip');
const { Keystore } = require('./keystore');

class RestoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Tables that describe transient / node-level state, never account content.
const SKIP_TABLES = new Set([
  'sessions', 'schema_migrations', 'presence_directory', 'remote_cache',
  'p2p_peer_db', 'p2p_peer_registry', 'p2p_sync_checkpoint', 'p2p_sync_events', 'p2p_inbox_seen', 'feedback_outbox',
]);
// meta keys that belong to the machine, not to the account.
const SKIP_META = new Set(['public_url_override', 'history_pending']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function shaFile(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function findBackupRoot(dir) {
  if (fs.existsSync(path.join(dir, 'manifest.json'))) return dir;
  // tolerate a ZIP that was re-created from the backup folder (one wrapper directory)
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    try { if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'manifest.json'))) return p; } catch { /* skip */ }
  }
  return null;
}

function readManifest(root) {
  let mf;
  try { mf = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); } catch { throw new RestoreError('E_RESTORE_BAD_BACKUP', 'manifest.json is unreadable'); }
  if (!mf || mf.format !== 'community-hub-backup' || (mf.version !== 1 && mf.version !== 2) || typeof mf.files !== 'object' || !mf.files) {
    throw new RestoreError('E_RESTORE_BAD_BACKUP', 'Unsupported backup format');
  }
  for (const [f, h] of Object.entries(mf.files)) {
    if (f.includes('..') || path.isAbsolute(f)) throw new RestoreError('E_RESTORE_BAD_BACKUP', 'Unsafe path in manifest');
    const abs = path.join(root, f);
    if (!fs.existsSync(abs)) throw new RestoreError('E_RESTORE_CORRUPT', `Backup is incomplete: ${f} is missing`);
    if (shaFile(abs) !== h) throw new RestoreError('E_RESTORE_CORRUPT', `Checksum mismatch for ${f}; backup is corrupted`);
  }
  if (!mf.files['community.db']) throw new RestoreError('E_RESTORE_BAD_BACKUP', 'community.db is missing from the backup');
  return mf;
}

// Statements on the attached backup must not enter Db's statement cache (a cached statement would block DETACH).
const rawAll = (db, sql) => db.raw.prepare(sql).all().map((r) => ({ ...r }));
const qident = (n) => { if (!IDENT.test(n)) throw new RestoreError('E_RESTORE_BAD_BACKUP', 'Unexpected table or column name'); return '"' + n + '"'; };

/** Restore into `hub` (must have no local account yet). Returns a summary for the UI. */
function restoreIntoHub(hub, zipPath) {
  const { cfg, db, ks, ledger, mat, log } = hub;
  if (hub._restoring) throw new RestoreError('E_RESTORE_BUSY', 'A restore is already running');
  hub._restoring = true;
  const tmp = path.join(cfg.dataDir, 'restore-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'));
  try {
    const existing = db.get("SELECT COUNT(*) c FROM users WHERE status IN ('local','legacy')");
    if (existing && existing.c > 0) throw new RestoreError('E_RESTORE_NOT_EMPTY', 'This Hub already has accounts; restore is only available on a fresh Hub');

    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    try { unpackZip(zipPath, tmp); } catch (e) { throw new RestoreError('E_RESTORE_BAD_ZIP', e.message || 'Not a valid ZIP file'); }
    const root = findBackupRoot(tmp);
    if (!root) throw new RestoreError('E_RESTORE_BAD_BACKUP', 'This ZIP is not a Community Hub backup (manifest.json not found)');
    const mf = readManifest(root);

    // ---- 1. database: import into the open database, atomically --------------------------------------------------------
    const bkFile = path.join(root, 'community.db');
    db.exec(`ATTACH DATABASE '${bkFile.replace(/'/g, "''")}' AS bk`);
    let tablesCopied = 0;
    try {
      let quick;
      try { quick = rawAll(db, 'PRAGMA bk.quick_check(1)'); } catch { quick = [{ quick_check: 'error' }]; }
      if (!quick.length || String(Object.values(quick[0])[0]).toLowerCase() !== 'ok') throw new RestoreError('E_RESTORE_CORRUPT', 'The database inside the backup is damaged');
      const bkTables = new Set(rawAll(db, "SELECT name FROM bk.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name));
      if (!bkTables.has('users')) throw new RestoreError('E_RESTORE_BAD_BACKUP', 'The backup database has no accounts table');
      const liveTables = new Set(rawAll(db, "SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name));
      const owner = rawAll(db, "SELECT username FROM bk.users WHERE status='local' ORDER BY is_primary DESC, id LIMIT 1")[0];
      if (!owner) throw new RestoreError('E_RESTORE_NO_ACCOUNT', 'The backup does not contain an account to restore');

      db.tx(() => {
        for (const t of bkTables) {
          if (SKIP_TABLES.has(t) || !liveTables.has(t)) continue;
          const live = rawAll(db, `PRAGMA main.table_info(${qident(t)})`).map((c) => c.name);
          const back = new Set(rawAll(db, `PRAGMA bk.table_info(${qident(t)})`).map((c) => c.name));
          const cols = live.filter((c) => back.has(c));
          if (!cols.length) continue;
          const list = cols.map(qident).join(',');
          if (t === 'meta') {
            const skip = [...SKIP_META].map((k) => `'${k}'`).join(',');
            db.exec(`DELETE FROM main.meta WHERE key NOT IN (${skip})`);
            db.exec(`INSERT OR REPLACE INTO main.meta(${list}) SELECT ${list} FROM bk.meta WHERE key NOT IN (${skip})`);
          } else {
            db.exec(`DELETE FROM main.${qident(t)}`);
            db.exec(`INSERT OR REPLACE INTO main.${qident(t)}(${list}) SELECT ${list} FROM bk.${qident(t)}`);
          }
          tablesCopied++;
        }
        // a restored account always starts a clean login: no foreign sessions survive
        db.exec('DELETE FROM main.sessions');
      });
    } finally {
      try { db.exec('DETACH DATABASE bk'); } catch (e) { log && log.warn && log.warn('restore: detach failed ' + e.message); }
    }
    mat.resetAliases();

    // ---- 2. media files ------------------------------------------------------------------------------------------------
    let mediaFiles = 0;
    const upRoot = path.join(root, 'uploads');
    for (const rel of walk(upRoot)) {
      if (rel.split(path.sep).includes('tmp')) continue;
      const to = path.join(cfg.uploadDir, rel);
      try { if (fs.existsSync(to) && fs.statSync(to).size === fs.statSync(path.join(upRoot, rel)).size) { mediaFiles++; continue; } } catch { /* copy below */ }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(upRoot, rel), to);
      mediaFiles++;
    }
    const mediaMissing = db.all('SELECT hash FROM media').filter((m) => !fs.existsSync(path.join(cfg.uploadDir, 'media', m.hash.slice(0, 2), m.hash))).length;

    // ---- 3. private keys (re-encrypted under this Hub's key-encryption key) ---------------------------------------------
    const kb = Keystore.readBackup(path.join(root, 'keys'), cfg.keyPassphrase);
    const locals = db.all("SELECT id, username, account_id, display_name, is_primary FROM users WHERE status='local' ORDER BY is_primary DESC, id");
    const mine = new Set(locals.map((u) => u.account_id));
    const adopted = ks.adopt(kb.keys.filter((k) => mine.has(k.accountId))); // keys of other installs are never imported
    const keysMissing = locals.filter((u) => !ks.has(u.account_id)).map((u) => u.account_id);

    // ---- 4. verify the signed history; rebuild posts from it when the table lost rows ----------------------------------
    let verify = { ok: 0, problems: [] };
    try { verify = ledger.verifyAll(); } catch (e) { verify = { ok: 0, problems: [{ problem: 'verify_failed' }] }; }
    let reindexed = false; let reindexError = null;
    const orphanEvents = db.get("SELECT COUNT(*) c FROM events e WHERE e.event_type='post.create' AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.event_id=e.event_id)");
    if (orphanEvents && orphanEvents.c > 0) {
      try { ledger.reindex(); reindexed = true; } catch (e) { reindexError = e.message; }
    }

    const cnt = (sql) => { try { return Number(db.get(sql).c || 0); } catch { return 0; } };
    const primary = locals[0];
    return {
      ok: true,
      backup_version: mf.version,
      backup_created_at: mf.created_at || null,
      account: primary ? { username: primary.username, display_name: primary.display_name || null, account_id: primary.account_id } : null,
      counts: {
        accounts: locals.length,
        posts: cnt("SELECT COUNT(*) c FROM posts WHERE deleted_at IS NULL OR deleted_at=''"),
        comments: cnt('SELECT COUNT(*) c FROM comments'),
        events: cnt('SELECT COUNT(*) c FROM events'),
        media_rows: cnt('SELECT COUNT(*) c FROM media'),
        media_files: mediaFiles,
        media_missing: mediaMissing,
        tables: tablesCopied,
      },
      keys: { adopted: adopted.adopted.length, missing: keysMissing, read_error: kb.error },
      key_missing: keysMissing.length > 0,
      verify: { ok: verify.ok, problems: verify.problems.length },
      reindexed, reindex_error: reindexError,
    };
  } finally {
    hub._restoring = false;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

module.exports = { restoreIntoHub, RestoreError };
