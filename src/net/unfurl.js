'use strict';
/**
 * SSRF-safe link metadata fetch for embed previews.
 * - http/https only; no credentials
 * - blocks private/link-local/metadata IPs (after DNS)
 * - timeout + size limits; does not follow more than 3 redirects
 */
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const { URL } = require('url');

const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|192\.168\.|192\.0\.0\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|224\.|240\.|255\.|172\.(1[6-9]|2\d|3[01])\.)/;
const TIMEOUT_MS = 3000;
const MAX_BYTES = 256 * 1024;

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    // IPv6: block loopback, link-local, unique-local
    const x = ip.toLowerCase();
    return x === '::1' || x.startsWith('fe80:') || x.startsWith('fc') || x.startsWith('fd') || x === '::';
  }
  return PRIVATE_V4.test(ip);
}

async function resolveSafe(hostname) {
  const addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addrs.length) throw Object.assign(new Error('dns'), { code: 'dns' });
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw Object.assign(new Error('private_address'), { code: 'private_address' });
  }
  return addrs[0].address;
}

function parseHtmlMeta(html) {
  const out = { title: '', description: '', image: '', site: '' };
  const get = (re) => {
    const m = html.match(re);
    return m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  };
  out.title = get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || get(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
    || get(/<title[^>]*>([^<]+)<\/title>/i);
  out.description = get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)
    || get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  out.image = get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || get(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  out.site = get(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  return out;
}

/** Known providers we allow as embed cards (no arbitrary iframe hosts). */
function detectProvider(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  const h = u.hostname.replace(/^www\./, '').toLowerCase();
  if (h === 'youtube.com' || h === 'm.youtube.com' || h === 'youtu.be') {
    let id = '';
    if (h === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else id = u.searchParams.get('v') || (u.pathname.startsWith('/embed/') ? u.pathname.split('/')[2] : '');
    if (/^[\w-]{6,20}$/.test(id)) return { provider: 'youtube', id, embedUrl: 'https://www.youtube-nocookie.com/embed/' + id, url: u.toString() };
  }
  if (h === 'tiktok.com' || h === 'www.tiktok.com' || h === 'vm.tiktok.com') {
    const m = u.pathname.match(/\/video\/(\d+)/);
    if (m) return { provider: 'tiktok', id: m[1], embedUrl: null, url: u.toString() };
    return { provider: 'tiktok', id: '', embedUrl: null, url: u.toString() };
  }
  if (h === 'vimeo.com' || h === 'player.vimeo.com') {
    const m = u.pathname.match(/\/(\d+)/);
    if (m) return { provider: 'vimeo', id: m[1], embedUrl: 'https://player.vimeo.com/video/' + m[1], url: u.toString() };
  }
  if (h === 'open.spotify.com') {
    return { provider: 'spotify', id: u.pathname, embedUrl: null, url: u.toString() };
  }
  return null;
}

function firstHttpUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return '';
  return m[0].replace(/[.,;:!?)]+$/, '');
}

async function fetchText(urlStr, redirects = 0) {
  if (redirects > 3) throw Object.assign(new Error('too_many_redirects'), { code: 'redirects' });
  const u = new URL(urlStr);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw Object.assign(new Error('bad_scheme'), { code: 'bad_scheme' });
  if (u.username || u.password) throw Object.assign(new Error('credentials'), { code: 'credentials' });
  const ip = await resolveSafe(u.hostname);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      servername: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'CommunityHub-Unfurl/2.2',
        Accept: 'text/html,application/xhtml+xml',
        Host: u.host,
      },
      timeout: TIMEOUT_MS,
      // Pin to resolved public IP to avoid DNS rebinding after check
      lookup: (hostname, opts, cb) => cb(null, ip, ip.includes(':') ? 6 : 4),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch {
          return reject(Object.assign(new Error('bad_redirect'), { code: 'redirects' }));
        }
        return fetchText(next, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(Object.assign(new Error('http_' + res.statusCode), { code: 'http' }));
      }
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > MAX_BYTES) { res.destroy(); reject(Object.assign(new Error('too_large'), { code: 'too_large' })); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(Object.assign(new Error('timeout'), { code: 'timeout' })); });
    req.on('error', reject);
    req.end();
  });
}

async function unfurl(urlStr) {
  const provider = detectProvider(urlStr);
  if (provider && (provider.provider === 'youtube' || provider.provider === 'vimeo')) {
    return {
      ok: true,
      url: provider.url,
      provider: provider.provider,
      id: provider.id,
      embedUrl: provider.embedUrl,
      title: provider.provider === 'youtube' ? 'YouTube' : 'Vimeo',
      description: '',
      image: provider.provider === 'youtube' && provider.id
        ? 'https://i.ytimg.com/vi/' + provider.id + '/hqdefault.jpg'
        : '',
    };
  }
  if (provider) {
    return { ok: true, url: provider.url, provider: provider.provider, id: provider.id, embedUrl: provider.embedUrl, title: provider.provider, description: '', image: '' };
  }
  // Generic Open Graph (SSRF-safe)
  const html = await fetchText(urlStr);
  const meta = parseHtmlMeta(html);
  return {
    ok: true,
    url: urlStr,
    provider: 'link',
    title: meta.title,
    description: meta.description,
    image: meta.image && /^https?:\/\//i.test(meta.image) ? meta.image.slice(0, 500) : '',
    site: meta.site,
  };
}

module.exports = { unfurl, detectProvider, firstHttpUrl, isPrivateIp };
