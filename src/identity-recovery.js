'use strict';
// Owner-confirmed key rotation for an account whose private key is NOT on this Hub (for example a restored backup that was
// taken without the key). An account id is the hash of its public key, so the old id can never sign again. Rotation:
//   1. generates a fresh key (new account id) and re-points the local user row to it,
//   2. records old id -> new id in meta.actor_aliases, so the old, validly signed events stay in the ledger untouched and the
//      old posts keep belonging to the owner locally (also after a reindex),
//   3. re-signs the profile and the owner's follow list under the new key and re-announces the endpoint.
// Followers of the old id on other Hubs keep following the old id; they must follow the new one. It is never automatic.
const { HttpError } = require('./util');

const FOLLOW_LIMIT = 1000;

function keyPresent(hub, user) { return !!(user && user.account_id && hub.ks.has(user.account_id)); }

function rekeyOwnerAccount(hub, user) {
  const { db, ks, ledger, mat, peers, log } = hub;
  const row = db.get("SELECT id, username, account_id, display_name, bio, avatar_media FROM users WHERE id=? AND status='local'", user.id);
  if (!row) throw new HttpError(404, 'E_NOT_FOUND', 'Account not found');
  if (ks.has(row.account_id)) throw new HttpError(409, 'E_KEY_PRESENT', 'This account already has its signing key');
  const oldId = row.account_id;
  const follows = db.all('SELECT followee FROM follows WHERE follower=? ORDER BY created_at LIMIT ' + FOLLOW_LIMIT, oldId).map((r) => r.followee);

  const key = ks.generate();
  db.tx(() => {
    db.run('UPDATE users SET account_id=?, pubkey=? WHERE id=?', key.accountId, key.pub, row.id);
    let map = {};
    try { const r = db.get("SELECT value FROM meta WHERE key='actor_aliases'"); if (r && r.value) map = JSON.parse(r.value) || {}; } catch { map = {}; }
    for (const k of Object.keys(map)) if (map[k] === oldId) map[k] = key.accountId; // earlier rotations follow the newest id
    map[oldId] = key.accountId;
    db.run("INSERT OR REPLACE INTO meta(key,value) VALUES('actor_aliases',?)", JSON.stringify(map));
  });
  mat.resetAliases();

  const out = { ok: true, account_id: key.accountId, old_account_id: oldId, profile: false, follows: 0 };
  try {
    const p = { display_name: (row.display_name || row.username).slice(0, 50) };
    if (row.bio) p.bio = String(row.bio).slice(0, 300);
    if (row.avatar_media) p.avatar = row.avatar_media;
    try { ledger.publish(key.accountId, 'profile.update', p); out.profile = true; }
    catch (e) { ledger.publish(key.accountId, 'profile.update', { display_name: p.display_name }); out.profile = true; }
  } catch (e) { log && log.warn && log.warn('rekey: profile event failed: ' + (e.code || e.message)); }
  for (const f of follows) {
    try { ledger.publish(key.accountId, 'follow.add', { account: f }); out.follows++; } catch { /* skip an invalid followee */ }
  }
  try { peers.announceEndpoint(); } catch { /* best effort */ }
  try { hub.bus.emit('local-publish'); } catch { /* best effort */ }
  log && log.info && log.info(`identity rotated: ${oldId} -> ${key.accountId}`);
  return out;
}

module.exports = { rekeyOwnerAccount, keyPresent };
