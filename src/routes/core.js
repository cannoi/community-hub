'use strict';
const { HttpError } = require('../util');
const { hashPassword, verifyPassword } = require('../auth');
const { toIso } = require('../social');
const { resolveAccessInfo, rememberPublicPort } = require('../net/access-info');

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,30}$/;

module.exports = function register(hub) {
  const { app, db, cfg, auth, ks, ledger, social, media, peers, limiter, bus } = hub;

  const me = (u) => u && { id: u.id, username: u.username, display_name: u.display_name || null, bio: u.bio || null, account_id: u.account_id, is_primary: !!u.is_primary, lang: u.lang || null, avatar_url: u.avatar_media ? `/media/${u.avatar_media}` : null };
  const primary = () => db.get('SELECT id FROM users WHERE is_primary=1 AND account_id IS NOT NULL');
  const features = () => ({
    federation: peers.enabled, public_url: cfg.publicUrl || null, registration: cfg.allowRegistration,
    ai: !!(cfg.ai.baseUrl && cfg.ai.model), dm: false, max_upload_mb: Math.round(cfg.maxUploadBytes / 1048576), max_post_chars: cfg.maxPostChars,
  });
  function checkCreds(username, password) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) throw new HttpError(400, 'E_BAD_USERNAME', 'Username must be 3-30 letters, digits, dot, dash or underscore');
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new HttpError(400, 'E_WEAK_PASSWORD', 'Password must be 8-200 characters');
  }
  function startSession(ctx, userId) {
    const s = auth.create(userId);
    ctx.res.setHeader('Set-Cookie', auth.cookie(ctx.req, s.token, s.ttl));
    return s.csrf;
  }

  app.get('/health', { auth: 'none' }, () => {
    try { db.get('SELECT 1 x'); } catch { throw new HttpError(503, 'E_DB', 'database unavailable'); }
    return { status: 'ok', timestamp: new Date().toISOString(), version: hub.version, uptime_s: Math.round((Date.now() - hub.startedAt) / 1000) };
  });

  app.get('/api/session', {}, (ctx) => {
    const setup = !primary();
    const out = { setup_required: setup, setup_token_required: !!cfg.setupToken, registration_allowed: cfg.allowRegistration && !setup, user: me(ctx.user), csrf: ctx.session ? ctx.session.csrf : null, features: features(), version: hub.version };
    if (setup) out.legacy_users = db.all("SELECT id, username FROM users WHERE status='legacy' ORDER BY id LIMIT 200");
    // Global Presence: the Hub joins the network automatically (see src/presence). There is no onboarding step to
    // "connect to a Hub" any more; the flag is kept (always false) so older clients keep working.
    out.network_setup_required = false;
    out.presence = hub.presence ? hub.presence.status() : null;
    out.network = hub.net ? hub.net.status() : { kind: 'https', enabled: true };
    return out;
  });

  // Public link — owner only (SEC-02). No third-party IP lookup; no header-poisoned global port.
  app.get('/api/remote/info', { auth: 'owner' }, async (ctx) => {
    const ov = db.get("SELECT value FROM meta WHERE key='public_url_override'")?.value || '';
    const info = await resolveAccessInfo(ctx.req, {
      ownerOverride: ov,
      includeLan: true,
      trustRequestHost: !!cfg.trustProxy,
    });
    return {
      ok: !!info.publicUrl,
      publicUrl: info.publicUrl || '',
      publicIp: info.publicIp || '',
      hostPort: info.hostPort,
      source: info.source,
      lanUrls: info.lanUrls || [],
    };
  });

  // --- first-time initialisation: creates THE default identity of this Hub ---
  app.post('/api/setup', { limit: 'login', csrf: false, auth: 'none' }, async (ctx) => {
    const b = ctx.body;
    if (primary()) throw new HttpError(409, 'E_ALREADY_SETUP', 'This Hub is already initialised');
    if (cfg.setupToken && b.setup_token !== cfg.setupToken) throw new HttpError(403, 'E_SETUP_TOKEN', 'Invalid setup token');
    checkCreds(b.username, b.password);
    const claim = b.claim_legacy_user_id !== undefined && b.claim_legacy_user_id !== null && b.claim_legacy_user_id !== '' ? Number(b.claim_legacy_user_id) : null;
    const res = db.tx(() => {
      let key;
      try { key = b.import ? ks.importKey(b.import.blob, String(b.import.passphrase || '')) : ks.generate(); } catch (e) { throw new HttpError(400, 'E_KEY_IMPORT', e.message); }
      const hash = hashPassword(b.password, cfg.scryptN);
      const disp = typeof b.display_name === 'string' && b.display_name.trim() ? b.display_name.trim().slice(0, 50) : null;
      let id;
      if (claim) { // explicit, owner-confirmed claim of an existing legacy profile — never automatic
        const l = db.get("SELECT id, username FROM users WHERE id=? AND status='legacy' AND account_id IS NULL", claim);
        if (!l) throw new HttpError(404, 'E_NOT_FOUND', 'Legacy profile not found or already claimed');
        if (l.username.toLowerCase() !== b.username.toLowerCase() && db.get('SELECT 1 x FROM users WHERE username=? COLLATE NOCASE', b.username)) throw new HttpError(409, 'E_USERNAME_TAKEN', 'Username taken');
        db.run("UPDATE users SET username=?, account_id=?, pubkey=?, status='local', is_primary=1, password_hash=?, display_name=COALESCE(?,display_name) WHERE id=?", b.username, key.accountId, key.pub, hash, disp, claim);
        id = claim;
      } else {
        if (db.get('SELECT 1 x FROM users WHERE username=? COLLATE NOCASE', b.username)) throw new HttpError(409, 'E_USERNAME_TAKEN', 'Username taken');
        id = Number(db.run("INSERT INTO users(username,avatar,account_id,pubkey,status,is_primary,password_hash,display_name) VALUES(?,?,?,?, 'local',1,?,?)", b.username, '', key.accountId, key.pub, hash, disp).lastInsertRowid);
      }
      if (b.import) db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('history_pending','1')");
      return { id, key };
    });
    const user = db.get('SELECT * FROM users WHERE id=?', res.id);
    if (!b.import) {
      try { ledger.publish(user.account_id, 'profile.update', { display_name: user.display_name || user.username }); } catch (e) { hub.log.warn('initial profile event failed: ' + e.code); }
      peers.announceEndpoint();
    }
    const csrf = startSession(ctx, user.id);
    hub.log.info(`Hub identity created: ${user.account_id}`);
    // Network connection step (all optional, changeable later in Settings / Network).
    // Default suggested peer: http://14.176.78.46:28090 — user may clear or replace with invite.
    const DEFAULT_INTRO = 'http://14.176.78.46:28090';
    let public_address = cfg.publicUrl || '';
    try {
      const info = await resolveAccessInfo(ctx.req);
      if (info.publicUrl) public_address = info.publicUrl;
    } catch (_) { /* best-effort */ }

    // Network connection is a separate onboarding step (network_setup_required).
    // Do not consume intro_hub here so Step 1 stays account-only.
    return { user: me(user), csrf, account_id: user.account_id, imported: !!b.import, public_address };
  });

  app.post('/api/login', { limit: 'login', csrf: false, auth: 'none' }, (ctx) => {
    const { username, password } = ctx.body;
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 60 || password.length > 200) throw new HttpError(400, 'E_INVALID', 'username and password required');
    const wait = limiter.check('loginuser:' + username.toLowerCase(), 10, 10 * 60000);
    if (wait) { ctx.res.setHeader('Retry-After', wait); throw new HttpError(429, 'E_RATE_LIMIT', 'Too many attempts, try again later'); }
    const u = db.get("SELECT * FROM users WHERE username=? COLLATE NOCASE AND status='local'", username);
    if (!verifyPassword(password, u && u.password_hash) || !u) throw new HttpError(401, 'E_BAD_CREDENTIALS', 'Wrong username or password');
    const csrf = startSession(ctx, u.id);
    return { user: me(u), csrf };
  });

  app.post('/api/logout', { auth: 'user' }, (ctx) => {
    auth.destroy(ctx.session.token);
    ctx.res.setHeader('Set-Cookie', auth.clearCookie(ctx.req));
    return { ok: true };
  });

  app.post('/api/register', { limit: 'login', csrf: false, auth: 'none' }, (ctx) => registerUser(ctx));
  function registerUser(ctx) {
    if (!primary()) throw new HttpError(409, 'E_NOT_SETUP', 'Initialise the Hub first');
    if (!cfg.allowRegistration) throw new HttpError(403, 'E_REGISTRATION_DISABLED', 'This Hub has a single owner account; registration is disabled');
    const b = ctx.body; checkCreds(b.username, b.password);
    if (db.get('SELECT 1 x FROM users WHERE username=? COLLATE NOCASE', b.username)) throw new HttpError(409, 'E_USERNAME_TAKEN', 'Username taken');
    const key = ks.generate();
    const disp = typeof b.display_name === 'string' && b.display_name.trim() ? b.display_name.trim().slice(0, 50) : null;
    const id = Number(db.run("INSERT INTO users(username,avatar,account_id,pubkey,status,is_primary,password_hash,display_name) VALUES(?,?,?,?, 'local',0,?,?)", b.username, '', key.accountId, key.pub, hashPassword(b.password, cfg.scryptN), disp).lastInsertRowid);
    try { ledger.publish(key.accountId, 'profile.update', { display_name: disp || b.username }); } catch { /* non-fatal */ }
    const csrf = startSession(ctx, id);
    return { user: me(db.get('SELECT * FROM users WHERE id=?', id)), csrf };
  }
  hub.registerUser = registerUser;

  app.get('/api/me', { auth: 'user' }, (ctx) => ({ user: me(ctx.user), csrf: ctx.session.csrf }));
  app.patch('/api/me', { auth: 'user' }, (ctx) => {
    const b = ctx.body; const u = ctx.user; const ev = {};
    if (b.display_name !== undefined) { const v = String(b.display_name).trim().slice(0, 50); if (!v) throw new HttpError(400, 'E_INVALID', 'display_name required'); ev.display_name = v; }
    if (b.bio !== undefined) ev.bio = String(b.bio).slice(0, 300);
    if (b.avatar !== undefined) {
      if (b.avatar === null) ev.avatar = null;
      else { const m = media.assertOwned([String(b.avatar)], u.id)[0]; if (!m.mime.startsWith('image/')) throw new HttpError(400, 'E_BAD_MEDIA', 'Avatar must be an image'); ev.avatar = m.hash; }
    }
    if (b.lang !== undefined) { if (!['en', 'vi'].includes(b.lang)) throw new HttpError(400, 'E_INVALID', 'lang must be en or vi'); db.run('UPDATE users SET lang=? WHERE id=?', b.lang, u.id); }
    if (Object.keys(ev).length) {
      if (ev.avatar === null) { db.run('UPDATE users SET avatar_media=NULL WHERE id=?', u.id); delete ev.avatar; }
      if (Object.keys(ev).length) { try { ledger.publish(u.account_id, 'profile.update', ev); } catch (e) { throw new HttpError(400, 'E_PUBLISH', 'Could not publish profile'); } bus.emit('local-publish'); }
    }
    return { user: me(db.get('SELECT * FROM users WHERE id=?', u.id)) };
  });
  app.post('/api/me/password', { auth: 'user', limit: 'login' }, (ctx) => {
    const { current, next } = ctx.body;
    const u = db.get('SELECT password_hash FROM users WHERE id=?', ctx.user.id);
    if (!verifyPassword(String(current || ''), u.password_hash)) throw new HttpError(403, 'E_BAD_CREDENTIALS', 'Current password is wrong');
    checkCreds(ctx.user.username, next);
    db.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(next, cfg.scryptN), ctx.user.id);
    db.run('DELETE FROM sessions WHERE user_id=? AND id<>?', ctx.user.id, ctx.session.id); // other sessions are revoked
    return { ok: true };
  });

  // --- Network prefs (owner): intro peer, optional public-URL password, public URL override ---
  app.get('/api/network/settings', { auth: 'owner' }, async (ctx) => {
    const intro = db.get("SELECT value FROM meta WHERE key='intro_peer'")?.value || '';
    const publicOverride = db.get("SELECT value FROM meta WHERE key='public_url_override'")?.value || '';
    let remote = { publicUrl: '', publicIp: '', hostPort: null };
    try {
      remote = await resolveAccessInfo(ctx.req, { ownerOverride: publicOverride, includeLan: true, trustRequestHost: !!cfg.trustProxy });
    } catch (_) {}
    return {
      intro_peer: (intro === 'http://14.176.78.46:28090' || intro === 'default') ? 'default' : intro,
      public_url_override: publicOverride,
      public_url: publicOverride || remote.publicUrl || cfg.publicUrl || '',
      remote,
      default_intro: 'default',
    };
  });

  app.post('/api/network/settings', { auth: 'owner', limit: 'write' }, async (ctx) => {
    const b = ctx.body || {};
    const { validateEndpoint } = require('../federation/transport');
const { normalizePeerInput, createInvite, parseInvite } = require('../federation/invite');

    if (b.intro_peer !== undefined) {
      let v = String(b.intro_peer || '').trim();
      if (!v) {
        db.run("DELETE FROM meta WHERE key='intro_peer'");
      } else if (v.toLowerCase() === 'default') {
        v = require('../net/seed-defaults').resolveDefaultSeed(cfg);
        if (!v) throw new HttpError(400, 'E_NO_SEED', 'No directory seed is configured (PRESENCE_SEEDS)');
        db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('intro_peer',?)", v);
        try { peers.add(v, { state: 'bootstrap', name: 'settings-intro' }); } catch (e) {
          if (e.code !== 'self' && e.code !== 'exists') hub.log.warn('intro peer add: ' + (e.code || e.message));
        }
      } else {
        // NET-04: reject bad schemes / garbage early; never store invalid
        try {
          const pinMatch = /^(hub1_[a-z2-7]{52})@(.+)$/.exec(v);
          const urlPart = pinMatch ? pinMatch[2] : v;
          validateEndpoint(urlPart, { allowPrivate: cfg.allowPrivatePeers });
          db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('intro_peer',?)", v);
          try { peers.add(v, { state: 'bootstrap', name: 'settings-intro' }); } catch (e) {
            if (e.code === 'self') throw new HttpError(400, 'E_PEER_SELF', 'Cannot add this Hub as a peer of itself');
            if (e.code === 'too_many_peers') throw new HttpError(400, 'E_PEER_LIMIT', 'Too many peers');
            if (e.code !== 'exists') hub.log.warn('intro peer add: ' + (e.code || e.message));
          }
        } catch (e) {
          if (e instanceof HttpError) throw e;
          const code = e.code || 'bad_url';
          const map = {
            bad_url: ['E_PEER_BAD_URL', 'Invalid peer URL'],
            https_required: ['E_PEER_HTTPS_REQUIRED', 'HTTPS required for this peer address'],
            private_address: ['E_PEER_PRIVATE_ADDRESS', 'Private or loopback addresses are not allowed'],
          };
          const m = map[code] || ['E_PEER_BAD_URL', 'Invalid peer URL'];
          throw new HttpError(400, m[0], m[1]);
        }
      }
    }
    
    if (b.invite_password !== undefined) {
      const pw = String(b.invite_password || '');
      if (!pw) db.run("DELETE FROM meta WHERE key='invite_password_hash'");
      else {
        const hash = require('crypto').createHash('sha256').update('invite-pw:' + pw).digest('hex');
        db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('invite_password_hash',?)", hash);
      }
    }
if (b.network_setup_done || b.intro_peer !== undefined || b.skip_network) {
      db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('network_setup_done','1')");
    }
    if (b.public_url_override !== undefined) {
      const v = String(b.public_url_override || '').trim().replace(/\/+$/, '');
      if (!v) db.run("DELETE FROM meta WHERE key='public_url_override'");
      else {
        try {
          const u = new URL(v);
          if (!/^https?:$/i.test(u.protocol)) throw new Error('bad');
        } catch {
          throw new HttpError(400, 'E_INVALID', 'Invalid public URL');
        }
        db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('public_url_override',?)", v);
        // NET-02: also drive federation self endpoint via cfg when possible
        try { cfg.publicUrl = v; } catch (_) {}
      }
    }
    // SEC-01: remove fake password fields — no-op if client still sends them
    return { ok: true };
  });

  // --- server-sent events: a content-free "something changed" nudge for real-time UI refresh ---
  app.get('/api/stream', { auth: 'user' }, (ctx) => {
    if (hub.sse.size >= 100) throw new HttpError(503, 'E_BUSY', 'Too many live connections');
    const { res } = ctx;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\nevent: hello\ndata: {}\n\n');
    hub.sse.add(res);
    let t = null;
    const nudge = () => { if (t) return; t = setTimeout(() => { t = null; try { res.write('event: update\ndata: {}\n\n'); } catch { /* closed */ } }, 300); };
    bus.on('events', nudge); bus.on('local-publish', nudge);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 25000);
    res.on('close', () => { clearInterval(hb); if (t) clearTimeout(t); bus.off('events', nudge); bus.off('local-publish', nudge); hub.sse.delete(res); });
  });
};
