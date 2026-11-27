'use strict';
/**
 * Phase 3 — Trust & Protection Engine
 * Independent of content quality. Peer ID is identity; IP is only an endpoint signal.
 *
 * States: NEW → PROBATION → TRUSTED | LIMITED | QUARANTINED | BLOCKED
 * Does not invent a second P2P stack; gates dials, register, and sync quotas.
 */
const netLog = require('../network-log');

const TRUST = Object.freeze({
  NEW: 'NEW',
  PROBATION: 'PROBATION',
  TRUSTED: 'TRUSTED',
  LIMITED: 'LIMITED',
  QUARANTINED: 'QUARANTINED',
  BLOCKED: 'BLOCKED',
});

const RANK = {
  [TRUST.BLOCKED]: -2,
  [TRUST.QUARANTINED]: -1,
  [TRUST.NEW]: 0,
  [TRUST.PROBATION]: 1,
  [TRUST.LIMITED]: 2,
  [TRUST.TRUSTED]: 3,
};

/** Default quotas (requests per window) by trust state */
const DEFAULT_QUOTA = {
  [TRUST.NEW]: { dials: 3, register: 2, sync_events: 20, window_ms: 60000 },
  [TRUST.PROBATION]: { dials: 8, register: 5, sync_events: 100, window_ms: 60000 },
  [TRUST.TRUSTED]: { dials: 30, register: 20, sync_events: 500, window_ms: 60000 },
  [TRUST.LIMITED]: { dials: 2, register: 1, sync_events: 10, window_ms: 60000 },
  [TRUST.QUARANTINED]: { dials: 0, register: 0, sync_events: 0, window_ms: 60000 },
  [TRUST.BLOCKED]: { dials: 0, register: 0, sync_events: 0, window_ms: 60000 },
};

class TrustEngine {
  /**
   * @param {{ log?: object, maxPeers?: number, quarantineMs?: number }} opts
   */
  constructor(opts = {}) {
    this.log = opts.log || { debug() {}, info() {}, warn() {} };
    this.maxPeers = opts.maxPeers || 500;
    this.quarantineMs = opts.quarantineMs || 30 * 60000;
    this._peers = new Map(); // id -> record
    this._global = { windowStart: Date.now(), dials: 0, registers: 0, maxDials: 120, maxRegisters: 60 };
  }

  _id(peerId) {
    return String(peerId || '').slice(0, 80);
  }

  _ensure(peerId) {
    const id = this._id(peerId);
    if (!id) return null;
    let r = this._peers.get(id);
    if (!r) {
      if (this._peers.size >= this.maxPeers) {
        // Evict oldest NEW with no success
        let victim = null;
        for (const [k, v] of this._peers) {
          if (v.state === TRUST.NEW && v.successes === 0) {
            if (!victim || v.seen_at < victim.seen_at) victim = { k, seen_at: v.seen_at };
          }
        }
        if (victim) this._peers.delete(victim.k);
        else return null;
      }
      r = {
        peer_id: id,
        state: TRUST.NEW,
        successes: 0,
        failures: 0,
        abuse: 0,
        seen_at: Date.now(),
        updated_at: Date.now(),
        quarantine_until: 0,
        window_start: Date.now(),
        window: { dials: 0, register: 0, sync_events: 0 },
      };
      this._peers.set(id, r);
    }
    // Auto exit quarantine
    if (r.state === TRUST.QUARANTINED && r.quarantine_until && Date.now() > r.quarantine_until) {
      r.state = TRUST.PROBATION;
      r.quarantine_until = 0;
      r.updated_at = Date.now();
    }
    return r;
  }

  _rollWindow(r) {
    const q = DEFAULT_QUOTA[r.state] || DEFAULT_QUOTA[TRUST.NEW];
    if (Date.now() - r.window_start > q.window_ms) {
      r.window_start = Date.now();
      r.window = { dials: 0, register: 0, sync_events: 0 };
    }
    return q;
  }

  _rollGlobal() {
    if (Date.now() - this._global.windowStart > 60000) {
      this._global.windowStart = Date.now();
      this._global.dials = 0;
      this._global.registers = 0;
    }
  }

  observe(peerId, { success, failure, abuse, bootstrap } = {}) {
    const r = this._ensure(peerId);
    if (!r) return null;
    if (bootstrap && r.state === TRUST.NEW) {
      r.state = TRUST.PROBATION;
    }
    if (success) {
      r.successes++;
      r.failures = Math.max(0, r.failures - 1);
      if (r.state === TRUST.NEW && r.successes >= 1) r.state = TRUST.PROBATION;
      if (r.state === TRUST.PROBATION && r.successes >= 5 && r.failures < 2) r.state = TRUST.TRUSTED;
      if (r.state === TRUST.LIMITED && r.successes >= 3) r.state = TRUST.PROBATION;
    }
    if (failure) {
      r.failures++;
      if (r.failures >= 8 && r.successes < 2) r.state = TRUST.LIMITED;
      if (r.failures >= 20) this.quarantine(peerId, 'too_many_failures');
    }
    if (abuse) {
      r.abuse += Number(abuse) || 1;
      if (r.abuse >= 3) this.quarantine(peerId, 'abuse');
      if (r.abuse >= 10) this.block(peerId, 'repeated_abuse');
    }
    r.seen_at = Date.now();
    r.updated_at = Date.now();
    return r;
  }

  quarantine(peerId, reason) {
    const r = this._ensure(peerId);
    if (!r || r.state === TRUST.BLOCKED) return r;
    r.state = TRUST.QUARANTINED;
    r.quarantine_until = Date.now() + this.quarantineMs;
    r.updated_at = Date.now();
    try { netLog.push('warn', 'quarantine', String(peerId).slice(0, 24) + ' ' + (reason || '')); } catch { /* ignore */ }
    return r;
  }

  block(peerId, reason) {
    const r = this._ensure(peerId);
    if (!r) return null;
    r.state = TRUST.BLOCKED;
    r.updated_at = Date.now();
    try { netLog.push('warn', 'block', String(peerId).slice(0, 24) + ' ' + (reason || '')); } catch { /* ignore */ }
    return r;
  }

  /**
   * @returns {{ ok: boolean, reason?: string, state?: string, remaining?: number }}
   */
  allow(peerId, action = 'dial') {
    this._rollGlobal();
    if (action === 'dial' && this._global.dials >= this._global.maxDials) {
      return { ok: false, reason: 'global_dial_limit', state: 'GLOBAL' };
    }
    if (action === 'register' && this._global.registers >= this._global.maxRegisters) {
      return { ok: false, reason: 'global_register_limit', state: 'GLOBAL' };
    }

    const r = this._ensure(peerId);
    if (!r) return { ok: false, reason: 'capacity', state: TRUST.NEW };
    if (r.state === TRUST.BLOCKED) return { ok: false, reason: 'blocked', state: r.state };
    if (r.state === TRUST.QUARANTINED) return { ok: false, reason: 'quarantined', state: r.state };

    const q = this._rollWindow(r);
    const key = action === 'register' ? 'register' : action === 'sync' ? 'sync_events' : 'dials';
    const limit = q[key] != null ? q[key] : q.dials;
    if (r.window[key] >= limit) {
      return { ok: false, reason: 'quota', state: r.state, remaining: 0 };
    }
    r.window[key] = (r.window[key] || 0) + 1;
    if (action === 'dial') this._global.dials++;
    if (action === 'register') this._global.registers++;
    return { ok: true, state: r.state, remaining: limit - r.window[key] };
  }

  stateOf(peerId) {
    const r = this._peers.get(this._id(peerId));
    return r ? r.state : TRUST.NEW;
  }

  /** Reject obviously invalid peer ids (anti-spoof surface) */
  validatePeerId(peerId) {
    const id = String(peerId || '');
    if (id.length < 30 || id.length > 80) return { ok: false, reason: 'bad_peer_id_length' };
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(id)) return { ok: false, reason: 'bad_peer_id_charset' };
    return { ok: true };
  }

  status() {
    const counts = {};
    for (const s of Object.values(TRUST)) counts[s] = 0;
    for (const r of this._peers.values()) counts[r.state] = (counts[r.state] || 0) + 1;
    return {
      phase: 3,
      peers_tracked: this._peers.size,
      counts,
      global: { dials: this._global.dials, registers: this._global.registers },
    };
  }

  list(limit = 20) {
    return [...this._peers.values()]
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, limit)
      .map((r) => ({
        peer_id: r.peer_id.slice(0, 24),
        state: r.state,
        successes: r.successes,
        failures: r.failures,
        abuse: r.abuse,
      }));
  }
}

module.exports = { TrustEngine, TRUST, RANK, DEFAULT_QUOTA };
