'use strict';
// Small shared helpers. No third-party dependencies.
const crypto = require('crypto');

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status; this.code = code; this.extra = extra;
  }
}

/**
 * Canonical serialization "hub-canon-v1" used for hashing and signing.
 * Objects: keys sorted by UTF-16 code units, no whitespace. Strings: JSON escaping.
 * Numbers: safe integers only (floats are rejected so every runtime produces identical bytes).
 * undefined / functions / NaN are rejected. Depth is bounded.
 */
function canonicalize(v, depth = 0) {
  if (depth > 8) throw new Error('canonical: too deep');
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(v)) throw new Error('canonical: only safe integers allowed');
      return String(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x) => canonicalize(x, depth + 1)).join(',') + ']';
      const keys = Object.keys(v).sort();
      const parts = [];
      for (const k of keys) {
        if (v[k] === undefined) throw new Error('canonical: undefined value');
        parts.push(JSON.stringify(k) + ':' + canonicalize(v[k], depth + 1));
      }
      return '{' + parts.join(',') + '}';
    }
    default: throw new Error('canonical: unsupported type ' + typeof v);
  }
}

function safeJsonParse(s, fallback = null) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/** Bounded LRU-ish map with TTL, used for nonce replay protection and rate limits. */
class TtlMap {
  constructor(max = 10000) { this.max = max; this.m = new Map(); }
  has(k, now = Date.now()) { const e = this.m.get(k); if (!e) return false; if (e.exp <= now) { this.m.delete(k); return false; } return true; }
  set(k, ttlMs, now = Date.now()) {
    if (this.m.size >= this.max) {
      for (const [key, e] of this.m) { if (e.exp <= now) this.m.delete(key); }
      while (this.m.size >= this.max) this.m.delete(this.m.keys().next().value);
    }
    this.m.set(k, { exp: now + ttlMs });
  }
  get size() { return this.m.size; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Redact obviously secret-looking values before logging. */
function redact(s) {
  return String(s).replace(/(authorization|api[_-]?key|password|passphrase|secret|token)(["'\s:=]+)[^\s"',}]+/gi, '$1$2[redacted]');
}
function makeLogger(level = 'info', sink = console) {
  const levels = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
  const cur = levels[level] ?? 3;
  const f = (lvl) => (...a) => { if ((levels[lvl]) <= cur) sink[lvl === 'debug' ? 'log' : lvl](`[${new Date().toISOString()}] ${lvl.toUpperCase()}`, ...a.map((x) => redact(x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x)))); };
  return { error: f('error'), warn: f('warn'), info: f('info'), debug: f('debug') };
}

module.exports = { base32, b64u, fromB64u, sha256, sha256hex, randomToken, HttpError, canonicalize, safeJsonParse, TtlMap, sleep, redact, makeLogger };
