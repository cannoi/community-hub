'use strict';
/**
 * Phase 5 — bounded local public-content index + deterministic shard metadata.
 * This module deliberately stores metadata for PUBLIC content only. It does not
 * fetch remote content, grant read access, or claim that remote replicas exist.
 * Remote manifests must pass the caller-supplied signature verifier.
 */
const crypto = require('crypto');

const DEFAULT_SHARDS = 64;
const MAX_TEXT = 12000;
const ST = require('./search-text');
const { tokenize, normalizeText, TOKENIZER_VERSION } = ST;      // Phase 6: multilingual tokenizer v2 (Latin pipeline unchanged)

function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function shardFor(key, count = DEFAULT_SHARDS) {
  const n = Math.max(1, Math.min(4096, Number(count) || DEFAULT_SHARDS));
  return parseInt(sha256(key).slice(0, 8), 16) % n;
}
function canonicalDocument(doc) {
  return JSON.stringify({
    origin_peer: String(doc.origin_peer), content_id: String(doc.content_id),
    title: String(doc.title || '').slice(0, 300), text: String(doc.text || '').slice(0, MAX_TEXT),
    language: String(doc.language || 'und').slice(0, 12), region: String(doc.region || 'ZZ').slice(0, 2).toUpperCase(),
    topics: Array.isArray(doc.topics) ? doc.topics.map(x => String(x).slice(0, 40)).slice(0, 12) : [],
    content_hash: String(doc.content_hash || ''), updated_at: Number(doc.updated_at) || 0,
  });
}

class DistributedIndex {
  constructor({ db, localPeerId = () => null, shardCount = DEFAULT_SHARDS, maxDocuments = 50000, maxBytes = 64 * 1024 * 1024, verifyManifest = null, log = null } = {}) {
    this.db = db || null;
    this.localPeerId = localPeerId;
    this.shardCount = Math.max(1, Math.min(4096, Number(shardCount) || DEFAULT_SHARDS));
    this.maxDocuments = Math.max(100, Number(maxDocuments) || 50000);
    this.maxBytes = Math.max(1024 * 1024, Number(maxBytes) || 64 * 1024 * 1024);
    this.verifyManifest = typeof verifyManifest === 'function' ? verifyManifest : null;
    this.log = log || { warn() {}, debug() {} };
    this._memory = new Map();
    this._replToken = Symbol('index-replication');   // only the replication coordinator is handed this
    this._managed = () => false;
    this._listeners = [];
    this._init();
  }

  /** Token the ShardCoordinator passes to write into shards it manages (fenced replication path). */
  replicationToken() { return this._replToken; }
  setManagedPredicate(fn) { this._managed = typeof fn === 'function' ? fn : () => false; }
  onChange(fn) { if (typeof fn === 'function') this._listeners.push(fn); }
  _emit(ev) { for (const fn of this._listeners) { try { fn(ev); } catch (e) { this.log.warn('index listener: ' + (e && e.message)); } } }

  _init() {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS p2p_index_documents (
        origin_peer TEXT NOT NULL, content_id TEXT NOT NULL, shard_id INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT 'und',
        region TEXT NOT NULL DEFAULT 'ZZ', topics TEXT NOT NULL DEFAULT '[]', content_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, byte_size INTEGER NOT NULL,
        PRIMARY KEY(origin_peer, content_id)
      );
      CREATE INDEX IF NOT EXISTS ix_p2p_index_shard ON p2p_index_documents(shard_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS ix_p2p_index_origin ON p2p_index_documents(origin_peer, updated_at DESC);
      CREATE TABLE IF NOT EXISTS p2p_index_terms (
        term TEXT NOT NULL, origin_peer TEXT NOT NULL, content_id TEXT NOT NULL,
        shard_id INTEGER NOT NULL, PRIMARY KEY(term, origin_peer, content_id)
      );
      CREATE INDEX IF NOT EXISTS ix_p2p_index_terms_lookup ON p2p_index_terms(term, shard_id);
      CREATE TABLE IF NOT EXISTS p2p_index_shards (
        shard_id INTEGER PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL DEFAULT 'ACTIVE', document_count INTEGER NOT NULL DEFAULT 0,
        digest TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS p2p_index_assignments (
        shard_id INTEGER NOT NULL, peer_id TEXT NOT NULL, role TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'PLANNED', score REAL NOT NULL DEFAULT 0,
        assigned_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(shard_id, peer_id, role)
      );
      CREATE INDEX IF NOT EXISTS ix_p2p_index_assign_peer ON p2p_index_assignments(peer_id, state);
    `);
    // Defensive copy of migration 11 so a DB opened without the migration runner still works.
    if (!this.db.hasColumn('p2p_index_documents', 'origin_sig')) this.db.exec("ALTER TABLE p2p_index_documents ADD COLUMN origin_sig TEXT NOT NULL DEFAULT ''");
    this.db.exec(`CREATE TABLE IF NOT EXISTS p2p_index_tombstones (origin_peer TEXT NOT NULL, content_id TEXT NOT NULL, shard_id INTEGER NOT NULL,
      version INTEGER NOT NULL, sig TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, PRIMARY KEY(origin_peer, content_id));
      CREATE INDEX IF NOT EXISTS ix_p2p_index_tomb_shard ON p2p_index_tombstones(shard_id, origin_peer, content_id);`);
    this._scheduleRebuild();
  }
  _scheduleRebuild() {
    try { const r = this.rebuildTermsIfNeeded(); if (!r.done) { const t = setTimeout(() => { try { if (!this.db.closed) this._scheduleRebuild(); } catch { /* ignore */ } }, 25); if (t.unref) t.unref(); } } catch (e) { this.log.warn('term rebuild: ' + (e && e.message)); }
  }

  getTombstone(origin, id) {
    return this.db ? (this.db.get('SELECT * FROM p2p_index_tombstones WHERE origin_peer=? AND content_id=?', String(origin), String(id)) || null) : null;
  }
  getDocument(origin, id) { return this._get(String(origin), String(id)); }

  _get(origin, id) {
    if (this.db) return this.db.get('SELECT * FROM p2p_index_documents WHERE origin_peer=? AND content_id=?', origin, id) || null;
    return this._memory.get(origin + '\t' + id) || null;
  }

  /** Index a locally-owned or cryptographically verified PUBLIC document. */
  upsertDocument(input, { verified = false, local = false, originSig = '', replication = null } = {}) {
    if (!input || input.visibility !== 'public') return { ok: false, reason: 'not_public' };
    const origin = String(input.origin_peer || '');
    const id = String(input.content_id || '');
    if (!origin || origin.length > 128 || !id || id.length > 160) return { ok: false, reason: 'invalid_identity' };
    if (!local && !verified) return { ok: false, reason: 'unverified_source' };
    const title = String(input.title || '').slice(0, 300);
    const body = String(input.text || '').slice(0, MAX_TEXT);
    const updatedAt = Number(input.updated_at) || Date.now();
    const computedHash = sha256(title + '\n' + body);
    const hash = String(input.content_hash || computedHash);
    if (!/^[a-f0-9]{64}$/i.test(hash)) return { ok: false, reason: 'invalid_hash' };
    if (hash.toLowerCase() !== computedHash) return { ok: false, reason: 'content_hash_mismatch' };
    const shard = shardFor(origin + ':' + id, this.shardCount);
    const viaReplication = replication === this._replToken;
    // Fencing at the storage layer: a shard managed by the replication coordinator accepts remote-origin writes ONLY from it.
    if (!local && !viaReplication && this._managed(shard)) return { ok: false, reason: 'managed_shard_requires_replication' };
    const topics = Array.isArray(input.topics) ? input.topics.map(x => String(x).slice(0, 40)).slice(0, 12) : [];
    const record = { origin_peer: origin, content_id: id, shard_id: shard, title, body,
      language: String(input.language || 'und').slice(0, 12), region: String(input.region || 'ZZ').slice(0, 2).toUpperCase(),
      topics, content_hash: hash, updated_at: updatedAt, indexed_at: Date.now(), byte_size: Buffer.byteLength(title + body) };
    if (record.byte_size > MAX_TEXT + 1200) return { ok: false, reason: 'document_too_large' };
    const old = this._get(origin, id);
    const tomb = this.getTombstone(origin, id);
    if (tomb && Number(tomb.version) >= updatedAt) return { ok: false, reason: 'tombstoned', shard_id: shard };
    if (old && old.content_hash === hash && Number(old.updated_at) >= updatedAt) {
      if (originSig && !old.origin_sig && this.db) this.db.run("UPDATE p2p_index_documents SET origin_sig=? WHERE origin_peer=? AND content_id=?", String(originSig), origin, id);
      return { ok: true, unchanged: true, shard_id: shard, content_hash: hash };
    }
    // Replicated writes are last-writer-wins so every replica converges regardless of arrival order.
    if (viaReplication && old && Number(old.updated_at) > updatedAt) return { ok: true, unchanged: true, stale: true, shard_id: shard, content_hash: old.content_hash };
    const terms = tokenize(title + ' ' + body + ' ' + topics.join(' '));
    if (this.db) {
      this.db.tx(() => {
        this.db.run('DELETE FROM p2p_index_terms WHERE origin_peer=? AND content_id=?', origin, id);
        this.db.run(`INSERT INTO p2p_index_documents(origin_peer,content_id,shard_id,title,body,language,region,topics,content_hash,updated_at,indexed_at,byte_size,origin_sig)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(origin_peer,content_id) DO UPDATE SET shard_id=excluded.shard_id,title=excluded.title,body=excluded.body,language=excluded.language,region=excluded.region,topics=excluded.topics,content_hash=excluded.content_hash,updated_at=excluded.updated_at,indexed_at=excluded.indexed_at,byte_size=excluded.byte_size,origin_sig=excluded.origin_sig`,
          origin,id,shard,title,body,record.language,record.region,JSON.stringify(topics),hash,updatedAt,record.indexed_at,record.byte_size,String(originSig || ''));
        this.db.run('DELETE FROM p2p_index_tombstones WHERE origin_peer=? AND content_id=?', origin, id);
        for (const term of terms) this.db.run('INSERT OR IGNORE INTO p2p_index_terms(term,origin_peer,content_id,shard_id) VALUES(?,?,?,?)', term,origin,id,shard);
        this._refreshShard(shard);
        this._enforceBounds();
      });
    } else this._memory.set(origin + '\t' + id, { ...record, topics: JSON.stringify(topics), terms });
    this._emit({ type: 'upsert', shard_id: shard, local: !!local, replicated: viaReplication, record: { ...record, text: body } });
    return { ok: true, unchanged: false, shard_id: shard, content_hash: hash, terms: terms.length };
  }

  /** Remove a document and (db mode) leave a tombstone so a stale replicated upsert can never resurrect it. */
  removeDocument(origin, id, { version = 0, sig = '', replication = null } = {}) {
    origin = String(origin); id = String(id);
    const shard = shardFor(origin + ':' + id, this.shardCount);
    const viaReplication = replication === this._replToken;
    const isLocal = origin === String(this.localPeerId() || '');
    if (!isLocal && !viaReplication && this._managed(shard)) return false;
    if (this.db) {
      const ver = Number(version) || Date.now();
      const prior = this.getTombstone(origin, id);
      const cur = this._get(origin, id);
      if (viaReplication && cur && Number(cur.updated_at) > ver) return false;       // delete is older than the live version
      let removed = false;
      this.db.tx(() => {
        const r = this.db.run('DELETE FROM p2p_index_documents WHERE origin_peer=? AND content_id=?', origin, id);
        this.db.run('DELETE FROM p2p_index_terms WHERE origin_peer=? AND content_id=?', origin, id);
        removed = Number(r.changes || 0) > 0;
        if (!prior || Number(prior.version) < ver) {
          this.db.run(`INSERT INTO p2p_index_tombstones(origin_peer,content_id,shard_id,version,sig,created_at) VALUES(?,?,?,?,?,?)
            ON CONFLICT(origin_peer,content_id) DO UPDATE SET version=excluded.version,sig=excluded.sig,created_at=excluded.created_at,shard_id=excluded.shard_id`,
            origin, id, shard, ver, String(sig || ''), Date.now());
        }
        this._refreshShard(shard);
      });
      if (removed || !prior || Number(prior.version) < ver) this._emit({ type: 'delete', shard_id: shard, local: isLocal, replicated: viaReplication, origin_peer: origin, content_id: id, version: ver });
      return removed;
    }
    return this._memory.delete(origin + '\t' + id);
  }

  searchLocal(query, { limit = 20, language, region } = {}) {
    const terms = tokenize(query);
    if (!terms.length) return { items: [], partial: false, source: 'local-index' };
    limit = Math.max(1, Math.min(50, Number(limit) || 20));
    let rows = [];
    if (this.db) {
      const marks = terms.map(() => '?').join(',');
      rows = this.db.all(`SELECT d.*, COUNT(DISTINCT t.term) AS matched_terms FROM p2p_index_documents d
        JOIN p2p_index_terms t ON t.origin_peer=d.origin_peer AND t.content_id=d.content_id
        WHERE t.term IN (${marks}) GROUP BY d.origin_peer,d.content_id ORDER BY matched_terms DESC,d.updated_at DESC LIMIT ?`, ...terms, limit * 4);
    } else {
      rows = [...this._memory.values()].map(d => ({ ...d, matched_terms: terms.filter(t => d.terms.includes(t)).length })).filter(d => d.matched_terms).sort((a,b) => b.matched_terms-a.matched_terms || b.updated_at-a.updated_at).slice(0,limit*4);
    }
    rows.sort((a,b) => (b.matched_terms-a.matched_terms) || ((language && a.language === language ? -1 : 0) - (language && b.language === language ? -1 : 0)) || ((region && a.region === region ? -1 : 0) - (region && b.region === region ? -1 : 0)) || (b.updated_at-a.updated_at));
    return { items: rows.slice(0,limit).map(r => ({ origin_peer:r.origin_peer, content_id:r.content_id, title:r.title, excerpt:String(r.body || '').slice(0,280), language:r.language, region:r.region, topics: safeJson(r.topics), content_hash:r.content_hash, updated_at:r.updated_at, shard_id:r.shard_id })), partial: false, source: 'local-index' };
  }

  // ------------------------------------------------------------------ Phase 6: tokenizer migration + federated query primitives
  /**
   * Terms are DERIVED data. When the tokenizer version changes, rebuild them from the stored documents in small batches
   * (documents are never modified). Searches keep working while this runs (old Latin terms are a subset of the new ones).
   */
  rebuildTermsIfNeeded({ batch = 200 } = {}) {
    if (!this.db) return { rebuilt: 0, done: true };
    this.db.exec('CREATE TABLE IF NOT EXISTS p2p_index_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    const cur = this.db.get("SELECT v FROM p2p_index_meta WHERE k='tokenizer_version'");
    if (cur && Number(cur.v) === TOKENIZER_VERSION) return { rebuilt: 0, done: true };
    const cursor = this.db.get("SELECT v FROM p2p_index_meta WHERE k='rebuild_cursor'");
    const after = cursor ? String(cursor.v) : '';
    const rows = this.db.all("SELECT origin_peer,content_id,shard_id,title,body,topics FROM p2p_index_documents WHERE (origin_peer||char(9)||content_id)>? ORDER BY origin_peer,content_id LIMIT ?", after, batch);
    this.db.tx(() => {
      for (const r of rows) {
        const terms = tokenize(r.title + ' ' + r.body + ' ' + safeJson(r.topics).join(' '));
        this.db.run('DELETE FROM p2p_index_terms WHERE origin_peer=? AND content_id=?', r.origin_peer, r.content_id);
        for (const t of terms) this.db.run('INSERT OR IGNORE INTO p2p_index_terms(term,origin_peer,content_id,shard_id) VALUES(?,?,?,?)', t, r.origin_peer, r.content_id, r.shard_id);
      }
      if (rows.length < batch) { this.db.run("INSERT OR REPLACE INTO p2p_index_meta(k,v) VALUES('tokenizer_version',?)", String(TOKENIZER_VERSION)); this.db.run("DELETE FROM p2p_index_meta WHERE k='rebuild_cursor'"); }
      else { const l = rows[rows.length - 1]; this.db.run("INSERT OR REPLACE INTO p2p_index_meta(k,v) VALUES('rebuild_cursor',?)", l.origin_peer + '\t' + l.content_id); }
    });
    return { rebuilt: rows.length, done: rows.length < batch };
  }

  /**
   * Candidate retrieval for federated search. terms = [{t, w}] already analysed by the REQUESTER (so every Hub uses one
   * analysis). Returns FULL signed documents (the requester verifies hash + origin signature itself). Strict filters are only
   * applied when explicitly requested by the user; region/language bias is done by the requester's ranking.
   */
  searchWeighted(terms, { limit = 30, rowCap = 120, language, region, topic, strict = false } = {}) {
    if (!this.db || !Array.isArray(terms) || !terms.length) return [];
    limit = Math.max(1, Math.min(50, Number(limit) || 30)); rowCap = Math.max(limit, Math.min(300, Number(rowCap) || 120));
    const ts = terms.slice(0, 24).map((x) => String(x.t)); const marks = ts.map(() => '?').join(',');
    const wcase = terms.slice(0, 24).map(() => 'WHEN ? THEN ?').join(' ');
    const wargs = terms.slice(0, 24).flatMap((x) => [String(x.t), Number(x.w) || 1]);
    const where = []; const fargs = [];
    if (strict && language) { where.push('d.language=?'); fargs.push(String(language)); }
    if (strict && region) { where.push('d.region=?'); fargs.push(String(region).toUpperCase()); }
    if (strict && topic) { where.push("d.topics LIKE ? ESCAPE '\\'"); fargs.push('%"' + String(topic).replace(/[%_\\"]/g, '') + '"%'); }
    const rows = this.db.all(`SELECT d.origin_peer,d.content_id,d.title,d.body,d.language,d.region,d.topics,d.content_hash,d.updated_at,d.origin_sig,
        SUM(CASE t.term ${wcase} ELSE 0 END) AS wscore
      FROM p2p_index_terms t JOIN p2p_index_documents d ON d.origin_peer=t.origin_peer AND d.content_id=t.content_id
      WHERE t.term IN (${marks}) ${where.length ? 'AND ' + where.join(' AND ') : ''}
      GROUP BY d.origin_peer,d.content_id ORDER BY wscore DESC, d.updated_at DESC LIMIT ?`, ...wargs, ...ts, ...fargs, rowCap);
    return rows.slice(0, rowCap).map((r) => ({ origin_peer: r.origin_peer, content_id: r.content_id, title: r.title, text: r.body, language: r.language, region: r.region, topics: safeJson(r.topics), content_hash: r.content_hash, updated_at: r.updated_at, origin_sig: r.origin_sig, wscore: Number(r.wscore) || 0 }));
  }

  /** Newest public documents (Explore browse mode). */
  recentDocuments({ limit = 30, before = 0, language, region, topic, strict = false } = {}) {
    if (!this.db) return [];
    limit = Math.max(1, Math.min(50, Number(limit) || 30));
    const where = []; const args = [];
    if (before) { where.push('updated_at < ?'); args.push(Number(before)); }
    if (strict && language) { where.push('language=?'); args.push(String(language)); }
    if (strict && region) { where.push('region=?'); args.push(String(region).toUpperCase()); }
    if (strict && topic) { where.push("topics LIKE ? ESCAPE '\\'"); args.push('%"' + String(topic).replace(/[%_\\"]/g, '') + '"%'); }
    return this.db.all(`SELECT origin_peer,content_id,title,body,language,region,topics,content_hash,updated_at,origin_sig FROM p2p_index_documents ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`, ...args, limit)
      .map((r) => ({ origin_peer: r.origin_peer, content_id: r.content_id, title: r.title, text: r.body, language: r.language, region: r.region, topics: safeJson(r.topics), content_hash: r.content_hash, updated_at: r.updated_at, origin_sig: r.origin_sig, wscore: 0 }));
  }

  /** Digest/metadata refresh is coalesced: writes only mark the shard dirty; one pass per shard recomputes it (was O(n) per write). */
  _refreshShard(shard) {
    if (!this.db) return;
    this._dirty = this._dirty || new Set(); this._dirty.add(Number(shard));
    if (!this._flushTimer) { this._flushTimer = setTimeout(() => { this._flushTimer = null; try { this.flushShards(); } catch (e) { this.log.warn('shard flush: ' + (e && e.message)); } }, 100); if (this._flushTimer.unref) this._flushTimer.unref(); }
  }
  flushShards() {
    if (!this.db || !this._dirty || !this._dirty.size) return 0;
    const ids = [...this._dirty]; this._dirty.clear(); let n = 0;
    for (const shard of ids) {
      if (this.db.closed) return n;
      const rows = this.db.all('SELECT origin_peer,content_id,content_hash,updated_at FROM p2p_index_documents WHERE shard_id=? ORDER BY origin_peer,content_id', shard);
      const digest = sha256(rows.map(r => `${r.origin_peer}:${r.content_id}:${r.content_hash}:${r.updated_at}`).join('\n'));
      this.db.run(`INSERT INTO p2p_index_shards(shard_id,generation,state,document_count,digest,updated_at) VALUES(?,1,'ACTIVE',?,?,?)
        ON CONFLICT(shard_id) DO UPDATE SET document_count=excluded.document_count,digest=excluded.digest,updated_at=excluded.updated_at`, shard, rows.length, digest, Date.now()); n++;
    }
    return n;
  }

  _enforceBounds() {
    if (!this.db) return;
    const count = Number(this.db.get('SELECT COUNT(*) c FROM p2p_index_documents')?.c || 0);
    let bytes = Number(this.db.get('SELECT COALESCE(SUM(byte_size),0) n FROM p2p_index_documents')?.n || 0);
    if (count <= this.maxDocuments && bytes <= this.maxBytes) return;
    const excess = this.db.all('SELECT origin_peer,content_id,byte_size FROM p2p_index_documents ORDER BY indexed_at ASC LIMIT ?', Math.min(count, Math.max(count-this.maxDocuments, 1)));
    for (const d of excess) {
      this.db.run('DELETE FROM p2p_index_terms WHERE origin_peer=? AND content_id=?', d.origin_peer,d.content_id);
      this.db.run('DELETE FROM p2p_index_documents WHERE origin_peer=? AND content_id=?', d.origin_peer,d.content_id);
      bytes -= Number(d.byte_size)||0;
      if (bytes <= this.maxBytes && count-excess.indexOf(d)-1 <= this.maxDocuments) break;
    }
  }

  /** Deterministic rendezvous assignment plan; candidates must be explicitly verified and trusted. */
  planAssignments(shardIds, candidates, { replicas = 2, ttlMs = 86400000 } = {}) {
    const eligible = (Array.isArray(candidates) ? candidates : []).filter(n => n && n.verified === true && n.trust_state === 'TRUSTED' && n.peer_id && Number(n.capacity) > 0);
    const plans = [];
    for (const shard of [...new Set((shardIds || []).map(Number).filter(Number.isInteger))]) {
      const ranked = eligible.map(n => ({ peer_id:String(n.peer_id), score: rendezvousScore(shard, n.peer_id) * Math.min(1, Math.max(0.05, Number(n.capacity)||0)), region:n.region || 'ZZ' })).sort((a,b)=>b.score-a.score || a.peer_id.localeCompare(b.peer_id));
      const selected = ranked.slice(0, Math.max(1, Math.min(5, Number(replicas)||2)));
      plans.push({ shard_id:shard, primary:selected[0] || null, replicas:selected.slice(1), under_replicated:selected.length < Math.max(1, Number(replicas)||2), expires_at:Date.now()+Math.max(60000,Number(ttlMs)||86400000) });
    }
    return plans;
  }

  applyShardManifest(manifest, { sourcePeer, verified = false } = {}) {
    if (!manifest || !Array.isArray(manifest.shards) || manifest.shards.length > 4096 || !sourcePeer) return { ok:false, reason:'invalid_manifest' };
    if (!verified || !this.verifyManifest || this.verifyManifest(manifest, sourcePeer) !== true) return { ok:false, reason:'unverified_manifest' };
    const now = Date.now();
    if (Number(manifest.expires_at) <= now || Number(manifest.expires_at) > now + 7*86400000) return { ok:false, reason:'expired_manifest' };
    if (this.db) this.db.tx(() => {
      for (const s of manifest.shards) {
        if (!Number.isInteger(s.shard_id) || s.shard_id < 0 || s.shard_id >= this.shardCount || !/^[a-f0-9]{64}$/i.test(String(s.digest||''))) throw new Error('invalid shard descriptor');
        this.db.run(`INSERT INTO p2p_index_assignments(shard_id,peer_id,role,state,score,assigned_at,expires_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(shard_id,peer_id,role) DO UPDATE SET state=excluded.state,score=excluded.score,assigned_at=excluded.assigned_at,expires_at=excluded.expires_at`, s.shard_id,String(s.primary_peer||sourcePeer),'PRIMARY','PLANNED',Number(s.score)||0,now,manifest.expires_at);
        for (const peer of (Array.isArray(s.replicas)?s.replicas:[]).slice(0,4)) this.db.run(`INSERT OR REPLACE INTO p2p_index_assignments(shard_id,peer_id,role,state,score,assigned_at,expires_at) VALUES(?,?,?,'PLANNED',?,?,?)`,s.shard_id,String(peer),'REPLICA',0,now,manifest.expires_at);
      }
    });
    return { ok:true, accepted:manifest.shards.length, source_peer:sourcePeer };
  }

  /** Export a bounded public-only shard snapshot for an authenticated replication transport. */
  exportShard(shardId, { limit = 5000 } = {}) {
    if (this.db) this.flushShards();
    if (!this.db) return { ok:false, reason:'persistent_store_required' };
    const id = Number(shardId);
    if (!Number.isInteger(id) || id < 0 || id >= this.shardCount) return { ok:false, reason:'invalid_shard' };
    limit = Math.max(1, Math.min(5000, Number(limit) || 5000));
    const rows = this.db.all('SELECT origin_peer,content_id,title,body,language,region,topics,content_hash,updated_at,origin_sig FROM p2p_index_documents WHERE shard_id=? ORDER BY origin_peer,content_id LIMIT ?', id, limit);
    const docs = rows.map(r => ({ ...r, topics:safeJson(r.topics), visibility:'public' }));
    const digest = sha256(docs.map(r => `${r.origin_peer}:${r.content_id}:${r.content_hash}:${r.updated_at}`).join('\n'));
    return { ok:true, shard_id:id, generation:1, count:docs.length, digest, documents:docs };
  }

  /** Import only a verified snapshot whose full-document digest matches its manifest. */
  importShardSnapshot(snapshot, { sourcePeer, verified = false } = {}) {
    if (!snapshot || !Array.isArray(snapshot.documents) || snapshot.documents.length > 5000 || !sourcePeer) return { ok:false, reason:'invalid_snapshot' };
    if (!verified || !this.verifyManifest || this.verifyManifest(snapshot, sourcePeer) !== true) return { ok:false, reason:'unverified_snapshot' };
    const docs = snapshot.documents;
    if (docs.some(r => String(r.content_hash || '').toLowerCase() !== sha256(String(r.title || '') + '\n' + String(r.body || '')))) return { ok:false, reason:'snapshot_integrity_mismatch' };
    const digest = sha256(docs.map(r => `${r.origin_peer}:${r.content_id}:${r.content_hash}:${r.updated_at}`).join('\n'));
    if (digest !== snapshot.digest || Number(snapshot.count) !== docs.length) return { ok:false, reason:'snapshot_integrity_mismatch' };
    for (const d of docs) {
      if (shardFor(String(d.origin_peer) + ':' + String(d.content_id), this.shardCount) !== Number(snapshot.shard_id)) return { ok:false, reason:'shard_assignment_mismatch' };
      const result = this.upsertDocument({ ...d, text:d.body, visibility:'public' }, { verified:true });
      if (!result.ok) return { ok:false, reason:result.reason, imported:0 };
    }
    return { ok:true, imported:docs.length, shard_id:Number(snapshot.shard_id), digest };
  }

  /** Paged, ordered read for snapshot transfer. phase = 'docs' | 'tombs'; cursor = "origin\tcontent_id". Bounded (<=500 rows). */
  pageShard(shardId, { phase = 'docs', after = '', limit = 200 } = {}) {
    if (!this.db) return { items: [], done: true, next: null };
    const id = Number(shardId); limit = Math.max(1, Math.min(500, Number(limit) || 200));
    const hasCursor = String(after).includes('\t');
    const [ao, ai] = String(after).split('\t');
    const where = `shard_id=? ${hasCursor ? 'AND (origin_peer>? OR (origin_peer=? AND content_id>?))' : ''} ORDER BY origin_peer,content_id LIMIT ?`;
    const args = hasCursor ? [id, ao, ao, ai, limit + 1] : [id, limit + 1];
    const rows = phase === 'tombs'
      ? this.db.all(`SELECT origin_peer,content_id,version,sig FROM p2p_index_tombstones WHERE ${where}`, ...args)
      : this.db.all(`SELECT origin_peer,content_id,title,body,language,region,topics,content_hash,updated_at,origin_sig FROM p2p_index_documents WHERE ${where}`, ...args)
          .map((r) => ({ ...r, topics: safeJson(r.topics) }));
    const done = rows.length <= limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, done, next: done || !last ? null : last.origin_peer + '\t' + last.content_id };
  }

  /** Content digest + tombstone digest of one shard (cheap anti-entropy comparison). */
  shardDigests(shardId) {
    if (!this.db) return { digest: '', tomb_digest: '', count: 0 };
    const id = Number(shardId);
    const rows = this.db.all('SELECT origin_peer,content_id,content_hash,updated_at FROM p2p_index_documents WHERE shard_id=? ORDER BY origin_peer,content_id', id);
    const tombs = this.db.all('SELECT origin_peer,content_id,version FROM p2p_index_tombstones WHERE shard_id=? ORDER BY origin_peer,content_id', id);
    return { digest: sha256(rows.map(r => `${r.origin_peer}:${r.content_id}:${r.content_hash}:${r.updated_at}`).join('\n')),
      tomb_digest: sha256(tombs.map(r => `${r.origin_peer}:${r.content_id}:${r.version}`).join('\n')), count: rows.length, tombstones: tombs.length };
  }

  /** Capacity snapshot used by the resource governor. */
  capacity() {
    if (!this.db) return { documents: this._memory.size, bytes: 0, maxDocuments: this.maxDocuments, maxBytes: this.maxBytes, ratio: 0 };
    const documents = Number(this.db.get('SELECT COUNT(*) c FROM p2p_index_documents')?.c || 0);
    const bytes = Number(this.db.get('SELECT COALESCE(SUM(byte_size),0) n FROM p2p_index_documents')?.n || 0);
    return { documents, bytes, maxDocuments: this.maxDocuments, maxBytes: this.maxBytes, ratio: Math.max(documents / this.maxDocuments, bytes / this.maxBytes) };
  }

  /** Drop tombstones older than ttl (they only need to outlive the longest plausible stale replica). */
  pruneTombstones(ttlMs = 30 * 86400000) {
    if (!this.db) return 0;
    return Number(this.db.run('DELETE FROM p2p_index_tombstones WHERE created_at < ?', Date.now() - ttlMs).changes || 0);
  }

  stats() {
    if (this.db) this.flushShards();
    if (!this.db) return { phase:5, documents:this._memory.size, shards:this.shardCount, bytes:[...this._memory.values()].reduce((n,d)=>n+d.byte_size,0), assignments:0, mode:'memory' };
    return { phase:5, documents:Number(this.db.get('SELECT COUNT(*) c FROM p2p_index_documents')?.c||0), terms:Number(this.db.get('SELECT COUNT(*) c FROM p2p_index_terms')?.c||0), shards:Number(this.db.get('SELECT COUNT(*) c FROM p2p_index_shards')?.c||0), bytes:Number(this.db.get('SELECT COALESCE(SUM(byte_size),0) n FROM p2p_index_documents')?.n||0), assignments:Number(this.db.get('SELECT COUNT(*) c FROM p2p_index_assignments WHERE expires_at>?',Date.now())?.c||0), mode:'sqlite' };
  }
}
function safeJson(v) { try { const x=JSON.parse(v||'[]'); return Array.isArray(x)?x:[]; } catch { return []; } }
function rendezvousScore(shard, peerId) { return parseInt(sha256(`${shard}:${peerId}`).slice(0,12),16) / 0xffffffffffff; }

module.exports = { DistributedIndex, shardFor, tokenize, normalizeText, rendezvousScore, DEFAULT_SHARDS };
