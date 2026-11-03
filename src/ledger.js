'use strict';
// Append-only signed event ledger (public events only) + deterministic ingestion.
//
// What this provides (and nothing more): per-actor hash-chained, signed, sequence-checked event logs with
// idempotent ingestion, fork/gap detection and rebuildable local views. It is NOT a consensus protocol:
// there is no global ordering, no Byzantine fault tolerance and no censorship resistance.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { canonicalize, sha256hex, safeJsonParse } = require('./util');
const { accountIdFromPub, isAccountId, verify } = require('./keystore');

const SCHEMA_VERSION = 1;
const SIG_DOMAIN = 'hub-event-v1';
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_BATCH = 200;
const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;
const MIN_TS = Date.UTC(2020, 0, 1);
const EVENT_ID_RE = /^ev1_[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const REACTIONS = ['like', 'love', 'haha', 'wow', 'sad'];

class LedgerError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }
const bad = (code, msg) => { throw new LedgerError(code, msg); };

const isStr = (v, max, min = 0) => typeof v === 'string' && v.length >= min && v.length <= max && !v.includes('\0');
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
function onlyKeys(obj, allowed) { for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad('invalid_payload', `unknown field ${k}`); }
function validMedia(list) {
  if (!Array.isArray(list) || list.length > 4) bad('invalid_payload', 'media');
  for (const m of list) {
    if (!m || typeof m !== 'object') bad('invalid_payload', 'media item');
    onlyKeys(m, ['hash', 'mime', 'size', 'name']);
    if (!HASH_RE.test(m.hash || '') || !/^[a-z]+\/[a-z0-9.+-]{1,60}$/.test(m.mime || '') || !isInt(m.size, 0, 2 ** 31) || !isStr(m.name, 120)) bad('invalid_payload', 'media item');
  }
}
function isHttpUrl(u) { try { const x = new URL(u); return (x.protocol === 'http:' || x.protocol === 'https:') && u.length <= 200 && !x.username && !x.password; } catch { return false; } }

/** Per-type schemas. Version 1 of every type. Unknown types/versions are rejected (never half-applied). */
const TYPES = {
  'profile.update'(e) {
    onlyKeys(e.payload, ['display_name', 'bio', 'avatar']);
    const p = e.payload;
    if (p.display_name !== undefined && !isStr(p.display_name, 50, 1)) bad('invalid_payload', 'display_name');
    if (p.bio !== undefined && !isStr(p.bio, 300)) bad('invalid_payload', 'bio');
    if (p.avatar !== undefined && p.avatar !== null && !HASH_RE.test(p.avatar)) bad('invalid_payload', 'avatar');
  },
  'post.create'(e) {
    onlyKeys(e.payload, ['content', 'media', 'kind', 'lang']);
    const p = e.payload;
    if (!isStr(p.content, 2000)) bad('invalid_payload', 'content');
    if (!['post', 'reply', 'repost', 'quote'].includes(p.kind)) bad('invalid_payload', 'kind');
    if (p.media !== undefined) validMedia(p.media);
    if (p.lang !== undefined && !/^[a-z]{2,3}$/.test(p.lang)) bad('invalid_payload', 'lang');
    if (p.kind === 'reply' && !e.parent) bad('invalid_payload', 'reply needs parent');
    if ((p.kind === 'repost' || p.kind === 'quote') && !e.target) bad('invalid_payload', 'repost/quote needs target');
    if (p.kind === 'post' && (e.parent || e.target)) bad('invalid_payload', 'post cannot reference');
    if (p.kind !== 'repost' && !p.content.trim() && !(p.media && p.media.length)) bad('invalid_payload', 'empty post');
  },
  'post.edit'(e) {
    onlyKeys(e.payload, ['content', 'media']);
    if (!e.target) bad('invalid_payload', 'target');
    if (!isStr(e.payload.content, 2000)) bad('invalid_payload', 'content');
    if (e.payload.media !== undefined) validMedia(e.payload.media);
  },
  'post.delete'(e) { onlyKeys(e.payload, []); if (!e.target) bad('invalid_payload', 'target'); },
  'react.add'(e) { onlyKeys(e.payload, ['kind']); if (!e.target || !REACTIONS.includes(e.payload.kind)) bad('invalid_payload', 'reaction'); },
  'react.remove'(e) { onlyKeys(e.payload, []); if (!e.target) bad('invalid_payload', 'target'); },
  'follow.add'(e) { onlyKeys(e.payload, ['account']); if (!isAccountId(e.payload.account) || e.payload.account === e.actor_id) bad('invalid_payload', 'account'); },
  'follow.remove'(e) { onlyKeys(e.payload, ['account']); if (!isAccountId(e.payload.account)) bad('invalid_payload', 'account'); },
  'endpoint.announce'(e) {
    onlyKeys(e.payload, ['endpoints', 'name']);
    const p = e.payload;
    if (!Array.isArray(p.endpoints) || p.endpoints.length < 1 || p.endpoints.length > 3 || !p.endpoints.every(isHttpUrl)) bad('invalid_payload', 'endpoints');
    if (p.name !== undefined && !isStr(p.name, 60)) bad('invalid_payload', 'name');
  },
};

const ENVELOPE_KEYS = ['schema_version', 'actor_id', 'actor_pub', 'sequence', 'previous_event_hash', 'created_at', 'event_type', 'payload', 'parent', 'target', 'signature', 'event_id'];

function unsignedOf(ev) {
  const u = {};
  for (const k of ENVELOPE_KEYS) if (k !== 'signature' && k !== 'event_id' && ev[k] !== undefined) u[k] = ev[k];
  return u;
}
const computeEventId = (unsigned) => 'ev1_' + sha256hex(canonicalize(unsigned));

/** Structural validation (no crypto, no DB). Throws LedgerError. */
function validateShape(ev, now = Date.now()) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) bad('malformed', 'not an object');
  for (const k of Object.keys(ev)) if (!ENVELOPE_KEYS.includes(k)) bad('malformed', `unknown envelope field ${k}`);
  if (ev.schema_version !== SCHEMA_VERSION) bad('unsupported_schema', `schema_version ${ev.schema_version}`);
  if (typeof ev.event_type !== 'string' || !TYPES[ev.event_type]) bad('unsupported_type', String(ev.event_type).slice(0, 40));
  if (!isAccountId(ev.actor_id)) bad('malformed', 'actor_id');
  if (typeof ev.actor_pub !== 'string' || ev.actor_pub.length !== 43) bad('malformed', 'actor_pub');
  if (!isInt(ev.sequence, 1, 2 ** 40)) bad('malformed', 'sequence');
  if (ev.sequence === 1 ? ev.previous_event_hash !== null : !EVENT_ID_RE.test(ev.previous_event_hash || '')) bad('malformed', 'previous_event_hash');
  if (!isInt(ev.created_at, MIN_TS, now + MAX_FUTURE_SKEW_MS)) bad('bad_timestamp', 'created_at out of range');
  for (const r of ['parent', 'target']) if (ev[r] !== undefined && !EVENT_ID_RE.test(ev[r])) bad('malformed', r);
  if (!ev.payload || typeof ev.payload !== 'object' || Array.isArray(ev.payload)) bad('malformed', 'payload');
  if (typeof ev.signature !== 'string' || ev.signature.length !== 86) bad('malformed', 'signature');
  let canon;
  try { canon = canonicalize(unsignedOf(ev)); } catch (e) { bad('malformed', e.message); }
  if (Buffer.byteLength(canon) > MAX_EVENT_BYTES) bad('too_large');
  TYPES[ev.event_type](ev);
  return canon;
}

function verifyEnvelope(ev, now = Date.now()) {
  const canon = validateShape(ev, now);
  if (accountIdFromPub(Buffer.from(ev.actor_pub, 'base64url')) !== ev.actor_id) bad('actor_mismatch', 'actor_id is not derived from actor_pub');
  if (ev.event_id !== 'ev1_' + sha256hex(canon)) bad('bad_event_id');
  if (!verify(ev.actor_pub, SIG_DOMAIN, canon, ev.signature)) bad('bad_signature');
  return true;
}

class Ledger {
  /**
   * @param {Db} db
   * @param {Keystore} keystore
   * @param {{apply:Function, reset:Function}} materializer
   */
  constructor(db, keystore, materializer, log) {
    this.db = db; this.ks = keystore; this.mat = materializer; this.log = log || { warn() {}, info() {}, debug() {} };
    this.bus = new EventEmitter();
    this.isBlocked = () => false; // set by app: local moderation hook (actor_id) => bool
  }

  head() { return this.db.get('SELECT COALESCE(MAX(lid),0) AS lid, COUNT(*) AS n FROM events'); }
  actorState(actor) { return this.db.get('SELECT * FROM actor_state WHERE actor_id=?', actor); }

  /** Build + sign + ingest a new event for a LOCAL account. */
  publish(accountId, eventType, payload, refs = {}, now = Date.now()) {
    if (!this.ks.has(accountId)) throw new LedgerError('not_local', 'no private key for this account');
    const st = this.actorState(accountId);
    const ev = {
      schema_version: SCHEMA_VERSION, actor_id: accountId, actor_pub: this.ks.publicKey(accountId),
      sequence: st ? st.last_seq + 1 : 1, previous_event_hash: st ? st.last_event_id : null,
      created_at: now, event_type: eventType, payload,
    };
    if (refs.parent) ev.parent = refs.parent;
    if (refs.target) ev.target = refs.target;
    const canon = canonicalize(unsignedOf(ev));
    ev.event_id = 'ev1_' + sha256hex(canon);
    ev.signature = this.ks.sign(accountId, SIG_DOMAIN, canon);
    const r = this.ingest(ev, { source: 'local', now });
    if (r.status !== 'accepted') throw new LedgerError(r.reason || r.status, `publish failed: ${r.status} ${r.reason || ''}`);
    return ev;
  }

  /**
   * Ingest one remote/local event. Idempotent. Returns {status, reason?, expected?, event_id?}
   * status: accepted | duplicate | rejected | gap | conflict
   */
  ingest(ev, { source = 'unknown', now = Date.now() } = {}) {
    try { verifyEnvelope(ev, now); } catch (e) {
      if (e instanceof LedgerError) return { status: 'rejected', reason: e.code, event_id: typeof ev?.event_id === 'string' ? ev.event_id.slice(0, 80) : undefined };
      throw e;
    }
    if (this.db.get('SELECT 1 x FROM events WHERE event_id=?', ev.event_id)) return { status: 'duplicate', event_id: ev.event_id };
    if (source !== 'local' && this.isBlocked(ev.actor_id)) return { status: 'rejected', reason: 'actor_blocked', event_id: ev.event_id };
    try {
      return this.db.tx(() => {
        const st = this.actorState(ev.actor_id);
        const expected = st ? st.last_seq + 1 : 1;
        if (st && st.pubkey !== ev.actor_pub) return { status: 'rejected', reason: 'actor_mismatch', event_id: ev.event_id };
        if (ev.sequence < expected) {
          const kept = this.db.get('SELECT event_id FROM events WHERE actor_id=? AND sequence=?', ev.actor_id, ev.sequence);
          this._conflict(ev, kept?.event_id, 'sequence_fork', source, now);
          return { status: 'conflict', reason: 'sequence_fork', event_id: ev.event_id };
        }
        if (ev.sequence > expected) {
          this.db.run('INSERT INTO ledger_gaps(actor_id,expected_seq,seen_seq,source,detected_at) VALUES(?,?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET seen_seq=MAX(seen_seq,excluded.seen_seq), expected_seq=excluded.expected_seq',
            ev.actor_id, expected, ev.sequence, source, now);
          return { status: 'gap', expected, actor_id: ev.actor_id, event_id: ev.event_id };
        }
        const prev = st ? st.last_event_id : null;
        if (ev.previous_event_hash !== prev) {
          this._conflict(ev, prev, 'bad_previous_hash', source, now);
          return { status: 'conflict', reason: 'bad_previous_hash', event_id: ev.event_id };
        }
        const res = this.db.run('INSERT INTO events(event_id,actor_id,sequence,event_type,schema_version,previous_event_hash,created_at,body,received_at,source) VALUES(?,?,?,?,?,?,?,?,?,?)',
          ev.event_id, ev.actor_id, ev.sequence, ev.event_type, ev.schema_version, ev.previous_event_hash, ev.created_at, JSON.stringify(ev), now, source);
        this.db.run('INSERT INTO actor_state(actor_id,pubkey,last_seq,last_event_id,forked) VALUES(?,?,?,?,0) ON CONFLICT(actor_id) DO UPDATE SET last_seq=excluded.last_seq,last_event_id=excluded.last_event_id',
          ev.actor_id, ev.actor_pub, ev.sequence, ev.event_id);
        this.db.run('DELETE FROM ledger_gaps WHERE actor_id=? AND expected_seq<=?', ev.actor_id, ev.sequence);
        this.mat.apply(ev, { lid: Number(res.lastInsertRowid), received_at: now, source });
        return { status: 'accepted', event_id: ev.event_id, lid: Number(res.lastInsertRowid) };
      });
    } catch (e) {
      this.log.warn('ingest failed and was rolled back: ' + e.message);
      return { status: 'rejected', reason: 'internal_error', event_id: ev.event_id };
    }
  }

  _conflict(ev, keptId, kind, source, now) {
    this.db.run('INSERT OR IGNORE INTO event_conflicts(actor_id,sequence,kept_event_id,conflicting_event_id,kind,source,detected_at) VALUES(?,?,?,?,?,?,?)',
      ev.actor_id, ev.sequence, keptId || null, ev.event_id, kind, source, now);
    this.db.run('UPDATE actor_state SET forked=1 WHERE actor_id=?', ev.actor_id);
  }

  /** Ingest a bounded batch. Returns per-event results plus a summary. */
  ingestBatch(list, opts = {}) {
    if (!Array.isArray(list)) return { results: [], summary: { error: 'not_array' } };
    if (list.length > MAX_BATCH) list = list.slice(0, MAX_BATCH);
    const results = list.map((ev) => this.ingest(ev, opts));
    const summary = {};
    for (const r of results) summary[r.status] = (summary[r.status] || 0) + 1;
    if (summary.accepted) this.bus.emit('events', { count: summary.accepted });
    return { results, summary };
  }

  eventsAfter(cursor, limit) {
    const rows = this.db.all('SELECT lid, body FROM events WHERE lid > ? ORDER BY lid ASC LIMIT ?', cursor, limit);
    return rows.map((r) => ({ lid: r.lid, event: JSON.parse(r.body) }));
  }
  eventsForActor(actor, fromSeq, limit) {
    return this.db.all('SELECT body FROM events WHERE actor_id=? AND sequence>=? ORDER BY sequence ASC LIMIT ?', actor, fromSeq, limit).map((r) => JSON.parse(r.body));
  }
  openGaps() { return this.db.all('SELECT * FROM ledger_gaps ORDER BY detected_at ASC LIMIT 100'); }
  conflicts(limit = 50) { return this.db.all('SELECT * FROM event_conflicts ORDER BY id DESC LIMIT ?', limit); }

  /** Digest over all event ids in local order: detects any silent mutation of the immutable log. */
  /** Federatable events after local lid (entire ledger is public-signed events). */
  publicEventsAfter(cursor, limit = 50) {
    const lim = Math.min(100, Math.max(1, Number(limit) || 50));
    const from = Math.max(0, Number(cursor) || 0);
    return this.eventsAfter(from, lim).map((row) => row.event);
  }

  computeDigest() {
    const h = crypto.createHash('sha256'); let n = 0, last = 0;
    for (;;) {
      const rows = this.db.all('SELECT lid, event_id FROM events WHERE lid>? ORDER BY lid LIMIT 1000', last);
      if (!rows.length) break;
      for (const r of rows) { h.update(r.event_id); last = r.lid; n++; }
    }
    return { digest: h.digest('hex'), event_count: n, lid: last };
  }
  checkpoint() {
    const c = this.computeDigest();
    this.db.run('INSERT INTO checkpoints(lid,event_count,digest,created_at) VALUES(?,?,?,?)', c.lid, c.event_count, c.digest, Date.now());
    return c;
  }
  /** Re-verify every stored event (signature + chain) — used by integrity check and restore tests. */
  verifyAll() {
    let ok = 0; const problems = [];
    const prev = new Map();
    for (const r of this.db.all('SELECT lid, event_id, body FROM events ORDER BY lid')) {
      const ev = JSON.parse(r.body);
      try {
        verifyEnvelope(ev, Date.now());
        const p = prev.get(ev.actor_id);
        if ((p ? p.seq + 1 : 1) !== ev.sequence || (p ? p.id : null) !== ev.previous_event_hash) throw new LedgerError('chain_broken');
        prev.set(ev.actor_id, { seq: ev.sequence, id: ev.event_id }); ok++;
      } catch (e) { problems.push({ event_id: r.event_id, problem: e.code || e.message }); }
    }
    return { ok, problems };
  }
  /** Drop every derived view and rebuild it from the immutable log. */
  reindex() {
    const before = this.computeDigest();
    this.db.tx(() => {
      this.mat.reset();
      for (let last = 0; ;) {
        const rows = this.db.all('SELECT lid, body, received_at, source FROM events WHERE lid>? ORDER BY lid LIMIT 500', last);
        if (!rows.length) break;
        for (const r of rows) { this.mat.apply(JSON.parse(r.body), { lid: r.lid, received_at: r.received_at, source: r.source, replay: true }); last = r.lid; }
      }
      this.mat.finishReplay();
    });
    const after = this.computeDigest();
    if (before.digest !== after.digest) throw new Error('ledger digest changed during reindex');
    return after;
  }
}

module.exports = { Ledger, LedgerError, verifyEnvelope, validateShape, computeEventId, unsignedOf, SCHEMA_VERSION, MAX_BATCH, MAX_EVENT_BYTES, EVENT_ID_RE, HASH_RE, REACTIONS, SIG_DOMAIN };
