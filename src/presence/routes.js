'use strict';
// HTTP surface of a directory seed: /presence/v1/{register,heartbeat,withdraw,resolve,search,info}.
// Deliberately tiny: small bodies only, no media, no feeds, no federation content endpoints.
const { HttpError } = require('../util');
const { isAccountId } = require('../keystore');
const { PresenceError } = require('./record');

function mountDirectoryRoutes(app, { directory, limiter, cfg, version = '' }) {
  const wrap = (fn) => (ctx) => {
    try { return fn(ctx); } catch (e) {
      if (e instanceof PresenceError) throw new HttpError(e.status, e.code, e.message);
      throw e;
    }
  };
  const O = (extra = {}) => ({ limit: 'presence', auth: 'none', csrf: false, ...extra });
  const tooMany = (ctx, wait) => { ctx.res.setHeader('Retry-After', wait); throw new HttpError(429, 'E_RATE_LIMIT', 'Too many requests'); };

  app.post('/presence/v1/register', O({ maxBytes: 2048 }), wrap((ctx) => {
    const b = ctx.body || {};
    const acct = isAccountId(b.account_id) ? b.account_id : '';
    if (acct) { const w = limiter.check('presence:acct:' + acct, 6, 60000); if (w) tooMany(ctx, w); }
    if (acct && !directory.has(acct)) { const w = limiter.check('presence:newip:' + ctx.ip, 30, 3600000); if (w) tooMany(ctx, w); } // new identities per IP per hour
    return { ok: true, ...directory.register(b) };
  }));
  app.post('/presence/v1/heartbeat', O({ maxBytes: 512 }), wrap((ctx) => {
    const b = ctx.body || {};
    if (isAccountId(b.account_id)) { const w = limiter.check('presence:hb:' + b.account_id, 12, 60000); if (w) tooMany(ctx, w); }
    return { ok: true, ...directory.heartbeat(b) };
  }));
  app.post('/presence/v1/withdraw', O({ maxBytes: 512 }), wrap((ctx) => ({ ok: true, ...directory.withdraw(ctx.body || {}) })));
  app.get('/presence/v1/resolve', O(), wrap((ctx) => {
    const a = String(ctx.query.account || '');
    if (!isAccountId(a)) throw new HttpError(400, 'E_PRESENCE_INVALID', 'account required');
    const r = directory.resolve(a);
    if (!r) throw new HttpError(404, 'E_PRESENCE_UNKNOWN', 'not found');
    return r;
  }));
  app.get('/presence/v1/search', O(), wrap((ctx) => {
    const q = String(ctx.query.q || '');
    if (q.trim().length < 2 || q.length > 40) throw new HttpError(400, 'E_PRESENCE_INVALID', 'q must be 2-40 characters');
    return { items: directory.search(q, Number(ctx.query.limit) || 20) };
  }));
  app.get('/presence/v1/info', O(), () => ({ role: 'presence-seed', protocol: 1, version, entries: directory.count() }));
}
module.exports = { mountDirectoryRoutes };
