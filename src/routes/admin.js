'use strict';
const fs = require('fs');
const path = require('path');
const { HttpError } = require('../util');
const { verifyPassword } = require('../auth');
const { createBackup, createBackupZip } = require('../backup');
const { rekeyOwnerAccount, keyPresent } = require('../identity-recovery');

const { normalizePeerInput, createInvite } = require('../federation/invite');
module.exports = function register(hub) {
  const { app, db, cfg, ks, ledger, peers, limiter } = hub;
  const reauth = (ctx) => {
    const wait = limiter.check('reauth:' + ctx.user.id, 5, 60000);
    if (wait) throw new HttpError(429, 'E_RATE_LIMIT', 'Too many attempts');
    const u = db.get('SELECT password_hash FROM users WHERE id=?', ctx.user.id);
    if (!verifyPassword(String(ctx.body.password || ''), u.password_hash)) throw new HttpError(403, 'E_BAD_CREDENTIALS', 'Password is wrong');
  };

  // ---- identity ----
  app.get('/api/identity', { auth: 'user' }, (ctx) => ({
    account_id: ctx.user.account_id, public_key: ks.publicKey(ctx.user.account_id), key_present: keyPresent(hub, ctx.user), id_format: 'hub1 = "hub1_" + base32(SHA-256(Ed25519 public key))',
    endpoint: cfg.publicUrl || null, primary: !!ctx.user.is_primary, history_pending: db.get("SELECT value FROM meta WHERE key='history_pending'")?.value === '1',
    sequence: ledger.actorState(ctx.user.account_id)?.last_seq || 0,
  }));
  // Key export: owner only, password re-entered, key re-encrypted under a separate export passphrase.
  app.post('/api/identity/export', { auth: 'user', limit: 'login' }, (ctx) => {
    reauth(ctx);
    try { return ks.exportKey(ctx.user.account_id, String(ctx.body.export_passphrase || '')); } catch (e) { throw new HttpError(400, 'E_EXPORT', e.message); }
  });
  // Key rotation for an account whose private key is not on this Hub (e.g. restored from a backup taken without the key).
  app.post('/api/identity/rekey', { auth: 'user', limit: 'login' }, (ctx) => { reauth(ctx); return rekeyOwnerAccount(hub, ctx.user); });
  app.post('/api/identity/start-fresh', { auth: 'owner', limit: 'login' }, (ctx) => { reauth(ctx); db.run("DELETE FROM meta WHERE key='history_pending'"); return { ok: true }; });

  // ---- peers & sync (owner only; summary for everyone signed in) ----
  app.get('/api/sync/status', { auth: 'user' }, (ctx) => {
    const s = peers.status();
    // Compact P2P / resilient-network snapshot for the NETWORK UI (Phase 8)
    let net = null;
    try { net = hub.net ? hub.net.status() : null; } catch (_) { net = null; }
    const p2p = net && net.kind === 'p2p' ? {
      enabled: !!net.enabled,
      state: net.network_state || net.state || 'OFFLINE',
      preferred_transport: net.preferred_transport || 'store_and_forward',
      peers: net.peers || 0,
      lan_peers: net.lan_peers || 0,
      relay_connections: net.relay_connections || 0,
      pending_messages: net.pending_local_messages || 0,
      reachability: net.reachability || 'unknown',
      last_dial_error: net.last_dial_error || null,
      mdns: !!net.mdns,
      discovery: !!net.discovery,
      pubsub: !!net.pubsub,
      outbox: net.outbox || null,
      last_sync_hint: net.started_at || null,
      bootstrap: net.bootstrap || null,
    } : {
      enabled: false,
      state: 'OFFLINE',
      preferred_transport: 'store_and_forward',
      peers: 0,
      lan_peers: 0,
      relay_connections: 0,
      pending_messages: 0,
      bootstrap: null,
    };
    if (ctx.user.is_primary) return { ...s, p2p };
    return { enabled: s.enabled, healthy: s.healthy, total: s.total, last_sync_at: s.last_sync_at, p2p };
  });
  const peerErr = (e) => { throw new HttpError(400, 'E_PEER_' + String(e.code || 'INVALID').toUpperCase(), 'Cannot add peer: ' + (e.code || e.message)); };
  app.get('/api/network/invite', { auth: 'owner' }, () => {
    const self = peers.self();
    if (!self || !self.endpoint) throw new (require('../util').HttpError)(400, 'E_NO_ENDPOINT', 'Set a public URL first');
    const code = createInvite({ account: self.account, endpoints: [self.endpoint], name: self.name });
    const needPw = !!db.get("SELECT value FROM meta WHERE key='invite_password_hash'")?.value;
    return { invite: code, endpoint: self.endpoint, account: self.account, invite_password_required: needPw, public_url: self.endpoint };
  });

  app.get('/api/peers', { auth: 'owner' }, () => ({ items: peers.status().peers }));
  app.post('/api/peers', { auth: 'owner', limit: 'write' }, (ctx) => {
    let endpoint = String(ctx.body.endpoint || ctx.body.invite || '');
    try { endpoint = normalizePeerInput(endpoint, { allowPrivate: cfg.allowPrivatePeers }); } catch (e) { peerErr(e); }
    let p; try { p = peers.add(endpoint, { state: ctx.body.state === 'bootstrap' ? 'bootstrap' : 'trusted' }); } catch (e) { peerErr(e); }
    peers.syncPeer(p).catch(() => {});
    return { id: p.id, endpoint: p.endpoint, state: p.state };
  });
  app.patch('/api/peers/:id', { auth: 'owner', limit: 'write' }, (ctx) => {
    const id = Number(ctx.params.id); const b = ctx.body || {};
    if (!peers.get(id)) throw new HttpError(404, 'E_NOT_FOUND', 'Peer not found');
    if (b.sync_content !== undefined) { // per-peer opt-in to BULK content sync (default off; needs the global mode 'trusted')
      if (typeof b.sync_content !== 'boolean') throw new HttpError(400, 'E_INVALID', 'sync_content must be boolean');
      if (b.sync_content && peers.contentMode() !== 'trusted') throw new HttpError(409, 'E_CONTENT_SYNC_GLOBAL_OFF', 'Enable content sync for trusted peers first');
      peers.setPeerSync(id, b.sync_content);
    }
    if (b.state !== undefined) { try { peers.setState(id, b.state); } catch { throw new HttpError(400, 'E_INVALID', 'Invalid state'); } }
    const p = peers.get(id);
    return { id, state: p.state, sync_content: !!p.sync_content };
  });
  app.delete('/api/peers/:id', { auth: 'owner', limit: 'write' }, (ctx) => { peers.remove(Number(ctx.params.id)); return { ok: true }; });
  app.post('/api/peers/:id/invite-sync', { auth: 'owner', limit: 'write' }, async (ctx) => {
    const id = Number(ctx.params.id);
    const p = peers.get(id);
    if (!p) throw new HttpError(404, 'E_NOT_FOUND', 'Peer not found');
    if (peers.contentMode() !== 'trusted') throw new HttpError(409, 'E_CONTENT_SYNC_GLOBAL_OFF', 'Enable content sync for trusted peers first');
    peers.setPeerSync(id, true);
    // clear invite marker
    if (p.last_error === 'SYNC_INVITE_PENDING') peers.db.run('UPDATE peers SET last_error=NULL WHERE id=?', id);
    try {
      const out = await peers.inviteSync(id);
      return { ok: true, invited: true, sync_content: true, remote: out.remote || null };
    } catch (e) {
      return { ok: true, invited: true, sync_content: true, remote_error: String(e.code || e.message).slice(0, 80) };
    }
  });
  app.get('/api/peers/sync-invites', { auth: 'owner' }, () => ({
    items: peers.pendingSyncInvites().map((p) => ({ id: p.id, account_id: p.account_id, name: p.name, state: p.state })),
  }));
  app.post('/api/peers/:id/sync', { auth: 'owner', limit: 'write' }, async (ctx) => {
    const p = peers.get(Number(ctx.params.id)); if (!p) throw new HttpError(404, 'E_NOT_FOUND', 'Peer not found');
    db.run('UPDATE peers SET next_retry_at=0 WHERE id=?', p.id);
    return peers.syncPeer(p);
  });

  // ---- integrity, recovery, portability ----
  app.get('/api/admin/integrity', { auth: 'owner' }, () => ({ digest: ledger.computeDigest(), verify: (() => { const v = ledger.verifyAll(); return { ok: v.ok, problems: v.problems.slice(0, 20) }; })(), gaps: ledger.openGaps(), conflicts: ledger.conflicts(20) }));
  app.post('/api/admin/reindex', { auth: 'owner', limit: 'login' }, () => ledger.reindex());
  // Phase 7 Developer Diagnostics (owner only, hidden from the normal UI): findings, lifecycle, metrics; run one bounded cycle on demand.
  app.get('/api/admin/healing', { auth: 'owner' }, () => ({ ...hub.healing.status(), findings_recent: hub.healing.findings({ limit: 50 }).map((f) => ({ id: f.id, layer: f.layer, kind: f.kind, severity: f.severity, status: f.status, attempts: f.attempts, detected_at: f.detected_at, repaired_at: f.repaired_at })), anti_entropy: hub.peers.antiEntropy ? hub.peers.antiEntropy.stats : undefined, remote_cache: hub.remote.stats }));
  app.post('/api/admin/healing/run', { auth: 'owner', limit: 'login' }, async () => ({ cycle: await hub.healing.cycle(), status: hub.healing.status() }));
  app.get('/api/admin/reports', { auth: 'owner' }, () => ({ items: db.all('SELECT * FROM reports ORDER BY id DESC LIMIT 200') }));
  app.post('/api/admin/backup', { auth: 'owner', limit: 'login' }, (ctx) => {
    reauth(ctx);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(cfg.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const zipPath = path.join(dir, 'community-hub-backup-' + stamp + '.zip');
    const r = createBackupZip(cfg, zipPath, db);
    return {
      path: zipPath,
      download: '/api/admin/backup/download?file=' + encodeURIComponent(path.basename(zipPath)),
      files: r.files,
      bytes: r.bytes,
      posts: r.posts || 0,
      events: r.events || 0,
      media: r.media || 0,
      inventory: r.inventory || null,
      keys_missing: r.keys_missing || [],
      warnings: (r.keys_missing || []).length ? ['keys_missing'] : [],
      note: 'ZIP includes community.db (posts+events), keys, media files, and data/posts.json for verification.',
    };
  });

  app.get('/api/admin/backup/download', { auth: 'owner' }, (ctx) => {
    const name = String(ctx.query.file || '');
    if (!/^[\w.\-]+\.zip$/.test(name) || name.includes('..')) throw new HttpError(400, 'E_INVALID', 'bad file');
    const abs = path.join(cfg.dataDir, 'backups', name);
    if (!fs.existsSync(abs)) throw new HttpError(404, 'E_NOT_FOUND', 'Backup not found');
    const st = fs.statSync(abs);
    ctx.res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': st.size,
      'Content-Disposition': 'attachment; filename="' + name + '"',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(abs).pipe(ctx.res);
  });

  // NOTE: the old in-place POST /api/admin/restore was removed in 2.3.13. Swapping database/key files under a running Hub left the
  // process writing to the old (unlinked) database while keys/ came from the backup. Restore now happens on the setup screen
  // (POST /api/setup/restore) or offline with `npm run restore`.
  app.get('/api/admin/export/events', { auth: 'owner' }, (ctx) => {
    const actor = ctx.user.account_id; const lines = [];
    for (let from = 1; lines.length < 50000;) { const evs = ledger.eventsForActor(actor, from, 500); if (!evs.length) break; for (const e of evs) lines.push(JSON.stringify(e)); from = evs[evs.length - 1].sequence + 1; }
    ctx.res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': 'attachment; filename="my-events.ndjson"', 'Cache-Control': 'no-store' });
    ctx.res.end(lines.join('\n') + (lines.length ? '\n' : ''));
  });
  app.post('/api/admin/import/events', { auth: 'owner', maxBytes: 4 * 1024 * 1024, limit: 'write' }, (ctx) => {
    if (!Array.isArray(ctx.body.events)) throw new HttpError(400, 'E_INVALID', 'events array required');
    return ledger.ingestBatch(ctx.body.events, { source: 'import' }).summary;
  });
};
