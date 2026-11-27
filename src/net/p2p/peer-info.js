'use strict';
/**
 * Normalize peer discovery records from libp2p / mDNS / DHT.
 * @libp2p/mdns 11.x may deliver Multiaddr objects, strings, or {id, multiaddrs}.
 * Never call addr.getPeerId() without checking — that throws TypeError on strings.
 */

function peerIdString(id) {
  if (id == null) return null;
  if (typeof id === 'string') return id.length >= 8 && id.length <= 128 ? id : null;
  try {
    if (typeof id.toString === 'function') {
      const s = String(id.toString());
      if (s && s !== '[object Object]' && s.length >= 8 && s.length <= 128) return s;
    }
  } catch { /* ignore */ }
  return null;
}

/** Extract peer id from a multiaddr string or Multiaddr-like object. */
function peerIdFromAddr(addr) {
  if (addr == null) return null;
  // Multiaddr object with getPeerId (older API)
  if (typeof addr === 'object' && typeof addr.getPeerId === 'function') {
    try {
      const id = addr.getPeerId();
      return peerIdString(id);
    } catch { /* fall through */ }
  }
  const s = typeof addr === 'string' ? addr : (typeof addr.toString === 'function' ? String(addr.toString()) : '');
  if (!s) return null;
  const m = /\/p2p\/([^/]+)/.exec(s);
  return m ? peerIdString(m[1]) : null;
}

function multiaddrString(addr) {
  if (addr == null) return null;
  if (typeof addr === 'string') return addr.startsWith('/') ? addr : null;
  try {
    if (typeof addr.toString === 'function') {
      const s = String(addr.toString());
      return s.startsWith('/') ? s : null;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Normalize evt.detail from peer:discovery into { id, multiaddrs: string[] } or null.
 * Accepts:
 *  - { id, multiaddrs }
 *  - PeerId-like alone
 *  - { id: PeerId, multiaddrs: Multiaddr[] }
 */
function normalizeDiscoveryDetail(detail) {
  if (!detail) return null;
  let id = peerIdString(detail.id) || peerIdString(detail.peerId) || peerIdString(detail.peer_id);
  const rawAddrs = detail.multiaddrs || detail.addrs || detail.addresses || [];
  const list = Array.isArray(rawAddrs) ? rawAddrs : [];
  const multiaddrs = [];
  for (const a of list.slice(0, 16)) {
    const s = multiaddrString(a);
    if (s) multiaddrs.push(s);
    if (!id) id = peerIdFromAddr(a) || peerIdFromAddr(s);
  }
  if (!id && typeof detail === 'string') id = peerIdString(detail);
  if (!id) return null;
  return { id, multiaddrs };
}

module.exports = {
  peerIdString,
  peerIdFromAddr,
  multiaddrString,
  normalizeDiscoveryDetail,
};
