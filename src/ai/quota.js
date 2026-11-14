'use strict';
/**
 * Per-user daily AI chat quota (in-memory + optional meta persistence day key).
 * Default 40 external/model calls per user per UTC day; offline localReply does not count.
 */
const DEFAULT_DAILY = 40;

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function createQuota({ daily = DEFAULT_DAILY, db } = {}) {
  const mem = new Map(); // key userId:day -> count

  function load(userId) {
    const k = userId + ':' + dayKey();
    if (mem.has(k)) return mem.get(k);
    let n = 0;
    if (db) {
      try {
        const row = db.get("SELECT value FROM meta WHERE key=?", 'ai_quota_' + k);
        if (row) n = Number(row.value) || 0;
      } catch { /* ok */ }
    }
    mem.set(k, n);
    return n;
  }

  function save(userId, n) {
    const k = userId + ':' + dayKey();
    mem.set(k, n);
    if (db) {
      try {
        db.run("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", 'ai_quota_' + k, String(n));
      } catch { /* ok */ }
    }
  }

  return {
    daily,
    check(userId) {
      const used = load(userId);
      return { allowed: used < daily, used, remaining: Math.max(0, daily - used), daily };
    },
    consume(userId) {
      const used = load(userId) + 1;
      save(userId, used);
      return { used, remaining: Math.max(0, daily - used), daily };
    },
  };
}

module.exports = { createQuota, DEFAULT_DAILY };
