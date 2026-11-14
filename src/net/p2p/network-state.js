'use strict';
/**
 * Network State Manager (Phase 7).
 *
 * Formal states:
 *   GLOBAL_ONLINE   — public reachability + healthy direct peers
 *   GLOBAL_DEGRADED — some Internet path, but unstable or mostly relayed
 *   LAN_ONLY        — only local/mDNS peers; no working Internet path
 *   RELAY_ONLY      — only relayed connections; no direct / LAN
 *   OFFLINE         — no peers, no path
 *   RECOVERING      — transitioning upward after a failure
 *
 * Preferences (highest first):
 *   1. LAN / local direct
 *   2. Internet direct
 *   3. Relayed
 *   4. Store-and-forward (offline queue)
 *
 * Anti-flapping: minimum dwell time + signal hysteresis before downward transitions.
 */

const STATES = Object.freeze({
  GLOBAL_ONLINE: 'GLOBAL_ONLINE',
  GLOBAL_DEGRADED: 'GLOBAL_DEGRADED',
  LAN_ONLY: 'LAN_ONLY',
  RELAY_ONLY: 'RELAY_ONLY',
  OFFLINE: 'OFFLINE',
  RECOVERING: 'RECOVERING',
});

/** Rank for comparison (higher = better connectivity). */
const RANK = {
  [STATES.OFFLINE]: 0,
  [STATES.RELAY_ONLY]: 1,
  [STATES.LAN_ONLY]: 2,
  [STATES.GLOBAL_DEGRADED]: 3,
  [STATES.RECOVERING]: 3,
  [STATES.GLOBAL_ONLINE]: 4,
};

const DEFAULT_DWELL_MS = 8000;       // min time in a state before downward move
const DEFAULT_RECOVER_MS = 5000;     // time in RECOVERING before promoting
const DEFAULT_OFFLINE_PEER_MAX = 0;

/**
 * @typedef {object} NetworkSignals
 * @property {number} peers              - active connections
 * @property {number} directPeers        - non-relay connections
 * @property {number} relayPeers         - relayed connections
 * @property {number} lanPeers           - LAN/mDNS known peers (may or may not be connected)
 * @property {number} knownRelays        - configured/known relay multiaddrs
 * @property {'public'|'private'|'unknown'} reachability
 * @property {boolean} nodeRunning
 * @property {number} pendingMessages
 * @property {boolean} mdnsEnabled
 * @property {boolean} discoveryEnabled
 */

class NetworkStateManager {
  /**
   * @param {{
   *   log?: object,
   *   dwellMs?: number,
   *   recoverMs?: number,
   *   onTransition?: (from: string, to: string, signals: NetworkSignals) => void,
   * }} opts
   */
  constructor(opts = {}) {
    this.log = opts.log || { debug() {}, info() {}, warn() {} };
    this.dwellMs = opts.dwellMs > 0 ? opts.dwellMs : DEFAULT_DWELL_MS;
    this.recoverMs = opts.recoverMs > 0 ? opts.recoverMs : DEFAULT_RECOVER_MS;
    this.onTransition = opts.onTransition || null;

    this._state = STATES.OFFLINE;
    this._enteredAt = Date.now();
    this._lastSignals = null;
    this._history = []; // { at, from, to }
    this._flapCount = 0;
    this._lastDownAt = 0;
  }

  state() { return this._state; }

  rank() { return RANK[this._state] ?? 0; }

  /** Preferred transport for new outbound work. */
  preferredTransport() {
    switch (this._state) {
      case STATES.LAN_ONLY:
        return 'lan';
      case STATES.GLOBAL_ONLINE:
        return 'direct';
      case STATES.GLOBAL_DEGRADED:
        return 'direct_or_relay';
      case STATES.RELAY_ONLY:
        return 'relay';
      case STATES.RECOVERING:
        return 'any';
      case STATES.OFFLINE:
      default:
        return 'store_and_forward';
    }
  }

  /**
   * Evaluate signals and possibly transition.
   * @param {NetworkSignals} signals
   * @returns {{ state: string, changed: boolean, preferred: string }}
   */
  evaluate(signals) {
    this._lastSignals = signals;
    const desired = this._classify(signals);
    const now = Date.now();
    const elapsed = now - this._enteredAt;
    const current = this._state;

    if (desired === current) {
      // Promote out of RECOVERING after recoverMs if still healthy
      if (current === STATES.RECOVERING && elapsed >= this.recoverMs) {
        const promoted = this._classify(signals, { allowRecovering: false });
        if (promoted !== STATES.OFFLINE && promoted !== STATES.RECOVERING) {
          this._transition(promoted, signals, now);
          return this._result(true);
        }
      }
      return this._result(false);
    }

    const goingDown = (RANK[desired] ?? 0) < (RANK[current] ?? 0);
    const goingUp = (RANK[desired] ?? 0) > (RANK[current] ?? 0);

    // Upward transitions are fast (except OFFLINE → RECOVERING first)
    if (goingUp) {
      if (current === STATES.OFFLINE && desired !== STATES.OFFLINE) {
        this._transition(STATES.RECOVERING, signals, now);
        return this._result(true);
      }
      if (current === STATES.RECOVERING) {
        // stay until recoverMs unless we drop again
        if (elapsed >= this.recoverMs) {
          this._transition(desired, signals, now);
          return this._result(true);
        }
        return this._result(false);
      }
      this._transition(desired, signals, now);
      return this._result(true);
    }

    // Downward: require dwell time to avoid flapping
    if (goingDown) {
      if (elapsed < this.dwellMs) {
        return this._result(false);
      }
      // Extra hysteresis: require clear signal for OFFLINE
      if (desired === STATES.OFFLINE) {
        const peers = (signals.peers || 0) + (signals.lanPeers || 0);
        if (peers > DEFAULT_OFFLINE_PEER_MAX) {
          // still have some awareness — prefer LAN_ONLY or RELAY_ONLY
          const alt = this._classify(signals, { forceOffline: false });
          if (alt !== STATES.OFFLINE) {
            this._transition(alt, signals, now);
            return this._result(true);
          }
        }
      }
      this._lastDownAt = now;
      this._flapCount++;
      this._transition(desired, signals, now);
      return this._result(true);
    }

    return this._result(false);
  }

  history(limit = 20) {
    return this._history.slice(-limit);
  }

  snapshot() {
    return {
      state: this._state,
      preferred_transport: this.preferredTransport(),
      entered_at: this._enteredAt,
      dwell_ms: this.dwellMs,
      flap_count: this._flapCount,
      signals: this._lastSignals ? { ...this._lastSignals } : null,
    };
  }

  /** Force a state (tests / emergency). */
  force(state) {
    if (!STATES[state]) return;
    this._transition(state, this._lastSignals || {}, Date.now());
  }

  // ---------- classification ----------

  /**
   * @param {NetworkSignals} s
   * @param {{ allowRecovering?: boolean, forceOffline?: boolean }} [opts]
   */
  _classify(s, opts = {}) {
    if (!s || !s.nodeRunning) return STATES.OFFLINE;

    const direct = s.directPeers || 0;
    const relay = s.relayPeers || 0;
    const lan = s.lanPeers || 0;
    const peers = s.peers || 0;
    const reach = s.reachability || 'unknown';

    // Healthy public + direct peers
    if (reach === 'public' && direct >= 1) {
      return STATES.GLOBAL_ONLINE;
    }

    // Public but only relay / unstable
    if (reach === 'public' && (relay >= 1 || direct >= 1)) {
      return direct >= 1 ? STATES.GLOBAL_ONLINE : STATES.GLOBAL_DEGRADED;
    }

    // Has direct peers but reachability private/unknown → could be LAN or degraded global
    if (direct >= 1 && lan >= 1) {
      return STATES.LAN_ONLY;
    }
    if (direct >= 1 && reach !== 'public') {
      // direct private addresses
      return lan > 0 || s.mdnsEnabled ? STATES.LAN_ONLY : STATES.GLOBAL_DEGRADED;
    }

    // Only relayed connections
    if (relay >= 1 && direct === 0) {
      return STATES.RELAY_ONLY;
    }

    // LAN awareness without active connections
    if (lan >= 1 && peers === 0) {
      return STATES.LAN_ONLY;
    }

    // Known relays but not connected — still not fully offline for routing intent
    if ((s.knownRelays || 0) > 0 && peers === 0 && lan === 0) {
      return STATES.RELAY_ONLY;
    }

    if (peers === 0 && lan === 0) return STATES.OFFLINE;

    // Fallback: some peers but unclear topology
    if (peers > 0) return STATES.GLOBAL_DEGRADED;
    return STATES.OFFLINE;
  }

  _transition(to, signals, now) {
    const from = this._state;
    if (from === to) return;
    this._state = to;
    this._enteredAt = now;
    this._history.push({ at: now, from, to });
    if (this._history.length > 100) this._history = this._history.slice(-80);
    this.log.info('network state ' + from + ' → ' + to +
      ' (peers=' + (signals.peers || 0) +
      ' direct=' + (signals.directPeers || 0) +
      ' relay=' + (signals.relayPeers || 0) +
      ' lan=' + (signals.lanPeers || 0) +
      ' reach=' + (signals.reachability || '?') + ')');
    if (typeof this.onTransition === 'function') {
      try { this.onTransition(from, to, signals); } catch { /* ignore */ }
    }
  }

  _result(changed) {
    return {
      state: this._state,
      changed,
      preferred: this.preferredTransport(),
    };
  }
}

module.exports = { NetworkStateManager, STATES, RANK };
