'use strict';
/**
 * WebCrypto-compatible AES-256-GCM payload encryption for Cloudflare Worker directory sync.
 *
 * Envelope format (JSON):
 * {
 *   "encrypted": true,
 *   "v": 1,
 *   "alg": "AES-256-GCM",
 *   "iv": "<base64 12-byte IV>",
 *   "ct": "<base64 ciphertext + 16-byte GCM auth tag>"
 * }
 *
 * Key derivation: SHA-256(UTF-8 secret) -> 32-byte AES-256 key.
 * Matches Cloudflare Workers `crypto.subtle.digest('SHA-256', ...)` + `crypto.subtle.encrypt('AES-GCM', ...)`.
 */
const crypto = require('crypto');

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeJsonValue(val, depth = 0) {
  if (depth > 40) throw new Error('json_depth_exceeded');
  if (val === null || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map((item) => sanitizeJsonValue(item, depth + 1));
  const out = {};
  for (const k of Object.keys(val)) {
    if (BAD_KEYS.has(k)) continue;
    out[k] = sanitizeJsonValue(val[k], depth + 1);
  }
  return out;
}

function deriveKey(secret) {
  if (typeof secret !== 'string') return null;
  const trimmed = secret.trim();
  if (!trimmed) return null;
  return crypto.createHash('sha256').update(Buffer.from(trimmed, 'utf8')).digest();
}

function isEncryptedEnvelope(obj) {
  return !!(
    obj &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    obj.encrypted === true &&
    typeof obj.iv === 'string' &&
    typeof (obj.ct || obj.data) === 'string'
  );
}

function encryptEnvelope(payload, secret) {
  const key = deriveKey(secret);
  if (!key) throw Object.assign(new Error('missing_cloudflare_key'), { code: 'missing_cloudflare_key' });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([encrypted, tag]);
  return {
    encrypted: true,
    v: 1,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    ct: combined.toString('base64'),
  };
}

function decryptEnvelope(obj, secret) {
  if (!obj || typeof obj !== 'object') {
    return { ok: false, wasEncrypted: false, data: null, error: 'invalid_payload' };
  }
  if (!isEncryptedEnvelope(obj)) {
    try {
      return { ok: true, wasEncrypted: false, data: sanitizeJsonValue(obj) };
    } catch {
      return { ok: false, wasEncrypted: false, data: null, error: 'invalid_payload' };
    }
  }
  const key = deriveKey(secret);
  if (!key) {
    return { ok: false, wasEncrypted: true, data: null, error: 'missing_key' };
  }
  try {
    if (obj.v !== undefined && Number(obj.v) !== 1) {
      return { ok: false, wasEncrypted: true, data: null, error: 'unsupported_version' };
    }
    if (obj.alg !== undefined && String(obj.alg).toUpperCase() !== 'AES-256-GCM') {
      return { ok: false, wasEncrypted: true, data: null, error: 'unsupported_alg' };
    }
    const iv = Buffer.from(obj.iv, 'base64');
    const raw = Buffer.from(obj.ct || obj.data, 'base64');
    if (iv.length !== 12 || raw.length < 16) {
      return { ok: false, wasEncrypted: true, data: null, error: 'invalid_envelope' };
    }
    const ciphertext = raw.subarray(0, raw.length - 16);
    const tag = raw.subarray(raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plainBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(plainBuf.toString('utf8'));
    return { ok: true, wasEncrypted: true, data: sanitizeJsonValue(parsed) };
  } catch {
    return { ok: false, wasEncrypted: true, data: null, error: 'decrypt_failed' };
  }
}

module.exports = {
  deriveKey,
  encryptEnvelope,
  decryptEnvelope,
  isEncryptedEnvelope,
  sanitizeJsonValue,
};
