'use strict';
// Original API surface (paths and JSON shapes preserved). Behaviour change: identity comes from the
// authenticated session; a client-supplied user_id is only accepted if it equals the session user.
const crypto = require('crypto');
const { HttpError } = require('../util');
const { toIso } = require('../social');

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genInviteCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  return out;
}

module.exports = function register(hub) {
  const { app, db, social, media } = hub;

  const getGroupMeta = (gid) => {
    const key = 'group_meta:' + gid;
    if (hub.sensitive) return hub.sensitive.getJson(key, {}) || {};
    try { return JSON.parse(db.get('SELECT value FROM meta WHERE key=?', key)?.value || '{}') || {}; } catch { return {}; }
  };
  const setGroupMeta = (gid, obj) => {
    const key = 'group_meta:' + gid;
    if (hub.sensitive) hub.sensitive.setJson(key, obj);
    else db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', key, JSON.stringify(obj));
  };
  const ensureGroupInvite = (gid) => {
    const meta = getGroupMeta(gid);
    if (meta.invite_code && /^[A-Z0-9]{6,16}$/.test(meta.invite_code)) {
      db.run('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)', 'group_invite:' + meta.invite_code, String(gid));
      return meta;
    }
    const code = genInviteCode(8);
    const next = { ...meta, invite_code: code };
    setGroupMeta(gid, next);
    db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', 'group_invite:' + code, String(gid));
    return next;
  };
  const enrichGroup = (g, user) => {
    const isMember = !!g.my_role;
    const meta = isMember ? ensureGroupInvite(g.id) : getGroupMeta(g.id);
    const avatarMedia = meta.avatar_media || null;
    const signedAvatar = avatarMedia && user && hub.auth ? `/media/${avatarMedia}?mt=${encodeURIComponent(hub.auth.signMediaToken(user.id, avatarMedia))}` : (avatarMedia ? `/media/${avatarMedia}` : null);
    const out = {
      ...g,
      created_at: toIso(g.created_at),
      topic: meta.topic || null,
      avatar_media: avatarMedia,
      avatar_url: signedAvatar,
      pinned_post_id: meta.pinned_post_id || null,
      is_owner: !!(user && g.owner_id === user.id),
    };
    if (isMember && meta.invite_code) out.invite_code = meta.invite_code;
    return out;
  };

  const sameUser = (ctx) => {
    const b = ctx.body || {};
    if (b.user_id !== undefined && b.user_id !== '' && Number(b.user_id) !== ctx.user.id) throw new HttpError(403, 'E_USER_MISMATCH', 'user_id does not match the authenticated user');
  };
  const group = (id) => { const g = db.get('SELECT * FROM groups WHERE id=?', Number(id)); if (!g) throw new HttpError(404, 'E_NOT_FOUND', 'Group not found'); return g; };
  const role = (gid, uid) => db.get('SELECT role FROM group_members WHERE group_id=? AND user_id=?', gid, uid)?.role || null;
  /** Read access: open groups → any signed-in user; private groups → members only (404 to hide existence). */
  const readable = (g, user) => { if (g.visibility === 'private' && !role(g.id, user.id)) throw new HttpError(404, 'E_NOT_FOUND', 'Group not found'); };
  const intId = (v) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, 'E_INVALID', 'Invalid id'); return n; };

  app.get('/api/users', { auth: 'user' }, (ctx) => {
    const limit = Math.min(200, Number(ctx.query.limit) || 100); const offset = Math.max(0, Number(ctx.query.offset) || 0);
    return db.all('SELECT id, username, avatar, created_at, account_id, display_name, status FROM users ORDER BY id LIMIT ? OFFSET ?', limit, offset).map((u) => ({ ...u, created_at: toIso(u.created_at) }));
  });
  app.post('/api/users', { limit: 'login', csrf: false, auth: 'none' }, (ctx) => hub.registerUser(ctx));

  app.get('/api/groups', { auth: 'user' }, (ctx) => {
    const qStr = String(ctx.query.q || '').trim().toLowerCase();
    const scope = ['joined', 'discover', 'all'].includes(ctx.query.scope) ? ctx.query.scope : 'all';
    const rows = db.all(`SELECT g.*, u.username AS owner_name, (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count,
      (SELECT role FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=?) AS my_role
      FROM groups g LEFT JOIN users u ON g.owner_id=u.id
      WHERE COALESCE(g.visibility,'open')='open' OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=?)
      ORDER BY (my_role IS NOT NULL) DESC, member_count DESC, g.id DESC`, ctx.user.id, ctx.user.id);
    let items = rows.map((g) => enrichGroup(g, ctx.user));
    if (scope === 'joined') items = items.filter((g) => !!g.my_role);
    else if (scope === 'discover') items = items.filter((g) => !g.my_role);
    if (qStr) {
      items = items.filter((g) =>
        String(g.name || '').toLowerCase().includes(qStr)
        || String(g.description || '').toLowerCase().includes(qStr)
        || String(g.topic || '').toLowerCase().includes(qStr)
      );
    }
    return items;
  });

  app.get('/api/groups/:id', { auth: 'user' }, (ctx) => {
    const g = db.get(`SELECT g.*, u.username AS owner_name, (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count,
      (SELECT role FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=?) AS my_role
      FROM groups g LEFT JOIN users u ON g.owner_id=u.id WHERE g.id=?`, ctx.user.id, intId(ctx.params.id));
    if (!g) throw new HttpError(404, 'E_NOT_FOUND', 'Group not found');
    readable(g, ctx.user);
    return enrichGroup(g, ctx.user);
  });

  app.post('/api/groups', { auth: 'user', limit: 'write' }, (ctx) => {
    sameUser(ctx);
    const name = typeof ctx.body.name === 'string' ? ctx.body.name.trim() : '';
    if (!name || name.length > 80) throw new HttpError(400, 'E_INVALID', 'Name is required (max 80 characters)');
    const description = String(ctx.body.description || '').slice(0, 500);
    const visibility = ctx.body.visibility === 'private' ? 'private' : 'open';
    const topic = typeof ctx.body.topic === 'string' ? ctx.body.topic.trim().slice(0, 40) : '';
    let avatarMedia = null;
    if (ctx.body.avatar) {
      const m = media.assertOwned([String(ctx.body.avatar)], ctx.user.id)[0];
      if (!m || !String(m.mime || '').startsWith('image/')) throw new HttpError(400, 'E_INVALID', 'Avatar must be an image');
      avatarMedia = m.hash;
    }
    const inviteCode = genInviteCode(8);
    const id = db.tx(() => {
      const gid = Number(db.run('INSERT INTO groups(name,description,owner_id,visibility) VALUES(?,?,?,?)', name, description, ctx.user.id, visibility).lastInsertRowid);
      db.run("INSERT INTO group_members(group_id,user_id,role) VALUES(?,?, 'admin')", gid, ctx.user.id);
      setGroupMeta(gid, { topic: topic || null, avatar_media: avatarMedia, invite_code: inviteCode, pinned_post_id: null });
      db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', 'group_invite:' + inviteCode, String(gid));
      return gid;
    });
    const signedAvatar = avatarMedia && hub.auth ? `/media/${avatarMedia}?mt=${encodeURIComponent(hub.auth.signMediaToken(ctx.user.id, avatarMedia))}` : (avatarMedia ? `/media/${avatarMedia}` : null);
    return { id, name, description, owner_id: ctx.user.id, visibility, topic: topic || null, avatar_media: avatarMedia, avatar_url: signedAvatar, invite_code: inviteCode, my_role: 'admin', is_owner: true };
  });

  app.patch('/api/groups/:id', { auth: 'user', limit: 'write' }, (ctx) => {
    const g = group(ctx.params.id);
    if (role(g.id, ctx.user.id) !== 'admin') throw new HttpError(403, 'E_FORBIDDEN', 'Group admins only');
    const b = ctx.body || {};
    const name = b.name !== undefined ? String(b.name).trim().slice(0, 80) : g.name;
    if (!name) throw new HttpError(400, 'E_INVALID', 'Name is required (max 80 characters)');
    const description = b.description !== undefined ? String(b.description || '').slice(0, 500) : g.description;
    const visibility = b.visibility !== undefined ? (b.visibility === 'private' ? 'private' : 'open') : g.visibility;
    const curMeta = ensureGroupInvite(g.id);
    const nextMeta = { ...curMeta };
    if (b.topic !== undefined) nextMeta.topic = String(b.topic || '').trim().slice(0, 40) || null;
    if (b.avatar !== undefined) {
      if (b.avatar === null || b.avatar === '') nextMeta.avatar_media = null;
      else {
        const m = media.assertOwned([String(b.avatar)], ctx.user.id)[0];
        if (!m || !String(m.mime || '').startsWith('image/')) throw new HttpError(400, 'E_INVALID', 'Avatar must be an image');
        nextMeta.avatar_media = m.hash;
      }
    }
    if (b.pinned_post_id !== undefined) {
      if (b.pinned_post_id === null || b.pinned_post_id === '') nextMeta.pinned_post_id = null;
      else {
        const pid = intId(b.pinned_post_id);
        const post = db.get('SELECT id, group_id, deleted_at FROM posts WHERE id=?', pid);
        if (!post || post.deleted_at || Number(post.group_id) !== g.id) throw new HttpError(400, 'E_INVALID', 'Post does not belong to this group');
        nextMeta.pinned_post_id = pid;
      }
    }
    if (b.rotate_invite) {
      if (curMeta.invite_code) db.run('DELETE FROM meta WHERE key=?', 'group_invite:' + curMeta.invite_code);
      const code = genInviteCode(8);
      nextMeta.invite_code = code;
      db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', 'group_invite:' + code, String(g.id));
    }
    db.run('UPDATE groups SET name=?, description=?, visibility=? WHERE id=?', name, description, visibility, g.id);
    setGroupMeta(g.id, nextMeta);
    const updated = db.get(`SELECT g.*, u.username AS owner_name, (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count,
      (SELECT role FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=?) AS my_role
      FROM groups g LEFT JOIN users u ON g.owner_id=u.id WHERE g.id=?`, ctx.user.id, g.id);
    return enrichGroup(updated, ctx.user);
  });

  app.delete('/api/groups/:id', { auth: 'user', limit: 'write' }, (ctx) => {
    const g = group(ctx.params.id);
    if (g.owner_id !== ctx.user.id && !ctx.user.is_primary) throw new HttpError(403, 'E_FORBIDDEN', 'Group owner only');
    const curMeta = getGroupMeta(g.id);
    db.tx(() => {
      db.run('DELETE FROM post_media WHERE post_id IN (SELECT id FROM posts WHERE group_id=?)', g.id);
      db.run('DELETE FROM post_tags WHERE post_id IN (SELECT id FROM posts WHERE group_id=?)', g.id);
      db.run('DELETE FROM reactions WHERE post_id IN (SELECT id FROM posts WHERE group_id=?)', g.id);
      db.run('DELETE FROM bookmarks WHERE post_id IN (SELECT id FROM posts WHERE group_id=?)', g.id);
      db.run('DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE group_id=?)', g.id);
      db.run('DELETE FROM posts WHERE group_id=?', g.id);
      db.run('DELETE FROM group_members WHERE group_id=?', g.id);
      db.run('DELETE FROM groups WHERE id=?', g.id);
      db.run('DELETE FROM meta WHERE key=?', 'group_meta:' + g.id);
      if (curMeta.invite_code) db.run('DELETE FROM meta WHERE key=?', 'group_invite:' + curMeta.invite_code);
    });
    return { deleted: true, id: g.id };
  });

  app.post('/api/groups/join-code', { auth: 'user', limit: 'write' }, (ctx) => {
    const code = String((ctx.body && ctx.body.code) || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code || code.length < 6 || code.length > 16) throw new HttpError(400, 'E_INVALID', 'Valid invite code required');
    const row = db.get('SELECT value FROM meta WHERE key=?', 'group_invite:' + code);
    if (!row || !row.value) throw new HttpError(404, 'E_NOT_FOUND', 'Invalid or expired invite code');
    const gid = Number(row.value);
    const g = db.get('SELECT * FROM groups WHERE id=?', gid);
    if (!g) throw new HttpError(404, 'E_NOT_FOUND', 'Group not found');
    db.run("INSERT OR IGNORE INTO group_members(group_id,user_id,role) VALUES(?,?, 'member')", g.id, ctx.user.id);
    const full = db.get(`SELECT g.*, u.username AS owner_name, (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count,
      (SELECT role FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=?) AS my_role
      FROM groups g LEFT JOIN users u ON g.owner_id=u.id WHERE g.id=?`, ctx.user.id, g.id);
    return { success: true, group_id: g.id, group: enrichGroup(full, ctx.user) };
  });

  app.get('/api/groups/:id/members', { auth: 'user' }, (ctx) => {
    const g = group(ctx.params.id); readable(g, ctx.user);
    return db.all('SELECT gm.*, u.username, u.avatar, u.display_name FROM group_members gm JOIN users u ON gm.user_id=u.id WHERE gm.group_id=? ORDER BY gm.joined_at LIMIT 500', g.id);
  });
  app.post('/api/groups/:id/join', { auth: 'user', limit: 'write' }, (ctx) => {
    sameUser(ctx);
    const g = group(ctx.params.id);
    if (g.visibility === 'private') throw new HttpError(403, 'E_PRIVATE_GROUP', 'This group is invite-only');
    db.run("INSERT OR IGNORE INTO group_members(group_id,user_id,role) VALUES(?,?, 'member')", g.id, ctx.user.id);
    return { success: true };
  });
  app.post('/api/groups/:id/leave', { auth: 'user', limit: 'write' }, (ctx) => {
    const g = group(ctx.params.id);
    const r = role(g.id, ctx.user.id);
    if (!r) return { success: true };
    if (r === 'admin' && db.get("SELECT COUNT(*) c FROM group_members WHERE group_id=? AND role='admin'", g.id).c === 1) throw new HttpError(409, 'E_LAST_ADMIN', 'Promote another admin before leaving');
    db.run('DELETE FROM group_members WHERE group_id=? AND user_id=?', g.id, ctx.user.id);
    return { success: true };
  });
  // admin-only membership management
  app.post('/api/groups/:id/members', { auth: 'user', limit: 'write' }, (ctx) => {
    const g = group(ctx.params.id);
    if (role(g.id, ctx.user.id) !== 'admin') throw new HttpError(403, 'E_FORBIDDEN', 'Group admins only');
    const uid = intId(ctx.body.user_id);
    if (!db.get("SELECT 1 x FROM users WHERE id=? AND status IN ('local','legacy')", uid)) throw new HttpError(404, 'E_NOT_FOUND', 'User not found');
    const r = ctx.body.role === 'admin' ? 'admin' : 'member';
    db.run('INSERT INTO group_members(group_id,user_id,role) VALUES(?,?,?) ON CONFLICT(group_id,user_id) DO UPDATE SET role=excluded.role', g.id, uid, r);
    return { success: true };
  });
  app.patch('/api/groups/:id/members/:uid', { auth: 'user', limit: 'write' }, (ctx) => {
    const g = group(ctx.params.id); const uid = intId(ctx.params.uid);
    if (role(g.id, ctx.user.id) !== 'admin') throw new HttpError(403, 'E_FORBIDDEN', 'Group admins only');
    if (!role(g.id, uid)) throw new HttpError(404, 'E_NOT_FOUND', 'Not a member');
    const r = ctx.body.role === 'admin' ? 'admin' : 'member';
    if (r === 'member' && role(g.id, uid) === 'admin' && db.get("SELECT COUNT(*) c FROM group_members WHERE group_id=? AND role='admin'", g.id).c === 1) throw new HttpError(409, 'E_LAST_ADMIN', 'A group needs at least one admin');
    db.run('UPDATE group_members SET role=? WHERE group_id=? AND user_id=?', r, g.id, uid);
    return { success: true };
  });
  app.delete('/api/groups/:id/members/:uid', { auth: 'user', limit: 'write' }, (ctx) => {
    const g = group(ctx.params.id); const uid = intId(ctx.params.uid);
    if (uid !== ctx.user.id && role(g.id, ctx.user.id) !== 'admin') throw new HttpError(403, 'E_FORBIDDEN', 'Group admins only');
    if (role(g.id, uid) === 'admin' && db.get("SELECT COUNT(*) c FROM group_members WHERE group_id=? AND role='admin'", g.id).c === 1) throw new HttpError(409, 'E_LAST_ADMIN', 'A group needs at least one admin');
    db.run('DELETE FROM group_members WHERE group_id=? AND user_id=?', g.id, uid);
    return { success: true };
  });

  app.get('/api/groups/:id/posts', { auth: 'user' }, (ctx) => {
    const g = group(ctx.params.id); readable(g, ctx.user);
    const r = social.page(`p.group_id=? AND p.parent_id IS NULL AND p.parent_event IS NULL AND p.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.user_id=? AND b.account_id=u.account_id)`, [g.id, ctx.user.id], { cursor: ctx.query.cursor, limit: ctx.query.limit || 100, max: 200, viewer: ctx.user });
    const pinId = getGroupMeta(g.id).pinned_post_id;
    let items = r.items;
    if (pinId) {
      if (!ctx.query.cursor) {
        const v = social.visible(ctx.user);
        const { POST_SELECT, POST_FROM } = require('../social');
        const pinRow = db.get(`${POST_SELECT}${POST_FROM} WHERE p.id=? AND p.group_id=? AND p.deleted_at IS NULL AND ${v.sql}`, pinId, g.id, ...v.params);
        if (pinRow) {
          const pinPost = { ...social.postOut(pinRow, ctx.user), is_group_pinned: true };
          items = [pinPost, ...items.filter((it) => it.id !== pinPost.id)];
        }
      } else {
        items = items.filter((it) => it.id !== pinId);
      }
    }
    if (r.next_cursor) ctx.res.setHeader('X-Next-Cursor', r.next_cursor);
    return items; // legacy shape: plain array
  });
  app.post('/api/groups/:id/posts', { auth: 'user', body: 'multipart', limit: 'upload' }, (ctx) => {
    sameUser(ctx);
    const g = group(ctx.params.id);
    let hashes = [];
    if (!role(g.id, ctx.user.id)) throw new HttpError(403, 'E_NOT_MEMBER', 'Join the group before posting');
    if (ctx.files[0]) hashes = [media.adopt(ctx.files[0], ctx.user.id).hash];
    const out = social.createPost(ctx.user, { content: ctx.body.content, group_id: g.id, media: hashes, client_id: ctx.body.client_id });
    return out.post;
  });
  // JSON variant (no file) so scripts and the new UI can post to a group without multipart
  app.post('/api/groups/:id/posts.json', { auth: 'user', limit: 'write' }, (ctx) => {
    sameUser(ctx); const g = group(ctx.params.id);
    return social.createPost(ctx.user, { content: ctx.body.content, group_id: g.id, media: ctx.body.media, client_id: ctx.body.client_id }).post;
  });

  app.get('/api/posts/:id/comments', { auth: 'user' }, (ctx) => {
    const t = social.thread(ctx.user, intId(ctx.params.id), { limit: 200, max: 200 });
    const direct = t.replies.filter((r) => r.parent_id === t.post.id || (!r.parent_id && t.post.event_id && r.parent_event === t.post.event_id));
    const rows = [...t.comments.map((c) => ({ id: c.id, post_id: t.post.id, user_id: c.user_id, content: c.content, created_at: c.created_at, username: c.username, avatar: '' })),
      ...direct.map((r) => ({ id: r.id, post_id: t.post.id, user_id: r.user_id, content: r.content, created_at: r.created_at, username: r.username, avatar: r.avatar, reply: true }))];
    return rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  });
  app.post('/api/posts/:id/comments', { auth: 'user', limit: 'write' }, (ctx) => {
    sameUser(ctx);
    const pid = intId(ctx.params.id);
    const out = social.createPost(ctx.user, { content: ctx.body.content, reply_to: pid, visibility: 'public', client_id: ctx.body.client_id });
    if (out.comment) return out.comment;
    return { id: out.post.id, post_id: pid, user_id: ctx.user.id, content: out.post.content, created_at: out.post.created_at };
  });
  app.post('/api/posts/:id/react', { auth: 'user', limit: 'write' }, (ctx) => { sameUser(ctx); return social.react(ctx.user, intId(ctx.params.id), ctx.body.type); });

  app.get('/api/groups/:id/files', { auth: 'user' }, (ctx) => {
    const g = group(ctx.params.id); readable(g, ctx.user);
    const postFiles = db.all(`SELECT p.id, p.file_url, p.created_at, u.username FROM posts p JOIN users u ON p.user_id=u.id WHERE p.group_id=? AND p.file_url IS NOT NULL AND p.deleted_at IS NULL ORDER BY p.id DESC LIMIT 500`, g.id)
      .map((r) => {
        const hash = /^\/media\/([0-9a-f]{64})$/.exec(r.file_url || '')?.[1];
        const m = hash && media.meta(hash);
        const signed_url = hash ? social._signedMediaUrl(hash, ctx.user) : undefined;
        return { ...r, ...(signed_url ? { signed_url } : {}), created_at: toIso(r.created_at), name: m ? m.name : undefined, kind: m ? m.kind : undefined, source: 'post' };
      });
    const shared = hub.fileShare ? hub.fileShare.list(ctx.user, { group_id: g.id }).map((f) => ({
      id: f.id,
      share_id: f.id,
      file_url: `#/files/${f.id}`,
      name: f.name,
      kind: f.kind,
      size: f.size,
      sha256: f.sha256,
      protected: !!f.has_passcode,
      username: f.owner_username || '',
      created_at: f.created_at,
      source: 'p2p_share',
    })) : [];
    return [...shared, ...postFiles].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  });
};

