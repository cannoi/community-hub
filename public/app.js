'use strict';
// Community Hub web UI — part 1: state, shell, router, shared components.
(function () {
  const { h, icon, clear, api, apiRaw, toast, modal, confirmDialog, menu, timeAgo, avatar, nameOf, linkify, mediaView, errText, shortId, net, setSessionToken, clearSessionClient, embedCard, machineCode, maskPublicEndpoint, peerErrorText, Behavior } = UI;
  const S = { session: null, user: null, features: {}, sync: null, unread: 0, token: 0, stream: null, banner: null, timers: [] };
  const $app = document.getElementById('app');
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const go = (hash) => { if (location.hash === hash) HubApp.route(); else location.hash = hash; };
  const copy = async (text, msg) => { try { await navigator.clipboard.writeText(text); toast(msg || t('copied')); } catch (e) { toast(text); } };
  const fail = (e) => toast(errText(e), true);
  const live = (tok) => tok === S.token;
  const boot = (x) => window.HubApp.boot(x);
  const route = () => window.HubApp.route();
  const VIS_ICON = { public: 'globe', followers: 'users', group: 'lock' };

  // ---------- auth screens ----------
  function authFrame(title, ...kids) {
    clear($app); $app.append(h('main', { class: 'auth', id: 'main', tabindex: '-1' }, h('div', { class: 'row' }, icon('users', 'lg'), h('h1', { text: t('app') })), h('div', { class: 'row small muted' }, langSwitch()), h('h2', { text: title }), ...kids));
  }
  function langSwitch() {
    return h('div', { class: 'row', role: 'group', 'aria-label': t('settings.language') }, ['en', 'vi'].map((l) => h('button', { class: 'btn sm' + (I18n.lang === l ? ' primary' : ''), 'aria-pressed': String(I18n.lang === l), onClick: () => { I18n.set(l); HubApp.boot(true); } }, l === 'en' ? 'English' : 'Tiếng Việt')));
  }
  const field = (id, label, attrs) => [h('label', { for: id }, label), h('input', { id, ...attrs })];
  function renderSetup() {
    const s = S.session; const err = h('p', { class: 'badge bad hidden', role: 'alert' }); let importData = null;
    const legacy = s.legacy_users || [];
    const claim = legacy.length ? h('select', { id: 'su-claim' }, h('option', { value: '' }, t('auth.claimNone')), legacy.map((u) => h('option', { value: u.id }, u.username))) : null;
    const impBox = h('div', { class: 'col hidden' }, h('label', { for: 'su-file' }, t('auth.importFile')), h('input', { id: 'su-file', type: 'file', accept: 'application/json,.json', onChange: (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { importData = JSON.parse(String(r.result)); } catch (x) { importData = null; err.textContent = t('err.E_KEY_IMPORT'); err.classList.remove('hidden'); } }; r.readAsText(f); } }), ...field('su-ipass', t('auth.importPass'), { type: 'password', autocomplete: 'off' }));
    const form = h('form', { class: 'card', onSubmit: async (e) => {
      e.preventDefault(); err.classList.add('hidden');
      const body = { username: v('su-user'), password: v('su-pass'), display_name: v('su-name') || undefined };
      if (claim && claim.value) body.claim_legacy_user_id = Number(claim.value);
      if (s.setup_token_required) body.setup_token = v('su-token');
      if (!impBox.classList.contains('hidden') && importData) body.import = { blob: importData, passphrase: v('su-ipass') };
      try {
        const r = await api('POST', '/api/setup', body, { quiet401: true });
        toast(t('auth.created', { id: shortId(r.account_id) }));
        if (r && r.csrf) net.csrf = r.csrf;
        if (r && r.session) setSessionToken(r.session);
        if (r && r.user) {
          S.user = r.user;
          S.session = Object.assign({}, S.session || {}, { user: r.user, csrf: r.csrf, setup_required: false, network_setup_required: false });
        }
        await HubApp.boot(true);
      } catch (x) { err.textContent = errText(x); err.classList.remove('hidden'); }
    } },
      h('p', { class: 'badge', text: t('auth.step1') }),
      h('p', { class: 'muted', text: t('auth.setupIntro') }),
      ...field('su-user', t('auth.username'), { type: 'text', autocomplete: 'username', required: true, minlength: '3', maxlength: '30' }),
      ...field('su-name', t('auth.displayName') + ' (' + t('optional') + ')', { type: 'text', maxlength: '50' }),
      ...field('su-pass', t('auth.password'), { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' }),
      h('p', { class: 'small muted', text: t('auth.passwordHint') }),
      claim ? [h('label', { for: 'su-claim' }, t('auth.claim')), claim, h('p', { class: 'small muted', text: t('auth.claimHelp') })] : null,
      s.setup_token_required ? field('su-token', t('auth.setupToken'), { type: 'password', required: true, autocomplete: 'off' }) : null,
      h('details', {}, h('summary', { onClick: () => impBox.classList.toggle('hidden') }, t('auth.importKey')), impBox),
      err, h('p', {}, h('button', { class: 'btn primary', type: 'submit' }, t('auth.create'))));
    authFrame(t('auth.setupTitle'), form);
  }

  /** Step 2 — independent network connect screen (after account exists). Default is a hidden seed label only. */
  function renderNetworkConnect() {
    const err = h('p', { class: 'badge bad hidden', role: 'alert' });
    const intro = h('input', { id: 'nc-intro', type: 'text', value: 'default', placeholder: t('auth.introHubPlaceholder'), autocomplete: 'off' });
    const hubPass = h('input', { id: 'nc-hubpass', type: 'password', placeholder: t('auth.hubPassPlaceholder'), autocomplete: 'off' });
    const form = h('form', { class: 'card', onSubmit: async (e) => {
      e.preventDefault(); err.classList.add('hidden');
      try {
        const payload = {
          intro_peer: String(intro.value || '').trim(),
          network_setup_done: true,
        };
        if (hubPass.value) payload.intro_hub_password = hubPass.value;
        await api('POST', '/api/network/settings', payload);
        toast(t('auth.networkConnected'));
        HubApp.boot();
      } catch (x) { err.textContent = errText(x); err.classList.remove('hidden'); }
    } },
      h('p', { class: 'badge', text: t('auth.step2') }),
      h('p', { class: 'muted', text: t('auth.connectHubIntro') }),
      h('label', { for: 'nc-intro' }, t('auth.introHub')),
      intro,
      h('p', { class: 'small muted', text: t('auth.introHubHelp') }),
      h('label', { for: 'nc-hubpass' }, t('auth.hubPass')),
      hubPass,
      h('p', { class: 'small muted', text: t('auth.hubPassHelp') }),
      err,
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn primary', type: 'submit' }, icon('globe', 'sm'), t('auth.connectNow')),
        h('button', { class: 'btn', type: 'button', onClick: async () => {
          try {
            await api('POST', '/api/network/settings', { intro_peer: '', skip_network: true, network_setup_done: true });
            HubApp.boot();
          } catch (x) { err.textContent = errText(x); err.classList.remove('hidden'); }
        } }, t('auth.skipNetwork'))
      )
    );
    authFrame(t('auth.connectHubTitle'), form);
  }

  const v = (id) => document.getElementById(id).value;
  function renderLogin(mode) {
    // Login gate inspired by Personal AI Hub (works on Pi Browser): centered card, minimal fields.
    const reg = mode === 'register';
    const hint = (S.session && S.session.login) || {};
    const passwordOnly = !reg && hint.mode === 'password' && hint.username;
    const err = h('p', { class: 'badge bad hidden', role: 'alert', id: 'login-error' });
    const kids = [];
    if (passwordOnly) {
      kids.push(h('p', { class: 'small muted center', text: t('auth.loginAs', { name: hint.display_name || hint.username }) }));
      kids.push(h('input', { type: 'hidden', id: 'li-user', value: hint.username }));
    } else {
      kids.push(...field('li-user', t('auth.username'), {
        type: 'text', autocomplete: 'username', required: true, maxlength: '30',
        value: hint.username || '',
      }));
    }
    kids.push(...field('li-pass', passwordOnly ? t('auth.loginHint') : t('auth.password'), {
      type: 'password',
      autocomplete: reg ? 'new-password' : 'current-password',
      required: true,
      id: 'li-pass',
    }));
    kids.push(err);
    kids.push(h('button', { class: 'btn primary', type: 'submit', style: 'width:100%;margin-top:8px' },
      icon('lock', 'sm'), reg ? t('auth.register') : t('auth.login')));
    if (S.session.registration_allowed) {
      kids.push(h('p', { class: 'center small' }, h('button', {
        class: 'btn sm', type: 'button',
        onClick: () => renderLogin(reg ? 'login' : 'register'),
      }, reg ? t('auth.haveAccount') : t('auth.noAccount'))));
    }
    if (passwordOnly) {
      kids.push(h('p', { class: 'center' }, h('button', {
        class: 'btn sm', type: 'button',
        onClick: () => {
          // Allow switching to full username form if needed
          S.session.login = { mode: 'username_password' };
          renderLogin('login');
        },
      }, t('auth.useOtherAccount'))));
    }
    const form = h('form', {
      class: 'card login-gate-card',
      onSubmit: async (e) => {
        e.preventDefault();
        err.classList.add('hidden');
        const username = passwordOnly ? hint.username : v('li-user');
        const password = v('li-pass');
        try {
          let result;
          if (reg) result = await api('POST', '/api/register', { username, password }, { quiet401: true });
          else result = await api('POST', '/api/login', passwordOnly ? { password } : { username, password }, { quiet401: true });
          // Apply session from response immediately (PAI-style). Do not depend only on cookie
          // being visible on the very next request — some Pi Browser / WebView cases lag.
          if (result && result.csrf) net.csrf = result.csrf;
          if (result && result.session) setSessionToken(result.session);
          if (result && result.user) {
            S.user = result.user;
            S.session = Object.assign({}, S.session || {}, {
              user: result.user,
              csrf: result.csrf || (S.session && S.session.csrf),
              setup_required: false,
              network_setup_required: false,
            });
          }
          await HubApp.boot(true);
        } catch (x) {
          err.textContent = errText(x);
          err.classList.remove('hidden');
        }
      },
    }, ...kids);
    authFrame(reg ? t('auth.register') : t('auth.loginTitle'), form);
    // Focus password on Pi Browser / mobile for fewer taps
    setTimeout(() => { const el = document.getElementById('li-pass'); if (el) el.focus(); }, 50);
  }

  // ---------- shell ----------
  const NAV = [
    ['home', 'home', 'nav.home', 'all'], ['explore', 'search', 'nav.explore', 'all'], ['notifications', 'bell', 'nav.notifications', 'all'], ['groups', 'users', 'nav.groups', 'all'],
    ['bookmarks', 'bookmark', 'nav.bookmarks', 'desk'], ['messages', 'mail', 'nav.messages', 'desk'], ['network', 'globe', 'nav.network', 'desk'], ['assistant', 'bot', 'nav.assistant', 'desk'], ['u/' + 'me', 'user', 'nav.profile', 'desk'], ['settings', 'settings', 'nav.settings', 'desk'],
  ];
  function renderShell() {
    clear($app);
    const me = S.user;
    const items = NAV.map(([r, ic, key, where]) => {
      const href = r === 'u/me' ? '#/u/' + encodeURIComponent(me.username) : '#/' + r;
      return h('a', { class: 'navitem ' + (where === 'desk' ? 'desk' : ''), href, 'data-r': r, 'aria-label': t(key), title: t(key) }, icon(ic), h('span', { class: 'lbl' }, t(key)), r === 'notifications' ? h('span', { class: 'dot hidden', id: 'notif-dot' }) : null);
    });
    const more = h('button', { class: 'navitem mobile-only', 'aria-label': t('nav.more'), onClick: openMore }, icon('menu'), h('span', { class: 'lbl' }, t('nav.more')));
    const nav = h('nav', { class: 'nav', 'aria-label': 'Main' }, h('a', { class: 'brand desk', href: '#/home', 'aria-label': t('app') }, icon('users', 'lg')), items, more,
      h('button', { class: 'btn primary composebtn', onClick: () => composeModal({}) }, icon('edit', 'sm'), t('composer.post')),
      h('div', { class: 'navfoot' }, h('div', { class: 'row' }, avatar(me, 'sm'), h('div', { class: 'grow small' }, h('b', { text: nameOf(me) }), h('div', { class: 'muted', text: '@' + me.username })), h('button', { class: 'iconbtn', 'aria-label': t('auth.logout'), title: t('auth.logout'), onClick: logout }, icon('logout')))));
    const side = h('aside', { class: 'side', 'aria-label': 'Search' }, searchBox(), h('div', { id: 'side-sync', class: 'card' }), h('div', { id: 'side-trends', class: 'card' }));
    $app.append(h('div', { class: 'shell' }, nav, h('main', { class: 'main', id: 'main', tabindex: '-1' }, h('div', { id: 'banner' }), h('div', { id: 'view' })), side));
    updateSyncChip(); loadTrends(); updateDot();
  }
  function openMore() {
    const mk = (r, ic, key) => h('a', { class: 'btn', style: null, href: r, onClick: () => m.close() }, icon(ic, 'sm'), t(key));
    const m = modal(t('nav.more'), h('div', { class: 'col' }, mk('#/bookmarks', 'bookmark', 'nav.bookmarks'), mk('#/messages', 'mail', 'nav.messages'), mk('#/network', 'globe', 'nav.network'), mk('#/assistant', 'bot', 'nav.assistant'), mk('#/u/' + encodeURIComponent(S.user.username), 'user', 'nav.profile'), mk('#/settings', 'settings', 'nav.settings'), h('button', { class: 'btn danger', onClick: () => { m.close(); logout(); } }, icon('logout', 'sm'), t('auth.logout'))));
  }
  function searchBox(value) {
    const input = h('input', { type: 'search', placeholder: t('search.placeholder'), 'aria-label': t('search.placeholder'), maxlength: '64', value: value || '' });
    return h('form', { class: 'searchbox', role: 'search', onSubmit: (e) => { e.preventDefault(); const q = input.value.trim(); if (q) go('#/search/' + encodeURIComponent(q)); } }, icon('search', 'sm'), input);
  }
  async function logout() { stopBackground(); S.user = null; try { await api('POST', '/api/logout', {}, { quiet401: true }); } catch (e) { /* ignore */ } clearSessionClient(); HubApp.boot(); }
  function updateDot() { const d = document.getElementById('notif-dot'); if (!d) return; d.textContent = S.unread > 99 ? '99+' : String(S.unread); d.classList.toggle('hidden', !S.unread); }
  async function refreshUnread() { try { const r = await api('GET', '/api/notifications?limit=1', undefined, { quiet401: true }); S.unread = r.unread; updateDot(); } catch (e) { /* ignore */ } }
  async function loadTrends() {
    const box = document.getElementById('side-trends'); if (!box) return;
    try { const r = await api('GET', '/api/trends'); clear(box); box.append(h('b', { text: t('trends') })); if (!r.tags.length) box.append(h('p', { class: 'small muted', text: t('explore.empty') })); box.append(h('div', { class: 'chips' }, r.tags.map((x) => h('button', { onClick: () => go('#/search/' + encodeURIComponent('#' + x.tag)) }, '#' + x.tag + ' · ' + x.n)))); } catch (e) { /* ignore */ }
  }
  async function refreshSync() {
    try { S.sync = await api('GET', '/api/sync/status', undefined, { quiet401: true }); } catch (e) { return; }
    updateSyncChip();
  }
  function syncSummary() {
    const s = S.sync; if (!s) return null;
    if (!s.enabled || !s.total) return { icon: 'globe', text: t('net.ready'), cls: '' };
    return { icon: 'globe', text: t('net.summary', { h: s.healthy, t: s.total }), cls: s.healthy === s.total ? 'ok' : (s.healthy ? 'warn' : 'bad') };
  }
  function updateSyncChip() {
    const box = document.getElementById('side-sync'); const x = syncSummary(); if (!box || !x) return;
    clear(box).append(h('a', { class: 'row', href: '#/network' }, icon(x.icon, 'sm'), h('span', { class: 'badge ' + x.cls, text: x.text })));
  }
  function stopBackground() { S.timers.forEach(clearInterval); S.timers = []; if (S.stream) { S.stream.close(); S.stream = null; } }
  function startBackground() {
    stopBackground();
    S.timers.push(setInterval(refreshSync, 30000), setInterval(flushOutbox, 20000), setInterval(refreshUnread, 60000));
    try {
      S.stream = new EventSource('/api/stream');
      S.stream.addEventListener('update', () => { refreshUnread(); refreshSync(); onActivity(); });
    } catch (e) { /* SSE unsupported: polling still works */ }
  }
  function onActivity(own) { if (S.onActivity && (own || Date.now() - (net.lastWrite || 0) > 4000)) S.onActivity(); } // our own writes refresh the view directly
  net.listeners.add((on) => { const b = document.getElementById('banner'); if (!b) return; clear(b); if (!on) b.append(h('div', { class: 'banner warn', role: 'status' }, icon('wifi', 'sm'), t('status.offline'))); else { toast(t('status.back')); flushOutbox(); } });

  // ---------- outbox (offline-first composition) ----------
  const obKey = () => 'hub.outbox.' + (S.user ? S.user.id : 0);
  const obLoad = () => { try { return JSON.parse(localStorage.getItem(obKey()) || '[]'); } catch (e) { return []; } };
  const obSave = (l) => { try { localStorage.setItem(obKey(), JSON.stringify(l.slice(-30))); } catch (e) { /* storage full/unavailable */ } window.dispatchEvent(new Event('hub-outbox')); };
  function enqueue(body) { const l = obLoad(); l.push({ body, state: 'waiting', at: Date.now() }); obSave(l); }
  let flushing = false;
  async function flushOutbox() {
    if (flushing || !S.user) return; flushing = true;
    try {
      for (const item of obLoad()) {
        if (item.state === 'failed') continue;
        try { await api('POST', '/api/posts', item.body); obSave(obLoad().filter((x) => x.body.client_id !== item.body.client_id)); onActivity(); }
        catch (e) { if (e.code === 'E_NETWORK' || e.status >= 500 || e.status === 429) break; const l = obLoad(); const it = l.find((x) => x.body.client_id === item.body.client_id); if (it) { it.state = 'failed'; it.error = errText(e); obSave(l); } }
      }
    } finally { flushing = false; }
  }
  function outboxView() {
    const box = h('div', {}); let mounted = false;
    const draw = () => {
      if (box.isConnected) mounted = true; else if (mounted) { window.removeEventListener('hub-outbox', draw); return; }
      clear(box);
      for (const it of obLoad()) {
        box.append(h('div', { class: 'post pending' }, avatar(S.user), h('div', { class: 'pbody' }, h('div', { class: 'small' }, icon(it.state === 'failed' ? 'info' : 'refresh', 'sm'), ' ', it.state === 'failed' ? it.error : t('composer.pending')), h('div', { class: 'ptext', text: it.body.content }),
          h('div', { class: 'row' }, h('button', { class: 'btn sm', onClick: () => { const l = obLoad(); const x = l.find((y) => y.body.client_id === it.body.client_id); if (x) x.state = 'waiting'; obSave(l); flushOutbox(); } }, t('composer.sendNow')), h('button', { class: 'btn sm', onClick: () => obSave(obLoad().filter((y) => y.body.client_id !== it.body.client_id)) }, t('composer.discard'))))));
      }
    };
    draw(); window.addEventListener('hub-outbox', draw);
    box.cleanup = () => window.removeEventListener('hub-outbox', draw);
    return box;
  }

  // ---------- composer ----------
  function composer(o = {}) {
    const max = (S.features.max_post_chars || 2000); const files = []; let busy = false;
    const ta = h('textarea', { placeholder: o.placeholder || t('composer.placeholder'), 'aria-label': o.placeholder || t('composer.placeholder'), maxlength: String(max + 200), rows: o.compact ? '2' : '3' });
    const counter = h('span', { class: 'counter' });
    const chips = h('div', { class: 'attach' });
    const sugg = h('div', { class: 'small hidden' });
    const fileIn = h('input', { type: 'file', class: 'hidden', multiple: true, accept: 'image/*,video/mp4,video/webm,video/quicktime,audio/*,application/pdf,.txt,.md,.csv,.json,.zip,.docx,.xlsx,.pptx', onChange: async (e) => { for (const f of [...e.target.files].slice(0, 4 - files.length)) await upload(f); e.target.value = ''; } });
    const vis = o.noVisibility ? null : h('select', { 'aria-label': t('composer.visibility'), title: t('composer.visibility') }, h('option', { value: 'public' }, t('vis.public')), h('option', { value: 'followers' }, t('vis.followers')));
    const btn = h('button', { class: 'btn primary', onClick: submit }, o.replyTo ? t('composer.reply') : t('composer.post'));
    const hint = h('span', { class: 'small muted' });
    const upd = () => { const n = ta.value.length; counter.textContent = n ? n + '/' + max : ''; counter.classList.toggle('over', n > max); btn.disabled = busy || n > max || (!ta.value.trim() && !files.length && !o.allowEmpty); if (vis) hint.textContent = vis.value === 'public' ? '' : t('vis.localOnly'); };
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(300, ta.scrollHeight) + 'px'; upd(); });
    if (vis) vis.addEventListener('change', upd);
    function drawChips() { clear(chips); files.forEach((f, i) => chips.append(h('span', { class: 'chip' }, icon(f.kind === 'image' ? 'image' : 'clip', 'sm'), f.name, h('button', { class: 'iconbtn', 'aria-label': t('close'), onClick: () => { files.splice(i, 1); drawChips(); upd(); } }, icon('x', 'sm'))))); }
    async function upload(file) {
      if (!net.online) return toast(t('composer.noMediaOffline'), true);
      busy = true; upd();
      const sp = h('span', { class: 'chip' }, t('composer.uploading'));
      chips.append(sp);
      try {
        let m;
        const CHUNK = 5 * 1024 * 1024;
        if (file.size > CHUNK) {
          const sess = await api('POST', '/api/media/sessions', { filename: file.name, size: file.size });
          const id = sess.id;
          const total = sess.totalChunks || Math.ceil(file.size / CHUNK);
          for (let i = 0; i < total; i++) {
            const start = i * CHUNK;
            const end = Math.min(file.size, start + CHUNK);
            const blob = file.slice(start, end);
            sp.textContent = t('composer.uploading') + ' ' + Math.round((end / file.size) * 100) + '%';
            await apiRaw('PUT', '/api/media/sessions/' + id + '/chunk/' + i, blob, { headers: { 'Content-Type': 'application/octet-stream' } });
          }
          m = await api('POST', '/api/media/sessions/' + id + '/complete', {});
        } else {
          const form = new FormData(); form.append('file', file);
          m = await api('POST', '/api/media', undefined, { form });
        }
        files.push(m);
      } catch (e) { fail(e); } finally { sp.remove(); busy = false; drawChips(); upd(); }
    }
    async function assist(mode) {
      if (!ta.value.trim()) return;
      sugg.classList.remove('hidden');
      sugg.textContent = t('assist.working');
      try {
        const r = await api('POST', '/api/assistant/compose', { text: ta.value, mode });
        clear(sugg).append(h('div', { class: 'card' },
          h('div', { class: 'ptext', text: r.result }),
          h('button', { class: 'btn sm', onClick: () => {
            ta.value = mode === 'hashtags' ? (ta.value.trim() + '\n' + r.result) : r.result;
            ta.dispatchEvent(new Event('input'));
            sugg.classList.add('hidden');
          } }, t('assist.apply'))
        ));
      } catch (e) { sugg.textContent = errText(e); }
    }
    async function submit() {
      const body = { content: ta.value.trim(), client_id: uuid() };
      if (files.length) body.media = files.map((f) => f.hash);
      if (o.groupId) body.group_id = o.groupId; else if (vis) body.visibility = vis.value;
      if (o.replyTo) body.reply_to = o.replyTo; if (o.quoteOf) body.quote_of = o.quoteOf;
      busy = true; upd();
      try {
        const r = await api('POST', '/api/posts', body);
        ta.value = ''; files.length = 0; drawChips(); ta.style.height = 'auto'; toast(t('composer.posted'));
        try { if (Behavior) Behavior.recordOwnPost(body.content); } catch (_) {}
        if (o.onPosted) o.onPosted(r.post || r.comment);
      } catch (e) {
        if (e.code === 'E_NETWORK' && !files.length && !o.replyTo && !o.quoteOf) { enqueue(body); ta.value = ''; toast(t('composer.queued')); } else fail(e);
      } finally { busy = false; upd(); }
    }
    const tools = h('div', { class: 'row wrap' },
      h('button', { class: 'iconbtn', 'aria-label': t('composer.attach'), title: t('composer.attach'), onClick: () => fileIn.click() }, icon('image')),
      vis,
      h('button', { class: 'iconbtn', title: t('assist.improve'), 'aria-label': t('assist.improve'), onClick: () => assist('improve') }, icon('sparkle')),
      h('button', { class: 'btn sm', onClick: () => assist('hashtags') }, t('assist.hashtags')),
      h('span', { class: 'grow' }), hint, counter, btn);
    upd();
    return h('div', { class: 'composer' }, avatar(S.user), h('div', { class: 'grow' }, ta, chips, sugg, fileIn, tools));
  }
  function composeModal(o) {
    let m; const ref = o.refPost ? h('div', { class: 'ref' }, h('b', { text: nameOf(o.refPost.author) }), h('div', { class: 'ptext', text: o.refPost.content })) : null;
    const c = composer({ ...o, placeholder: o.replyTo ? t('composer.replyPlaceholder') : o.quoteOf ? t('composer.quotePlaceholder') : undefined, noVisibility: !!(o.replyTo || o.quoteOf || o.groupId), allowEmpty: false, onPosted: (p) => { m.close(); if (o.onPosted) o.onPosted(p); else onActivity(); } });
    m = modal('', h('div', {}, ref, c));
  }

  // ---------- post card ----------
  function postCard(p, o = {}) {
    if (p.kind === 'repost' && p.ref && !p.ref.missing && !p.deleted) {
      const inner = postCard(p.ref, { ...o, via: p });
      return inner;
    }
    const card = h('article', { class: 'post' + (o.noNav ? '' : ' clickable'), 'data-id': p.id });
    const redraw = async () => { try { const np = await api('GET', '/api/posts/' + p.id); card.replaceWith(postCard(np, o)); } catch (e) { card.remove(); } };
    if (p.deleted) { card.append(avatar(p.author), h('div', { class: 'pbody' }, h('div', { class: 'tomb', text: t('post.deleted') }))); return card; }
    const mine = S.user && p.user_id === S.user.id;
    const a = p.author || {}; const handle = a.account_id || a.username;
    const head = h('div', { class: 'phead' }, h('a', { class: 'pname', href: '#/u/' + encodeURIComponent(a.username) }, nameOf(a)), h('span', { class: 'muted small', text: '@' + a.username }), h('span', { class: 'muted small', text: '· ' + timeAgo(p.created_at) }),
      p.edited_at ? h('span', { class: 'muted small', text: '· ' + t('post.edited') }) : null,
      p.visibility !== 'public' ? h('span', { class: 'badge', title: t('vis.localOnly') }, icon(VIS_ICON[p.visibility] || 'lock', 'sm'), t('vis.' + p.visibility)) : null,
      p.origin === 'remote' ? h('span', { class: 'badge', title: t('profile.remote') }, icon('globe', 'sm')) : null);
    const body = h('div', { class: 'pbody' });
    if (o.via) body.append(h('div', { class: 'small muted row' }, icon('repeat', 'sm'), t('post.reposted', { name: nameOf(o.via.author) })));
    body.append(head);
    if (p.content) body.append(h('div', { class: 'ptext' }, linkify(p.content)));
    if (p.content) { const em = embedCard(p.content); if (em) body.append(em); }
    body.append(mediaView(p.media));
    if (p.kind === 'quote' && p.ref) body.append(refCard(p.ref));
    const v = p.viewer || {};
    const count = (n) => (n ? String(n) : '');
    const likeBtn = h('button', { class: 'iconbtn like' + (v.liked ? ' on' : ''), 'aria-pressed': String(!!v.liked), 'aria-label': t('post.like'), onClick: async (e) => {
      e.stopPropagation();
      try { const r = await api('POST', '/api/posts/' + p.id + '/react', {}); v.liked = r.reacted; p.counts.likes += r.reacted ? 1 : -1; likeBtn.classList.toggle('on', r.reacted); likeBtn.setAttribute('aria-pressed', String(r.reacted)); cnt.textContent = count(p.counts.likes); if (r.reacted && Behavior) Behavior.track('like', p); } catch (x) { fail(x); }
    } }, icon('heart'));
    const cnt = h('span', { class: 'small', text: count(p.counts.likes) }); likeBtn.append(cnt);
    const shareable = p.visibility === 'public' && p.event_id;
    const bmBtn = h('button', { class: 'iconbtn bm' + (v.bookmarked ? ' on' : ''), 'aria-pressed': String(!!v.bookmarked), 'aria-label': t('post.bookmark'), onClick: async (e) => { e.stopPropagation(); try { if (v.bookmarked) await api('DELETE', '/api/bookmarks/' + p.id); else await api('POST', '/api/bookmarks/' + p.id, {}); v.bookmarked = !v.bookmarked; bmBtn.classList.toggle('on', v.bookmarked); bmBtn.setAttribute('aria-pressed', String(v.bookmarked)); toast(v.bookmarked ? t('post.saved') : t('bookmarks.title')); if (!v.bookmarked && o.onUnbookmark) card.remove(); } catch (x) { fail(x); } } }, icon('bookmark'));
    // Translate only for others' posts whose language differs from the user's posting history
    let translateBtn = null;
    try {
      if (!mine && p.content && Behavior) {
        const ul = Behavior.userLang();
        const pl = Behavior.detectLang(p.content);
        if (pl && ul && pl !== ul) {
          translateBtn = h('button', { class: 'btn sm', type: 'button', 'aria-label': t('assist.translate'), onClick: async (e) => {
            e.stopPropagation();
            const slot = h('div', { class: 'card translate-result', text: t('assist.working') });
            body.append(slot);
            try {
              const r = await api('POST', '/api/assistant/compose', { text: p.content, mode: 'translate', target_lang: ul });
              clear(slot).append(
                h('div', { class: 'small muted', text: t('assist.translatedTo') + ' ' + String(ul).toUpperCase() }),
                h('div', { class: 'ptext', text: r.result || '' })
              );
            } catch (err) {
              // Offline fallback: simple note (no model)
              clear(slot).append(h('p', { class: 'small muted', text: errText(err) }));
            }
          } }, t('assist.translate') + ' → ' + String(Behavior.userLang()).toUpperCase());
        }
      }
    } catch (_) { /* Behavior optional */ }
    try { if (Behavior) Behavior.track('view', p); } catch (_) {}

    const actions = h('div', { class: 'actions' },
      h('button', { class: 'iconbtn', 'aria-label': t('post.reply'), onClick: (e) => { e.stopPropagation(); composeModal({ replyTo: p.id, refPost: p, onPosted: () => { if (o.onReplied) o.onReplied(); else redraw(); } }); } }, icon('comment'), h('span', { class: 'small', text: count(p.counts.replies) })),
      shareable ? h('button', { class: 'iconbtn' + (v.reposted ? ' on' : ''), 'aria-label': t('post.repost'), onClick: (e) => { e.stopPropagation(); menu(e.currentTarget, [
        { icon: 'repeat', label: v.reposted ? t('post.unrepost') : t('post.repost'), onClick: async () => { if (v.reposted) return; try { await api('POST', '/api/posts', { repost_of: p.id, client_id: uuid() }); toast(t('post.unrepost')); redraw(); } catch (x) { fail(x); } } },
        { icon: 'quote', label: t('post.quote'), onClick: () => composeModal({ quoteOf: p.id, refPost: p, onPosted: onActivity }) }]); } }, icon('repeat'), h('span', { class: 'small', text: count(p.counts.reposts + p.counts.quotes) })) : h('span'),
      likeBtn, bmBtn, translateBtn,
      // Copy-link removed: would expose host/IP of the Hub to clipboard/shares
      h('button', { class: 'iconbtn', 'aria-label': t('more'), 'aria-haspopup': 'menu', onClick: (e) => { e.stopPropagation(); menu(e.currentTarget, mine ? [
        p.kind !== 'repost' ? { icon: 'edit', label: t('post.edit'), onClick: () => editPost(p, redraw) } : null,
        { icon: 'trash', label: t('post.delete'), danger: true, onClick: async () => { if (await confirmDialog(p.event_id ? t('post.confirmDelete') : t('post.delete') + '?', t('post.delete'), true)) { try { const r = await api('DELETE', '/api/posts/' + p.id); toast(r.note === 'tombstone_published' ? t('post.deleteNote') : t('post.delete')); card.remove(); } catch (x) { fail(x); } } } }] : [
        { icon: 'flag', label: t('post.report'), onClick: async () => { try { await api('POST', '/api/reports', { post_id: p.id, reason: 'reported from UI' }); toast(t('post.reported')); } catch (x) { fail(x); } } },
        a.account_id ? { icon: 'mute', label: t('post.mute'), onClick: async () => { try { await api('POST', '/api/mutes', { account_id: a.account_id }); card.remove(); } catch (x) { fail(x); } } } : null,
        a.account_id ? { icon: 'block', label: t('post.block'), danger: true, onClick: async () => { try { await api('POST', '/api/blocks', { account_id: a.account_id }); card.remove(); } catch (x) { fail(x); } } } : null]); } }, icon('more')));
    body.append(actions);
    card.append(h('a', { href: '#/u/' + encodeURIComponent(a.username), tabindex: '-1', 'aria-hidden': 'true' }, avatar(a)), body);
    if (!o.noNav) card.addEventListener('click', (e) => { if (e.target.closest('a,button,video,audio,img,input,textarea,select')) return; if (window.getSelection().toString()) return; try { if (Behavior) Behavior.track('open', p); } catch (_) {} go('#/post/' + p.id); });
    return card;
  }
  function refCard(r) {
    if (r.missing) return h('div', { class: 'ref muted small', text: r.deleted ? t('post.deleted') : t('post.refMissing') });
    return h('div', { class: 'ref' }, h('div', { class: 'row' }, avatar(r.author, 'sm'), h('b', { text: nameOf(r.author) }), h('span', { class: 'muted small', text: '@' + r.author.username })), h('div', { class: 'ptext' }, linkify(r.content || '')), mediaView(r.media));
  }
  function editPost(p, done) {
    const ta = h('textarea', { 'aria-label': t('post.edit.title'), rows: '5' }); ta.value = p.content;
    let m; m = modal(t('post.edit.title'), h('div', { class: 'col' }, ta, h('div', { class: 'row' }, h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: () => m.close() }, t('cancel')), h('button', { class: 'btn primary', onClick: async () => { try { await api('PATCH', '/api/posts/' + p.id, { content: ta.value }); m.close(); done(); } catch (e) { fail(e); } } }, t('save')))));
  }

  // ---------- paginated list ----------
  function pagedList(fetchPage, o = {}) {
    const root = h('div', {}); const list = h('div', {}); const more = h('div', { class: 'center', style: null }); let cursor = null; let loading = false; let first = true;
    root.append(list, more);
    async function load(reset) {
      if (loading) return; loading = true;
      if (reset) { clear(list); cursor = null; first = true; }
      clear(more).append(h('div', { class: 'spinner', role: 'status', 'aria-label': t('loading') }));
      try {
        const r = await fetchPage(cursor);
        let items = r.items || [];
        if (o.rank && Behavior) { try { items = Behavior.rankPosts(items); } catch (_) {} }
        items.forEach((p) => list.append(o.render ? o.render(p) : postCard(p, o)));
        cursor = r.next_cursor; clear(more);
        if (first && !r.items.length) more.append(h('div', { class: 'empty' }, o.empty || t('explore.empty')));
        if (cursor) { const b = h('button', { class: 'btn', onClick: () => load() }, t('loadMore')); more.append(b); if ('IntersectionObserver' in window) { const io = new IntersectionObserver((en) => { if (en[0].isIntersecting) { io.disconnect(); load(); } }, { rootMargin: '300px' }); io.observe(b); } }
        first = false;
      } catch (e) { clear(more).append(h('div', { class: 'empty' }, errText(e), h('div', {}, h('button', { class: 'btn', onClick: () => load() }, icon('refresh', 'sm'), t('retry'))))); }
      finally { loading = false; }
    }
    load(true); root.reload = () => load(true);
    return root;
  }
  window.HubApp = { S, h, icon, clear, api, apiRaw, go, copy, fail, live, composer, composeModal, postCard, refCard, pagedList, outboxView, flushOutbox, searchBox, refreshSync, syncSummary, uuid, field, v, renderShell, startBackground, refreshUnread, updateDot, langSwitch, renderSetup, renderLogin, renderNetworkConnect, VIS_ICON, machineCode, maskPublicEndpoint, peerErrorText, Behavior };
})();
