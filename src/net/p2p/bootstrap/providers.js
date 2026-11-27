'use strict';
/**
 * Bootstrap Provider implementations (Phases 2–5).
 * Each provider is independent; failure of one never blocks others.
 */
const https = require('https');
const http = require('http');
const net = require('net');
const dns = require('dns').promises;
const crypto = require('crypto');
const { parseMultiaddr, checkDial } = require('../policy');
const { PROVIDER_KINDS, NETWORK_ID, PROTOCOL_VERSION } = require('./types');
const { endpointForPeer } = require('./peer-crawl');
const { guardedLookup, isPublicIp } = require('../../../federation/transport');
const { sanitizeJsonValue } = require('./cloudflare-crypto');
const { getKey, seal, open } = require('./crypto');

const MAX_PROVIDER_BYTES = 1024 * 1024;
const isLoopbackIp = (ip) => {
  const s = String(ip || '').replace(/^\[|\]$/g, '').toLowerCase();
  return s === '127.0.0.1' || s === '::1' || s === '::ffff:127.0.0.1';
};

function baseProvider(kind, name, enabled, discoverFn, extraStatus = {}) {
  let lastError = null;
  let lastOkAt = 0;
  let lastCount = 0;
  let attempts = 0;
  let successes = 0;
  return {
    kind: () => kind,
    name: () => name,
    isEnabled: () => !!enabled,
    async discover() {
      attempts++;
      if (!enabled) return [];
      try {
        const list = await discoverFn();
        lastCount = list.length;
        lastOkAt = Date.now();
        lastError = null;
        if (list.length) successes++;
        return list;
      } catch (e) {
        lastError = (e && e.message) || String(e);
        throw e;
      }
    },
    status() {
      return {
        kind, name, enabled: !!enabled,
        attempts, successes, last_count: lastCount,
        last_ok_at: lastOkAt || null,
        last_error: lastError,
        ...extraStatus,
      };
    },
  };
}

/** Fixed built-in seeds (infrastructure and/or cannoi). Strict AES-256-GCM envelope for HTTP(S) seeds. */
function createFixedSeedProvider(seeds = [], opts = {}) {
  const list = (seeds || []).map(normalizeSeed).filter(Boolean);
  const timeoutMs = opts.timeoutMs || 5000;
  return baseProvider(PROVIDER_KINDS.FIXED, 'fixed-seeds', list.length > 0, async () => {
    const out = [];
    for (const seed of list) {
      if (!seed.endpoint) { out.push(toCandidate(seed)); continue; }
      // An HTTP(S) seed (Worker v1.4.0) returns an AES-256-GCM encrypted envelope on /p2p/bootstrap.
      // Never fallback to plaintext; skip seed on any fetch/decrypt/validation error.
      try {
        const key = getKey(opts.cloudflareKey);
        const base = seed.endpoint.replace(/\/+$/, '');
        const raw = await fetchJson(base + '/p2p/bootstrap', timeoutMs, {
          allowPrivate: !!opts.allowPrivate,
          headers: { 'X-Cannoi-Encrypted': '1' },
        });
        const info = open(raw, key);
        if (!info || info.network !== NETWORK_ID || !Array.isArray(info.multiaddrs) || (!info.peer_id && info.status !== 'directory')) {
          throw new Error('invalid bootstrap descriptor');
        }
        const addDescriptor = (peerIdValue, addrValues, extra = {}) => {
          const peerId = String(peerIdValue || '').slice(0, 128);
          if (!peerId) return false;
          const multiaddrs = (Array.isArray(addrValues) ? addrValues : []).map(String).filter((ma) => {
            if (!ma.startsWith('/') || ma.length >= 512 || !ma.includes('/p2p/' + peerId)) return false;
            try { const parsed = parseMultiaddr(ma); checkDial(parsed, { allowPrivate: !!opts.allowPrivate }); return parsed.peerId === peerId; }
            catch { return false; }
          }).slice(0, 8);
          if (!multiaddrs.length) return false;
          out.push({ peerId, multiaddrs, category: 'cannoi', source: PROVIDER_KINDS.FIXED,
            protocol: extra.protocol || info.protocol || PROTOCOL_VERSION,
            capabilities: Array.isArray(extra.capabilities) ? extra.capabilities.slice(0, 16) : ['hub', 'bootstrap'],
            endpoint: endpointForPeer({ multiaddrs }) || null });
          return true;
        };
        if (info.peer_id) addDescriptor(info.peer_id, info.multiaddrs);
        for (const peer of (Array.isArray(info.peers) ? info.peers : []).slice(0, 50)) {
          if (peer && peer.network === NETWORK_ID) addDescriptor(peer.peer_id, peer.multiaddrs, peer);
        }
      } catch (e) {
        if (opts.log) opts.log.debug('fixed-seed skipped ' + seed.endpoint + ': ' + (e && e.message));
      }
    }
    return dedupeCandidates(out);
  });
}

/** Previously known peers from PeerDatabase. */
function createKnownPeerProvider(peerDb) {
  return baseProvider(PROVIDER_KINDS.KNOWN, 'known-peers', true, async () => {
    if (!peerDb) return [];
    peerDb.clearExpired();
    return peerDb.asCandidates({ limit: 40 });
  });
}

/** Configured libp2p-style bootstrap multiaddrs (infrastructure). */
function createLibp2pBootstrapProvider(addrs = []) {
  const list = (addrs || []).map((a) => {
    const s = String(a || '').trim();
    if (!s) return null;
    const m = /\/p2p\/([^/]+)/.exec(s);
    return {
      peerId: m ? m[1] : s,
      multiaddrs: [s],
      category: 'infrastructure',
      source: PROVIDER_KINDS.LIBP2P,
    };
  }).filter(Boolean);
  return baseProvider(PROVIDER_KINDS.LIBP2P, 'libp2p-bootstrap', list.length > 0, async () => list);
}

/**
 * HTTPS signed seed manifest.
 * Manifest shape:
 * {
 *   version: 1,
 *   network: "cannoi",
 *   expires_at: <ms>,
 *   peers: [{ peer_id, multiaddrs, category, capabilities, protocol }],
 *   signature?: "..."  // optional for now; required when publicKey configured
 * }
 */
function createHttpsManifestProvider(urls = [], opts = {}) {
  const list = (urls || []).map(String).filter(Boolean);
  const timeoutMs = opts.timeoutMs || 8000;
  const publicKey = opts.publicKey || null; // PEM or raw for future verify

  return baseProvider(
    PROVIDER_KINDS.HTTPS_MANIFEST,
    'https-manifest',
    list.length > 0,
    async () => {
      const out = [];
      for (const url of list) {
        try {
          const body = await fetchJson(url, timeoutMs);
          const peers = validateManifest(body, { publicKey });
          for (const p of peers) out.push(p);
        } catch (e) {
          // try next URL
          if (opts.log) opts.log.debug('https-manifest ' + url + ': ' + (e && e.message));
        }
      }
      return dedupeCandidates(out);
    },
    { urls: list.slice(0, 5) }
  );
}

/** Optional DNS seed (Bitcoin-style). Disabled unless domains configured. */
function createDnsSeedProvider(domains = [], opts = {}) {
  const list = (domains || []).map(String).filter(Boolean);
  return baseProvider(
    PROVIDER_KINDS.DNS,
    'dns-seed',
    list.length > 0,
    async () => {
      const out = [];
      for (const domain of list) {
        try {
          // TXT records: cannoi-peer=<peerId>|<multiaddr>
          const records = await dns.resolveTxt(domain);
          for (const chunks of records) {
            const txt = chunks.join('');
            const m = /^cannoi-peer=([^|]+)\|(.+)$/.exec(txt);
            if (m) {
              out.push({
                peerId: m[1],
                multiaddrs: [m[2]],
                category: 'cannoi',
                source: PROVIDER_KINDS.DNS,
                protocol: PROTOCOL_VERSION,
              });
            }
          }
        } catch (e) {
          if (opts.log) opts.log.debug('dns-seed ' + domain + ': ' + (e && e.message));
        }
      }
      return dedupeCandidates(out);
    },
    { domains: list.slice(0, 5) }
  );
}

/** LAN/mDNS bridge — reads from LanRegistry snapshot function. */
function createMdnsProvider(getLanPeers) {
  return baseProvider(PROVIDER_KINDS.MDNS, 'mdns-lan', true, async () => {
    const peers = typeof getLanPeers === 'function' ? (getLanPeers() || []) : [];
    return peers.map((p) => ({
      peerId: p.id || p.peerId,
      multiaddrs: p.multiaddrs || [],
      category: 'cannoi',
      source: PROVIDER_KINDS.MDNS,
      lastSeen: p.lastSeen,
    })).filter((p) => p.peerId);
  });
}

// ---------- helpers ----------

function normalizeSeed(s) {
  if (!s) return null;
  if (typeof s === 'object' && s.peerId) {
    return {
      peerId: String(s.peerId),
      multiaddrs: Array.isArray(s.multiaddrs) ? s.multiaddrs.map(String) : [],
      category: s.category === 'infrastructure' ? 'infrastructure' : 'cannoi',
      source: PROVIDER_KINDS.FIXED,
      protocol: s.protocol || PROTOCOL_VERSION,
      capabilities: s.capabilities || [],
    };
  }
  const str = String(s).trim();
  if (!str) return null;
  // multiaddr
  if (str.startsWith('/')) {
    const m = /\/p2p\/([^/]+)/.exec(str);
    return {
      peerId: m ? m[1] : 'unknown',
      multiaddrs: [str],
      category: 'infrastructure',
      source: PROVIDER_KINDS.FIXED,
    };
  }
  // HTTPS hub endpoint → treat as cannoi registry hint (not multiaddr)
  if (/^https?:\/\//i.test(str)) {
    return {
      peerId: 'https:' + str.replace(/^https?:\/\//i, '').split('/')[0],
      multiaddrs: [],
      category: 'cannoi',
      source: PROVIDER_KINDS.FIXED,
      capabilities: ['https-federation'],
      endpoint: str.replace(/\/$/, ''),
    };
  }
  return null;
}

function toCandidate(s) {
  return {
    peerId: s.peerId,
    multiaddrs: s.multiaddrs || [],
    category: s.category || 'cannoi',
    source: s.source || PROVIDER_KINDS.FIXED,
    protocol: s.protocol,
    capabilities: s.capabilities,
    endpoint: s.endpoint,
  };
}

function validateManifest(body, opts = {}) {
  if (!body || typeof body !== 'object') throw new Error('invalid manifest');
  if (body.network && body.network !== NETWORK_ID) throw new Error('wrong network');
  if (body.expires_at && Number(body.expires_at) < Date.now()) throw new Error('manifest expired');
  const version = Number(body.version) || 1;
  if (version < 1 || version > 10) throw new Error('unsupported manifest version');
  // Ed25519 signature verification when key provided
  if (opts.publicKey) {
    if (!body.signature || typeof body.signature !== 'string') {
      throw new Error('manifest signature required');
    }
    const canonicalObj = {
      version,
      network: body.network || NETWORK_ID,
      expires_at: body.expires_at ?? null,
      peers: Array.isArray(body.peers) ? body.peers : [],
    };
    const payload = Buffer.from(JSON.stringify(canonicalObj), 'utf8');
    const sigStr = body.signature.trim();
    const sigBuf = Buffer.from(sigStr, /[-_]/.test(sigStr) ? 'base64url' : 'base64');
    let ok = false;
    try {
      ok = crypto.verify(null, payload, opts.publicKey, sigBuf);
    } catch { ok = false; }
    if (!ok) throw new Error('invalid manifest signature');
  }
  const peers = Array.isArray(body.peers) ? body.peers : [];
  const out = [];
  for (const p of peers) {
    if (!p || !p.peer_id) continue;
    out.push({
      peerId: String(p.peer_id).slice(0, 128),
      multiaddrs: Array.isArray(p.multiaddrs) ? p.multiaddrs.map(String).slice(0, 8) : [],
      category: p.category === 'infrastructure' ? 'infrastructure' : 'cannoi',
      source: PROVIDER_KINDS.HTTPS_MANIFEST,
      protocol: p.protocol || PROTOCOL_VERSION,
      capabilities: Array.isArray(p.capabilities) ? p.capabilities.slice(0, 16) : [],
      expiresAt: body.expires_at ? Number(body.expires_at) : undefined,
      signature: p.signature || body.signature || null,
      endpoint: p.endpoint || null,
    });
  }
  return out;
}

function dedupeCandidates(list) {
  const map = new Map();
  for (const c of list) {
    if (!c.peerId) continue;
    const prev = map.get(c.peerId);
    if (!prev) { map.set(c.peerId, c); continue; }
    const addrs = new Set([...(prev.multiaddrs || []), ...(c.multiaddrs || [])]);
    prev.multiaddrs = [...addrs].slice(0, 16);
  }
  return [...map.values()];
}

function assertSafeProviderUrl(raw, { allowPrivate = false } = {}) {
  const u = new URL(raw);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('unsupported protocol');
  if (u.username || u.password || u.hash) throw new Error('bad url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.length > 253) throw new Error('bad url');
  if (net.isIP(host)) {
    if (!allowPrivate && !isPublicIp(host) && !isLoopbackIp(host)) throw new Error('private address');
  } else if (!allowPrivate && (/(^|\.)localhost$/i.test(host) || /\.(local|internal|lan|home|corp)$/i.test(host))) {
    throw new Error('private address');
  }
  return u;
}

function postJsonOnce(parsed, payloadObj, timeoutMs, extraHeaders = {}, allowPrivate = false) {
  return new Promise((resolve, reject) => {
    const lib = parsed.protocol === 'https:' ? https : http;
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const body = Buffer.from(JSON.stringify(payloadObj));
    const reqOpts = {
      method: 'POST',
      timeout: timeoutMs,
      agent: false,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'User-Agent': 'cannoi-hub/2.4',
        ...extraHeaders,
      },
    };
    if (!net.isIP(host)) reqOpts.lookup = guardedLookup(!!allowPrivate);
    const req = lib.request(parsed, reqOpts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return reject(new Error('redirect blocked'));
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_PROVIDER_BYTES) {
        res.destroy();
        return reject(new Error('response too large'));
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_PROVIDER_BYTES) {
          res.destroy();
          return reject(new Error('response too large'));
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode }));
        }
        try {
          const parsedJson = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(parsedJson && typeof parsedJson === 'object' ? sanitizeJsonValue(parsedJson) : parsedJson);
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(body);
  });
}

async function publishPeerRecord(url, record, timeoutMs = 5000, opts = {}) {
  const parsed = assertSafeProviderUrl(String(url).replace(/\/+$/, '') + '/p2p/register', { allowPrivate: !!opts.allowPrivate });
  const key = getKey(opts.cloudflareKey);
  const env = seal({ record }, key);
  const out = await postJsonOnce(parsed, env, timeoutMs, { 'X-Cannoi-Encrypted': '1' }, !!opts.allowPrivate);
  return open(out, key);
}

function fetchJson(url, timeoutMs = 8000, opts = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = assertSafeProviderUrl(url, { allowPrivate: !!opts.allowPrivate }); } catch (e) { reject(e); return; }
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      timeout: timeoutMs,
      agent: false,
      headers: { Accept: 'application/json', 'User-Agent': 'cannoi-hub/2.4', ...(opts.headers || {}) },
    };
    if (!net.isIP(host)) reqOpts.lookup = guardedLookup(!!opts.allowPrivate);
    const req = lib.get(parsed, reqOpts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return reject(new Error('redirect blocked'));
      }
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_PROVIDER_BYTES) {
        res.destroy();
        return reject(new Error('response too large'));
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_PROVIDER_BYTES) {
          res.destroy();
          return reject(new Error('response too large'));
        }
        chunks.push(c);
      });
      res.on('end', () => {
        try {
          let data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data && typeof data === 'object') data = sanitizeJsonValue(data);
          resolve(data);
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

module.exports = {
  createFixedSeedProvider,
  createKnownPeerProvider,
  createLibp2pBootstrapProvider,
  createHttpsManifestProvider,
  createDnsSeedProvider,
  createMdnsProvider,
  validateManifest,
  normalizeSeed,
  fetchJson,
  publishPeerRecord,
};
