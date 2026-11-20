'use strict';
// Server side of the peer protocol (/federation/v1/*). Authentication = signed requests, never cookies/IP.
const { HttpError } = require('../util');
const { PROTOCOL, signHello, RequestVerifier } = require('../federation/protocol');
const { validateEndpoint } = require('../federation/transport');
const { isAccountId } = require('../keystore');
const { serveFile } = require('../http');
const { isInline } = require('../media');

module.exports = function register(hub) {
  const { app, db, cfg, ledger, ks, media, peers, limiter } = hub;
  let verifier = null; let verifierFor = null;
  const V = () => { const s = peers.self(); if (!s) throw new HttpError(503, 'E_NOT_READY', 'Hub is not initialised yet'); if (verifierFor !== s.account) { verifier = new RequestVerifier(s.account); verifierFor = s.account; } return verifier; };
  const on = () => { if (!cfg.federationEnabled) throw new HttpError(404, 'E_NOT_FOUND', 'Federation disabled'); };

  /** Authenticate a peer request; applies per-peer limits, block list, allow-list mode and safe auto-introduction. */
  function peerAuth(ctx) {
    on();
    const id = V().verify(ctx.req, ctx.rawBody || '');
    const wait = limiter.check('fed:' + id.account, cfg.rateLimit.federation);
    if (wait) { ctx.res.setHeader('Retry-After', wait); throw new HttpError(429, 'E_RATE_LIMIT', 'Too many requests'); }
    let row = peers.byAccount(id.account);
    if ((row && row.state === 'blocked') || ledger.isBlocked(id.account)) throw new HttpError(403, 'E_PEER_BLOCKED', 'Peer not permitted');
    if (row && id.endpoint && cfg.federationMode === 'open') { // known peer announces another endpoint: candidate only, verified by hello before use
      try { peers.addEndpointCandidate(row, id.endpoint); } catch { /* invalid/full/duplicate */ }
    }
    if (!row && id.endpoint) { // peer introduces itself; we verify it by challenge when we sync with it (hello), so claims cannot impersonate
      try { if (cfg.federationMode === 'open') row = peers.addContact(id.account, id.endpoint); } catch { /* invalid/full */ } // contact only: never synced unless the owner opts in
    }
    if (cfg.federationMode === 'allowlist' && !row) throw new HttpError(403, 'E_PEER_UNKNOWN', 'Peer not permitted');
    return { ...id, row };
  }

  /** Bulk content endpoints (event feeds, inbox) are only for peers the owner explicitly opted in for content sync. */
  function requireContentSync(id) {
    // Public content sync: global mode only — no mutual per-peer consent (joining the network = share public posts).
    if (peers.contentMode() !== 'trusted') throw new HttpError(403, 'E_NOT_SYNC', 'Content sync is disabled on this Hub');
    if (id && id.row && id.row.state === 'blocked') throw new HttpError(403, 'E_PEER_BLOCKED', 'Peer blocked');
  }

  /** Derive a reachable endpoint for hello when HUB_PUBLIC_URL is unset (WP1.2 / NAT). */
  function requestEndpoint(req) {
    const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const xfHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const host = xfHost || String(req.headers.host || '').split(',')[0].trim();
    if (!host) return '';
    const proto = xfProto || (cfg.cookieSecure === true ? 'https' : 'http');
    return (proto + '://' + host).replace(/\/+$/, '');
  }

  app.get('/federation/v1/hello', { limit: 'federation', auth: 'none' }, (ctx) => {
    on();
    const self = peers.self(); if (!self) throw new HttpError(503, 'E_NOT_READY', 'Hub is not initialised yet');
    const nonce = String(ctx.query.nonce || '');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new HttpError(400, 'E_INVALID', 'nonce required');
    // Prefer configured/override endpoint; else the URL the peer actually contacted (Host / X-Forwarded-*).
    const endpoint = self.endpoint || requestEndpoint(ctx.req) || '';
    if (!endpoint) throw new HttpError(503, 'E_NO_ENDPOINT', 'Set HUB_PUBLIC_URL or public_url_override so peers can verify this Hub');
    const endpointSource = self.endpoint ? 'configured' : 'request';
    return {
      protocol: PROTOCOL,
      software: 'community-hub',
      version: hub.version,
      account: self.account,
      pub: ks.publicKey(self.account),
      endpoint,
      endpoint_source: endpointSource,
      name: self.name,
      nonce,
      sig: signHello(ks, self.account, endpoint, nonce),
      capabilities: ['push', 'reach-check', 'range-proxy'],
    };
  });

  // Only public ledger events exist in the ledger, so everything returned here is public by construction.
  app.get('/federation/v1/events', { limit: 'federation' }, (ctx) => {
    requireContentSync(peerAuth(ctx));
    const cursor = Math.max(0, Number.parseInt(ctx.query.cursor, 10) || 0);
    const limit = Math.min(cfg.syncBatch, Math.max(1, Number.parseInt(ctx.query.limit, 10) || 50));
    const rows = ledger.eventsAfter(cursor, limit + 1);
    const more = rows.length > limit; if (more) rows.pop();
    const head = ledger.head().lid;
    return { events: rows, next_cursor: rows.length ? rows[rows.length - 1].lid : cursor, has_more: more, head };
  });

  app.get('/federation/v1/events/actor/:id', { limit: 'federation' }, (ctx) => {
    requireContentSync(peerAuth(ctx));
    if (!isAccountId(ctx.params.id)) throw new HttpError(400, 'E_INVALID', 'bad actor');
    const from = Math.max(1, Number.parseInt(ctx.query.from, 10) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(ctx.query.limit, 10) || 100));
    return { events: ledger.eventsForActor(ctx.params.id, from, limit) };
  });

  // Phase 7: compact heads (actor, last sequence, last event id) for anti-entropy. Only actors this Hub already replicates; no content.
  app.get('/federation/v1/heads', { limit: 'federation' }, (ctx) => {
    requireContentSync(peerAuth(ctx));
    const after = String(ctx.query.after || ''); if (after && !isAccountId(after)) throw new HttpError(400, 'E_INVALID', 'bad cursor');
    const limit = Math.min(200, Math.max(1, Number.parseInt(ctx.query.limit, 10) || 100));
    const rows = db.all('SELECT actor_id, last_seq, last_event_id FROM actor_state WHERE actor_id>? ORDER BY actor_id LIMIT ?', after, limit + 1);
    const more = rows.length > limit; if (more) rows.pop();
    ctx.res.setHeader('Cache-Control', 'no-store');
    return { heads: rows.map((r) => ({ actor: r.actor_id, seq: r.last_seq, id: r.last_event_id })), has_more: more, next: rows.length ? rows[rows.length - 1].actor_id : null };
  });

  app.get('/federation/v1/peers', { limit: 'federation' }, (ctx) => {
    const idp = peerAuth(ctx);
    // This is a small rendezvous list, not content. Share only with a verified,
    // non-blocked Hub identity; bulk event feeds remain separately opt-in.
    if (!idp.row || idp.row.state === 'blocked') return { peers: [] };
    const self = peers.self();
    const out = [];
    if (self && self.endpoint) out.push({ account: self.account, endpoint: self.endpoint, name: self.name });
    for (const p of peers.list().filter((x) => x.account_id && ['trusted', 'bootstrap'].includes(x.state) && x.last_ok && x.fail_streak < 3).slice(0, 49)) {
      try { validateEndpoint(p.endpoint, { allowPrivate: cfg.allowPrivatePeers }); out.push({ account: p.account_id, endpoint: p.endpoint, name: p.name }); } catch { /* skip */ }
    }
    return { peers: out.slice(0, 50) };
  });

  app.post('/federation/v1/poke', { limit: 'federation', maxBytes: 1024 }, (ctx) => {
    const id = peerAuth(ctx);
    if (id.row) peers.syncSoon(id.account);
    return { ok: true };
  });

  /**
   * Mutual introduction (WP1.3). A reachable peer calls us with a signed request and its endpoint.
   * We register them (open mode) and return our account + endpoint so they can store us.
   * Works when only one side has a public URL (the caller is the reachable one).
   */
  app.post('/federation/v1/connect', { limit: 'federation', maxBytes: 4096 }, (ctx) => {
    const id = peerAuth(ctx);
    const body = ctx.body || {};
    const claimed = String(body.endpoint || id.endpoint || '').trim();
    if (claimed) {
      try {
        validateEndpoint(claimed, { allowPrivate: cfg.allowPrivatePeers });
        const pin = id.account + '@' + claimed;
        if (!id.row) {
          if (cfg.federationMode === 'allowlist') throw new HttpError(403, 'E_PEER_UNKNOWN', 'Peer not permitted');
          peers.add(pin, { state: 'discovered', name: body.name || null });
        } else if (id.row.endpoint !== claimed) {
          try { peers.add(pin, { state: 'discovered' }); } catch { /* full/dup */ }
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        /* invalid endpoint ignored for registration */
      }
    }
    // Optional mutual content-sync invitation (backward compatible field)
    if (body.want_sync === true) {
      try { peers.noteSyncInvite(id.account, { endpoint: claimed || undefined, name: body.name || null }); } catch { /* ignore */ }
    }
    const self = peers.self();
    const endpoint = self.endpoint || requestEndpoint(ctx.req) || '';
    return {
      ok: true,
      protocol: PROTOCOL,
      account: self.account,
      name: self.name,
      endpoint,
      peer: id.account,
      want_sync_received: body.want_sync === true,
    };
  });

  /**
   * Push inbox (WP1.3). Peer that cannot be pulled (NAT) pushes public signed events to us.
   * Events are self-authenticating; we ingest with the same ledger path as pull sync.
   */
  app.post('/federation/v1/inbox', { limit: 'federation', maxBytes: 512 * 1024 }, (ctx) => {
    const id = peerAuth(ctx);
    requireContentSync(id);
    const events = ctx.body && Array.isArray(ctx.body.events) ? ctx.body.events : null;
    if (!events) throw new HttpError(400, 'E_INVALID', 'events array required');
    if (events.length > 100) throw new HttpError(400, 'E_INVALID', 'max 100 events per inbox push');
    const inc = peers.filterIncoming(events); // same interest policy as pull sync: a pushing peer cannot grow the ledger with strangers
    const summary = { ...ledger.ingestBatch(inc.keep, { source: 'inbox:' + id.account }).summary, skipped: inc.skipped };
    if (id.row) {
      try {
        db.run('UPDATE peers SET last_ok=?, fail_streak=0, next_retry_at=0 WHERE id=?', Date.now(), id.row.id);
      } catch { /* ok */ }
    }
    hub.bus.emit('local-publish');
    return { ok: true, summary };
  });

  app.get('/federation/v1/whoami', { limit: 'federation', auth: 'none' }, (ctx) => {
    on();
    return { ip: ctx.ip || '', time: Date.now() };
  });

  app.post('/federation/v1/reach-check', { limit: 'federation', maxBytes: 4096 }, async (ctx) => {
    const id = peerAuth(ctx);
    const url = String((ctx.body && ctx.body.url) || '').trim();
    if (!url) throw new HttpError(400, 'E_INVALID', 'url required');
    try {
      validateEndpoint(url, { allowPrivate: cfg.allowPrivatePeers });
    } catch (e) {
      return { reachable: false, reason: e.code || 'bad_url' };
    }
    try {
      const nonce = require('crypto').randomBytes(16).toString('base64url');
      const res = await peers.transport.request(url, { method: 'GET', path: '/federation/v1/hello?nonce=' + nonce }, 64 * 1024);
      if (res.status !== 200) return { reachable: false, reason: 'http_' + res.status };
      let j; try { j = JSON.parse(res.body.toString('utf8')); } catch { return { reachable: false, reason: 'bad_json' }; }
      if (j.account !== id.account && j.account !== peers.self()?.account) {
        // peer is checking if URL is reachable as claimed hub — accept matching protocol
      }
      if (j.protocol !== PROTOCOL) return { reachable: false, reason: 'protocol_mismatch' };
      return { reachable: true, reason: 'ok', account: j.account || null };
    } catch (e) {
      return { reachable: false, reason: e.code || e.message || 'unreachable' };
    }
  });



  /**
   * On-demand view of ONE actor's latest public activity (profile + recent posts). Small (≤ 50 events, ≤ 256 KiB),
   * read-only, never includes media bytes. This is how a remote visitor opens a profile without any bulk sync.
   * Events are self-authenticating (signed by the actor), so the visitor verifies them without trusting this Hub.
   */
  app.get('/federation/v1/actor/:id/snapshot', { limit: 'federation' }, (ctx) => {
    peerAuth(ctx);
    const actor = ctx.params.id;
    if (!isAccountId(actor)) throw new HttpError(400, 'E_INVALID', 'bad actor');
    const limit = Math.min(50, Math.max(1, Number.parseInt(ctx.query.limit, 10) || 30));
    const st = ledger.actorState(actor);
    if (!st) throw new HttpError(404, 'E_NOT_FOUND', 'Unknown actor');
    if (ctx.query.after !== undefined) {   // Phase 7 delta mode: only events newer than the caller's verified base, oldest first, resumable
      const after = Math.max(0, Number.parseInt(ctx.query.after, 10) || 0);
      const rows = db.all("SELECT body, sequence FROM events WHERE actor_id=? AND sequence>? AND event_type IN ('profile.update','post.create','post.edit','post.delete') ORDER BY sequence ASC LIMIT ?", actor, after, limit * 3 + 1);
      const more = rows.length > limit * 3; if (more) rows.pop();
      let bytes = 0; const events = []; let cut = false;
      for (const r of rows) { const e = JSON.parse(r.body); if (e.event_type === 'post.create' && !['post', 'quote'].includes(e.payload.kind)) continue; const n = Buffer.byteLength(r.body); if (bytes + n > 256 * 1024) { cut = true; break; } bytes += n; events.push(e); }
      ctx.res.setHeader('Cache-Control', 'no-store');
      const last = events.length ? events[events.length - 1].sequence : after;
      return { actor, head_seq: st.last_seq, events, delta: true, has_more: more || cut, through_seq: last };
    }
    const prof = db.all("SELECT body FROM events WHERE actor_id=? AND event_type='profile.update' ORDER BY sequence DESC LIMIT 1", actor);
    const rows = db.all("SELECT body FROM events WHERE actor_id=? AND event_type IN ('post.create','post.edit','post.delete') ORDER BY sequence DESC LIMIT ?", actor, limit * 3);
    let out = [...prof, ...rows].map((r) => JSON.parse(r.body));
    out = out.filter((e) => e.event_type !== 'post.create' || ['post', 'quote'].includes(e.payload.kind));
    let bytes = 0; const events = [];
    for (const e of out) { const n = Buffer.byteLength(JSON.stringify(e)); if (bytes + n > 256 * 1024) break; bytes += n; events.push(e); }
    events.sort((a, b) => a.sequence - b.sequence);
    ctx.res.setHeader('Cache-Control', 'no-store');
    return { actor, head_seq: st.last_seq, events };
  });

  app.get('/federation/v1/media/:hash', { limit: 'federation' }, (ctx) => {
    peerAuth(ctx);
    const h = ctx.params.hash;
    if (!/^[0-9a-f]{64}$/.test(h)) throw new HttpError(400, 'E_INVALID', 'bad hash');
    const m = db.get("SELECT * FROM media WHERE hash=? AND origin='local'", h);
    // Only media referenced by PUBLIC posts leaves this hub. Restricted/private media is never served to peers.
    if (!m || !media.isPublic(h) || !media.exists(h)) throw new HttpError(404, 'E_NOT_FOUND', 'Not found');
    serveFile(ctx.req, ctx.res, { file: media.pathFor(h), size: m.size, mime: m.mime, disposition: 'attachment', filename: m.name, cache: 'no-store', maxRange: cfg.maxRangeBytes });
  });
};
