'use strict';
// Online backup (owner-triggered) and offline restore (CLI / API zip).
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

function createBackup(cfg, dest, db) {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  // A raw copy of a live WAL-mode SQLite file silently loses committed pages that still sit in the -wal file.
  // VACUUM INTO produces a consistent snapshot (this was a data-loss regression in 2.2.0).
  const own = !db; if (own) db = new Db(cfg.dbFile);
  try { db.snapshot(path.join(dest, 'community.db')); } finally { if (own) db.close(); }
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
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify({ format: 'community-hub-backup', version: 1, created_at: new Date().toISOString(), files }, null, 2), { mode: 0o600 });
  return { dest, files: Object.keys(files).length };
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
  if (mf.format !== 'community-hub-backup' || mf.version !== 1) throw new Error('Unsupported backup format');
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
  return { restored: Object.keys(mf.files).length };
}

function restoreBackupZip(cfg, zipPath, { force = false } = {}) {
  const tmp = path.join(cfg.dataDir, 'restore-tmp-' + Date.now());
  try {
    unpackZip(zipPath, tmp);
    return restoreBackup(cfg, tmp, { force });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ok */ }
  }
}

module.exports = { createBackup, createBackupZip, restoreBackup, restoreBackupZip };
