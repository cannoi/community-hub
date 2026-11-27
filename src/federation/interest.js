'use strict';
// Interest-scoped content sync (2.3.16).
//
// With bulk content sync enabled ("trusted" peers), the old behaviour copied EVERY event a peer holds into the local ledger, so each
// Hub's database grew with the size of the whole network. Events are hash-chained per actor, so a Hub cannot keep a random sample
// of an actor's events: it either holds that actor's chain or none of it. The policy is therefore per ACTOR:
//
//   keep   -> the ledger: my own accounts, accounts my users follow, my trusted sync peers' own accounts, actors the ledger already
//             holds (their chain continues), and a small daily budget of NEW actors that reply to / react to / quote MY posts.
//   cache  -> remote_cache: public posts and profiles of everyone else are VERIFIED and kept in the bounded, expiring discovery cache
//             (HUB_REMOTE_VIEW_MAX_EVENTS events, newest 80 per actor, TTL) so they can be discovered and opened without ever
//             entering the ledger or growing it.
//   drop   -> everything else (reactions, follows, announcements of strangers).
//
// HUB_SYNC_SCOPE=all restores the old "replicate everything" behaviour.
const TTL_MS = 20000;

class InterestFilter {
  constructor({ db, cfg, clock = Date.now }) {
    Object.assign(this, { db, cfg, clock });
    this._set = null; this._at = 0; this._local = null;
    this.counters = { kept: 0, cached: 0, dropped: 0, admitted: 0, over_budget: 0 };
  }

  scope() { return this.cfg.syncScope === 'all' ? 'all' : 'interest'; }
  invalidate() { this._set = null; this._at = 0; }

  _localAccounts() {
    const out = new Set();
    for (const r of this.db.all("SELECT account_id FROM users WHERE status='local' AND account_id IS NOT NULL")) out.add(r.account_id);
    try { // retired identities of a key rotation are still "mine"
      const m = this.db.get("SELECT value FROM meta WHERE key='actor_aliases'");
      if (m && m.value) for (const k of Object.keys(JSON.parse(m.value) || {})) out.add(k);
    } catch { /* no aliases */ }
    return out;
  }

  /** Actors whose events belong in the ledger. Cached for a few seconds. */
  actors() {
    const now = this.clock();
    if (this._set && now - this._at < TTL_MS) return this._set;
    const set = new Set(); const local = this._localAccounts();
    for (const a of local) set.add(a);
    const ph = [...local].map(() => '?').join(',');
    if (local.size) for (const r of this.db.all(`SELECT DISTINCT followee FROM follows WHERE follower IN (${ph})`, ...local)) set.add(r.followee);
    try { for (const r of this.db.all("SELECT account_id FROM peers WHERE sync_content=1 AND account_id IS NOT NULL AND state!='blocked'")) set.add(r.account_id); } catch { /* no peers table yet */ }
    for (const r of this.db.all('SELECT actor_id FROM actor_state')) set.add(r.actor_id); // chains we already hold continue
    this._set = set; this._at = now; this._local = local;
    return set;
  }

  _isMine(eventId) {
    if (!eventId) return false;
    this.actors(); const local = [...(this._local || [])]; if (!local.length) return false;
    return !!this.db.get(`SELECT 1 x FROM events WHERE event_id=? AND actor_id IN (${local.map(() => '?').join(',')})`, eventId, ...local);
  }

  _budgetLeft() {
    const cap = Number.isFinite(Number(this.cfg.syncNewActorsPerDay)) ? Number(this.cfg.syncNewActorsPerDay) : 50;
    const day = new Date(this.clock()).toISOString().slice(0, 10); const key = 'sync_new_actors_' + day;
    const used = Number((this.db.get('SELECT value FROM meta WHERE key=?', key) || {}).value || 0);
    return { cap, used, key, left: Math.max(0, cap - used) };
  }
  _spend(key, used) {
    this.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', key, String(used));
    this.db.run("DELETE FROM meta WHERE key LIKE 'sync_new_actors_%' AND key<>?", key); // one day of counters only
  }

  /** Split one batch of envelopes into {keep, cache, dropped}. */
  partition(events) {
    const list = Array.isArray(events) ? events : [];
    if (this.scope() === 'all') { this.counters.kept += list.length; return { keep: list, cache: [], dropped: 0 }; }
    const wanted = this.actors(); const keep = []; const cache = []; let dropped = 0;
    const budget = this._budgetLeft(); let used = budget.used; const admitted = new Set();
    for (const ev of list) {
      if (!ev || typeof ev.actor_id !== 'string') { dropped++; continue; }
      if (wanted.has(ev.actor_id) || admitted.has(ev.actor_id)) { keep.push(ev); continue; }
      // a stranger engaging with MY content: admit the actor (its chain is back-filled) while the daily budget lasts
      if ((this._isMine(ev.parent) || this._isMine(ev.target))) {
        if (used < budget.cap) { used++; admitted.add(ev.actor_id); keep.push(ev); this.counters.admitted++; continue; }
        this.counters.over_budget++;
      }
      if (ev.event_type === 'profile.update' || ev.event_type === 'post.create' || ev.event_type === 'post.edit' || ev.event_type === 'post.delete') cache.push(ev);
      else dropped++;
    }
    if (used !== budget.used) { this._spend(budget.key, used); this.invalidate(); }
    this.counters.kept += keep.length; this.counters.cached += cache.length; this.counters.dropped += dropped;
    return { keep, cache, dropped };
  }

  status() { return { scope: this.scope(), new_actors_per_day: Number(this.cfg.syncNewActorsPerDay) || 0, ...this.counters }; }
}

module.exports = { InterestFilter };
