'use strict';
// Community Hub web UI — part 2: screens, router and boot.
(function () {
  const A = window.HubApp; const { S, h, icon, append, clear, api, apiRaw, go, copy, fail, live, composer, composeModal, postCard, pagedList, outboxView, flushOutbox, searchBox, field, v, machineCode, maskPublicEndpoint, peerErrorText, Behavior, Calls } = A;
  const { avatar, nameOf, timeAgo, shortId, errText, toast, modal, confirmDialog, menu, linkify, net, formatBytes, mediaView } = UI;
  const qs = (c) => (c ? '?cursor=' + encodeURIComponent(c) : '');
  const $ = (id) => document.getElementById(id);
  const navStack = [];
  let navGoingBack = false;
  const currentHash = () => (location.hash && location.hash.startsWith('#/') ? location.hash : '#/home');
  const goBack = () => {
    const cur = currentHash();
    while (navStack.length && navStack[navStack.length - 1] === cur) navStack.pop();
    const prev = navStack[navStack.length - 1];
    if (prev && prev !== cur) {
      navGoingBack = true;
      go(prev);
      return;
    }
    if (cur !== '#/home') {
      navGoingBack = true;
      go('#/home');
    }
  };
  const top = (title, o = {}) => h('div', { class: 'topbar' }, o.back ? h('button', { type: 'button', class: 'iconbtn', 'aria-label': t('back'), onClick: (e) => { e.stopPropagation(); if (o.onBack) o.onBack(); else goBack(); } }, icon('back')) : null, h('h1', { text: title }), o.right || null);
  const activityBar = (reload) => { const bar = h('div', { class: 'banner hidden' }, h('button', { class: 'btn sm', onClick: () => { bar.classList.add('hidden'); reload(); } }, icon('refresh', 'sm'), t('newPosts'))); S.onActivity = () => bar.classList.remove('hidden'); return bar; };
  const empty = (text, ic) => h('div', { class: 'empty' }, ic ? icon(ic, 'lg') : null, h('p', { text }));
  const spinner = () => h('div', { class: 'spinner', role: 'status', 'aria-label': t('loading') });
  const userRow = (u) => h('a', { class: 'post', href: '#/u/' + encodeURIComponent(u.username || u.account_id || ''), style: null }, avatar(u), h('div', { class: 'pbody' }, h('b', { text: nameOf(u) }), h('div', { class: 'muted small', text: u.username ? '@' + u.username : shortId(u.account_id) }), u.bio ? h('div', { class: 'small', text: u.bio }) : null));

  // ---------- views ----------
  function viewHome(view, tok) {
    let tab = 'foryou';
    try { const saved = sessionStorage.getItem('hub.homeTab'); if (saved === 'following' || saved === 'foryou') tab = saved; } catch (_) {}
    const ob = outboxView();
    const listHolder = h('div', {});
    const tabs = h('div', { class: 'feed-tabs', role: 'tablist' });
    let feed = null;
    const draw = () => {
      clear(tabs);
      [['foryou', 'home.forYou'], ['following', 'home.following']].forEach(([k, lbl]) => {
        tabs.append(h('button', {
          type: 'button', role: 'tab', 'aria-selected': String(tab === k),
          onClick: () => { if (tab === k) return; tab = k; try { sessionStorage.setItem('hub.homeTab', k); } catch (_) {} draw(); },
        }, t(lbl)));
      });
      const ep = tab === 'foryou' ? '/api/feed/foryou' : '/api/feed/home';
      const pq = (tab === 'foryou' && Behavior && Behavior.preferredQuery) ? Behavior.preferredQuery() : '';
      feed = pagedList((c) => {
        const params = [];
        if (c) params.push('cursor=' + encodeURIComponent(c));
        if (pq) params.push(pq);
        return api('GET', ep + (params.length ? '?' + params.join('&') : ''));
      }, { empty: t('home.empty') });
      clear(listHolder).append(feed);
    };
    const bar = activityBar(() => feed && feed.reload());
    const header = h('div', { class: 'topbar col-top' }, h('h1', { text: t('home.title') }), tabs);
    draw();
    view.append(header, bar, composer({ onPosted: () => feed && feed.reload() }), ob, listHolder);
  }
  // Phase 6 — Global Explore: public posts from the whole network. No friend / Hub address / region setup needed.
  function networkExplore(tok) {
    const TOPICS = ['tech', 'travel', 'food', 'music', 'education', 'news', 'health', 'finance', 'sports', 'art', 'career'];
    const input = h('input', { type: 'search', maxlength: '200', placeholder: t('gx.placeholder'), 'aria-label': t('gx.placeholder') });
    const sel = (key, vals) => h('select', { 'aria-label': t(key) }, h('option', { value: '', text: t(key) + ': ' + t('gx.any') }), ...vals.map((x) => h('option', { value: x, text: x.toUpperCase() })));
    const lang = sel('gx.filter.language', ['vi', 'en', 'ja', 'zh', 'ko', 'fr', 'de', 'es']), region = sel('gx.filter.region', ['VN', 'JP', 'US', 'DE', 'FR', 'GB', 'KR', 'SG']);
    const topic = h('select', { 'aria-label': t('gx.filter.topic') }, h('option', { value: '', text: t('gx.filter.topic') + ': ' + t('gx.any') }), ...TOPICS.map((x) => h('option', { value: x, text: x })));
    const status = h('div', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
    const list = h('div'); const more = h('button', { class: 'btn hidden', onClick: () => loadMore() }, t('gx.more'));
    let sid = null, timer = null, shown = 0, seq = 0, nextOffset = 0, last = null;
    const label = (it) => (it.hub.is_self ? t('gx.thisHub') : it.hub.label);
    const stateText = (s) => (s && s.state ? t('gx.state.' + s.state) : '');
    function card(it) {
      return h('div', { class: 'post' }, h('div', { class: 'pbody' },
        h('div', { class: 'phead' }, h('b', { text: label(it) }), h('span', { class: 'muted small', text: '· ' + timeAgo(it.updated_at) + (it.language && it.language !== 'und' ? ' · ' + it.language.toUpperCase() : '') })),
        it.title ? h('div', { text: it.title }) : null,
        h('div', { class: 'ptext', text: it.excerpt }),
        h('div', { class: 'row' }, ...(it.topics || []).slice(0, 4).map((x) => h('span', { class: 'muted small', text: '#' + x })), h('span', { class: 'grow' }),
          h('button', { class: 'btn sm', onClick: () => openPost(it) }, t('gx.open')))));
    }
    async function openPost(it) {
      const body = h('div', {}, spinner()); modal(label(it), body);
      try {
        const r = await api('GET', '/api/explore/network/post?origin=' + encodeURIComponent(it.origin_ref) + '&id=' + encodeURIComponent(it.content_id) + '&hash=' + encodeURIComponent(it.content_hash));
        clear(body).append(h('div', { class: 'ptext', text: r.post.content }), h('div', { class: 'muted small', text: timeAgo(r.post.edited_at || r.post.created_at) + ' · ' + t('gx.verified') }), r.stale_index ? h('div', { class: 'muted small', text: t('gx.stale') }) : null);
      } catch (e) { clear(body).append(empty(e.status === 410 ? t('gx.gone') : e.status === 503 ? t('gx.originOffline') : errText(e), 'info')); }
    }
    function render(snap, append) {
      last = snap; status.textContent = stateText(snap);
      if (!append) { clear(list); shown = 0; }
      if (!snap.items.length && !shown) { if (snap.state !== 'searching') list.append(empty(t('gx.none'), 'search')); }
      else snap.items.forEach((it) => list.append(card(it)));
      shown += snap.items.length; nextOffset = (append ? nextOffset : 0) + 20;
      more.classList.toggle('hidden', !snap.next_cursor || snap.state === 'searching');
    }
    function params() { const p = new URLSearchParams({ q: input.value.trim(), limit: '20' }); if (lang.value) p.set('language', lang.value); if (region.value) p.set('region', region.value); if (topic.value) p.set('topic', topic.value); return p; }
    async function run() {
      clearTimeout(timer); const my = ++seq; sid = null; status.textContent = t('gx.state.searching'); clear(list); list.append(spinner()); more.classList.add('hidden');
      try { poll(await api('GET', '/api/explore/network?' + params()), my); } catch (e) { clear(list); status.textContent = ''; list.append(empty(errText(e), 'info')); }
    }
    function poll(snap, my) {
      if (my !== seq || !live(tok)) return; sid = snap.session;
      if (snap.state === 'unavailable') { clear(list); status.textContent = ''; return list.append(empty(t('gx.state.unavailable'), 'info')); }
      render(snap, false);
      if (snap.state === 'searching') timer = setTimeout(async () => { try { poll(await api('GET', '/api/explore/network?session=' + encodeURIComponent(sid) + '&offset=0&limit=20'), my); } catch (e) { status.textContent = errText(e); } }, 700);
    }
    async function loadMore() {
      if (!sid) return; more.disabled = true;
      try { render(await api('GET', '/api/explore/network?session=' + encodeURIComponent(sid) + '&offset=' + shown + '&limit=20'), true); } catch (e) { fail(e); } finally { more.disabled = false; }
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    for (const el of [lang, region, topic]) el.addEventListener('change', run);
    const root = h('div', { class: 'page col' }, h('div', { class: 'row' }, input, h('button', { class: 'btn primary', onClick: run }, icon('search', 'sm'), t('gx.search'))), h('div', { class: 'row' }, lang, region, topic), status, list, more);
    root.start = run; root.stop = () => { seq++; clearTimeout(timer); };
    return root;
  }
  async function viewExplore(view, tok) { // behavior-ranked discovery
    const pq = (Behavior && Behavior.preferredQuery) ? Behavior.preferredQuery() : '';
    const feed = pagedList((c) => {
      const params = [];
      if (c) params.push('cursor=' + encodeURIComponent(c));
      if (pq) params.push(pq);
      return api('GET', '/api/feed/public' + (params.length ? '?' + params.join('&') : ''));
    }, { rank: true, empty: t('explore.empty') });
    const trends = h('div', { class: 'chips' });
    const hubPane = h('div', {}, h('div', { class: 'page' }, searchBox(), h('div', { class: 'col' }, h('b', { text: t('trends') }), trends)), activityBar(() => feed.reload()), feed);
    const net = networkExplore(tok); const netPane = h('div', { class: 'hidden' }, net);
    const tabHub = h('button', { class: 'btn sm primary', onClick: () => pick('hub') }, t('gx.tab.hub')), tabNet = h('button', { class: 'btn sm', onClick: () => pick('net') }, t('gx.tab.network'));
    let started = false;
    function pick(w) { const n = w === 'net'; hubPane.classList.toggle('hidden', n); netPane.classList.toggle('hidden', !n); tabHub.classList.toggle('primary', !n); tabNet.classList.toggle('primary', n); if (n && !started) { started = true; net.start(); } if (!n) net.stop(); }
    view.append(top(t('explore.title')), h('div', { class: 'page row' }, tabHub, tabNet), hubPane, netPane);
    try { const r = await api('GET', '/api/trends'); if (live(tok)) r.tags.forEach((x) => trends.append(h('button', { onClick: () => go('#/search/' + encodeURIComponent('#' + x.tag)) }, '#' + x.tag + ' · ' + x.n))); } catch (e) { /* optional */ }
  }
  async function viewSearch(view, tok, q) {
    view.append(top(t('nav.explore'), { back: true }), h('div', { class: 'page' }, searchBox(q)));
    const out = h('div', {}, spinner()); view.append(out);
    try {
      const r = await api('GET', '/api/search?q=' + encodeURIComponent(q)); if (!live(tok)) return; clear(out);
      if (!r.accounts.length && !r.posts.length && !r.tags.length) return out.append(empty(t('search.none'), 'search'));
      if (r.accounts.length) out.append(h('h2', { class: 'page', text: t('search.people') }), ...r.accounts.map(userRow));
      if (r.tags.length && !q.startsWith('#')) out.append(h('h2', { class: 'page', text: t('search.tags') }), h('div', { class: 'page chips' }, r.tags.map((x) => h('button', { onClick: () => go('#/search/' + encodeURIComponent('#' + x)) }, '#' + x))));
      if (r.posts.length) out.append(h('h2', { class: 'page', text: t('search.posts') }), ...r.posts.map((p) => postCard(p)));
    } catch (e) { clear(out).append(empty(errText(e))); }
  }
  async function viewPost(view, tok, id) {
    view.append(top(t('post.replies'), { back: true })); const body = h('div', {}, spinner()); view.append(body);
    try {
      const r = await api('GET', '/api/posts/' + encodeURIComponent(id) + '/thread'); if (!live(tok)) return; clear(body);
      const again = () => route();

      // 1) Ancestor chain above focal post
      if (Array.isArray(r.ancestors) && r.ancestors.length) {
        const ancWrap = h('div', { class: 'thread-ancestors' });
        r.ancestors.forEach((anc) => {
          const ac = postCard(anc, { spine: true, hideReplyTo: true, inThread: true, compact: true, onReplied: again });
          ac.classList.add('thread-ancestor');
          ancWrap.append(ac);
        });
        body.append(ancWrap);
      }

      // 2) Focal post + quick inline reply box
      const parentCard = postCard(r.post, { noNav: true, hideReplyTo: true, inThread: true, onReplied: again, onDeleted: () => go('#/home') });
      parentCard.classList.add('thread-root', 'thread-focal');
      body.append(parentCard);
      if (!r.post.deleted) {
        body.append(h('div', { class: 'thread-focal-reply' },
          composer({ replyTo: r.post.id, placeholder: t('composer.replyPlaceholder'), noVisibility: true, compact: true, onPosted: again })
        ));
      }

      // 3) Build Mind-Map tree from r.replies
      const allReplies = r.replies || [];
      const byParent = new Map();
      const pushChild = (key, item) => {
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(item);
      };
      allReplies.forEach((rp) => {
        const k = rp.parent_id ? ('id:' + rp.parent_id) : (rp.parent_event ? ('ev:' + rp.parent_event) : ('id:' + r.post.id));
        pushChild(k, rp);
      });
      const childrenOf = (node) => {
        const res = [];
        const seen = new Set();
        for (const key of ['id:' + node.id, node.event_id ? ('ev:' + node.event_id) : null].filter(Boolean)) {
          for (const ch of (byParent.get(key) || [])) {
            if (!seen.has(ch.id)) { seen.add(ch.id); res.push(ch); }
          }
        }
        return res;
      };
      const subtreeCount = (node, guard = new Set()) => {
        if (!node || guard.has(node.id)) return 0;
        guard.add(node.id);
        const kids = childrenOf(node);
        let n = kids.length;
        for (const k of kids) n += subtreeCount(k, guard);
        return n;
      };

      const topReplies = childrenOf(r.post);
      // Orphan safety net: include any reply whose parent wasn't reachable from r.post
      const visited = new Set();
      const markVisited = (node) => {
        if (!node || visited.has(node.id)) return;
        visited.add(node.id);
        childrenOf(node).forEach(markVisited);
      };
      topReplies.forEach(markVisited);
      allReplies.forEach((rp) => {
        if (!visited.has(rp.id)) { topReplies.push(rp); markVisited(rp); }
      });

      const legacyComments = r.comments || [];
      const totalComments = allReplies.length + legacyComments.length;
      const treeWrap = h('section', { class: 'mm-tree', 'aria-label': t('post.replies') });

      const branchNodes = [];
      let allCollapsed = false;
      const collapseBtn = h('button', { type: 'button', class: 'btn sm mm-toggle-all hidden', onClick: () => {
        allCollapsed = !allCollapsed;
        branchNodes.forEach(({ nodeEl, btn, count }) => {
          nodeEl.classList.toggle('is-collapsed', allCollapsed);
          btn.setAttribute('aria-expanded', String(!allCollapsed));
          btn.textContent = (allCollapsed ? '▸ ' : '▾ ') + t('post.branchReplies', { n: String(count) });
        });
        collapseBtn.textContent = allCollapsed ? t('post.expandAll') : t('post.collapseAll');
      } }, t('post.collapseAll'));

      const mmHeader = h('div', { class: 'mm-header row' },
        h('span', { class: 'mm-title', text: t('post.commentsCount', { n: String(totalComments) }) }),
        h('span', { class: 'grow' }),
        collapseBtn
      );
      treeWrap.append(mmHeader);

      const renderMindNode = (node, depth, container) => {
        const kids = childrenOf(node);
        const hasKids = kids.length > 0;
        const nodeEl = h('div', { class: 'mm-node' });
        const inlineSlot = h('div', { class: 'mm-inline-reply hidden' });

        const toggleInlineReply = () => {
          const opening = inlineSlot.classList.contains('hidden');
          if (opening) {
            if (!inlineSlot.firstChild) {
              const handle = (node.author && node.author.username) ? ('@' + node.author.username) : '';
              inlineSlot.append(composer({
                replyTo: node.id,
                placeholder: t('post.replyingTo', { user: handle || t('post.reply') }),
                noVisibility: true,
                compact: true,
                onPosted: again,
              }));
            }
            inlineSlot.classList.remove('hidden');
            const ta = inlineSlot.querySelector('textarea');
            if (ta) ta.focus();
          } else {
            inlineSlot.classList.add('hidden');
          }
        };

        const card = postCard(node, { hideReplyTo: true, inThread: true, compact: true, onReplied: again, onInlineReply: toggleInlineReply });
        card.classList.add('mm-card');

        const wrap = h('div', { class: 'mm-card-wrap' }, card, inlineSlot);
        if (hasKids) {
          const totalBranch = subtreeCount(node);
          const branchBtn = h('button', {
            type: 'button',
            class: 'mm-branch-btn',
            'aria-expanded': 'true',
            onClick: (e) => {
              e.stopPropagation();
              const collapsed = nodeEl.classList.toggle('is-collapsed');
              branchBtn.setAttribute('aria-expanded', String(!collapsed));
              branchBtn.textContent = (collapsed ? '▸ ' : '▾ ') + t('post.branchReplies', { n: String(totalBranch) });
            },
          }, '▾ ' + t('post.branchReplies', { n: String(totalBranch) }));
          wrap.append(branchBtn);
          branchNodes.push({ nodeEl, btn: branchBtn, count: totalBranch });
        }
        nodeEl.append(wrap);

        if (hasKids) {
          const branch = h('div', { class: 'mm-children' });
          if (depth >= 5) {
            branch.append(h('div', { class: 'mm-node mm-leaf-link' },
              h('a', { class: 'btn sm mm-continue-link', href: '#/post/' + node.id }, t('post.openBranch', { n: String(subtreeCount(node)) }))
            ));
          } else {
            const limit = depth === 0 ? kids.length : 4;
            kids.slice(0, limit).forEach((ch) => renderMindNode(ch, depth + 1, branch));
            if (kids.length > limit) {
              const moreNode = h('div', { class: 'mm-node mm-more-node' });
              const restBtn = h('button', { type: 'button', class: 'btn sm thread-more-btn', onClick: () => {
                moreNode.remove();
                kids.slice(limit).forEach((ch) => renderMindNode(ch, depth + 1, branch));
              } }, t('post.showReplies', { n: String(kids.length - limit) }));
              moreNode.append(restBtn);
              branch.append(moreNode);
            }
          }
          nodeEl.append(branch);
        }
        container.append(nodeEl);
      };

      const rootList = h('div', { class: 'mm-root-list' });
      topReplies.forEach((rp) => renderMindNode(rp, 0, rootList));
      legacyComments.forEach((c) => {
        const card = h('article', { class: 'post mm-card' },
          avatar({ username: c.username, display_name: c.display_name }, 'sm'),
          h('div', { class: 'pbody' },
            h('div', { class: 'phead' }, h('b', { text: c.display_name || c.username }), h('span', { class: 'muted small', text: '· ' + timeAgo(c.created_at) })),
            h('div', { class: 'ptext' }, linkify(c.content || ''))
          )
        );
        rootList.append(h('div', { class: 'mm-node' }, h('div', { class: 'mm-card-wrap' }, card)));
      });
      if (branchNodes.length > 0) collapseBtn.classList.remove('hidden');

      treeWrap.append(rootList);
      body.append(treeWrap);
      if (!topReplies.length && !legacyComments.length) treeWrap.append(empty(t('post.noReplies')));
    } catch (e) { clear(body).append(empty(errText(e), 'info')); }
  }

  async function viewProfile(view, tok, handle) {
    view.append(top(t('nav.profile'), { back: true })); const body = h('div', {}, spinner()); view.append(body);
    let p; try { p = await api('GET', '/api/profiles/' + encodeURIComponent(handle)); } catch (e) { return clear(body).append(empty(e.status === 404 ? t('profile.notFound') : errText(e), 'user')); }
    if (!live(tok)) return; clear(body);
    const rel = p.relation || {}; const self = rel.self;
    const followBtn = () => { if (self || !p.account_id || !S.user) return null; const b = h('button', { class: 'btn ' + (rel.following ? '' : 'primary'), onClick: async () => { try { if (rel.following) await api('DELETE', '/api/follow', { account_id: p.account_id }); else await api('POST', '/api/follow', { account_id: p.account_id }); route(); } catch (e) { fail(e); } } }, rel.following ? t('profile.following') : t('profile.follow')); return b; };
    const msgBtn = !self && p.account_id && S.user ? h('a', { class: 'btn', href: '#/messages/' + encodeURIComponent(p.account_id) }, icon('mail', 'sm'), t('profile.message')) : null;
    const moreBtn = !self && p.account_id ? h('button', { class: 'iconbtn', 'aria-label': t('more'), onClick: (e) => menu(e.currentTarget, [
      { icon: 'mute', label: rel.muted ? t('profile.unmute') : t('post.mute'), onClick: async () => { try { await api(rel.muted ? 'DELETE' : 'POST', '/api/mutes', { account_id: p.account_id }); route(); } catch (x) { fail(x); } } },
      { icon: 'block', label: rel.blocked ? t('profile.unblock') : t('post.block'), danger: !rel.blocked, onClick: async () => { try { await api(rel.blocked ? 'DELETE' : 'POST', '/api/blocks', { account_id: p.account_id }); route(); } catch (x) { fail(x); } } },
      { icon: 'flag', label: t('post.report'), onClick: async () => { try { await api('POST', '/api/reports', { account_id: p.account_id, reason: 'profile' }); toast(t('post.reported')); } catch (x) { fail(x); } } }]) }, icon('more')) : null;
    const list = (dir) => async () => { try { const r = await api('GET', '/api/profiles/' + encodeURIComponent(handle) + '/' + dir); modal(t(dir === 'followers' ? 'profile.followers' : 'profile.followingN'), h('div', {}, r.items.length ? r.items.map((u) => userRow({ ...u, username: u.username })) : empty(t('settings.none')))); } catch (e) { fail(e); } };
    body.append(h('div', { class: 'profilehead' }, h('div', { class: 'row wrap' }, avatar(p, 'lg'), h('span', { class: 'grow' }), moreBtn, msgBtn, self ? h('button', { class: 'btn', onClick: () => editProfile(p) }, t('profile.edit')) : followBtn()),
      h('h2', { text: nameOf(p) }), h('div', { class: 'muted', text: '@' + p.username }),
      h('div', { class: 'row wrap' }, rel.friend ? h('span', { class: 'badge ok' }, t('profile.friend')) : rel.followed_by ? h('span', { class: 'badge' }, t('profile.followsYou')) : null, p.status === 'remote' ? h('span', { class: 'badge' }, icon('globe', 'sm'), t('profile.remote')) : null, rel.blocked ? h('span', { class: 'badge bad' }, t('profile.blocked')) : null, rel.muted ? h('span', { class: 'badge warn' }, t('profile.muted')) : null),
      p.bio ? h('p', { class: 'ptext' }, linkify(p.bio)) : null,
      p.status === 'legacy' ? h('p', { class: 'small muted', text: t('profile.legacy') }) : null,
      p.account_id ? h('div', { class: 'small row wrap' }, h('span', { class: 'muted', text: t('profile.accountId') }), h('code', { class: 'id', text: shortId(p.account_id) }), h('button', { class: 'iconbtn', 'aria-label': t('copy'), onClick: () => copy(p.account_id) }, icon('link', 'sm'))) : null,
      h('div', { class: 'stat' }, h('span', {}, h('b', { text: p.counts.posts }), ' ' + t('profile.posts')), h('button', { onClick: list('followers') }, h('b', { text: p.counts.followers }), ' ' + t('profile.followers')), h('button', { onClick: list('following') }, h('b', { text: p.counts.following }), ' ' + t('profile.followingN')))));
    let filter = 'posts'; const holder = h('div', {});
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const tabDefs = [['posts', 'profile.posts'], ['replies', 'profile.replies'], ['media', 'profile.media'], ...(self ? [['private', 'profile.private']] : [])];
    const draw = () => {
      clear(tabs);
      tabDefs.forEach(([k, key]) => tabs.append(h('button', { role: 'tab', 'aria-selected': String(filter === k), onClick: () => { filter = k; draw(); } }, t(key))));
      clear(holder).append(pagedList(
        (c) => api('GET', '/api/profiles/' + encodeURIComponent(handle) + '/posts?filter=' + encodeURIComponent(filter) + (c ? '&cursor=' + encodeURIComponent(c) : '')),
        { showPinned: filter === 'posts', onPinned: () => draw() }
      ));
    };
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
      const IC = { like: 'heart', reply: 'comment', repost: 'repeat', quote: 'quote', follow: 'user', mention: 'user' };
      r.items.forEach((n) => body.append(h('a', {
        class: 'post notif-row' + (n.read ? '' : ' unread'),
        href: n.post_id ? '#/post/' + n.post_id : '#/u/' + encodeURIComponent((n.actor && n.actor.username) || ''),
      },
        h('span', { class: 'iconbtn on' }, icon(IC[n.type] || 'bell')),
        avatar(n.actor, 'sm'),
        h('div', { class: 'pbody' },
          h('div', { text: t('notif.' + n.type, { name: nameOf(n.actor) }) }),
          n.post_preview ? h('div', { class: 'notif-preview muted small', text: n.post_preview }) : null,
          h('div', { class: 'muted small', text: timeAgo(n.created_at) })
        )
      )));
    } catch (e) { clear(body).append(empty(errText(e))); }
  }
  function viewBookmarks(view) {
    view.append(top(t('bookmarks.title')), pagedList((c) => api('GET', '/api/bookmarks' + qs(c)), { empty: t('bookmarks.empty'), onUnbookmark: true }));
  }
  async function viewMessages(view, tok, initialTarget) {
    view.append(top(t('messages.title'), { right: h('span', { class: 'badge ok' }, icon('shield', 'sm'), 'E2EE') }));
    const shell = h('div', { class: 'dm-shell' });
    const listPane = h('div', { class: 'dm-list' });
    const chatPane = h('div', { class: 'dm-chat' });
    shell.append(listPane, chatPane);
    view.append(shell);

    let activePeer = initialTarget || '';
    let threadsData = { threads: [], contacts: [] };
    let busySend = false;

    const uploadDmMedia = async (file) => {
      const CHUNK = 5 * 1024 * 1024;
      if (file.size > CHUNK) {
        const sess = await api('POST', '/api/media/sessions', { filename: file.name, size: file.size });
        const total = sess.totalChunks || Math.ceil(file.size / CHUNK);
        for (let i = 0; i < total; i++) {
          const blob = file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK));
          await apiRaw('PUT', '/api/media/sessions/' + sess.id + '/chunk/' + i, blob, { headers: { 'Content-Type': 'application/octet-stream' } });
        }
        return api('POST', '/api/media/sessions/' + sess.id + '/complete', {});
      }
      const form = new FormData();
      form.append('file', file);
      return api('POST', '/api/media', undefined, { form });
    };

    const renderList = () => {
      clear(listPane);
      const { threads, contacts } = threadsData;
      if (threads.length) {
        threads.forEach((tr) => {
          const on = activePeer === tr.peer_account_id || activePeer.toLowerCase() === String(tr.username || '').toLowerCase();
          listPane.append(h('button', {
            type: 'button',
            class: 'dm-item' + (on ? ' active' : ''),
            onClick: () => openChat(tr.peer_account_id),
          },
            avatar(tr, 'sm'),
            h('div', { class: 'grow dm-item-body' },
              h('div', { class: 'row' }, h('b', { class: 'grow', text: nameOf(tr) }), tr.unread ? h('span', { class: 'badge ok', text: String(tr.unread) }) : null),
              h('div', { class: 'small muted dm-prev', text: (tr.last_direction === 'out' ? '↗ ' : '') + (tr.last_message || '') })
            )
          ));
        });
      }
      const existingAccts = new Set(threads.map((x) => x.peer_account_id));
      const freshContacts = (contacts || []).filter((c) => !existingAccts.has(c.account_id));
      if (freshContacts.length) {
        listPane.append(h('div', { class: 'dm-sec small muted', text: t('messages.new') }));
        freshContacts.forEach((c) => {
          const on = activePeer === c.account_id || activePeer.toLowerCase() === String(c.username || '').toLowerCase();
          listPane.append(h('button', {
            type: 'button',
            class: 'dm-item' + (on ? ' active' : ''),
            onClick: () => openChat(c.account_id),
          },
            avatar(c, 'sm'),
            h('div', { class: 'grow dm-item-body' },
              h('b', { text: nameOf(c) }),
              h('div', { class: 'small muted', text: '@' + c.username })
            ),
            c.has_key ? icon('lock', 'sm') : null
          ));
        });
      }
      if (!threads.length && !freshContacts.length) {
        listPane.append(empty(t('messages.empty'), 'mail'));
      }
    };

    const renderPlaceholder = () => {
      clear(chatPane);
      shell.classList.remove('dm-mobile-chat');
      chatPane.append(h('div', { class: 'empty' }, icon('shield', 'lg'), h('p', { text: t('messages.pickUser') }), h('p', { class: 'small muted', text: t('messages.e2ee') })));
    };

    const openChat = async (target, keepScroll = false, refreshKey = false) => {
      activePeer = target;
      shell.classList.add('dm-mobile-chat');
      renderList();
      if (!keepScroll) clear(chatPane).append(spinner());
      try {
        const q = refreshKey ? '?refresh=1' : '';
        const conv = await api('GET', '/api/messages/' + encodeURIComponent(target) + q);
        if (!live(tok) || activePeer !== target) return;
        const peer = conv.peer || {};
        clear(chatPane);
        const hdr = h('div', { class: 'dm-head row' },
          h('button', { type: 'button', class: 'iconbtn dm-back', 'aria-label': t('back'), onClick: () => { activePeer = ''; shell.classList.remove('dm-mobile-chat'); renderList(); renderPlaceholder(); } }, icon('back')),
          avatar(peer, 'sm'),
          h('div', { class: 'grow' },
            h('a', { class: 'pname', href: '#/u/' + encodeURIComponent(peer.username || peer.account_id), text: nameOf(peer) }),
            h('div', { class: 'small muted', text: '@' + (peer.username || '') + ' · ' + (peer.has_key ? t('messages.e2ee') : t('messages.noKey')) })
          ),
          (Calls && peer.account_id) ? h('button', { type: 'button', class: 'iconbtn', title: t('messages.callAudio'), 'aria-label': t('messages.callAudio'), onClick: () => Calls.startCall(peer, false) }, icon('phone')) : null,
          (Calls && peer.account_id) ? h('button', { type: 'button', class: 'iconbtn', title: t('messages.callVideo'), 'aria-label': t('messages.callVideo'), onClick: () => Calls.startCall(peer, true) }, icon('video')) : null,
          icon('lock', 'sm')
        );
        const msgsBox = h('div', { class: 'dm-msgs' });
        if (!conv.messages.length) {
          msgsBox.append(empty(t('messages.empty'), 'mail'));
        } else {
          conv.messages.forEach((m) => {
            const mine = m.direction === 'out';
            const tick = mine ? (m.read ? '✓✓ ' : '✓ ') : '';
            const st = mine ? (' · ' + tick + (t('messages.status.' + (m.status || 'sent')))) : '';
            const bubble = append(
              h('div', { class: 'dm-bubble ' + (mine ? 'me' : 'them') }),
              m.content ? h('div', { class: 'ptext', text: m.content }) : null,
              (m.attachments && m.attachments.length) ? mediaView(m.attachments) : null,
              h('div', { class: 'small dm-meta', text: timeAgo(m.created_at) + st })
            );
            msgsBox.append(h('div', { class: 'dm-row ' + (mine ? 'out' : 'in') }, bubble));
          });
        }
        const noKeyBanner = !peer.has_key ? h('div', { class: 'banner warn row' },
          icon('shield', 'sm'),
          h('span', { class: 'grow small', text: t('messages.noKeyHelp') }),
          h('button', { type: 'button', class: 'btn sm', onClick: () => openChat(target, false, true) }, icon('refresh', 'sm'), t('messages.checkKey'))
        ) : null;

        const dmFiles = [];
        const attachRow = h('div', { class: 'dm-attach-row hidden' });
        const input = h('textarea', { rows: '1', maxlength: '4000', disabled: !peer.has_key, placeholder: peer.has_key ? t('messages.placeholder') : t('messages.noKey'), 'aria-label': t('messages.placeholder') });
        const sendBtn = h('button', { type: 'button', class: 'btn primary sm', disabled: !peer.has_key, onClick: () => send() }, icon('send', 'sm'), t('messages.send'));
        const drawAttach = () => {
          clear(attachRow);
          attachRow.classList.toggle('hidden', !dmFiles.length);
          dmFiles.forEach((f, idx) => {
            attachRow.append(h('span', { class: 'chip' },
              icon('clip', 'sm'),
              h('span', { class: 'small', text: f.name || shortId(f.hash) }),
              h('button', { type: 'button', class: 'iconbtn', 'aria-label': t('close'), onClick: () => { dmFiles.splice(idx, 1); drawAttach(); } }, icon('x', 'sm'))
            ));
          });
        };
        const fileIn = h('input', {
          type: 'file',
          class: 'hidden',
          multiple: true,
          accept: 'image/*,video/mp4,video/webm,audio/*,application/pdf,.txt,.md,.csv,.json,.zip,.docx,.xlsx,.pptx',
          onChange: async (e) => {
            const list = [...e.target.files].slice(0, 4 - dmFiles.length);
            e.target.value = '';
            if (!list.length) return;
            busySend = true; sendBtn.disabled = true;
            try {
              for (const f of list) {
                const up = await uploadDmMedia(f);
                if (up && up.hash) dmFiles.push(up);
              }
              drawAttach();
            } catch (err) { fail(err); }
            finally { busySend = false; sendBtn.disabled = !peer.has_key; }
          },
        });
        const attachBtn = h('button', {
          type: 'button',
          class: 'iconbtn',
          disabled: !peer.has_key,
          title: t('messages.attach'),
          'aria-label': t('messages.attach'),
          onClick: () => fileIn.click(),
        }, icon('clip'));
        const send = async () => {
          const text = input.value.trim();
          if ((!text && !dmFiles.length) || busySend || !peer.has_key) return;
          busySend = true; sendBtn.disabled = true;
          try {
            await api('POST', '/api/messages', {
              recipient: peer.account_id || target,
              content: text,
              attachments: dmFiles.map((f) => f.hash),
            });
            input.value = '';
            dmFiles.length = 0;
            drawAttach();
            await loadAll(true);
          } catch (e) { fail(e); }
          finally { busySend = false; sendBtn.disabled = !peer.has_key; }
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
        const form = h('div', { class: 'dm-compose row' }, fileIn, attachBtn, input, sendBtn);
        append(chatPane, hdr, msgsBox, noKeyBanner, attachRow, form);
        msgsBox.scrollTop = msgsBox.scrollHeight;
      } catch (e) { clear(chatPane).append(empty(errText(e), 'info')); }
    };

    const loadAll = async (keepScroll = false) => {
      try {
        threadsData = await api('GET', '/api/messages/threads');
        if (!live(tok)) return;
        renderList();
        if (activePeer) await openChat(activePeer, keepScroll);
        else renderPlaceholder();
      } catch (e) { clear(listPane).append(empty(errText(e), 'info')); }
    };

    const onDm = async (ev) => {
      if (!live(tok)) { window.removeEventListener('hub-dm', onDm); return; }
      const d = (ev && ev.detail) || {};
      try {
        threadsData = await api('GET', '/api/messages/threads');
        if (!live(tok)) return;
        renderList();
        if (activePeer && d.from && (d.from === activePeer || d.from === (threadsData.threads.find((x) => x.peer_account_id === activePeer)?.peer_account_id))) {
          await openChat(activePeer, true);
        }
      } catch (_) {}
    };
    window.addEventListener('hub-dm', onDm);
    S.onActivity = () => { if (live(tok)) loadAll(true); };
    await loadAll(false);
  }

  // ---------- groups (local to this Hub) ----------
  const groupAvatarEl = (g, size) => {
    const el = h('span', { class: 'avatar group-av' + (size ? ' ' + size : ''), 'aria-hidden': 'true' });
    if (g && g.avatar_url) {
      const img = h('img', { src: g.avatar_url, alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', () => { img.remove(); el.append(icon(g.visibility === 'private' ? 'lock' : 'users')); });
      el.appendChild(img);
    } else {
      el.append(icon((g && g.visibility === 'private') ? 'lock' : 'users'));
    }
    return el;
  };

  async function viewGroups(view, tok) {
    let scope = 'all';
    let qTimer = null;
    let createAvatarHash = '';

    const searchIn = h('input', { type: 'search', maxlength: '80', placeholder: t('groups.search'), 'aria-label': t('groups.search') });
    const codeIn = h('input', { type: 'text', maxlength: '16', placeholder: t('groups.enterCode'), 'aria-label': t('groups.enterCode') });
    const joinCodeBtn = h('button', { type: 'button', class: 'btn primary', onClick: async () => {
      const code = codeIn.value.trim();
      if (!code) return;
      try {
        const r = await api('POST', '/api/groups/join-code', { code });
        toast(t('groups.joined'));
        go('#/groups/' + r.group_id);
      } catch (e) { fail(e); }
    } }, icon('link', 'sm'), t('groups.joinCode'));
    const codeBar = h('div', { class: 'card row wrap' },
      codeIn, joinCodeBtn
    );

    const nm = h('input', { type: 'text', id: 'g-name', maxlength: '80', required: true });
    const topicIn = h('input', { type: 'text', id: 'g-topic', maxlength: '40', placeholder: t('optional') });
    const ds = h('textarea', { id: 'g-desc', maxlength: '500', rows: '2' });
    const avStatus = h('span', { class: 'small muted' });
    const avIn = h('input', { type: 'file', id: 'g-av', accept: 'image/png,image/jpeg,image/webp,image/gif', onChange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      const form = new FormData(); form.append('file', f);
      avStatus.textContent = t('composer.uploading');
      try { const m = await api('POST', '/api/media', undefined, { form }); createAvatarHash = m.hash; avStatus.textContent = f.name; toast(t('post.saved')); }
      catch (x) { avStatus.textContent = ''; fail(x); }
    } });
    const pv = h('input', { type: 'checkbox', id: 'g-priv' });
    const form = h('details', { class: 'card' },
      h('summary', {}, h('b', { text: t('groups.create') })),
      h('form', { class: 'col', style: 'margin-top:10px', onSubmit: async (e) => {
        e.preventDefault();
        try {
          const body = { name: nm.value, description: ds.value, visibility: pv.checked ? 'private' : 'open', topic: topicIn.value.trim() };
          if (createAvatarHash) body.avatar = createAvatarHash;
          const g = await api('POST', '/api/groups', body);
          go('#/groups/' + g.id);
        } catch (x) { fail(x); }
      } },
        h('label', { for: 'g-name' }, t('groups.name')), nm,
        h('label', { for: 'g-topic' }, t('groups.topic')), topicIn,
        h('label', { for: 'g-desc' }, t('groups.desc')), ds,
        h('label', { for: 'g-av' }, t('groups.avatar')), h('div', { class: 'row wrap' }, avIn, avStatus),
        h('label', { class: 'row', for: 'g-priv' }, pv, t('groups.private')),
        h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, t('groups.create')))
      )
    );

    const tabs = h('div', { class: 'feed-tabs', role: 'tablist' });
    const list = h('div', {}, spinner());

    const loadGroups = async () => {
      clear(list).append(spinner());
      try {
        const params = new URLSearchParams({ scope });
        const qv = searchIn.value.trim();
        if (qv) params.set('q', qv);
        const gs = await api('GET', '/api/groups?' + params.toString());
        if (!live(tok)) return;
        clear(list);
        if (!gs.length) return list.append(empty(t('groups.empty'), 'users'));
        gs.forEach((g) => {
          list.append(h('a', { class: 'post clickable', href: '#/groups/' + g.id },
            groupAvatarEl(g),
            h('div', { class: 'pbody' },
              append(h('div', { class: 'row wrap' }),
                h('b', { text: g.name }),
                g.topic ? h('span', { class: 'badge', text: '#' + g.topic }) : null,
                g.my_role ? h('span', { class: 'badge ok', text: t('groups.mine') }) : null,
                g.visibility === 'private' ? h('span', { class: 'badge' }, icon('lock', 'sm'), t('groups.private')) : null
              ),
              g.description ? h('div', { class: 'small muted', text: g.description }) : null,
              h('div', { class: 'small muted', text: t('groups.memberCount', { n: g.member_count }) })
            )
          ));
        });
      } catch (e) { clear(list).append(empty(errText(e))); }
    };

    const drawTabs = () => {
      clear(tabs);
      [['all', 'groups.tabAll'], ['joined', 'groups.tabJoined'], ['discover', 'groups.tabDiscover']].forEach(([k, key]) => {
        tabs.append(h('button', {
          type: 'button', role: 'tab', 'aria-selected': String(scope === k),
          onClick: () => { if (scope === k) return; scope = k; drawTabs(); loadGroups(); },
        }, t(key)));
      });
    };

    searchIn.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(loadGroups, 220); });
    drawTabs();
    view.append(top(t('groups.title')), h('div', { class: 'page col' }, h('p', { class: 'small muted', text: t('groups.localNote') }), searchIn, codeBar, form), tabs, list);
    await loadGroups();
  }

  async function viewGroup(view, tok, id, tab = 'posts') {
    view.append(top(t('groups.title'), { back: true })); const body = h('div', {}, spinner()); view.append(body);
    let g, members;
    try {
      [g, members] = await Promise.all([api('GET', '/api/groups/' + id), api('GET', '/api/groups/' + id + '/members')]);
      if (!g) throw Object.assign(new Error(), { code: 'E_NOT_FOUND' });
    } catch (e) { return clear(body).append(empty(errText(e), 'users')); }
    if (!live(tok)) return; clear(body);
    const me = members.find((m) => m.user_id === S.user.id);
    const admin = me && me.role === 'admin';
    const isOwner = !!g.is_owner || (g.owner_id === S.user.id);

    const editModal = () => {
      let avatarVal;
      const nm = h('input', { type: 'text', id: 'eg-name', maxlength: '80', value: g.name || '' });
      const tp = h('input', { type: 'text', id: 'eg-topic', maxlength: '40', value: g.topic || '' });
      const ds = h('textarea', { id: 'eg-desc', maxlength: '500', rows: '3' }); ds.value = g.description || '';
      const pv = h('input', { type: 'checkbox', id: 'eg-priv', checked: g.visibility === 'private' ? 'checked' : undefined });
      const avStatus = h('span', { class: 'small muted' });
      const avIn = h('input', { type: 'file', id: 'eg-av', accept: 'image/png,image/jpeg,image/webp,image/gif', onChange: async (e) => {
        const f = e.target.files[0]; if (!f) return;
        const form = new FormData(); form.append('file', f);
        avStatus.textContent = t('composer.uploading');
        try { const r = await api('POST', '/api/media', undefined, { form }); avatarVal = r.hash; avStatus.textContent = f.name; toast(t('post.saved')); }
        catch (x) { avStatus.textContent = ''; fail(x); }
      } });
      let m;
      m = modal(t('groups.edit'), h('div', { class: 'col' },
        h('label', { for: 'eg-name' }, t('groups.name')), nm,
        h('label', { for: 'eg-topic' }, t('groups.topic')), tp,
        h('label', { for: 'eg-desc' }, t('groups.desc')), ds,
        h('label', { for: 'eg-av' }, t('groups.avatar')), h('div', { class: 'row wrap' }, avIn, avStatus),
        h('label', { class: 'row', for: 'eg-priv' }, pv, t('groups.private')),
        h('div', { class: 'row wrap' },
          isOwner ? h('button', { type: 'button', class: 'btn danger', onClick: async () => {
            if (!await confirmDialog(t('groups.confirmDelete'), t('groups.delete'), true)) return;
            try { await api('DELETE', '/api/groups/' + id); m.close(); go('#/groups'); } catch (e) { fail(e); }
          } }, icon('trash', 'sm'), t('groups.delete')) : null,
          h('span', { class: 'grow' }),
          h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, t('cancel')),
          h('button', { type: 'button', class: 'btn primary', onClick: async () => {
            try {
              const payload = { name: nm.value, topic: tp.value, description: ds.value, visibility: pv.checked ? 'private' : 'open' };
              if (avatarVal !== undefined) payload.avatar = avatarVal;
              await api('PATCH', '/api/groups/' + id, payload);
              m.close();
              toast(t('post.saved'));
              route();
            } catch (e) { fail(e); }
          } }, t('save'))
        )
      ));
    };

    const leaveOrJoinBtn = me
      ? (isOwner && members.filter((m) => m.role === 'admin').length === 1 ? null : h('button', { class: 'btn', onClick: async () => { try { await api('POST', '/api/groups/' + id + '/leave', {}); toast(t('groups.left')); route(); } catch (e) { fail(e); } } }, t('groups.leave')))
      : (g.visibility === 'private' ? null : h('button', { class: 'btn primary', onClick: async () => { try { await api('POST', '/api/groups/' + id + '/join', {}); toast(t('groups.joined')); route(); } catch (e) { fail(e); } } }, t('groups.join')));

    const inviteBar = (me && g.invite_code) ? h('div', { class: 'group-invite-bar' },
      h('span', { class: 'small muted', text: t('groups.inviteCode') + ':' }),
      h('code', { class: 'id', text: g.invite_code }),
      h('button', { type: 'button', class: 'btn sm', onClick: () => copy(g.invite_code) }, icon('link', 'sm'), t('copy')),
      admin ? h('button', { type: 'button', class: 'btn sm', onClick: async () => {
        try { await api('PATCH', '/api/groups/' + id, { rotate_invite: true }); toast(t('post.saved')); route(); } catch (e) { fail(e); }
      } }, icon('refresh', 'sm'), t('groups.rotateInvite')) : null
    ) : null;

    body.append(append(
      h('div', { class: 'profilehead' }),
      append(h('div', { class: 'row wrap' }),
        groupAvatarEl(g, 'lg'),
        append(h('div', { class: 'grow' }),
          h('h2', { text: g.name }),
          append(h('div', { class: 'row wrap' }),
            g.topic ? h('span', { class: 'badge', text: '#' + g.topic }) : null,
            g.visibility === 'private' ? h('span', { class: 'badge' }, icon('lock', 'sm'), t('groups.private')) : null,
            h('span', { class: 'small muted', text: t('groups.memberCount', { n: members.length }) })
          )
        ),
        admin ? h('button', { type: 'button', class: 'btn', onClick: editModal }, icon('edit', 'sm'), t('groups.edit')) : null,
        leaveOrJoinBtn
      ),
      g.description ? h('p', { text: g.description }) : null,
      inviteBar,
      h('p', { class: 'small muted' }, icon('lock', 'sm'), ' ' + t('groups.localNote'))
    ));

    const holder = h('div', {}); const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const draw = () => {
      clear(tabs); [['posts', 'groups.posts'], ['files', 'groups.files'], ['members', 'groups.members']].forEach(([k, key]) => tabs.append(h('button', { role: 'tab', 'aria-selected': String(tab === k), onClick: () => { tab = k; draw(); } }, t(key))));
      clear(holder);
      if (tab === 'posts') {
        const feed = pagedList(
          async (c) => { const { data, headers } = await apiRaw('GET', '/api/groups/' + id + '/posts' + (c ? '?cursor=' + encodeURIComponent(c) : '')); return { items: data, next_cursor: headers.get('X-Next-Cursor') }; },
          {
            empty: t('groups.noPosts'),
            showGroupPinned: true,
            onGroupPin: admin ? async (p) => {
              try {
                await api('PATCH', '/api/groups/' + id, { pinned_post_id: p.is_group_pinned ? null : p.id });
                toast(t(p.is_group_pinned ? 'post.saved' : 'groups.pinned'));
                feed.reload();
              } catch (e) { fail(e); }
            } : null,
          }
        );
        append(holder, me ? composer({ groupId: Number(id), noVisibility: true, placeholder: t('groups.postPlaceholder'), onPosted: () => feed.reload() }) : null, feed);
      } else if (tab === 'files') {
        const shareAct = me ? h('div', { class: 'page row' },
          h('a', { class: 'btn primary sm', href: '#/files?group=' + encodeURIComponent(id) }, icon('share', 'sm'), t('groups.shareFile'))
        ) : null;
        const l = h('div', {}, spinner());
        append(holder, shareAct, l);
        api('GET', '/api/groups/' + id + '/files').then((fs) => {
          clear(l);
          if (!fs.length) return l.append(empty(t('groups.noFiles'), 'file'));
          fs.forEach((f) => {
            if (f.source === 'p2p_share') {
              l.append(h('a', { class: 'filechip', href: '#/files/' + encodeURIComponent(f.id) },
                icon(f.protected ? 'lock' : 'shield'),
                h('span', { class: 'grow' }, f.name || f.id),
                h('span', { class: 'small muted', text: (f.size ? formatBytes(f.size) + ' · ' : '') + (f.username || '') + ' · ' + timeAgo(f.created_at) }),
                icon('download', 'sm')
              ));
            } else {
              l.append(h('a', { class: 'filechip', href: UI.mediaSrc({ url: f.file_url, signed_url: f.signed_url }, f.file_url.startsWith('/media/')), download: '' },
                icon('file'),
                h('span', { class: 'grow' }, f.name || f.file_url.split('/').pop()),
                h('span', { class: 'small muted', text: f.username + ' · ' + timeAgo(f.created_at) }),
                icon('download', 'sm')
              ));
            }
          });
        }).catch((e) => clear(l).append(empty(errText(e))));
      } else {
        members.forEach((m) => holder.append(h('div', { class: 'post' }, avatar(m, 'sm'), h('div', { class: 'pbody' }, h('a', { href: '#/u/' + encodeURIComponent(m.username) }, h('b', { text: m.display_name || m.username })), ' ', h('span', { class: 'badge' }, t('groups.role.' + m.role)),
          admin ? h('div', { class: 'row wrap' }, h('button', { class: 'btn sm', onClick: async () => { try { await api('PATCH', '/api/groups/' + id + '/members/' + m.user_id, { role: m.role === 'admin' ? 'member' : 'admin' }); route(); } catch (e) { fail(e); } } }, m.role === 'admin' ? t('groups.makeMember') : t('groups.makeAdmin')), h('button', { class: 'btn sm danger', onClick: async () => { try { await api('DELETE', '/api/groups/' + id + '/members/' + m.user_id); route(); } catch (e) { fail(e); } } }, t('groups.remove'))) : null))));
        if (admin) api('GET', '/api/users').then((us) => { const cand = us.filter((u) => ['local', 'legacy'].includes(u.status) && !members.some((m) => m.user_id === u.id)); if (!cand.length) return; const sel = h('select', { 'aria-label': t('groups.addMember') }, h('option', { value: '' }, t('groups.pick')), cand.map((u) => h('option', { value: u.id }, u.display_name || u.username))); holder.append(h('div', { class: 'page row' }, sel, h('button', { class: 'btn', onClick: async () => { if (!sel.value) return; try { await api('POST', '/api/groups/' + id + '/members', { user_id: Number(sel.value) }); route(); } catch (e) { fail(e); } } }, t('groups.addMember')))); }).catch(() => {});
      }
    };
    draw(); body.append(tabs, holder);
  }

  // ---------- Secured P2P File Sharing ----------
  async function viewFiles(view, tok, arg) {
    let preGroupId = '';
    let highlightId = '';
    if (arg) {
      if (arg.startsWith('?')) {
        preGroupId = new URLSearchParams(arg.slice(1)).get('group') || '';
      } else {
        const [pathPart, qsPart] = String(arg).split('?');
        if (pathPart && !pathPart.startsWith('?')) highlightId = pathPart;
        if (qsPart) preGroupId = new URLSearchParams(qsPart).get('group') || '';
      }
    }

    let scope = 'all';
    let uploadedMedia = null;
    let joinedGroups = [];
    try { joinedGroups = await api('GET', '/api/groups?scope=joined'); } catch (_) { joinedGroups = []; }
    if (!live(tok)) return;

    const uploadMediaFile = async (file, statusEl) => {
      const CHUNK = 5 * 1024 * 1024;
      if (file.size > CHUNK) {
        const sess = await api('POST', '/api/media/sessions', { filename: file.name, size: file.size });
        const total = sess.totalChunks || Math.ceil(file.size / CHUNK);
        for (let i = 0; i < total; i++) {
          const end = Math.min(file.size, (i + 1) * CHUNK);
          statusEl.textContent = t('composer.uploading') + ' ' + Math.round((end / file.size) * 100) + '%';
          await apiRaw('PUT', '/api/media/sessions/' + sess.id + '/chunk/' + i, file.slice(i * CHUNK, end), { headers: { 'Content-Type': 'application/octet-stream' } });
        }
        return api('POST', '/api/media/sessions/' + sess.id + '/complete', {});
      }
      const form = new FormData();
      form.append('file', file);
      return api('POST', '/api/media', undefined, { form });
    };

    const fileLabel = h('span', { class: 'small muted' });
    const fileIn = h('input', { type: 'file', id: 'pf-file', onChange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      fileLabel.textContent = t('composer.uploading');
      try {
        uploadedMedia = await uploadMediaFile(f, fileLabel);
        fileLabel.textContent = (uploadedMedia.name || f.name) + ' (' + formatBytes(uploadedMedia.size || f.size) + ')';
      } catch (err) {
        uploadedMedia = null;
        fileLabel.textContent = '';
        fail(err);
      }
    } });

    const visSel = h('select', { id: 'pf-vis' },
      h('option', { value: 'public' }, t('files.scope.public')),
      h('option', { value: 'group' }, t('files.scope.group')),
      h('option', { value: 'recipient' }, t('files.scope.recipient'))
    );
    const grpSel = h('select', { id: 'pf-grp', class: 'hidden' },
      h('option', { value: '' }, t('groups.pick')),
      ...joinedGroups.map((g) => h('option', { value: String(g.id) }, g.name))
    );
    const recIn = h('input', { type: 'text', id: 'pf-rec', class: 'hidden', maxlength: '120', placeholder: t('files.recipientPh') });
    if (preGroupId && joinedGroups.some((g) => String(g.id) === String(preGroupId))) {
      visSel.value = 'group';
      grpSel.value = String(preGroupId);
      grpSel.classList.remove('hidden');
    }
    visSel.addEventListener('change', () => {
      grpSel.classList.toggle('hidden', visSel.value !== 'group');
      recIn.classList.toggle('hidden', visSel.value !== 'recipient');
    });

    const passIn = h('input', { type: 'password', id: 'pf-pass', maxlength: '64', placeholder: t('files.passcodePh') });
    const expIn = h('input', { type: 'number', id: 'pf-exp', min: '0', max: '8760', placeholder: '0' });
    const maxIn = h('input', { type: 'number', id: 'pf-max', min: '0', max: '10000', placeholder: '0' });
    const noteIn = h('input', { type: 'text', id: 'pf-note', maxlength: '300', placeholder: t('optional') });

    const shareBtn = h('button', { type: 'submit', class: 'btn primary' }, icon('share', 'sm'), t('files.shareBtn'));
    const form = h('form', { class: 'card col', onSubmit: async (e) => {
      e.preventDefault();
      if (!uploadedMedia || !uploadedMedia.hash) return toast(t('err.E_NO_FILE'), true);
      shareBtn.disabled = true;
      try {
        const body = {
          media_hash: uploadedMedia.hash,
          name: uploadedMedia.name,
          visibility: visSel.value,
          note: noteIn.value.trim(),
        };
        if (visSel.value === 'group') body.group_id = Number(grpSel.value);
        if (visSel.value === 'recipient') body.recipient = recIn.value.trim();
        if (passIn.value.trim()) body.passcode = passIn.value.trim();
        if (Number(expIn.value) > 0) body.expires_hours = Number(expIn.value);
        if (Number(maxIn.value) > 0) body.max_downloads = Number(maxIn.value);
        const r = await api('POST', '/api/p2p/files', body);
        uploadedMedia = null; fileIn.value = ''; fileLabel.textContent = ''; passIn.value = ''; noteIn.value = '';
        toast(t('files.created'));
        highlightId = r.item ? r.item.id : '';
        await loadList();
      } catch (err) { fail(err); }
      finally { shareBtn.disabled = false; }
    } },
      h('b', { text: t('files.upload') }),
      h('p', { class: 'small muted', text: t('files.subtitle') }),
      h('label', { for: 'pf-file' }, t('files.pick')),
      h('div', { class: 'row wrap' }, fileIn, fileLabel),
      h('label', { for: 'pf-vis' }, t('files.scope')), visSel,
      grpSel, recIn,
      h('div', { class: 'row wrap' },
        h('div', { class: 'col grow' }, h('label', { for: 'pf-pass' }, t('files.passcode')), passIn),
        h('div', { class: 'col grow' }, h('label', { for: 'pf-exp' }, t('files.expires')), expIn),
        h('div', { class: 'col grow' }, h('label', { for: 'pf-max' }, t('files.maxDl')), maxIn)
      ),
      h('label', { for: 'pf-note' }, t('optional')), noteIn,
      h('div', {}, shareBtn)
    );

    const tabs = h('div', { class: 'feed-tabs', role: 'tablist' });
    const list = h('div', { class: 'page col' }, spinner());

    const downloadShare = async (f, passcodeVal = '') => {
      const headers = { 'Content-Type': 'application/json' };
      if (net.sessionToken) headers['X-Hub-Session'] = net.sessionToken;
      if (net.csrf) headers['X-CSRF-Token'] = net.csrf;
      const res = await fetch('/api/p2p/files/' + encodeURIComponent(f.id) + '/download', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ passcode: passcodeVal }),
      });
      if (!res.ok) {
        let err = null;
        try { err = await res.json(); } catch (_) {}
        throw Object.assign(new Error((err && err.error) || 'download_failed'), { status: res.status, code: (err && err.code) || 'E_HTTP' });
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name || f.id;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };

    const promptAndDownload = (f) => {
      if (!f.has_passcode || f.is_owner) {
        downloadShare(f, '').then(() => loadList()).catch(fail);
        return;
      }
      const pw = h('input', { type: 'password', placeholder: t('files.enterPasscode'), autofocus: true });
      let m;
      const goDl = async () => {
        try {
          await downloadShare(f, pw.value);
          m.close();
          loadList();
        } catch (err) { fail(err); }
      };
      m = modal(f.name || t('files.download'), h('div', { class: 'col' },
        h('p', { class: 'small muted', text: t('files.enterPasscode') }),
        pw,
        h('div', { class: 'row' },
          h('span', { class: 'grow' }),
          h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, t('cancel')),
          h('button', { type: 'button', class: 'btn primary', onClick: goDl }, icon('download', 'sm'), t('files.download'))
        )
      ));
    };

    const renderFileCard = (f) => {
      const shareUrl = location.origin + '/#/files/' + encodeURIComponent(f.id);
      const card = h('div', { class: 'card p2p-file-card' + (highlightId === f.id ? ' highlight' : '') },
        append(h('div', { class: 'row wrap' }),
          icon(f.has_passcode ? 'lock' : 'file'),
          h('b', { class: 'grow', text: f.name }),
          f.sig_valid ? h('span', { class: 'badge ok' }, icon('shield', 'sm'), t('files.signed')) : null,
          f.has_passcode ? h('span', { class: 'badge warn' }, icon('lock', 'sm'), t('files.protected')) : null,
          f.group_name ? h('span', { class: 'badge', text: f.group_name }) : null
        ),
        f.note ? h('div', { class: 'small', text: f.note }) : null,
        h('div', { class: 'small muted row wrap' },
          h('span', { text: formatBytes(f.size) }),
          h('span', { text: '· @' + (f.owner_username || '') }),
          h('span', { text: '· ' + t('files.downloads', { n: String(f.downloads || 0) }) + (f.max_downloads ? ('/' + f.max_downloads) : '') }),
          h('span', { text: '· SHA-256 ' + String(f.sha256 || '').slice(0, 12) + '…' })
        ),
        append(h('div', { class: 'row wrap' }),
          (!f.expired && !f.limit_reached && f.available)
            ? h('button', { type: 'button', class: 'btn primary sm', onClick: () => promptAndDownload(f) }, icon('download', 'sm'), t('files.download'))
            : h('span', { class: 'badge bad', text: f.expired ? t('err.E_EXPIRED') : (f.limit_reached ? t('err.E_LIMIT_REACHED') : t('media.unavailable')) }),
          h('button', { type: 'button', class: 'btn sm', onClick: () => copy(shareUrl) }, icon('link', 'sm'), t('files.copyLink')),
          f.is_owner ? h('button', { type: 'button', class: 'btn sm danger', onClick: async () => {
            if (!await confirmDialog(t('files.confirmRevoke'), t('files.revoke'), true)) return;
            try { await api('DELETE', '/api/p2p/files/' + encodeURIComponent(f.id)); loadList(); } catch (err) { fail(err); }
          } }, icon('trash', 'sm'), t('files.revoke')) : null
        )
      );
      return card;
    };

    const loadList = async () => {
      clear(list).append(spinner());
      try {
        const items = [];
        if (highlightId) {
          try {
            const single = await api('GET', '/api/p2p/files/' + encodeURIComponent(highlightId));
            if (single && single.item) items.push(single.item);
          } catch (_) {}
        }
        const r = await api('GET', '/api/p2p/files?scope=' + encodeURIComponent(scope));
        if (!live(tok)) return;
        for (const it of (r.items || [])) {
          if (!items.some((x) => x.id === it.id)) items.push(it);
        }
        clear(list);
        if (!items.length) return list.append(empty(t('files.empty'), 'file'));
        items.forEach((f) => list.append(renderFileCard(f)));
      } catch (e) { clear(list).append(empty(errText(e), 'info')); }
    };

    const drawTabs = () => {
      clear(tabs);
      [['all', 'files.tabAll'], ['mine', 'files.tabMine']].forEach(([k, key]) => {
        tabs.append(h('button', {
          type: 'button', role: 'tab', 'aria-selected': String(scope === k),
          onClick: () => { if (scope === k) return; scope = k; drawTabs(); loadList(); },
        }, t(key)));
      });
    };

    drawTabs();
    view.append(top(t('files.title')), h('div', { class: 'page col' }, form), tabs, list);
    await loadList();
  }

  // ---------- network ----------
  async function viewNetwork(view, tok) {
    view.append(top(t('net.title')));
    const body = h('div', { class: 'page col' });
    view.append(body);
    const owner = S.user.is_primary;

    // --- Simple Network UI (defaults ON, auto share public posts) ---
    const simpleBox = h('div', { class: 'card col', id: 'net-simple' });
    body.append(simpleBox);
    const fillSimple = async () => {
      clear(simpleBox);
      simpleBox.append(h('p', { class: 'muted small', text: t('net.simple.intro') }));
      try {
        const ux = await api('GET', '/api/network/ux');
        const label = t(ux.label_key || ('net.ux.' + ux.ux)) || ux.ux;
        simpleBox.append(h('div', { class: 'row' }, icon('wifi', 'sm'), h('b', { class: 'grow', text: label })));
      } catch (e) { /* ignore */ }
      let ns = {};
      try { ns = await api('GET', '/api/network/settings'); } catch (e) { /* */ }
      const joined = ns.network_join !== false;
      const joinToggle = h('input', { type: 'checkbox', checked: joined ? 'checked' : undefined, id: 'net-join' });
      const privateBox = h('div', { class: 'col', style: joined ? 'display:none' : '' });
      const seedsIn = h('textarea', { rows: '3', placeholder: t('net.simple.seedsPh'), value: ns.custom_seeds || '', maxlength: '2000' });
      privateBox.append(
        h('p', { class: 'small muted', text: t('net.simple.privateHelp') }),
        h('label', {}, t('net.simple.seeds')),
        seedsIn,
        h('button', { type: 'button', class: 'btn sm', onClick: async () => {
          try {
            await api('POST', '/api/network/settings', { network_join: false, custom_seeds: seedsIn.value });
            toast(t('saved'));
            fillSimple();
          } catch (e) { fail(e); }
        } }, t('save'))
      );
      const applyJoinVisibility = (joined) => {
        privateBox.style.display = joined ? 'none' : '';
        try {
          const adv = body.querySelector('details.card.col') || advanced;
          if (adv) adv.style.display = joined ? 'none' : '';
        } catch (_) {}
        try {
          body.querySelectorAll('.net-p2p-card, .net-dir-card').forEach((el) => {
            el.style.display = joined ? '' : 'none';
          });
        } catch (_) {}
      };
      const cs = ns.community_status || {};
      const statusRow = h('div', { class: 'row wrap small' });
      if (!joined) {
        statusRow.append(h('span', { class: 'badge warn', text: t('net.private.activeBadge') }));
      } else if (cs.community_active) {
        statusRow.append(h('span', { class: 'badge ok', text: t('net.private.communityDetected', { n: String(cs.community_peers_count || 0) }) }));
      }
      joinToggle.onchange = async () => {
        const wantJoin = !!joinToggle.checked;
        if (!wantJoin) {
          let latest = ns;
          try { latest = await api('GET', '/api/network/settings'); } catch (_) {}
          const latestCs = latest.community_status || cs;
          if (latestCs && latestCs.community_active) {
            const count = Number(latestCs.community_peers_count || latestCs.p2p_peers_count || 0);
            const ok = await confirmDialog(
              t('net.private.confirmCreate', { n: String(count) }),
              t('net.private.confirmBtn'),
              true
            );
            if (!ok) {
              joinToggle.checked = true;
              return;
            }
          }
        }
        try {
          const r = await api('POST', '/api/network/settings', {
            network_join: wantJoin,
            content_sync: wantJoin ? 'trusted' : 'off',
            custom_seeds: wantJoin ? undefined : seedsIn.value,
          });
          applyJoinVisibility(wantJoin);
          if (wantJoin) {
            toast(t('net.simple.joined'));
          } else if (r && Number(r.disconnected_community_peers) > 0) {
            toast(t('net.private.disconnected', { n: String(r.disconnected_community_peers) }));
          } else {
            toast(t('net.simple.left'));
          }
          fillSimple();
          refresh({ soft: true });
        } catch (e) { fail(e); joinToggle.checked = !joinToggle.checked; }
      };
      clear(simpleBox);
      simpleBox.append(
        h('label', { class: 'row', style: 'gap:8px;align-items:center' }, joinToggle, h('span', { text: t('net.simple.join') })),
        statusRow.childNodes.length ? statusRow : null,
        h('p', { class: 'small muted', text: t('net.simple.joinHelp') }),
        privateBox
      );
      applyJoinVisibility(joined);
    };
    // Advanced diagnostics (collapsed) — status, presence, remote, connect, peers
    const intro = h('p', { class: 'muted', text: t('net.intro'), style: 'display:none' });
    const statusBox = h('div', { class: 'card row' }, h('div', { class: 'spinner', role: 'status' }));
    const presenceBox = h('div', { class: 'card col', id: 'presence-card' });
    const remoteBox = h('div', { class: 'card col' });
    const connectBox = h('div', { class: 'card col' });
    const peersBox = h('div', { class: 'col' });
    const advanced = h('details', { class: 'card col' },
      h('summary', { text: t('net.simple.advanced') }),
      statusBox, presenceBox, remoteBox, connectBox, peersBox
    );
    body.append(intro, advanced);
    if (owner) {
      fillSimple().catch(() => {});
      // Re-apply join visibility once advanced exists
      api('GET', '/api/network/settings').then((ns) => {
        const joined = ns.network_join !== false;
        advanced.style.display = joined ? 'none' : '';
        try { body.querySelectorAll('.net-p2p-card, .net-dir-card').forEach((el) => { el.style.display = joined ? '' : 'none'; }); } catch (_) {}
      }).catch(() => {});
    }

    let builtForms = false;
    let lastUrl = '';
    let inviteCode = '';
    let inviteLoad = null;
    const loadInviteCode = () => {
      if (inviteCode) return Promise.resolve(inviteCode);
      if (!inviteLoad) inviteLoad = api('GET', '/api/network/invite').then((r) => {
        if (!r || !r.invite) throw Object.assign(new Error('invite unavailable'), { code: 'E_NO_ENDPOINT' });
        inviteCode = r.invite; return inviteCode;
      }).finally(() => { inviteLoad = null; });
      return inviteLoad;
    };
    const showManualInvite = (code) => modal(t('net.copyInvite'), h('div', { class: 'col' },
      h('p', { class: 'small muted', text: t('net.copyInviteManual') }),
      h('textarea', { rows: '5', readonly: 'readonly', value: code, onFocus: (ev) => ev.target.select() })
    ));

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
      const ovIn = h('input', { type: 'text', id: 'ns-pub', value: '', placeholder: url || 'https://hub.example', maxlength: '300' });
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
            h('label', { class: 'row', style: 'gap:6px;align-items:center' },
              h('input', { type: 'checkbox', checked: s.content_sync === 'trusted' ? 'checked' : undefined, onChange: async (ev) => {
                try {
                  await api('PATCH', '/api/presence/settings', { content_sync: ev.target.checked ? 'trusted' : 'off' });
                  toast(t('net.contentSyncSaved'));
                  refresh({ soft: true });
                } catch (e) { fail(e); }
              }}),
              h('span', { class: 'small', text: t('net.contentSyncEnable') })
            ),
            h('p', { class: 'small muted', text: t('net.contentSyncHelp') }),
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
                  inviteCode = ''; inviteLoad = null; loadInviteCode().catch(() => {});
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
      // Prefetch the invite before the user clicks so Clipboard API still runs inside the click gesture.
      loadInviteCode().catch(() => {});
      connectBox.append(h('button', { type: 'button', class: 'btn sm', onClick: async () => {
        try {
          const hadCodeBeforeClick = !!inviteCode;
          if (!hadCodeBeforeClick) toast(t('net.inviteLoading'));
          const code = inviteCode || await loadInviteCode();
          // If the code had to be fetched after the click, transient browser clipboard permission may be gone.
          if (!hadCodeBeforeClick) { showManualInvite(code); return; }
          let copied = false;
          try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              await navigator.clipboard.writeText(code);
              copied = true;
            }
          } catch (_) { /* HTTP and embedded browsers may deny Clipboard API. */ }
          if (!copied) {
            const area = document.createElement('textarea');
            area.value = code; area.setAttribute('readonly', '');
            area.style.position = 'fixed'; area.style.opacity = '0'; area.style.pointerEvents = 'none';
            document.body.appendChild(area); area.focus(); area.select();
            try { copied = !!document.execCommand('copy'); } catch (_) { copied = false; }
            area.remove();
          }
          if (copied) toast(t('net.inviteCopied'));
          else showManualInvite(code);
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
            h('label', { class: 'row small', style: 'gap:6px;align-items:center' },
              h('input', { type: 'checkbox', checked: p.sync_content ? 'checked' : undefined, disabled: s.content_sync !== 'trusted' || p.state === 'blocked', onChange: async (ev) => {
                try { await api('PATCH', '/api/peers/' + p.id, { sync_content: !!ev.target.checked }); toast(t('net.contentSyncSaved')); refresh({ soft: true }); }
                catch (e) { fail(e); refresh({ soft: true }); }
              }}),
              h('span', { text: t('net.peerContentSync') }),
              p.sync_reason ? h('div', { class: 'small muted', text: t('net.sync.' + p.sync_reason) || p.sync_reason }) : null,
              (!p.sync_content && p.health === 'healthy') ? h('button', {
                type: 'button', class: 'btn small',
                onClick: async () => {
                  try {
                    await api('POST', '/api/peers/' + p.id + '/invite-sync', {});
                    toast(t('net.sync.inviteSent') || 'Sync invite sent');
                    refresh({ soft: true });
                  } catch (e) { toast(errorText(e), 'error'); }
                }
              }, t('net.sync.invite') || 'Invite sync') : null
            ),
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
        // Directory rendezvous status inside Technical details
        try {
          const dir = s.directory || (p2p.bootstrap && p2p.bootstrap.directory) || null;
          let dcard = advanced.querySelector('.net-dir-card');
          if (!dcard) {
            dcard = h('div', { class: 'card col net-dir-card' });
            statusBox.after(dcard);
          }
          clear(dcard);
          const ok = dir && dir.last_ok_at && !dir.last_error;
          const label = !dir ? t('net.dir.none') : (ok ? t('net.dir.ok') : t('net.dir.fail'));
          const badge = !dir ? '' : (ok ? 'ok' : 'warn');
          dcard.append(
            h('div', { class: 'row wrap' },
              icon('globe', 'sm'),
              h('b', { class: 'grow', text: t('net.dir.title') }),
              h('span', { class: 'badge ' + badge, text: label }),
              owner ? h('button', { type: 'button', class: 'btn sm', onClick: async () => {
                try {
                  const res = await api('POST', '/api/network/directory/sync', {});
                  toast(res && res.ok ? t('net.dir.ok') : t('net.dir.fail'), !(res && res.ok));
                  refresh({ soft: true });
                } catch (e) { fail(e); }
              } }, icon('refresh', 'sm'), t('net.dir.syncNow')) : null
            )
          );
          if (dir && dir.last_ok_at) {
            dcard.append(h('div', { class: 'small muted', text: t('net.dir.refresh', { t: timeAgo(new Date(dir.last_ok_at).toISOString()) }) }));
          }
        } catch (_) { /* never break Network page */ }

        // Prefer grouped problems; hide red/global dial noise when at least one link is healthy
        const problems = Array.isArray(p2p.problems) ? p2p.problems : [];
        if (problems.length && !(Number(p2p.peers) > 0)) {
          const top = problems[0];
          const label = t('net.problem.' + top.code) || top.sample || top.code;
          strip.append(h('div', { class: 'small muted', text: label }));
        } else if (problems.length && Number(p2p.peers) > 0) {
          const n = problems.reduce((s, x) => s + (x.count || 1), 0);
          strip.append(h('div', { class: 'small muted', text: t('net.problem.unreachable') + ' (' + n + ')' }));
        } else if (p2p.last_dial_error && !(Number(p2p.peers) > 0)) {
          strip.append(h('div', { class: 'small muted', text: t('net.p2p.dialError', { e: String(p2p.last_dial_error).slice(0, 100) }) }));
        }
        if (p2p.last_sync_hint) {
          strip.append(h('div', { class: 'small muted', text: t('net.p2p.started', { t: timeAgo(p2p.last_sync_hint) }) }));
        }

        // Bootstrap & Discovery diagnostics inside Technical details
        const bs = p2p.bootstrap;
        if (bs) {
          let bcard = advanced.querySelector('.net-bootstrap-card');
          if (!bcard) {
            bcard = h('div', { class: 'card col net-bootstrap-card' });
            statusBox.after(bcard);
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
        const label = (state === 'online' || state === 'network') ? t('presence.online')
          : state === 'error' ? t('presence.error')
          : state === 'connecting' ? t('presence.connecting')
          : state === 'local' ? t('presence.local')
          : t('presence.' + state) || state;
        const cls = (state === 'online' || state === 'network') ? 'ok' : (state === 'error' ? 'warn' : '');
        presenceBox.append(
          h('div', { class: 'row' }, icon('users', 'sm'), h('b', { class: 'grow', text: t('presence.title') }),
            h('span', { class: 'badge ' + cls, text: label })
          ),
          h('p', { class: 'small muted', text: t('presence.help') })
        );
        if (owner) {
          const enabled = !!(ps && ps.enabled !== false);
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
      const loadLogs = async (notifyErr = false) => {
        clear(box).append(spinner());
        try {
          const r = await api('GET', '/api/ai/logs');
          clear(box);
          const netLines = Array.isArray(r.network) ? r.network : [];
          if (netLines.length) {
            box.append(h('b', { text: t('assistant.logs.network') }));
            netLines.slice().reverse().slice(0, 40).forEach((line) => {
              box.append(h('pre', { class: 'small log-line', text: String(line) }));
            });
          }
          const aiOnly = Array.isArray(r.ai)
            ? r.ai
            : (r.logs || []).filter((x) => !(typeof x === 'string' && x.startsWith('[network]')));
          if (aiOnly.length) {
            box.append(h('b', { text: t('assistant.tabLogs') }));
            aiOnly.slice().reverse().slice(0, 60).forEach((line) => {
              box.append(h('pre', { class: 'small log-line', text: typeof line === 'string' ? line : JSON.stringify(line) }));
            });
          }
          if (!netLines.length && !aiOnly.length) {
            box.append(h('p', { class: 'muted small', text: t('assistant.logs.networkEmpty') }));
          }
        } catch (e) {
          clear(box).append(empty(errText(e), 'info'));
          if (notifyErr) fail(e);
        }
      };
      panel.append(
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', type: 'button', onClick: () => loadLogs(true) }, t('assistant.refreshLogs')),
          h('button', { class: 'btn sm danger', type: 'button', onClick: async () => {
            try {
              await api('DELETE', '/api/ai/logs');
              clear(box).append(h('p', { class: 'muted small', text: t('assistant.logs.networkEmpty') }));
              toast(t('done'));
            } catch (e) { fail(e); }
          } }, t('assistant.clearLogs'))
        ),
        box
      );
      await loadLogs(false);
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
    const langs = I18n.LANGS || [{ code: 'en', label: 'English' }, { code: 'vi', label: 'Tiếng Việt' }];
    body.append(sec(t('settings.language'), h('div', { class: 'lang-grid' }, langs.map(({ code, label }) => h('button', { class: 'btn sm' + (I18n.lang === code ? ' primary' : ''), 'aria-pressed': String(I18n.lang === code), onClick: async () => { I18n.set(code); try { await api('PATCH', '/api/me', { lang: code }); } catch (e) { /* offline ok */ } A.renderShell(); route(); } }, label)))));
    body.append(sec(t('settings.profile'), h('div', {}, h('button', { class: 'btn', onClick: async () => { try { editProfile(await api('GET', '/api/profiles/' + encodeURIComponent(S.user.username))); } catch (e) { fail(e); } } }, icon('edit', 'sm'), t('profile.edit')))));
    let idv; try { idv = await api('GET', '/api/identity'); } catch (e) { idv = null; }
    if (!live(tok)) return;
    if (idv) {
      const pw = h('input', { type: 'password', id: 'ex-pw', autocomplete: 'current-password' }); const pp = h('input', { type: 'password', id: 'ex-pp', autocomplete: 'new-password', minlength: '10' });
      body.append(sec(t('settings.identity'), h('p', { class: 'small muted', text: t('settings.identityHelp') }),
        h('div', { class: 'kv' }, h('span', { text: t('profile.accountId') }), h('code', { text: idv.account_id }), h('span', { text: t('settings.sequence', { n: idv.sequence }) }), h('span')),
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
              if (r.keys_missing && r.keys_missing.length) setTimeout(() => toast(t('key.backupWarn'), true), 1800);
            } catch (e) { fail(e); }
          } }, icon('download', 'sm'), t('settings.backup')),
          h('p', { class: 'small muted', text: t('settings.backupHelp') }),
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
    const cur = currentHash();
    if (navGoingBack) {
      navGoingBack = false;
    } else if (!navStack.length || navStack[navStack.length - 1] !== cur) {
      navStack.push(cur);
      if (navStack.length > 50) navStack.shift();
    }
    const raw = location.hash.replace(/^#\/?/, '');
    const qIdx = raw.indexOf('?');
    const pathPart = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    const hashQuery = qIdx >= 0 ? raw.slice(qIdx) : '';
    const parts = pathPart.split('/'); const name = parts[0] || 'home'; let arg = ''; try { arg = decodeURIComponent(parts.slice(1).join('/')); } catch (e) { arg = ''; }
    document.querySelectorAll('.nav [data-r]').forEach((a) => { const r = a.getAttribute('data-r'); const on = r === name || (r === 'u/me' && name === 'u' && arg.toLowerCase() === S.user.username.toLowerCase()); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    clear(view);
    const R = { home: () => viewHome(view, tok), explore: () => viewExplore(view, tok), search: () => viewSearch(view, tok, arg), post: () => viewPost(view, tok, arg), u: () => viewProfile(view, tok, arg), notifications: () => viewNotifications(view, tok), bookmarks: () => viewBookmarks(view), messages: () => viewMessages(view, tok, arg), groups: () => (arg ? viewGroup(view, tok, arg) : viewGroups(view, tok)), files: () => viewFiles(view, tok, arg + hashQuery), network: () => viewNetwork(view, tok), assistant: () => viewAssistant(view, tok), settings: () => viewSettings(view, tok) };
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
