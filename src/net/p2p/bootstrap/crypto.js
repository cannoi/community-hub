'use strict';
/**
 * Bootstrap AES-256-GCM envelope crypto (compatible with Cloudflare Worker v1.4.0 & WebCrypto).
 *
 * Spec:
 *   key = SHA-256(utf8(CLOUDFLARE_SYNC_KEY)) -> 32-byte Buffer
 *   alg = "AES-256-GCM"
 *   iv  = 12 random bytes (base64)
 *   ct  = ciphertext || authTag (16 bytes) (base64)
 *   envelope = { encrypted: true, v: 1, alg: "AES-256-GCM", iv, ct }
 */
const crypto = require('crypto');
const { sanitizeJsonValue } = require('./cloudflare-crypto');

function resolveSecretKey(keyOrSecret) {
  if (Buffer.isBuffer(keyOrSecret)) {
    if (keyOrSecret.length !== 32) {
      throw Object.assign(new Error('Invalid AES-256 key length'), { code: 'INVALID_CLOUDFLARE_SYNC_KEY' });
    }
    return keyOrSecret;
  }
  const raw = keyOrSecret !== undefined && keyOrSecret !== null
    ? String(keyOrSecret)
    : String(process.env.CLOUDFLARE_SYNC_KEY || '');
  const trimmed = raw.trim();
  if (!trimmed) {
    throw Object.assign(new Error('CLOUDFLARE_SYNC_KEY is not configured'), { code: 'MISSING_CLOUDFLARE_SYNC_KEY' });
  }
  return crypto.createHash('sha256').update(Buffer.from(trimmed, 'utf8')).digest();
}

function getKey(secretOverride) {
  return resolveSecretKey(secretOverride);
}

function seal(obj, keyOrSecret) {
  const key = resolveSecretKey(keyOrSecret);
  const iv = crypto.randomBytes(12);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ct = Buffer.concat([enc, tag]);
  return {
    encrypted: true,
    v: 1,
    alg: 'AES-256-GCM',
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
  };
}

function open(envelope, keyOrSecret) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.encrypted !== true) {
    throw Object.assign(new Error('Expected encrypted bootstrap envelope'), { code: 'ENVELOPE_REQUIRED' });
  }
  if (envelope.v !== undefined && Number(envelope.v) !== 1) {
    throw Object.assign(new Error('Unsupported envelope version'), { code: 'UNSUPPORTED_ENVELOPE_VERSION' });
  }
  if (String(envelope.alg || '').toUpperCase() !== 'AES-256-GCM') {
    throw Object.assign(new Error('Unsupported envelope algorithm'), { code: 'UNSUPPORTED_ENVELOPE_ALG' });
  }
  if (typeof envelope.iv !== 'string' || typeof envelope.ct !== 'string') {
    throw Object.assign(new Error('Malformed encrypted envelope'), { code: 'MALFORMED_ENVELOPE' });
  }
  const key = resolveSecretKey(keyOrSecret);
  const iv = Buffer.from(envelope.iv, 'base64');
  const raw = Buffer.from(envelope.ct, 'base64');
  if (iv.length !== 12 || raw.length < 16) {
    throw Object.assign(new Error('Invalid envelope IV or ciphertext'), { code: 'INVALID_ENVELOPE' });
  }
  const ciphertext = raw.subarray(0, raw.length - 16);
  const tag = raw.subarray(raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plainBuf = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const parsed = JSON.parse(plainBuf.toString('utf8'));
  return parsed && typeof parsed === 'object' ? sanitizeJsonValue(parsed) : parsed;
}

function openOrPlain(body, keyOrSecret) {
  if (!body || typeof body !== 'object') {
    throw Object.assign(new Error('Invalid bootstrap payload'), { code: 'INVALID_PAYLOAD' });
  }
  if (body.encrypted === true) {
    return open(body, keyOrSecret);
  }
  return sanitizeJsonValue(body);
}

module.exports = {
  getKey,
  seal,
  open,
  openOrPlain,
};
