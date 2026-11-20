'use strict';
// Local-first media storage: content-addressed files (no user-controlled names or extensions on disk),
// magic-byte type detection, quotas, and access-controlled serving.
const fs = require('fs');
const path = require('path');
const { HttpError } = require('./util');

const DOC_EXT = new Set(['.zip', '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp']);
const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.json', '.log']);
const INLINE_KINDS = new Set(['image', 'video', 'audio']);

/** Detect type from magic bytes (never from the client-supplied Content-Type). Returns null if unsupported. */
function sniff(head, filename = '') {
  const ext = path.extname(filename).toLowerCase();
  const h = head;
  const s = (a, b) => h.subarray(a, b).toString('latin1');
  if (h.length >= 4 && h[0] === 0x89 && s(1, 4) === 'PNG') return { mime: 'image/png', kind: 'image' };
  if (h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return { mime: 'image/jpeg', kind: 'image' };
  if (s(0, 4) === 'GIF8') return { mime: 'image/gif', kind: 'image' };
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image' };
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return { mime: 'audio/wav', kind: 'audio' };
  if (s(4, 8) === 'ftyp') {
    const brand = s(8, 12);
    if (brand === 'qt  ') return { mime: 'video/quicktime', kind: 'video' };
    if (brand === 'M4A ' || brand === 'M4B ') return { mime: 'audio/mp4', kind: 'audio' };
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return null;
    return { mime: 'video/mp4', kind: 'video' };
  }
  if (h.length >= 4 && h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return ext === '.weba' || ext === '.mka' ? { mime: 'audio/webm', kind: 'audio' } : { mime: 'video/webm', kind: 'video' };
  if (s(0, 4) === 'OggS') return ext === '.ogv' ? { mime: 'video/ogg', kind: 'video' } : { mime: 'audio/ogg', kind: 'audio' };
  if (s(0, 3) === 'ID3' || (h.length >= 2 && h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', kind: 'audio' };
  if (s(0, 4) === 'fLaC') return { mime: 'audio/flac', kind: 'audio' };
  if (s(0, 5) === '%PDF-') return { mime: 'application/pdf', kind: 'document' };
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'AVI ') return { mime: 'video/x-msvideo', kind: 'video' };
  if (s(0, 4) === '\x1aE\xdf\xa3' || (h.length >= 4 && h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3 && ext === '.mkv')) return { mime: 'video/x-matroska', kind: 'video' };
  if (ext === '.heic' || ext === '.heif') return { mime: 'image/heic', kind: 'image' };
  if (ext === '.rar' || (h.length >= 7 && s(0, 7) === 'Rar!\x1a\x07')) return { mime: 'application/vnd.rar', kind: 'document' };
  if (ext === '.7z' || (h.length >= 6 && h[0] === 0x37 && h[1] === 0x7a)) return { mime: 'application/x-7z-compressed', kind: 'document' };
  if (ext === '.apk' || (ext === '.zip' && DOC_EXT.has(ext))) return { mime: 'application/vnd.android.package-archive', kind: 'document' };

  if (s(0, 2) === 'PK' && DOC_EXT.has(ext)) return { mime: 'application/octet-stream', kind: 'document' };
  if (TEXT_EXT.has(ext) && !h.includes(0)) return { mime: 'text/plain; charset=utf-8', kind: 'document' };
  return null;
}

const isInline = (kind) => INLINE_KINDS.has(kind);

function safeName(name) {
  const base = path.basename(String(name || 'file').replace(/\\/g, '/')).replace(/[^\w.\- ()\u00C0-\u024F\u1E00-\u1EFF]/g, '_').slice(0, 120);
  return base || 'file';
}

class MediaStore {
  constructor(db, cfg, log) {
    this.db = db; this.cfg = cfg; this.log = log;
    this.root = path.join(cfg.uploadDir, 'media');
    fs.mkdirSync(this.root, { recursive: true }); fs.mkdirSync(path.join(cfg.uploadDir, 'tmp'), { recursive: true });
  }
  pathFor(hash) { return path.join(this.root, hash.slice(0, 2), hash); }
  exists(hash) { return fs.existsSync(this.pathFor(hash)); }
  usage(userId) {
    return this.db.get('SELECT COALESCE(SUM(m.size),0) AS n FROM media_owners o JOIN media m ON m.hash=o.hash WHERE o.user_id=?', userId).n;
  }
  /** Validate + move an uploaded temp file into the store. */
  adopt(file, userId, { origin = 'local', originActor = null } = {}) {
    if (!file.size) throw new HttpError(400, 'E_EMPTY_FILE', 'Empty file');
    const t = sniff(file.head, file.filename);
    if (!t) throw new HttpError(415, 'E_UNSUPPORTED_TYPE', 'Unsupported file type');
    const hash = file.sha256;
    const dest = this.pathFor(hash);
    const known = this.db.get('SELECT hash FROM media WHERE hash=?', hash);
    if (userId && !this.db.get('SELECT 1 x FROM media_owners WHERE hash=? AND user_id=?', hash, userId) && this.usage(userId) + file.size > this.cfg.userQuotaBytes) throw new HttpError(413, 'E_QUOTA', 'Storage quota exceeded');
    if (!fs.existsSync(dest)) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(file.tmpPath, dest); fs.chmodSync(dest, 0o600); }
    else { try { fs.unlinkSync(file.tmpPath); } catch { /* ok */ } }
    if (!known) this.db.run('INSERT INTO media(hash,mime,kind,size,name,owner_user,origin,origin_actor,created_at) VALUES(?,?,?,?,?,?,?,?,?)', hash, t.mime, t.kind, file.size, safeName(file.filename), userId || null, origin, originActor, Date.now());
    if (userId) this.db.run('INSERT OR IGNORE INTO media_owners(hash,user_id) VALUES(?,?)', hash, userId);
    return this.meta(hash);
  }
  meta(hash) {
    const m = this.db.get('SELECT hash,mime,kind,size,name,origin FROM media WHERE hash=?', hash);
    return m && { ...m, url: `/media/${hash}` };
  }
  /** Media attached to events must exist locally and belong to the author. */
  assertOwned(hashes, userId) {
    const out = [];
    for (const h of hashes) {
      if (!/^[0-9a-f]{64}$/.test(h)) throw new HttpError(400, 'E_BAD_MEDIA', 'Invalid media reference');
      const m = this.db.get('SELECT m.hash,m.mime,m.size,m.name FROM media m JOIN media_owners o ON o.hash=m.hash WHERE m.hash=? AND o.user_id=?', h, userId);
      if (!m) throw new HttpError(400, 'E_BAD_MEDIA', 'Unknown media reference');
      out.push({ hash: m.hash, mime: m.mime.split(';')[0], size: m.size, name: m.name || 'file' });
    }
    return out;
  }
  isPublic(hash) {
    return !!this.db.get(`SELECT 1 x FROM post_media pm JOIN posts p ON p.id=pm.post_id WHERE pm.hash=? AND p.visibility='public' AND p.deleted_at IS NULL LIMIT 1`, hash)
      || !!this.db.get('SELECT 1 x FROM users WHERE avatar_media=? LIMIT 1', hash);
  }
  /** Media referenced by a remote profile the user opened on demand (streamed through; only for signed-in viewers). */
  isRemoteRef(hash) {
    return !!this.db.get('SELECT 1 x FROM remote_media_refs WHERE hash=? AND seen_at>? LIMIT 1', hash, Date.now() - ((this.cfg.remote && this.cfg.remote.ttlMs) || 86400000));
  }
  /** Sum of cached remote media, for the cache cap. */
  remoteBytes() { return this.db.get("SELECT COALESCE(SUM(size),0) n FROM media WHERE origin='remote'").n; }
  evictRemote(needed) {
    let freed = 0;
    for (const m of this.db.all("SELECT hash,size FROM media WHERE origin='remote' ORDER BY COALESCE(last_access,created_at) ASC LIMIT 200")) {
      if (this.remoteBytes() + needed <= this.cfg.remoteCacheBytes) break;
      try { fs.unlinkSync(this.pathFor(m.hash)); } catch { /* gone */ }
      this.db.run('DELETE FROM media WHERE hash=?', m.hash); freed += m.size;
    }
    return freed;
  }
}

module.exports = { MediaStore, sniff, isInline, safeName };
