'use strict';
// Community Hub web UI — part 1: state, shell, router, shared components.
(function () {
  const { h, icon, append, clear, api, apiRaw, toast, modal, confirmDialog, menu, timeAgo, avatar, nameOf, linkify, mediaSrc, mediaView, errText, shortId, net, setSessionToken, clearSessionClient, embedCard, machineCode, maskPublicEndpoint, peerErrorText, Behavior } = UI;
  const S = { session: null, user: null, features: {}, sync: null, unread: 0, token: 0, stream: null, banner: null, timers: [] };
  const $app = document.getElementById('app');
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const go = (hash) => { if (location.hash === hash) HubApp.route(); else location.hash = hash; };
  const copy = async (text, msg) => { try { await navigator.clipboard.writeText(text); toast(msg || t('copied')); } catch (e) { toast(text); } };
  const fail = (e) => toast(errText(e), true);
  const live = (tok) => tok === S.token;
  const boot = (x) => window.HubApp.boot(x);
  const route = () => window.HubApp.route();
  const VIS_ICON = { public: 'globe', followers: 'users', private: 'lock', group: 'lock' };

  // ---------- auth screens ----------
  function authFrame(title, ...kids) {
    clear($app); $app.append(h('main', { class: 'auth', id: 'main', tabindex: '-1' }, h('div', { class: 'row' }, icon('users', 'lg'), h('h1', { text: t('app') })), h('div', { class: 'row small muted' }, langSwitch()), h('h2', { text: title }), ...kids));
  }
  function langSwitch() {
    const langs = (window.I18n && I18n.LANGS) || [{ code: 'en', label: 'English' }, { code: 'vi', label: 'Tiếng Việt' }];
    return h('div', { class: 'lang-grid', role: 'group', 'aria-label': t('settings.language') },
      langs.map((l) => h('button', {
        type: 'button',
        class: 'btn sm' + (I18n.lang === l.code ? ' primary' : ''),
        'aria-pressed': String(I18n.lang === l.code),
        onClick: () => { I18n.set(l.code); if (S.user) api('PATCH', '/api/me', { lang: l.code }).catch(() => {}); HubApp.boot(true); },
      }, l.label))
    );
  }
  const field = (id, label, attrs) => [h('label', { for: id }, label), h('input', { id, ...attrs })];
  function renderSetup() {
    const s = S.session; const err = h('p', { class: 'badge bad hidden', role: 'alert' });
    const legacy = s.legacy_users || [];
    const claim = legacy.length ? h('select', { id: 'su-claim' }, h('option', { value: '' }, t('auth.claimNone')), legacy.map((u) => h('option', { value: u.id }, u.username))) : null;
    const form = h('form', { class: 'card', onSubmit: async (e) => {
      e.preventDefault(); err.classList.add('hidden');
      const body = { username: v('su-user'), password: v('su-pass'), display_name: v('su-name') || undefined };
      if (claim && claim.value) body.claim_legacy_user_id = Number(claim.value);
      if (s.setup_token_required) body.setup_token = v('su-token');
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
      err, h('p', {}, h('button', { class: 'btn primary', type: 'submit' }, t('auth.create'))));
    const restore = restorePanel(s);
    const tabCreate = h('button', { type: 'button', class: 'btn primary', role: 'tab', 'aria-selected': 'true' }, icon('plus', 'sm'), t('auth.tabCreate'));
    const tabRestore = h('button', { type: 'button', class: 'btn', role: 'tab', 'aria-selected': 'false' }, icon('upload', 'sm'), t('auth.tabRestore'));
    const pick = (mode) => {
      const r = mode === 'restore';
      form.classList.toggle('hidden', r); restore.classList.toggle('hidden', !r);
      tabCreate.classList.toggle('primary', !r); tabRestore.classList.toggle('primary', r);
      tabCreate.setAttribute('aria-selected', String(!r)); tabRestore.setAttribute('aria-selected', String(r));
    };
    tabCreate.addEventListener('click', () => pick('create')); tabRestore.addEventListener('click', () => pick('restore'));
    restore.classList.add('hidden');
    authFrame(t('auth.setupTitle'), h('div', { class: 'row tabs', role: 'tablist' }, tabCreate, tabRestore), form, restore);
  }

  /** Setup option: bring an existing account back from a backup ZIP (profile, posts, media, password). */
  function restorePanel(s) {
    let file = null; let busy = false;
    const msg = h('p', { class: 'badge bad hidden', role: 'alert' });
    const fname = h('span', { class: 'small muted grow', text: t('auth.restoreNoFile') });
    const input = h('input', { type: 'file', id: 'rs-file', accept: '.zip,application/zip,application/x-zip-compressed', class: 'hidden', onChange: (e) => {
      file = (e.target.files && e.target.files[0]) || null;
      fname.textContent = file ? file.name + ' (' + UI.formatBytes(file.size) + ')' : t('auth.restoreNoFile');
      msg.classList.add('hidden');
    } });
    const status = h('p', { class: 'small muted hidden', role: 'status', text: t('auth.restoring') });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, icon('upload', 'sm'), t('auth.restoreBtn'));
    const show = (text) => { msg.textContent = text; msg.classList.remove('hidden'); };
    const done = h('div', { class: 'card col hidden', role: 'status' });
    const form = h('form', { class: 'card col', onSubmit: async (e) => {
      e.preventDefault(); if (busy) return; msg.classList.add('hidden');
      if (!file) return show(t('err.E_NO_FILE'));
      if (!/\.zip$/i.test(file.name)) return show(t('auth.restoreNotZip'));
      busy = true; btn.disabled = true; status.classList.remove('hidden');
      try {
        const fd = new FormData(); fd.append('file', file);
        const headers = s.setup_token_required ? { 'X-Setup-Token': v('rs-token') } : {};
        const r = await api('POST', '/api/setup/restore', undefined, { form: fd, headers, quiet401: true });
        const c = r.counts || {};
        clear(done).append(
          h('div', { class: 'row' }, icon('check'), h('b', { text: t('auth.restoreDone', { user: (r.account && r.account.username) || '' }) })),
          h('p', { class: 'small', text: t('auth.restoreStats', { posts: String(c.posts || 0), media: String(c.media_files || 0), events: String(c.events || 0) }) }),
          r.verify && r.verify.problems ? h('p', { class: 'small badge warn', text: t('auth.restoreProblems', { n: String(r.verify.problems) }) }) : h('p', { class: 'small muted', text: t('auth.restoreVerified') }),
          r.reindexed ? h('p', { class: 'small muted', text: t('auth.restoreRebuilt') }) : null,
          c.media_missing ? h('p', { class: 'small badge warn', text: t('auth.restoreMediaMissing', { n: String(c.media_missing) }) }) : null,
          r.key_missing ? h('p', { class: 'small badge warn', text: t('auth.restoreKeyWarn') }) : null,
          h('p', { class: 'muted', text: t('auth.restoreSignIn') }),
          h('button', { class: 'btn primary', type: 'button', onClick: () => HubApp.boot() }, icon('check', 'sm'), t('auth.restoreContinue')));
        form.classList.add('hidden'); done.classList.remove('hidden');
      } catch (x) { show(errText(x)); busy = false; btn.disabled = false; status.classList.add('hidden'); }
    } },
      h('p', { class: 'badge', text: t('auth.restoreTitle') }),
      h('p', { class: 'muted', text: t('auth.restoreHelp') }),
      s.setup_token_required ? field('rs-token', t('auth.setupToken'), { type: 'password', autocomplete: 'off', required: true }) : null,
      h('div', { class: 'row' }, h('label', { class: 'btn', for: 'rs-file' }, icon('file', 'sm'), t('auth.restorePick')), fname, input),
      msg, status, h('p', {}, btn));
    return h('div', { class: 'col' }, form, done);
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
    ['files', 'file', 'nav.files', 'desk'], ['bookmarks', 'bookmark', 'nav.bookmarks', 'desk'], ['messages', 'mail', 'nav.messages', 'desk'], ['network', 'globe', 'nav.network', 'desk'], ['assistant', 'bot', 'nav.assistant', 'desk'], ['u/' + 'me', 'user', 'nav.profile', 'desk'], ['settings', 'settings', 'nav.settings', 'desk'],
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
    $app.append(h('div', { class: 'shell' }, nav, h('main', { class: 'main', id: 'main', tabindex: '-1' }, h('div', { id: 'banner' }), h('div', { id: 'keybanner' }), h('div', { id: 'view' })), side));
    updateSyncChip(); loadTrends(); updateDot(); renderKeyBanner();
  }

  /** Shown to the owner when this Hub has no private key for the account (e.g. restored from a backup without keys). */
  function renderKeyBanner() {
    const box = document.getElementById('keybanner'); if (!box) return; clear(box);
    if (!S.user || !S.user.key_missing) return;
    const btn = h('button', { class: 'btn primary sm', type: 'button', onClick: async () => {
      if (!confirm(t('key.rekeyConfirm'))) return;
      const p = prompt(t('settings.confirmPassword')); if (!p) return;
      btn.disabled = true;
      try {
        const r = await api('POST', '/api/identity/rekey', { password: p });
        S.user = Object.assign({}, S.user, { account_id: r.account_id, key_missing: false });
        toast(t('key.rekeyDone')); renderKeyBanner(); route();
      } catch (e) { fail(e); btn.disabled = false; }
    } }, icon('key', 'sm'), t('key.rekeyBtn'));
    box.append(h('div', { class: 'banner warn', role: 'alert', style: 'cursor:default;flex-wrap:wrap' }, icon('shield'), h('div', { class: 'grow' }, h('b', { text: t('key.missingTitle') }), h('div', { class: 'small', text: t('key.missingBody') })), btn));
  }

  function openMore() {
    const mk = (r, ic, key) => h('a', { class: 'btn', style: null, href: r, onClick: () => m.close() }, icon(ic, 'sm'), t(key));
    const m = modal(t('nav.more'), h('div', { class: 'col' }, mk('#/files', 'file', 'nav.files'), mk('#/bookmarks', 'bookmark', 'nav.bookmarks'), mk('#/messages', 'mail', 'nav.messages'), mk('#/network', 'globe', 'nav.network'), mk('#/assistant', 'bot', 'nav.assistant'), mk('#/u/' + encodeURIComponent(S.user.username), 'user', 'nav.profile'), mk('#/settings', 'settings', 'nav.settings'), h('button', { class: 'btn danger', onClick: () => { m.close(); logout(); } }, icon('logout', 'sm'), t('auth.logout'))));
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
    if (s.total > 0) return { icon: 'globe', text: t('net.summary', { h: s.healthy, t: s.total }), cls: s.healthy === s.total ? 'ok' : (s.healthy ? 'warn' : 'bad') };
    if (s.p2p && s.p2p.bootstrap && s.p2p.bootstrap.cannoi_connected > 0) {
      return { icon: 'globe', text: t('net.bootstrap.joined', { n: String(s.p2p.bootstrap.cannoi_connected) }), cls: 'ok' };
    }
    if (!s.enabled || !s.total) return { icon: 'globe', text: t('net.ready'), cls: '' };
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
      const qsTok = net.sessionToken ? ('?s=' + encodeURIComponent(net.sessionToken)) : '';
      S.stream = new EventSource('/api/stream' + qsTok);
      S.stream.addEventListener('update', () => { refreshUnread(); refreshSync(); onActivity(); });
      S.stream.addEventListener('dm', (ev) => {
        let d = {}; try { d = JSON.parse(ev.data || '{}'); } catch (_) {}
        window.dispatchEvent(new CustomEvent('hub-dm', { detail: d }));
        refreshUnread();
      });
      S.stream.addEventListener('call', (ev) => {
        let d = {}; try { d = JSON.parse(ev.data || '{}'); } catch (_) {}
        Calls.onSignal(d);
      });
    } catch (e) { /* SSE unsupported: polling still works */ }
    api('GET', '/api/calls/pending', undefined, { quiet401: true }).then((r) => {
      if (r && Array.isArray(r.items)) r.items.forEach((sig) => Calls.onSignal(sig));
    }).catch(() => {});
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
    const previews = h('div', { class: 'composer-previews' });
    const chips = h('div', { class: 'attach' });
    const sugg = h('div', { class: 'small hidden' });
    const mentionBox = h('div', { class: 'mention-menu hidden', role: 'listbox' });
    const fileIn = h('input', { type: 'file', class: 'hidden', multiple: true, accept: 'image/*,video/mp4,video/webm,video/quicktime,audio/*,application/pdf,.txt,.md,.csv,.json,.zip,.docx,.xlsx,.pptx', onChange: async (e) => { for (const f of [...e.target.files].slice(0, 4 - files.length)) await upload(f); e.target.value = ''; } });
    const vis = o.noVisibility ? null : h('select', { 'aria-label': t('composer.visibility'), title: t('composer.visibility') },
      h('option', { value: 'public' }, t('vis.public')),
      h('option', { value: 'followers' }, t('vis.followers')),
      h('option', { value: 'private' }, t('vis.private'))
    );
    if (vis && o.defaultVis) vis.value = o.defaultVis;
    const btn = h('button', { class: 'btn primary', onClick: submit }, o.replyTo ? t('composer.reply') : t('composer.post'));
    const hint = h('span', { class: 'small muted' });
    const upd = () => {
      const n = ta.value.length;
      counter.textContent = n ? n + '/' + max : '';
      counter.classList.toggle('over', n > max);
      btn.disabled = busy || n > max || (!ta.value.trim() && !files.length && !o.allowEmpty);
      if (vis) {
        hint.textContent = vis.value === 'public' ? '' : vis.value === 'private' ? t('vis.privateHint') : t('vis.followersHint');
      }
    };

    // @mention autocomplete
    let mTimer = null; let mUsers = []; let mIdx = 0; let mMatch = null;
    const closeMentions = () => { mMatch = null; mUsers = []; mentionBox.classList.add('hidden'); clear(mentionBox); };
    const pickMention = (u) => {
      if (!mMatch || !u) return;
      const before = ta.value.slice(0, mMatch.start) + '@' + u.username + ' ';
      const after = ta.value.slice(mMatch.end);
      ta.value = before + after;
      ta.focus();
      ta.setSelectionRange(before.length, before.length);
      closeMentions();
      upd();
    };
    const drawMentions = () => {
      clear(mentionBox);
      if (!mUsers.length) { mentionBox.classList.add('hidden'); return; }
      mUsers.forEach((u, idx) => {
        mentionBox.append(h('button', {
          type: 'button',
          class: 'mention-item' + (idx === mIdx ? ' active' : ''),
          role: 'option',
          onMouseDown: (e) => { e.preventDefault(); pickMention(u); },
        }, avatar(u, 'sm'), h('span', { class: 'grow' }, h('b', { text: nameOf(u) }), ' ', h('span', { class: 'muted small', text: '@' + u.username }))));
      });
      mentionBox.classList.remove('hidden');
    };
    const checkMention = () => {
      clearTimeout(mTimer);
      const pos = ta.selectionStart || 0;
      const head = ta.value.slice(0, pos);
      const mm = /(?:^|[\s(\[{"'])@([A-Za-z0-9_.-]{0,20})$/.exec(head);
      if (!mm) { closeMentions(); return; }
      const q = mm[1];
      mMatch = { start: pos - q.length - 1, end: pos };
      mTimer = setTimeout(async () => {
        try {
          const r = await api('GET', '/api/mentions?limit=6&q=' + encodeURIComponent(q), undefined, { quiet401: true });
          if (!ta.isConnected || !mMatch) return;
          mUsers = r.items || []; mIdx = 0; drawMentions();
        } catch (_) { closeMentions(); }
      }, 130);
    };
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(300, ta.scrollHeight) + 'px'; upd(); checkMention(); });
    ta.addEventListener('keydown', (e) => {
      if (mentionBox.classList.contains('hidden') || !mUsers.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); mIdx = (mIdx + 1) % mUsers.length; drawMentions(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); mIdx = (mIdx - 1 + mUsers.length) % mUsers.length; drawMentions(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mUsers[mIdx]); }
      else if (e.key === 'Escape') { e.preventDefault(); closeMentions(); }
    });
    ta.addEventListener('blur', () => setTimeout(closeMentions, 180));
    if (vis) vis.addEventListener('change', upd);

    function drawChips() {
      clear(previews); clear(chips);
      files.forEach((f, i) => {
        if (f.kind === 'image') {
          previews.append(h('div', { class: 'preview-tile' },
            h('img', { class: 'preview-img', src: mediaSrc(f), alt: f.name || '' }),
            h('button', { type: 'button', class: 'iconbtn preview-rm', 'aria-label': t('close'), onClick: () => { files.splice(i, 1); drawChips(); upd(); } }, icon('x', 'sm'))
          ));
        } else {
          chips.append(h('span', { class: 'chip' }, icon('clip', 'sm'), f.name, h('button', { type: 'button', class: 'iconbtn', 'aria-label': t('close'), onClick: () => { files.splice(i, 1); drawChips(); upd(); } }, icon('x', 'sm'))));
        }
      });
    }
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
      busy = true; upd(); closeMentions();
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
    return h('div', { class: 'composer' }, avatar(S.user), h('div', { class: 'grow composer-inner' }, ta, mentionBox, previews, chips, sugg, fileIn, tools));
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
    if (o.showPinned && p.is_pinned) body.append(h('div', { class: 'small muted row pinned-badge' }, icon('pin', 'sm'), t('post.pinned')));
    if (o.showGroupPinned && p.is_group_pinned) body.append(h('div', { class: 'small muted row pinned-badge' }, icon('pin', 'sm'), t('groups.pinned')));
    if (o.via) body.append(h('div', { class: 'small muted row' }, icon('repeat', 'sm'), t('post.reposted', { name: nameOf(o.via.author) })));
    if (!o.hideReplyTo && p.reply_to && p.reply_to.username) {
      body.append(h('div', { class: 'small muted row reply-to-line', onClick: (e) => { e.stopPropagation(); if (p.reply_to.id) go('#/post/' + p.reply_to.id); } },
        icon('comment', 'sm'),
        h('span', { text: t('post.replyingTo', { user: '@' + p.reply_to.username }) }),
        p.reply_to.preview ? h('span', { class: 'reply-preview muted', text: ' — ' + p.reply_to.preview }) : null
      ));
    }
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

    const canPin = mine && !p.group_id && !p.parent_id && !p.parent_event;
    const replyBtn = h('button', {
      class: 'iconbtn',
      'aria-label': t('post.reply'),
      title: t('post.replies'),
      onClick: (e) => {
        e.stopPropagation();
        if (!o.inThread) {
          try { if (Behavior) Behavior.track('open', p); } catch (_) {}
          go('#/post/' + p.id);
          return;
        }
        if (o.onInlineReply) {
          o.onInlineReply(p);
          return;
        }
        if (o.noNav) {
          const ta = document.querySelector('.thread-focal-reply textarea');
          if (ta) { ta.focus(); ta.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
        }
        composeModal({ replyTo: p.id, refPost: p, onPosted: () => { if (o.onReplied) o.onReplied(); else redraw(); } });
      },
    }, icon('comment'), h('span', { class: 'small', text: count(p.counts.replies) }));

    const actions = h('div', { class: 'actions' },
      replyBtn,
      shareable ? h('button', { class: 'iconbtn' + (v.reposted ? ' on' : ''), 'aria-label': t('post.repost'), onClick: (e) => { e.stopPropagation(); menu(e.currentTarget, [
        { icon: 'repeat', label: v.reposted ? t('post.unrepost') : t('post.repost'), onClick: async () => { if (v.reposted) return; try { await api('POST', '/api/posts', { repost_of: p.id, client_id: uuid() }); toast(t('post.unrepost')); redraw(); } catch (x) { fail(x); } } },
        { icon: 'quote', label: t('post.quote'), onClick: () => composeModal({ quoteOf: p.id, refPost: p, onPosted: onActivity }) }]); } }, icon('repeat'), h('span', { class: 'small', text: count(p.counts.reposts + p.counts.quotes) })) : h('span'),
      likeBtn, bmBtn, translateBtn,
      h('button', { class: 'iconbtn', 'aria-label': t('more'), 'aria-haspopup': 'menu', onClick: (e) => {
        e.stopPropagation();
        const groupPinItem = (o.onGroupPin && !p.parent_id && !p.parent_event) ? {
          icon: 'pin',
          label: p.is_group_pinned ? t('groups.unpin') : t('groups.pin'),
          onClick: () => o.onGroupPin(p),
        } : null;
        menu(e.currentTarget, mine ? [
          canPin ? { icon: 'pin', label: p.is_pinned ? t('post.unpin') : t('post.pin'), onClick: async () => { try { await api(p.is_pinned ? 'DELETE' : 'POST', '/api/posts/' + p.id + '/pin', {}); p.is_pinned = !p.is_pinned; toast(t(p.is_pinned ? 'post.pinned' : 'post.saved')); if (o.onPinned) o.onPinned(); else redraw(); } catch (x) { fail(x); } } } : null,
          groupPinItem,
          p.kind !== 'repost' ? { icon: 'edit', label: t('post.edit'), onClick: () => editPost(p, redraw) } : null,
          { icon: 'trash', label: t('post.delete'), danger: true, onClick: async () => { if (await confirmDialog(p.event_id ? t('post.confirmDelete') : t('post.delete') + '?', t('post.delete'), true)) { try { const r = await api('DELETE', '/api/posts/' + p.id); toast(r.note === 'tombstone_published' ? t('post.deleteNote') : t('post.delete')); if (o.onDeleted) o.onDeleted(); else card.remove(); } catch (x) { fail(x); } } } }
        ] : [
          groupPinItem,
          { icon: 'flag', label: t('post.report'), onClick: async () => { try { await api('POST', '/api/reports', { post_id: p.id, reason: 'reported from UI' }); toast(t('post.reported')); } catch (x) { fail(x); } } },
          a.account_id ? { icon: 'mute', label: t('post.mute'), onClick: async () => { try { await api('POST', '/api/mutes', { account_id: a.account_id }); card.remove(); } catch (x) { fail(x); } } } : null,
          a.account_id ? { icon: 'block', label: t('post.block'), danger: true, onClick: async () => { try { await api('POST', '/api/blocks', { account_id: a.account_id }); card.remove(); } catch (x) { fail(x); } } } : null
        ]);
      } }, icon('more')));
    body.append(actions);
    const av = h('a', { href: '#/u/' + encodeURIComponent(a.username), class: 'pav-col', tabindex: '-1', 'aria-hidden': 'true' }, avatar(a, o.compact ? 'sm' : undefined), o.spine ? h('span', { class: 'thread-spine' }) : null);
    card.append(av, body);
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
  // ---------- WebRTC Voice/Video Calls (signaled via Hub SSE + /api/calls/signal) ----------
  const Calls = (() => {
    let active = null;
    let incomingModal = null;
    let ringTimer = null;

    function supported() {
      return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    }

    function sendSig(to, type, data) {
      return api('POST', '/api/calls/signal', { to, type, call_id: (active && active.callId) || (data && data.call_id) || undefined, data }).catch(() => {});
    }

    function cleanup(notifyRemote = false) {
      clearTimeout(ringTimer);
      if (incomingModal) { try { incomingModal.close(); } catch (_) {} incomingModal = null; }
      if (!active) return;
      const a = active; active = null;
      if (notifyRemote && a.peerAccount) sendSig(a.peerAccount, 'hangup', { call_id: a.callId });
      try { if (a.pc) a.pc.close(); } catch (_) {}
      try { if (a.stream) a.stream.getTracks().forEach((tr) => tr.stop()); } catch (_) {}
      try { if (a.overlay) a.overlay.remove(); } catch (_) {}
    }

    function createOverlay(peer, video) {
      const statusEl = h('div', { class: 'small muted', text: t('messages.callConnecting') });
      const remoteVid = h('video', { class: 'call-video-remote', autoplay: true, playsinline: true });
      const localVid = h('video', { class: 'call-video-local' + (video ? '' : ' hidden'), autoplay: true, playsinline: true, muted: true });
      let muted = false; let camOff = !video;
      const muteBtn = h('button', { type: 'button', class: 'btn', onClick: () => {
        if (!active || !active.stream) return;
        muted = !muted;
        active.stream.getAudioTracks().forEach((tr) => { tr.enabled = !muted; });
        muteBtn.textContent = muted ? t('messages.unmuteAudio') : t('messages.muteAudio');
      } }, icon('mic-off', 'sm'), t('messages.muteAudio'));
      const camBtn = video ? h('button', { type: 'button', class: 'btn', onClick: () => {
        if (!active || !active.stream) return;
        camOff = !camOff;
        active.stream.getVideoTracks().forEach((tr) => { tr.enabled = !camOff; });
        localVid.classList.toggle('hidden', camOff);
      } }, icon('video', 'sm'), t('messages.toggleVideo')) : null;
      const hangBtn = h('button', { type: 'button', class: 'btn danger', onClick: () => { cleanup(true); toast(t('messages.callEnded')); } }, icon('x', 'sm'), t('messages.hangup'));
      const box = h('div', { class: 'call-overlay', role: 'dialog', 'aria-modal': 'true' },
        h('div', { class: 'row' }, avatar(peer, 'sm'), h('b', { text: nameOf(peer) })),
        statusEl,
        h('div', { class: 'call-videos' }, remoteVid, localVid),
        append(h('div', { class: 'call-controls' }), muteBtn, camBtn, hangBtn)
      );
      document.body.appendChild(box);
      return { overlay: box, statusEl, remoteVid, localVid };
    }

    function createPc(peerAccount) {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pc.onicecandidate = (ev) => {
        if (ev.candidate && active && active.callId) sendSig(peerAccount, 'ice', ev.candidate);
      };
      pc.ontrack = (ev) => {
        if (active && active.remoteVid && ev.streams && ev.streams[0]) {
          active.remoteVid.srcObject = ev.streams[0];
          if (active.statusEl) active.statusEl.textContent = t('messages.callActive');
        }
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected' && active && active.statusEl) active.statusEl.textContent = t('messages.callActive');
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') cleanup(false);
      };
      return pc;
    }

    async function startCall(peer, video = false) {
      if (!supported()) return toast(t('messages.webrtcUnsupported'), true);
      if (active) return;
      const peerAccount = peer && peer.account_id;
      if (!peerAccount) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!video });
        const callId = uuid();
        const ui = createOverlay(peer, video);
        ui.statusEl.textContent = t('messages.calling', { name: nameOf(peer) });
        ui.localVid.srcObject = stream;
        const pc = createPc(peerAccount);
        stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
        active = { callId, peerAccount, peer, video, pc, stream, ...ui };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await api('POST', '/api/calls/signal', { to: peerAccount, call_id: callId, type: 'offer', data: { sdp: offer.sdp, type: offer.type, video: !!video } });
        ringTimer = setTimeout(() => { if (active && active.callId === callId && active.pc.connectionState !== 'connected') { cleanup(true); toast(t('messages.callEnded')); } }, 45000);
      } catch (e) {
        cleanup(false);
        toast((e && e.message) || t('messages.webrtcUnsupported'), true);
      }
    }

    async function acceptIncoming(sig) {
      if (incomingModal) { try { incomingModal.close(); } catch (_) {} incomingModal = null; }
      if (!supported()) { await sendSig(sig.from_account, 'reject', { call_id: sig.call_id }); return toast(t('messages.webrtcUnsupported'), true); }
      try {
        const video = !!(sig.data && sig.data.video);
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
        const peer = Object.assign({ account_id: sig.from_account }, sig.from_user || {});
        const ui = createOverlay(peer, video);
        ui.localVid.srcObject = stream;
        const pc = createPc(sig.from_account);
        stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
        active = { callId: sig.call_id, peerAccount: sig.from_account, peer, video, pc, stream, ...ui };
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: sig.data.sdp }));
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        await api('POST', '/api/calls/signal', { to: sig.from_account, call_id: sig.call_id, type: 'answer', data: { sdp: ans.sdp, type: ans.type } });
      } catch (e) {
        cleanup(false);
        await sendSig(sig.from_account, 'reject', { call_id: sig.call_id });
        toast((e && e.message) || t('messages.webrtcUnsupported'), true);
      }
    }

    async function onSignal(sig) {
      if (!sig || !sig.type) return;
      if (sig.type === 'offer') {
        if (active) { sendSig(sig.from_account, 'reject', { call_id: sig.call_id }); return; }
        const peer = sig.from_user || { username: sig.from_account };
        const mode = (sig.data && sig.data.video) ? t('messages.callVideo') : t('messages.callAudio');
        if (incomingModal) { try { incomingModal.close(); } catch (_) {} }
        incomingModal = modal(t('messages.incomingCall', { mode, name: nameOf(peer) }), h('div', { class: 'col' },
          h('div', { class: 'row' }, avatar(peer, 'sm'), h('b', { text: nameOf(peer) }), h('span', { class: 'muted small', text: '@' + (peer.username || '') })),
          h('div', { class: 'row' },
            h('span', { class: 'grow' }),
            h('button', { type: 'button', class: 'btn danger', onClick: () => { if (incomingModal) incomingModal.close(); incomingModal = null; sendSig(sig.from_account, 'reject', { call_id: sig.call_id }); } }, icon('x', 'sm'), t('messages.decline')),
            h('button', { type: 'button', class: 'btn primary', onClick: () => acceptIncoming(sig) }, icon('phone', 'sm'), t('messages.answer'))
          )
        ));
      } else if (sig.type === 'answer' && active && active.callId === sig.call_id && sig.data) {
        clearTimeout(ringTimer);
        try { await active.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: sig.data.sdp })); } catch (_) {}
      } else if (sig.type === 'ice' && active && active.callId === sig.call_id && sig.data) {
        try { await active.pc.addIceCandidate(new RTCIceCandidate(sig.data)); } catch (_) {}
      } else if ((sig.type === 'hangup' || sig.type === 'reject') && ((active && active.callId === sig.call_id) || incomingModal)) {
        cleanup(false);
        toast(t('messages.callEnded'));
      }
    }

    return { startCall, onSignal, supported };
  })();

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
  window.HubApp = { S, h, icon, append, clear, api, apiRaw, go, copy, fail, live, composer, composeModal, postCard, refCard, pagedList, outboxView, flushOutbox, searchBox, refreshSync, syncSummary, uuid, field, v, renderShell, startBackground, refreshUnread, updateDot, langSwitch, renderSetup, renderLogin, renderNetworkConnect, VIS_ICON, machineCode, maskPublicEndpoint, peerErrorText, Behavior, Calls };
})();
