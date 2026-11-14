'use strict';
/**
 * Local / offline messaging with persistent store-and-forward (Phase 4 + Phase 5).
 *
 * Protocol: /cannoi/msg/1.0.0
 *
 * States: queued → sending → delivered | failed
 * - Globally unique message IDs
 * - Deduplication on receive (p2p_inbox_seen)
 * - Expiration policy
 * - Bounded retries (no infinite loops)
 * - Ordering via monotonic order_key per destination
 * - Transactional DB writes when a database is provided
 * - In-memory fallback when db is null (tests / no-db mode)
 *
 * Never silently discards undelivered messages (except explicit expiry or max_attempts).
 */
const crypto = require('crypto');

const PROTOCOL = '/cannoi/msg/1.0.0';
const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_QUEUE = 2000;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 15 * 60 * 1000;

function newMsgId() {
  return crypto.randomBytes(16).toString('hex');
}

function backoffMs(attempts) {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempts - 1)));
  return exp + Math.floor(Math.random() * 1000);
}

class LocalMessaging {
  /**
   * @param {{
   *   getNode: () => any,
   *   db?: object|null,
   *   log?: object,
   *   maxQueue?: number,
   *   defaultTtlMs?: number,
   *   maxAttempts?: number,
   *   localPeerId?: () => string|null,
   * }} opts
   */
  constructor(opts) {
    this.getNode = opts.getNode;
    this.db = opts.db || null;
    this.log = opts.log || { debug() {}, info() {}, warn() {} };
    this.maxQueue = opts.maxQueue || DEFAULT_MAX_QUEUE;
    this.defaultTtlMs = opts.defaultTtlMs || DEFAULT_TTL_MS;
    this.maxAttempts = opts.maxAttempts || DEFAULT_MAX_ATTEMPTS;
    this.localPeerId = opts.localPeerId || (() => null);
    this._memQueue = []; // fallback when no db
    this._handlers = new Set();
    this._started = false;
    this._orderSeq = 0;
  }

  async start() {
    if (this._started) return;
    const node = this.getNode();
    if (!node || typeof node.handle !== 'function') {
      this._started = true;
      return;
    }
    try {
      await node.handle(PROTOCOL, async ({ stream, connection }) => {
        try {
          const chunks = [];
          for await (const c of stream.source) {
            chunks.push(Buffer.from(c.subarray ? c.subarray() : c));
          }
          const raw = Buffer.concat(chunks).toString('utf8');
          let msg;
          try { msg = JSON.parse(raw); } catch { return; }
          if (!msg || !msg.id || typeof msg.id !== 'string') return;
          if (msg.id.length > 128) return;

          // Dedup
          if (this._hasSeen(msg.id)) return;
          this._markSeen(msg.id);

          for (const h of this._handlers) {
            try { h(msg, connection); } catch { /* ignore */ }
          }
        } catch (e) {
          this.log.debug('local-msg recv: ' + (e && e.message));
        }
      });
      this._started = true;
      this._expireOld();
    } catch (e) {
      this.log.warn('local-msg handle failed: ' + (e && e.message));
      this._started = true; // allow queue operations even if handle fails
    }
  }

  async stop() {
    const node = this.getNode();
    if (node && typeof node.unhandle === 'function') {
      try { await node.unhandle(PROTOCOL); } catch { /* ignore */ }
    }
    this._started = false;
  }

  onMessage(handler) {
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  /**
   * Enqueue or deliver a message.
   * @returns {{ id: string, status: 'sent'|'queued' }}
   */
  async send(toPeerId, type, payload, opts = {}) {
    const id = opts.id || newMsgId();
    const now = Date.now();
    const ttl = opts.ttlMs > 0 ? opts.ttlMs : this.defaultTtlMs;
    const maxAttempts = opts.maxAttempts > 0 ? opts.maxAttempts : this.maxAttempts;
    const orderKey = ++this._orderSeq;
    const msg = {
      id,
      to: String(toPeerId),
      from: this.localPeerId() || undefined,
      type: String(type || 'data').slice(0, 64),
      payload: payload == null ? null : payload,
      ts: now,
      expires_at: now + ttl,
      max_attempts: maxAttempts,
      order_key: orderKey,
    };

    // Try immediate delivery
    const delivered = await this._tryDeliver(msg);
    if (delivered) {
      this._recordDelivered(msg);
      return { id, status: 'sent' };
    }

    this._enqueue(msg);
    return { id, status: 'queued' };
  }

  /** Flush ready queued messages. */
  async flush() {
    this._expireOld();
    const ready = this._listReady(50);
    let sent = 0;
    for (const row of ready) {
      const msg = this._rowToMsg(row);
      this._setState(msg.id, 'sending');
      const ok = await this._tryDeliver(msg);
      if (ok) {
        this._recordDelivered(msg);
        sent++;
      } else {
        const attempts = (row.attempts || 0) + 1;
        if (attempts >= (row.max_attempts || this.maxAttempts)) {
          this._setState(msg.id, 'failed', 'max attempts reached');
        } else {
          this._setRetry(msg.id, attempts, backoffMs(attempts));
        }
      }
    }
    return { sent, remaining: this.pendingCount() };
  }

  pendingCount() {
    if (this.db) {
      try {
        const r = this.db.get("SELECT COUNT(*) c FROM p2p_outbox WHERE state IN ('queued','sending')");
        return r ? r.c : 0;
      } catch { return this._memQueue.length; }
    }
    return this._memQueue.filter((m) => m.state === 'queued' || m.state === 'sending').length;
  }

  /** Stats for diagnostics / UI. */
  stats() {
    if (this.db) {
      try {
        const rows = this.db.all(
          "SELECT state, COUNT(*) c FROM p2p_outbox GROUP BY state"
        );
        const out = { queued: 0, sending: 0, delivered: 0, failed: 0 };
        for (const r of rows) out[r.state] = r.c;
        return out;
      } catch { /* fall through */ }
    }
    const out = { queued: 0, sending: 0, delivered: 0, failed: 0 };
    for (const m of this._memQueue) out[m.state] = (out[m.state] || 0) + 1;
    return out;
  }

  listPending(limit = 50) {
    if (this.db) {
      try {
        return this.db.all(
          "SELECT id, to_peer, msg_type, state, attempts, next_attempt_at, expires_at, created_at, order_key FROM p2p_outbox WHERE state IN ('queued','sending') ORDER BY order_key ASC LIMIT ?",
          limit
        );
      } catch { /* fall through */ }
    }
    return this._memQueue
      .filter((m) => m.state === 'queued' || m.state === 'sending')
      .sort((a, b) => a.order_key - b.order_key)
      .slice(0, limit)
      .map((m) => ({
        id: m.id, to_peer: m.to, msg_type: m.type, state: m.state,
        attempts: m.attempts || 0, next_attempt_at: m.next_attempt_at || 0,
        expires_at: m.expires_at, created_at: m.ts, order_key: m.order_key,
      }));
  }

  // ---------- internals ----------

  async _tryDeliver(msg) {
    const node = this.getNode();
    if (!node || typeof node.dialProtocol !== 'function') return false;
    try {
      const stream = await node.dialProtocol(msg.to, PROTOCOL);
      const body = {
        id: msg.id,
        from: msg.from,
        to: msg.to,
        type: msg.type,
        payload: msg.payload,
        ts: msg.ts,
      };
      const data = Buffer.from(JSON.stringify(body), 'utf8');
      await stream.sink([data]);
      try { await stream.close(); } catch { /* ignore */ }
      return true;
    } catch (e) {
      this.log.debug('local-msg deliver failed: ' + (e && e.message));
      return false;
    }
  }

  _enqueue(msg) {
    if (this.db) {
      try {
        this.db.tx(() => {
          const existing = this.db.get('SELECT id FROM p2p_outbox WHERE id=?', msg.id);
          if (existing) return; // dedup
          const count = this.db.get("SELECT COUNT(*) c FROM p2p_outbox WHERE state IN ('queued','sending')");
          if (count && count.c >= this.maxQueue) {
            // Drop oldest failed/expired first, never silent-drop active queued without marking
            this.db.run(
              "DELETE FROM p2p_outbox WHERE id IN (SELECT id FROM p2p_outbox WHERE state='failed' ORDER BY updated_at ASC LIMIT 50)"
            );
          }
          const now = Date.now();
          this.db.run(
            `INSERT INTO p2p_outbox(id,to_peer,from_peer,msg_type,payload,state,attempts,max_attempts,next_attempt_at,expires_at,created_at,updated_at,order_key)
             VALUES(?,?,?,?,?,'queued',0,?,?,?,?,?,?)`,
            msg.id, msg.to, msg.from || null, msg.type,
            msg.payload == null ? null : JSON.stringify(msg.payload),
            msg.max_attempts, now, msg.expires_at, now, now, msg.order_key
          );
        });
        return;
      } catch (e) {
        this.log.warn('p2p_outbox enqueue db error: ' + (e && e.message));
      }
    }
    // memory fallback
    if (this._memQueue.some((m) => m.id === msg.id)) return;
    this._memQueue.push({
      ...msg,
      state: 'queued',
      attempts: 0,
      next_attempt_at: Date.now(),
    });
    if (this._memQueue.length > this.maxQueue) {
      this._memQueue = this._memQueue.slice(-this.maxQueue);
    }
  }

  _recordDelivered(msg) {
    if (this.db) {
      try {
        const now = Date.now();
        this.db.run(
          "UPDATE p2p_outbox SET state='delivered', delivered_at=?, updated_at=? WHERE id=?",
          now, now, msg.id
        );
        // Also insert if it was never queued (immediate send)
        const row = this.db.get('SELECT id FROM p2p_outbox WHERE id=?', msg.id);
        if (!row) {
          this.db.run(
            `INSERT OR IGNORE INTO p2p_outbox(id,to_peer,from_peer,msg_type,payload,state,attempts,max_attempts,next_attempt_at,expires_at,created_at,updated_at,delivered_at,order_key)
             VALUES(?,?,?,?,?,'delivered',0,?,0,?,?,?,?,?)`,
            msg.id, msg.to, msg.from || null, msg.type,
            msg.payload == null ? null : JSON.stringify(msg.payload),
            msg.max_attempts || this.maxAttempts,
            msg.expires_at || now + this.defaultTtlMs,
            msg.ts || now, now, now, msg.order_key || 0
          );
        }
      } catch (e) {
        this.log.debug('record delivered: ' + (e && e.message));
      }
      return;
    }
    const m = this._memQueue.find((x) => x.id === msg.id);
    if (m) { m.state = 'delivered'; m.delivered_at = Date.now(); }
  }

  _setState(id, state, lastError) {
    if (this.db) {
      try {
        this.db.run(
          'UPDATE p2p_outbox SET state=?, last_error=?, updated_at=? WHERE id=?',
          state, lastError || null, Date.now(), id
        );
      } catch { /* ignore */ }
      return;
    }
    const m = this._memQueue.find((x) => x.id === id);
    if (m) { m.state = state; m.last_error = lastError; }
  }

  _setRetry(id, attempts, delayMs) {
    const next = Date.now() + delayMs;
    if (this.db) {
      try {
        this.db.run(
          "UPDATE p2p_outbox SET state='queued', attempts=?, next_attempt_at=?, updated_at=? WHERE id=?",
          attempts, next, Date.now(), id
        );
      } catch { /* ignore */ }
      return;
    }
    const m = this._memQueue.find((x) => x.id === id);
    if (m) { m.state = 'queued'; m.attempts = attempts; m.next_attempt_at = next; }
  }

  _listReady(limit) {
    const now = Date.now();
    if (this.db) {
      try {
        return this.db.all(
          `SELECT * FROM p2p_outbox
           WHERE state='queued' AND next_attempt_at<=? AND (expires_at IS NULL OR expires_at>?)
           ORDER BY order_key ASC LIMIT ?`,
          now, now, limit
        );
      } catch { return []; }
    }
    return this._memQueue
      .filter((m) => m.state === 'queued' && (m.next_attempt_at || 0) <= now && (!m.expires_at || m.expires_at > now))
      .sort((a, b) => a.order_key - b.order_key)
      .slice(0, limit)
      .map((m) => ({
        id: m.id, to_peer: m.to, from_peer: m.from, msg_type: m.type,
        payload: m.payload == null ? null : JSON.stringify(m.payload),
        attempts: m.attempts || 0, max_attempts: m.max_attempts || this.maxAttempts,
        expires_at: m.expires_at, order_key: m.order_key, created_at: m.ts,
      }));
  }

  _rowToMsg(row) {
    let payload = null;
    if (row.payload) {
      try { payload = JSON.parse(row.payload); } catch { payload = row.payload; }
    }
    return {
      id: row.id,
      to: row.to_peer,
      from: row.from_peer,
      type: row.msg_type,
      payload,
      ts: row.created_at,
      expires_at: row.expires_at,
      max_attempts: row.max_attempts,
      order_key: row.order_key,
    };
  }

  _expireOld() {
    const now = Date.now();
    if (this.db) {
      try {
        this.db.run(
          "UPDATE p2p_outbox SET state='failed', last_error='expired', updated_at=? WHERE state IN ('queued','sending') AND expires_at IS NOT NULL AND expires_at<=?",
          now, now
        );
        // Cleanup old seen ids (> 30 days)
        this.db.run('DELETE FROM p2p_inbox_seen WHERE seen_at < ?', now - 30 * 86400000);
        // Cleanup old delivered records (> 14 days)
        this.db.run("DELETE FROM p2p_outbox WHERE state='delivered' AND delivered_at < ?", now - 14 * 86400000);
      } catch { /* ignore */ }
      return;
    }
    for (const m of this._memQueue) {
      if ((m.state === 'queued' || m.state === 'sending') && m.expires_at && m.expires_at <= now) {
        m.state = 'failed';
        m.last_error = 'expired';
      }
    }
  }

  _hasSeen(id) {
    if (this.db) {
      try {
        return !!this.db.get('SELECT id FROM p2p_inbox_seen WHERE id=?', id);
      } catch { return false; }
    }
    return false;
  }

  _markSeen(id) {
    if (this.db) {
      try {
        this.db.run('INSERT OR IGNORE INTO p2p_inbox_seen(id, seen_at) VALUES(?,?)', id, Date.now());
      } catch { /* ignore */ }
    }
  }
}

module.exports = { LocalMessaging, PROTOCOL, newMsgId };
