'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError, randomToken } = require('../util');
const { serveFile } = require('../http');
const { isInline, sniff } = require('../media');

const CHUNK_MAX = 5 * 1024 * 1024;
const SESSION_TTL_MS = 60 * 60 * 1000;
const sessions = new Map();

function purgeSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.created > SESSION_TTL_MS) {
      try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* ok */ }
      sessions.delete(id);
    }
  }
}
try { setInterval(purgeSessions, 10 * 60 * 1000).unref(); } catch { /* ok */ }

module.exports = function register(hub) {
  const { app, db, cfg, media, social, peers, log } = hub;

  app.post('/api/media', { auth: 'user', body: 'multipart', limit: 'upload' }, (ctx) => {
    if (!ctx.files[0]) throw new HttpError(400, 'E_NO_FILE', 'file field required');
    return media.adopt(ctx.files[0], ctx.user.id);
  });

  // ---- Chunked upload (WP4) ----
  app.post('/api/media/sessions', { auth: 'user', limit: 'upload' }, (ctx) => {
    purgeSessions();
    const b = ctx.body || {};
    const filename = String(b.filename || b.name || 'file').slice(0, 200);
    const size = Number(b.size);
    if (!Number.isFinite(size) || size < 1) throw new HttpError(400, 'E_INVALID', 'size required');
    const maxBytes = cfg.maxUploadBytes || 50 * 1024 * 1024;
    if (size > maxBytes) throw new HttpError(413, 'E_TOO_LARGE', 'File too large');
    if (media.usage(ctx.user.id) + size > cfg.userQuotaBytes) throw new HttpError(413, 'E_QUOTA', 'Storage quota exceeded');
    const id = randomToken(16);
    const dir = path.join(cfg.uploadDir, 'tmp', 'chunks-' + id);
    fs.mkdirSync(dir, { recursive: true });
    const totalChunks = Math.ceil(size / CHUNK_MAX);
    sessions.set(id, { id, userId: ctx.user.id, filename, size, totalChunks, received: new Set(), dir, created: Date.now() });
    return { id, chunkSize: CHUNK_MAX, totalChunks, maxBytes };
  });

  app.put('/api/media/sessions/:id/chunk/:index', { auth: 'user', limit: 'upload', body: 'raw', maxBytes: CHUNK_MAX + 64 * 1024 }, (ctx) => {
    const s = sessions.get(ctx.params.id);
    if (!s || s.userId !== ctx.user.id) throw new HttpError(404, 'E_NOT_FOUND', 'Upload session not found');
    const idx = Number(ctx.params.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= s.totalChunks) throw new HttpError(400, 'E_INVALID', 'Bad chunk index');
    const buf = ctx.rawBody || Buffer.alloc(0);
    if (!buf.length) throw new HttpError(400, 'E_EMPTY_FILE', 'Empty chunk');
    if (buf.length > CHUNK_MAX) throw new HttpError(413, 'E_TOO_LARGE', 'Chunk too large');
    if (idx < s.totalChunks - 1 && buf.length !== CHUNK_MAX) throw new HttpError(400, 'E_INVALID', 'Incomplete intermediate chunk');
    const expectedLast = s.size - CHUNK_MAX * (s.totalChunks - 1);
    if (idx === s.totalChunks - 1 && buf.length !== expectedLast) throw new HttpError(400, 'E_INVALID', 'Last chunk size mismatch');
    fs.writeFileSync(path.join(s.dir, String(idx)), buf);
    s.received.add(idx);
    return { ok: true, index: idx, received: s.received.size, totalChunks: s.totalChunks };
  });

  app.post('/api/media/sessions/:id/complete', { auth: 'user', limit: 'upload' }, (ctx) => {
    const s = sessions.get(ctx.params.id);
    if (!s || s.userId !== ctx.user.id) throw new HttpError(404, 'E_NOT_FOUND', 'Upload session not found');
    if (s.received.size !== s.totalChunks) {
      throw new HttpError(400, 'E_INCOMPLETE', 'Missing chunks', { received: s.received.size, totalChunks: s.totalChunks });
    }
    const tmpPath = path.join(s.dir, 'assembled');
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(tmpPath, 'w');
    let head = Buffer.alloc(0);
    let written = 0;
    try {
      for (let i = 0; i < s.totalChunks; i++) {
        const part = fs.readFileSync(path.join(s.dir, String(i)));
        if (i === 0) head = Buffer.from(part.subarray(0, Math.min(4096, part.length)));
        hash.update(part);
        fs.writeSync(fd, part);
        written += part.length;
      }
    } finally {
      try { fs.closeSync(fd); } catch { /* ok */ }
    }
    if (written !== s.size) {
      try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* ok */ }
      sessions.delete(s.id);
      throw new HttpError(400, 'E_INVALID', 'Assembled size mismatch');
    }
    const sha256 = hash.digest('hex');
    const file = { tmpPath, size: s.size, filename: s.filename, head, sha256 };
    let meta;
    try {
      meta = media.adopt(file, ctx.user.id);
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch { /* ok */ }
      try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* ok */ }
      sessions.delete(s.id);
      throw e;
    }
    try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* ok */ }
    sessions.delete(s.id);
    return meta;
  });

  app.delete('/api/media/sessions/:id', { auth: 'user', limit: 'upload' }, (ctx) => {
    const s = sessions.get(ctx.params.id);
    if (!s || s.userId !== ctx.user.id) return { ok: true };
    try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* ok */ }
    sessions.delete(s.id);
    return { ok: true };
  });

  // Content-addressed media. Access is decided per request (public post → anyone; otherwise owner / permitted viewer).
  app.get('/media/:hash', {}, async (ctx) => {
    const h = ctx.params.hash;
    if (!/^[0-9a-f]{64}$/.test(h)) throw new HttpError(404, 'E_NOT_FOUND', 'Not found');
    if (!social.canViewMedia(ctx.user, h)) throw new HttpError(404, 'E_NOT_FOUND', 'Not found');
    let m = db.get('SELECT * FROM media WHERE hash=?', h);
    if (!m || !media.exists(h)) {
      if (!(media.isPublic(h) || media.isRemoteRef(h)) || !peers.enabled) throw new HttpError(404, 'E_NOT_FOUND', 'Not found');
      const ref = db.get('SELECT u.account_id FROM post_media pm JOIN posts p ON p.id=pm.post_id JOIN users u ON u.id=p.user_id WHERE pm.hash=? AND u.status=\'remote\' LIMIT 1', h)
        || db.get('SELECT actor_id AS account_id FROM remote_media_refs WHERE hash=? ORDER BY seen_at DESC LIMIT 1', h);
      const range = ctx.req.headers.range;
      const mirror = cfg.remoteCacheBytes > 0; // opt-in; default: stream through, never store remote media on this disk
      if ((range || !mirror) && peers.proxyMediaRange) {
        try {
          await peers.proxyMediaRange(h, ref?.account_id, { rangeHeader: range, res: ctx.res, maxBytes: cfg.maxUploadBytes || 2 ** 40 });
          return; // response already streamed
        } catch (e) {
          log.debug('range proxy failed: ' + (e.code || e.message));
          if (ctx.res.headersSent) return;
          if (!mirror) throw new HttpError(502, 'E_MEDIA_UNAVAILABLE', 'Media is not available right now');
        }
      }
      try { await peers.fetchMedia(h, ref?.account_id); } catch (e) { log.debug('remote media fetch failed: ' + (e.code || e.message)); throw new HttpError(502, 'E_MEDIA_UNAVAILABLE', 'Media is not available right now'); }
      m = db.get('SELECT * FROM media WHERE hash=?', h);
      if (!m) throw new HttpError(502, 'E_MEDIA_UNAVAILABLE', 'Media is not available right now');
    }
    db.run('UPDATE media SET last_access=? WHERE hash=?', Date.now(), h);
    const pub = media.isPublic(h);
    const inline = isInline(m.kind) && ctx.query.download !== '1';
    serveFile(ctx.req, ctx.res, { file: media.pathFor(h), size: m.size, mime: m.mime, disposition: inline ? 'inline' : 'attachment', filename: m.name, cache: pub ? 'public, max-age=3600' : 'private, no-store', maxRange: cfg.maxRangeBytes, etag: h });
  });

  app.get('/uploads/:name', {}, (ctx) => {
    const name = ctx.params.name;
    if (!ctx.user) throw new HttpError(401, 'E_AUTH', 'Authentication required');
    if (name.length > 300 || /[\\/\0]/.test(name) || name.includes('..')) throw new HttpError(404, 'E_NOT_FOUND', 'Not found');
    const post = db.get('SELECT id FROM posts WHERE file_url=? AND deleted_at IS NULL', '/uploads/' + name);
    if (!post || !social.canViewPost(ctx.user, post.id)) throw new HttpError(404, 'E_NOT_FOUND', 'Not found');
    for (const dir of [cfg.legacyUploadDir, path.join(cfg.uploadDir, 'legacy')]) {
      const abs = path.resolve(dir, name);
      if (path.dirname(abs) !== path.resolve(dir)) continue;
      let st; try { st = fs.statSync(abs); } catch { continue; }
      if (!st.isFile()) continue;
      const fd = fs.openSync(abs, 'r'); const head = Buffer.alloc(Math.min(4096, st.size)); fs.readSync(fd, head, 0, head.length, 0); fs.closeSync(fd);
      const t = sniff(head, name);
      const inline = t && isInline(t.kind);
      return serveFile(ctx.req, ctx.res, { file: abs, size: st.size, mime: inline ? t.mime : 'application/octet-stream', disposition: inline ? 'inline' : 'attachment', filename: name.replace(/^\d+-\d+-/, ''), cache: 'private, no-store', maxRange: cfg.maxRangeBytes });
    }
    throw new HttpError(404, 'E_NOT_FOUND', 'Not found');
  });
};
