'use strict';
/**
 * Distributed event sync engine (Phase 6).
 *
 * - Event-based replication with sequential numbers per (topic, origin)
 * - Incremental sync via checkpoints
 * - Deterministic conflict resolution: higher seq wins; same seq → lexicographically greater event_id wins
 * - Duplicate protection via event_id PK and (topic, origin, seq) UNIQUE
 * - Policies: public | private | local
 * - Persistent checkpoints survive restart
 */
const crypto = require('crypto');

const POLICIES = new Set(['public', 'private', 'local']);

function eventId() {
  return crypto.randomBytes(16).toString('hex');
}

class SyncEngine {
  /**
   * @param {{ db?: object|null, log?: object, localPeerId?: () => string|null }} opts
   */
  constructor(opts = {}) {
    this.db = opts.db || null;
    this.log = opts.log || { debug() {}, info() {}, warn() {} };
    this.localPeerId = opts.localPeerId || (() => null);
    this._memEvents = []; // fallback
    this._memCheckpoints = new Map(); // key peerId\ttopic → { last_seq, last_event_id }
    this._seq = new Map(); // topic → last local seq
  }

  /**
   * Append a local event. Returns the stored event record.
   */
  append(topic, body, { policy = 'public', signature = null } = {}) {
    topic = String(topic || '').slice(0, 128);
    if (!topic) throw Object.assign(new Error('topic required'), { code: 'E_SYNC_TOPIC' });
    if (!POLICIES.has(policy)) policy = 'public';
    // local-only never replicates
    const origin = this.localPeerId() || 'local';
    const seq = (this._seq.get(topic) || 0) + 1;
    this._seq.set(topic, seq);
    const id = eventId();
    const now = Date.now();
    const rec = {
      event_id: id,
      topic,
      seq,
      origin_peer: origin,
      policy,
      body: typeof body === 'string' ? body : JSON.stringify(body ?? null),
      signature: signature || null,
      created_at: now,
    };
    this._storeEvent(rec);
    return rec;
  }

  /**
   * Ingest a remote event. Returns { accepted: boolean, reason?: string }.
   */
  ingest(remote) {
    if (!remote || !remote.event_id || !remote.topic || remote.seq == null) {
      return { accepted: false, reason: 'malformed' };
    }
    const policy = POLICIES.has(remote.policy) ? remote.policy : 'public';
    if (policy === 'local') return { accepted: false, reason: 'local-only' };

    // Duplicate by id
    if (this._getEvent(remote.event_id)) return { accepted: false, reason: 'duplicate' };

    // Conflict on (topic, origin, seq)
    const existing = this._getByOriginSeq(remote.topic, remote.origin_peer, remote.seq);
    if (existing) {
      // Deterministic: greater event_id wins
      if (remote.event_id <= existing.event_id) return { accepted: false, reason: 'conflict-lost' };
      this._deleteEvent(existing.event_id);
    }

    const rec = {
      event_id: String(remote.event_id).slice(0, 128),
      topic: String(remote.topic).slice(0, 128),
      seq: Number(remote.seq) || 0,
      origin_peer: String(remote.origin_peer || 'unknown').slice(0, 128),
      policy,
      body: typeof remote.body === 'string' ? remote.body : JSON.stringify(remote.body ?? null),
      signature: remote.signature ? String(remote.signature).slice(0, 512) : null,
      created_at: Number(remote.created_at) || Date.now(),
    };
    this._storeEvent(rec);
    return { accepted: true };
  }

  /** Events for a topic after a given seq (incremental). */
  listSince(topic, afterSeq = 0, limit = 200) {
    topic = String(topic || '');
    if (this.db) {
      try {
        return this.db.all(
          'SELECT * FROM p2p_sync_events WHERE topic=? AND seq>? AND policy!=? ORDER BY seq ASC LIMIT ?',
          topic, afterSeq, 'local', limit
        );
      } catch { return []; }
    }
    return this._memEvents
      .filter((e) => e.topic === topic && e.seq > afterSeq && e.policy !== 'local')
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  getCheckpoint(peerId, topic) {
    if (this.db) {
      try {
        return this.db.get(
          'SELECT * FROM p2p_sync_checkpoint WHERE peer_id=? AND topic=?',
          peerId, topic
        ) || null;
      } catch { return null; }
    }
    return this._memCheckpoints.get(peerId + '\t' + topic) || null;
  }

  setCheckpoint(peerId, topic, lastSeq, lastEventId = null) {
    const now = Date.now();
    if (this.db) {
      try {
        this.db.run(
          `INSERT INTO p2p_sync_checkpoint(peer_id, topic, last_seq, last_event_id, updated_at)
           VALUES(?,?,?,?,?)
           ON CONFLICT(peer_id, topic) DO UPDATE SET last_seq=excluded.last_seq, last_event_id=excluded.last_event_id, updated_at=excluded.updated_at`,
          peerId, topic, lastSeq, lastEventId, now
        );
      } catch (e) {
        this.log.debug('checkpoint save: ' + (e && e.message));
      }
      return;
    }
    this._memCheckpoints.set(peerId + '\t' + topic, {
      peer_id: peerId, topic, last_seq: lastSeq, last_event_id: lastEventId, updated_at: now,
    });
  }

  /**
   * Build an incremental sync payload for a remote peer based on checkpoint.
   */
  buildSyncRequest(peerId, topic) {
    const cp = this.getCheckpoint(peerId, topic);
    return { topic, after_seq: cp ? cp.last_seq : 0 };
  }

  /**
   * Apply a batch of remote events and advance checkpoint.
   */
  applySyncBatch(peerId, topic, events) {
    let accepted = 0;
    let maxSeq = this.getCheckpoint(peerId, topic)?.last_seq || 0;
    let lastId = null;
    for (const ev of events || []) {
      const r = this.ingest(ev);
      if (r.accepted) {
        accepted++;
        if (ev.seq >= maxSeq) { maxSeq = ev.seq; lastId = ev.event_id; }
      }
    }
    if (accepted > 0) this.setCheckpoint(peerId, topic, maxSeq, lastId);
    return { accepted, last_seq: maxSeq };
  }

  stats() {
    if (this.db) {
      try {
        const events = this.db.get('SELECT COUNT(*) c FROM p2p_sync_events');
        const cps = this.db.get('SELECT COUNT(*) c FROM p2p_sync_checkpoint');
        return { events: events ? events.c : 0, checkpoints: cps ? cps.c : 0 };
      } catch { return { events: 0, checkpoints: 0 }; }
    }
    return { events: this._memEvents.length, checkpoints: this._memCheckpoints.size };
  }

  // ---------- storage ----------

  _storeEvent(rec) {
    if (this.db) {
      try {
        this.db.run(
          `INSERT OR IGNORE INTO p2p_sync_events(event_id, topic, seq, origin_peer, policy, body, signature, created_at)
           VALUES(?,?,?,?,?,?,?,?)`,
          rec.event_id, rec.topic, rec.seq, rec.origin_peer, rec.policy, rec.body, rec.signature, rec.created_at
        );
      } catch (e) {
        this.log.debug('store event: ' + (e && e.message));
      }
      return;
    }
    this._memEvents.push(rec);
    if (this._memEvents.length > 5000) this._memEvents = this._memEvents.slice(-4000);
  }

  _getEvent(id) {
    if (this.db) {
      try { return this.db.get('SELECT * FROM p2p_sync_events WHERE event_id=?', id); }
      catch { return null; }
    }
    return this._memEvents.find((e) => e.event_id === id) || null;
  }

  _getByOriginSeq(topic, origin, seq) {
    if (this.db) {
      try {
        return this.db.get(
          'SELECT * FROM p2p_sync_events WHERE topic=? AND origin_peer=? AND seq=?',
          topic, origin, seq
        );
      } catch { return null; }
    }
    return this._memEvents.find((e) => e.topic === topic && e.origin_peer === origin && e.seq === seq) || null;
  }

  _deleteEvent(id) {
    if (this.db) {
      try { this.db.run('DELETE FROM p2p_sync_events WHERE event_id=?', id); } catch { /* ignore */ }
      return;
    }
    this._memEvents = this._memEvents.filter((e) => e.event_id !== id);
  }
}

module.exports = { SyncEngine, POLICIES };
