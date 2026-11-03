'use strict';
// Original API surface (paths and JSON shapes preserved). Behaviour change: identity comes from the
// authenticated session; a client-supplied user_id is only accepted if it equals the session user.
const { HttpError } = require('../util');
const { toIso, POST_SELECT, POST_FROM } = require('../social');

module.exports = function register(hub) {
  const { app, db, social, media } = hub;

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
    return db.all(`SELECT g.*, u.username AS owner_name, (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count,
      (SELECT role FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=?) AS my_role
      FROM groups g LEFT JOIN users u ON g.owner_id=u.id
      WHERE COALESCE(g.visibility,'open')='open' OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=?) ORDER BY g.id`, ctx.user.id, ctx.user.id)
      .map((g) => ({ ...g, created_at: toIso(g.created_at) }));
  });
  app.post('/api/groups', { auth: 'user', limit: 'write' }, (ctx) => {
    sameUser(ctx);
    const name = typeof ctx.body.name === 'string' ? ctx.body.name.trim() : '';
    if (!name || name.length > 80) throw new HttpError(400, 'E_INVALID', 'Name is required (max 80 characters)');
    const description = String(ctx.body.description || '').slice(0, 500);
    const visibility = ctx.body.visibility === 'private' ? 'private' : 'open';
    const id = db.tx(() => {
      const gid = Number(db.run('INSERT INTO groups(name,description,owner_id,visibility) VALUES(?,?,?,?)', name, description, ctx.user.id, visibility).lastInsertRowid);
      db.run("INSERT INTO group_members(group_id,user_id,role) VALUES(?,?, 'admin')", gid, ctx.user.id);
      return gid;
    });
    return { id, name, description, owner_id: ctx.user.id, visibility };
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
    const r = social.page(`p.group_id=? AND p.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.user_id=? AND b.account_id=u.account_id)`, [g.id, ctx.user.id], { cursor: ctx.query.cursor, limit: ctx.query.limit || 100, max: 200, viewer: ctx.user });
    if (r.next_cursor) ctx.res.setHeader('X-Next-Cursor', r.next_cursor);
    return r.items; // legacy shape: plain array
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
    const rows = [...t.comments.map((c) => ({ id: c.id, post_id: t.post.id, user_id: c.user_id, content: c.content, created_at: c.created_at, username: c.username, avatar: '' })),
      ...t.replies.map((r) => ({ id: r.id, post_id: t.post.id, user_id: r.user_id, content: r.content, created_at: r.created_at, username: r.username, avatar: r.avatar, reply: true }))];
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
    return db.all(`SELECT p.id, p.file_url, p.created_at, u.username FROM posts p JOIN users u ON p.user_id=u.id WHERE p.group_id=? AND p.file_url IS NOT NULL AND p.deleted_at IS NULL ORDER BY p.id DESC LIMIT 500`, g.id)
      .map((r) => {
        const hash = /^\/media\/([0-9a-f]{64})$/.exec(r.file_url || '')?.[1];
        const m = hash && media.meta(hash);
        return { ...r, created_at: toIso(r.created_at), name: m ? m.name : undefined, kind: m ? m.kind : undefined };
      });
  });
};
