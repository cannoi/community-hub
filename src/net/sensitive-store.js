'use strict';
/**
 * Encrypted-at-rest wrapper over SQLite `meta(key, value)`.
 * Encrypts sensitive operational data (custom_seeds, intro_peer, public_url_override,
 * P2P file share records, group private metadata) with AES-256-GCM under a subkey derived
 * from the Hub keystore KEK (`ks.kek`), preventing raw IP / seed / secret disclosure on disk.
 * Legacy plaintext values in `meta` remain readable transparently and are encrypted on next write.
 */
const crypto = require('crypto');

const INFO = Buffer.from('hub-meta-enc-v1');

function deriveMetaKey(kek) {
  if (!kek || !Buffer.isBuffer(kek) || kek.length < 16) return null;
  return Buffer.from(crypto.hkdfSync('sha256', kek, Buffer.alloc(0), INFO, 32));
}

function maskEndpoint(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let out = s.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, '•••.•••.•••.$4');
  out = out.replace(/\[([0-9a-f:]+)\]/gi, '[••••:••••]');
  try {
    const u = new URL(out);
    if (!out.includes('•••') && u.hostname.length > 6) {
      const parts = u.hostname.split('.');
      if (parts.length >= 2) {
        const maskedHost = parts.slice(0, -1).map((p) => (p.length > 2 ? p[0] + '•••' + p.slice(-1) : '••')).join('.') + '.' + parts[parts.length - 1];
        return u.protocol + '//' + maskedHost + (u.port ? ':' + u.port : '');
      }
    }
  } catch { /* non-URL string, return IP-masked */ }
  return out;
}

class SensitiveStore {
  constructor(db, kek) {
    this.db = db;
    this.key = deriveMetaKey(kek);
  }

  encryptValue(key, plaintext) {
    if (!this.key) return String(plaintext);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('meta:' + String(key), 'utf8'));
    const ct = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
      __enc: 1,
      alg: 'AES-256-GCM',
      iv: iv.toString('base64url'),
      tag: tag.toString('base64url'),
      ct: ct.toString('base64url'),
    });
  }

  decryptValue(key, raw) {
    if (raw === null || raw === undefined) return '';
    const s = String(raw);
    if (!s) return '';
    if (s[0] !== '{') return s; // legacy plaintext compatibility
    try {
      const env = JSON.parse(s);
      if (!env || env.__enc !== 1 || env.alg !== 'AES-256-GCM' || !env.iv || !env.tag || !env.ct) {
        return s; // normal JSON stored in meta
      }
      if (!this.key) return '';
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(env.iv, 'base64url'));
      d.setAAD(Buffer.from('meta:' + String(key), 'utf8'));
      d.setAuthTag(Buffer.from(env.tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(env.ct, 'base64url')), d.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  get(key) {
    try {
      const row = this.db.get('SELECT value FROM meta WHERE key=?', String(key));
      if (!row || row.value === null || row.value === undefined) return '';
      return this.decryptValue(key, row.value);
    } catch {
      return '';
    }
  }

  set(key, value) {
    const k = String(key);
    if (value === null || value === undefined || value === '') {
      this.db.run('DELETE FROM meta WHERE key=?', k);
      return;
    }
    const stored = this.encryptValue(k, String(value));
    this.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', k, stored);
  }

  getJson(key, fallback = null) {
    const txt = this.get(key);
    if (!txt) return fallback;
    try { return JSON.parse(txt); } catch { return fallback; }
  }

  setJson(key, obj) {
    if (obj === null || obj === undefined) {
      this.del(key);
      return;
    }
    this.set(key, JSON.stringify(obj));
  }

  del(key) {
    this.db.run('DELETE FROM meta WHERE key=?', String(key));
  }

  listPrefix(prefix) {
    const p = String(prefix).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const rows = this.db.all("SELECT key, value FROM meta WHERE key LIKE ? ESCAPE '\\' LIMIT 500", p);
    const out = [];
    for (const r of rows) {
      const val = this.decryptValue(r.key, r.value);
      if (val) out.push({ key: r.key, value: val });
    }
    return out;
  }

  /** Re-encrypt any legacy plaintext entries for listed keys in-place. */
  migrateKeys(keys = []) {
    for (const k of keys) {
      try {
        const row = this.db.get('SELECT value FROM meta WHERE key=?', k);
        if (!row || !row.value) continue;
        let already = false;
        if (row.value[0] === '{') {
          try { already = JSON.parse(row.value).__enc === 1; } catch { already = false; }
        }
        if (!already) this.set(k, row.value);
      } catch { /* best effort */ }
    }
  }
}

module.exports = { SensitiveStore, deriveMetaKey, maskEndpoint };
