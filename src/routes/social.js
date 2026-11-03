'use strict';
const { HttpError } = require('../util');
const { isAccountId } = require('../keystore');

module.exports = function register(hub) {
  const { app, db, social } = hub;
  const intId = (v) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, 'E_INVALID', 'Invalid id'); return n; };
  const q = (ctx) => ({ cursor: ctx.query.cursor, limit: ctx.query.limit, replies: ctx.query.replies === '1' });

  // ---- feeds (stable opaque cursors; items ordered by sort_ts,id) ----
  app.get('/api/feed/home', { auth: 'user' }, (ctx) => social.homeFeed(ctx.user, q(ctx)));
  app.get('/api/feed/public', {}, (ctx) => social.publicFeed(ctx.user, q(ctx))); // public posts only; no auth required
  app.get('/api/profiles/:handle', {}, (ctx) => social.profile(ctx.user, ctx.params.handle));
  app.get('/api/profiles/:handle/posts', {}, (ctx) => {
    const p = social.profile(ctx.user, ctx.params.handle);
    return social.profileFeed(ctx.user, p.id, q(ctx));
  });
  app.get('/api/profiles/:handle/followers', {}, (ctx) => { const p = social.profile(ctx.user, ctx.params.handle); return { items: p.account_id ? social.followList(p.account_id, 'followers') : [] }; });
  app.get('/api/profiles/:handle/following', {}, (ctx) => { const p = social.profile(ctx.user, ctx.params.handle); return { items: p.account_id ? social.followList(p.account_id, 'following') : [] }; });

  // ---- posts ----
  app.post('/api/posts', { auth: 'user', limit: 'write' }, (ctx) => {
    const b = ctx.body;
    if (b.user_id !== undefined && Number(b.user_id) !== ctx.user.id) throw new HttpError(403, 'E_USER_MISMATCH', 'user_id does not match the authenticated user');
    const out = social.createPost(ctx.user, b);
    ctx.res.statusCode = out.duplicate ? 200 : 201;
    return out;
  });
  app.get('/api/posts/:id', {}, (ctx) => social.getPost(ctx.user, intId(ctx.params.id)));
  app.get('/api/posts/:id/thread', {}, (ctx) => social.thread(ctx.user, intId(ctx.params.id), q(ctx)));
  app.patch('/api/posts/:id', { auth: 'user', limit: 'write' }, (ctx) => social.editPost(ctx.user, intId(ctx.params.id), ctx.body));
  app.delete('/api/posts/:id', { auth: 'user', limit: 'write' }, (ctx) => social.deletePost(ctx.user, intId(ctx.params.id)));
  app.put('/api/posts/:id/reaction', { auth: 'user', limit: 'write' }, (ctx) => social.react(ctx.user, intId(ctx.params.id), ctx.body.type, true));
  app.delete('/api/posts/:id/reaction', { auth: 'user', limit: 'write' }, (ctx) => social.react(ctx.user, intId(ctx.params.id), 'like', false));

  // ---- follows (friends = mutual follows) ----
  app.post('/api/follow', { auth: 'user', limit: 'write' }, (ctx) => social.setFollow(ctx.user, String(ctx.body.account_id || ''), true));
  app.delete('/api/follow', { auth: 'user', limit: 'write' }, (ctx) => social.setFollow(ctx.user, String(ctx.body.account_id || ctx.query.account_id || ''), false));

  // ---- local-only features (never federated) ----
  app.get('/api/bookmarks', { auth: 'user' }, (ctx) => social.bookmarks(ctx.user, q(ctx)));
  app.post('/api/bookmarks/:id', { auth: 'user', limit: 'write' }, (ctx) => {
    const id = intId(ctx.params.id); social.getPost(ctx.user, id);
    db.run('INSERT OR IGNORE INTO bookmarks(user_id,post_id,created_at) VALUES(?,?,?)', ctx.user.id, id, Date.now()); return { bookmarked: true };
  });
  app.delete('/api/bookmarks/:id', { auth: 'user', limit: 'write' }, (ctx) => { db.run('DELETE FROM bookmarks WHERE user_id=? AND post_id=?', ctx.user.id, intId(ctx.params.id)); return { bookmarked: false }; });

  for (const [name, table] of [['blocks', 'blocks'], ['mutes', 'mutes']]) {
    app.get(`/api/${name}`, { auth: 'user' }, (ctx) => ({ items: db.all(`SELECT t.account_id, u.username, u.display_name FROM ${table} t LEFT JOIN users u ON u.account_id=t.account_id WHERE t.user_id=? ORDER BY t.created_at DESC LIMIT 500`, ctx.user.id) }));
    app.post(`/api/${name}`, { auth: 'user', limit: 'write' }, (ctx) => {
      const a = String(ctx.body.account_id || '');
      if (!isAccountId(a) || a === ctx.user.account_id) throw new HttpError(400, 'E_INVALID', 'Invalid account id');
      db.run(`INSERT OR IGNORE INTO ${table}(user_id,account_id,created_at) VALUES(?,?,?)`, ctx.user.id, a, Date.now());
      if (name === 'blocks' && social.db.get('SELECT 1 x FROM follows WHERE follower=? AND followee=?', ctx.user.account_id, a)) social.setFollow(ctx.user, a, false);
      return { ok: true };
    });
    app.delete(`/api/${name}`, { auth: 'user', limit: 'write' }, (ctx) => { db.run(`DELETE FROM ${table} WHERE user_id=? AND account_id=?`, ctx.user.id, String(ctx.body.account_id || ctx.query.account_id || '')); return { ok: true }; });
  }

  app.post('/api/reports', { auth: 'user', limit: 'write' }, (ctx) => {
    const b = ctx.body; const reason = String(b.reason || '').slice(0, 500);
    if (b.post_id !== undefined) social.getPost(ctx.user, intId(b.post_id));
    else if (!isAccountId(b.account_id)) throw new HttpError(400, 'E_INVALID', 'post_id or account_id required');
    db.run('INSERT INTO reports(reporter_id,post_id,account_id,reason,created_at) VALUES(?,?,?,?,?)', ctx.user.id, b.post_id ? intId(b.post_id) : null, b.account_id || null, reason, Date.now());
    return { ok: true };
  });

  app.get('/api/notifications', { auth: 'user' }, (ctx) => social.notifications(ctx.user, ctx.query));
  app.post('/api/notifications/read', { auth: 'user' }, (ctx) => { db.run('UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL', Date.now(), ctx.user.id); return { ok: true }; });


  // ---- link preview (SSRF-safe) ----
  app.get('/api/unfurl', { auth: 'user', limit: 'write' }, async (ctx) => {
    const { unfurl, firstHttpUrl } = require('../net/unfurl');
    const raw = String(ctx.query.url || ctx.query.u || '').trim().slice(0, 500);
    const url = raw || firstHttpUrl(String(ctx.query.text || ''));
    if (!url || !/^https?:\/\//i.test(url)) throw new HttpError(400, 'E_INVALID', 'url required');
    try {
      return await unfurl(url);
    } catch (e) {
      const code = e.code || 'unfurl_failed';
      const map = {
        private_address: [400, 'E_UNFURL_PRIVATE', 'URL points to a private address'],
        bad_scheme: [400, 'E_INVALID', 'Only http(s) URLs are allowed'],
        credentials: [400, 'E_INVALID', 'URL must not contain credentials'],
        dns: [400, 'E_UNFURL_DNS', 'Could not resolve host'],
        timeout: [504, 'E_UNFURL_TIMEOUT', 'Preview timed out'],
        too_large: [400, 'E_UNFURL_LARGE', 'Response too large'],
        redirects: [400, 'E_UNFURL_REDIRECT', 'Too many or invalid redirects'],
        http: [502, 'E_UNFURL_HTTP', 'Remote host error'],
      };
      const m = map[code] || [502, 'E_UNFURL', 'Could not fetch preview'];
      throw new HttpError(m[0], m[1], m[2]);
    }
  });

  app.get('/api/search', { limit: 'write' }, (ctx) => social.search(ctx.user, ctx.query.q, ctx.query.type));
  app.get('/api/trends', {}, () => ({ tags: social.trends() }));
};
