'use strict';
/**
 * GossipSub façade (Phase 6).
 * Topic policies, rate limiting, duplicate suppression, signed payload envelope.
 * Works without GossipSub package (no-op publish/subscribe).
 */
const crypto = require('crypto');

const DEFAULT_TOPICS = {
  // policy: public = anyone, private = authenticated peers only, local = never gossip
  'cannoi/presence': 'public',
  'cannoi/events': 'public',
  'cannoi/sync': 'public',
};

class GossipFacade {
  /**
   * @param {{
   *   getPubsub: () => any,
   *   log?: object,
   *   ratePerMin?: number,
   *   maxMessageSize?: number,
   *   topicPolicies?: Record<string,string>,
   *   localPeerId?: () => string|null,
   * }} opts
   */
  constructor(opts) {
    this.getPubsub = opts.getPubsub;
    this.log = opts.log || { debug() {}, info() {}, warn() {} };
    this.ratePerMin = opts.ratePerMin || 120;
    this.maxMessageSize = opts.maxMessageSize || 65536;
    this.topicPolicies = { ...DEFAULT_TOPICS, ...(opts.topicPolicies || {}) };
    this.localPeerId = opts.localPeerId || (() => null);
    this._handlers = new Map(); // topic → Set<fn>
    this._seen = new Map(); // msg id → ts
    this._rate = new Map(); // key → { n, reset }
    this._subscribed = new Set();
    this._bound = false;
  }

  policyOf(topic) {
    return this.topicPolicies[topic] || 'public';
  }

  setPolicy(topic, policy) {
    if (!['public', 'private', 'local'].includes(policy)) return;
    this.topicPolicies[topic] = policy;
  }

  async start() {
    const ps = this.getPubsub();
    if (!ps || this._bound) return;
    try {
      ps.addEventListener('message', (evt) => this._onMessage(evt));
      this._bound = true;
    } catch (e) {
      this.log.debug('gossip bind: ' + (e && e.message));
    }
  }

  stop() {
    this._handlers.clear();
    this._subscribed.clear();
    this._bound = false;
  }

  subscribe(topic, handler) {
    topic = String(topic || '');
    if (!topic) return () => {};
    if (this.policyOf(topic) === 'local') {
      // local-only: still allow local handlers, never mesh
      if (!this._handlers.has(topic)) this._handlers.set(topic, new Set());
      this._handlers.get(topic).add(handler);
      return () => this._handlers.get(topic)?.delete(handler);
    }
    if (!this._handlers.has(topic)) this._handlers.set(topic, new Set());
    this._handlers.get(topic).add(handler);
    const ps = this.getPubsub();
    if (ps && typeof ps.subscribe === 'function' && !this._subscribed.has(topic)) {
      try {
        ps.subscribe(topic);
        this._subscribed.add(topic);
      } catch (e) {
        this.log.debug('gossip subscribe: ' + (e && e.message));
      }
    }
    return () => {
      this._handlers.get(topic)?.delete(handler);
    };
  }

  async publish(topic, data, { signature = null } = {}) {
    topic = String(topic || '');
    if (!topic) {
      const e = new Error('topic required'); e.code = 'E_GOSSIP_TOPIC'; throw e;
    }
    if (this.policyOf(topic) === 'local') {
      // deliver only to local handlers
      const envelope = this._envelope(topic, data, signature);
      this._dispatch(topic, envelope, null);
      return { recipients: 0, local: true };
    }
    if (!this._rateOk('pub:' + topic)) {
      const e = new Error('rate limit exceeded'); e.code = 'E_GOSSIP_RATE'; throw e;
    }
    const envelope = this._envelope(topic, data, signature);
    const raw = Buffer.from(JSON.stringify(envelope), 'utf8');
    if (raw.length > this.maxMessageSize) {
      const e = new Error('message too large'); e.code = 'E_GOSSIP_SIZE'; throw e;
    }
    const ps = this.getPubsub();
    if (ps && typeof ps.publish === 'function') {
      try {
        await ps.publish(topic, raw);
        return { recipients: -1, local: false };
      } catch (e) {
        this.log.debug('gossip publish: ' + (e && e.message));
        throw e;
      }
    }
    // no pubsub — local only
    this._dispatch(topic, envelope, null);
    return { recipients: 0, local: true };
  }

  topics() {
    return [...this._subscribed];
  }

  // ---------- internals ----------

  _envelope(topic, data, signature) {
    const id = crypto.randomBytes(12).toString('hex');
    return {
      id,
      topic,
      from: this.localPeerId() || null,
      ts: Date.now(),
      data: data == null ? null : data,
      signature: signature || null,
    };
  }

  _onMessage(evt) {
    try {
      const detail = evt.detail || evt;
      const topic = detail.topic;
      let envelope;
      try {
        const text = typeof detail.data === 'string'
          ? detail.data
          : Buffer.from(detail.data).toString('utf8');
        envelope = JSON.parse(text);
      } catch {
        return;
      }
      if (!envelope || !envelope.id) return;
      if (this._seen.has(envelope.id)) return;
      this._seen.set(envelope.id, Date.now());
      this._pruneSeen();
      if (this.policyOf(topic) === 'local') return;
      if (!this._rateOk('rx:' + topic)) return;
      this._dispatch(topic, envelope, detail.from ? String(detail.from) : null);
    } catch (e) {
      this.log.debug('gossip onMessage: ' + (e && e.message));
    }
  }

  _dispatch(topic, envelope, fromPeer) {
    const set = this._handlers.get(topic);
    if (!set) return;
    for (const h of set) {
      try { h({ topic, data: envelope.data, from: envelope.from || fromPeer, id: envelope.id, ts: envelope.ts, signature: envelope.signature }); }
      catch { /* ignore */ }
    }
  }

  _rateOk(key) {
    const now = Date.now();
    let e = this._rate.get(key);
    if (!e || e.reset <= now) {
      e = { n: 0, reset: now + 60000 };
      this._rate.set(key, e);
    }
    e.n++;
    return e.n <= this.ratePerMin;
  }

  _pruneSeen() {
    if (this._seen.size < 2000) return;
    const cutoff = Date.now() - 600000;
    for (const [id, ts] of this._seen) {
      if (ts < cutoff) this._seen.delete(id);
    }
  }
}

module.exports = { GossipFacade, DEFAULT_TOPICS };
