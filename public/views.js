'use strict';
// Community Hub web UI — part 2: screens, router and boot.
(function () {
  const A = window.HubApp; const { S, h, icon, clear, api, apiRaw, go, copy, fail, live, composer, composeModal, postCard, pagedList, outboxView, flushOutbox, searchBox, field, v, machineCode, maskPublicEndpoint, peerErrorText, Behavior } = A;
  const { avatar, nameOf, timeAgo, shortId, errText, toast, modal, confirmDialog, menu, linkify, net, formatBytes } = UI;
  const qs = (c) => (c ? '?cursor=' + encodeURIComponent(c) : '');
  const $ = (id) => document.getElementById(id);
  const top = (title, o = {}) => h('div', { class: 'topbar' }, o.back ? h('button', { class: 'iconbtn', 'aria-label': t('back'), onClick: () => (history.length > 1 ? history.back() : go('#/home')) }, icon('back')) : null, h('h1', { text: title }), o.right || null);
  const activityBar = (reload) => { const bar = h('div', { class: 'banner hidden' }, h('button', { class: 'btn sm', onClick: () => { bar.classList.add('hidden'); reload(); } }, icon('refresh', 'sm'), t('newPosts'))); S.onActivity = () => bar.classList.remove('hidden'); return bar; };
  const empty = (text, ic) => h('div', { class: 'empty' }, ic ? icon(ic, 'lg') : null, h('p', { text }));
  const spinner = () => h('div', { class: 'spinner', role: 'status', 'aria-label': t('loading') });
  const userRow = (u) => h('a', { class: 'post', href: '#/u/' + encodeURIComponent(u.username || u.account_id || ''), style: null }, avatar(u), h('div', { class: 'pbody' }, h('b', { text: nameOf(u) }), h('div', { class: 'muted small', text: u.username ? '@' + u.username : shortId(u.account_id) }), u.bio ? h('div', { class: 'small', text: u.bio }) : null));

  // ---------- views ----------
  function viewHome(view, tok) {
    const ob = outboxView();
    const feed = pagedList((c) => api('GET', '/api/feed/home' + qs(c)), { empty: t('home.empty') });
    view.append(top(t('home.title')), activityBar(() => feed.reload()), composer({ onPosted: () => feed.reload() }), ob, feed);
  }
  async function viewExplore(view, tok) { // behavior-ranked discovery
    const feed = pagedList((c) => api('GET', '/api/feed/public' + qs(c)), { rank: true, empty: t('explore.empty') });
    const trends = h('div', { class: 'chips' });
    view.append(top(t('explore.title')), h('div', { class: 'page' }, searchBox(), h('div', { class: 'col' }, h('b', { text: t('trends') }), trends)), activityBar(() => feed.reload()), feed);
    try { const r = await api('GET', '/api/trends'); if (live(tok)) r.tags.forEach((x) => trends.append(h('button', { onClick: () => go('#/search/' + encodeURIComponent('#' + x.tag)) }, '#' + x.tag + ' · ' + x.n))); } catch (e) { /* optional */ }
  }
  async function viewSearch(view, tok, q) {
    view.append(top(t('nav.explore'), { back: true }), h('div', { class: 'page' }, searchBox(q)));
    const out = h('div', {}, spinner()); view.append(out);
    try {
      const r = await api('GET', '/api/search?q=' + encodeURIComponent(q)); if (!live(tok)) return; clear(out);
      if (!r.accounts.length && !r.posts.length && !r.tags.length) return out.append(empty(t('search.none'), 'search'));
      if (r.accounts.length) out.append(h('h2', { class: 'page', text: t('search.people') }), r.accounts.map(userRow));
      if (r.tags.length && !q.startsWith('#')) out.append(h('h2', { class: 'page', text: t('search.tags') }), h('div', { class: 'page chips' }, r.tags.map((x) => h('button', { onClick: () => go('#/search/' + encodeURIComponent('#' + x)) }, '#' + x))));
      if (r.posts.length) out.append(h('h2', { class: 'page', text: t('search.posts') }), r.posts.map((p) => postCard(p)));
    } catch (e) { clear(out).append(empty(errText(e))); }
  }
  async function viewPost(view, tok, id) {
    view.append(top(t('post.replies'), { back: true })); const body = h('div', {}, spinner()); view.append(body);
    try {
      const r = await api('GET', '/api/posts/' + encodeURIComponent(id) + '/thread'); if (!live(tok)) return; clear(body);
      const again = () => route();
      body.append(postCard(r.post, { noNav: true, onReplied: again }));
      if (!r.post.deleted) body.append(composer({ replyTo: r.post.id, placeholder: t('composer.replyPlaceholder'), noVisibility: true, compact: true, onPosted: again }));
      r.replies.forEach((p) => body.append(postCard(p, { onReplied: again })));
      r.comments.forEach((c) => body.append(h('div', { class: 'post' }, avatar({ username: c.username, display_name: c.display_name }, 'sm'), h('div', { class: 'pbody' }, h('div', { class: 'phead' }, h('b', { text: c.display_name || c.username }), h('span', { class: 'muted small', text: '· ' + timeAgo(c.created_at) })), h('div', { class: 'ptext', text: c.content })))));
      if (!r.replies.length && !r.comments.length) body.append(empty(t('post.noReplies')));
    } catch (e) { clear(body).append(empty(errText(e), 'info')); }
  }
  async function viewProfile(view, tok, handle) {
    view.append(top(t('nav.profile'), { back: true })); const body = h('div', {}, spinner()); view.append(body);
    let p; try { p = await api('GET', '/api/profiles/' + encodeURIComponent(handle)); } catch (e) { return clear(body).append(empty(e.status === 404 ? t('profile.notFound') : errText(e), 'user')); }
    if (!live(tok)) return; clear(body);
    const rel = p.relation || {}; const self = rel.self;
    const followBtn = () => { if (self || !p.account_id || !S.user) return null; const b = h('button', { class: 'btn ' + (rel.following ? '' : 'primary'), onClick: async () => { try { if (rel.following) await api('DELETE', '/api/follow', { account_id: p.account_id }); else await api('POST', '/api/follow', { account_id: p.account_id }); route(); } catch (e) { fail(e); } } }, rel.following ? t('profile.following') : t('profile.follow')); return b; };
    const moreBtn = !self && p.account_id ? h('button', { class: 'iconbtn', 'aria-label': t('more'), onClick: (e) => menu(e.currentTarget, [
      { icon: 'mute', label: rel.muted ? t('profile.unmute') : t('post.mute'), onClick: async () => { try { await api(rel.muted ? 'DELETE' : 'POST', '/api/mutes', { account_id: p.account_id }); route(); } catch (x) { fail(x); } } },
      { icon: 'block', label: rel.blocked ? t('profile.unblock') : t('post.block'), danger: !rel.blocked, onClick: async () => { try { await api(rel.blocked ? 'DELETE' : 'POST', '/api/blocks', { account_id: p.account_id }); route(); } catch (x) { fail(x); } } },
      { icon: 'flag', label: t('post.report'), onClick: async () => { try { await api('POST', '/api/reports', { account_id: p.account_id, reason: 'profile' }); toast(t('post.reported')); } catch (x) { fail(x); } } }]) }, icon('more')) : null;
    const list = (dir) => async () => { try { const r = await api('GET', '/api/profiles/' + encodeURIComponent(handle) + '/' + dir); modal(t(dir === 'followers' ? 'profile.followers' : 'profile.followingN'), h('div', {}, r.items.length ? r.items.map((u) => userRow({ ...u, username: u.username })) : empty(t('settings.none')))); } catch (e) { fail(e); } };
    body.append(h('div', { class: 'profilehead' }, h('div', { class: 'row' }, avatar(p, 'lg'), h('span', { class: 'grow' }), moreBtn, self ? h('button', { class: 'btn', onClick: () => editProfile(p) }, t('profile.edit')) : followBtn()),
      h('h2', { text: nameOf(p) }), h('div', { class: 'muted', text: '@' + p.username }),
      h('div', { class: 'row wrap' }, rel.friend ? h('span', { class: 'badge ok' }, t('profile.friend')) : rel.followed_by ? h('span', { class: 'badge' }, t('profile.followsYou')) : null, p.status === 'remote' ? h('span', { class: 'badge' }, icon('globe', 'sm'), t('profile.remote')) : null, rel.blocked ? h('span', { class: 'badge bad' }, t('profile.blocked')) : null, rel.muted ? h('span', { class: 'badge warn' }, t('profile.muted')) : null),
      p.bio ? h('p', { class: 'ptext' }, linkify(p.bio)) : null,
      p.status === 'legacy' ? h('p', { class: 'small muted', text: t('profile.legacy') }) : null,
      p.account_id ? h('div', { class: 'small row wrap' }, h('span', { class: 'muted', text: t('profile.accountId') }), h('code', { class: 'id', text: shortId(p.account_id) }), h('button', { class: 'iconbtn', 'aria-label': t('copy'), onClick: () => copy(p.account_id) }, icon('link', 'sm'))) : null,
      h('div', { class: 'stat' }, h('span', {}, h('b', { text: p.counts.posts }), ' ' + t('profile.posts')), h('button', { onClick: list('followers') }, h('b', { text: p.counts.followers }), ' ' + t('profile.followers')), h('button', { onClick: list('following') }, h('b', { text: p.counts.following }), ' ' + t('profile.followingN')))));
    let replies = false; const holder = h('div', {});
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const draw = () => { clear(tabs); [[false, 'profile.posts'], [true, 'profile.replies']].forEach(([r, k]) => tabs.append(h('button', { role: 'tab', 'aria-selected': String(replies === r), onClick: () => { replies = r; draw(); } }, t(k)))); clear(holder).append(pagedList((c) => api('GET', '/api/profiles/' + encodeURIComponent(handle) + '/posts' + (c ? '?cursor=' + encodeURIComponent(c) + '&' : '?') + 'replies=' + (replies ? 1 : 0)))); };
    draw(); body.append(tabs, holder);
  }
  function editProfile(p) {
    let avatarHash; const nm = h('input', { type: 'text', id: 'ep-name', maxlength: '50', value: p.display_name || '' }); const bio = h('textarea', { id: 'ep-bio', maxlength: '300' }); bio.value = p.bio || '';
    const fi = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', id: 'ep-av', onChange: async (e) => { const f = e.target.files[0]; if (!f) return; const form = new FormData(); form.append('file', f); try { const m = await api('POST', '/api/media', undefined, { form }); avatarHash = m.hash; toast(t('post.saved')); } catch (x) { fail(x); } } });
    let m; m = modal(t('profile.edit'), h('div', { class: 'col' }, h('label', { for: 'ep-name' }, t('auth.displayName')), nm, h('label', { for: 'ep-bio' }, t('profile.bio')), bio, h('label', { for: 'ep-av' }, t('profile.avatar')), fi,
      h('div', { class: 'row' }, h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: () => m.close() }, t('cancel')), h('button', { class: 'btn primary', onClick: async () => { try { const body = { display_name: nm.value, bio: bio.value }; if (avatarHash) body.avatar = avatarHash; const r = await api('PATCH', '/api/me', body); S.user = r.user; m.close(); A.renderShell(); route(); } catch (e) { fail(e); } } }, t('save')))));
  }
  async function viewNotifications(view, tok) {
    const markBtn = h('button', { class: 'btn sm', onClick: async () => { try { await api('POST', '/api/notifications/read', {}); S.unread = 0; A.updateDot(); route(); } catch (e) { fail(e); } } }, t('notif.markRead'));
    view.append(top(t('notif.title'), { right: markBtn })); const body = h('div', {}, spinner()); view.append(body);
    try {
      const r = await api('GET', '/api/notifications'); if (!live(tok)) return; clear(body); S.unread = r.unread; A.updateDot();
      if (!r.items.length) return body.append(empty(t('notif.empty'), 'bell'));
      const IC = { like: 'heart', reply: 'comment', repost: 'repeat', quote: 'quote', follow: 'user' };
      r.items.forEach((n) => body.append(h('a', { class: 'post' + (n.read ? '' : ' clickable'), href: n.post_id ? '#/post/' + n.post_id : '#/u/' + encodeURIComponent(n.actor.username || ''), style: null }, h('span', { class: 'iconbtn on' }, icon(IC[n.type] || 'bell')), avatar(n.actor, 'sm'), h('div', { class: 'pbody' }, h('div', { text: t('notif.' + n.type, { name: nameOf(n.actor) }) }), h('div', { class: 'muted small', text: timeAgo(n.created_at) })))));
    } catch (e) { clear(body).append(empty(errText(e))); }
  }
  function viewBookmarks(view) {
    view.append(top(t('bookmarks.title')), pagedList((c) => api('GET', '/api/bookmarks' + qs(c)), { empty: t('bookmarks.empty'), onUnbookmark: true }));
  }
  function viewMessages(view) {
    view.append(top(t('messages.title')), h('div', { class: 'page' }, h('div', { class: 'card col' }, h('div', { class: 'row' }, icon('lock', 'lg'), h('h2', { text: t('messages.disabled') })), h('p', { text: t('messages.why') }), h('a', { class: 'btn', href: '#/assistant' }, icon('bot', 'sm'), t('nav.assistant')))));
  }

  // ---------- groups (local to this Hub) ----------
  async function viewGroups(view, tok) {
    const nm = h('input', { type: 'text', id: 'g-name', maxlength: '80', required: true }); const ds = h('textarea', { id: 'g-desc', maxlength: '500', rows: '2' }); const pv = h('input', { type: 'checkbox', id: 'g-priv' });
    const form = h('form', { class: 'card col', onSubmit: async (e) => { e.preventDefault(); try { const g = await api('POST', '/api/groups', { name: nm.value, description: ds.value, visibility: pv.checked ? 'private' : 'open' }); go('#/groups/' + g.id); } catch (x) { fail(x); } } },
      h('b', { text: t('groups.create') }), h('label', { for: 'g-name' }, t('groups.name')), nm, h('label', { for: 'g-desc' }, t('groups.desc')), ds, h('label', { class: 'row', for: 'g-priv' }, pv, t('groups.private')), h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, t('groups.create'))));
    const list = h('div', {}, spinner());
    view.append(top(t('groups.title')), h('div', { class: 'page col' }, h('p', { class: 'small muted', text: t('groups.localNote') }), form), list);
    try {
      const gs = await api('GET', '/api/groups'); if (!live(tok)) return; clear(list);
      if (!gs.length) return list.append(empty(t('groups.empty'), 'users'));
      gs.forEach((g) => list.append(h('a', { class: 'post clickable', href: '#/groups/' + g.id, style: null }, h('span', { class: 'avatar' }, icon(g.visibility === 'private' ? 'lock' : 'users')), h('div', { class: 'pbody' }, h('b', { text: g.name }), g.my_role ? h('span', { class: 'badge' }, t('groups.mine')) : null, g.visibility === 'private' ? h('span', { class: 'badge' }, icon('lock', 'sm'), t('groups.private')) : null, h('div', { class: 'small muted', text: g.description || '' }), h('div', { class: 'small muted', text: t('groups.memberCount', { n: g.member_count }) })))));
    } catch (e) { clear(list).append(empty(errText(e))); }
  }
  async function viewGroup(view, tok, id, tab = 'posts') {
    view.append(top(t('groups.title'), { back: true })); const body = h('div', {}, spinner()); view.append(body);
    let g, members;
    try { const [gs, ms] = await Promise.all([api('GET', '/api/groups'), api('GET', '/api/groups/' + id + '/members')]); g = gs.find((x) => String(x.id) === String(id)); members = ms; if (!g) throw Object.assign(new Error(), { code: 'E_NOT_FOUND' }); } catch (e) { return clear(body).append(empty(errText(e), 'users')); }
    if (!live(tok)) return; clear(body);
    const me = members.find((m) => m.user_id === S.user.id); const admin = me && me.role === 'admin';
    const act = me ? (g.owner_id === S.user.id && members.filter((m) => m.role === 'admin').length === 1 ? null : h('button', { class: 'btn', onClick: async () => { try { await api('POST', '/api/groups/' + id + '/leave', {}); toast(t('groups.left')); route(); } catch (e) { fail(e); } } }, t('groups.leave'))) : (g.visibility === 'private' ? null : h('button', { class: 'btn primary', onClick: async () => { try { await api('POST', '/api/groups/' + id + '/join', {}); toast(t('groups.joined')); route(); } catch (e) { fail(e); } } }, t('groups.join')));
    body.append(h('div', { class: 'profilehead' }, h('div', { class: 'row' }, h('h2', { class: 'grow', text: g.name }), act), h('p', { text: g.description || '' }), h('p', { class: 'small muted' }, icon('lock', 'sm'), ' ' + t('groups.localNote'))));
    const holder = h('div', {}); const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const draw = () => {
      clear(tabs); [['posts', 'groups.posts'], ['files', 'groups.files'], ['members', 'groups.members']].forEach(([k, key]) => tabs.append(h('button', { role: 'tab', 'aria-selected': String(tab === k), onClick: () => { tab = k; draw(); } }, t(key))));
      clear(holder);
      if (tab === 'posts') {
        const feed = pagedList(async (c) => { const { data, headers } = await apiRaw('GET', '/api/groups/' + id + '/posts' + (c ? '?cursor=' + encodeURIComponent(c) : '')); return { items: data, next_cursor: headers.get('X-Next-Cursor') }; }, { empty: t('groups.noPosts') });
        holder.append(me ? composer({ groupId: Number(id), noVisibility: true, placeholder: t('groups.postPlaceholder'), onPosted: () => feed.reload() }) : null, feed);
      } else if (tab === 'files') {
        const l = h('div', {}, spinner()); holder.append(l);
        api('GET', '/api/groups/' + id + '/files').then((fs) => { clear(l); if (!fs.length) return l.append(empty(t('groups.noFiles'), 'file')); fs.forEach((f) => l.append(h('a', { class: 'filechip', href: f.file_url + (f.file_url.startsWith('/media/') ? '?download=1' : ''), download: '' }, icon('file'), h('span', { class: 'grow' }, f.name || f.file_url.split('/').pop()), h('span', { class: 'small muted', text: f.username + ' · ' + timeAgo(f.created_at) }), icon('download', 'sm')))); }).catch((e) => clear(l).append(empty(errText(e))));
      } else {
        members.forEach((m) => holder.append(h('div', { class: 'post' }, avatar(m, 'sm'), h('div', { class: 'pbody' }, h('a', { href: '#/u/' + encodeURIComponent(m.username) }, h('b', { text: m.display_name || m.username })), ' ', h('span', { class: 'badge' }, t('groups.role.' + m.role)),
          admin ? h('div', { class: 'row wrap' }, h('button', { class: 'btn sm', onClick: async () => { try { await api('PATCH', '/api/groups/' + id + '/members/' + m.user_id, { role: m.role === 'admin' ? 'member' : 'admin' }); route(); } catch (e) { fail(e); } } }, m.role === 'admin' ? t('groups.makeMember') : t('groups.makeAdmin')), h('button', { class: 'btn sm danger', onClick: async () => { try { await api('DELETE', '/api/groups/' + id + '/members/' + m.user_id); route(); } catch (e) { fail(e); } } }, t('groups.remove'))) : null))));
        if (admin) api('GET', '/api/users').then((us) => { const cand = us.filter((u) => ['local', 'legacy'].includes(u.status) && !members.some((m) => m.user_id === u.id)); if (!cand.length) return; const sel = h('select', { 'aria-label': t('groups.addMember') }, h('option', { value: '' }, t('groups.pick')), cand.map((u) => h('option', { value: u.id }, u.display_name || u.username))); holder.append(h('div', { class: 'page row' }, sel, h('button', { class: 'btn', onClick: async () => { if (!sel.value) return; try { await api('POST', '/api/groups/' + id + '/members', { user_id: Number(sel.value) }); route(); } catch (e) { fail(e); } } }, t('groups.addMember')))); }).catch(() => {});
      }
    };
    draw(); body.append(tabs, holder);
  }

  // ---------- network ----------
  async function viewNetwork(view, tok) {
    view.append(top(t('net.title')));
    const body = h('div', { class: 'page col' });
    view.append(body);
    const owner = S.user.is_primary;

    // Stable sections — forms are built once so a 10s status poll does not wipe inputs
    const intro = h('p', { class: 'muted', text: t('net.intro') });
    const statusBox = h('div', { class: 'card row' }, h('div', { class: 'spinner', role: 'status' }));
    const presenceBox = h('div', { class: 'card col', id: 'presence-card' });
    const remoteBox = h('div', { class: 'card col' });
    const connectBox = h('div', { class: 'card col' });
    const peersBox = h('div', { class: 'col' });
    body.append(intro, statusBox, presenceBox, remoteBox, connectBox, peersBox);

    let builtForms = false;
    let lastUrl = '';

    const renderRemote = (info, s) => {
      const url = (info && info.publicUrl) || (s.self && s.self.endpoint) || '';
      lastUrl = url;
      clear(remoteBox);
      remoteBox.append(h('div', { class: 'row' }, icon('globe', 'sm'), h('b', { class: 'grow', text: t('remote.title') })));
      if (url) {
        remoteBox.append(
          h('code', { class: 'id', text: url }),
          h('div', { class: 'row wrap' },
            h('button', { class: 'btn sm', onClick: () => copy(url, t('copied')) }, icon('link', 'sm'), t('copy')),
            h('button', { class: 'btn sm', onClick: async () => { try { await api('GET', '/api/remote/info?refresh=1'); refresh({ soft: true }); } catch (e) { fail(e); } } }, t('remote.refresh'))
          ),
          h('p', { class: 'small muted', text: t('remote.help') })
        );
      } else {
        remoteBox.append(h('p', { class: 'small muted', text: t('remote.missing') }));
      }
      // Always show invite-oriented public address block
      remoteBox.append(
        h('h3', { text: t('net.publicAddressTitle') }),
        h('p', { class: 'small muted', text: t('net.publicAddressHelp') })
      );
      if (url) {
        remoteBox.append(
          h('div', { class: 'row wrap' },
            h('code', { class: 'grow', text: url }),
            h('button', { class: 'btn sm', type: 'button', onClick: async () => {
              try { await navigator.clipboard.writeText(url); toast(t('copied')); } catch (_) { toast(url); }
            } }, t('copy'))
          )
        );
      }
      if (!owner) return;
      // One place for override + optional public URL password (no second public-URL field elsewhere)
      const ovIn = h('input', { type: 'text', id: 'ns-pub', value: '', placeholder: url || 'http://IP:28090', maxlength: '300' });
            // Load saved override once into the field without fighting the user while typing
      api('GET', '/api/network/settings').then((ns) => {
        if (!live(tok)) return;
        if (ns.public_url_override && document.activeElement !== ovIn) ovIn.value = ns.public_url_override;
              }).catch(() => {});
      remoteBox.append(
        h('details', {},
          h('summary', { text: t('net.settingsTitle') }),
          h('div', { class: 'col' },
            h('label', { for: 'ns-pub' }, t('net.publicUrl')),
            ovIn,
            h('p', { class: 'small muted', text: t('net.publicUrlHelp') }),
            
            
            
            h('label', { for: 'ns-inv-pw' }, t('net.invitePassword')),
            h('input', { type: 'password', id: 'ns-inv-pw', placeholder: t('net.invitePasswordPh'), autocomplete: 'new-password', maxlength: '100' }),
            h('p', { class: 'small muted', text: t('net.invitePasswordHelp') }),
            h('div', { class: 'row wrap' },
              h('button', { class: 'btn primary sm', type: 'button', onClick: async () => {
                try {
                  const invEl = document.getElementById('ns-inv-pw');
                  const payload = { public_url_override: ovIn.value.trim() };
                  if (invEl && invEl.value) payload.invite_password = invEl.value;
                  await api('POST', '/api/network/settings', payload);
                  if (invEl) invEl.value = '';
                  toast(t('save'));
                  refresh({ soft: true });
                } catch (x) { fail(x); }
              } }, t('save')),
              h('button', { class: 'btn sm', type: 'button', onClick: async () => {
                try {
                  await api('POST', '/api/network/settings', { invite_password: '' });
                  toast(t('net.invitePasswordCleared'));
                  refresh({ soft: true });
                } catch (x) { fail(x); }
              } }, t('net.clearInvitePassword'))
            )
          )
        )
      );
    };

    const ensureConnectForm = () => {
      if (builtForms || !owner) return;
      builtForms = true;
      clear(connectBox);
      const inp = h('input', { type: 'text', id: 'peer-url', placeholder: t('net.addPlaceholder'), 'aria-label': t('net.add'), maxlength: '300' });
      connectBox.append(
        h('b', { text: t('net.add') }),
        h('div', { class: 'row' }, inp, h('button', { class: 'btn primary', type: 'button', onClick: async () => {
          const raw = inp.value.trim(); if (!raw) return;
          try {
            // Single path: add peer (also records intro_peer when label is "default")
            if (raw.toLowerCase() === 'default') {
              await api('POST', '/api/network/settings', { intro_peer: 'default', network_setup_done: true });
            } else {
              await api('POST', '/api/peers', { endpoint: raw });
            }
            inp.value = '';
            toast(t('net.syncing'));
            refresh({ soft: true });
          } catch (x) { fail(x); }
        } }, icon('plus', 'sm'), t('net.add'))),
        h('p', { class: 'small muted', text: t('net.addHelp') })
      );
      connectBox.append(h('button', { type: 'button', class: 'btn sm', onClick: async () => {
        try {
          const r = await api('GET', '/api/network/invite');
          if (navigator.clipboard && r.invite) { await navigator.clipboard.writeText(r.invite); toast(t('net.inviteCopied')); }
          else toast(r.invite || '');
        } catch (e) { fail(e); }
      } }, t('net.copyInvite')));

    };

    const renderPeers = (s) => {
      clear(peersBox);
      if (!s.peers || !s.peers.length) {
        peersBox.append(empty(t('net.none'), 'globe'));
        return;
      }
      s.peers.forEach((p) => {
        const act = (label, fn, cls) => h('button', { class: 'btn sm ' + (cls || ''), onClick: async () => { try { await fn(); refresh({ soft: true }); } catch (e) { fail(e); } } }, label);
        const code = p.machine_code || machineCode(p);
        const title = (p.name && p.name !== p.endpoint && !/\d{1,3}(?:\.\d{1,3}){3}/.test(p.name)) ? p.name : code;
        peersBox.append(h('div', { class: 'peer' },
          h('span', { class: 'dotstat ' + p.health, title: t('net.health.' + p.health) }),
          h('div', { class: 'grow' },
            h('b', { text: title }),
            h('div', { class: 'small muted' }, h('code', { text: code }), ' · ', t('net.machineCode')),
            h('div', { class: 'row wrap small' },
              h('span', { class: 'badge ' + (p.health === 'healthy' ? 'ok' : p.health === 'degraded' ? 'warn' : p.health === 'pending' ? '' : 'bad'), text: t('net.health.' + p.health) }),
              h('span', { class: 'muted', text: t('net.lastSync', { t: p.last_sync_at ? timeAgo(new Date(p.last_sync_at).toISOString()) : t('net.never') }) }),
              h('span', { class: 'muted', text: t('net.received', { n: p.events_received }) }),
              p.events_rejected ? h('span', { class: 'badge warn', text: t('net.rejected', { n: p.events_rejected }) }) : null
            ),
            p.last_error && p.health !== 'healthy' ? h('div', { class: 'small', text: t('net.error', { e: peerErrorText(p.last_error) }) }) : null
          ),
          h('div', { class: 'row wrap' },
            act(t('net.syncNow'), () => api('POST', '/api/peers/' + p.id + '/sync', {})),
            p.state === 'discovered' ? act(t('net.trust'), () => api('PATCH', '/api/peers/' + p.id, { state: 'trusted' })) : null,
            p.state === 'blocked' ? act(t('net.unblock'), () => api('PATCH', '/api/peers/' + p.id, { state: 'trusted' })) : act(t('net.block'), () => api('PATCH', '/api/peers/' + p.id, { state: 'blocked' }), 'danger'),
            act(t('net.remove'), () => api('DELETE', '/api/peers/' + p.id))
          ),
          h('details', {},
            h('summary', { text: t('net.advanced') }),
            h('div', { class: 'kv small' },
              h('span', { text: 'account' }), h('code', { text: p.account_id || '—' }),
              h('span', { text: 'state' }), h('code', { text: p.state + (p.pinned ? ' (pinned)' : '') }),
              h('span', { text: 'cursor' }), h('code', { text: String(p.cursor) }),
              h('span', { text: 'failures' }), h('code', { text: String(p.fail_streak) })
            )
          )
        ));
      });
    };

    const refresh = async ({ soft } = {}) => {
      if (!live(tok)) return;
      let s;
      try { s = await api('GET', '/api/sync/status'); } catch (e) {
        if (!soft) clear(statusBox).append(empty(errText(e)));
        return;
      }
      if (!live(tok)) return;
      S.sync = s;

      const sum = A.syncSummary();
      const badgeText = s.total
        ? (s.healthy === s.total ? t('net.synced') : t('net.summary', { h: String(s.healthy), t: String(s.total) }))
        : t('net.ready');
      clear(statusBox);
      statusBox.append(
        icon('globe'),
        h('b', { class: 'grow', text: s.total ? sum.text : t('net.ready') }),
        h('span', { class: 'badge ' + (s.total ? sum.cls : ''), text: badgeText })
      );

      // Phase 8 — compact P2P / resilient network strip (non-technical)
      // Guarded: never let diagnostics crash the Network page (white screen)
      const p2p = s.p2p || null;
      try { if (p2p) {
        const stateKey = String(p2p.state || 'OFFLINE');
        const stateLabel = t('net.p2p.state.' + stateKey) || stateKey;
        const stateCls = stateKey === 'GLOBAL_ONLINE' ? 'ok'
          : (stateKey === 'OFFLINE' ? 'bad'
            : (stateKey === 'RECOVERING' || stateKey === 'GLOBAL_DEGRADED' ? 'warn' : ''));
        const transportKey = String(p2p.preferred_transport || 'store_and_forward');
        const transportLabel = t('net.p2p.transport.' + transportKey) || transportKey;
        const chips = h('div', { class: 'row wrap small net-p2p-strip' },
          h('span', { class: 'badge ' + stateCls, title: t('net.p2p.stateHelp'), text: stateLabel }),
          h('span', { class: 'muted', text: t('net.p2p.peers', { n: String(p2p.peers || 0) }) }),
          (p2p.lan_peers > 0) ? h('span', { class: 'muted', text: t('net.p2p.lan', { n: String(p2p.lan_peers) }) }) : null,
          (p2p.relay_connections > 0) ? h('span', { class: 'muted', text: t('net.p2p.relay', { n: String(p2p.relay_connections) }) }) : null,
          (p2p.pending_messages > 0) ? h('span', { class: 'badge warn', text: t('net.p2p.queue', { n: String(p2p.pending_messages) }) }) : null,
          h('span', { class: 'muted', text: t('net.p2p.via', { m: transportLabel }) })
        );
        // Compact card under the federation status — does not dominate the page
        let strip = body.querySelector('.net-p2p-card');
        if (!strip) {
          strip = h('div', { class: 'card col net-p2p-card' });
          statusBox.after(strip);
        }
        clear(strip);
        strip.append(
          h('div', { class: 'row' },
            icon('wifi', 'sm'),
            h('b', { class: 'grow', text: t('net.p2p.title') }),
            h('span', { class: 'badge ' + stateCls, text: stateLabel })
          ),
          chips
        );
        if (p2p.last_sync_hint) {
          strip.append(h('div', { class: 'small muted', text: t('net.p2p.started', { t: timeAgo(p2p.last_sync_hint) }) }));
        }

        // Bootstrap & Discovery diagnostics (compact)
        const bs = p2p.bootstrap;
        if (bs) {
          let bcard = body.querySelector('.net-bootstrap-card');
          if (!bcard) {
            bcard = h('div', { class: 'card col net-bootstrap-card' });
            strip.after(bcard);
          }
          clear(bcard);
          const bsState = String(bs.state || 'NETWORK_INITIALIZING');
          const bsLabel = t('net.bootstrap.state.' + bsState) || bsState;
          const bsCls = bsState === 'NETWORK_JOINED' ? 'ok'
            : (bsState === 'WAITING_FOR_FIRST_PEER' || bsState === 'NETWORK_INITIALIZING' ? 'warn' : '');
          bcard.append(
            h('div', { class: 'row' },
              icon('globe', 'sm'),
              h('b', { class: 'grow', text: t('net.bootstrap.title') }),
              h('span', { class: 'badge ' + bsCls, text: bsLabel })
            ),
            h('div', { class: 'row wrap small' },
              h('span', { class: 'muted', text: t('net.bootstrap.known', { n: String(bs.known_peers || 0) }) }),
              h('span', { class: 'muted', text: t('net.bootstrap.discovered', { n: String(bs.cannoi_discovered || 0) }) }),
              (bs.cannoi_connected > 0)
                ? h('span', { class: 'badge ok', text: t('net.bootstrap.joined', { n: String(bs.cannoi_connected) }) })
                : h('span', { class: 'muted', text: t('net.bootstrap.waiting') })
            )
          );
        }
      }
      } catch (p2pErr) { try { console.warn('p2p ui', p2pErr); } catch (_) {} }

      // Global Presence status (simple, non-technical)
      try {
        const ps = await api('GET', '/api/presence/status');
        clear(presenceBox);
        const state = (ps && ps.state) || 'local';
        const label = state === 'online' ? t('presence.online')
          : state === 'error' ? t('presence.error')
          : state === 'local' ? t('presence.local')
          : t('presence.' + state) || state;
        const cls = state === 'online' ? 'ok' : (state === 'error' ? 'warn' : '');
        presenceBox.append(
          h('div', { class: 'row' }, icon('users', 'sm'), h('b', { class: 'grow', text: t('presence.title') }),
            h('span', { class: 'badge ' + cls, text: label })
          ),
          h('p', { class: 'small muted', text: t('presence.help') })
        );
        if (owner) {
          const enabled = !!(ps && ps.enabled !== false && state !== 'local');
          const searchable = !!(ps && ps.searchable !== false);
          const row = h('div', { class: 'row wrap' });
          row.append(
            h('label', { class: 'row', style: 'gap:6px;align-items:center' },
              h('input', { type: 'checkbox', checked: enabled ? 'checked' : undefined, onChange: async (ev) => {
                try {
                  await api('PATCH', '/api/presence/settings', { enabled: !!ev.target.checked });
                  toast(t('save'));
                  refresh({ soft: true });
                } catch (e) { fail(e); }
              }}),
              h('span', { class: 'small', text: t('presence.enable') })
            ),
            h('label', { class: 'row', style: 'gap:6px;align-items:center' },
              h('input', { type: 'checkbox', checked: searchable ? 'checked' : undefined, onChange: async (ev) => {
                try {
                  await api('PATCH', '/api/presence/settings', { searchable: !!ev.target.checked });
                  toast(t('save'));
                  refresh({ soft: true });
                } catch (e) { fail(e); }
              }}),
              h('span', { class: 'small', text: t('presence.searchable') })
            )
          );
          presenceBox.append(row);
        }
      } catch (pe) {
        clear(presenceBox);
        presenceBox.append(h('div', { class: 'row' }, icon('users', 'sm'), h('b', { class: 'grow', text: t('presence.title') }),
          h('span', { class: 'badge', text: t('presence.local') })),
          h('p', { class: 'small muted', text: t('presence.help') })
        );
      }

      if (s.ledger) {
        statusBox.append(h('span', { class: 'small muted', text: t('net.ledger', { n: s.ledger.events }) }));
      }

      if (!s.enabled) {
        clear(connectBox);
        clear(peersBox);
        peersBox.append(h('div', { class: 'card', text: t('net.disabled') }));
        return;
      }

      // Remote URL: only rebuild when URL / password flag changes, or first paint — never every 10s if unchanged
      let info = null;
      try { info = await api('GET', '/api/remote/info'); } catch (e) { info = null; }
      const url = (info && info.publicUrl) || (s.self && s.self.endpoint) || '';
      const needRemote = !soft || url !== lastUrl || !remoteBox.childNodes.length;
      if (needRemote) renderRemote(info, s);

      if (owner) ensureConnectForm();
      else if (!builtForms) { clear(connectBox); connectBox.append(h('p', { class: 'small muted', text: t('net.ownerOnly') })); builtForms = true; }

      renderPeers(s);
    };

    await refresh({ soft: false });
    // Soft poll: update status + peer list only — does not clear form inputs
    const timer = setInterval(() => {
      if (!live(tok)) { clearInterval(timer); return; }
      refresh({ soft: true });
    }, 15000);
  }

  // ---------- assistant ----------
  async function viewAssistant(view, tok) {
    // Universal AI + Feedback UI embedded in Assistant (More menu) — no floating FAB/widget
    view.append(top(t('assistant.title')));
    const page = h('div', { class: 'page col' });
    view.append(page);

    const tabs = h('div', { class: 'row wrap', role: 'tablist', 'aria-label': t('assistant.title') });
    const panel = h('div', { class: 'col' });
    page.append(tabs, panel);

    let active = 'chat';
    let history = [];
    try { history = JSON.parse(sessionStorage.getItem('hub.chat') || '[]'); } catch (e) { history = []; }

    const mkTab = (id, label, badgeId) => {
      const b = h('button', {
        class: 'btn sm',
        role: 'tab',
        'aria-selected': 'false',
        type: 'button',
        onClick: () => show(id),
      }, label);
      if (badgeId) {
        const badge = h('span', { id: badgeId, class: 'badge bad badge-gap', hidden: true });
        b.append(badge);
      }
      return b;
    };
    const tabChat = mkTab('chat', t('assistant.tabChat'));
    const tabFb = mkTab('feedback', t('assistant.tabFeedback'), 'fbTabBadge');
    const tabSet = mkTab('settings', t('assistant.tabSettings'));
    const tabLogs = mkTab('logs', t('assistant.tabLogs'));
    tabs.append(tabChat, tabFb, tabSet, tabLogs);
    const tabMap = { chat: tabChat, feedback: tabFb, settings: tabSet, logs: tabLogs };

    const setUnread = (n) => {
      const el = document.getElementById('fbTabBadge');
      const count = Number(n) || 0;
      if (!el) return;
      if (count > 0) { el.hidden = false; el.textContent = count > 9 ? '9+' : String(count); }
      else { el.hidden = true; el.textContent = ''; }
    };

    const show = (id) => {
      active = id;
      Object.keys(tabMap).forEach((k) => tabMap[k].setAttribute('aria-selected', k === id ? 'true' : 'false'));
      Object.keys(tabMap).forEach((k) => tabMap[k].classList.toggle('primary', k === id));
      clear(panel);
      if (id === 'chat') renderChat();
      else if (id === 'feedback') renderFeedback();
      else if (id === 'settings') renderAiSettings();
      else renderLogs();
    };

    // ---- Chat ----
    function renderChat() {
      let st = { provider: 'local' };
      const statusRow = h('div', { class: 'row wrap small' });
      const log = h('div', { class: 'chat', role: 'log', 'aria-live': 'polite' });
      const bubble = (role, text) => log.append(h('div', { class: 'bubble ' + (role === 'user' ? 'me' : 'bot') }, text));
      const input = h('textarea', { placeholder: t('assistant.placeholder'), 'aria-label': t('assistant.placeholder'), rows: '2', maxlength: '2000', onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } } });
      let busy = false;
      const send = async (text) => {
        text = (text || input.value).trim(); if (!text || busy) return;
        busy = true; input.value = ''; bubble('user', text); history.push({ role: 'user', content: text });
        const wait = h('div', { class: 'bubble bot muted', text: t('assistant.thinking') }); log.append(wait); wait.scrollIntoView({ block: 'nearest' });
        try {
          let reply = '';
          try {
            const r = await api('POST', '/api/ai/chat', {
              message: text,
              history: history.slice(-11, -1).map((m) => ({ role: m.role === 'bot' ? 'assistant' : m.role, content: m.content })),
              context: { lang: I18n.lang, screen: 'assistant' },
            });
            reply = r.reply || r.text || r.message || '';
          } catch (aiErr) {
            const r = await api('POST', '/api/assistant/chat', { message: text, lang: I18n.lang, history: history.slice(-11, -1) });
            reply = r.reply || '';
          }
          wait.remove(); bubble('bot', reply || t('assistant.hello')); history.push({ role: 'assistant', content: reply });
        } catch (e) { wait.remove(); bubble('bot', errText(e)); }
        finally { busy = false; try { sessionStorage.setItem('hub.chat', JSON.stringify(history.slice(-30))); } catch (e) { /* ignore */ } }
      };
      api('GET', '/api/ai/status').then((a) => {
        if (!live(tok)) return;
        if (a && a.configured) st = { provider: 'external', model: (a.settings && a.settings.model) || 'auto' };
        clear(statusRow);
        statusRow.append(
          icon(st.provider === 'external' ? 'sparkle' : 'bot', 'sm'),
          h('span', { class: 'badge', text: st.provider === 'external' ? t('assistant.external', { m: st.model || 'auto' }) : t('assistant.local') })
        );
      }).catch(() => {});
      if (!history.length) bubble('bot', t('assistant.hello'));
      else history.forEach((m) => bubble(m.role === 'user' ? 'user' : 'bot', m.content));
      panel.append(
        statusRow,
        h('div', { class: 'chips' }, ['s1', 's2', 's3', 's4'].map((k) => h('button', { type: 'button', onClick: () => send(t('assistant.' + k)) }, t('assistant.' + k)))),
        h('div', { class: 'card' }, log),
        h('div', { class: 'row' }, input, h('button', { class: 'btn primary', 'aria-label': t('assistant.send'), onClick: () => send() }, icon('send', 'sm'), t('assistant.send')))
      );
    }

    // ---- Feedback ----
    async function renderFeedback() {
      const list = h('div', { class: 'col' });
      const donate = h('div', { class: 'card col', hidden: true });
      const formErr = h('p', { class: 'badge bad hidden', role: 'alert' });
      const typeSel = h('select', { id: 'fb-type' },
        h('option', { value: 'bug' }, t('assistant.fbBug')),
        h('option', { value: 'improvement' }, t('assistant.fbImprove')),
        h('option', { value: 'question' }, t('assistant.fbQuestion'))
      );
      const rating = h('select', { id: 'fb-rating' },
        [5, 4, 3, 2, 1].map((n) => h('option', { value: String(n) }, String(n)))
      );
      const msg = h('textarea', { id: 'fb-msg', rows: '3', maxlength: '2000', placeholder: t('assistant.fbMessage') });
      const sync = async () => {
        let anonymousId = localStorage.getItem('hub.fb.aid');
        if (!anonymousId) { anonymousId = (crypto.randomUUID ? crypto.randomUUID() : 'a' + Date.now()); localStorage.setItem('hub.fb.aid', anonymousId); }
        try {
          const r = await api('GET', '/api/feedback/sync?anonymous_id=' + encodeURIComponent(anonymousId));
          if (!live(tok)) return;
          const notices = (r && r.notices) || [];
          setUnread(notices.length);
          clear(list);
          if (!notices.length) list.append(h('p', { class: 'muted small', text: t('assistant.fbNoNotices') }));
          else notices.forEach((n) => {
            list.append(h('div', { class: 'card col' },
              h('b', { text: n.title || n.subject || t('assistant.tabFeedback') }),
              h('p', { class: 'small', text: n.body || n.message || '' }),
              h('button', { class: 'btn sm', type: 'button', onClick: async () => {
                try { await api('POST', '/api/feedback/read/' + encodeURIComponent(n.id)); sync(); } catch (e) { fail(e); }
              } }, t('assistant.fbMarkRead'))
            ));
          });
          // Donate only from sync — never hard-coded
          clear(donate);
          if (r && r.donate) {
            donate.hidden = false;
            donate.append(h('b', { text: t('assistant.fbDonate') }));
            const rows = [];
            const flat = (src, prefix) => {
              if (src == null) return;
              if (typeof src === 'string' || typeof src === 'number') { if (String(src).trim()) rows.push([prefix || 'info', String(src)]); return; }
              if (Array.isArray(src)) { src.forEach((v, i) => flat(v, prefix + ' ' + (i + 1))); return; }
              if (typeof src === 'object') Object.keys(src).forEach((k) => flat(src[k], prefix ? prefix + ' · ' + k : k));
            };
            flat(r.donate, '');
            rows.slice(0, 12).forEach(([k, v]) => donate.append(h('div', { class: 'kv small' }, h('span', { text: k }), h('code', { text: v }))));
          } else donate.hidden = true;
        } catch (e) {
          clear(list);
          list.append(h('p', { class: 'muted small', text: t('assistant.fbOffline') }));
        }
      };
      panel.append(
        h('p', { class: 'muted small', text: t('assistant.fbIntro') }),
        list, donate,
        h('form', { class: 'card col', onSubmit: async (e) => {
          e.preventDefault(); formErr.classList.add('hidden');
          try {
            let anonymousId = localStorage.getItem('hub.fb.aid') || '';
            await api('POST', '/api/feedback', {
              type: typeSel.value,
              rating: Number(rating.value),
              message: msg.value.trim(),
              anonymous_id: anonymousId,
              lang: I18n.lang,
            });
            msg.value = '';
            toast(t('assistant.fbSent'));
            sync();
          } catch (x) { formErr.textContent = errText(x); formErr.classList.remove('hidden'); }
        } },
          h('b', { text: t('assistant.fbSend') }),
          h('label', { for: 'fb-type' }, t('assistant.fbType')), typeSel,
          h('label', { for: 'fb-rating' }, t('assistant.fbRating')), rating,
          h('label', { for: 'fb-msg' }, t('assistant.fbMessage')), msg,
          formErr,
          h('button', { class: 'btn primary', type: 'submit' }, t('assistant.fbSend'))
        )
      );
      sync();
    }

    // ---- AI Settings (owner) ----
    async function renderAiSettings() {
      if (!S.user.is_primary) {
        panel.append(h('p', { class: 'muted', text: t('assistant.settingsOwnerOnly') }));
        return;
      }
      let settings = {};
      let catalog = { providers: [] };
      try { settings = await api('GET', '/api/ai/settings'); } catch (e) { /* */ }
      try { catalog = await api('GET', '/api/ai/catalog'); } catch (e) { /* */ }
      const providers = (catalog.providers || []).map((p) => p.id || p);
      const prov = h('select', { id: 'ai-prov' },
        h('option', { value: 'none' }, 'none'),
        providers.map((id) => h('option', { value: id, selected: settings.provider === id }, id))
      );
      const apiKey = h('input', { id: 'ai-key', type: 'password', placeholder: settings.maskedKey || t('optional'), autocomplete: 'off' });
      const baseUrl = h('input', { id: 'ai-base', type: 'text', value: settings.baseUrl || '', placeholder: 'https://…/v1', maxlength: '300' });
      const model = h('input', { id: 'ai-model', type: 'text', value: settings.model || 'auto', maxlength: '120' });
      const mode = h('select', { id: 'ai-mode' },
        ['cloud_enabled', 'balanced', 'prefer_local', 'local_only', 'custom'].map((m) => h('option', { value: m, selected: (settings.mode || 'cloud_enabled') === m }, m))
      );
      const modelsBox = h('div', { class: 'col small muted' });
      const msg = h('p', { class: 'small muted' });
      panel.append(h('form', { class: 'card col', onSubmit: async (e) => {
        e.preventDefault();
        try {
          const body = { provider: prov.value, baseUrl: baseUrl.value.trim(), model: model.value.trim() || 'auto', mode: mode.value };
          if (apiKey.value && !apiKey.value.includes('…')) body.apiKey = apiKey.value.trim();
          const r = await api('POST', '/api/ai/settings', body);
          msg.textContent = t('save') + (r.settings && r.settings.maskedKey ? ' · ' + r.settings.maskedKey : '');
          toast(t('save'));
        } catch (x) { fail(x); }
      } },
        h('b', { text: t('assistant.tabSettings') }),
        h('label', { for: 'ai-prov' }, 'Provider'), prov,
        h('label', { for: 'ai-key' }, 'API key'), apiKey,
        h('label', { for: 'ai-base' }, 'Base URL'), baseUrl,
        h('label', { for: 'ai-model' }, 'Model'), model,
        h('label', { for: 'ai-mode' }, 'Mode'), mode,
        h('div', { class: 'row wrap' },
          h('button', { class: 'btn primary', type: 'submit' }, t('save')),
          h('button', { class: 'btn sm', type: 'button', onClick: async () => {
            try { const r = await api('POST', '/api/ai/test', {}); msg.textContent = JSON.stringify(r).slice(0, 200); toast(t('assistant.testOk')); }
            catch (x) { fail(x); }
          } }, t('assistant.testConn')),
          h('button', { class: 'btn sm', type: 'button', onClick: async () => {
            try {
              const r = await api('GET', '/api/ai/models');
              clear(modelsBox);
              const list = (r.models || r || []);
              (Array.isArray(list) ? list : []).slice(0, 40).forEach((m) => modelsBox.append(h('code', { text: typeof m === 'string' ? m : (m.id || m.name || JSON.stringify(m)) })));
            } catch (x) { fail(x); }
          } }, t('assistant.loadModels'))
        ),
        modelsBox, msg
      ));
    }

    // ---- Logs ----
    async function renderLogs() {
      if (!S.user.is_primary) {
        panel.append(h('p', { class: 'muted', text: t('assistant.settingsOwnerOnly') }));
        return;
      }
      const box = h('div', { class: 'card col' });
      panel.append(
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', type: 'button', onClick: async () => {
            try {
              const r = await api('GET', '/api/ai/logs');
              clear(box);
              (r.logs || []).slice().reverse().forEach((line) => {
                box.append(h('pre', { class: 'small log-line', text: typeof line === 'string' ? line : JSON.stringify(line) }));
              });
              if (!(r.logs || []).length) box.append(h('p', { class: 'muted small', text: '—' }));
            } catch (e) { fail(e); }
          } }, t('assistant.refreshLogs')),
          h('button', { class: 'btn sm danger', type: 'button', onClick: async () => {
            try { await api('DELETE', '/api/ai/logs'); clear(box); toast(t('done')); } catch (e) { fail(e); }
          } }, t('assistant.clearLogs'))
        ),
        box
      );
      try {
        const r = await api('GET', '/api/ai/logs');
        (r.logs || []).slice().reverse().forEach((line) => {
          box.append(h('pre', { class: 'small log-line', text: typeof line === 'string' ? line : JSON.stringify(line) }));
        });
      } catch (e) { /* */ }
    }

    show('chat');
    // Periodic feedback sync for badge while on this screen
    const fbTimer = setInterval(() => {
      if (!live(tok)) { clearInterval(fbTimer); return; }
      if (active !== 'feedback') {
        let anonymousId = localStorage.getItem('hub.fb.aid') || '';
        if (!anonymousId) return;
        api('GET', '/api/feedback/sync?anonymous_id=' + encodeURIComponent(anonymousId)).then((r) => {
          setUnread(((r && r.notices) || []).length);
        }).catch(() => {});
      }
    }, 60000);
  }

  async function viewSettings(view, tok) {
    view.append(top(t('settings.title'))); const body = h('div', { class: 'page col' }); view.append(body);
    const sec = (title, ...k) => h('section', { class: 'card col' }, h('h2', { text: title }), ...k);
    body.append(sec(t('settings.language'), h('div', { class: 'row' }, ['en', 'vi'].map((l) => h('button', { class: 'btn' + (I18n.lang === l ? ' primary' : ''), 'aria-pressed': String(I18n.lang === l), onClick: async () => { I18n.set(l); try { await api('PATCH', '/api/me', { lang: l }); } catch (e) { /* offline ok */ } A.renderShell(); route(); } }, l === 'en' ? 'English' : 'Tiếng Việt')))));
    body.append(sec(t('settings.profile'), h('div', {}, h('button', { class: 'btn', onClick: async () => { try { editProfile(await api('GET', '/api/profiles/' + encodeURIComponent(S.user.username))); } catch (e) { fail(e); } } }, icon('edit', 'sm'), t('profile.edit')))));
    let idv; try { idv = await api('GET', '/api/identity'); } catch (e) { idv = null; }
    if (!live(tok)) return;
    if (idv) {
      const pw = h('input', { type: 'password', id: 'ex-pw', autocomplete: 'current-password' }); const pp = h('input', { type: 'password', id: 'ex-pp', autocomplete: 'new-password', minlength: '10' });
      body.append(sec(t('settings.identity'), h('p', { class: 'small muted', text: t('settings.identityHelp') }),
        h('div', { class: 'kv' }, h('span', { text: t('profile.accountId') }), h('code', { text: idv.account_id }), h('span', { text: 'ID format' }), h('code', { text: idv.id_format }), h('span', { text: t('settings.sequence', { n: idv.sequence }) }), h('span')),
        h('div', {}, h('button', { class: 'btn sm', onClick: () => copy(idv.account_id) }, icon('link', 'sm'), t('copy'))),
        idv.history_pending ? h('div', { class: 'banner warn col' }, h('span', { text: t('settings.historyPending') }), h('button', { class: 'btn sm', onClick: async () => { const p = prompt(t('settings.confirmPassword')); if (!p) return; try { await api('POST', '/api/identity/start-fresh', { password: p }); route(); } catch (e) { fail(e); } } }, t('settings.startFresh'))) : null,
        h('details', {}, h('summary', { text: t('settings.exportKey') }), h('div', { class: 'col' }, h('p', { class: 'small muted', text: t('settings.exportHelp') }), h('label', { for: 'ex-pw' }, t('settings.confirmPassword')), pw, h('label', { for: 'ex-pp' }, t('settings.exportPass')), pp,
          h('div', {}, h('button', { class: 'btn', onClick: async () => { try { const blob = await api('POST', '/api/identity/export', { password: pw.value, export_passphrase: pp.value }); const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(blob, null, 2)], { type: 'application/json' })), download: 'community-hub-identity-' + blob.account_id.slice(5, 13) + '.json' }); document.body.append(a); a.click(); a.remove(); pw.value = pp.value = ''; toast(t('settings.exportDone')); } catch (e) { fail(e); } } }, icon('key', 'sm'), t('settings.exportKey'))))),
        S.user.is_primary ? h('div', { class: 'col' },
          h('button', { class: 'btn', onClick: async () => {
            const p = prompt(t('settings.confirmPassword')); if (!p) return;
            try {
              const r = await api('POST', '/api/admin/backup', { password: p });
              const dlHeaders = {};
              if (UI.net && UI.net.sessionToken) dlHeaders['X-Hub-Session'] = UI.net.sessionToken;
              const res = await fetch(r.download, { credentials: 'include', headers: dlHeaders });
              if (!res.ok) throw new Error('download failed');
              const blob = await res.blob();
              const a = document.createElement('a');
              const name = (r.path || 'backup.zip').split('/').pop();
              a.href = URL.createObjectURL(blob);
              a.download = name;
              document.body.appendChild(a); a.click(); a.remove();
              setTimeout(() => URL.revokeObjectURL(a.href), 5000);
              toast(t('settings.backupDownloadedStats', { posts: String(r.posts || 0), media: String(r.media || 0), events: String(r.events || 0) }));
            } catch (e) { fail(e); }
          } }, icon('download', 'sm'), t('settings.backup')),
          h('p', { class: 'small muted', text: t('settings.backupHelp') }),
          h('label', { class: 'btn sm', for: 'restore-zip' }, t('settings.restoreZip')),
          h('input', { type: 'file', id: 'restore-zip', accept: '.zip,application/zip', class: 'hidden', onChange: async (ev) => {
            const file = ev.target.files && ev.target.files[0]; if (!file) return;
            const p = prompt(t('settings.confirmPassword')); if (!p) { ev.target.value = ''; return; }
            if (!confirm(t('settings.restoreConfirm'))) { ev.target.value = ''; return; }
            try {
              const form = new FormData();
              form.append('password', p);
              form.append('file', file);
              await api('POST', '/api/admin/restore', undefined, { form });
              toast(t('settings.restoreDone'));
              setTimeout(() => location.reload(), 1000);
            } catch (e) { fail(e); }
            finally { ev.target.value = ''; }
          } })
        ) : null));

    }
    const cur = h('input', { type: 'password', id: 'pw-cur', autocomplete: 'current-password' }); const nw = h('input', { type: 'password', id: 'pw-new', autocomplete: 'new-password', minlength: '8' });
    body.append(sec(t('settings.password'), h('label', { for: 'pw-cur' }, t('settings.currentPassword')), cur, h('label', { for: 'pw-new' }, t('settings.newPassword')), nw, h('div', {}, h('button', { class: 'btn', onClick: async () => { try { await api('POST', '/api/me/password', { current: cur.value, next: nw.value }); cur.value = nw.value = ''; toast(t('settings.passwordChanged')); } catch (e) { fail(e); } } }, t('save')))));
    for (const [key, path, title] of [['blocks', '/api/blocks', 'settings.blocked'], ['mutes', '/api/mutes', 'settings.muted']]) {
      try { const r = await api('GET', path); body.append(sec(t(title), r.items.length ? r.items.map((x) => h('div', { class: 'row' }, h('span', { class: 'grow', text: x.display_name || x.username || shortId(x.account_id) }), h('button', { class: 'btn sm', onClick: async () => { try { await api('DELETE', path, { account_id: x.account_id }); route(); } catch (e) { fail(e); } } }, t(key === 'blocks' ? 'profile.unblock' : 'profile.unmute')))) : h('p', { class: 'muted small', text: t('settings.none') }))); } catch (e) { /* skip */ }
    }
    if (S.user.is_primary) { try { const r = await api('GET', '/api/admin/reports'); body.append(sec(t('settings.reports'), r.items.length ? r.items.slice(0, 20).map((x) => h('div', { class: 'small', text: (x.post_id ? '#' + x.post_id : shortId(x.account_id)) + ' — ' + timeAgo(new Date(x.created_at).toISOString()) })) : h('p', { class: 'muted small', text: t('settings.none') }))); } catch (e) { /* skip */ } }
    body.append(sec(t('settings.about'), h('p', { class: 'small', text: t('settings.aboutText') }), h('p', { class: 'small muted', text: 'Community Hub v' + (S.session.version || '') })), h('div', {}, h('button', { class: 'btn danger', onClick: () => document.querySelector('.navfoot button, .navitem.mobile-only') && A.api('POST', '/api/logout', {}).then(() => location.reload()) }, icon('logout', 'sm'), t('auth.logout'))));
  }

  // ---------- router & boot ----------
  function route() {
    S.token++; const tok = S.token; S.onActivity = null;
    document.querySelectorAll('.menu').forEach((x) => x.remove());
    const view = $('view'); if (!view || !S.user) return;
    const raw = location.hash.replace(/^#\/?/, ''); const parts = raw.split('/'); const name = parts[0] || 'home'; let arg = ''; try { arg = decodeURIComponent(parts.slice(1).join('/')); } catch (e) { arg = ''; }
    document.querySelectorAll('.nav [data-r]').forEach((a) => { const r = a.getAttribute('data-r'); const on = r === name || (r === 'u/me' && name === 'u' && arg.toLowerCase() === S.user.username.toLowerCase()); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    clear(view);
    const R = { home: () => viewHome(view, tok), explore: () => viewExplore(view, tok), search: () => viewSearch(view, tok, arg), post: () => viewPost(view, tok, arg), u: () => viewProfile(view, tok, arg), notifications: () => viewNotifications(view, tok), bookmarks: () => viewBookmarks(view), messages: () => viewMessages(view), groups: () => (arg ? viewGroup(view, tok, arg) : viewGroups(view, tok)), network: () => viewNetwork(view, tok), assistant: () => viewAssistant(view, tok), settings: () => viewSettings(view, tok) };
    (R[name] || R.home)(); window.scrollTo(0, 0); document.title = t('app');
  }
  async function boot(keep) {
    A.S.timers.forEach(clearInterval); S.timers = [];
    const hadUser = keep && S.user;
    try {
      const sess = await api('GET', '/api/session', undefined, { quiet401: true });
      S.session = sess;
      // Prefer server user; if cookie lagged but we just logged in, keep hadUser
      if (sess && sess.user) S.user = sess.user;
      else if (!hadUser) S.user = null;
      else {
        // keep S.user from login response; merge session flags
        S.session = Object.assign({}, sess || {}, { user: S.user, setup_required: false });
      }
    } catch (e) {
      if (hadUser) {
        // Offline after login: still enter app with local session snapshot
        S.session = Object.assign({}, S.session || {}, { user: S.user, setup_required: false, network_setup_required: false });
      } else {
        const msg = errText(e);
        const hint = (e && (e.code === 'E_NETWORK' || e.status === 0))
          ? t('err.bootOffline')
          : (e && e.status >= 500 ? t('err.bootServer') : '');
        clear(document.getElementById('app')).append(h('div', { class: 'auth' }, h('div', { class: 'empty' },
          icon('wifi', 'lg'),
          h('p', { text: msg }),
          hint ? h('p', { class: 'small muted', text: hint }) : null,
          h('div', {}, h('button', { class: 'btn primary', onClick: () => boot() }, icon('refresh', 'sm'), t('retry')))
        )));
        return;
      }
    }
    S.features = (S.session && S.session.features) || {};
    if (S.user && S.user.lang && !localStorage.getItem('hub.lang')) I18n.set(S.user.lang);
    if (S.session && S.session.setup_required && !S.user) return A.renderSetup();
    if (!S.user) return A.renderLogin();
    // Step 2: connect to network (independent of account creation / login)
    if (S.session && S.session.network_setup_required && S.user.is_primary) return A.renderNetworkConnect();
    A.renderShell(); A.startBackground(); A.refreshSync(); A.refreshUnread(); A.flushOutbox(); route();
  }
  // Soft auth-loss: re-check session before kicking to login (avoids bounce when cookie lags)
  let authLostBusy = false;
  UI.net.onAuthLost = async () => {
    if (authLostBusy || !S.user) return;
    authLostBusy = true;
    try {
      const sess = await api('GET', '/api/session', undefined, { quiet401: true });
      if (sess && sess.user) {
        S.user = sess.user;
        S.session = sess;
        return; // still authenticated — ignore transient 401
      }
      try {
        if (UI.clearSessionClient) UI.clearSessionClient();
        else { net.csrf = null; }
      } catch (_) {}
      S.user = null;
      boot();
    } catch (_) {
      // network blip — do not force logout
    } finally {
      authLostBusy = false;
    }
  };
  window.addEventListener('hashchange', route);
  document.getElementById('skip-link').addEventListener('click', (e) => { e.preventDefault(); const m = document.getElementById('main'); if (m) m.focus(); });
  A.boot = boot; A.route = route;
  boot();
})();
