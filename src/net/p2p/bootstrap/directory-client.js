'use strict';
/**
 * Directory / Rendezvous client (Cloudflare Worker or any Hub seed).
 * Never relays content — only peer descriptors. Worker down ≠ network dead.
 */
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');
const crypto = require('crypto');
const { guardedLookup, isPublicIp } = require('../../../federation/transport');
const { sanitizeJsonValue } = require('./cloudflare-crypto');
const { getKey, seal, open } = require('./crypto');

const DEFAULT_DIRECTORY =
  'https://cannoi-community-bootstrap.huunghitran-datxanh.workers.dev';
const MAX_DIR_BYTES = 1024 * 1024;

function isLoopbackIp(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '').toLowerCase();
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1';
}

function assertSafeDirectoryUrl(raw, { allowPrivate = false } = {}) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw Object.assign(new Error('bad_scheme'), { code: 'bad_scheme' });
  }
  if (u.username || u.password || u.hash) {
    throw Object.assign(new Error('bad_url'), { code: 'bad_url' });
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.length > 253) {
    throw Object.assign(new Error('bad_url'), { code: 'bad_url' });
  }
  if (net.isIP(host)) {
    if (!allowPrivate && !isPublicIp(host) && !isLoopbackIp(host)) {
      throw Object.assign(new Error('private_address'), { code: 'private_address' });
    }
  } else if (!allowPrivate && (/(^|\.)localhost$/i.test(host) || /\.(local|internal|lan|home|corp)$/i.test(host))) {
    throw Object.assign(new Error('private_address'), { code: 'private_address' });
  }
  return u;
}

function normalizeUrls(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const s = String(raw || '').trim().replace(/\/+$/, '');
    if (!s) continue;
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
      if (seen.has(u.origin + u.pathname.replace(/\/+$/, ''))) continue;
      seen.add(u.origin + u.pathname.replace(/\/+$/, ''));
      out.push(u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '')));
    } catch { /* skip */ }
  }
  return out;
}

function fetchJson(url, { method = 'GET', body, timeoutMs = 8000, headers = {}, maxBytes = MAX_DIR_BYTES, allowPrivate = false } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = assertSafeDirectoryUrl(url, { allowPrivate }); } catch (e) { reject(e); return; }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqOpts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      agent: false,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'community-hub-directory-client/2.4',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    };
    if (!net.isIP(host)) {
      reqOpts.lookup = guardedLookup(!!allowPrivate);
    }
    const req = lib.request(reqOpts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return reject(Object.assign(new Error('redirect_blocked'), { code: 'E_REDIRECT' }));
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        return reject(Object.assign(new Error('response_too_large'), { code: 'E_TOO_LARGE' }));
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > maxBytes) {
          res.destroy();
          return reject(Object.assign(new Error('response_too_large'), { code: 'E_TOO_LARGE' }));
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try {
          const parsed = JSON.parse(buf.toString('utf8') || 'null');
          json = parsed && typeof parsed === 'object' ? sanitizeJsonValue(parsed) : parsed;
        } catch { json = null; }
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: buf,
          json,
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
        });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error('timeout'), { code: 'E_TIMEOUT' })); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function classifyError(e, res) {
  if (e && e.code === 'E_TIMEOUT') return 'timeout';
  if (e && (e.code === 'ENOTFOUND' || e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET')) return 'network';
  if (res) {
    if (res.status === 429) return 'rate_limited';
    if (res.status >= 500) return 'server';
    if (res.status >= 400) return 'validation';
  }
  return 'unknown';
}

function isSafeEndpointUrl(raw, { allowPrivate = false } = {}) {
  try {
    const u = assertSafeDirectoryUrl(String(raw || '').trim(), { allowPrivate });
    return u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
  } catch { return null; }
}

/** Validate peer descriptor from directory listing (defense in depth). */
function sanitizePeer(p, { allowPrivate = false } = {}) {
  if (!p || typeof p !== 'object') return null;
  const peerId = String(p.peer_id || p.peerId || '').slice(0, 128);
  if (peerId.length < 8) return null;
  const rawMultiaddrs = (Array.isArray(p.multiaddrs) ? p.multiaddrs : [])
    .map(String)
    .filter((ma) => ma.startsWith('/') && ma.length < 512 && ma.includes('/p2p/' + peerId))
    .slice(0, 8);
  // Prefer public; drop clearly private unless allowed
  let multiaddrs = rawMultiaddrs;
  if (!allowPrivate) {
    multiaddrs = rawMultiaddrs.filter((ma) =>
      !/\/ip4\/(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ma) &&
      !/\/ip6\/(::1|fe80:|fc|fd)/.test(ma)
    );
  }
  const safeEndpoint = p.endpoint ? isSafeEndpointUrl(p.endpoint, { allowPrivate }) : null;
  if (!multiaddrs.length && !safeEndpoint) return null;
  let expires = Number(p.expires_at) || 0;
  if (expires > 0 && expires < 1e12) expires *= 1000;
  if (expires && expires < Date.now()) return null;
  return {
    peerId,
    multiaddrs,
    network: String(p.network || 'cannoi').slice(0, 32),
    protocol: String(p.protocol || '1').slice(0, 16),
    capabilities: Array.isArray(p.capabilities) ? p.capabilities.map(String).slice(0, 16) : [],
    reachability: String(p.reachability || 'unknown').slice(0, 32),
    endpoint: safeEndpoint,
    name: typeof p.name === 'string' ? p.name.slice(0, 60) : null,
    expires_at: expires || null,
    source: 'directory',
    category: 'cannoi',
  };
}

class DirectoryClient {
  /**
   * @param {{ urls?: string[], timeoutMs?: number, log?: object, allowPrivate?: boolean, cloudflareKey?: string, cloudflareStrict?: boolean }} opts
   */
  constructor(opts = {}) {
    this.urls = normalizeUrls(opts.urls && opts.urls.length ? opts.urls : [DEFAULT_DIRECTORY]);
    this.timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 8000);
    this.log = opts.log || { debug() {}, info() {}, warn() {} };
    this.allowPrivate = !!opts.allowPrivate;
    const explicitKey = typeof opts.cloudflareKey === 'string' ? opts.cloudflareKey.trim() : '';
    this.cloudflareKey = explicitKey || String(process.env.CLOUDFLARE_SYNC_KEY || '').trim();
    this.cloudflareStrict = !!opts.cloudflareStrict;
    this._failures = 0;
    this._lastOkAt = 0;
    this._lastError = null;
    this._lastRegisterError = null;
    this._lastStatus = null;
    this._registeredUntil = 0;
    this._retryBudget = 20;
    this._nextRetryAt = 0;
  }

  status() {
    return {
      urls: this.urls.slice(0, 5),
      encrypted_sync: !!this.cloudflareKey,
      last_ok_at: this._lastOkAt || null,
      last_error: this._lastError,
      last_register_error: this._lastRegisterError,
      last_http_status: this._lastStatus,
      failures: this._failures,
      registered_until: this._registeredUntil || null,
      retry_budget: this._retryBudget,
    };
  }

  async fetchBootstrap() {
    const rid = crypto.randomBytes(4).toString('hex');
    const peers = [];
    let key;
    try {
      key = getKey(this.cloudflareKey);
    } catch {
      this._lastError = 'missing_key';
      return { peers, raw: null, url: null };
    }
    for (const base of this.urls) {
      const t0 = Date.now();
      try {
        const res = await fetchJson(base + '/p2p/bootstrap', {
          timeoutMs: this.timeoutMs,
          headers: { 'X-Cannoi-Encrypted': '1' },
          allowPrivate: this.allowPrivate,
        });
        this._lastStatus = res.status;
        const ms = Date.now() - t0;
        if (!res.ok || !res.json) {
          this._lastError = classifyError(null, res);
          this.log.debug(`dir[${rid}] bootstrap ${base} status=${res.status} ${ms}ms`);
          continue;
        }
        let j;
        try {
          j = open(res.json, key);
        } catch (e) {
          this._lastError = 'decrypt_failed';
          this.log.debug(`dir[${rid}] bootstrap decrypt skipped ${base}: ${e && e.message}`);
          continue;
        }
        const payload = (j && j.data && typeof j.data === 'object' && Array.isArray(j.data.peers)) ? j.data : j;
        if (!payload || (payload.network && payload.network !== 'cannoi')) continue;
        for (const p of (Array.isArray(payload.peers) ? payload.peers : []).slice(0, 200)) {
          const s = sanitizePeer(p, { allowPrivate: this.allowPrivate });
          if (s) peers.push(s);
        }
        this._lastOkAt = Date.now();
        this._failures = 0;
        this._lastError = null;
        this.log.debug(`dir[${rid}] bootstrap ok ${base} peers=${peers.length} ${ms}ms`);
        return { peers, raw: payload, url: base };
      } catch (e) {
        this._failures++;
        this._lastError = classifyError(e, null);
        this.log.debug(`dir[${rid}] bootstrap fail ${base}: ${e.message}`);
      }
    }
    return { peers, raw: null, url: null };
  }

  /**
   * Register local record with encrypted directory Worker (v1.4.0 AES-256-GCM).
   * Strictly requires sealed payload and encrypted response; skips failing seeds cleanly.
   */
  async register(record) {
    if (!record || !record.peer_id || !Array.isArray(record.multiaddrs) || !record.multiaddrs.length) {
      return { ok: false, reason: 'invalid_record' };
    }
    if (this._retryBudget <= 0 && Date.now() < this._nextRetryAt) {
      return { ok: false, reason: 'retry_budget' };
    }
    let key;
    try {
      key = getKey(this.cloudflareKey);
    } catch {
      this._lastRegisterError = 'missing_key';
      if (!this._lastOkAt) this._lastError = 'missing_key';
      return { ok: false, reason: 'missing_key' };
    }
    const rid = crypto.randomBytes(4).toString('hex');
    for (const base of this.urls) {
      const t0 = Date.now();
      try {
        const sendBody = seal({ record }, key);
        const res = await fetchJson(base + '/p2p/register', {
          method: 'POST',
          body: sendBody,
          headers: { 'X-Cannoi-Encrypted': '1' },
          timeoutMs: this.timeoutMs,
          allowPrivate: this.allowPrivate,
        });
        this._lastStatus = res.status;
        const ms = Date.now() - t0;
        this.log.debug(`dir[${rid}] register ${base} status=${res.status} ${ms}ms`);
        let respJson = null;
        if (res.ok) {
          if (!res.json) {
            this._lastRegisterError = 'decrypt_failed';
            this.log.debug(`dir[${rid}] register empty/non-json response ${base}`);
            continue;
          }
          try {
            respJson = open(res.json, key);
          } catch (e) {
            this._lastRegisterError = 'decrypt_failed';
            this.log.debug(`dir[${rid}] register decrypt failed ${base}: ${e && e.message}`);
            continue;
          }
        }
        if (res.status === 429) {
          this._retryBudget = Math.max(0, this._retryBudget - 1);
          this._nextRetryAt = Date.now() + 60000;
          this._lastRegisterError = 'rate_limited';
          return { ok: false, reason: 'rate_limited', status: 429, json: respJson };
        }
        if (!res.ok) {
          this._lastRegisterError = classifyError(null, res);
          if (!this._lastOkAt) this._lastError = this._lastRegisterError;
          continue;
        }
        this._lastOkAt = Date.now();
        this._failures = 0;
        this._lastRegisterError = null;
        const exp = Number(record.expires_at) || (Date.now() + 24 * 3600 * 1000);
        this._registeredUntil = exp;
        this._retryBudget = Math.min(20, this._retryBudget + 2);
        return { ok: true, status: res.status, json: respJson, url: base };
      } catch (e) {
        this._failures++;
        this._lastRegisterError = classifyError(e, null);
        if (!this._lastOkAt) this._lastError = this._lastRegisterError;
        this._retryBudget = Math.max(0, this._retryBudget - 1);
        this._nextRetryAt = Date.now() + Math.min(300000, 2000 * (2 ** Math.min(6, this._failures)));
        this.log.debug(`dir[${rid}] register fail ${base}: ${e.message}`);
      }
    }
    return { ok: false, reason: this._lastRegisterError || this._lastError || 'unreachable' };
  }

  /** True if we should re-register (10-minute refresh or TTL expiry). */
  shouldRefreshRegistration(now = Date.now()) {
    if (!this._registeredUntil) return true;
    const ttlLeft = this._registeredUntil - now;
    if (ttlLeft <= 0) return true;
    if (this._lastOkAt && now - this._lastOkAt >= 10 * 60 * 1000) return true;
    const half = 12 * 3600 * 1000;
    return ttlLeft < half;
  }
}

module.exports = {
  DirectoryClient,
  DEFAULT_DIRECTORY,
  normalizeUrls,
  sanitizePeer,
  fetchJson,
  classifyError,
};
