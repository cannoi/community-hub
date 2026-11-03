'use strict';
// Global Presence API. Browser-facing: /api/presence/*  — directory-facing (only when PRESENCE_SERVE=true): /presence/v1/*
const { HttpError } = require('../util');
const { isAccountId } = require('../keystore');
const { Directory } = require('../presence/directory');
const { mountDirectoryRoutes } = require('../presence/routes');

module.exports = function register(hub) {
  const { app, db, cfg, presence, remote, peers, limiter } = hub;

  // ---- optional seed role: a tiny directory (register / heartbeat / resolve / search). Disabled by default. ----
  if (cfg.presence.serve) {
    hub.directory = new Directory(db, { maxEntries: cfg.presence.maxEntries, onlineMs: cfg.presence.onlineMs, retainMs: cfg.presence.retainMs, allowPrivate: cfg.allowPrivatePeers });
    mountDirectoryRoutes(app, { directory: hub.directory, limiter, cfg, version: hub.version });
    const t = setInterval(() => { try { hub.directory.prune(); } catch { /* ignore */ } }, 3600000); t.unref(); hub.timers.push(t);
  }
  const t2 = setInterval(() => { try { remote.purgeExpired(); } catch { /* ignore */ } }, 3600000); t2.unref(); hub.timers.push(t2);

  const needDirectory = () => { if (!presence.seeds().length) throw new HttpError(503, 'E_PRESENCE_LOCAL_ONLY', 'No directory is configured for this Hub'); };
  const wrapDir = async (fn) => { try { return await fn(); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(502, 'E_PRESENCE_UNAVAILABLE', 'Directory unavailable'); } };

  app.get('/api/presence/status', { auth: 'user' }, () => presence.status());

  app.patch('/api/presence/settings', { auth: 'owner', limit: 'write' }, (ctx) => {
    const b = ctx.body || {}; const patch = {};
    for (const k of ['enabled', 'searchable', 'share_endpoint']) if (b[k] !== undefined) { if (typeof b[k] !== 'boolean') throw new HttpError(400, 'E_INVALID', k + ' must be boolean'); patch[k] = b[k]; }
    if (b.region !== undefined) { const r = String(b.region || '').toUpperCase(); if (r && !/^[A-Z]{2}$/.test(r)) throw new HttpError(400, 'E_INVALID', 'region must be a 2-letter code'); patch.region = r; }
    if (b.content_sync !== undefined) { try { peers.setContentMode(b.content_sync); } catch { throw new HttpError(400, 'E_INVALID', "content_sync must be 'off' or 'trusted'"); } }
    if (Object.keys(patch).length) presence.setSettings(patch);
    return presence.status();
  });

  // Find people on the network (directory lookup only: names/ids/online — no content, no addresses).
  app.get('/api/presence/search', { auth: 'user', limit: 'presence' }, (ctx) => wrapDir(async () => {
    const q = String(ctx.query.q || '').trim();
    if (isAccountId(q)) { // a pasted account id resolves directly
      needDirectory(); const r = await presence.resolve(q);
      return { items: r ? [{ account_id: q, name: r.record.name, region: r.record.region || null, online: r.online, last_seen: r.last_seen, reachable: !!r.record.endpoint }] : [] };
    }
    if (q.length < 2 || q.length > 40) throw new HttpError(400, 'E_INVALID', 'q must be 2-40 characters');
    needDirectory();
    return { items: await presence.search(q) };
  }));

  app.get('/api/presence/resolve', { auth: 'user', limit: 'presence' }, (ctx) => wrapDir(async () => {
    const a = String(ctx.query.account || '');
    if (!isAccountId(a)) throw new HttpError(400, 'E_INVALID', 'account required');
    needDirectory();
    const r = await presence.resolve(a, { fresh: ctx.query.fresh === '1' });
    if (!r) throw new HttpError(404, 'E_REMOTE_UNKNOWN', 'Not found in the directory');
    return { account_id: a, name: r.record.name, region: r.record.region || null, online: r.online, last_seen: r.last_seen, reachable: !!r.record.endpoint }; // never the address
  }));

  // Open a remote profile ON DEMAND (small signed snapshot, cached briefly, never stored as your Hub's data).
  app.get('/api/presence/profile/:account', { auth: 'user', limit: 'presence' }, (ctx) => wrapDir(async () => {
    const view = await remote.open(ctx.params.account, { force: ctx.query.refresh === '1' });
    const dir = presence.cache.get(ctx.params.account)?.val;
    return { ...view, directory: dir ? { name: dir.record.name, region: dir.record.region || null, online: dir.online, last_seen: dir.last_seen } : null };
  }));
  app.delete('/api/presence/profile/:account', { auth: 'user', limit: 'write' }, (ctx) => { if (!isAccountId(ctx.params.account)) throw new HttpError(400, 'E_INVALID', 'bad account'); remote.forget(ctx.params.account); return { ok: true }; });
};
