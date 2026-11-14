'use strict';
// UI toolkit: safe DOM builder (no innerHTML), API client, toasts, modals, menus, media viewer.
(function () {
  const SVGNS = 'http://www.w3.org/2000/svg';

  /** Create an element. Text is always inserted as text nodes, so untrusted content cannot become markup. */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    const add = (c) => { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c instanceof Node ? c : document.createTextNode(String(c))); };
    kids.forEach(add);
    return el;
  }
  function icon(name, cls) {
    const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('class', 'ic' + (cls ? ' ' + cls : '')); s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    const u = document.createElementNS(SVGNS, 'use'); u.setAttribute('href', '#i-' + name); s.appendChild(u); return s;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  // ---------- API ----------
  class ApiError extends Error { constructor(status, code, msg, data) { super(msg || code); this.status = status; this.code = code; this.data = data; } }
  const net = { csrf: null, online: navigator.onLine !== false, onAuthLost: null, listeners: new Set(), sessionToken: null };
  function setOnline(v) { if (net.online !== v) { net.online = v; net.listeners.forEach((f) => f(v)); } }
  // Session token fallback when HttpOnly cookie is dropped (Pi Browser / some WebViews)
  try { net.sessionToken = sessionStorage.getItem('hub.session') || null; } catch (_) { net.sessionToken = null; }
  function setSessionToken(tok) {
    net.sessionToken = tok || null;
    try {
      if (tok) sessionStorage.setItem('hub.session', tok);
      else sessionStorage.removeItem('hub.session');
    } catch (_) { /* private mode */ }
  }
  function clearSessionClient() {
    net.csrf = null;
    setSessionToken(null);
  }
  window.addEventListener('online', () => setOnline(true)); window.addEventListener('offline', () => setOnline(false));
  async function apiRaw(method, path, body, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (net.sessionToken) headers['X-Hub-Session'] = net.sessionToken;
    if (net.csrf && method !== 'GET') { headers['X-CSRF-Token'] = net.csrf; net.lastWrite = Date.now(); }
    let payload;
    if (opts.form) payload = opts.form;
    else if (opts.raw || (typeof Blob !== 'undefined' && body instanceof Blob) || (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer)) {
      payload = body;
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/octet-stream';
    } else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, { method, headers, body: payload, credentials: 'include' }); } catch (e) { setOnline(false); throw new ApiError(0, 'E_NETWORK', 'network'); }
    setOnline(true);
    const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (data && data.csrf) net.csrf = data.csrf;
    if (data && data.session) setSessionToken(data.session);
    if (!res.ok) {
      if (res.status === 401 && !opts.quiet401 && net.onAuthLost) {
        // Debounced: let the page decide after re-checking session (avoid bounce on first miss)
        try { net.onAuthLost(); } catch (_) {}
      }
      throw new ApiError(res.status, (data && data.code) || 'E_HTTP', (data && data.error) || '', data);
    }
    return { data, headers: res.headers };
  }
  const api = async (m, p, b, o) => (await apiRaw(m, p, b, o)).data;
  const errText = (e) => (e && e.code ? I18n.err(e.code) : I18n.err('generic'));

  // ---------- feedback ----------
  function toast(msg, isErr) {
    const root = document.getElementById('toasts');
    const el = h('div', { class: 'toast' + (isErr ? ' err' : ''), role: isErr ? 'alert' : 'status' }, msg);
    root.appendChild(el); setTimeout(() => el.remove(), isErr ? 6000 : 3200);
  }
  function modal(title, body, opts = {}) {
    const root = document.getElementById('modal-root'); const prev = document.activeElement;
    const close = () => { bg.remove(); document.removeEventListener('keydown', onKey, true); if (prev && prev.focus) prev.focus(); if (opts.onClose) opts.onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, title ? h('h2', { text: title }) : null, body);
    const bg = h('div', { class: 'modal-bg', onClick: (e) => { if (e.target === bg) close(); } }, box);
    root.appendChild(bg); document.addEventListener('keydown', onKey, true);
    const f = box.querySelector('textarea,input,select,button'); if (f) f.focus();
    return { close, box };
  }
  function confirmDialog(message, okLabel, danger) {
    return new Promise((resolve) => {
      let m; let settled = false; const fin = (v) => { if (!settled) { settled = true; resolve(v); } };
      m = modal('', h('div', { class: 'col' }, h('p', { text: message }), h('div', { class: 'row' }, h('span', { class: 'grow' }),
        h('button', { class: 'btn', onClick: () => { m.close(); fin(false); } }, t('cancel')),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onClick: () => { m.close(); fin(true); } }, okLabel))), { onClose: () => fin(false) });
    });
  }
  function menu(anchor, items) {
    document.querySelectorAll('.menu').forEach((x) => x.remove());
    const r = anchor.getBoundingClientRect();
    const m = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => h('button', { role: 'menuitem', class: it.danger ? 'dng' : '', onClick: () => { m.remove(); it.onClick(); } }, icon(it.icon || 'more', 'sm'), it.label)));
    document.body.appendChild(m);
    const w = m.offsetWidth; m.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right + window.scrollX - w)) + 'px'; m.style.top = (r.bottom + window.scrollY + 4) + 'px';
    const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('click', off, true); document.removeEventListener('keydown', esc, true); } };
    const esc = (e) => { if (e.key === 'Escape') { m.remove(); document.removeEventListener('click', off, true); document.removeEventListener('keydown', esc, true); anchor.focus(); } };
    setTimeout(() => { document.addEventListener('click', off, true); document.addEventListener('keydown', esc, true); }, 0);
    const first = m.querySelector('button'); if (first) first.focus();
  }

  // ---------- formatting ----------
  function timeAgo(iso) {
    if (!iso) return '';
    const d = new Date(iso); const s = (Date.now() - d.getTime()) / 1000;
    if (!isFinite(s)) return '';
    if (s < 45) return t('time.justNow');
    const rtf = new Intl.RelativeTimeFormat(I18n.lang, { numeric: 'auto', style: 'short' });
    if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
    if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
    if (s < 7 * 86400) return rtf.format(-Math.round(s / 86400), 'day');
    return d.toLocaleDateString(I18n.lang, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  const shortId = (id) => (id ? id.slice(0, 10) + '…' + id.slice(-6) : '');
  function hue(str) { let x = 0; for (let i = 0; i < str.length; i++) x = (x * 31 + str.charCodeAt(i)) >>> 0; return x % 360; }
  const nameOf = (u) => (u && (u.display_name || u.username)) || '?';
  function avatar(u, size) {
    const n = nameOf(u); const el = h('span', { class: 'avatar' + (size ? ' ' + size : ''), 'aria-hidden': 'true' });
    if (u && u.avatar_url) { const img = h('img', { src: u.avatar_url, alt: '', loading: 'lazy', decoding: 'async' }); img.addEventListener('error', () => { img.remove(); el.textContent = n.slice(0, 1).toUpperCase(); }); el.appendChild(img); }
    else el.textContent = n.slice(0, 1).toUpperCase();
    el.style.background = 'hsl(' + hue((u && (u.account_id || u.username)) || n) + ' 55% 42%)';
    return el;
  }

  /** Text → nodes. Only http(s) URLs become links; #tags link to in-app search. */

  /** Safe embed card for known providers only (no arbitrary iframes). */
  function detectEmbed(text) {
    const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
    if (!m) return null;
    let url = m[0].replace(/[.,;:!?)]+$/, '');
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    const h = u.hostname.replace(/^www\./, '').toLowerCase();
    if (h === 'youtube.com' || h === 'm.youtube.com' || h === 'youtu.be') {
      let id = h === 'youtu.be' ? u.pathname.slice(1).split('/')[0] : (u.searchParams.get('v') || '');
      if (!id && u.pathname.startsWith('/embed/')) id = u.pathname.split('/')[2] || '';
      if (/^[\w-]{6,20}$/.test(id)) return { provider: 'youtube', id, url, embed: 'https://www.youtube-nocookie.com/embed/' + id };
    }
    if (h === 'vimeo.com' || h === 'player.vimeo.com') {
      const mm = u.pathname.match(/\/(\d{6,12})/);
      if (mm) return { provider: 'vimeo', id: mm[1], url, embed: 'https://player.vimeo.com/video/' + mm[1] };
    }
    if (h === 'tiktok.com' || h.endsWith('.tiktok.com')) {
      return { provider: 'tiktok', id: '', url, embed: null };
    }
    return { provider: 'link', id: '', url, embed: null };
  }
  function embedCard(text) {
    const info = detectEmbed(text);
    if (!info) return null;
    const loadLabel = (window.I18n && I18n.t) ? I18n.t('embed.load', { p: info.provider }) : ('Load from ' + info.provider);
    if (info.embed) {
      const box = h('div', { class: 'embed card embed-click' });
      const btn = h('button', {
        type: 'button', class: 'btn embed-load',
        onClick: () => {
          clear(box);
          box.append(h('iframe', {
            src: info.embed,
            title: info.provider + ' embed',
            loading: 'lazy',
            referrerpolicy: 'strict-origin-when-cross-origin',
            allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
            allowfullscreen: true,
            class: 'embed-frame',
            sandbox: 'allow-scripts allow-same-origin allow-popups allow-presentation',
          }));
          box.append(h('a', { class: 'small', href: info.url, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, info.url));
        },
      }, '▶ ' + loadLabel);
      box.append(
        h('div', { class: 'embed-placeholder' },
          h('span', { class: 'badge' }, info.provider),
          h('p', { class: 'small muted', text: (window.I18n && I18n.t) ? I18n.t('embed.privacy') : 'Content loads only after you press play.' }),
          btn
        ),
        h('a', { class: 'small', href: info.url, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, info.url)
      );
      return box;
    }
    // Link / TikTok: optional unfurl only after user asks
    const box = h('div', { class: 'embed card link-preview' });
    const previewBtn = h('button', {
      type: 'button', class: 'btn sm',
      onClick: () => {
        if (!(window.HubApp && window.HubApp.S && window.HubApp.S.user)) return;
        previewBtn.disabled = true;
        api('GET', '/api/unfurl?url=' + encodeURIComponent(info.url)).then((r) => {
          if (!box.isConnected || !r) return;
          clear(box);
          if (r.title) box.append(h('b', { text: r.title }));
          if (r.description) box.append(h('p', { class: 'small muted', text: r.description }));
          if (r.image && /^https?:\/\//i.test(r.image)) {
            box.append(h('img', { src: r.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', class: 'unfurl-img' }));
          }
          box.append(h('a', { class: 'small', href: info.url, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, info.url));
        }).catch(() => { previewBtn.disabled = false; });
      },
    }, (window.I18n && I18n.t) ? I18n.t('embed.preview') : 'Preview');
    box.append(h('a', { href: info.url, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, info.url), previewBtn);
    return box;
  }



  /** Local-only user behavior + language preference (explore ranking, translate). */
  const Behavior = (() => {
    const KEY = 'hub_behavior_v1';
    function load() {
      try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
    }
    function save(d) {
      try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* quota */ }
    }
    function detectLang(text) {
      const s = String(text || '');
      if (/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s)) return 'vi';
      if (/[\u3040-\u30ff]/.test(s)) return 'ja';
      if (/[\uac00-\ud7af]/.test(s)) return 'ko';
      if (/[\u4e00-\u9fff]/.test(s)) return 'zh';
      if (/[äöüß]/i.test(s)) return 'de';
      if (/[àâæçéèêëïîôùûüÿœ]/i.test(s) && !/[àáạảã]/.test(s)) return 'fr';
      return 'en';
    }
    function recordOwnPost(content) {
      const d = load();
      d.own_langs = d.own_langs || {};
      const L = detectLang(content);
      d.own_langs[L] = (d.own_langs[L] || 0) + 1;
      d.own_posts = (d.own_posts || 0) + 1;
      save(d);
    }
    function userLang() {
      const d = load();
      const map = d.own_langs || {};
      let best = null, n = 0;
      for (const [k, v] of Object.entries(map)) if (v > n) { n = v; best = k; }
      if (best) return best;
      try { return (window.I18n && I18n.lang) || 'en'; } catch { return 'en'; }
    }
    function track(event, post) {
      if (!post || !post.id) return;
      const d = load();
      d.posts = d.posts || {};
      const id = String(post.id);
      const e = d.posts[id] || { v: 0, like: 0, open: 0, author: null, tags: [], lang: 'en', last: 0 };
      if (event === 'view') e.v++;
      if (event === 'like') e.like++;
      if (event === 'open') e.open++;
      e.author = (post.author && (post.author.account_id || post.author.username)) || e.author;
      e.lang = detectLang(post.content) || e.lang;
      e.tags = Array.isArray(post.tags) ? post.tags.slice(0, 8) : e.tags;
      e.last = Date.now();
      d.posts[id] = e;
      // author affinity
      if (e.author) {
        d.authors = d.authors || {};
        d.authors[e.author] = (d.authors[e.author] || 0) + (event === 'like' ? 3 : event === 'open' ? 2 : 1);
      }
      // tag affinity
      d.tags = d.tags || {};
      (e.tags || []).forEach((tg) => { d.tags[tg] = (d.tags[tg] || 0) + 1; });
      // prune to last 500 posts
      const ids = Object.keys(d.posts);
      if (ids.length > 500) {
        ids.sort((a, b) => (d.posts[a].last || 0) - (d.posts[b].last || 0));
        ids.slice(0, ids.length - 500).forEach((x) => delete d.posts[x]);
      }
      save(d);
    }
    /** Offline ranking score for explore (higher = earlier). */
    function scorePost(post) {
      const d = load();
      const id = String(post.id);
      const e = (d.posts && d.posts[id]) || {};
      const author = post.author && (post.author.account_id || post.author.username);
      let s = 0;
      // recency (ms -> hours, decay)
      const ageH = Math.max(0, (Date.now() - new Date(post.created_at).getTime()) / 3600000);
      s += Math.max(0, 48 - ageH) * 2;
      // engagement already known locally
      s += (e.v || 0) * 1 + (e.open || 0) * 4 + (e.like || 0) * 6;
      // author affinity
      if (author && d.authors && d.authors[author]) s += Math.min(40, d.authors[author] * 2);
      // tag affinity
      const tags = post.tags || [];
      tags.forEach((tg) => { if (d.tags && d.tags[tg]) s += Math.min(15, d.tags[tg]); });
      // language match with user history
      const ul = userLang();
      const pl = detectLang(post.content);
      if (pl === ul) s += 12;
      else s -= 4;
      // slight boost for media
      if (post.media && post.media.length) s += 3;
      return s;
    }
    function rankPosts(items) {
      return (items || []).slice().sort((a, b) => scorePost(b) - scorePost(a));
    }
    return { load, save, detectLang, recordOwnPost, userLang, track, scorePost, rankPosts };
  })();

  /** Hide public IPs in peer endpoints — show stable machine code instead. */
  function machineCode(peer) {
    if (!peer) return '—';
    if (peer.account_id && /^hub1_/.test(peer.account_id)) {
      const a = peer.account_id.slice(5);
      return 'hub1_' + a.slice(0, 4) + '…' + a.slice(-4);
    }
    const ep = String(peer.endpoint || peer.name || '');
    let h = 0;
    for (let i = 0; i < ep.length; i++) h = ((h << 5) - h + ep.charCodeAt(i)) | 0;
    const code = Math.abs(h).toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
    return 'mc_' + code;
  }
  function maskPublicEndpoint(url) {
    const s = String(url || '');
    if (!s) return '';
    // Replace any IPv4 with bullets; keep scheme/host names that are not IPs shortened
    return s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '•••.•••.•••.•••');
  }
  function peerErrorText(code) {
    const c = String(code || '');
    const key = 'net.err.' + c;
    const translated = t(key);
    if (translated && translated !== key) return translated;
    return c;
  }

  function linkify(text) {
    const frag = document.createDocumentFragment();
    const re = /(https?:\/\/[^\s<>"']+)|(#[\p{L}\p{N}_]{1,50})/gu; let last = 0; let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      if (m[1]) {
        let url = m[1]; let tail = ''; const t2 = /[.,;:!?)\]]+$/.exec(url); if (t2) { tail = t2[0]; url = url.slice(0, -tail.length); }
        let ok = false; try { const u = new URL(url); ok = u.protocol === 'http:' || u.protocol === 'https:'; } catch (e) { ok = false; }
        if (ok) { frag.append(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }, url)); frag.append(tail); } else frag.append(m[1]);
      } else frag.append(h('a', { class: 'tag', href: '#/search/' + encodeURIComponent(m[2]) }, m[2]));
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  // ---------- media ----------
  function lightbox(images, start) {
    let i = start; const img = h('img', { alt: '' }); const cap = h('div', { class: 'small', style: null });
    const dl = h('a', { class: 'iconbtn', download: '', 'aria-label': t('media.download') }, icon('download'));
    const render = () => { img.src = images[i].url; img.alt = images[i].name || ''; dl.href = images[i].url + '?download=1'; cap.textContent = (i + 1) + ' / ' + images.length; };
    const prev = h('button', { class: 'iconbtn', 'aria-label': t('media.prev'), onClick: () => { i = (i - 1 + images.length) % images.length; render(); } }, icon('left'));
    const next = h('button', { class: 'iconbtn', 'aria-label': t('media.next'), onClick: () => { i = (i + 1) % images.length; render(); } }, icon('right'));
    const bg = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('media.open') });
    const close = () => { bg.remove(); document.removeEventListener('keydown', key, true); };
    const key = (e) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') prev.click(); else if (e.key === 'ArrowRight') next.click(); };
    bg.append(h('div', { class: 'row' }, images.length > 1 ? prev : null, img, images.length > 1 ? next : null), h('div', { class: 'row' }, h('span', { class: 'muted' }, cap), dl, h('button', { class: 'iconbtn', 'aria-label': t('close'), onClick: close }, icon('x'))));
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    document.body.appendChild(bg); document.addEventListener('keydown', key, true); render(); next.focus();
  }
  function videoBox(m) {
    const box = h('div', { class: 'mediabox' });
    const build = () => {
      clear(box);
      const v = h('video', { controls: true, preload: 'metadata', playsinline: true, 'aria-label': m.name || '' });
      const fail = (unsupported) => { clear(box); box.append(h('div', { class: 'mediaerr' }, icon('info', 'sm'), unsupported ? t('media.unsupported') : t('media.failed'), h('button', { class: 'btn sm', onClick: build }, icon('refresh', 'sm'), t('retry')), h('a', { class: 'btn sm', href: m.url + '?download=1', download: '' }, icon('download', 'sm'), t('media.download')))); };
      if (m.mime && !v.canPlayType(m.mime)) return fail(true);
      v.addEventListener('error', () => fail(v.error && v.error.code === 4 && m.available !== false));
      v.src = m.url; box.append(v);
    };
    build(); return box;
  }
  function audioList(items) {
    const box = h('div', { class: 'mediabox' }); const els = [];
    items.forEach((m, idx) => {
      const a = h('audio', { controls: true, preload: 'none', src: m.url, 'aria-label': m.name || '' });
      a.addEventListener('ended', () => { if (els[idx + 1]) els[idx + 1].play().catch(() => {}); }); // simple playlist
      a.addEventListener('error', () => { const e = h('div', { class: 'mediaerr' }, icon('info', 'sm'), t('media.failed'), h('button', { class: 'btn sm', onClick: () => { a.load(); e.remove(); } }, t('retry'))); a.after(e); });
      els.push(a); box.append(h('div', { class: 'small muted', text: m.name || '' }), a);
    });
    return box;
  }
  function mediaView(items) {
    const out = document.createDocumentFragment(); if (!items || !items.length) return out;
    const imgs = items.filter((m) => m.kind === 'image');
    if (imgs.length) {
      const g = h('div', { class: 'media-grid n' + Math.min(4, imgs.length) });
      imgs.forEach((m, i) => { const im = h('img', { src: m.url, alt: m.name || '', loading: 'lazy', decoding: 'async', tabindex: '0', role: 'button', 'aria-label': t('media.open') + ': ' + (m.name || '') }); const open = (e) => { e.stopPropagation(); lightbox(imgs, i); }; im.addEventListener('click', open); im.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e); } }); g.append(im); });
      out.append(g);
    }
    items.filter((m) => m.kind === 'video').forEach((m) => out.append(videoBox(m)));
    const au = items.filter((m) => m.kind === 'audio'); if (au.length) out.append(audioList(au));
    items.filter((m) => m.kind === 'document').forEach((m) => out.append(h('a', { class: 'filechip', href: m.url + '?download=1', download: '' }, icon('file'), h('span', { class: 'grow' }, m.name || 'file'), h('span', { class: 'small muted' }, formatBytes(m.size)), icon('download', 'sm'))));
    return out;
  }
  function formatBytes(n) { if (!n && n !== 0) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; }

  window.UI = { h, icon, clear, api, apiRaw, ApiError, net, setSessionToken, clearSessionClient, errText, toast, modal, confirmDialog, menu, timeAgo, shortId, avatar, nameOf, linkify, mediaView, lightbox, formatBytes, embedCard, detectEmbed, machineCode, maskPublicEndpoint, peerErrorText, Behavior };
})();
