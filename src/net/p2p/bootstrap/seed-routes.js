'use strict';
/**
 * Public rendezvous endpoints for the standalone CANNOI seed service.
 * The seed is a directory, not a libp2p peer: it only stores and returns
 * short-lived, publicly dialable peer descriptors.
 */
const { HttpError } = require('../../../util');
const { PeerRegistry, isPrivateMultiaddr } = require('./peer-record');
const { parseMultiaddr, checkDial } = require('../policy');
const { NETWORK_ID, PROTOCOL_VERSION } = require('./types');
const { probePeerRecord } = require('./probe');
const { RegionalDirectory } = require('./directory');
const { TrustEngine } = require('../trust-engine');
const seedTrust = new TrustEngine({ maxPeers: 2000 });

function validatePublicRecord(record, now = Date.now()) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      record.network !== NETWORK_ID || typeof record.peer_id !== 'string' ||
      record.peer_id.length < 30 || record.peer_id.length > 80 ||
      !Array.isArray(record.multiaddrs) || record.multiaddrs.length < 1 || record.multiaddrs.length > 8 ||
      !Number.isSafeInteger(record.registered_at) ||
      !Number.isSafeInteger(record.expires_at) || record.expires_at <= now ||
      record.expires_at > now + 7 * 86400000 || record.registered_at > now + 5 * 60000) {
    throw new HttpError(400, 'E_P2P_RECORD', 'Invalid bootstrap peer record');
  }
  if (record.protocol !== undefined && (typeof record.protocol !== 'string' || record.protocol.length > 64)) {
    throw new HttpError(400, 'E_P2P_RECORD', 'Invalid peer protocol');
  }
  if (record.capabilities !== undefined && (!Array.isArray(record.capabilities) || record.capabilities.length > 16 || record.capabilities.some((x) => typeof x !== 'string' || x.length > 64))) {
    throw new HttpError(400, 'E_P2P_RECORD', 'Invalid peer capabilities');
  }
  if (record.reachability !== undefined && (typeof record.reachability !== 'string' || record.reachability.length > 32)) {
    throw new HttpError(400, 'E_P2P_RECORD', 'Invalid peer reachability');
  }
  if (record.signature !== undefined && record.signature !== null && (typeof record.signature !== 'string' || record.signature.length > 1024)) {
    throw new HttpError(400, 'E_P2P_RECORD', 'Invalid peer signature');
  }
  for (const addr of record.multiaddrs) {
    if (typeof addr !== 'string' || addr.length >= 512 || !addr.includes('/p2p/' + record.peer_id)) {
      throw new HttpError(400, 'E_P2P_ADDRESS', 'Invalid peer address');
    }
    try {
      const parsed = parseMultiaddr(addr);
      checkDial(parsed, { allowPrivate: false });
      if (parsed.peerId !== record.peer_id) throw new Error('peer id mismatch');
    } catch {
      throw new HttpError(400, 'E_P2P_ADDRESS', 'Invalid public peer address');
    }
  }
  return {
    peer_id: record.peer_id,
    network: NETWORK_ID,
    protocol: record.protocol || PROTOCOL_VERSION,
    multiaddrs: record.multiaddrs.slice(0, 8),
    capabilities: Array.isArray(record.capabilities) ? record.capabilities.slice(0, 16) : [],
    reachability: record.reachability || 'unknown',
    registered_at: record.registered_at,
    expires_at: record.expires_at,
    signature: record.signature || null,
  };
}

function mountBootstrapSeedRoutes(app, { db, limiter, version = '' } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS p2p_peer_registry (
    peer_id TEXT PRIMARY KEY,
    record TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_p2p_peer_registry_expiry ON p2p_peer_registry(expires_at);`);
  const regionalDir = new RegionalDirectory({ maxEntries: 5000, shards: 16 });
  const registry = new PeerRegistry({ db });
  const prune = () => {
    db.run('DELETE FROM p2p_peer_registry WHERE expires_at <= ?', Date.now());
    const count = Number(db.get('SELECT COUNT(*) AS c FROM p2p_peer_registry')?.c || 0);
    if (count > 20000) db.run('DELETE FROM p2p_peer_registry WHERE peer_id IN (SELECT peer_id FROM p2p_peer_registry ORDER BY updated_at ASC LIMIT ?)', count - 20000);
  };
  const opts = { auth: 'none', limit: 'presence' };

  app.get('/p2p/bootstrap', opts, () => {
    prune();
    const peers = registry.list(50).filter((r) => r && r.network === NETWORK_ID && Array.isArray(r.multiaddrs) && r.multiaddrs.some(a => !isPrivateMultiaddr(a)))
      .map((r) => ({
        peer_id: r.peer_id,
        network: NETWORK_ID,
        protocol: r.protocol || PROTOCOL_VERSION,
        multiaddrs: r.multiaddrs.filter(a => !isPrivateMultiaddr(a)).slice(0, 8),
        capabilities: Array.isArray(r.capabilities) ? r.capabilities.slice(0, 16) : [],
        reachability: String(r.reachability || 'unknown').slice(0, 32),
        registered_at: Number(r.registered_at) || null,
        expires_at: Number(r.expires_at) || null,
        signature: r.signature || null,
      }));
    return {
      network: NETWORK_ID,
      protocol: PROTOCOL_VERSION,
      status: 'directory',
      role: 'rendezvous-seed',
      peer_id: null,
      multiaddrs: [],
      peers,
      count: peers.length,
      version,
      updated_at: new Date().toISOString(),
    };
  });

  app.post('/p2p/register', { ...opts, maxBytes: 32768 }, async (ctx) => {
    const wait = limiter.check('p2p-seed-register:' + ctx.ip, 30, 60000);
    if (wait) {
      ctx.res.setHeader('Retry-After', wait);
      throw new HttpError(429, 'E_RATE_LIMIT', 'Too many peer registrations');
    }
    prune();
    const record = validatePublicRecord(ctx.body && ctx.body.record);
    const tv = seedTrust.validatePeerId(record.peer_id);
    if (!tv.ok) throw new HttpError(400, 'E_P2P_BAD_PEER', 'Invalid peer identity');
    const ta = seedTrust.allow(record.peer_id, 'register');
    if (!ta.ok) {
      return { ok: false, accepted: 0, verified: false, reason: 'trust_' + ta.reason, trust_state: ta.state };
    }
    // Probe-back: only serve records that answer /p2p/bootstrap with matching peer_id
    let probe = { verified: false, reason: 'skipped' };
    try {
      probe = await probePeerRecord(record, { timeoutMs: 4000, sourceIp: ctx.ip });
    } catch {
      probe = { verified: false, reason: 'unreachable' };
    }
    if (!probe.verified) {
      return {
        ok: false,
        accepted: 0,
        verified: false,
        reason: probe.reason || 'unreachable',
        peer_id: record.peer_id,
        observed: { ip: ctx.ip || null, peer_id: probe.observed_peer_id || null },
      };
    }
    record.verified = true;
    record.verified_at = Date.now();
    const result = registry.put(record);
    if (!result.ok) throw new HttpError(400, 'E_P2P_RECORD', 'Peer record rejected: ' + result.reason);
    prune();
    seedTrust.observe(record.peer_id, { success: true, bootstrap: true });
    try {
      regionalDir.put({
        ...record,
        region: (ctx.body && ctx.body.region) || record.region || 'ZZ',
        languages: (ctx.body && ctx.body.languages) || record.languages,
        language: (ctx.body && ctx.body.language) || record.language,
        topics: (ctx.body && ctx.body.topics) || record.topics,
        verified: true,
      });
    } catch { /* ignore */ }
    return {
      ok: true,
      accepted: 1,
      verified: true,
      peer_id: record.peer_id,
      expires_at: record.expires_at,
      observed: { ip: ctx.ip || null },
      trust_state: seedTrust.stateOf(record.peer_id),
    };
  });
  app.get('/p2p/directory', { ...opts }, (ctx) => {
    const q = ctx.query || {};
    return regionalDir.query({
      region: q.region,
      language: q.language || q.lang,
      shard: q.shard,
      cursor: q.cursor,
      limit: q.limit,
      verified_only: q.verified === '1' || q.verified === 'true',
    });
  });
  app.get('/p2p/directory/stats', { ...opts }, () => regionalDir.stats());
  return registry;
}

module.exports = { mountBootstrapSeedRoutes, validatePublicRecord };
