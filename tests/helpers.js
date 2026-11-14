'use strict';
/**
 * Shared test helpers for Community Hub.
 * Provides isolated temporary data directories, hub lifecycle, and an HTTP client
 * that automatically manages session cookies + CSRF tokens.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createHub } = require('../src/hub');

let _tmpCounter = 0;

/** Create a unique temporary directory under the OS temp folder. */
function tmp(prefix = 'hub') {
  const dir = path.join(os.tmpdir(), `ch-${prefix}-${process.pid}-${Date.now()}-${++_tmpCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Tiny 1×1 PNG (valid) used by media tests. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** Minimal valid-looking MP4 header (for content-type tests; not a full playable file). */
const mp4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  0x00, 0x00, 0x00, 0x00, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31,
]);

/**
 * Build a multipart/form-data body for file upload tests.
 * @param {object} fields  key → string | { filename, contentType, buffer }
 */
function formWith(fields) {
  const boundary = '----TestBoundary' + Date.now();
  const parts = [];
  for (const [name, val] of Object.entries(fields)) {
    if (val && typeof val === 'object' && Buffer.isBuffer(val.buffer || val)) {
      const buf = val.buffer || val;
      const filename = val.filename || 'file.bin';
      const ct = val.contentType || 'application/octet-stream';
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
        `Content-Type: ${ct}\r\n\r\n`
      );
      parts.push(buf);
      parts.push('\r\n');
    } else {
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        String(val) + '\r\n'
      );
    }
  }
  parts.push(`--${boundary}--\r\n`);
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Poll until predicate returns truthy or timeout. */
async function waitFor(fn, timeoutMs = 10000, intervalMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* keep trying */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out after ' + timeoutMs + 'ms');
}

/**
 * Start an isolated Hub instance with its own data directory.
 * Returns the hub object plus convenience fields: .base, .dir, .cfg, .net, …
 */
async function startHub(overrides = {}) {
  const dataDir = overrides.dataDir || tmp('hub');
  const cfgOverrides = {
    dataDir,
    dbFile: path.join(dataDir, 'community.db'),
    keyDir: path.join(dataDir, 'keys'),
    uploadDir: path.join(dataDir, 'uploads'),
    publicDir: path.join(__dirname, '..', 'public'),
    host: '127.0.0.1',
    port: 0,                          // ephemeral
    logLevel: overrides.logLevel || 'error',
    allowRegistration: overrides.allowRegistration !== undefined ? overrides.allowRegistration : false,
    allowPrivatePeers: true,          // tests run on loopback
    ...overrides,
  };
  // Nested objects that tests often override
  if (overrides.p2p) cfgOverrides.p2p = { enabled: false, ...overrides.p2p };
  if (overrides.presence) cfgOverrides.presence = overrides.presence;
  if (overrides.rateLimit) cfgOverrides.rateLimit = overrides.rateLimit;
  if (overrides.transport) cfgOverrides.transport = overrides.transport; // passed via createHub overrides

  const hub = createHub(cfgOverrides, process.env);
  // Attach transport if provided via overrides (SpyTransport etc.)
  if (overrides.transport) {
    hub.transport = overrides.transport;
  }
  await hub.start();
  hub.base = `http://127.0.0.1:${hub.port}`;
  hub.dir = dataDir;
  return hub;
}

/**
 * Lightweight HTTP client that keeps cookies and CSRF token across requests.
 */
class Client {
  constructor(base) {
    this.base = base.replace(/\/+$/, '');
    this.cookie = '';
    this.csrf = '';
    this.last = null;
  }

  async req(method, path, body, opts = {}) {
    const url = new URL(path.startsWith('http') ? path : this.base + path);
    const headers = Object.assign({
      'Accept': 'application/json',
      'User-Agent': 'community-hub-test/2.3',
    }, opts.headers || {});
    if (this.cookie) headers['Cookie'] = this.cookie;
    if (this.csrf && method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = this.csrf;

    let payload = null;
    if (body !== undefined && body !== null) {
      if (Buffer.isBuffer(body) || (opts.rawBody && typeof body === 'string')) {
        payload = body;
        if (!headers['Content-Type'] && opts.contentType) headers['Content-Type'] = opts.contentType;
      } else if (typeof body === 'object' && !(body instanceof Buffer)) {
        payload = JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
      } else {
        payload = String(body);
      }
    }

    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: opts.timeout || 15000,
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          // capture Set-Cookie
          const sc = r.headers['set-cookie'];
          if (sc) {
            const parts = (Array.isArray(sc) ? sc : [sc]).map((s) => s.split(';')[0]);
            this.cookie = parts.join('; ');
          }
          // capture CSRF from body or header
          if (json && json.csrf) this.csrf = json.csrf;
          if (r.headers['x-csrf-token']) this.csrf = r.headers['x-csrf-token'];
          resolve({
            status: r.statusCode,
            headers: r.headers,
            text,
            json,
            body: buf,
          });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
      if (payload) req.write(payload);
      req.end();
    });
    this.last = res;
    return res;
  }

  get(path, opts) { return this.req('GET', path, null, opts); }
  post(path, body, opts) { return this.req('POST', path, body, opts); }
  put(path, body, opts) { return this.req('PUT', path, body, opts); }
  patch(path, body, opts) { return this.req('PATCH', path, body, opts); }
  delete(path, body, opts) { return this.req('DELETE', path, body, opts); }

  /**
   * Create the owner account (first-run setup) or log in.
   * Default password is the well-known test password.
   */
  async setup(username = 'owner', password = 'correct-horse-9', extra = {}) {
    // Try setup endpoint first (first run)
    let r = await this.post('/api/setup', { username, password, ...extra });
    if (r.status === 200 || r.status === 201) {
      if (r.json && r.json.csrf) this.csrf = r.json.csrf;
      return r.json || r;
    }
    // Already set up → login
    r = await this.post('/api/login', { username, password });
    if (r.status !== 200) {
      throw new Error(`setup/login failed (${r.status}): ${r.text.slice(0, 200)}`);
    }
    if (r.json && r.json.csrf) this.csrf = r.json.csrf;
    return r.json || r;
  }
}

module.exports = {
  startHub,
  Client,
  waitFor,
  tmp,
  PNG,
  mp4,
  formWith,
};
