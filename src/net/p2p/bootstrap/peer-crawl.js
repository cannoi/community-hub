'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');
const { parseMultiaddr, checkDial } = require('../policy');
const { guardedLookup, isPublicIp } = require('../../../federation/transport');
const { sanitizeJsonValue } = require('./cloudflare-crypto');

const MAX_CRAWL_BYTES = 512 * 1024;

function httpEndpointFromMultiaddr(ma) {
  try {
    const a = parseMultiaddr(String(ma));
    checkDial(a, { allowPrivate: false });
    const host = a.hostType === 'ip6' ? '[' + a.host + ']' : a.host;
    return (a.secure ? 'https://' : 'http://') + host + ':' + a.port;
  } catch { return null; }
}
function endpointForPeer(peer) {
  for (const ma of (peer && peer.multiaddrs || [])) {
    const endpoint = httpEndpointFromMultiaddr(ma);
    if (endpoint) return endpoint;
  }
  return null;
}
class PeerCrawler {
  constructor(opts = {}) {
    this.peerDb = opts.peerDb;
    this.fetchJson = opts.fetchJson || defaultFetchJson;
    this.getConnectedPeerIds = opts.getConnectedPeerIds || (() => []);
    this.getPeerId = opts.getPeerId || (() => null);
    this.perCycle = Math.max(1, Math.min(20, Number(opts.perCycle) || 4));
    this.timeoutMs = Number(opts.timeoutMs) || 4000;
    this._lastAsked = new Map();
    this._failures = new Map();
    this._nextAllowed = new Map();
  }
  async crawl() {
    if (!this.peerDb) return [];
    const connected = new Set(this.getConnectedPeerIds() || []);
    const selfId = this.getPeerId() ? String(this.getPeerId()) : null;
    const now = Date.now();
    const candidates = this.peerDb.list({ category: 'cannoi', limit: 500 })
      // Connected peers are the best bridge candidates: they are reachable and
      // should be queried for their own peer lists. Do not exclude them.
      .filter(p => (!selfId || String(p.peer_id) !== selfId) && (this._nextAllowed.get(p.peer_id) || 0) <= now)
      .map(p => ({ peer: p, endpoint: endpointForPeer(p) }))
      .filter(x => x.endpoint)
      .sort((a,b) => Number(connected.has(b.peer.peer_id)) - Number(connected.has(a.peer.peer_id)) ||
        (this._lastAsked.get(a.peer.peer_id) || 0) - (this._lastAsked.get(b.peer.peer_id) || 0))
      .slice(0, this.perCycle);
    const discovered = [];
    await Promise.all(candidates.map(async ({peer, endpoint}) => {
      const id = peer.peer_id;
      this._lastAsked.set(id, now);
      try {
        const info = await this.fetchJson(endpoint + '/p2p/bootstrap', this.timeoutMs);
        if (!info || info.network !== 'cannoi' || !Array.isArray(info.peers)) throw new Error('invalid peer bootstrap response');
        for (const item of info.peers.slice(0, 100)) {
          if (!item || typeof item.peer_id !== 'string' || !Array.isArray(item.multiaddrs)) continue;
          const addrs = item.multiaddrs.filter(ma => {
            try { const parsed = parseMultiaddr(ma); checkDial(parsed); return parsed.peerId === item.peer_id; } catch { return false; }
          });
          if (!addrs.length || item.peer_id === id) continue;
          const rec = { peerId: item.peer_id, multiaddrs: addrs.slice(0,8), category:'cannoi',
            source:'peer-crawl', protocol:item.protocol, capabilities:item.capabilities || [], signature:item.signature || null };
          this.peerDb.upsert(rec); discovered.push(rec);
        }
        this._failures.set(id, 0);
        this._nextAllowed.delete(id);
      } catch {
        const failures = (this._failures.get(id) || 0) + 1;
        this._failures.set(id, failures);
        this._nextAllowed.set(id, now + Math.min(30 * 60 * 1000, 5000 * (2 ** Math.min(failures - 1, 8))));
        this.peerDb.markFailure(id);
      }
    }));
    return discovered;
  }
}
async function defaultFetchJson(url, timeoutMs = 4000) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad scheme');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !isPublicIp(host)) throw new Error('private address');
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(u, {
      timeout: timeoutMs,
      agent: false,
      lookup: guardedLookup(false),
      headers: { Accept: 'application/json', 'User-Agent': 'cannoi-crawl/2.4' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return reject(new Error('redirect blocked'));
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_CRAWL_BYTES) {
        res.destroy();
        return reject(new Error('response too large'));
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_CRAWL_BYTES) {
          res.destroy();
          return reject(new Error('response too large'));
        }
        chunks.push(c);
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(parsed && typeof parsed === 'object' ? sanitizeJsonValue(parsed) : parsed);
        } catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}
module.exports = { PeerCrawler, httpEndpointFromMultiaddr, endpointForPeer };
