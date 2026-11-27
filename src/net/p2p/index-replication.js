'use strict';
/**
 * Phase 5 completion — live shard replication for the distributed public index.
 *
 * SAFETY MODEL (why two Primaries can never both write one shard)
 *  1. Epoch = fencing token. Every shard has a monotonically increasing epoch. Primary of epoch E exists only if a quorum of
 *     the shard's members signed a vote for (shard, E, candidate, members). A voter persists "voted_epoch" BEFORE replying and
 *     votes at most once per epoch, so two different candidates can never both hold a quorum for the same epoch.
 *  2. Joint quorum. A membership change needs a majority of the OLD member set AND of the NEW set, so the new epoch's quorum
 *     always intersects the old primary's quorum; at least one member of the old quorum has already fenced the old epoch.
 *  3. Fencing on every message. Members reject appends/submits with epoch < max(epoch, voted_epoch). After voting for E' a member
 *     refuses epoch < E', so the old primary cannot collect acks and can no longer renew its lease.
 *  4. Lease self-fencing. A primary only accepts writes while a quorum acked a message it SENT less than leaseMs*leaseFraction
 *     ago (monotonic clock). Voters refuse to vote for a rival until leaseMs after last hearing from the primary. The only timing
 *     assumption is bounded clock-RATE drift (not synchronised clocks). A primary that loses quorum fences itself.
 *  5. Storage guard. DistributedIndex refuses remote-origin writes into a managed shard unless they carry the coordinator's
 *     replication token, and replicated writes are signed + last-writer-wins + tombstoned, so even a bug cannot corrupt content.
 *  Trade-off (honest): availability is sacrificed for safety. With <majority members reachable a shard is read-only (searchable,
 *  but no new writes accepted) until quorum returns. With 2 members no automatic failover is possible; use >=3.
 *
 * What is NOT claimed: protection against a majority of colluding members, nor Byzantine fault tolerance. The index is a signed
 * cache; the origin Hub stays authoritative for content and access control.
 */
const crypto = require('crypto');
const { shardFor, rendezvousScore } = require('./distributed-index');
const C = require('./index-crypto');
const { ResourceGovernor, RateBucket } = require('./index-governor');

const DEFAULTS = {
  leaseMs: 10000, leaseFraction: 0.6, heartbeatMs: 2000, requestTimeoutMs: 3000, electionStepMs: 1500,
  maxMembers: 5, replicas: 3, maxEntriesPerAppend: 50, maxAppendBytes: 600 * 1024, oplogRetention: 2000,
  snapshotPage: 200, snapshotPageBytes: 600 * 1024, maxPending: 2000, maxMigrations: 2, migrationCooldownMs: 600000,
  migrationTimeoutMs: 120000, deadAfterMs: 60000, clockSkewMs: 300000, reconcileMs: 30000, maxPullPagesPerTick: 5,
  controlRatePerSec: 40, integrityBatch: 200,
};
const DATA_OPS = new Set(['append', 'submit', 'fetch', 'snapshot']);
const MSG_TYPES = new Set(['vote_req', 'announce', 'append', 'fetch', 'snapshot', 'submit', 'digest', 'release', 'invite', 'state_query']);
const ROLE = Object.freeze({ NONE: 'NONE', LEARNER: 'LEARNER', REPLICA: 'REPLICA', PRIMARY: 'PRIMARY', RETIRED: 'RETIRED' });

const monoNow = () => Number(process.hrtime.bigint() / 1000000n);
const majority = (n) => Math.floor(n / 2) + 1;
const sameSet = (a, b) => { const x = C.sortedUnique(a), y = C.sortedUnique(b); return x.length === y.length && x.every((v, i) => v === y[i]); };
const validPeer = (p) => typeof p === 'string' && p.length >= 1 && p.length <= 80;
const cmpLog = (e1, s1, e2, s2) => (e1 - e2) || (s1 - s2);
const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

class ShardCoordinator {
  /**
   * @param {{index:object, db:object, transport:object, signer:object, localPeerId?:string, trust?:object, governor?:object,
   *          log?:object, now?:function, wall?:function, config?:object}} o
   */
  constructor(o) {
    if (!o || !o.index || !o.db || !o.transport || !o.signer) throw new Error('index, db, transport and signer are required');
    this.index = o.index; this.db = o.db; this.transport = o.transport; this.signer = o.signer;
    this.self = String(o.localPeerId || o.signer.peerId);
    this.trust = o.trust || null; this.log = o.log || noopLog;
    this.now = o.now || monoNow; this.wall = o.wall || Date.now;
    this.cfg = { ...DEFAULTS, ...(o.config || {}) };
    this.governor = o.governor || new ResourceGovernor({ index: this.index });
    this._token = this.index.replicationToken();
    this._states = new Map(); this._rt = new Map(); this._pending = new Map(); this._tasks = new Set();
    this._inflight = 0; this._cursor = 0; this._ticking = false; this._stopped = false;
    this._rate = new RateBucket({ capacity: this.cfg.controlRatePerSec * 3, refillPerSec: this.cfg.controlRatePerSec, now: this.now });
    this.metrics = { appends_sent: 0, appends_ok: 0, entries_applied: 0, snapshots_served: 0, snapshots_pulled: 0, elections_won: 0, elections_failed: 0, votes_granted: 0, rejected: {}, denied: {}, repaired_docs: 0, dropped_pending: 0 };
    this.index.setManagedPredicate((shard) => this.isManaged(shard));
    this.index.onChange((ev) => this._onLocalChange(ev));
    this._load();
  }

  // ------------------------------------------------------------------ lifecycle / persistence
  async start() { this._stopped = false; await this.transport.start((from, msg) => this.handle(from, msg)); }
  async stop({ graceful = true } = {}) {
    this._stopped = true;
    if (graceful) await this.gracefulRelease().catch(() => {});
    await this.idle();
    try { await this.transport.stop(); } catch { /* ignore */ }
  }
  /** Resolve when background signing/submit tasks drained (tests + shutdown). */
  async idle() { while (this._tasks.size) await Promise.allSettled([...this._tasks]); }

  _blank(shard) { return { shard_id: shard, epoch: 0, voted_epoch: 0, voted_for: '', primary: '', members: [], learners: [], planned: [], seq: 0, last_epoch: 0, role: ROLE.NONE, status: 'ACTIVE', cert: null }; }
  _newRt() { return { lastContact: this.now(), released: false, acks: new Map(), progress: new Map(), leaseUntil: 0, electing: false, electFails: 0, nextElection: 0, gap: false, syncing: false, migrating: null, lastMigration: 0, lastReconcile: 0, lastBeat: 0, verifyCursor: '' }; }
  _load() {
    for (const r of this.db.all('SELECT * FROM p2p_index_shard_state')) {
      const j = (x, d) => { try { return JSON.parse(x); } catch { return d; } };
      this._states.set(r.shard_id, { shard_id: r.shard_id, epoch: r.epoch, voted_epoch: r.voted_epoch, voted_for: r.voted_for, primary: r.primary_peer, members: j(r.members, []), learners: j(r.learners, []), planned: j(r.planned, []), seq: r.seq, last_epoch: r.last_epoch, role: r.role, status: r.status, cert: j(r.cert, null) });
      this._rt.set(r.shard_id, this._newRt());   // after a restart we behave as "just heard from the primary": waits a full lease before voting; primary holds NO lease until re-acked
    }
  }
  _st(shard, create = false) {
    let st = this._states.get(shard);
    if (!st && create) { st = this._blank(shard); this._states.set(shard, st); this._rt.set(shard, this._newRt()); }
    return st || null;
  }
  _save(st) {
    this.db.run(`INSERT INTO p2p_index_shard_state(shard_id,epoch,voted_epoch,voted_for,primary_peer,members,learners,planned,seq,last_epoch,role,status,cert,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(shard_id) DO UPDATE SET epoch=excluded.epoch,voted_epoch=excluded.voted_epoch,voted_for=excluded.voted_for,primary_peer=excluded.primary_peer,
      members=excluded.members,learners=excluded.learners,planned=excluded.planned,seq=excluded.seq,last_epoch=excluded.last_epoch,role=excluded.role,status=excluded.status,cert=excluded.cert,updated_at=excluded.updated_at`,
      st.shard_id, st.epoch, st.voted_epoch, st.voted_for, st.primary, JSON.stringify(st.members), JSON.stringify(st.learners), JSON.stringify(st.planned), st.seq, st.last_epoch, st.role, st.status, st.cert ? JSON.stringify(st.cert) : '', this.wall());
  }
  /** Epoch / vote changes must survive power loss: force the WAL to disk (rare events only). */
  _durable() { try { this.db.raw.exec('PRAGMA wal_checkpoint(FULL)'); } catch { /* best effort */ } }

  isManaged(shard) {
    const st = this._states.get(shard);
    return !!st && (st.role === ROLE.PRIMARY || st.role === ROLE.REPLICA || st.role === ROLE.LEARNER);
  }
  _hosted() { let n = 0; for (const st of this._states.values()) if (st.role === ROLE.PRIMARY || st.role === ROLE.REPLICA || st.role === ROLE.LEARNER) n++; return n; }
  _deny(reason) { this.metrics.denied[reason] = (this.metrics.denied[reason] || 0) + 1; return { ok: false, granted: false, reason }; }
  _reject(reason) { this.metrics.rejected[reason] = (this.metrics.rejected[reason] || 0) + 1; return { ok: false, reason }; }
  _observe(peer, o) { if (this.trust) { try { this.trust.observe(peer, o); } catch { /* ignore */ } } }

  // ------------------------------------------------------------------ message entry point
  async handle(from, msg) {
    try {
      if (this._stopped) return { ok: false, reason: 'stopped' };
      if (!msg || typeof msg !== 'object' || !MSG_TYPES.has(msg.t)) return this._reject('bad_message');
      if (!validPeer(from)) return this._reject('bad_peer');
      const shard = Number(msg.shard);
      if (msg.t !== 'state_query' || msg.shard !== undefined) {
        if (!Number.isInteger(shard) || shard < 0 || shard >= this.index.shardCount) return this._reject('bad_shard');
      }
      if (this.trust) {
        const ts = this.trust.stateOf(from);
        if (ts === 'BLOCKED' || ts === 'QUARANTINED') return this._reject('trust_' + ts.toLowerCase());
      }
      const factor = this.trust ? ({ TRUSTED: 1, PROBATION: 0.5, NEW: 0.25, LIMITED: 0.1 }[this.trust.stateOf(from)] || 0.25) : 1;
      if (!this._rate.take(from, 1, factor)) return this._reject('rate_limited');
      if (this._inflight >= this.governor.concurrency() * 4) return this._reject('busy');   // backpressure
      if (DATA_OPS.has(msg.t) && !(msg.t === 'append' && (!msg.entries || !msg.entries.length)) && this.trust) {
        const a = this.trust.allow(from, 'sync'); if (!a.ok) return this._reject('quota_' + a.reason);
      }
      this._inflight++;
      try {
        switch (msg.t) {
          case 'vote_req': return await this._onVoteReq(from, msg);
          case 'announce': return await this._onAnnounce(from, msg);
          case 'append': return await this._onAppend(from, msg);
          case 'submit': return await this._onSubmit(from, msg);
          case 'fetch': return this._onFetch(from, msg);
          case 'snapshot': return await this._onSnapshot(from, msg);
          case 'digest': return this._onDigest(from, msg);
          case 'release': return this._onRelease(from, msg);
          case 'invite': return this._onInvite(from, msg);
          case 'state_query': return this._onStateQuery(from, msg);
          default: return this._reject('bad_message');
        }
      } finally { this._inflight--; }
    } catch (e) { this.log.warn('index handle error: ' + (e && e.message)); return { ok: false, reason: 'internal' }; }
  }

  // ------------------------------------------------------------------ election / fencing
  _validMembers(list) { return Array.isArray(list) && list.length <= this.cfg.maxMembers && list.every(validPeer) && new Set(list).size === list.length; }

  async _onVoteReq(from, m) {
    const { shard, epoch, candidate } = m;
    if (from !== candidate) { this._observe(from, { abuse: 1 }); return this._deny('sender_mismatch'); }
    const members = m.members, old = m.old_members || [];
    if (!this._validMembers(members) || !this._validMembers(old) || !Number.isInteger(epoch) || epoch < 1) return this._deny('malformed');
    if (!members.includes(candidate)) return this._deny('candidate_not_member');
    if (!members.includes(this.self) && !old.includes(this.self)) return this._deny('not_member');
    if (Math.abs(this.wall() - Number(m.ts)) > this.cfg.clockSkewMs) return this._deny('stale_request');
    if (this.trust && this.trust.stateOf(candidate) !== 'TRUSTED') return this._deny('candidate_untrusted');
    const st = this._st(shard, true), rt = this._rt.get(shard);
    if (!st.members.length && members.includes(this.self) && st.role === ROLE.NONE && !this.governor.canHost(this._hosted())) return this._deny('no_capacity');
    if (epoch <= st.epoch || epoch <= st.voted_epoch) {
      const again = epoch === st.voted_epoch && st.voted_for === candidate && epoch > st.epoch;   // idempotent re-ask by the SAME candidate
      if (!again) return { ...this._deny('stale_epoch'), epoch: Math.max(st.epoch, st.voted_epoch) };
    }
    if (st.members.length) { if (!sameSet(old, st.members)) return this._deny('membership_mismatch'); }
    else if (old.length) { if (!(st.role === ROLE.LEARNER && st.primary === candidate)) return this._deny('unknown_prior_membership'); }
    else if (st.planned.length && !st.planned.includes(candidate)) return this._deny('not_planned_primary');
    if (cmpLog(Number(m.last_epoch) || 0, Number(m.last_seq) || 0, st.last_epoch, st.seq) < 0) return this._deny('log_behind');
    if (st.primary && st.primary !== candidate && !rt.released && this.now() - rt.lastContact < this.cfg.leaseMs) return this._deny('primary_alive');
    // Persist the vote durably BEFORE answering — this is what makes "one vote per epoch" survive crashes.
    st.voted_epoch = epoch; st.voted_for = candidate;
    this.db.tx(() => this._save(st)); this._durable();
    const sig = await this.signer.sign(C.votePayload({ shard, epoch, candidate, members, old_members: old, voter: this.self }));
    this.metrics.votes_granted++;
    return { ok: true, granted: true, voter: this.self, sig, epoch };
  }

  /** Run an election for `shard`. members defaults to the current set. Returns {ok, epoch?, reason?}. */
  async elect(shard, { members = null } = {}) {
    const st = this._st(shard, true), rt = this._rt.get(shard);
    if (rt.electing) return { ok: false, reason: 'already_electing' };
    members = members || (st.members.length ? st.members : st.planned);
    if (!this._validMembers(members) || !members.includes(this.self)) return { ok: false, reason: 'bad_members' };
    const old = st.members.slice();
    rt.electing = true;
    try {
      const epoch = Math.max(st.epoch, st.voted_epoch, rt.minEpoch || 0) + 1;
      st.voted_epoch = epoch; st.voted_for = this.self;                       // self vote is subject to the same persistence rule
      this.db.tx(() => this._save(st)); this._durable();
      const req = { t: 'vote_req', shard, epoch, candidate: this.self, members, old_members: old, last_epoch: st.last_epoch, last_seq: st.seq, ts: this.wall(), nonce: crypto.randomBytes(8).toString('hex') };
      const targets = [...new Set([...members, ...old])].filter((p) => p !== this.self);
      const votes = [{ peer: this.self, sig: await this.signer.sign(C.votePayload({ shard, epoch, candidate: this.self, members, old_members: old, voter: this.self })) }];
      let higher = 0;
      const results = await Promise.allSettled(targets.map((p) => this.transport.request(p, req, { timeoutMs: this.cfg.requestTimeoutMs })));
      for (let i = 0; i < targets.length; i++) {
        const r = results[i]; if (r.status !== 'fulfilled' || !r.value) continue;
        const v = r.value;
        if (Number(v.epoch) > epoch) higher = Math.max(higher, Number(v.epoch));
        if (v.granted === true && v.voter === targets[i] && await this.signer.verify(C.votePayload({ shard, epoch, candidate: this.self, members, old_members: old, voter: targets[i] }), v.sig, targets[i])) votes.push({ peer: targets[i], sig: v.sig });
      }
      if (higher) rt.minEpoch = higher;
      if (!this._quorumOk(votes, members, old)) {
        rt.electFails++; rt.nextElection = this.now() + Math.min(60000, 1000 * 2 ** Math.min(rt.electFails, 6)) + Math.floor(Math.random() * 1000);
        this.metrics.elections_failed++;
        return { ok: false, reason: 'no_quorum', votes: votes.length };
      }
      const cert = { shard_id: shard, epoch, primary: this.self, members, old_members: old, votes, issued_at: this.wall() };
      this._install(st, rt, cert);
      this.metrics.elections_won++; rt.electFails = 0;
      await this._announce(st, cert);
      await this._replicateShard(shard).catch(() => {});
      return { ok: true, epoch, cert };
    } finally { rt.electing = false; }
  }

  _quorumOk(votes, members, old) {
    const ids = new Set(votes.map((v) => v.peer));
    const inM = members.filter((p) => ids.has(p)).length;
    if (inM < majority(members.length)) return false;
    if (old.length) { const inO = old.filter((p) => ids.has(p)).length; if (inO < majority(old.length)) return false; }
    return true;
  }
  _install(st, rt, cert) {
    const wasPrimary = st.role === ROLE.PRIMARY;
    st.epoch = cert.epoch; st.primary = cert.primary; st.members = cert.members.slice(); st.cert = cert; st.learners = st.learners.filter((p) => !cert.members.includes(p));
    st.planned = []; st.status = 'ACTIVE';
    st.role = cert.primary === this.self ? ROLE.PRIMARY : (cert.members.includes(this.self) ? ROLE.REPLICA : ROLE.RETIRED);
    if (st.voted_epoch < cert.epoch) { st.voted_epoch = cert.epoch; st.voted_for = cert.primary; }
    rt.lastContact = this.now(); rt.released = false; rt.acks = new Map(); rt.progress = new Map(); rt.leaseUntil = 0; rt.gap = false; rt.migrating = null; rt.notified = new Set();
    if (wasPrimary && st.role !== ROLE.PRIMARY) this.log.info(`shard ${st.shard_id}: stepped down at epoch ${cert.epoch}`);
    this.db.tx(() => this._save(st)); this._durable();
  }
  async _announce(st, cert) {
    const targets = [...new Set([...cert.members, ...cert.old_members])].filter((p) => p !== this.self);
    await Promise.allSettled(targets.map((p) => this.transport.request(p, { t: 'announce', shard: st.shard_id, cert }, { timeoutMs: this.cfg.requestTimeoutMs })));
  }

  async _verifyCert(cert, shard) {
    if (!cert || cert.shard_id !== shard || !Number.isInteger(cert.epoch) || cert.epoch < 1) return false;
    if (!this._validMembers(cert.members) || !this._validMembers(cert.old_members || []) || !cert.members.includes(cert.primary)) return false;
    if (!Array.isArray(cert.votes) || cert.votes.length > 2 * this.cfg.maxMembers) return false;
    const ok = [];
    for (const v of cert.votes) {
      if (!v || !validPeer(v.peer) || ![...cert.members, ...cert.old_members].includes(v.peer) || ok.some((x) => x.peer === v.peer)) return false;
      if (!(await this.signer.verify(C.votePayload({ shard, epoch: cert.epoch, candidate: cert.primary, members: cert.members, old_members: cert.old_members, voter: v.peer }), v.sig, v.peer))) return false;
      ok.push(v);
    }
    return this._quorumOk(ok, cert.members, cert.old_members || []);
  }

  async _onAnnounce(from, m) {
    const cert = m.cert; const shard = Number(m.shard);
    if (!cert || from !== cert.primary) return this._reject('announce_sender_mismatch');
    const st = this._st(shard, true), rt = this._rt.get(shard);
    if (cert.epoch < st.epoch || cert.epoch < st.voted_epoch && cert.primary !== st.voted_for) return { ok: false, reason: 'stale_epoch', epoch: Math.max(st.epoch, st.voted_epoch) };
    if (cert.epoch === st.epoch && st.primary === cert.primary) return { ok: true, seq: st.seq, last_epoch: st.last_epoch };
    if (!(await this._verifyCert(cert, shard))) { this._observe(from, { abuse: 1 }); return this._reject('bad_cert'); }
    if (!cert.members.includes(this.self) && !cert.old_members.includes(this.self) && st.role === ROLE.NONE) return this._reject('not_member');
    // chain-of-custody: the certificate must extend the membership I already know, or be confirmed by a majority of it
    if (st.members.length && !sameSet(cert.old_members, st.members)) {
      if (!(await this._confirmWithMembers(st, cert))) return this._reject('unconfirmed_chain');
    } else if (!st.members.length) {
      if (cert.members.includes(this.self) && !((st.planned.length && st.planned.includes(cert.primary)) || (st.role === ROLE.LEARNER && st.primary === cert.primary))) return this._reject('unexpected_membership');
    }
    if (cert.members.includes(this.self) && st.role === ROLE.NONE && !this.governor.canHost(this._hosted())) return this._reject('no_capacity');
    this._install(st, rt, cert);
    return { ok: true, seq: st.seq, last_epoch: st.last_epoch };
  }
  async _confirmWithMembers(st, cert) {
    const hash = C.sha256(JSON.stringify([cert.epoch, cert.primary, C.sortedUnique(cert.members)]));
    const peers = st.members.filter((p) => p !== this.self);
    const rs = await Promise.allSettled(peers.map((p) => this.transport.request(p, { t: 'state_query', shard: st.shard_id }, { timeoutMs: this.cfg.requestTimeoutMs })));
    let agree = 0; for (const r of rs) if (r.status === 'fulfilled' && r.value && r.value.cert_hash === hash) agree++;
    return agree + 1 >= majority(st.members.length) && agree > 0;
  }
  _certHash(st) { return st.cert ? C.sha256(JSON.stringify([st.cert.epoch, st.cert.primary, C.sortedUnique(st.cert.members)])) : ''; }
  _onStateQuery(from, m) {
    const st = this._states.get(Number(m.shard)); if (!st) return { ok: false, reason: 'unknown_shard' };
    return { ok: true, epoch: st.epoch, primary: st.primary, seq: st.seq, cert_hash: this._certHash(st) };
  }

  // ------------------------------------------------------------------ lease
  _recompute(st, rt) {
    const need = majority(st.members.length || 1), t = this.now();
    const times = [t];
    for (const p of st.members) if (p !== this.self) times.push(rt.acks.get(p) || 0);
    times.sort((a, b) => b - a);
    const start = times[need - 1] || 0;
    rt.leaseUntil = start > 0 ? start + this.cfg.leaseMs * this.cfg.leaseFraction : 0;
    if (start > 0) rt.lastContact = Math.max(rt.lastContact, start);
  }
  leaseValid(shard) {
    const st = this._states.get(shard), rt = this._rt.get(shard);
    if (!st || st.role !== ROLE.PRIMARY) return false;
    this._recompute(st, rt);
    return this.now() < rt.leaseUntil;
  }
  /** Public write-authority check: true only for a Primary that currently holds a quorum lease. */
  canWrite(shard) { return this.leaseValid(shard); }

  // ------------------------------------------------------------------ entries (signed documents / tombstones)
  async _verifyEntry(e, shard) {
    if (!e || typeof e !== 'object' || !validPeer(e.origin_peer) || typeof e.content_id !== 'string' || !e.content_id || e.content_id.length > 160) return 'malformed';
    if (shardFor(e.origin_peer + ':' + e.content_id, this.index.shardCount) !== shard) return 'wrong_shard';
    if (e.op === 'delete') {
      if (!Number.isFinite(Number(e.version))) return 'malformed';
      return (await this.signer.verify(C.tombPayload(e.origin_peer, e.content_id, e.version), e.origin_sig, e.origin_peer)) ? null : 'bad_signature';
    }
    if (e.op !== 'upsert' || !e.doc || typeof e.doc !== 'object') return 'malformed';
    const d = e.doc;
    if (d.origin_peer !== e.origin_peer || d.content_id !== e.content_id) return 'malformed';
    const title = String(d.title || '').slice(0, 300), text = String(d.text || '').slice(0, 12000);
    if (String(d.content_hash || '').toLowerCase() !== C.sha256(title + '\n' + text)) return 'hash_mismatch';
    return (await this.signer.verify(C.docPayload({ ...d, title, text }), e.origin_sig, e.origin_peer)) ? null : 'bad_signature';
  }
  _applyEntry(e) {
    if (e.op === 'delete') { this.index.removeDocument(e.origin_peer, e.content_id, { version: Number(e.version), sig: e.origin_sig, replication: this._token }); return true; }
    const r = this.index.upsertDocument({ ...e.doc, visibility: 'public' }, { verified: true, originSig: e.origin_sig, replication: this._token });
    if (!r.ok && r.reason !== 'tombstoned') throw new Error('apply_failed:' + r.reason);
    return true;
  }
  _oplogRow(shard, seq) { return this.db.get('SELECT seq,epoch FROM p2p_index_oplog WHERE shard_id=? AND seq=?', shard, seq); }
  _oplogInsert(shard, seq, epoch, e) {
    this.db.run('INSERT OR REPLACE INTO p2p_index_oplog(shard_id,seq,epoch,op,origin_peer,content_id,payload,created_at) VALUES(?,?,?,?,?,?,?,?)', shard, seq, epoch, e.op, e.origin_peer, e.content_id, JSON.stringify(e), this.wall());
  }
  _oplogTrim(st) { const floor = st.seq - this.cfg.oplogRetention; if (floor > 0) this.db.run('DELETE FROM p2p_index_oplog WHERE shard_id=? AND seq<=?', st.shard_id, floor); }

  /** Primary: assign the next sequence number, apply and log. Caller has verified the entry and checked write authority. */
  _primaryAppend(st, entry) {
    let seq = 0;
    this.db.tx(() => { this._applyEntry(entry); seq = st.seq + 1; this._oplogInsert(st.shard_id, seq, st.epoch, { ...entry, epoch: st.epoch, seq }); st.seq = seq; st.last_epoch = st.epoch; this._oplogTrim(st); this._save(st); });
    return seq;
  }

  async _onSubmit(from, m) {
    const shard = Number(m.shard), st = this._states.get(shard);
    if (!st || st.role !== ROLE.PRIMARY) return { ok: false, reason: 'not_primary', primary: st ? st.primary : '' };
    if (!this.leaseValid(shard)) return { ok: false, reason: 'lease_expired' };
    if (this.governor.pressure().reasons.includes('disk')) return this._reject('disk_pressure');
    const bad = await this._verifyEntry(m.entry, shard);
    if (bad) { this._observe(from, { abuse: 1 }); return this._reject('entry_' + bad); }
    if (!this.leaseValid(shard)) return { ok: false, reason: 'lease_expired' };     // re-check after the await: authority may have been lost
    const seq = this._primaryAppend(st, m.entry);
    await this._replicateShard(shard).catch(() => {});
    return { ok: true, seq, committed: this._committed(st, this._rt.get(shard), seq) };
  }
  _committed(st, rt, seq) {
    let n = 1; for (const p of st.members) if (p !== this.self && (rt.progress.get(p)?.match || 0) >= seq) n++;
    return n >= majority(st.members.length);
  }

  // ------------------------------------------------------------------ local writes (legacy API stays; replication hooks in)
  _onLocalChange(ev) {
    if (ev.replicated || !ev.local) return;
    const st = this._states.get(ev.shard_id);
    if (!st || !(st.role === ROLE.PRIMARY || st.role === ROLE.REPLICA)) return;
    const t = (async () => {
      let entry;
      if (ev.type === 'upsert') {
        const r = ev.record; const doc = { origin_peer: r.origin_peer, content_id: r.content_id, title: r.title, text: r.text, language: r.language, region: r.region, topics: r.topics, content_hash: r.content_hash, updated_at: r.updated_at };
        const sig = await this.signer.sign(C.docPayload(doc));
        this.db.run('UPDATE p2p_index_documents SET origin_sig=? WHERE origin_peer=? AND content_id=? AND content_hash=?', sig, doc.origin_peer, doc.content_id, doc.content_hash);
        entry = { op: 'upsert', origin_peer: doc.origin_peer, content_id: doc.content_id, doc, origin_sig: sig };
      } else {
        const sig = await this.signer.sign(C.tombPayload(ev.origin_peer, ev.content_id, ev.version));
        this.db.run('UPDATE p2p_index_tombstones SET sig=? WHERE origin_peer=? AND content_id=? AND version=?', sig, ev.origin_peer, ev.content_id, ev.version);
        entry = { op: 'delete', origin_peer: ev.origin_peer, content_id: ev.content_id, version: ev.version, origin_sig: sig };
      }
      await this._publish(ev.shard_id, entry);
    })().catch((e) => this.log.debug('local publish: ' + (e && e.message))).finally(() => this._tasks.delete(t));
    this._tasks.add(t);
  }
  async _publish(shard, entry) {
    const st = this._states.get(shard); if (!st) return;
    if (st.role === ROLE.PRIMARY && this.leaseValid(shard)) { this._primaryAppend(st, entry); await this._replicateShard(shard).catch(() => {}); return; }
    const key = entry.origin_peer + '\t' + entry.content_id;
    this._pending.delete(key); this._pending.set(key, { shard, entry });
    while (this._pending.size > this.cfg.maxPending) { this._pending.delete(this._pending.keys().next().value); this.metrics.dropped_pending++; }
    await this._flushPending(shard);
  }
  async _flushPending(onlyShard) {
    for (const [key, p] of [...this._pending]) {
      if (onlyShard != null && p.shard !== onlyShard) continue;
      const st = this._states.get(p.shard); if (!st || !st.primary) continue;
      try {
        if (st.primary === this.self) { if (!this.leaseValid(p.shard)) continue; this._primaryAppend(st, p.entry); this._pending.delete(key); continue; }
        const r = await this.transport.request(st.primary, { t: 'submit', shard: p.shard, entry: p.entry }, { timeoutMs: this.cfg.requestTimeoutMs });
        if (r && r.ok) this._pending.delete(key);
      } catch { /* retried next tick */ }
    }
  }

  // ------------------------------------------------------------------ replication (primary side)
  /** Coalesced: at most ONE replication loop per shard; writes arriving meanwhile just mark it dirty so one append carries many entries. */
  _replicateShard(shard) {
    const rt = this._rt.get(shard); if (!rt) return Promise.resolve();
    if (rt.repl) { rt.replDirty = true; return rt.repl; }
    rt.repl = (async () => {
      try {
        for (let round = 0; round < 400; round++) {
          rt.replDirty = false;
          await this._replicateOnce(shard);
          const st = this._states.get(shard); if (!st || st.role !== ROLE.PRIMARY) break;
          const behind = [...st.members, ...st.learners].some((p) => { if (p === this.self) return false; const pr = rt.progress.get(p); return pr && pr.fail === 0 && pr.match < st.seq; });
          if (!rt.replDirty && !behind) break;
        }
      } finally { rt.repl = null; }
    })();
    return rt.repl;
  }
  async _replicateOnce(shard) {
    const st = this._states.get(shard), rt = this._rt.get(shard);
    if (!st || st.role !== ROLE.PRIMARY) return;
    const peers = [...new Set([...st.members, ...st.learners])].filter((p) => p !== this.self);
    await Promise.allSettled(peers.map((p) => this._sendAppend(st, rt, p)));
    // members removed by the last membership change may have been offline: keep telling them (bounded) until they acknowledge
    const removed = ((st.cert && st.cert.old_members) || []).filter((p) => p !== this.self && !st.members.includes(p) && !(rt.notified && rt.notified.has(p)));
    await Promise.allSettled(removed.slice(0, 4).map(async (p) => { const r = await this.transport.request(p, { t: 'announce', shard, cert: st.cert }, { timeoutMs: this.cfg.requestTimeoutMs }).catch(() => null); if (r && r.ok) { rt.notified = rt.notified || new Set(); rt.notified.add(p); } }));
    this._recompute(st, rt); rt.lastBeat = this.now();
    if (!this.leaseValid(shard) && st.status !== 'FENCED') { st.status = 'FENCED'; this.db.tx(() => this._save(st)); this.log.warn(`shard ${shard}: lease lost, writes fenced`); }
    else if (this.leaseValid(shard) && st.status === 'FENCED') { st.status = 'ACTIVE'; this.db.tx(() => this._save(st)); }
  }
  async _sendAppend(st, rt, peer) {
    let pr = rt.progress.get(peer); if (!pr) { pr = { next: st.seq + 1, match: 0, fail: 0 }; rt.progress.set(peer, pr); }
    const sentAt = this.now();
    const rows = this.db.all('SELECT seq,epoch,payload FROM p2p_index_oplog WHERE shard_id=? AND seq>=? AND seq<=? ORDER BY seq LIMIT ?', st.shard_id, pr.next, st.seq, this.cfg.maxEntriesPerAppend);
    const entries = []; let bytes = 0, expect = pr.next;
    for (const r of rows) { if (r.seq !== expect) break; bytes += r.payload.length; if (entries.length && bytes > this.cfg.maxAppendBytes) break; entries.push(JSON.parse(r.payload)); expect++; }
    // If the trimmed log can no longer supply the follower's next entry, advertise the head instead: the follower then sees a gap and pulls a snapshot.
    const prev = (!entries.length && pr.next <= st.seq) ? st.seq : pr.next - 1; const prevRow = prev > 0 ? this._oplogRow(st.shard_id, prev) : null;
    const msg = { t: 'append', shard: st.shard_id, epoch: st.epoch, prev_seq: prev, prev_epoch: prevRow ? prevRow.epoch : (prev === st.seq ? st.last_epoch : 0), entries };
    this.metrics.appends_sent++;
    let resp;
    try { resp = await this.transport.request(peer, msg, { timeoutMs: this.cfg.requestTimeoutMs }); } catch { pr.fail++; return; }
    if (!resp) { pr.fail++; return; }
    if (resp.ok) { pr.match = resp.seq; pr.next = resp.seq + 1; pr.fail = 0; rt.acks.set(peer, sentAt); this.metrics.appends_ok++; return; }
    if (resp.reason === 'gap') { pr.next = Math.max(1, Number(resp.have_seq) + 1); pr.match = Math.max(0, pr.next - 1); rt.acks.set(peer, sentAt); return; }   // reachable & loyal to this epoch; replica will pull
    if (resp.reason === 'need_announce' && st.cert) { await this.transport.request(peer, { t: 'announce', shard: st.shard_id, cert: st.cert }, { timeoutMs: this.cfg.requestTimeoutMs }).catch(() => {}); return; }
    pr.fail++;   // stale_epoch / not_primary / rejects: NOT an ack — a fenced member can never extend our lease
  }

  // ------------------------------------------------------------------ replication (follower side)
  async _onAppend(from, m) {
    const shard = Number(m.shard), st = this._states.get(shard);
    if (!st) return { ok: false, reason: 'unknown_shard' };
    const rt = this._rt.get(shard);
    if (m.epoch < st.epoch || m.epoch < st.voted_epoch) { this.metrics.rejected.fenced = (this.metrics.rejected.fenced || 0) + 1; return { ok: false, reason: 'stale_epoch', epoch: Math.max(st.epoch, st.voted_epoch) }; }
    if (m.epoch > st.epoch) return { ok: false, reason: 'need_announce', epoch: st.epoch };
    if (st.role === ROLE.PRIMARY) { this.log.error(`shard ${shard}: DUAL PRIMARY claim from ${from.slice(0, 12)} at epoch ${m.epoch}`); this._observe(from, { abuse: 1 }); return { ok: false, reason: 'dual_primary' }; }
    if (from !== st.primary) return { ok: false, reason: 'not_primary' };
    if (st.role !== ROLE.REPLICA && st.role !== ROLE.LEARNER) return { ok: false, reason: 'not_member' };
    let entries = Array.isArray(m.entries) ? m.entries : [];
    if (entries.length > this.cfg.maxEntriesPerAppend * 2) { this._observe(from, { abuse: 1 }); return this._reject('too_many_entries'); }
    const prevSeq = Number(m.prev_seq) || 0;
    if (prevSeq > st.seq) { rt.gap = true; rt.lastContact = this.now(); rt.released = false; return { ok: false, reason: 'gap', have_seq: st.seq }; }
    if (prevSeq < st.seq) {
      const next = this._oplogRow(shard, prevSeq + 1);
      if (next && next.epoch === m.epoch) entries = entries.filter((e) => e.seq > st.seq);              // duplicate delivery
      else { this.db.tx(() => { this.db.run('DELETE FROM p2p_index_oplog WHERE shard_id=? AND seq>?', shard, prevSeq); st.seq = prevSeq; const r = prevSeq ? this._oplogRow(shard, prevSeq) : null; st.last_epoch = r ? r.epoch : 0; this._save(st); }); }  // drop a stale-epoch uncommitted tail (log metadata only; content is merged, never lost)
    }
    if (entries.length && entries[0].seq !== st.seq + 1) return { ok: false, reason: 'gap', have_seq: st.seq };
    for (let i = 0; i < entries.length; i++) if (entries[i].seq !== st.seq + 1 + i || !(entries[i].epoch <= m.epoch)) { this._observe(from, { abuse: 1 }); return this._reject('bad_sequence'); }
    const err = await this._verifyAll(entries, shard);
    if (err) { this._observe(from, { abuse: 1 }); return this._reject('entry_' + err); }
    if (m.epoch < st.voted_epoch || m.epoch !== st.epoch) return { ok: false, reason: 'stale_epoch', epoch: Math.max(st.epoch, st.voted_epoch) };   // re-check after awaits
    this._applyReplicated(st, entries);
    rt.lastContact = this.now(); rt.released = false; rt.gap = false;
    this._observe(from, { success: true });
    return { ok: true, seq: st.seq, epoch: st.epoch };
  }
  async _verifyAll(entries, shard) { for (const e of entries) { const r = await this._verifyEntry(e, shard); if (r) return r; } return null; }
  _applyReplicated(st, entries) {
    if (!entries.length) return;
    this.db.tx(() => {
      for (const e of entries) { this._applyEntry(e); this._oplogInsert(st.shard_id, e.seq, e.epoch, e); st.seq = e.seq; st.last_epoch = e.epoch; this.metrics.entries_applied++; }
      this._oplogTrim(st); this._save(st);
    });
  }

  // ------------------------------------------------------------------ catch-up (pull) + snapshot
  _isMember(st, peer) { return st.members.includes(peer) || st.learners.includes(peer) || (!!st.primary && st.primary === peer); }
  _onFetch(from, m) {
    const shard = Number(m.shard), st = this._states.get(shard);
    if (!st || !(st.role === ROLE.PRIMARY || st.role === ROLE.REPLICA)) return { ok: false, reason: 'not_serving' };
    if (!this._isMember(st, from)) return { ok: false, reason: 'not_member' };
    const from_seq = Math.max(1, Number(m.from_seq) || 1);
    if (from_seq > st.seq) return { ok: true, entries: [], seq: st.seq, epoch: st.epoch };
    const rows = this.db.all('SELECT seq,payload FROM p2p_index_oplog WHERE shard_id=? AND seq>=? ORDER BY seq LIMIT ?', shard, from_seq, this.cfg.maxEntriesPerAppend);
    if (!rows.length || rows[0].seq !== from_seq) return { ok: true, snapshot_required: true, seq: st.seq, epoch: st.epoch };
    const entries = []; let bytes = 0, expect = from_seq;
    for (const r of rows) { if (r.seq !== expect) break; bytes += r.payload.length; if (entries.length && bytes > this.cfg.maxAppendBytes) break; entries.push(JSON.parse(r.payload)); expect++; }
    return { ok: true, entries, seq: st.seq, epoch: st.epoch };
  }
  async _onSnapshot(from, m) {
    const shard = Number(m.shard), st = this._states.get(shard);
    if (!st || !(st.role === ROLE.PRIMARY || st.role === ROLE.REPLICA)) return { ok: false, reason: 'not_serving' };
    if (!this._isMember(st, from)) return { ok: false, reason: 'not_member' };
    const phase = m.phase === 'tombs' ? 'tombs' : 'docs';
    let limit = Math.min(this.cfg.snapshotPage, Number(m.limit) || this.cfg.snapshotPage);
    let page = this.index.pageShard(shard, { phase, after: String(m.after || ''), limit });
    while (page.items.length > 1 && JSON.stringify(page.items).length > this.cfg.snapshotPageBytes) { limit = Math.max(1, Math.floor(page.items.length / 2)); page = this.index.pageShard(shard, { phase, after: String(m.after || ''), limit }); }
    if (phase === 'docs') await this._signLocal(page.items);
    this.metrics.snapshots_served++;
    return { ok: true, phase, items: page.items, done: page.done, next: page.next, seq: st.seq, epoch: st.epoch, last_epoch: st.last_epoch };
  }
  async _signLocal(items) {
    for (const d of items) if (d.origin_peer === this.self && !d.origin_sig) {
      d.origin_sig = await this.signer.sign(C.docPayload({ ...d, text: d.body }));
      this.db.run('UPDATE p2p_index_documents SET origin_sig=? WHERE origin_peer=? AND content_id=? AND content_hash=?', d.origin_sig, d.origin_peer, d.content_id, d.content_hash);
    }
  }
  _onDigest(from, m) {
    const shard = Number(m.shard), st = this._states.get(shard);
    if (!st || !this._isMember(st, from)) return { ok: false, reason: 'not_member' };
    return { ok: true, epoch: st.epoch, seq: st.seq, ...this.index.shardDigests(shard) };
  }

  /** Pull missing log entries (or a full snapshot merge when the log no longer covers the gap). */
  async catchUp(shard, { from = null } = {}) {
    const st = this._states.get(shard), rt = this._rt.get(shard);
    if (!st || rt.syncing) return { ok: false, reason: 'busy' };
    const src = from || st.primary; if (!src || src === this.self) return { ok: false, reason: 'no_source' };
    if (this.index.capacity().ratio >= 0.95) { st.status = 'DEGRADED'; return { ok: false, reason: 'capacity' }; }
    rt.syncing = true;
    try {
      for (let i = 0; i < this.cfg.maxPullPagesPerTick; i++) {
        const r = await this.transport.request(src, { t: 'fetch', shard, from_seq: st.seq + 1 }, { timeoutMs: this.cfg.requestTimeoutMs });
        if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || 'fetch_failed' };
        if (r.snapshot_required) return await this._snapshotSync(st, rt, src);
        if (!r.entries.length) { rt.gap = false; return { ok: true, seq: st.seq }; }
        const exp = st.seq + 1;
        if (r.entries[0].seq !== exp) return { ok: false, reason: 'bad_sequence' };
        const err = await this._verifyAll(r.entries, shard);
        if (err) { this._observe(src, { abuse: 1 }); return { ok: false, reason: 'entry_' + err }; }
        this._applyReplicated(st, r.entries);
      }
      return { ok: true, seq: st.seq, more: true };
    } catch (e) { return { ok: false, reason: 'transport' }; } finally { rt.syncing = false; }
  }
  async _snapshotSync(st, rt, src) {
    const shard = st.shard_id; let snapSeq = null, snapEpoch = 0, pulled = 0;
    for (const phase of ['docs', 'tombs']) {
      let after = '';
      for (let guard = 0; guard < 100000; guard++) {
        const r = await this.transport.request(src, { t: 'snapshot', shard, phase, after, limit: this.cfg.snapshotPage }, { timeoutMs: this.cfg.requestTimeoutMs * 3 });
        if (!r || !r.ok || !Array.isArray(r.items)) return { ok: false, reason: (r && r.reason) || 'snapshot_failed' };
        if (snapSeq === null) { snapSeq = Number(r.seq) || 0; snapEpoch = Number(r.last_epoch) || 0; }
        const entries = r.items.map((d) => phase === 'docs'
          ? { op: 'upsert', origin_peer: d.origin_peer, content_id: d.content_id, origin_sig: d.origin_sig, doc: { origin_peer: d.origin_peer, content_id: d.content_id, title: d.title, text: d.body, language: d.language, region: d.region, topics: d.topics, content_hash: d.content_hash, updated_at: d.updated_at } }
          : { op: 'delete', origin_peer: d.origin_peer, content_id: d.content_id, version: d.version, origin_sig: d.sig });
        const good = [];
        for (const e of entries) { const bad = await this._verifyEntry(e, shard); if (bad) { if (bad !== 'bad_signature' || e.origin_sig) this._observe(src, { abuse: 1 }); continue; } good.push(e); }   // unsigned legacy rows are skipped, never trusted
        this.db.tx(() => { for (const e of good) { try { this._applyEntry(e); pulled++; } catch { /* skip row */ } } });
        if (r.done || !r.next) break; after = r.next;
      }
    }
    this.db.tx(() => { this.db.run('DELETE FROM p2p_index_oplog WHERE shard_id=?', shard); if (snapSeq !== null && snapSeq > st.seq) { st.seq = snapSeq; st.last_epoch = snapEpoch || st.last_epoch; } this._save(st); });
    this.metrics.snapshots_pulled++; this.metrics.repaired_docs += pulled; rt.gap = false;
    return { ok: true, snapshot: true, merged: pulled, seq: st.seq };
  }

  // ------------------------------------------------------------------ integrity / anti-entropy
  /** Verify stored documents (hash + origin signature). Corrupt rows are dropped so a snapshot merge restores them. */
  async verifyIntegrity(shard, { limit = this.cfg.integrityBatch } = {}) {
    const rt = this._rt.get(shard) || this._newRt();
    const rows = this.db.all('SELECT origin_peer,content_id,title,body,language,region,topics,content_hash,updated_at,origin_sig FROM p2p_index_documents WHERE shard_id=? AND (origin_peer||char(9)||content_id)>? ORDER BY origin_peer,content_id LIMIT ?', shard, rt.verifyCursor || '', limit);
    let corrupt = 0;
    for (const r of rows) {
      let bad = r.content_hash !== C.sha256(r.title + '\n' + r.body);
      if (!bad && r.origin_sig) bad = !(await this.signer.verify(C.docPayload({ ...r, text: r.body, topics: JSON.parse(r.topics || '[]') }), r.origin_sig, r.origin_peer));
      if (bad) { corrupt++; this.db.tx(() => { this.db.run('DELETE FROM p2p_index_documents WHERE origin_peer=? AND content_id=?', r.origin_peer, r.content_id); this.db.run('DELETE FROM p2p_index_terms WHERE origin_peer=? AND content_id=?', r.origin_peer, r.content_id); }); }
    }
    rt.verifyCursor = rows.length < limit ? '' : rows[rows.length - 1].origin_peer + '\t' + rows[rows.length - 1].content_id;
    if (corrupt) { this.index._refreshShard(shard); this.log.warn(`shard ${shard}: ${corrupt} corrupt document(s) removed for repair`); }
    return { checked: rows.length, corrupt, complete: rows.length < limit };
  }

  /** Compare with the primary; repair by pull-merge, then push local-origin docs the primary lacks. */
  async reconcile(shard) {
    const st = this._states.get(shard), rt = this._rt.get(shard);
    if (!st || st.role !== ROLE.REPLICA || !st.primary) return { ok: false, reason: 'not_replica' };
    let r; try { r = await this.transport.request(st.primary, { t: 'digest', shard }, { timeoutMs: this.cfg.requestTimeoutMs }); } catch { return { ok: false, reason: 'unreachable' }; }
    if (!r || !r.ok || r.epoch !== st.epoch) return { ok: false, reason: 'epoch_mismatch' };
    if (r.seq > st.seq) { const c = await this.catchUp(shard); if (!c.ok) return c; }
    const same = (a, b) => a.digest === b.digest && a.tomb_digest === b.tomb_digest;
    if (same(this.index.shardDigests(shard), r)) return { ok: true, in_sync: true };
    const pull = await this.catchUp(shard, { from: st.primary }).then(async (x) => x.ok && !x.snapshot ? await this._forceSnapshot(shard) : x);
    const r2 = await this.transport.request(st.primary, { t: 'digest', shard }, { timeoutMs: this.cfg.requestTimeoutMs }).catch(() => null);
    if (r2 && r2.ok && same(this.index.shardDigests(shard), r2)) return { ok: true, in_sync: true, repaired: true };
    const pushed = await this._pushLocal(shard, st);
    return { ok: true, in_sync: false, pushed, pull: pull && pull.ok };
  }
  /** Merge-repair this shard from a specific member (used by a Primary whose own rows were lost). */
  async _forceSnapshot_from(shard, peer) { const st = this._states.get(shard), rt = this._rt.get(shard); if (!st || rt.syncing) return { ok: false, reason: 'busy' }; rt.syncing = true; try { return await this._snapshotSync(st, rt, peer); } catch { return { ok: false, reason: 'transport' }; } finally { rt.syncing = false; } }
  async _forceSnapshot(shard) { const st = this._states.get(shard), rt = this._rt.get(shard); if (rt.syncing) return { ok: false, reason: 'busy' }; rt.syncing = true; try { return await this._snapshotSync(st, rt, st.primary); } catch { return { ok: false, reason: 'transport' }; } finally { rt.syncing = false; } }
  async _pushLocal(shard, st, max = 100) {
    const rows = this.db.all('SELECT origin_peer,content_id,title,body,language,region,topics,content_hash,updated_at,origin_sig FROM p2p_index_documents WHERE shard_id=? AND origin_peer=? LIMIT ?', shard, this.self, max);
    await this._signLocal(rows); let n = 0;
    for (const d of rows) {
      const entry = { op: 'upsert', origin_peer: d.origin_peer, content_id: d.content_id, origin_sig: d.origin_sig, doc: { origin_peer: d.origin_peer, content_id: d.content_id, title: d.title, text: d.body, language: d.language, region: d.region, topics: JSON.parse(d.topics || '[]'), content_hash: d.content_hash, updated_at: d.updated_at } };
      try { const r = await this.transport.request(st.primary, { t: 'submit', shard, entry }, { timeoutMs: this.cfg.requestTimeoutMs }); if (r && r.ok) n++; } catch { break; }
    }
    return n;
  }

  // ------------------------------------------------------------------ plans, replicas, rebalance
  /** Adopt deterministic assignment plans (DistributedIndex.planAssignments). Creates replicas; the planned primary starts the election. */
  async adoptPlan(plans) {
    const started = [];
    for (const p of plans || []) {
      if (!p || !p.primary) continue;
      const members = [p.primary.peer_id, ...(p.replicas || []).map((r) => r.peer_id)].filter(Boolean).slice(0, this.cfg.maxMembers);
      if (!members.includes(this.self)) continue;
      const st = this._st(p.shard_id, true);
      if (st.epoch > 0) continue;                                              // already running: membership only changes through joint-quorum elections
      if (st.role === ROLE.NONE) { if (!this.governor.canHost(this._hosted())) continue; st.role = ROLE.LEARNER; }
      st.planned = members; this.db.tx(() => this._save(st));
      if (p.primary.peer_id === this.self) started.push(p.shard_id);
    }
    const out = [];
    for (const s of started) out.push({ shard: s, ...(await this.elect(s, { members: this._st(s).planned })) });
    return out;
  }

  _peerHealthy(rt, p) { const t = rt.acks.get(p); return !!t && this.now() - t < this.cfg.deadAfterMs; }
  _desiredMembers(st, rt, candidates) {
    const eligible = (candidates || []).filter((n) => n && n.verified === true && n.trust_state === 'TRUSTED' && n.peer_id && Number(n.capacity) > 0);
    const byId = new Map(eligible.map((n) => [String(n.peer_id), n]));
    const live = st.members.filter((p) => p === this.self || (byId.has(p) && this._peerHealthy(rt, p)));
    if (live.length === st.members.length && st.members.length >= this.cfg.replicas) return null;
    const pool = eligible.filter((n) => !st.members.includes(String(n.peer_id)))
      .map((n) => ({ id: String(n.peer_id), score: rendezvousScore(st.shard_id, n.peer_id) * Math.min(1, Math.max(0.05, Number(n.capacity) || 0)) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const desired = [...live, ...pool.slice(0, Math.max(0, this.cfg.replicas - live.length)).map((x) => x.id)].slice(0, this.cfg.maxMembers);
    if (sameSet(desired, st.members) || desired.length < 1) return null;
    return desired;
  }

  /**
   * Safe rebalance / replica repair: (1) invite additions as non-voting learners, (2) wait until each is byte-identical (match+digest),
   * (3) switch membership with a JOINT-QUORUM election. Bounded concurrency + cooldown prevent churn.
   */
  async rebalance(candidates) {
    const report = { started: [], completed: [], aborted: [] };
    let active = 0; for (const rt of this._rt.values()) if (rt.migrating) active++;
    for (const st of this._states.values()) {
      if (st.role !== ROLE.PRIMARY) continue;
      const rt = this._rt.get(st.shard_id);
      if (rt.migrating) { const r = await this._advanceMigration(st, rt); if (r) report[r.done ? 'completed' : 'aborted'].push(st.shard_id); continue; }
      if (active >= this.cfg.maxMigrations || !this.leaseValid(st.shard_id) || this.now() - rt.lastMigration < this.cfg.migrationCooldownMs && rt.lastMigration) continue;
      if (this.governor.pressure().high) continue;
      const desired = this._desiredMembers(st, rt, candidates); if (!desired) continue;
      const additions = desired.filter((p) => !st.members.includes(p)); const invited = [];
      for (const a of additions) {
        const r = await this.transport.request(a, { t: 'invite', shard: st.shard_id, epoch: st.epoch, members: st.members }, { timeoutMs: this.cfg.requestTimeoutMs }).catch(() => null);
        if (r && r.ok) invited.push(a);
      }
      if (invited.length !== additions.length) continue;            // never half-start a migration
      st.learners = [...new Set([...st.learners, ...additions])].slice(0, this.cfg.maxMembers); this.db.tx(() => this._save(st));
      rt.migrating = { target: desired, additions, started: this.now() }; active++; report.started.push(st.shard_id);
      await this._replicateShard(st.shard_id);
    }
    return report;
  }
  async _advanceMigration(st, rt) {
    const mg = rt.migrating;
    if (this.now() - mg.started > this.cfg.migrationTimeoutMs || !this.leaseValid(st.shard_id)) { rt.migrating = null; st.learners = []; rt.lastMigration = this.now(); this.db.tx(() => this._save(st)); return { done: false }; }
    await this._replicateShard(st.shard_id);
    const mine = this.index.shardDigests(st.shard_id);
    for (const a of mg.additions) {
      const pr = rt.progress.get(a); if (!pr || pr.match < st.seq) return null;
      const d = await this.transport.request(a, { t: 'digest', shard: st.shard_id }, { timeoutMs: this.cfg.requestTimeoutMs }).catch(() => null);
      if (!d || !d.ok || d.digest !== mine.digest || d.tomb_digest !== mine.tomb_digest) return null;
    }
    const r = await this.elect(st.shard_id, { members: mg.target });
    rt.lastMigration = this.now();
    if (!r.ok) return null;                                          // try again next round until timeout
    const s2 = this._states.get(st.shard_id); s2.learners = []; this.db.tx(() => this._save(s2));
    this._rt.get(st.shard_id).migrating = null; this._rt.get(st.shard_id).lastMigration = this.now();
    return { done: true };
  }
  _onInvite(from, m) {
    if (this.trust && this.trust.stateOf(from) !== 'TRUSTED') return this._reject('inviter_untrusted');
    const shard = Number(m.shard), st = this._st(shard, true), rt = this._rt.get(shard);
    if (st.role === ROLE.PRIMARY || (st.role === ROLE.REPLICA && st.primary !== from)) return this._reject('already_member');
    if (st.role === ROLE.NONE || st.role === ROLE.RETIRED) { if (!this.governor.canHost(this._hosted())) return this._reject('no_capacity'); }
    if (Number(m.epoch) < st.epoch || Number(m.epoch) < st.voted_epoch) return this._reject('stale_epoch');
    if (st.role !== ROLE.REPLICA) { st.role = ROLE.LEARNER; st.epoch = Number(m.epoch); st.primary = from; st.members = []; st.planned = [from]; st.seq = st.role === ROLE.LEARNER ? st.seq : 0; }
    rt.lastContact = this.now(); rt.gap = true; this.db.tx(() => this._save(st));
    return { ok: true };
  }
  _onRelease(from, m) {
    const shard = Number(m.shard), st = this._states.get(shard), rt = this._rt.get(shard);
    if (!st || st.role === ROLE.PRIMARY || from !== st.primary || Number(m.epoch) !== st.epoch) return this._reject('bad_release');
    rt.released = true; return { ok: true };
  }
  /** Graceful shutdown of a Primary: tell members to elect immediately instead of waiting a full lease. */
  async gracefulRelease() {
    for (const st of this._states.values()) {
      if (st.role !== ROLE.PRIMARY) continue;
      const rt = this._rt.get(st.shard_id); rt.leaseUntil = 0; st.status = 'FENCED';          // fence ourselves first, THEN release
      await Promise.allSettled(st.members.filter((p) => p !== this.self).map((p) => this.transport.request(p, { t: 'release', shard: st.shard_id, epoch: st.epoch }, { timeoutMs: this.cfg.requestTimeoutMs })));
    }
  }

  // ------------------------------------------------------------------ scheduler
  /**
   * One bounded maintenance pass (heartbeats, catch-up, failover elections, anti-entropy, rebalance, pending flush).
   * Time-boxed by the resource governor so it never starves the Hub's foreground work.
   */
  async tick({ candidates = null } = {}) {
    if (this._ticking || this._stopped) return { skipped: true };
    this._ticking = true; const t0 = Date.now(), budget = this.governor.tickBudgetMs() * 4; const did = { heartbeats: 0, catchups: 0, elections: 0, reconciles: 0 };
    try {
      const ids = [...this._states.keys()].sort((a, b) => a - b);
      const n = ids.length;
      for (let k = 0; k < n; k++) {
        if (Date.now() - t0 > budget && k > 0) break;
        const shard = ids[(this._cursor + k) % n], st = this._states.get(shard), rt = this._rt.get(shard);
        if (st.role === ROLE.PRIMARY) {
          if (this.now() - rt.lastBeat >= this.cfg.heartbeatMs) { await this._replicateShard(shard); did.heartbeats++; }
        } else if (st.role === ROLE.REPLICA || st.role === ROLE.LEARNER) {
          if (rt.gap && !rt.syncing) { await this.catchUp(shard); did.catchups++; }
          if (st.role === ROLE.LEARNER && st.epoch === 0 && st.planned[0] === this.self && this.now() >= rt.nextElection && !rt.electing) { await this.elect(shard, { members: st.planned }); did.elections++; continue; }
          if (st.role === ROLE.REPLICA && st.primary) {
            const silent = this.now() - rt.lastContact, wait = rt.released ? 0 : this.cfg.leaseMs;
            const order = C.sortedUnique(st.members).filter((p) => p !== st.primary).sort((a, b) => rendezvousScore(shard, b) - rendezvousScore(shard, a));
            const slot = Math.max(0, order.indexOf(this.self)), delay = slot * this.cfg.electionStepMs + Math.floor(Math.random() * 250);
            if (silent >= wait + delay && this.now() >= rt.nextElection && !rt.electing) { await this.elect(shard, { members: st.members }); did.elections++; continue; }
            if (this.now() - rt.lastReconcile > this.cfg.reconcileMs * (0.8 + Math.random() * 0.4)) { rt.lastReconcile = this.now(); await this.reconcile(shard); did.reconciles++; }
          }
        }
      }
      this._cursor = n ? (this._cursor + 1) % n : 0;
      await this._flushPending();
      if (candidates) await this.rebalance(candidates);
    } finally { this._ticking = false; }
    return did;
  }

  // ------------------------------------------------------------------ diagnostics
  status({ limit = 50 } = {}) {
    const shards = []; const roles = {};
    for (const st of this._states.values()) {
      roles[st.role] = (roles[st.role] || 0) + 1;
      if (shards.length < limit) shards.push({ shard: st.shard_id, role: st.role, epoch: st.epoch, seq: st.seq, status: st.status, members: st.members.length, writable: st.role === ROLE.PRIMARY ? this.leaseValid(st.shard_id) : false, under_replicated: st.members.length > 0 && st.members.length < this.cfg.replicas });
    }
    return { phase: '5-replication', roles, hosted: this._hosted(), pending_local: this._pending.size, resources: this.governor.snapshot(), metrics: this.metrics, shards };
  }
}

module.exports = { ShardCoordinator, ROLE, DEFAULTS, majority, sameSet };
