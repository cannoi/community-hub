'use strict';
// Social domain services: visibility rules, serializers, posts, feeds, unified threads, reactions, mentions, search, notifications.
const { HttpError } = require('./util');
const { isAccountId } = require('./keystore');
const { extractTags, extractMentions } = require('./materializer');

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
  ((SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) + (SELECT COUNT(*) FROM posts x WHERE x.deleted_at IS NULL AND (x.parent_id=p.id OR (p.parent_id IS NULL AND p.parent_event IS NULL AND x.root_id=p.id) OR (p.event_id IS NOT NULL AND x.parent_event=p.event_id AND x.parent_id IS NULL)))) AS reply_count,
  CASE WHEN p.event_id IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM posts x WHERE x.ref_event=p.event_id AND x.kind='repost' AND x.deleted_at IS NULL) END AS repost_count,
  CASE WHEN p.event_id IS NULL THEN 0 ELSE (SELECT COUNT(*) FROM posts x WHERE x.ref_event=p.event_id AND x.kind='quote' AND x.deleted_at IS NULL) END AS quote_count`;
const POST_SELECT = `SELECT p.*, u.username, u.display_name, u.account_id AS author_account, u.avatar AS author_legacy_avatar, u.avatar_media AS author_avatar_media, u.status AS author_status, u.pinned_post_id AS author_pinned_post_id, u.dm_pub AS author_dm_pub, ${COUNTS}`;
const POST_FROM = ' FROM posts p JOIN users u ON u.id=p.user_id';

class Social {
  constructor({ db, ledger, ks, media, cfg, bus, auth = null }) {
    this.db = db; this.ledger = ledger; this.ks = ks; this.media = media; this.cfg = cfg; this.bus = bus; this.auth = auth;
  }

  // ---------- visibility ----------
  /** SQL predicate (alias p/u) for posts the viewer may see. Private is owner-only; followers is self + followers; restricted is never matched for anonymous callers. */
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
    if (this.media.isRemoteRef(hash)) return true; // streamed on demand for signed-in users only
    if (this.db.get('SELECT 1 x FROM media_owners WHERE hash=? AND user_id=?', hash, viewer.id)) return true;
    // Allow DM sender/recipient who received an E2EE attachment referencing this hash
    if (viewer.account_id) {
      const dmKey = 'dm_media:' + hash;
      let dmAllowed = null;
      if (this.db._sensitive) dmAllowed = this.db._sensitive.getJson(dmKey, null);
      else { try { dmAllowed = JSON.parse(this.db.get('SELECT value FROM meta WHERE key=?', dmKey)?.value || 'null'); } catch {} }
      if (Array.isArray(dmAllowed) && dmAllowed.includes(viewer.account_id)) return true;
    }
    // Allow viewing group avatar media if the group is open or the viewer is a member
    try {
      const gMetas = this.db.all("SELECT key, value FROM meta WHERE key LIKE 'group_meta:%'");
      for (const row of gMetas) {
        let gm = null;
        if (this.db._sensitive) gm = this.db._sensitive.getJson(row.key, null);
        else { try { gm = JSON.parse(row.value || 'null'); } catch {} }
        if (gm && gm.avatar_media === hash) {
          const gid = Number(row.key.slice('group_meta:'.length));
          const grp = this.db.get('SELECT id, visibility FROM groups WHERE id=?', gid);
          if (grp && (grp.visibility !== 'private' || this.db.get('SELECT 1 x FROM group_members WHERE group_id=? AND user_id=?', gid, viewer.id))) {
            return true;
          }
        }
      }
    } catch { /* ignore */ }
    const v = this.visible(viewer);
    return !!this.db.get(`SELECT 1 x FROM post_media pm JOIN posts p ON p.id=pm.post_id JOIN users u ON u.id=p.user_id WHERE pm.hash=? AND p.deleted_at IS NULL AND ${v.sql} LIMIT 1`, hash, ...v.params);
  }

  _signedMediaUrl(hash, viewer) {
    if (!hash || !viewer || !this.auth) return undefined;
    return `/media/${hash}?mt=${encodeURIComponent(this.auth.signMediaToken(viewer.id, hash))}`;
  }

  // ---------- serializers ----------
  userOut(r) {
    if (!r) return null;
    return {
      id: r.id, account_id: r.account_id || null, username: r.username, display_name: r.display_name || null,
      bio: r.bio || null, status: r.status, avatar_url: r.avatar_media ? `/media/${r.avatar_media}` : null,
      avatar: r.avatar || '', dm_pub: r.dm_pub || null, pinned_post_id: r.pinned_post_id || null,
      created_at: toIso(r.created_at),
    };
  }
  postOut(r, viewer, depth = 0) {
    const media = r.media ? JSON.parse(r.media).map((m) => {
      const signed = this._signedMediaUrl(m.hash, viewer);
      return {
        ...m,
        kind: this.media.meta(m.hash)?.kind || (m.mime || '').split('/')[0],
        url: `/media/${m.hash}`,
        ...(signed ? { signed_url: signed } : {}),
        available: this.media.exists(m.hash),
      };
    }) : [];
    const out = {
      id: r.id, event_id: r.event_id || null, group_id: r.group_id, user_id: r.user_id, content: r.content, file_url: r.file_url,
      created_at: toIso(r.created_at), sort_ts: r.sort_ts, edited_at: r.edited_at ? toIso(r.edited_at) : null,
      deleted: !!(r.deleted_at && r.deleted_at > 0), visibility: r.visibility, kind: r.kind, origin: r.origin,
      username: r.username, avatar: r.author_legacy_avatar || '',
      author: {
        id: r.user_id, account_id: r.author_account || null, username: r.username,
        display_name: r.display_name || null, status: r.author_status,
        avatar_url: r.author_avatar_media ? `/media/${r.author_avatar_media}` : null,
        dm_pub: r.author_dm_pub || null,
      },
      media, reaction_count: r.like_count, comment_count: r.reply_count,
      counts: { likes: r.like_count, replies: r.reply_count, reposts: r.repost_count, quotes: r.quote_count },
      parent_id: r.parent_id || null,
      root_id: r.root_id || null,
      parent_event: r.parent_event || null,
      is_pinned: !!(r.author_pinned_post_id && r.author_pinned_post_id === r.id),
    };
    // X-style reply context (works for both local parent_id and federated parent_event)
    if ((r.parent_id || r.parent_event) && depth < 2) {
      try {
        const pr = r.parent_id
          ? this.db.get(`SELECT p.id, p.content, p.event_id, u.username, u.display_name, u.account_id FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=? AND p.deleted_at IS NULL LIMIT 1`, r.parent_id)
          : this.db.get(`SELECT p.id, p.content, p.event_id, u.username, u.display_name, u.account_id FROM posts p JOIN users u ON u.id=p.user_id WHERE p.event_id=? AND p.deleted_at IS NULL LIMIT 1`, r.parent_event);
        if (pr) {
          const prev = String(pr.content || '').replace(/\s+/g, ' ').trim().slice(0, 140);
          out.reply_to = {
            id: pr.id, event_id: pr.event_id || null, username: pr.username,
            display_name: pr.display_name || null, account_id: pr.account_id || null, preview: prev || null,
          };
        }
      } catch { /* ignore */ }
    }
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
    return this.page(`p.group_id IS NULL AND p.deleted_at IS NULL AND p.parent_id IS NULL AND p.parent_event IS NULL AND (p.user_id=? OR u.account_id IN (SELECT followee FROM follows WHERE follower=?)) AND ${v.sql} AND ${m.sql}`,
      [viewer.id, viewer.account_id, ...v.params, ...m.params], { ...q, viewer });
  }
  _spamPenalty(text) {
    const s = String(text || '').trim();
    if (!s) return 0.1;
    let pen = 0;
    const words = s.split(/\s+/u).filter(Boolean);
    if (words.length >= 3) {
      const tags = words.filter((w) => w.startsWith('#')).length;
      const links = words.filter((w) => /^https?:/i.test(w)).length;
      if ((tags + links) / words.length > 0.45) pen += 0.45;
      if (links >= 3) pen += 0.35;
      const uniq = new Set(words.map((w) => w.toLowerCase())).size;
      if (words.length >= 6 && uniq / words.length < 0.4) pen += 0.5;
    }
    const letters = s.replace(/[^\p{L}]/gu, '');
    const caps = letters.replace(/[^\p{Lu}]/gu, '');
    if (letters.length > 20 && caps.length / letters.length > 0.7) pen += 0.35;
    if (/(.)\1{8,}/.test(s)) pen += 0.3;
    return Math.min(1, pen);
  }

  _detectTextLang(text) {
    const s = String(text || '');
    if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s)) return 'vi';
    if (/[\u3040-\u30ff]/.test(s)) return 'ja';
    if (/[\uac00-\ud7af]/.test(s)) return 'ko';
    if (/[\u4e00-\u9fff]/.test(s)) return 'zh';
    if (/[ñáéíóúü¿¡]/i.test(s)) return 'es';
    if (/[àâæçéèêëïîôùûüÿœ]/i.test(s)) return 'fr';
    return 'en';
  }

  _normTextKey(text) {
    return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /** X-style algorithmic For You feed: blends followed, 2-hop Web-of-Trust, behavior prefs, anti-spam & diversity. */
  forYouFeed(viewer, q = {}) {
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 20));
    const offset = Math.max(0, Number.parseInt(q.cursor, 10) || 0);
    const v = this.visible(viewer); const m = this.hideMuted(viewer);
    const prefLangs = new Set(String(q.langs || (viewer && viewer.lang) || '').split(',').map((x) => x.trim().toLowerCase()).filter((x) => /^[a-z]{2,3}$/.test(x)));
    const hintTags = new Set(String(q.tags || '').split(',').map((x) => x.trim().toLowerCase().replace(/^#+/, '')).filter(Boolean));

    // Direct follows + 2-hop follows (friends of friends)
    const directSet = new Set(viewer && viewer.account_id ? this.db.all('SELECT followee FROM follows WHERE follower=?', viewer.account_id).map((r) => r.followee) : []);
    const wotSet = new Set();
    if (directSet.size) {
      for (const f of directSet) {
        for (const r of this.db.all('SELECT followee FROM follows WHERE follower=? LIMIT 40', f)) wotSet.add(r.followee);
      }
    }
    // User preferred tags from recent likes or posts + behavior hints
    const userTags = new Set([...hintTags, ...(viewer ? this.db.all(`
      SELECT DISTINCT pt.tag FROM post_tags pt
      JOIN posts p ON p.id=pt.post_id
      WHERE p.user_id=? OR EXISTS(SELECT 1 FROM reactions r WHERE r.user_id=? AND (r.post_id=p.id OR r.target_event=p.event_id))
      ORDER BY p.sort_ts DESC LIMIT 20
    `, viewer.id, viewer.id).map((x) => x.tag) : [])]);

    const rows = this.db.all(
      `${POST_SELECT}${POST_FROM}
       WHERE p.group_id IS NULL AND p.deleted_at IS NULL AND p.parent_id IS NULL AND p.parent_event IS NULL
         AND (p.visibility='public' OR p.user_id=? OR (p.visibility='followers' AND EXISTS(SELECT 1 FROM follows f WHERE f.follower=? AND f.followee=u.account_id)))
         AND ${v.sql} AND ${m.sql}
       ORDER BY p.sort_ts DESC, p.id DESC LIMIT 200`,
      viewer ? viewer.id : 0, viewer ? (viewer.account_id || '') : '', ...v.params, ...m.params
    );

    const now = Date.now();
    const postIds = rows.map((r) => r.id);
    const tagsByPost = new Map();
    if (postIds.length && userTags.size) {
      for (const tr of this.db.all(`SELECT post_id, tag FROM post_tags WHERE post_id IN (${postIds.map(() => '?').join(',')})`, ...postIds)) {
        if (!tagsByPost.has(tr.post_id)) tagsByPost.set(tr.post_id, []);
        tagsByPost.get(tr.post_id).push(tr.tag);
      }
    }

    const scored = rows.map((r) => {
      const ageHours = Math.max(0, (now - (r.sort_ts || 0)) / 3600000);
      const recency = 60 / (1 + ageHours / 12);
      const eng = (r.like_count || 0) * 3 + (r.reply_count || 0) * 4 + (r.repost_count || 0) * 3 + (r.quote_count || 0) * 3;
      const acct = r.author_account || '';
      const followBoost = (viewer && r.user_id === viewer.id) ? 14 : directSet.has(acct) ? 24 : wotSet.has(acct) ? 14 : 0;
      const mediaBoost = (r.file_url || (r.media && r.media !== '[]')) ? 6 : 0;
      const pTags = tagsByPost.get(r.id) || [];
      const tagBoost = pTags.some((tg) => userTags.has(tg)) ? 12 : 0;
      const lang = this._detectTextLang(r.content);
      const langBoost = prefLangs.size ? (prefLangs.has(lang) ? 8 : -4) : 0;
      const spamPen = this._spamPenalty(r.content) * 45;
      const p2pOriginBoost = r.origin === 'remote' ? 4 : 0;
      return { r, score: recency + Math.min(80, eng) + followBoost + mediaBoost + tagBoost + langBoost + p2pOriginBoost - spamPen };
    }).sort((a, b) => b.score - a.score || b.r.sort_ts - a.r.sort_ts);

    // Deduplicate identical spam text and cap rapid consecutive/total domination per author
    const seenText = new Set();
    const primary = [];
    const overflow = [];
    const authorCounts = new Map();
    const MAX_PER_AUTHOR = 3;
    for (const item of scored) {
      const norm = this._normTextKey(item.r.content);
      if (norm.length > 16) {
        if (seenText.has(norm)) continue;
        seenText.add(norm);
      }
      const ak = String(item.r.author_account || item.r.user_id);
      const c = authorCounts.get(ak) || 0;
      if (c < MAX_PER_AUTHOR) {
        authorCounts.set(ak, c + 1);
        primary.push(item);
      } else {
        overflow.push(item);
      }
    }
    const finalList = [...primary, ...overflow];
    const slice = finalList.slice(offset, offset + limit);
    const hasMore = offset + slice.length < finalList.length;
    return {
      items: slice.map((x) => this.postOut(x.r, viewer)),
      next_cursor: hasMore ? String(offset + slice.length) : null,
    };
  }
  publicFeed(viewer, q = {}) {
    const v = this.visible(viewer); const m = this.hideMuted(viewer);
    const pg = this.page(`p.group_id IS NULL AND p.deleted_at IS NULL AND p.parent_id IS NULL AND p.parent_event IS NULL AND p.visibility='public' AND ${v.sql} AND ${m.sql}`, [...v.params, ...m.params], { ...q, viewer });
    // Anti-spam / deduplication pass on page items without breaking cursor continuity
    const seen = new Set();
    const deduped = [];
    for (const it of pg.items) {
      const norm = this._normTextKey(it.content);
      if (norm.length > 20 && seen.has(norm)) continue;
      if (norm.length > 20) seen.add(norm);
      deduped.push(it);
    }
    if (!q.cursor && (q.langs || q.tags)) {
      const prefLangs = new Set(String(q.langs || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
      const hintTags = new Set(String(q.tags || '').split(',').map((x) => x.trim().toLowerCase().replace(/^#+/, '')).filter(Boolean));
      deduped.sort((a, b) => {
        const sa = (prefLangs.has(this._detectTextLang(a.content)) ? 8 : 0) + ((a.tags || []).some((tg) => hintTags.has(tg)) ? 10 : 0) - this._spamPenalty(a.content) * 40;
        const sb = (prefLangs.has(this._detectTextLang(b.content)) ? 8 : 0) + ((b.tags || []).some((tg) => hintTags.has(tg)) ? 10 : 0) - this._spamPenalty(b.content) * 40;
        return sb - sa;
      });
    }
    pg.items = deduped;
    return pg;
  }
  profileFeed(viewer, userId, q = {}) {
    const v = this.visible(viewer);
    const filter = q.filter || (q.replies ? 'replies' : 'posts');
    if (filter === 'private') {
      if (!viewer || viewer.id !== userId) return { items: [], next_cursor: null };
      return this.page(`p.user_id=? AND p.group_id IS NULL AND p.deleted_at IS NULL AND p.visibility='private' AND ${v.sql}`, [userId, ...v.params], { ...q, viewer });
    }
    if (filter === 'media') {
      return this.page(`p.user_id=? AND p.group_id IS NULL AND p.deleted_at IS NULL AND (p.file_url IS NOT NULL OR (p.media IS NOT NULL AND p.media <> '[]' AND p.media <> '')) AND ${v.sql}`, [userId, ...v.params], { ...q, viewer });
    }
    if (filter === 'replies' || q.replies) {
      return this.page(`p.user_id=? AND p.group_id IS NULL AND p.deleted_at IS NULL AND ${v.sql}`, [userId, ...v.params], { ...q, viewer });
    }
    const page = this.page(`p.user_id=? AND p.group_id IS NULL AND p.deleted_at IS NULL AND p.parent_id IS NULL AND p.parent_event IS NULL AND ${v.sql}`, [userId, ...v.params], { ...q, viewer });
    if (!q.cursor) {
      const pinId = this.db.get('SELECT pinned_post_id FROM users WHERE id=?', userId)?.pinned_post_id;
      if (pinId && this.canViewPost(viewer, pinId)) {
        const pinRow = this.db.get(`${POST_SELECT}${POST_FROM} WHERE p.id=? AND p.user_id=? AND p.deleted_at IS NULL AND ${v.sql}`, pinId, userId, ...v.params);
        if (pinRow) {
          const rest = page.items.filter((it) => it.id !== pinRow.id);
          page.items = [this.postOut(pinRow, viewer), ...rest];
        }
      }
    } else {
      const pinId = this.db.get('SELECT pinned_post_id FROM users WHERE id=?', userId)?.pinned_post_id;
      if (pinId) page.items = page.items.filter((it) => it.id !== pinId);
    }
    return page;
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
  thread(viewer, id, q = {}) {
    const post = this.getPost(viewer, id);
    const v = this.visible(viewer);
    // 1) Ancestor chain upward (max 8 hops) for X-style vertical parent context
    const ancestors = [];
    const seenAnc = new Set([post.id]);
    let curParentId = post.parent_id;
    let curParentEv = post.parent_event;
    for (let step = 0; step < 8 && (curParentId || curParentEv); step++) {
      const ar = curParentId
        ? this.db.get(`${POST_SELECT}${POST_FROM} WHERE p.id=? AND ${v.sql}`, curParentId, ...v.params)
        : this.db.get(`${POST_SELECT}${POST_FROM} WHERE p.event_id=? AND ${v.sql}`, curParentEv, ...v.params);
      if (!ar || seenAnc.has(ar.id)) break;
      seenAnc.add(ar.id);
      ancestors.unshift(this.postOut(ar, viewer));
      curParentId = ar.parent_id;
      curParentEv = ar.parent_event;
    }

    // 2) Full multi-level conversation tree (up to 8 levels deep, bounded to 250 items)
    const maxItems = Math.min(250, Math.max(20, Number(q.limit) || 200));
    const collected = [];
    const seenIds = new Set([post.id]);
    let frontierIds = [post.id];
    let frontierEvs = post.event_id ? [post.event_id] : [];
    for (let lvl = 0; lvl < 8 && (frontierIds.length || frontierEvs.length) && collected.length < maxItems; lvl++) {
      const conds = [];
      const params = [];
      if (frontierIds.length) {
        conds.push(`p.parent_id IN (${frontierIds.map(() => '?').join(',')})`);
        params.push(...frontierIds);
      }
      if (frontierEvs.length) {
        conds.push(`(p.parent_id IS NULL AND p.parent_event IN (${frontierEvs.map(() => '?').join(',')}))`);
        params.push(...frontierEvs);
      }
      const rows = this.db.all(
        `${POST_SELECT}${POST_FROM} WHERE (${conds.join(' OR ')}) AND p.deleted_at IS NULL AND ${v.sql} ORDER BY p.sort_ts ASC, p.id ASC LIMIT ?`,
        ...params, ...v.params, maxItems - collected.length
      );
      const nextIds = [];
      const nextEvs = [];
      for (const r of rows) {
        if (seenIds.has(r.id)) continue;
        seenIds.add(r.id);
        collected.push(this.postOut(r, viewer));
        nextIds.push(r.id);
        if (r.event_id) nextEvs.push(r.event_id);
      }
      frontierIds = nextIds;
      frontierEvs = nextEvs;
    }

    // Backwards-compatible legacy comments array for /api/posts/:id/comments
    const legacy = this.db.all('SELECT c.id,c.content,c.created_at,c.user_id,u.username,u.display_name FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.id ASC LIMIT 200', id)
      .map((c) => ({ id: c.id, content: c.content, created_at: toIso(c.created_at), user_id: c.user_id, username: c.username, display_name: c.display_name, legacy_comment: true }));
    return { ancestors, post, replies: collected, comments: legacy, next_cursor: null };
  }

  // ---------- writes ----------
  _requireKey(user) {
    if (!user.account_id || !this.ks.has(user.account_id)) throw new HttpError(403, 'E_NO_KEY', 'This account cannot sign events');
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

  _notifyLocalMentions(user, postId, content, ts, vis, groupId) {
    if (vis === 'private') return;
    for (const uname of extractMentions(content)) {
      const mu = this.db.get("SELECT id, account_id FROM users WHERE username=? COLLATE NOCASE AND status='local'", uname);
      if (!mu || mu.id === user.id) continue;
      if (vis === 'group' && groupId) {
        if (!this.db.get('SELECT 1 x FROM group_members WHERE group_id=? AND user_id=?', groupId, mu.id)) continue;
      }
      if (vis === 'followers') {
        if (!this.db.get('SELECT 1 x FROM follows WHERE follower=? AND followee=?', mu.account_id, user.account_id)) continue;
      }
      this.ledger.mat.notify(mu.id, 'mention', user.id, postId, 'mention_' + postId + '_' + mu.id, ts, true);
    }
  }

  createPost(user, b) {
    const cid = b.client_id ? String(b.client_id).slice(0, 64) : null;
    const dup = this._byClient(user, cid);
    if (dup) return { post: this.getPost(user, dup.id), duplicate: true };
    const hashes = Array.isArray(b.media) ? b.media.slice(0, 4) : [];
    const media = hashes.length ? this.media.assertOwned(hashes.map(String), user.id) : [];
    const kindIn = b.repost_of ? 'repost' : b.quote_of ? 'quote' : b.reply_to ? 'reply' : 'post';
    const content = this._content(b.content, kindIn === 'repost' || media.length > 0);
    const lang = /^[a-z]{2,3}$/.test(b.lang || '') ? b.lang : undefined;
    const vis = b.group_id ? 'group' : (['public', 'followers', 'private'].includes(b.visibility) ? b.visibility : 'public');

    if (b.group_id) {
      const g = this.db.get('SELECT id FROM groups WHERE id=?', Number(b.group_id));
      if (!g) throw new HttpError(404, 'E_NOT_FOUND', 'Group not found');
      if (!this.db.get('SELECT 1 x FROM group_members WHERE group_id=? AND user_id=?', g.id, user.id)) throw new HttpError(403, 'E_NOT_MEMBER', 'Join the group before posting');
      return { post: this._localPost(user, { content, vis: 'group', group_id: g.id, media, cid }) };
    }
    if (kindIn === 'reply') {
      const parent = this.db.get('SELECT id, user_id, event_id, visibility, group_id, root_id, deleted_at FROM posts WHERE id=?', Number(b.reply_to));
      if (!parent || parent.deleted_at || !this.canViewPost(user, parent.id)) throw new HttpError(404, 'E_NOT_FOUND', 'Post not found');
      const rootId = parent.root_id || parent.id;
      if (parent.event_id && parent.visibility === 'public' && vis === 'public') {
        const post = this._eventPost(user, 'reply', { content, media, lang }, { parent: parent.event_id }, cid, { parent_id: parent.id, root_id: rootId });
        return { post };
      }
      const replyVis = parent.group_id ? 'group' : (parent.visibility || 'public');
      const replyPost = this._localPost(user, {
        content, vis: replyVis, group_id: parent.group_id || null, media, cid,
        kind: 'reply', parent_id: parent.id, root_id: rootId, parent_event: parent.event_id || null,
      });
      if (parent.user_id !== user.id) {
        this.ledger.mat.notify(parent.user_id, 'reply', user.id, replyPost.id, 'local_reply_' + replyPost.id, Date.now(), true);
      }
      return { post: replyPost };
    }
    if (kindIn === 'repost' || kindIn === 'quote') {
      const t = this.db.get("SELECT id, event_id, visibility, deleted_at, kind FROM posts WHERE id=?", Number(b.repost_of || b.quote_of));
      if (!t || !t.event_id || t.visibility !== 'public' || t.deleted_at || !this.canViewPost(user, t.id)) throw new HttpError(400, 'E_NOT_SHAREABLE', 'Only public posts can be reposted or quoted');
      if (kindIn === 'repost' && this.db.get("SELECT 1 x FROM posts WHERE user_id=? AND kind='repost' AND ref_event=? AND deleted_at IS NULL", user.id, t.event_id)) throw new HttpError(409, 'E_ALREADY', 'Already reposted');
      return { post: this._eventPost(user, kindIn, { content, media, lang }, { target: t.event_id }, cid) };
    }
    if (vis === 'followers' || vis === 'private') return { post: this._localPost(user, { content, vis, group_id: null, media, cid }) };
    return { post: this._eventPost(user, 'post', { content, media, lang }, {}, cid) };
  }
  _eventPost(user, kind, p, refs, cid, link = null) {
    this._requireKey(user);
    const payload = { kind, content: p.content }; if (p.media.length) payload.media = p.media; if (p.lang) payload.lang = p.lang;
    let ev;
    try { ev = this.ledger.publish(user.account_id, 'post.create', payload, refs); } catch (e) { throw new HttpError(400, 'E_' + String(e.code || 'PUBLISH').toUpperCase(), 'Could not publish: ' + (e.code || 'error')); }
    const row = this.db.get('SELECT id FROM posts WHERE event_id=?', ev.event_id);
    if (cid) this.db.run('UPDATE posts SET client_id=? WHERE id=?', cid, row.id);
    if (link && link.parent_id) {
      this.db.run('UPDATE posts SET parent_id=COALESCE(parent_id,?), root_id=COALESCE(root_id,?) WHERE id=?', link.parent_id, link.root_id || link.parent_id, row.id);
    }
    this.bus.emit('local-publish');
    return this.getPost(user, row.id);
  }
  _localPost(user, { content, vis, group_id, media, cid, kind = 'post', parent_id = null, root_id = null, parent_event = null }) {
    const now = Date.now();
    const r = this.db.run(
      `INSERT INTO posts(group_id,user_id,content,file_url,created_at,kind,visibility,parent_id,root_id,parent_event,media,sort_ts,origin,client_id)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'local',?)`,
      group_id, user.id, content, media.length ? `/media/${media[0].hash}` : null, new Date(now).toISOString(),
      kind, vis, parent_id, root_id, parent_event, JSON.stringify(media), now, cid
    );
    const id = Number(r.lastInsertRowid);
    for (const m of media) this.db.run('INSERT OR IGNORE INTO post_media(post_id,hash) VALUES(?,?)', id, m.hash);
    for (const tg of extractTags(content)) this.db.run('INSERT OR IGNORE INTO post_tags(post_id,tag) VALUES(?,?)', id, tg);
    this._notifyLocalMentions(user, id, content, now, vis, group_id);
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
      this.db.run('DELETE FROM post_tags WHERE post_id=?', id);
      for (const m of media) this.db.run('INSERT OR IGNORE INTO post_media(post_id,hash) VALUES(?,?)', id, m.hash);
      for (const tg of extractTags(content)) this.db.run('INSERT OR IGNORE INTO post_tags(post_id,tag) VALUES(?,?)', id, tg);
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
      this.db.run('DELETE FROM post_tags WHERE post_id=?', id);
    }
    this.db.run('UPDATE users SET pinned_post_id=NULL WHERE id=? AND pinned_post_id=?', p.user_id, id);
    return { deleted: true, note: p.event_id ? 'tombstone_published' : 'local_only' };
  }

  pinPost(user, id, on = true) {
    const p = this.db.get('SELECT id, user_id, group_id, parent_id, parent_event, deleted_at FROM posts WHERE id=?', id);
    if (!p || p.deleted_at) throw new HttpError(404, 'E_NOT_FOUND', 'Post not found');
    if (p.user_id !== user.id) throw new HttpError(403, 'E_FORBIDDEN', 'You can only pin your own posts');
    if (p.group_id || p.parent_id || p.parent_event) throw new HttpError(400, 'E_INVALID', 'Only top-level profile posts can be pinned');
    this.db.run('UPDATE users SET pinned_post_id=? WHERE id=?', on ? id : null, user.id);
    return { pinned: !!on, pinned_post_id: on ? id : null };
  }

  react(user, id, type, on) {
    const p = this.db.get('SELECT id,user_id,event_id,visibility FROM posts WHERE id=? AND deleted_at IS NULL', id);
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
    if (want && !cur) {
      this.db.run('INSERT INTO reactions(post_id,user_id,type) VALUES(?,?,?)', id, user.id, String(type || 'like').slice(0, 20));
      if (p.user_id !== user.id) this.ledger.mat.notify(p.user_id, 'like', user.id, id, 'local_like_' + id + '_' + user.id, Date.now(), true);
    }
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
    const v = this.visible(viewer);
    out.counts = {
      followers: a ? this.db.get('SELECT COUNT(*) c FROM follows WHERE followee=?', a).c : 0,
      following: a ? this.db.get('SELECT COUNT(*) c FROM follows WHERE follower=?', a).c : 0,
      posts: this.db.get(`SELECT COUNT(*) c FROM posts p JOIN users u ON u.id=p.user_id WHERE p.user_id=? AND p.group_id IS NULL AND p.parent_id IS NULL AND p.parent_event IS NULL AND p.deleted_at IS NULL AND ${v.sql}`, u.id, ...v.params).c,
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

  // ---------- mentions & search & discovery ----------
  mentions(viewer, q = '', limit = 8) {
    const clean = String(q || '').replace(/^@+/, '').trim().slice(0, 30);
    const lim = Math.min(20, Math.max(1, Number(limit) || 8));
    const acct = viewer ? (viewer.account_id || '') : '';
    if (!clean) {
      return this.db.all(
        `SELECT u.*, EXISTS(SELECT 1 FROM follows f WHERE f.follower=? AND f.followee=u.account_id) AS is_followed
         FROM users u
         WHERE u.status IN ('local','remote') AND u.id <> ?
         ORDER BY is_followed DESC, (u.status='local') DESC, u.id ASC LIMIT ?`,
        acct, viewer ? viewer.id : 0, lim
      ).map((u) => this.userOut(u));
    }
    return this.db.all(
      `SELECT u.*, EXISTS(SELECT 1 FROM follows f WHERE f.follower=? AND f.followee=u.account_id) AS is_followed
       FROM users u
       WHERE u.status IN ('local','remote') AND (u.username LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')
       ORDER BY is_followed DESC, (u.username LIKE ? ESCAPE '\\') DESC, (u.status='local') DESC, u.username ASC LIMIT ?`,
      acct, likeEsc(clean), likeEsc(clean), clean.replace(/[\\%_]/g, (c) => '\\' + c) + '%', lim
    ).map((u) => this.userOut(u));
  }
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
    const items = rows.filter((r) => !blocked.has(r.account_id)).map((r) => {
      let post_preview = null;
      const post_id = r.post_id;
      if (post_id) {
        try {
          const pr = this.db.get('SELECT content FROM posts WHERE id=? AND deleted_at IS NULL', post_id);
          if (pr && pr.content) post_preview = String(pr.content).replace(/\s+/g, ' ').trim().slice(0, 120);
        } catch { /* ignore */ }
      }
      return {
        id: r.id, type: r.type, post_id, created_at: toIso(r.created_at), read: !!r.read_at,
        post_preview,
        actor: { id: r.actor_user_id, username: r.username, display_name: r.display_name, account_id: r.account_id, avatar_url: r.avatar_media ? `/media/${r.avatar_media}` : null },
      };
    });
    return { items, next_cursor: more ? String(rows[rows.length - 1].id) : null, unread: this.db.get('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_at IS NULL', user.id).c };
  }
}
module.exports = { Social, enc, dec, toIso, POST_SELECT, POST_FROM };
