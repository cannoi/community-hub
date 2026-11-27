'use strict';
function parsePublicIp(cfg = {}) {
  const direct = String(cfg.publicIp || process.env.PUBLIC_IP || process.env.HUB_PUBLIC_IP || '').trim();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(direct)) return direct;
  const url = String(cfg.publicUrl || process.env.HUB_PUBLIC_URL || process.env.PUBLIC_URL || '').trim();
  if (!url) return '';
  try {
    const h = new URL(url).hostname;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return h;
  } catch { /* ignore */ }
  return '';
}
function parseOwnPort(cfg = {}) {
  const p2p = cfg.p2p || {};
  const n = Number(p2p.publicPort || process.env.P2P_PUBLIC_PORT || process.env.HOST_PORT || 0);
  if (n > 0 && n <= 65535) return n;
  try {
    const u = new URL(String(cfg.publicUrl || process.env.HUB_PUBLIC_URL || ''));
    if (u.port) return Number(u.port);
  } catch { /* ignore */ }
  return 0;
}
function localHostCandidates() {
  const out = ['127.0.0.1'];
  const g = String(process.env.HOST_GATEWAY || process.env.SOLOHOST_HOST_IP || '').trim();
  if (g) out.push(g);
  out.push('host.docker.internal', '172.17.0.1');
  return out;
}
function localHttpCandidates(cfg, endpoint) {
  try {
    const u = new URL(String(endpoint));
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    const pubIp = parsePublicIp(cfg);
    const own = parseOwnPort(cfg);
    if (!pubIp || u.hostname !== pubIp) return [String(endpoint).replace(/\/$/, '')];
    if (own && port === own) return [String(endpoint).replace(/\/$/, '')];
    const list = localHostCandidates().map((h) => {
      const n = new URL(u.href); n.hostname = h; n.port = String(port);
      return n.toString().replace(/\/$/, '');
    });
    list.push(String(endpoint).replace(/\/$/, ''));
    return [...new Set(list)];
  } catch { return [String(endpoint)]; }
}
module.exports = { parsePublicIp, parseOwnPort, localHostCandidates, localHttpCandidates };
