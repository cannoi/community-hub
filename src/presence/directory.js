'use strict';
// Seed-side directory. Stores signed presence records only — never content, media, feeds or request IPs.
// Bounded: at most `maxEntries` rows; stale rows are pruned; each record ≤ 2 KiB.
const { validateRecord, validateSimple, PresenceError, HB_DOMAIN, WD_DOMAIN } = require('./record');

const likeEsc = (s) => '%' + String(s).replace(/[\\%_]/g, (c) => '\\' + c) + '%';

class Directory {
  /** @param {{get,run,all,exec}} db  @param {{maxEntries,onlineMs,retainMs,allowPrivate}} opts */
  constructor(db, opts = {}) {
    this.db = db;
    this.o = { maxEntries: 20000, onlineMs: 900000, retainMs: 7 * 86400000, allowPrivate: false, ...opts };
    db.exec(`CREATE TABLE IF NOT EXISTS presence_directory (
      account_id TEXT PRIMARY KEY, pub TEXT NOT NULL, name_lc TEXT NOT NULL, searchable INTEGER NOT NULL,
      rec_ts INTEGER NOT NULL, hb_ts INTEGER NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, rec TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_pd_last ON presence_directory(last_seen);
      CREATE INDEX IF NOT EXISTS ix_pd_name ON presence_directory(searchable, name_lc);`);
  }
  count() { return this.db.get('SELECT COUNT(*) c FROM presence_directory').c; }
  has(account) { return !!this.db.get('SELECT 1 x FROM presence_directory WHERE account_id=?', account); }

  register(rec, now = Date.now()) {
    validateRecord(rec, { now, allowPrivate: this.o.allowPrivate });
    const json = JSON.stringify(rec);
    if (Buffer.byteLength(json) > 2048) throw new PresenceError('E_PRESENCE_INVALID', 400, 'record too large');
    const cur = this.db.get('SELECT rec_ts, first_seen, pub FROM presence_directory WHERE account_id=?', rec.account_id);
    if (cur) {
      if (cur.pub !== rec.pub) throw new PresenceError('E_PRESENCE_SIG', 401, 'key mismatch');
      if (rec.ts <= cur.rec_ts) throw new PresenceError('E_PRESENCE_REPLAY', 409, 'stale or replayed record');
      this.db.run('UPDATE presence_directory SET name_lc=?, searchable=?, rec_ts=?, hb_ts=?, last_seen=?, rec=? WHERE account_id=?',
        rec.name.toLowerCase(), rec.searchable ? 1 : 0, rec.ts, rec.ts, now, json, rec.account_id);
    } else {
      this._makeRoom(now);
      this.db.run('INSERT INTO presence_directory(account_id,pub,name_lc,searchable,rec_ts,hb_ts,first_seen,last_seen,rec) VALUES(?,?,?,?,?,?,?,?,?)',
        rec.account_id, rec.pub, rec.name.toLowerCase(), rec.searchable ? 1 : 0, rec.ts, rec.ts, now, now, json);
    }
    return { ttl_ms: this.o.onlineMs, heartbeat_ms: Math.floor(this.o.onlineMs / 3) };
  }

  heartbeat(msg, now = Date.now()) {
    const row = this.db.get('SELECT pub, hb_ts FROM presence_directory WHERE account_id=?', msg && msg.account_id);
    if (!row) throw new PresenceError('E_PRESENCE_UNKNOWN', 404, 'not registered');
    validateSimple(msg, row.pub, HB_DOMAIN, { now });
    if (msg.ts <= row.hb_ts) throw new PresenceError('E_PRESENCE_REPLAY', 409, 'stale or replayed heartbeat');
    this.db.run('UPDATE presence_directory SET hb_ts=?, last_seen=? WHERE account_id=?', msg.ts, now, msg.account_id);
    return { ttl_ms: this.o.onlineMs };
  }

  withdraw(msg, now = Date.now()) {
    const row = this.db.get('SELECT pub, hb_ts FROM presence_directory WHERE account_id=?', msg && msg.account_id);
    if (!row) return { removed: false };
    validateSimple(msg, row.pub, WD_DOMAIN, { now });
    if (msg.ts <= row.hb_ts) throw new PresenceError('E_PRESENCE_REPLAY', 409, 'stale or replayed message');
    this.db.run('DELETE FROM presence_directory WHERE account_id=?', msg.account_id);
    return { removed: true };
  }

  /** Signed record exactly as registered (clients verify it themselves; a seed cannot forge or alter it). */
  resolve(account, now = Date.now()) {
    const r = this.db.get('SELECT rec, last_seen FROM presence_directory WHERE account_id=?', account);
    if (!r) return null;
    return { record: JSON.parse(r.rec), online: now - r.last_seen <= this.o.onlineMs, last_seen: r.last_seen };
  }

  /** Minimal listing: name + id + coarse status. Only records that opted in (searchable). */
  search(q, limit = 20, now = Date.now()) {
    const s = String(q || '').trim().toLowerCase().slice(0, 40);
    if (s.length < 2) return [];
    const rows = this.db.all(`SELECT rec, last_seen FROM presence_directory WHERE searchable=1 AND name_lc LIKE ? ESCAPE '\\'
      ORDER BY (? - last_seen <= ?) DESC, (name_lc = ?) DESC, last_seen DESC LIMIT ?`, likeEsc(s), now, this.o.onlineMs, s, Math.min(20, Math.max(1, limit)));
    return rows.map((r) => { const rec = JSON.parse(r.rec); return { account_id: rec.account_id, name: rec.name, region: rec.region || null, online: now - r.last_seen <= this.o.onlineMs, last_seen: r.last_seen, reachable: !!rec.endpoint }; });
  }

  prune(now = Date.now()) {
    return this.db.run('DELETE FROM presence_directory WHERE last_seen < ?', now - this.o.retainMs).changes;
  }
  _makeRoom(now) {
    if (this.count() < this.o.maxEntries) return;
    this.prune(now);
    const over = this.count() - this.o.maxEntries + 1;
    if (over > 0) this.db.run('DELETE FROM presence_directory WHERE account_id IN (SELECT account_id FROM presence_directory ORDER BY last_seen ASC LIMIT ?)', Math.max(over, Math.ceil(this.o.maxEntries * 0.01)));
  }
}
module.exports = { Directory };
