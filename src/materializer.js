'use strict';
// Derives mutable local indexes (posts, reactions, follows, profiles, notifications) from immutable events.
// Rules are deterministic and depend only on event content + per-actor order, so any hub that holds the
// same set of events converges to the same views. Only the author of a post may edit/delete it
// (checked here, not at ingest, so an invalid edit by someone else is stored but has no effect).
const { fromB64u } = require('./util');

const TAG_RE = /#([\p{L}\p{N}_]{1,50})/gu;
const extractTags = (text) => [...new Set([...String(text || '').matchAll(TAG_RE)].map((m) => m[1].toLowerCase()))].slice(0, 20);

class Materializer {
  constructor(db, emitter) { this.db = db; this.emit = emitter; }

  reset() {
    const d = this.db;
    d.run("UPDATE posts SET deleted_at=-1 WHERE event_id IS NOT NULL"); // stale marker; replay revives, leftovers are removed
    d.run('DELETE FROM reactions WHERE event_id IS NOT NULL');
    d.run('DELETE FROM follows');
    d.run('DELETE FROM endpoint_announces');
    d.run("UPDATE users SET display_name=NULL, bio=NULL, avatar_media=NULL WHERE status='remote'");
  }
  finishReplay() {
    const d = this.db;
    const stale = d.all('SELECT id FROM posts WHERE event_id IS NOT NULL AND deleted_at=-1');
    for (const s of stale) { d.run('DELETE FROM post_tags WHERE post_id=?', s.id); d.run('DELETE FROM post_media WHERE post_id=?', s.id); d.run('DELETE FROM posts WHERE id=?', s.id); }
  }

  ensureUser(actorId, pub) {
    let u = this.db.get('SELECT id, status FROM users WHERE account_id=?', actorId);
    if (u) return u;
    const base = 'r_' + actorId.slice(5, 15);
    let name = base;
    for (let i = 2; this.db.get('SELECT 1 x FROM users WHERE username=?', name); i++) name = `${base}_${i}`;
    const r = this.db.run("INSERT INTO users(username, avatar, account_id, pubkey, status) VALUES(?,?,?,?, 'remote')", name, '', actorId, pub);
    return { id: Number(r.lastInsertRowid), status: 'remote' };
  }
  userOfAccount(acct) { return this.db.get('SELECT id, status FROM users WHERE account_id=?', acct); }

  notify(recipientAccountOrUserId, type, actorUserId, postId, eventId, ts, byUserId = false) {
    const rcpt = byUserId ? this.db.get("SELECT id FROM users WHERE id=? AND status='local'", recipientAccountOrUserId)
      : this.db.get("SELECT id FROM users WHERE account_id=? AND status='local'", recipientAccountOrUserId);
    if (!rcpt || rcpt.id === actorUserId) return;
    const actorAcct = this.db.get('SELECT account_id FROM users WHERE id=?', actorUserId)?.account_id;
    if (actorAcct && this.db.get('SELECT 1 x FROM blocks WHERE user_id=? AND account_id=?', rcpt.id, actorAcct)) return;
    this.db.run('INSERT OR IGNORE INTO notifications(user_id,type,actor_user_id,post_id,event_id,created_at) VALUES(?,?,?,?,?,?)', rcpt.id, type, actorUserId, postId || null, eventId, ts);
  }

  apply(ev, ctx = {}) {
    const u = this.ensureUser(ev.actor_id, ev.actor_pub);
    const ts = Math.min(ev.created_at, ctx.received_at || ev.created_at);
    const fn = this['on_' + ev.event_type.replace('.', '_')];
    if (fn) fn.call(this, ev, u, ts, ctx);
  }

  on_profile_update(ev, u) {
    const p = ev.payload;
    if (p.display_name !== undefined) this.db.run('UPDATE users SET display_name=? WHERE id=?', p.display_name, u.id);
    if (p.bio !== undefined) this.db.run('UPDATE users SET bio=? WHERE id=?', p.bio, u.id);
    if (p.avatar !== undefined) this.db.run('UPDATE users SET avatar_media=? WHERE id=?', p.avatar, u.id);
  }

  _setPostSideTables(postId, content, media) {
    this.db.run('DELETE FROM post_tags WHERE post_id=?', postId);
    this.db.run('DELETE FROM post_media WHERE post_id=?', postId);
    for (const t of extractTags(content)) this.db.run('INSERT OR IGNORE INTO post_tags(post_id,tag) VALUES(?,?)', postId, t);
    for (const m of media || []) this.db.run('INSERT OR IGNORE INTO post_media(post_id,hash) VALUES(?,?)', postId, m.hash);
  }

  on_post_create(ev, u, ts, ctx) {
    const p = ev.payload; const media = p.media || [];
    const fileUrl = media.length ? `/media/${media[0].hash}` : null;
    const iso = new Date(ev.created_at).toISOString();
    const row = this.db.get('SELECT id FROM posts WHERE event_id=?', ev.event_id);
    let postId;
    if (row) {
      this.db.run('UPDATE posts SET user_id=?, content=?, file_url=?, kind=?, visibility=?, parent_event=?, ref_event=?, media=?, sort_ts=?, edited_at=NULL, deleted_at=NULL, created_at=? WHERE id=?',
        u.id, p.content, fileUrl, p.kind, 'public', ev.parent || null, ev.target || null, JSON.stringify(media), ts, iso, row.id);
      postId = row.id;
    } else {
      const r = this.db.run("INSERT INTO posts(group_id,user_id,content,file_url,created_at,event_id,kind,visibility,parent_event,ref_event,media,sort_ts,origin) VALUES(NULL,?,?,?,?,?,?,'public',?,?,?,?,?)",
        u.id, p.content, fileUrl, iso, ev.event_id, p.kind, ev.parent || null, ev.target || null, JSON.stringify(media), ts, ctx.source === 'local' ? 'local' : 'remote');
      postId = Number(r.lastInsertRowid);
    }
    this._setPostSideTables(postId, p.content, media);
    if (ctx.replay) return;
    const refEvent = ev.parent || ev.target;
    if (refEvent) {
      const target = this.db.get('SELECT p.id, u.account_id FROM posts p JOIN users u ON u.id=p.user_id WHERE p.event_id=?', refEvent);
      if (target?.account_id) this.notify(target.account_id, p.kind === 'reply' ? 'reply' : p.kind, u.id, postId, ev.event_id, ts);
    }
    this.emit?.emit('view', { kind: 'post', id: postId });
  }

  _ownPost(ev) {
    return this.db.get('SELECT p.id, p.deleted_at FROM posts p JOIN users u ON u.id=p.user_id WHERE p.event_id=? AND u.account_id=?', ev.target, ev.actor_id);
  }
  on_post_edit(ev, u, ts) {
    const post = this._ownPost(ev);
    if (!post || (post.deleted_at && post.deleted_at !== -1)) return; // not the author / already tombstoned: no effect
    const media = ev.payload.media || [];
    this.db.run('UPDATE posts SET content=?, media=?, file_url=?, edited_at=? WHERE id=?', ev.payload.content, JSON.stringify(media), media.length ? `/media/${media[0].hash}` : null, ev.created_at, post.id);
    this._setPostSideTables(post.id, ev.payload.content, media);
  }
  on_post_delete(ev) {
    const post = this._ownPost(ev);
    if (!post) return;
    this.db.run("UPDATE posts SET deleted_at=?, content='', media=NULL, file_url=NULL WHERE id=?", ev.created_at, post.id);
    this._setPostSideTables(post.id, '', []);
  }

  on_react_add(ev, u, ts, ctx) {
    this.db.run("INSERT INTO reactions(post_id,user_id,type,target_event,event_id) VALUES(NULL,?,?,?,?) ON CONFLICT(target_event,user_id) WHERE target_event IS NOT NULL DO UPDATE SET type=excluded.type, event_id=excluded.event_id",
      u.id, ev.payload.kind, ev.target, ev.event_id);
    if (ctx.replay) return;
    const t = this.db.get('SELECT p.id, us.account_id FROM posts p JOIN users us ON us.id=p.user_id WHERE p.event_id=?', ev.target);
    if (t?.account_id) this.notify(t.account_id, 'like', u.id, t.id, ev.event_id, ts);
  }
  on_react_remove(ev, u) { this.db.run('DELETE FROM reactions WHERE target_event=? AND user_id=?', ev.target, u.id); }

  on_follow_add(ev, u, ts, ctx) {
    this.db.run('INSERT INTO follows(follower,followee,event_id,created_at) VALUES(?,?,?,?) ON CONFLICT(follower,followee) DO UPDATE SET event_id=excluded.event_id', ev.actor_id, ev.payload.account, ev.event_id, ev.created_at);
    if (!ctx.replay) this.notify(ev.payload.account, 'follow', u.id, null, ev.event_id, ts);
  }
  on_follow_remove(ev) { this.db.run('DELETE FROM follows WHERE follower=? AND followee=?', ev.actor_id, ev.payload.account); }

  on_endpoint_announce(ev) {
    const cur = this.db.get('SELECT sequence FROM endpoint_announces WHERE actor_id=?', ev.actor_id);
    if (cur && cur.sequence > ev.sequence) return;
    this.db.run('INSERT INTO endpoint_announces(actor_id,endpoints,event_id,sequence) VALUES(?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET endpoints=excluded.endpoints,event_id=excluded.event_id,sequence=excluded.sequence',
      ev.actor_id, JSON.stringify(ev.payload.endpoints), ev.event_id, ev.sequence);
  }
}
module.exports = { Materializer, extractTags };
