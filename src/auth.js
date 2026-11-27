'use strict';
// Password hashing (scrypt), server-side sessions (random token, only its hash stored), CSRF and cookies.
const crypto = require('crypto');
const { HttpError, randomToken, sha256hex } = require('./util');
const { parseCookies, isAllowedOrigin } = require('./http');

const COOKIE = 'hub_session';
const DUMMY = { salt: crypto.randomBytes(16), hash: crypto.randomBytes(32) };

function hashPassword(pw, N = 16384) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32, { N, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${N}$8$1$${salt.toString('base64url')}$${h.toString('base64url')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored || '').split('$');
    if (alg !== 'scrypt') throw new Error('x');
    const exp = Buffer.from(hash, 'base64url');
    const got = crypto.scryptSync(pw, Buffer.from(salt, 'base64url'), exp.length, { N: +N, r: +r, p: +p, maxmem: 128 * 1024 * 1024 });
    return crypto.timingSafeEqual(got, exp);
  } catch {
    crypto.scryptSync(pw, DUMMY.salt, 32, { N: 16384, r: 8, p: 1 }); // equalize timing for unknown users
    return false;
  }
}

class Auth {
  constructor(db, cfg) { this.db = db; this.cfg = cfg; }
  isSecure(req) {
    if (this.cfg.cookieSecure === true) return true;
    if (this.cfg.cookieSecure === false) return false;
    if (req.socket.encrypted) return true;
    if (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https') return true;
    const ref = String(req.headers.origin || req.headers.referer || '');
    if (ref.startsWith('https://') && (!req.headers.origin || isAllowedOrigin(req, this.cfg))) return true;
    return false;
  }
  create(userId, now = Date.now()) {
    const token = randomToken(32); const csrf = randomToken(24);
    const ttl = this.cfg.sessionDays * 86400000;
    this.db.run('INSERT INTO sessions(id,user_id,csrf,created_at,expires_at) VALUES(?,?,?,?,?)', sha256hex(token), userId, csrf, now, now + ttl);
    return { token, csrf, ttl };
  }
  cookie(req, token, ttlMs) {
    const sec = this.isSecure(req);
    const ss = sec ? 'SameSite=None; Secure' : 'SameSite=Lax';
    return `${COOKIE}=${token}; Path=/; HttpOnly; ${ss}; Max-Age=${Math.floor(ttlMs / 1000)}`;
  }
  clearCookie(req) {
    const sec = this.isSecure(req);
    const ss = sec ? 'SameSite=None; Secure' : 'SameSite=Lax';
    return `${COOKIE}=; Path=/; HttpOnly; ${ss}; Max-Age=0`;
  }
  destroy(token) { this.db.run('DELETE FROM sessions WHERE id=?', sha256hex(token)); }
  destroyAllFor(userId) { this.db.run('DELETE FROM sessions WHERE user_id=?', userId); }
  lookup(req, now = Date.now()) {
    // Cookie first (HttpOnly); header fallback for Pi Browser / WebViews that drop cookies.
    let token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) {
      const h = String(req.headers['x-hub-session'] || req.headers['authorization'] || '');
      if (h.toLowerCase().startsWith('bearer ')) token = h.slice(7).trim();
      else if (h && !h.includes(' ')) token = h.trim();
    }
    if (!token && String(req.url || '').startsWith('/api/stream')) {
      try { token = new URL(req.url, 'http://local').searchParams.get('s') || ''; } catch { token = ''; }
    }
    if (!token || token.length > 100) return null;
    const s = this.db.get('SELECT * FROM sessions WHERE id=?', sha256hex(token));
    if (!s) return null;
    if (s.expires_at <= now) { this.db.run('DELETE FROM sessions WHERE id=?', s.id); return null; }
    const user = this.db.get("SELECT id, username, display_name, bio, avatar_media, account_id, pubkey, status, is_primary, lang FROM users WHERE id=? AND status='local'", s.user_id);
    if (!user) return null;
    if (now - s.created_at > 3600000 && s.expires_at - now < this.cfg.sessionDays * 86400000 - 3600000) {
      this.db.run('UPDATE sessions SET expires_at=? WHERE id=?', now + this.cfg.sessionDays * 86400000, s.id);
    }
    return { user, session: { id: s.id, csrf: s.csrf, token } };
  }
  _mediaKey() {
    if (this._mediaSecret) return this._mediaSecret;
    try {
      const row = this.db.get("SELECT value FROM meta WHERE key='media_hmac_secret'");
      if (row && row.value) {
        this._mediaSecret = Buffer.from(row.value, 'base64url');
        if (this._mediaSecret.length >= 16) return this._mediaSecret;
      }
      const k = crypto.randomBytes(32);
      this.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('media_hmac_secret',?)", k.toString('base64url'));
      this._mediaSecret = k;
      return k;
    } catch {
      this._mediaSecret = crypto.randomBytes(32);
      return this._mediaSecret;
    }
  }
  /** Mint an HMAC-signed, viewer-bound, hash-bound, short-lived token for <img>/<video>/<audio> requests. */
  signMediaToken(userId, hash, ttlMs = 12 * 3600000) {
    const exp = Date.now() + ttlMs;
    const msg = `media:${userId}:${hash}:${exp}`;
    const sig = crypto.createHmac('sha256', this._mediaKey()).update(msg).digest('base64url');
    return `${userId}.${exp}.${sig}`;
  }
  /** Verify scoped media token and return the active local user (still subject to live canViewMedia checks!). */
  verifyMediaToken(token, hash) {
    try {
      const parts = String(token || '').split('.');
      if (parts.length !== 3) return null;
      const uid = Number(parts[0]);
      const exp = Number(parts[1]);
      if (!Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(exp) || exp < Date.now()) return null;
      const expected = crypto.createHmac('sha256', this._mediaKey()).update(`media:${uid}:${hash}:${exp}`).digest();
      const got = Buffer.from(parts[2], 'base64url');
      if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
      return this.db.get("SELECT id, username, display_name, bio, avatar_media, account_id, pubkey, status, is_primary, lang FROM users WHERE id=? AND status='local'", uid) || null;
    } catch {
      return null;
    }
  }
  installHooks(app) {
    app.hooks.auth = async (ctx, o) => {
      const found = this.lookup(ctx.req);
      if (found) { ctx.user = found.user; ctx.session = found.session; }
      const need = o.auth;
      if (need === 'user' || need === 'owner') {
        if (!ctx.user) throw new HttpError(401, 'E_AUTH', 'Authentication required');
        if (need === 'owner' && !ctx.user.is_primary) throw new HttpError(403, 'E_FORBIDDEN', 'Only the Hub owner can do this');
      }
    };
    app.hooks.csrf = (ctx) => {
      const h = String(ctx.req.headers['x-csrf-token'] || '');
      const a = Buffer.from(h); const b = Buffer.from(ctx.session.csrf);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(403, 'E_CSRF', 'Missing or invalid CSRF token');
      if (ctx.req.headers.origin && !isAllowedOrigin(ctx.req, this.cfg)) throw new HttpError(403, 'E_CSRF', 'Cross-origin request refused');
    };
  }
}
module.exports = { Auth, hashPassword, verifyPassword, COOKIE };
