'use strict';
// Password hashing (scrypt), server-side sessions (random token, only its hash stored), CSRF and cookies.
const crypto = require('crypto');
const { HttpError, randomToken, sha256hex } = require('./util');
const { parseCookies } = require('./http');

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
    return !!req.socket.encrypted || (this.cfg.trustProxy > 0 && req.headers['x-forwarded-proto'] === 'https');
  }
  create(userId, now = Date.now()) {
    const token = randomToken(32); const csrf = randomToken(24);
    const ttl = this.cfg.sessionDays * 86400000;
    this.db.run('INSERT INTO sessions(id,user_id,csrf,created_at,expires_at) VALUES(?,?,?,?,?)', sha256hex(token), userId, csrf, now, now + ttl);
    return { token, csrf, ttl };
  }
  cookie(req, token, ttlMs) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}${this.isSecure(req) ? '; Secure' : ''}`;
  }
  clearCookie(req) { return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.isSecure(req) ? '; Secure' : ''}`; }
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
      const origin = ctx.req.headers.origin;
      if (origin) { let host; try { host = new URL(origin).host; } catch { host = ''; } if (host !== ctx.req.headers.host) throw new HttpError(403, 'E_CSRF', 'Cross-origin request refused'); }
    };
  }
}
module.exports = { Auth, hashPassword, verifyPassword, COOKIE };
