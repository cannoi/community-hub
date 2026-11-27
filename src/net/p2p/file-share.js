'use strict';
/**
 * Secured Peer-to-Peer File Sharing service.
 * - Metadata stored encrypted-at-rest in `meta` (`p2p_file:<id>`)
 * - Signed with author's Ed25519 identity key (`p2p-file-v1`)
 * - Integrity checked against stored SHA-256 hash prior to transfer
 * - Supports optional scrypt-salted passcode lock, expiration, download cap,
 *   recipient-only restriction, and group-scoped sharing
 */
const crypto = require('crypto');
const fs = require('fs');
const { HttpError } = require('../../util');
const { isAccountId, verify } = require('../../keystore');

const PREFIX = 'p2p_file:';

function hashPasscode(passcode) {
  const pw = String(passcode || '');
  if (!pw) return null;
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64url');
  return { salt, hash };
}

function verifyPasscode(passcode, record) {
  if (!record || !record.hash || !record.salt) return true;
  const pw = String(passcode || '');
  if (!pw) return false;
  try {
    const a = Buffer.from(record.hash, 'base64url');
    const b = crypto.scryptSync(pw, record.salt, 32, { N: 16384, r: 8, p: 1 });
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function fileSha256(absPath) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(absPath, 'r');
  const buf = Buffer.allocUnsafe(65536);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

class P2PFileShareService {
  constructor(hub) {
    this.hub = hub;
    this.db = hub.db;
    this.ks = hub.ks;
    this.media = hub.media;
    this.store = hub.sensitive;
  }

  _signPayload(rec) {
    return `${rec.id}|${rec.media_hash}|${rec.size}|${rec.visibility}|${rec.expires_at || 0}|${rec.created_at}`;
  }

  _verifySig(rec) {
    if (!rec || !rec.owner_pub || !rec.signature) return false;
    return verify(rec.owner_pub, 'p2p-file-v1', this._signPayload(rec), rec.signature);
  }

  _isMember(groupId, userId) {
    if (!groupId || !userId) return false;
    return !!this.db.get('SELECT 1 x FROM group_members WHERE group_id=? AND user_id=?', Number(groupId), Number(userId));
  }

  _canAccess(user, rec) {
    if (!user || !rec) return false;
    if (rec.owner_id === user.id || (user.account_id && rec.owner_account === user.account_id)) return true;
    if (rec.visibility === 'public') return true;
    if (rec.visibility === 'group') return this._isMember(rec.group_id, user.id);
    if (rec.visibility === 'recipient') return !!user.account_id && rec.recipient_account === user.account_id;
    return false;
  }

  _sanitize(rec, user) {
    const expired = !!(rec.expires_at && Date.now() > rec.expires_at);
    const maxed = !!(rec.max_downloads && rec.downloads >= rec.max_downloads);
    const m = this.media.meta(rec.media_hash);
    const available = !!(m && this.media.exists(rec.media_hash));
    const groupRow = rec.group_id ? this.db.get('SELECT id, name FROM groups WHERE id=?', rec.group_id) : null;
    return {
      id: rec.id,
      name: rec.name,
      mime: rec.mime,
      kind: (m && m.kind) || (rec.mime || '').split('/')[0] || 'document',
      size: rec.size,
      sha256: rec.sha256,
      visibility: rec.visibility,
      group_id: rec.group_id || null,
      group_name: groupRow ? groupRow.name : null,
      recipient_account: rec.recipient_account || null,
      owner_account: rec.owner_account,
      owner_username: rec.owner_username,
      note: rec.note || '',
      has_passcode: !!rec.passcode_hash,
      expires_at: rec.expires_at ? new Date(rec.expires_at).toISOString() : null,
      expired,
      max_downloads: rec.max_downloads || null,
      downloads: rec.downloads || 0,
      limit_reached: maxed,
      sig_valid: this._verifySig(rec),
      available,
      is_owner: !!(user && (rec.owner_id === user.id || (user.account_id && rec.owner_account === user.account_id))),
      created_at: new Date(rec.created_at).toISOString(),
    };
  }

  create(user, body = {}) {
    if (!user || !user.account_id || !this.ks.has(user.account_id)) {
      throw new HttpError(403, 'E_NO_KEY', 'Signing key required');
    }
    const hash = String(body.media_hash || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(400, 'E_INVALID', 'Valid media_hash is required');
    const owned = this.media.assertOwned([hash], user.id)[0];
    const vis = ['public', 'group', 'recipient'].includes(body.visibility) ? body.visibility : 'public';

    let groupId = null;
    if (vis === 'group') {
      groupId = Number(body.group_id);
      if (!Number.isSafeInteger(groupId) || groupId < 1 || !this._isMember(groupId, user.id)) {
        throw new HttpError(403, 'E_NOT_MEMBER', 'Join the target group first');
      }
    }

    let recipientAcct = null;
    if (vis === 'recipient') {
      let target = String(body.recipient || '').trim();
      if (!isAccountId(target)) {
        const u = this.db.get("SELECT account_id FROM users WHERE username=? COLLATE NOCASE AND status IN ('local','remote')", target.replace(/^@+/, ''));
        if (!u || !u.account_id) throw new HttpError(404, 'E_NOT_FOUND', 'Recipient not found');
        target = u.account_id;
      }
      recipientAcct = target;
    }

    const passcode = body.passcode ? String(body.passcode).slice(0, 128) : '';
    if (passcode && passcode.length < 4) throw new HttpError(400, 'E_INVALID', 'Passcode must be at least 4 characters');
    const expiresHours = body.expires_hours !== undefined && body.expires_hours !== null && body.expires_hours !== '' ? Number(body.expires_hours) : null;
    let expiresAt = null;
    if (expiresHours !== null) {
      if (!Number.isFinite(expiresHours) || expiresHours <= 0 || expiresHours > 24 * 365) {
        throw new HttpError(400, 'E_INVALID', 'Invalid expiration window');
      }
      expiresAt = Date.now() + Math.round(expiresHours * 3600000);
    }

    const maxDl = body.max_downloads !== undefined && body.max_downloads !== null && body.max_downloads !== '' ? Number(body.max_downloads) : null;
    let maxDownloads = null;
    if (maxDl !== null) {
      if (!Number.isSafeInteger(maxDl) || maxDl < 1 || maxDl > 10000) {
        throw new HttpError(400, 'E_INVALID', 'Invalid max_downloads');
      }
      maxDownloads = maxDl;
    }

    const id = crypto.randomBytes(9).toString('base64url');
    const createdAt = Date.now();
    const rec = {
      id,
      owner_id: user.id,
      owner_account: user.account_id,
      owner_username: user.username,
      owner_pub: this.ks.publicKey(user.account_id),
      media_hash: owned.hash,
      name: String(body.name || owned.name || 'file').replace(/[\r\n\0]/g, '').slice(0, 200),
      mime: owned.mime || 'application/octet-stream',
      size: owned.size,
      sha256: owned.hash,
      visibility: vis,
      group_id: groupId,
      recipient_account: recipientAcct,
      passcode_hash: passcode ? hashPasscode(passcode) : null,
      expires_at: expiresAt,
      max_downloads: maxDownloads,
      downloads: 0,
      note: String(body.note || '').replace(/[\0\r]/g, '').trim().slice(0, 300),
      created_at: createdAt,
    };
    rec.signature = this.ks.sign(user.account_id, 'p2p-file-v1', this._signPayload(rec));
    this.store.setJson(PREFIX + id, rec);
    return this._sanitize(rec, user);
  }

  _load(id) {
    const clean = String(id || '').trim();
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(clean)) return null;
    return this.store.getJson(PREFIX + clean, null);
  }

  list(user, { scope = 'all', group_id = null } = {}) {
    const rows = this.store.listPrefix(PREFIX);
    const items = [];
    for (const r of rows) {
      let rec;
      try { rec = JSON.parse(r.value); } catch { continue; }
      if (!rec || !rec.id) continue;
      if (!this._canAccess(user, rec)) continue;
      if (group_id && Number(rec.group_id) !== Number(group_id)) continue;
      const mine = rec.owner_id === user.id || (user.account_id && rec.owner_account === user.account_id);
      if (scope === 'mine' && !mine) continue;
      if (scope === 'shared' && mine) continue;
      items.push(this._sanitize(rec, user));
    }
    return items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  get(user, id) {
    const rec = this._load(id);
    if (!rec || !this._canAccess(user, rec)) throw new HttpError(404, 'E_NOT_FOUND', 'Shared file not found');
    return this._sanitize(rec, user);
  }

  prepareDownload(user, id, { passcode = '' } = {}) {
    const rec = this._load(id);
    if (!rec || !this._canAccess(user, rec)) throw new HttpError(404, 'E_NOT_FOUND', 'Shared file not found');
    if (rec.expires_at && Date.now() > rec.expires_at) throw new HttpError(410, 'E_EXPIRED', 'This share link has expired');
    if (rec.max_downloads && rec.downloads >= rec.max_downloads) throw new HttpError(410, 'E_LIMIT_REACHED', 'Download limit reached');
    if (!this._verifySig(rec)) throw new HttpError(403, 'E_BAD_SIG', 'Share signature verification failed');

    const isOwner = rec.owner_id === user.id || (user.account_id && rec.owner_account === user.account_id);
    if (rec.passcode_hash && !isOwner && !verifyPasscode(passcode, rec.passcode_hash)) {
      throw new HttpError(403, 'E_BAD_PASSCODE', 'Wrong passcode');
    }

    const m = this.media.meta(rec.media_hash);
    if (!m || !this.media.exists(rec.media_hash)) {
      throw new HttpError(404, 'E_MEDIA_UNAVAILABLE', 'File is not stored locally right now');
    }
    const absPath = this.media.pathFor(rec.media_hash);
    if (fileSha256(absPath) !== rec.media_hash) {
      throw new HttpError(500, 'E_CORRUPT', 'File integrity verification failed');
    }

    rec.downloads = (rec.downloads || 0) + 1;
    this.store.setJson(PREFIX + rec.id, rec);
    return { absPath, size: m.size, mime: m.mime, name: rec.name || m.name, sha256: rec.media_hash };
  }

  revoke(user, id) {
    const rec = this._load(id);
    if (!rec) throw new HttpError(404, 'E_NOT_FOUND', 'Shared file not found');
    const isOwner = rec.owner_id === user.id || (user.account_id && rec.owner_account === user.account_id);
    if (!isOwner && !user.is_primary) throw new HttpError(403, 'E_FORBIDDEN', 'Only the owner can revoke this share');
    this.store.del(PREFIX + rec.id);
    return { ok: true, revoked: true };
  }
}

module.exports = { P2PFileShareService };
