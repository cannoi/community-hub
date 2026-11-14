'use strict';
// Minimal, dependency-free HTTP layer: router, bounded body parsing, streaming multipart, rate limiting,
// security headers, static files and Range-capable file serving.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError } = require('./util');

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://www.tiktok.com",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

class RateLimiter {
  constructor(max = 50000) { this.hits = new Map(); this.max = max; }
  /** @returns {number} 0 if allowed, otherwise seconds until the window resets */
  check(key, limit, windowMs = 60000, now = Date.now()) {
    let e = this.hits.get(key);
    if (!e || e.reset <= now) {
      if (this.hits.size >= this.max) this._prune(now);
      e = { n: 0, reset: now + windowMs }; this.hits.set(key, e);
    }
    e.n++;
    return e.n > limit ? Math.max(1, Math.ceil((e.reset - now) / 1000)) : 0;
  }
  _prune(now) { for (const [k, e] of this.hits) if (e.reset <= now) this.hits.delete(k); while (this.hits.size >= this.max) this.hits.delete(this.hits.keys().next().value); }
}

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}

function clientIp(req, trustProxy) {
  if (trustProxy > 0) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ip = xff[xff.length - trustProxy];
    if (ip) return ip;
  }
  return req.socket.remoteAddress || 'unknown';
}

async function readBody(req, limit) {
  const len = Number(req.headers['content-length']);
  if (Number.isFinite(len) && len > limit) throw new HttpError(413, 'E_TOO_LARGE', 'Request body too large');
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) { req.destroy(); throw new HttpError(413, 'E_TOO_LARGE', 'Request body too large'); } chunks.push(c); }
  return Buffer.concat(chunks);
}

async function parseJsonBody(req, limit) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  const raw = await readBody(req, limit);
  if (!raw.length) return { body: {}, raw };
  if (ct.startsWith('application/x-www-form-urlencoded')) return { body: Object.fromEntries(new URLSearchParams(raw.toString('utf8'))), raw };
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'E_CONTENT_TYPE', 'Content-Type must be application/json');
  try { const b = JSON.parse(raw.toString('utf8')); return { body: b, raw }; } catch { throw new HttpError(400, 'E_BAD_JSON', 'Invalid JSON'); }
}

/** Streaming multipart/form-data parser. Files go to tmpDir, hashed on the fly, size-capped. */
async function parseMultipart(req, opts) {
  const { tmpDir, maxFileBytes, maxFiles = 1, maxFields = 30, maxFieldBytes = 65536 } = opts;
  const ct = String(req.headers['content-type'] || '');
  const m = /^multipart\/form-data;\s*boundary=(?:"([^"]{1,200})"|([^;\s]{1,200}))/i.exec(ct);
  if (!m) throw new HttpError(415, 'E_CONTENT_TYPE', 'Expected multipart/form-data');
  const delim = Buffer.from('\r\n--' + (m[1] || m[2]));
  const len = Number(req.headers['content-length']);
  if (Number.isFinite(len) && len > maxFileBytes + 1024 * 1024) throw new HttpError(413, 'E_TOO_LARGE', 'Upload too large');
  fs.mkdirSync(tmpDir, { recursive: true });
  const fields = {}; const files = [];
  let buf = Buffer.from('\r\n'); let state = 'preamble'; let cur = null; let nFields = 0; let total = 0;
  const cleanup = () => { for (const f of files) { try { fs.closeSync(f._fd); } catch { /* closed */ } try { fs.unlinkSync(f.tmpPath); } catch { /* gone */ } } };
  const finishPart = () => {
    if (!cur) return;
    if (cur.file) { fs.closeSync(cur.file._fd); cur.file.sha256 = cur.hash.digest('hex'); delete cur.file._fd; }
    else fields[cur.name] = Buffer.concat(cur.chunks).toString('utf8');
    cur = null;
  };
  const startPart = (headerText) => {
    const h = {};
    for (const line of headerText.split('\r\n')) { const i = line.indexOf(':'); if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
    const cd = h['content-disposition'] || '';
    const name = /name="([^"]{1,100})"/.exec(cd)?.[1];
    const filename = /filename="([^"]{0,300})"/.exec(cd)?.[1];
    if (!name || /__proto__|constructor|prototype/.test(name)) throw new HttpError(400, 'E_BAD_MULTIPART', 'Bad multipart header');
    if (filename !== undefined) {
      if (files.length >= maxFiles) throw new HttpError(400, 'E_TOO_MANY_FILES', 'Too many files');
      const tmpPath = path.join(tmpDir, 'up-' + crypto.randomBytes(12).toString('hex'));
      const f = { fieldname: name, filename, tmpPath, size: 0, head: Buffer.alloc(0), _fd: fs.openSync(tmpPath, 'w', 0o600) };
      files.push(f); cur = { file: f, hash: crypto.createHash('sha256') };
    } else {
      if (++nFields > maxFields) throw new HttpError(400, 'E_TOO_MANY_FIELDS', 'Too many fields');
      cur = { name, chunks: [], size: 0 };
    }
  };
  const write = (data) => {
    if (!data.length || !cur) return;
    if (cur.file) {
      const f = cur.file; f.size += data.length;
      if (f.size > maxFileBytes) throw new HttpError(413, 'E_TOO_LARGE', 'File too large');
      if (f.head.length < 4096) f.head = Buffer.concat([f.head, data.subarray(0, 4096 - f.head.length)]);
      cur.hash.update(data); fs.writeSync(f._fd, data);
    } else {
      cur.size += data.length;
      if (cur.size > maxFieldBytes) throw new HttpError(413, 'E_TOO_LARGE', 'Field too large');
      cur.chunks.push(Buffer.from(data));
    }
  };
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxFileBytes + 1024 * 1024) throw new HttpError(413, 'E_TOO_LARGE', 'Upload too large');
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (state === 'end') { buf = Buffer.alloc(0); break; }
        if (state === 'delimtail') {
          if (buf.length < 2) break;
          const t = buf.subarray(0, 2).toString('latin1');
          if (t === '--') { state = 'end'; continue; }
          if (t !== '\r\n') throw new HttpError(400, 'E_BAD_MULTIPART', 'Malformed multipart');
          buf = buf.subarray(2); state = 'headers'; continue;
        }
        if (state === 'headers') {
          const i = buf.indexOf('\r\n\r\n');
          if (i < 0) { if (buf.length > 8192) throw new HttpError(400, 'E_BAD_MULTIPART', 'Header too large'); break; }
          startPart(buf.subarray(0, i).toString('utf8')); buf = buf.subarray(i + 4); state = 'body'; continue;
        }
        const i = buf.indexOf(delim);
        if (i >= 0) { if (state === 'body') { write(buf.subarray(0, i)); finishPart(); } buf = buf.subarray(i + delim.length); state = 'delimtail'; continue; }
        if (state === 'body') { const safe = buf.length - (delim.length - 1); if (safe > 0) { write(buf.subarray(0, safe)); buf = buf.subarray(safe); } }
        else if (buf.length > 65536) buf = buf.subarray(buf.length - delim.length);
        break;
      }
    }
    if (state !== 'end') throw new HttpError(400, 'E_BAD_MULTIPART', 'Incomplete multipart body');
  } catch (e) { cleanup(); throw e; }
  return { fields, files, cleanup: () => { for (const f of files) { try { fs.unlinkSync(f.tmpPath); } catch { /* moved */ } } } };
}

/** Serve a file with correct single-range (206) semantics, bounded range size and safe headers. */
function serveFile(req, res, { file, size, mime, disposition = 'inline', filename, cache = 'private, no-store', maxRange, etag }) {
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'; media-src 'self'; img-src 'self'; style-src 'unsafe-inline'", 'Cross-Origin-Resource-Policy': 'same-origin' };
  if (disposition === 'attachment') headers['Content-Disposition'] = `attachment; filename="${(filename || 'download').replace(/[^\w.\- ]/g, '_').slice(0, 100)}"`;
  if (etag) headers.ETag = `"${etag}"`;
  if (etag && req.headers['if-none-match'] === `"${etag}"`) { res.writeHead(304, headers); return res.end(); }
  let start = 0; let end = size - 1; let status = 200;
  const range = req.headers.range;
  if (range && size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] || m[2])) {
      if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, size - n); }
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
      if (start >= size || start > end) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }); return res.end(); }
      if (maxRange && end - start + 1 > maxRange) end = start + maxRange - 1;
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    } // multi-range or malformed: ignore header and serve whole file (allowed by RFC 9110)
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

class App {
  constructor({ config, log, limiter }) { this.cfg = config; this.log = log; this.routes = []; this.limiter = limiter || new RateLimiter(); this.hooks = {}; }
  route(method, pattern, opts, handler) {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    this.routes.push({ method, re, keys, opts, handler, pattern });
  }
  get(p, o, h) { this.route('GET', p, o, h); }
  post(p, o, h) { this.route('POST', p, o, h); }
  patch(p, o, h) { this.route('PATCH', p, o, h); }
  put(p, o, h) { this.route('PUT', p, o, h); }
  delete(p, o, h) { this.route('DELETE', p, o, h); }

  json(res, status, obj, extraHeaders = {}) {
    // Prefer setHeader so prior Set-Cookie (login/logout) is never dropped by writeHead.
    const body = JSON.stringify(obj);
    if (res.headersSent) { try { res.end(body); } catch { /* closed */ } return; }
    res.statusCode = status || 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.setHeader('Cache-Control', 'no-store');
    for (const [k, v] of Object.entries(extraHeaders || {})) {
      if (v === undefined || v === null) continue;
      res.setHeader(k, v);
    }
    res.end(body);
  }

  async handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const ip = clientIp(req, this.cfg.trustProxy);
    const ctx = { req, res, ip, params: {}, query: {}, user: null, session: null, body: {}, files: [], cfg: this.cfg, app: this };
    try {
      if (req.url.length > 2048) throw new HttpError(414, 'E_URI', 'URI too long');
      const url = new URL(req.url, 'http://local');
      ctx.url = url; ctx.path = url.pathname;
      for (const [k, v] of url.searchParams) if (!/__proto__|constructor/.test(k)) ctx.query[k] = v;
      const rl = this.limiter.check('g:' + ip, this.cfg.rateLimit.general);
      if (rl) { res.setHeader('Retry-After', rl); throw new HttpError(429, 'E_RATE_LIMIT', 'Too many requests'); }

      let route = null; let pathMatched = false;
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      for (const r of this.routes) {
        const m = r.re.exec(ctx.path);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        route = r; r.keys.forEach((k, i) => { try { ctx.params[k] = decodeURIComponent(m[i + 1]); } catch { throw new HttpError(400, 'E_BAD_PATH', 'Bad path'); } });
        break;
      }
      if (!route) {
        if (method === 'GET' && this.hooks.static) return await this.hooks.static(ctx);
        throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'E_METHOD' : 'E_NOT_FOUND', pathMatched ? 'Method not allowed' : 'Not found');
      }
      const o = route.opts;
      if (o.limit) {
        const lim = this.cfg.rateLimit[o.limit];
        const r2 = this.limiter.check(`${o.limit}:${ip}`, lim);
        if (r2) { res.setHeader('Retry-After', r2); throw new HttpError(429, 'E_RATE_LIMIT', 'Too many requests'); }
      }
      if (route.method !== 'GET' && req.headers.origin) { // cross-site write attempts are refused whatever the auth mode
        let host = ''; try { host = new URL(req.headers.origin).host; } catch { /* invalid */ }
        if (host !== req.headers.host) throw new HttpError(403, 'E_CSRF', 'Cross-origin request refused');
      }
      if (this.hooks.auth) await this.hooks.auth(ctx, o);
      if (route.method !== 'GET' && o.csrf !== false && ctx.session) this.hooks.csrf(ctx);
      if (o.body === 'multipart') {
        const mp = await parseMultipart(req, { tmpDir: path.join(this.cfg.uploadDir, 'tmp'), maxFileBytes: o.maxBytes || this.cfg.maxUploadBytes });
        ctx.body = mp.fields; ctx.files = mp.files; ctx.cleanup = mp.cleanup;
      } else if (o.body === 'json' || (o.body === undefined && route.method !== 'GET')) {
        const { body, raw } = await parseJsonBody(req, o.maxBytes || this.cfg.maxJsonBytes);
        ctx.body = body; ctx.rawBody = raw;
      } else if (o.body === 'raw') ctx.rawBody = await readBody(req, o.maxBytes || this.cfg.maxJsonBytes);
      try {
        const out = await route.handler(ctx);
        if (out !== undefined && !res.headersSent && !res.writableEnded) this.json(res, res.statusCode || 200, out);
      } finally { if (ctx.cleanup) ctx.cleanup(); }
    } catch (e) {
      if (ctx.cleanup) ctx.cleanup();
      this.fail(res, e);
    }
  }
  fail(res, e) {
    if (res.headersSent) { try { res.destroy(); } catch { /* closed */ } return; }
    if (e instanceof HttpError) return this.json(res, e.status, { error: e.message, code: e.code, ...(e.extra || {}) });
    this.log.error('Unhandled error: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
    this.json(res, 500, { error: 'Internal server error', code: 'E_INTERNAL' });
  }
}

/** Static file handler for the public/ directory with traversal protection. */
function staticHandler(dir) {
  const root = path.resolve(dir) + path.sep;
  return async (ctx) => {
    let rel = ctx.path === '/' ? '/index.html' : ctx.path;
    let abs;
    try { abs = path.resolve(root, '.' + decodeURIComponent(rel)); } catch { throw new HttpError(400, 'E_BAD_PATH', 'Bad path'); }
    if (!abs.startsWith(root) || rel.includes('\0')) throw new HttpError(404, 'E_NOT_FOUND', 'Not found');
    let st;
    try { st = fs.statSync(abs); } catch { throw new HttpError(404, 'E_NOT_FOUND', 'Not found'); }
    if (!st.isFile()) throw new HttpError(404, 'E_NOT_FOUND', 'Not found');
    const ext = path.extname(abs).toLowerCase();
    if (!MIME[ext]) throw new HttpError(404, 'E_NOT_FOUND', 'Not found');
    ctx.res.setHeader('Cache-Control', 'no-cache');
    ctx.res.setHeader('Content-Type', MIME[ext]);
    ctx.res.setHeader('Content-Length', st.size);
    ctx.res.writeHead(200);
    if (ctx.req.method === 'HEAD') return ctx.res.end();
    fs.createReadStream(abs).pipe(ctx.res);
  };
}

module.exports = { App, RateLimiter, parseCookies, clientIp, parseMultipart, serveFile, staticHandler, readBody, parseJsonBody, SECURITY_HEADERS };
