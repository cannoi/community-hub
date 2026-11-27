'use strict';
// End-to-End Encrypted Direct Messaging service:
//  - Confidentiality: X25519 ECDH + HKDF-SHA256 + AES-256-GCM
//  - Authenticity: Ed25519 signature over sender/recipient/msg_id/ciphertext
//  - Transport: Same-Hub direct delivery OR P2P /cannoi/msg/1.0.0 store-and-forward + HTTP /federation/v1/dm fallback
const crypto = require('crypto');
const { HttpError, sha256hex } = require('./util');
const { isAccountId, verify } = require('./keystore');
const { toIso } = require('./social');

const DM_ENVELOPE_TAG = '__hub_dm';

function decodeDmContent(raw) {
  const s = raw === null || raw === undefined ? '' : String(raw);
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (obj && obj[DM_ENVELOPE_TAG] === 1) {
        return {
          text: obj.text ? String(obj.text) : '',
          attachments: Array.isArray(obj.attachments) ? obj.attachments : [],
        };
      }
    } catch { /* normal text */ }
  }
  return { text: s, attachments: [] };
}

class DirectMessages {
  constructor(hub) {
    this.hub = hub;
    this.db = hub.db;
    this.ks = hub.ks;
    this.cfg = hub.cfg;
    this.bus = hub.bus;
    this.log = hub.log;
  }

  ensureUserDmKey(user) {
    if (!user || !user.account_id || !this.ks.has(user.account_id)) return null;
    try {
      const pub = this.ks.ensureEncKey(user.account_id);
      if (pub && user.dm_pub !== pub) {
        this.db.run('UPDATE users SET dm_pub=? WHERE id=?', pub, user.id);
        user.dm_pub = pub;
      }
      return pub;
    } catch {
      return null;
    }
  }

  _canDM(sender, targetAcct) {
    if (!sender || !sender.account_id) throw new HttpError(403, 'E_NO_KEY', 'Account key required');
    if (!isAccountId(targetAcct)) throw new HttpError(400, 'E_INVALID', 'Invalid account id');
    if (targetAcct === sender.account_id) throw new HttpError(400, 'E_INVALID', 'Cannot message yourself');
    if (this.db.get('SELECT 1 x FROM blocks WHERE user_id=? AND account_id=?', sender.id, targetAcct)) {
      throw new HttpError(403, 'E_BLOCKED', 'You blocked this account');
    }
  }

  _p2pPeerIdFor(peer, targetAcct) {
    // peer.pin holds a hub1_... account ID, NOT a libp2p Peer ID (12D3KooW... / Qm...).
    // Resolve a real P2P peer ID from p2p_peer_registry when available.
    try {
      const rows = this.db.all('SELECT peer_id, record FROM p2p_peer_registry WHERE expires_at > ? LIMIT 100', Date.now());
      const ep = peer && peer.endpoint ? String(peer.endpoint).replace(/\/+$/, '') : '';
      for (const r of rows) {
        if (!r || !r.peer_id || /^hub1_/.test(r.peer_id)) continue;
        try {
          const rec = JSON.parse(r.record || '{}');
          const recEp = rec.http_endpoint || rec.endpoint || '';
          if ((targetAcct && rec.account_id === targetAcct) ||
              (peer && peer.account_id && rec.account_id === peer.account_id) ||
              (ep && recEp && String(recEp).replace(/\/+$/, '') === ep)) {
            return r.peer_id;
          }
        } catch { /* ignore malformed row */ }
      }
    } catch { /* table optional */ }
    return null;
  }

  async _resolveRecipientKey(acct, { refresh = false } = {}) {
    const u = this.db.get('SELECT id, username, display_name, account_id, pubkey, dm_pub, status FROM users WHERE account_id=?', acct);
    if (u && u.status === 'local' && this.ks.has(u.account_id)) {
      const dmPub = this.ensureUserDmKey(u);
      return { user: u, dm_pub: dmPub, local: true };
    }
    if (u && u.dm_pub && !refresh) return { user: u, dm_pub: u.dm_pub, local: false };
    // Try remote lookup via direct peer, presence directory, or connected healthy peers
    const peers = this.hub.peers;
    let peer = peers && peers.byAccount ? peers.byAccount(acct) : null;
    if ((!peer || !peer.endpoint) && this.hub.remote && typeof this.hub.remote._resolvePeer === 'function') {
      try { peer = await this.hub.remote._resolvePeer(acct); } catch { /* ignore */ }
    }
    const candidates = [];
    const seenEp = new Set();
    const addCand = (p) => {
      if (!p || !p.endpoint || p.state === 'blocked' || seenEp.has(p.endpoint)) return;
      seenEp.add(p.endpoint);
      candidates.push(p);
    };
    addCand(peer);
    if (peers && typeof peers.list === 'function') {
      const allPeers = peers.list()
        .filter((p) => p && p.endpoint && p.state !== 'blocked' && p.last_ok)
        .sort((a, b) => (b.last_ok || 0) - (a.last_ok || 0))
        .slice(0, 5);
      for (const p of allPeers) addCand(p);
    }
    if (peers && peers.transport) {
      for (const cand of candidates) {
        try {
          const res = await peers.transport.request(cand.endpoint, { method: 'GET', path: '/federation/v1/dm-key/' + acct }, 16384);
          if (res.status === 200) {
            const j = JSON.parse(res.body.toString('utf8'));
            if (j && j.dm_pub) {
              if (u) {
                this.db.run('UPDATE users SET dm_pub=? WHERE id=?', j.dm_pub, u.id);
                u.dm_pub = j.dm_pub;
              }
              return { user: u || null, dm_pub: j.dm_pub, peer: cand, local: false };
            }
          }
        } catch { /* try next candidate */ }
      }
    }
    return { user: u || null, dm_pub: (u && u.dm_pub) || null, peer, local: false };
  }

  _grantDmMediaAccess(hashes, accounts) {
    if (!Array.isArray(hashes) || !hashes.length) return;
    for (const h of hashes) {
      if (!/^[0-9a-f]{64}$/.test(String(h))) continue;
      const key = 'dm_media:' + h;
      let existing = [];
      try {
        const raw = this.hub.sensitive ? this.hub.sensitive.getJson(key, []) : JSON.parse(this.db.get('SELECT value FROM meta WHERE key=?', key)?.value || '[]');
        if (Array.isArray(raw)) existing = raw;
      } catch { existing = []; }
      const merged = [...new Set([...existing, ...accounts.filter(Boolean)])];
      if (this.hub.sensitive) this.hub.sensitive.setJson(key, merged);
      else this.db.run('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)', key, JSON.stringify(merged));
    }
  }

  _hydrateAttachments(atts, viewer) {
    if (!Array.isArray(atts) || !atts.length) return [];
    return atts.map((a) => {
      if (!a || !a.hash) return null;
      const m = this.hub.media ? this.hub.media.meta(a.hash) : null;
      const signed = this.hub.social && this.hub.social._signedMediaUrl ? this.hub.social._signedMediaUrl(a.hash, viewer) : undefined;
      return {
        hash: a.hash,
        name: a.name || (m && m.name) || 'file',
        mime: a.mime || (m && m.mime) || 'application/octet-stream',
        size: Number(a.size || (m && m.size) || 0),
        kind: (m && m.kind) || a.kind || ((a.mime || '').split('/')[0]) || 'document',
        url: `/media/${a.hash}`,
        ...(signed ? { signed_url: signed } : {}),
        available: this.hub.media ? this.hub.media.exists(a.hash) : true,
      };
    }).filter(Boolean);
  }

  async send(sender, { recipient, content, attachments }) {
    const text = String(content || '').replace(/\0/g, '').trim();
    const attHashes = Array.isArray(attachments) ? attachments.slice(0, 4).map(String).filter((x) => /^[0-9a-f]{64}$/.test(x)) : [];
    const ownedAtts = attHashes.length && this.hub.media ? this.hub.media.assertOwned(attHashes, sender.id) : [];
    if (!text && !ownedAtts.length) throw new HttpError(400, 'E_EMPTY', 'Message cannot be empty');
    if (text.length > 4000) throw new HttpError(400, 'E_TOO_LONG', 'Message too long');

    let targetAcct = String(recipient || '').trim();
    if (!isAccountId(targetAcct)) {
      const byName = this.db.get("SELECT account_id FROM users WHERE username=? COLLATE NOCASE AND status IN ('local','remote')", targetAcct.replace(/^@+/, ''));
      if (!byName || !byName.account_id) throw new HttpError(404, 'E_NOT_FOUND', 'Recipient not found');
      targetAcct = byName.account_id;
    }

    this._canDM(sender, targetAcct);
    const senderEncPub = this.ensureUserDmKey(sender);
    if (!senderEncPub) throw new HttpError(403, 'E_NO_KEY', 'No encryption key for sender');

    const info = await this._resolveRecipientKey(targetAcct);
    const now = Date.now();
    const msgId = crypto.randomBytes(16).toString('hex');

    if (!info.dm_pub) {
      throw new HttpError(409, 'E_DM_NO_KEY', 'Recipient has not published an encryption key yet');
    }

    const attPayload = ownedAtts.map((m) => ({ hash: m.hash, name: m.name, mime: m.mime, size: m.size, kind: m.kind }));
    if (attPayload.length) {
      this._grantDmMediaAccess(attPayload.map((a) => a.hash), [sender.account_id, targetAcct]);
    }
    const storedPlaintext = attPayload.length ? JSON.stringify({ [DM_ENVELOPE_TAG]: 1, text, attachments: attPayload }) : text;

    const aad = `${sender.account_id}:${targetAcct}:${msgId}`;
    const box = this.ks.encryptDM(sender.account_id, info.dm_pub, storedPlaintext, aad);
    const cipherJson = JSON.stringify(box);
    const envelope = {
      v: 1,
      msg_id: msgId,
      sender_account: sender.account_id,
      sender_pub: this.ks.publicKey(sender.account_id),
      sender_username: sender.username,
      sender_display_name: sender.display_name || null,
      recipient_account: targetAcct,
      box,
      created_at: now,
    };
    const signStr = `${envelope.v}|${envelope.msg_id}|${envelope.sender_account}|${envelope.recipient_account}|${sha256hex(cipherJson)}|${envelope.created_at}`;
    envelope.sig = this.ks.sign(sender.account_id, 'dm-v1', signStr);

    let status = 'queued';
    if (info.local && info.user) {
      // Deliver locally using real X25519 decrypt check
      if (this.db.get('SELECT 1 x FROM blocks WHERE user_id=? AND account_id=?', info.user.id, sender.account_id)) {
        throw new HttpError(403, 'E_BLOCKED', 'Recipient is unavailable');
      }
      const plain = this.ks.decryptDM(info.user.account_id, senderEncPub, box, aad);
      this.db.run(
        `INSERT INTO direct_messages(user_id,peer_account_id,peer_username,peer_display_name,msg_id,direction,ciphertext,content,created_at,status,encrypted)
         VALUES(?,?,?,?,?,'in',?,?,?,?,1)`,
        info.user.id, sender.account_id, sender.username, sender.display_name || null, msgId, cipherJson, plain, now, 'delivered'
      );
      status = 'delivered';
      if (this.hub.emitToUser) {
        try { this.hub.emitToUser(info.user.id, 'dm', { from: sender.account_id, msg_id: msgId }); } catch { /* ignore */ }
      }
    } else {
      // Remote Hub delivery: try HTTPS peer + P2P LocalMessaging
      let delivered = false;
      const peers = this.hub.peers;
      let peer = info.peer || (peers && peers.byAccount ? peers.byAccount(targetAcct) : null);
      if ((!peer || !peer.endpoint) && this.hub.remote && typeof this.hub.remote._resolvePeer === 'function') {
        try { peer = await this.hub.remote._resolvePeer(targetAcct); } catch { /* ignore */ }
      }
      if (peer && peer.endpoint && peers && peers.call) {
        try {
          const r = await peers.call(peer, 'POST', '/federation/v1/dm', { body: { envelope } });
          if (r && r.delivered) { status = 'delivered'; delivered = true; }
          else if (r && r.ok) { status = 'sent'; delivered = true; }
        } catch { /* fallback to p2p outbox */ }
      }
      if (!delivered && this.hub.net && typeof this.hub.net.sendLocalMessage === 'function') {
        const p2pPeerId = this._p2pPeerIdFor(peer, targetAcct);
        if (p2pPeerId) {
          try {
            const res = await this.hub.net.sendLocalMessage(p2pPeerId, 'cannoi-dm-v1', envelope, { id: msgId });
            status = res && res.status === 'sent' ? 'delivered' : 'queued';
          } catch { /* keep queued */ }
        }
      }
    }

    const peerUser = info.user || this.db.get('SELECT username, display_name FROM users WHERE account_id=?', targetAcct);
    const ins = this.db.run(
      `INSERT INTO direct_messages(user_id,peer_account_id,peer_username,peer_display_name,msg_id,direction,ciphertext,content,created_at,read_at,status,encrypted)
       VALUES(?,?,?,?,?,'out',?,?,?,?,?,1)`,
      sender.id, targetAcct, peerUser ? peerUser.username : null, peerUser ? peerUser.display_name : null,
      msgId, cipherJson, storedPlaintext, now, now, status
    );

    this.bus.emit('local-publish');
    return {
      id: Number(ins.lastInsertRowid),
      msg_id: msgId,
      peer_account_id: targetAcct,
      direction: 'out',
      content: text,
      attachments: this._hydrateAttachments(attPayload, sender),
      created_at: toIso(now),
      status,
      encrypted: true,
    };
  }

  receiveEnvelope(envelope) {
    if (!envelope || envelope.v !== 1 || !isAccountId(envelope.sender_account) || !isAccountId(envelope.recipient_account)) {
      throw new HttpError(400, 'E_INVALID', 'Invalid DM envelope');
    }
    const { msg_id, sender_account, sender_pub, recipient_account, box, created_at, sig } = envelope;
    if (!msg_id || typeof msg_id !== 'string' || !box || !sender_pub || !sig) throw new HttpError(400, 'E_INVALID', 'Incomplete DM envelope');
    const cipherJson = JSON.stringify(box);
    const signStr = `${envelope.v}|${msg_id}|${sender_account}|${recipient_account}|${sha256hex(cipherJson)}|${created_at}`;
    if (!verify(sender_pub, 'dm-v1', signStr, sig)) throw new HttpError(403, 'E_BAD_SIG', 'Invalid DM signature');

    const rcpt = this.db.get("SELECT id, account_id, dm_pub FROM users WHERE account_id=? AND status='local'", recipient_account);
    if (!rcpt || !this.ks.has(rcpt.account_id)) throw new HttpError(404, 'E_NOT_FOUND', 'Recipient not on this Hub');
    if (this.db.get('SELECT 1 x FROM blocks WHERE user_id=? AND account_id=?', rcpt.id, sender_account)) {
      throw new HttpError(403, 'E_BLOCKED', 'Sender blocked');
    }

    const dup = this.db.get('SELECT id FROM direct_messages WHERE user_id=? AND msg_id=?', rcpt.id, msg_id);
    if (dup) return { ok: true, delivered: true, duplicate: true };

    const aad = `${sender_account}:${recipient_account}:${msg_id}`;
    const plain = this.ks.decryptDM(rcpt.account_id, box.spub, box, aad);
    const decoded = decodeDmContent(plain);
    if (decoded.attachments.length) {
      this._grantDmMediaAccess(decoded.attachments.map((a) => a.hash), [sender_account, recipient_account]);
    }
    this.db.run(
      `INSERT INTO direct_messages(user_id,peer_account_id,peer_username,peer_display_name,msg_id,direction,ciphertext,content,created_at,status,encrypted)
       VALUES(?,?,?,?,?,'in',?,?,?, 'delivered', 1)`,
      rcpt.id, sender_account, envelope.sender_username || null, envelope.sender_display_name || null,
      msg_id, cipherJson, plain, Number(created_at) || Date.now()
    );
    if (this.hub.emitToUser) {
      try { this.hub.emitToUser(rcpt.id, 'dm', { from: sender_account, msg_id }); } catch { /* ignore */ }
    }
    this.bus.emit('local-publish');
    return { ok: true, delivered: true };
  }

  threads(user) {
    this.ensureUserDmKey(user);
    const rows = this.db.all(
      `SELECT m.*, u.username AS known_username, u.display_name AS known_display_name, u.avatar_media, u.dm_pub,
         (SELECT COUNT(*) FROM direct_messages u2 WHERE u2.user_id=m.user_id AND u2.peer_account_id=m.peer_account_id AND u2.direction='in' AND u2.read_at IS NULL) AS unread
       FROM direct_messages m
       LEFT JOIN users u ON u.account_id=m.peer_account_id
       WHERE m.id IN (
         SELECT MAX(id) FROM direct_messages WHERE user_id=? GROUP BY peer_account_id
       )
       ORDER BY m.created_at DESC, m.id DESC`,
      user.id
    );
    const contacts = this.db.all(
      `SELECT id, account_id, username, display_name, avatar_media, dm_pub, status
       FROM users
       WHERE account_id IS NOT NULL AND id <> ? AND status IN ('local','remote')
       ORDER BY (status='local') DESC, (dm_pub IS NOT NULL) DESC, username ASC LIMIT 50`,
      user.id
    ).map((c) => ({
      account_id: c.account_id,
      username: c.username,
      display_name: c.display_name || null,
      avatar_url: c.avatar_media ? `/media/${c.avatar_media}` : null,
      has_key: !!(c.dm_pub || (c.status === 'local' && this.ks.has(c.account_id))),
      status: c.status,
    }));
    const threads = rows.map((r) => {
      const dec = decodeDmContent(r.content);
      const preview = dec.text || (dec.attachments.length ? ('📎 ' + (dec.attachments[0].name || 'file')) : '');
      return {
        peer_account_id: r.peer_account_id,
        username: r.known_username || r.peer_username || ('r_' + r.peer_account_id.slice(5, 13)),
        display_name: r.known_display_name || r.peer_display_name || null,
        avatar_url: r.avatar_media ? `/media/${r.avatar_media}` : null,
        last_message: preview,
        last_direction: r.direction,
        last_status: r.status,
        last_at: toIso(r.created_at),
        unread: r.unread || 0,
        encrypted: !!r.encrypted,
      };
    });
    const unreadTotal = rows.reduce((s, r) => s + (r.unread || 0), 0);
    return { threads, contacts, unread: unreadTotal };
  }

  async conversation(user, peerAccountOrHandle, limit = 80, opts = {}) {
    this.ensureUserDmKey(user);
    let targetAcct = String(peerAccountOrHandle || '').trim();
    let peerUser = null;
    if (isAccountId(targetAcct)) {
      peerUser = this.db.get('SELECT id, username, display_name, account_id, avatar_media, dm_pub, status FROM users WHERE account_id=?', targetAcct);
    } else {
      peerUser = this.db.get("SELECT id, username, display_name, account_id, avatar_media, dm_pub, status FROM users WHERE username=? COLLATE NOCASE AND status IN ('local','remote')", targetAcct.replace(/^@+/, ''));
      if (peerUser) targetAcct = peerUser.account_id;
    }
    if (!isAccountId(targetAcct)) throw new HttpError(404, 'E_NOT_FOUND', 'Conversation not found');
    let hasKey = !!(peerUser && (peerUser.dm_pub || (peerUser.status === 'local' && this.ks.has(targetAcct))));
    if (!hasKey || opts.refresh) {
      try {
        const keyInfo = await Promise.race([
          this._resolveRecipientKey(targetAcct, { refresh: !!opts.refresh }),
          new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
        ]);
        if (keyInfo && keyInfo.dm_pub) hasKey = true;
        if (keyInfo && keyInfo.user && !peerUser) peerUser = keyInfo.user;
      } catch { /* best effort key probe */ }
    }
    const now = Date.now();
    this.db.run("UPDATE direct_messages SET read_at=? WHERE user_id=? AND peer_account_id=? AND direction='in' AND read_at IS NULL", now, user.id, targetAcct);
    const msgs = this.db.all(
      'SELECT id, msg_id, direction, content, created_at, read_at, status, encrypted FROM direct_messages WHERE user_id=? AND peer_account_id=? ORDER BY id DESC LIMIT ?',
      user.id, targetAcct, Math.min(200, Math.max(10, Number(limit) || 80))
    ).reverse().map((m) => {
      const dec = decodeDmContent(m.content);
      return {
        id: m.id, msg_id: m.msg_id, direction: m.direction, content: dec.text,
        attachments: this._hydrateAttachments(dec.attachments, user),
        created_at: toIso(m.created_at), read: !!m.read_at, status: m.status, encrypted: !!m.encrypted,
      };
    });
    return {
      peer: {
        account_id: targetAcct,
        username: peerUser ? peerUser.username : ('r_' + targetAcct.slice(5, 13)),
        display_name: peerUser ? peerUser.display_name : null,
        avatar_url: peerUser && peerUser.avatar_media ? `/media/${peerUser.avatar_media}` : null,
        has_key: hasKey,
        status: peerUser ? peerUser.status : 'remote',
      },
      messages: msgs,
    };
  }
}

module.exports = { DirectMessages };
