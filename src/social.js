'use strict';
// Social domain services: visibility rules, serializers, posts, feeds, follows, reactions, search, notifications.
const { HttpError } = require('./util');
const { isAccountId } = require('./keystore');

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function dec(c) {
  if (!c) return null;
  try { const o = JSON.parse(Buffer.from(String(c).slice(0, 200), 'base64url').toString('utf8')); return Number.isSafeInteger(o.t) && Number.isSafeInteger(o.i) ? o : null; } catch { return null; }
}
const toIso = (v) => {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v).toISOString();
  return /T.*Z$/.test(v) ? v : String(v).replace(' ', 'T') + 'Z';
};
const likeEsc = (s) => '%' + String(s).replace(/[\\%_]/g, (c) => '\\' + c) + '%';

const COUNTS = `
  ((SELECT COUNT(*) FROM reactions r WHERE r.post_id=p.id) + CASE WHEN p.event_id IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM reactions r WHERE r.target_event=p.event_id) END) AS like_count,
  ((SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) + CASE WHEN p.event_id IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM posts x WHERE x.parent_event=p.event_id AND x.deleted_at IS NULL) END) AS reply_count,
  CASE WHEN p.event_id IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM posts x WHERE x.ref_event=p.event_id AND x.kind='repost' AND x.deleted_at IS NULL) END AS repost_count,
  CASE WHEN p.event_id IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM posts x WHERE x.ref_event=p.event_id AND x.kind='quote' AND x.deleted_at IS NULL) END AS quote_count`;
const POST_SELECT = `SELECT p.*, u.username, u.display_name, u.account_id AS author_account, u.avatar AS author_legacy_avatar, u.avatar_media AS author_avatar_media, u.status AS author_status, ${COUNTS}`;
const POST_FROM = ' FROM posts p JOIN users u ON u.id=p.user_id';

class Social {
  constructor({ db, ledger, ks, media, cfg, bus }) { this.db = db; this.ledger = ledger; this.ks = ks; this.media = media; this.cfg = cfg; this.bus = bus; }

  // ---------- visibility ----------
  /** SQL predicate (alias p/u) for posts the viewer may see. Restricted content is never matched for anonymous callers. */
  visible(viewer) {
    if (!viewer) return { sql: "(p.visibility='public')", params: [] };
    return {
      sql: `(p.visibility='public' OR p.user_id=? OR (p.visibility='followers' AND EXISTS(SELECT 1 FROM follows f WHERE f.follower=? AND f.followee=u.account_id))
        OR (p.visibility='group' AND (EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=p.group_id AND gm.user_id=?) OR EXISTS(SELECT 1 FROM groups g WHERE g.id=p.group_id AND COALESCE(g.visibility,'open')='open'))))
        AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.user_id=? AND b.account_id=u.account_id)`,
      params: [viewer.id, viewer.account_id || '', viewer.id, viewer.id],
    };
  }
  hideMuted(viewer) {
    if (!viewer) return { sql: '1=1', params: [] };
    return { sql: 'NOT EXISTS(SELECT 1 FROM mutes m WHERE m.user_id=? AND m.account_id=u.account_id)', params: [viewer.id] };
  }
  canViewPost(viewer, postId) {
    const v = this.visible(viewer);
    return !!this.db.get(`SELECT 1 x ${POST_FROM} WHERE p.id=? AND ${v.sql}`, postId, ...v.params);
  }
  canViewMedia(viewer, hash) {
    if (this.media.isPublic(hash)) return true;
    if (!viewer) return false;
    if (this.media.isRemoteRef(hash)) return true; // streamed on demand for signed-in users only (no open proxy for anonymous visitors)
    if (this.db.get('SELECT 1 x FROM media_owners WHERE hash=? AND user_id=?', hash, viewer.id)) return true;
    const v = this.visible(viewer);
    return !!this.db.get(`SELECT 1 x FROM post_media pm JOIN posts p ON p.id=pm.post_id JOIN users u ON u.id=p.user_id WHERE pm.hash=? AND p.deleted_at IS NULL AND ${v.sql} LIMIT 1`, hash, ...v.params);
  }

  // ---------- serializers ----------
  userOut(r) {
    if (!r) return null;
    return {
      id: r.id, account_id: r.account_id || null, username: r.username, display_name: r.display_name || null,
      bio: r.bio || null, status: r.status, avatar_url: r.avatar_media ? `/media/${r.avatar_media}` : null,
      avatar: r.avatar || '', created_at: toIso(r.created_at),
    };
  }
  postOut(r, viewer, depth = 0) {
    const media = r.media ? JSON.parse(r.media).map((m) => ({ ...m, kind: this.media.meta(m.hash)?.kind || (m.mime || '').split('/')[0], url: `/media/${m.hash}`, available: this.media.exists(m.hash) })) : [];
    const out = {
      id: r.id, event_id: r.event_id || null, group_id: r.group_id, user_id: r.user_id, content: r.content, file_url: r.file_url,
      created_at: toIso(r.created_at), sort_ts: r.sort_ts, edited_at: r.edited_at ? toIso(r.edited_at) : null,
      deleted: !!(r.deleted_at && r.deleted_at > 0), visibility: r.visibility, kind: r.kind, origin: r.origin,
      username: r.username, avatar: r.author_legacy_avatar || '',
      author: { id: r.user_id, account_id: r.author_account || null, username: r.username, display_name: r.display_name || null, status: r.author_status, avatar_url: r.author_avatar_media ? `/media/${r.author_avatar_media}` : null },
      media, reaction_count: r.like_count, comment_count: r.reply_count,
      counts: { likes: r.like_count, replies: r.reply_count, reposts: r.repost_count, quotes: r.quote_count },
      parent_event: r.parent_event || null,
    };
    if (viewer) {
      out.viewer = {
        liked: !!this.db.get('SELECT 1 x FROM reactions WHERE user_id=? AND (post_id=? OR (target_event IS NOT NULL AND target_event=?))', viewer.id, r.id, r.event_id || ''),
        reposted: !!(r.event_id && this.db.get("SELECT 1 x FROM posts WHERE user_id=? AND kind='repost' AND ref_event=? AND deleted_at IS NULL", viewer.id, r.event_id)),
        bookmarked: !!this.db.get('SELECT 1 x FROM bookmarks WHERE user_id=? AND post_id=?', viewer.id, r.id),
      };
    }
    if (r.ref_event && depth === 0) {
      const v = this.visible(viewer);
      const ref = this.db.get(`${POST_SELECT}${POST_FROM} WHERE p.event_id=? AND ${v.sql}`, r.ref_event, ...v.params);
      out.ref = ref && !(ref.deleted_at > 0) ? this.postOut(ref, viewer, 1) : { missing: true, event_id: r.ref_event, deleted: !!(ref && ref.deleted_at > 0) };
    }
    return out;
  }

  // ---------- feeds ----------
  page(where, params, { cursor, limit = 20, viewer, order = 'DESC', max = 50 }) {
    limit = Math.min(max, Math.max(1, Number(limit) || 20));
    const c = dec(cursor);
    let sql = `${POST_SELECT}${POST_FROM} WHERE ${where}`; const p = [...params];
    if (c) { sql += order === 'DESC' ? ' AND (p.sort_ts < ? OR (p.sort_ts = ? AND p.id < ?))' : ' AND (p.sort_ts > ? OR (p.sort_ts = ? AND p.id > ?))'; p.push(c.t, c.t, c.i); }
    sql += ` ORDER BY p.sort_ts ${order}, p.id ${order} LIMIT ?`; p.push(limit + 1);
    const rows = this.db.all(sql, ...p);
    const more = rows.length > limit; if (more) rows.pop();
    const last = rows[rows.length - 1];
    return { items: rows.map((r) => this.postOut(r, viewer)), next_cursor: more && last ? enc({ t: last.sort_ts, i: last.id }) : null };
  }
  homeFeed(viewer, q) {
    const v = this.visible(viewer); const m = this.hideMuted(viewer);
    return this.page(`p.group_id IS NULL AND p.deleted_at IS NULL AND p.parent_event IS NULL AND (p.user_id=? OR u.account_id IN (SELECT followee FROM follows WHERE follower=?)) AND ${v.sql} AND ${m.sql}`,
      [viewer.id, viewer.account_id, ...v.params, ...m.params], { ...q, viewer });
  }
  publicFeed(viewer, q) {
    const v = this.visible(viewer); const m = this.hideMuted(viewer);
    return this.page(`p.group_id IS NULL AND p.deleted_at IS NULL AND p.parent_event IS NULL AND p.visibility='public' AND ${v.sql} AND ${m.sql}`, [...v.params, ...m.params], { ...q, viewer });
  }
  profileFeed(viewer, userId, q) {
    const v = this.visible(viewer);
    return this.page(`p.user_id=? AND p.group_id IS NULL AND p.deleted_at IS NULL AND (? = 1 OR p.parent_event IS NULL) AND ${v.sql}`, [userId, q.replies ? 1 : 0, ...v.params], { ...q, viewer });
  }
  bookmarks(viewer, q) {
    const v = this.visible(viewer);
    return this.page(`p.deleted_at IS NULL AND p.id IN (SELECT post_id FROM bookmarks WHERE user_id=?) AND ${v.sql}`, [viewer.id, ...v.params], { ...q, viewer });
  }
  getPost(viewer, id) {
    const v = this.visible(viewer);
    const r = this.db.get(`${POST_SELECT}${POST_FROM} WHERE p.id=? AND ${v.sql}`, id, ...v.params);
    if (!r) throw new HttpError(404, 'E_NOT_FOUND', 'Post not found');
    return this.postOut(r, viewer);
  }
  thread(viewer, id, q) {
    const post = this.getPost(viewer, id);
    let replies = { items: [], next_cursor: null };
    if (post.event_id) {
      const v = this.visible(viewer);
      replies = this.page(`p.parent_event=? AND p.deleted_at IS NULL AND ${v.sql}`, [post.event_id, ...v.params], { ...q, viewer, order: 'ASC' });
    }
    const legacy = this.db.all('SELECT c.id,c.content,c.created_at,c.user_id,u.username,u.display_name FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.id ASC LIMIT 200', id)
      .map((c) => ({ id: c.id, content: c.content, created_at: toIso(c.created_at), user_id: c.user_id, username: c.username, display_name: c.display_name, legacy_comment: true }));
    return { post, replies: replies.items, comments: legacy, next_cursor: replies.next_cursor };
  }

  // ---------- writes ----------
  _requireKey(user) {
    if (!user.account_id || !this.ks.has(user.account_id)) throw new HttpError(403, 'E_NO_KEY', 'This account cannot sign events');
    // After importing an existing identity, publishing before the old history is known would fork the chain.
    if (this.db.get("SELECT value FROM meta WHERE key='history_pending'")?.value === '1') {
      if (this.ledger.actorState(user.account_id)) this.db.run("DELETE FROM meta WHERE key='history_pending'");
      else throw new HttpError(409, 'E_HISTORY_NOT_SYNCED', 'Sync your previous history from a peer first (or choose "start fresh")');
    }
  }
  _content(s, allowEmpty = false) {
    if (s !== undefined && typeof s !== 'string') throw new HttpError(400, 'E_INVALID', 'content must be text');
    const c = String(s || '').replace(/\r\n/g, '\n').replace(/\0/g, '').trim();
    if (c.length > this.cfg.maxPostChars) throw new HttpError(400, 'E_TOO_LONG', `Post is limited to ${this.cfg.maxPostChars} characters`);
    if (!c && !allowEmpty) throw new HttpError(400, 'E_EMPTY', 'Content is required');
    return c;
  }
  _byClient(user, cid) { return cid ? this.db.get('SELECT id FROM posts WHERE user_id=? AND client_id=?', user.id, cid) : null; }

  createPost(user, b) {
    const cid = b.client_id ? String(b.client_id).slice(0, 64) : null;
    const dup = this._byClient(user, cid);
    if (dup) return { post: this.getPost(user, dup.id), duplicate: true };
    const hashes = Array.isArray(b.media) ? b.media.slice(0, 4) : [];
    const media = hashes.length ? this.media.assertOwned(hashes.map(String), user.id) : [];
    const kindIn = b.repost_of ? 'repost' : b.quote_of ? 'quote' : b.reply_to ? 'reply' : 'post';
    const content = this._content(b.content, kindIn === 'repost' || media.length > 0);
    const lang = /^[a-z]{2,3}$/.test(b.lang || '') ? b.lang : undefined;
    const vis = b.group_id ? 'group' : (['public', 'followers'].includes(b.visibility) ? b.visibility : 'public');

    if (b.group_id) { // local-only community post (legacy group behaviour)
      const g = this.db.get('SELECT id FROM groups WHERE id=?', Number(b.group_id));
      if (!g) throw new HttpError(404, 'E_NOT_FOUND', 'Group not found');
      if (!this.db.get('SELECT 1 x FROM group_members WHERE group_id=? AND user_id=?', g.id, user.id)) throw new HttpError(403, 'E_NOT_MEMBER', 'Join the group before posting');
      return { post: this._localPost(user, { content, vis: 'group', group_id: g.id, media, cid }) };
    }
    if (kindIn === 'reply') {
      const parent = this.db.get('SELECT id, event_id, visibility, deleted_at FROM posts WHERE id=?', Number(b.reply_to));
      if (!parent || parent.deleted_at || !this.canViewPost(user, parent.id)) throw new HttpError(404, 'E_NOT_FOUND', 'Post not found');
      if (parent.event_id && parent.visibility === 'public' && vis === 'public') return { post: this._eventPost(user, 'reply', { content, media, lang }, { parent: parent.event_id }, cid) };
      const r = this.db.run('INSERT INTO comments(post_id,user_id,content) VALUES(?,?,?)', parent.id, user.id, content);
      return { comment: { id: Number(r.lastInsertRowid), post_id: parent.id, user_id: user.id, content, created_at: new Date().toISOString() } };
    }
    if (kindIn === 'repost' || kindIn === 'quote') {
      const t = this.db.get("SELECT id, event_id, visibility, deleted_at, kind FROM posts WHERE id=?", Number(b.repost_of || b.quote_of));
      if (!t || !t.event_id || t.visibility !== 'public' || t.deleted_at || !this.canViewPost(user, t.id)) throw new HttpError(400, 'E_NOT_SHAREABLE', 'Only public posts can be reposted or quoted');
      if (kindIn === 'repost' && this.db.get("SELECT 1 x FROM posts WHERE user_id=? AND kind='repost' AND ref_event=? AND deleted_at IS NULL", user.id, t.event_id)) throw new HttpError(409, 'E_ALREADY', 'Already reposted');
      return { post: this._eventPost(user, kindIn, { content, media, lang }, { target: t.event_id }, cid) };
    }
    if (vis === 'followers') return { post: this._localPost(user, { content, vis: 'followers', group_id: null, media, cid }) };
    return { post: this._eventPost(user, 'post', { content, media, lang }, {}, cid) };
  }
  _eventPost(user, kind, p, refs, cid) {
    this._requireKey(user);
    const payload = { kind, content: p.content }; if (p.media.length) payload.media = p.media; if (p.lang) payload.lang = p.lang;
    let ev;
    try { ev = this.ledger.publish(user.account_id, 'post.create', payload, refs); } catch (e) { throw new HttpError(400, 'E_' + String(e.code || 'PUBLISH').toUpperCase(), 'Could not publish: ' + (e.code || 'error')); }
    const row = this.db.get('SELECT id FROM posts WHERE event_id=?', ev.event_id);
    if (cid) this.db.run('UPDATE posts SET client_id=? WHERE id=?', cid, row.id);
    this.bus.emit('local-publish');
    return this.getPost(user, row.id);
  }
  _localPost(user, { content, vis, group_id, media, cid }) {
    const now = Date.now();
    const r = this.db.run("INSERT INTO posts(group_id,user_id,content,file_url,created_at,kind,visibility,media,sort_ts,origin,client_id) VALUES(?,?,?,?,?,'post',?,?,?,'local',?)",
      group_id, user.id, content, media.length ? `/media/${media[0].hash}` : null, new Date(now).toISOString(), vis, JSON.stringify(media), now, cid);
    const id = Number(r.lastInsertRowid);
    for (const m of media) this.db.run('INSERT OR IGNORE INTO post_media(post_id,hash) VALUES(?,?)', id, m.hash);
    return this.getPost(user, id);
  }
  editPost(user, id, b) {
    const p = this.db.get('SELECT * FROM posts WHERE id=?', id);
    if (!p || p.deleted_at) throw new HttpError(404, 'E_NOT_FOUND', 'Post not found');
    if (p.user_id !== user.id) throw new HttpError(403, 'E_FORBIDDEN', 'You can only edit your own posts');
    if (p.kind === 'repost') throw new HttpError(400, 'E_INVALID', 'Reposts cannot be edited');
    const media = Array.isArray(b.media) ? this.media.assertOwned(b.media.slice(0, 4).map(String), user.id) : (p.media ? JSON.parse(p.media) : []);
    const content = this._content(b.content, media.length > 0);
    if (p.event_id) {
      this._requireKey(user);
      const payload = { content }; if (media.length) payload.media = media;
      try { this.ledger.publish(user.account_id, 'post.edit', payload, { target: p.event_id }); } catch (e) { throw new HttpError(400, 'E_PUBLISH', 'Could not publish edit'); }
      this.bus.emit('local-publish');
    } else {
      this.db.run('UPDATE posts SET content=?, media=?, file_url=?, edited_at=? WHERE id=?', content, JSON.stringify(media), media.length ? `/media/${media[0].hash}` : null, Date.now(), id);
      this.db.run('DELETE FROM post_media WHERE post_id=?', id);
      for (const m of media) this.db.run('INSERT OR IGNORE INTO post_media(post_id,hash) VALUES(?,?)', id, m.hash);
    }
    return this.getPost(user, id);
  }
  deletePost(user, id) {
    const p = this.db.get('SELECT * FROM posts WHERE id=?', id);
    if (!p || p.deleted_at) throw new HttpError(404, 'E_NOT_FOUND', 'Post not found');
    const groupAdmin = p.group_id && this.db.get("SELECT 1 x FROM group_members WHERE group_id=? AND user_id=? AND role='admin'", p.group_id, user.id);
    if (p.user_id !== user.id && !groupAdmin) throw new HttpError(403, 'E_FORBIDDEN', 'You cannot delete this post');
    if (p.event_id) {
      this._requireKey(user);
      try { this.ledger.publish(user.account_id, 'post.delete', {}, { target: p.event_id }); } catch { throw new HttpError(400, 'E_PUBLISH', 'Could not publish delete'); }
      this.bus.emit('local-publish');
    } else {
      this.db.run("UPDATE posts SET deleted_at=?, content='', media=NULL, file_url=NULL WHERE id=?", Date.now(), id);
      this.db.run('DELETE FROM post_media WHERE post_id=?', id);
    }
    return { deleted: true, note: p.event_id ? 'tombstone_published' : 'local_only' };
  }

  react(user, id, type, on) {
    const p = this.db.get('SELECT id,event_id,visibility FROM posts WHERE id=? AND deleted_at IS NULL', id);
    if (!p || !this.canViewPost(user, id)) throw new HttpError(404, 'E_NOT_FOUND', 'Post not found');
    if (p.event_id && p.visibility === 'public') {
      const cur = this.db.get('SELECT 1 x FROM reactions WHERE target_event=? AND user_id=?', p.event_id, user.id);
      const want = on === undefined ? !cur : !!on;
      if (want && !cur) { this._requireKey(user); this.ledger.publish(user.account_id, 'react.add', { kind: ['like', 'love', 'haha', 'wow', 'sad'].includes(type) ? type : 'like' }, { target: p.event_id }); }
      if (!want && cur) { this._requireKey(user); this.ledger.publish(user.account_id, 'react.remove', {}, { target: p.event_id }); }
      if (want !== !!cur) this.bus.emit('local-publish');
      return { reacted: want };
    }
    const cur = this.db.get('SELECT 1 x FROM reactions WHERE post_id=? AND user_id=?', id, user.id);
    const want = on === undefined ? !cur : !!on;
    if (want && !cur) this.db.run('INSERT INTO reactions(post_id,user_id,type) VALUES(?,?,?)', id, user.id, String(type || 'like').slice(0, 20));
    if (!want && cur) this.db.run('DELETE FROM reactions WHERE post_id=? AND user_id=?', id, user.id);
    return { reacted: want };
  }

  setFollow(user, account, on) {
    if (!isAccountId(account)) throw new HttpError(400, 'E_INVALID', 'Invalid account id');
    if (account === user.account_id) throw new HttpError(400, 'E_INVALID', 'Cannot follow yourself');
    this._requireKey(user);
    const cur = this.db.get('SELECT 1 x FROM follows WHERE follower=? AND followee=?', user.account_id, account);
    if (on && !cur) this.ledger.publish(user.account_id, 'follow.add', { account });
    if (!on && cur) this.ledger.publish(user.account_id, 'follow.remove', { account });
    if (!!cur !== on) this.bus.emit('local-publish');
    return { following: on };
  }
  profile(viewer, handle) {
    const u = isAccountId(handle) ? this.db.get('SELECT * FROM users WHERE account_id=?', handle) : this.db.get('SELECT * FROM users WHERE username=? COLLATE NOCASE', handle);
    if (!u) throw new HttpError(404, 'E_NOT_FOUND', 'Profile not found');
    const a = u.account_id;
    const out = this.userOut(u);
    out.counts = {
      followers: a ? this.db.get('SELECT COUNT(*) c FROM follows WHERE followee=?', a).c : 0,
      following: a ? this.db.get('SELECT COUNT(*) c FROM follows WHERE follower=?', a).c : 0,
      posts: this.db.get("SELECT COUNT(*) c FROM posts WHERE user_id=? AND group_id IS NULL AND visibility='public' AND parent_event IS NULL AND deleted_at IS NULL", u.id).c,
    };
    if (viewer && a) {
      const f = !!this.db.get('SELECT 1 x FROM follows WHERE follower=? AND followee=?', viewer.account_id, a);
      const fb = !!this.db.get('SELECT 1 x FROM follows WHERE follower=? AND followee=?', a, viewer.account_id);
      out.relation = { self: viewer.id === u.id, following: f, followed_by: fb, friend: f && fb, blocked: !!this.db.get('SELECT 1 x FROM blocks WHERE user_id=? AND account_id=?', viewer.id, a), muted: !!this.db.get('SELECT 1 x FROM mutes WHERE user_id=? AND account_id=?', viewer.id, a) };
    }
    return out;
  }
  followList(account, dir, limit = 100) {
    const col = dir === 'followers' ? 'follower' : 'followee'; const other = dir === 'followers' ? 'followee' : 'follower';
    return this.db.all(`SELECT f.${col} AS account_id, u.id, u.username, u.display_name, u.avatar_media, u.status FROM follows f LEFT JOIN users u ON u.account_id=f.${col} WHERE f.${other}=? ORDER BY f.created_at DESC LIMIT ?`, account, Math.min(200, limit))
      .map((r) => ({ account_id: r.account_id, id: r.id || null, username: r.username || null, display_name: r.display_name || null, avatar_url: r.avatar_media ? `/media/${r.avatar_media}` : null, known: !!r.id }));
  }

  // ---------- search & discovery ----------
  search(viewer, q, type) {
    q = String(q || '').trim().slice(0, 64);
    if (!q) return { accounts: [], posts: [], tags: [] };
    const out = { accounts: [], posts: [], tags: [] };
    const tagMode = q.startsWith('#');
    if (!tagMode && (!type || type === 'accounts')) {
      out.accounts = this.db.all("SELECT * FROM users WHERE status IN ('local','remote') AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') ORDER BY (status='local') DESC, username LIMIT 20", likeEsc(q), likeEsc(q)).map((u) => this.userOut(u));
    }
    const v = this.visible(viewer); const m = this.hideMuted(viewer);
    if (tagMode) {
      const tag = q.slice(1).toLowerCase();
      out.tags = [tag];
      const rows = this.db.all(`${POST_SELECT}${POST_FROM} WHERE p.id IN (SELECT post_id FROM post_tags WHERE tag=?) AND p.group_id IS NULL AND p.deleted_at IS NULL AND ${v.sql} AND ${m.sql} ORDER BY p.sort_ts DESC, p.id DESC LIMIT 30`, tag, ...v.params, ...m.params);
      out.posts = rows.map((r) => this.postOut(r, viewer));
    } else if (!type || type === 'posts') {
      const rows = this.db.all(`${POST_SELECT}${POST_FROM} WHERE p.content LIKE ? ESCAPE '\\' AND p.group_id IS NULL AND p.deleted_at IS NULL AND ${v.sql} AND ${m.sql} ORDER BY p.sort_ts DESC, p.id DESC LIMIT 30`, likeEsc(q), ...v.params, ...m.params);
      out.posts = rows.map((r) => this.postOut(r, viewer));
      out.tags = this.db.all("SELECT tag, COUNT(*) n FROM post_tags WHERE tag LIKE ? ESCAPE '\\' GROUP BY tag ORDER BY n DESC LIMIT 5", likeEsc(q)).map((r) => r.tag);
    }
    return out;
  }
  trends() {
    return this.db.all("SELECT pt.tag, COUNT(*) n FROM post_tags pt JOIN posts p ON p.id=pt.post_id WHERE p.visibility='public' AND p.deleted_at IS NULL AND p.sort_ts > ? GROUP BY pt.tag ORDER BY n DESC, pt.tag LIMIT 10", Date.now() - 7 * 86400000);
  }

  // ---------- notifications ----------
  notifications(user, q) {
    const limit = Math.min(50, Number(q.limit) || 30); const before = Number(q.cursor) || Number.MAX_SAFE_INTEGER;
    const rows = this.db.all(`SELECT n.*, u.username, u.display_name, u.account_id, u.avatar_media, u.status FROM notifications n LEFT JOIN users u ON u.id=n.actor_user_id WHERE n.user_id=? AND n.id<? ORDER BY n.id DESC LIMIT ?`, user.id, before, limit + 1);
    const more = rows.length > limit; if (more) rows.pop();
    const blocked = new Set(this.db.all('SELECT account_id FROM blocks WHERE user_id=?', user.id).map((r) => r.account_id));
    const items = rows.filter((r) => !blocked.has(r.account_id)).map((r) => ({
      id: r.id, type: r.type, post_id: r.post_id, created_at: toIso(r.created_at), read: !!r.read_at,
      actor: { id: r.actor_user_id, username: r.username, display_name: r.display_name, account_id: r.account_id, avatar_url: r.avatar_media ? `/media/${r.avatar_media}` : null },
    }));
    return { items, next_cursor: more ? String(rows[rows.length - 1].id) : null, unread: this.db.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL', user.id).c };
  }
}
module.exports = { Social, enc, dec, toIso, POST_SELECT, POST_FROM };
