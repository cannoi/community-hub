'use strict';
/**
 * Phase 5 completion — resource control + transports for index replication.
 *
 * ResourceGovernor decides, from measured CPU load / RSS / free disk / index fill, how much serving work this machine may take.
 * Weak machines never host other Hubs' shards (they remain Consumer + Local Index). Pressure at runtime sheds work instead of
 * degrading the Hub the user is actually using.
 */
const os = require('os');
const fs = require('fs');
const compat = require('./libp2p-compat');

const PROTOCOL = '/cannoi/index/1.0.0';
const MB = 1024 * 1024;

class ResourceGovernor {
  /**
   * @param {{dataDir?:string, index?:object, overrides?:object, probes?:object}} o
   *  probes (injectable for tests): load1(), cpus(), totalMemMb(), rssMb(), freeDiskMb()
   */
  constructor(o = {}) {
    this.dataDir = o.dataDir || '.';
    this.index = o.index || null;
    this.overrides = o.overrides || {};
    this.p = {
      load1: () => os.loadavg()[0],
      cpus: () => os.cpus().length || 1,
      totalMemMb: () => os.totalmem() / MB,
      rssMb: () => process.memoryUsage().rss / MB,
      freeDiskMb: () => { try { const s = fs.statfsSync(this.dataDir); return (Number(s.bavail) * Number(s.bsize)) / MB; } catch { return Infinity; } },
      ...(o.probes || {}),
    };
  }

  profile() {
    const mem = this.p.totalMemMb(); const cpus = this.p.cpus();
    let t;
    if (mem < 1536 || cpus < 2) t = { tier: 'weak', maxHostedShards: 0, baseConcurrency: 2, tickBudgetMs: 20, maxRssMb: Math.max(128, mem * 0.2) };
    else if (mem < 6144 || cpus < 4) t = { tier: 'medium', maxHostedShards: 8, baseConcurrency: 4, tickBudgetMs: 50, maxRssMb: Math.max(256, mem * 0.25) };
    else t = { tier: 'strong', maxHostedShards: 32, baseConcurrency: 16, tickBudgetMs: 150, maxRssMb: Math.max(512, mem * 0.25) };
    return { ...t, ...this.overrides };
  }

  pressure() {
    const pr = this.profile(); const reasons = [];
    const loadPerCpu = this.p.load1() / this.p.cpus();
    if (loadPerCpu > 0.85) reasons.push('cpu');
    if (this.p.rssMb() > pr.maxRssMb) reasons.push('ram');
    const minDisk = this.overrides.minFreeDiskMb != null ? this.overrides.minFreeDiskMb : 512;
    if (this.p.freeDiskMb() < minDisk) reasons.push('disk');
    if (this.index && this.index.capacity().ratio >= 0.9) reasons.push('index_full');
    return { high: reasons.length > 0, reasons, loadPerCpu };
  }

  canHost(currentlyHosted) {
    const pr = this.profile();
    if (Number(currentlyHosted) >= pr.maxHostedShards) return false;
    return !this.pressure().high;
  }

  concurrency() {
    const pr = this.profile(); const l = this.p.load1() / this.p.cpus();
    const f = l < 0.5 ? 1 : l < 0.8 ? 0.5 : 0.25;
    return Math.max(1, Math.floor(pr.baseConcurrency * f));
  }

  tickBudgetMs() { return this.profile().tickBudgetMs; }

  snapshot() { const pr = this.profile(); const pe = this.pressure(); return { tier: pr.tier, max_hosted_shards: pr.maxHostedShards, concurrency: this.concurrency(), pressure: pe.reasons, load_per_cpu: Number(pe.loadPerCpu.toFixed(2)), rss_mb: Math.round(this.p.rssMb()) }; }
}

/** Per-peer token bucket (bounded map). Control-plane messages are cheap but must still be capped. */
class RateBucket {
  constructor({ capacity = 120, refillPerSec = 20, maxPeers = 2000, now = Date.now } = {}) {
    this.capacity = capacity; this.refill = refillPerSec; this.maxPeers = maxPeers; this.now = now; this.m = new Map();
  }
  take(peer, cost = 1, factor = 1) {
    const t = this.now(); let b = this.m.get(peer);
    if (!b) { if (this.m.size >= this.maxPeers) this.m.delete(this.m.keys().next().value); b = { tokens: this.capacity * factor, t }; this.m.set(peer, b); }
    b.tokens = Math.min(this.capacity * factor, b.tokens + ((t - b.t) / 1000) * this.refill * factor); b.t = t;
    if (b.tokens < cost) return false;
    b.tokens -= cost; return true;
  }
}

/** Real transport over the Hub's existing libp2p node (no second P2P stack). One request/response per stream. */
class Libp2pIndexTransport {
  constructor({ getNode, toPeer, log, maxBytes = 1024 * 1024, protocol = PROTOCOL }) {
    this.protocol = protocol; this.getNode = getNode; this.toPeer = toPeer; this.log = log || { debug() {}, warn() {} }; this.maxBytes = maxBytes; this._started = false;
  }
  async start(handler) {
    const node = this.getNode();
    if (!node || typeof node.handle !== 'function') return false;
    await node.handle(this.protocol, async (a, b) => {
      const { stream, connection } = compat.handlerArgs(a, b);
      try {
        const remote = connection && connection.remotePeer ? String(connection.remotePeer) : null; // authenticated by the Noise handshake
        if (!remote) return;
        const raw = (await compat.readStream(stream, this.maxBytes)).toString('utf8');
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        const resp = await handler(remote, msg);
        await compat.writeStream(stream, Buffer.from(JSON.stringify(resp == null ? { ok: false } : resp), 'utf8'));
        try { await stream.close(); } catch { /* ignore */ }
      } catch (e) { this.log.debug('index handler: ' + (e && e.message)); try { stream.abort && stream.abort(e); } catch { /* ignore */ } }
    });
    this._started = true; return true;
  }
  async stop() { const n = this.getNode(); if (n && typeof n.unhandle === 'function') { try { await n.unhandle(this.protocol); } catch { /* ignore */ } } this._started = false; }
  async request(peer, msg, { timeoutMs = 3000 } = {}) {
    const node = this.getNode();
    if (!node || typeof node.dialProtocol !== 'function') throw new Error('no_node');
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    let timer; const killer = new Promise((_, rej) => { timer = setTimeout(() => { try { ac && ac.abort(); } catch { /* ignore */ } rej(Object.assign(new Error('timeout'), { code: 'E_TIMEOUT' })); }, timeoutMs); });
    const work = (async () => {
      const target = this.toPeer ? await this.toPeer(peer) : peer;
      const stream = await node.dialProtocol(target, this.protocol, ac ? { signal: ac.signal } : undefined);
      await compat.writeStream(stream, Buffer.from(JSON.stringify(msg), 'utf8'));
      if (typeof stream.closeWrite === 'function') { try { await stream.closeWrite(); } catch { /* ignore */ } }
      const raw = (await compat.readStream(stream, this.maxBytes)).toString('utf8');
      try { await stream.close(); } catch { /* ignore */ }
      return JSON.parse(raw);
    })();
    try { return await Promise.race([work, killer]); } finally { clearTimeout(timer); work.catch(() => {}); }
  }
}

/** In-process network for tests: JSON round-trips every message, enforces size, supports partitions / downed peers / drops. */
class LoopbackNetwork {
  constructor({ maxBytes = 1024 * 1024 } = {}) { this.nodes = new Map(); this.down = new Set(); this.cut = new Set(); this.maxBytes = maxBytes; this.sent = 0; this.log = []; this.dropRate = 0; this.dropIf = null; }
  attach(peerId) {
    const net = this; const self = { handler: null };
    this.nodes.set(peerId, self);
    return {
      async start(h) { self.handler = h; return true; },
      async stop() { self.handler = null; },
      async request(to, msg) {
        net.sent++;
        const body = JSON.stringify(msg);
        if (body.length > net.maxBytes) throw Object.assign(new Error('message too large'), { code: 'E_P2P_TOO_LARGE' });
        net.log.push({ from: peerId, to, t: msg.t });
        if (net.down.has(peerId) || net.down.has(to) || net.cut.has(peerId + '>' + to) || net.cut.has(to + '>' + peerId)) throw new Error('unreachable');
        if (net.dropRate && Math.random() < net.dropRate) throw new Error('dropped');
        if (net.dropIf && net.dropIf(peerId, to, msg)) throw new Error('dropped');
        const dst = net.nodes.get(to);
        if (!dst || !dst.handler) throw new Error('no_route');
        const resp = await dst.handler(peerId, JSON.parse(body));
        const rb = JSON.stringify(resp == null ? { ok: false } : resp);
        if (rb.length > net.maxBytes) throw Object.assign(new Error('response too large'), { code: 'E_P2P_TOO_LARGE' });
        return JSON.parse(rb);
      },
    };
  }
  setDown(peer, v = true) { if (v) this.down.add(peer); else this.down.delete(peer); }
  /** Cut links between two groups (both directions). */
  partition(groupA, groupB) { for (const a of groupA) for (const b of groupB) this.cut.add(a + '>' + b); }
  heal() { this.cut.clear(); this.down.clear(); this.dropRate = 0; this.dropIf = null; }
}

const SEARCH_PROTOCOL = '/cannoi/search/1.0.0';
module.exports = { ResourceGovernor, RateBucket, Libp2pIndexTransport, LoopbackNetwork, PROTOCOL, SEARCH_PROTOCOL };
