'use strict';
// Optional browser E2E (developer tool, not part of `npm test`): needs Playwright + Chromium.
//   NODE_PATH=$(npm root -g) node tests/ui-e2e.js [screenshot-dir]
const path = require('path'); const fs = require('fs');
const { startHub, PNG } = require('./helpers');
let chromium; try { ({ chromium } = require('playwright')); } catch { console.error('playwright not installed'); process.exit(2); }
const shots = process.argv[2] || '/tmp/shots'; fs.mkdirSync(shots, { recursive: true });
const png = path.join(shots, 'test.png'); fs.writeFileSync(png, PNG);
const results = []; const ok = (n, c, extra) => { results.push([n, !!c]); console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + (extra || ''))); };

(async () => {
  const hub = await startHub({ allowRegistration: true, rateLimit: { general: 5000, write: 5000, login: 500, upload: 500, federation: 500, assistant: 50 } });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  const page = await ctx.newPage(); const problems = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => { if (!r.url().endsWith('/api/stream')) problems.push('requestfailed: ' + r.url()); }); // SSE streams are aborted on reload/logout by design
  const external = []; page.on('request', (r) => { if (!r.url().startsWith(hub.base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url()); });
  try {
    await page.goto(hub.base); await page.waitForSelector('#su-user');
    ok('setup screen shown on fresh hub', true);
    await page.fill('#su-user', 'owner'); await page.fill('#su-name', 'Hub Owner'); await page.fill('#su-pass', 'correct-horse-9');
    await page.screenshot({ path: path.join(shots, '01-setup.png') });
    await page.click('button[type=submit]'); await page.waitForSelector('.composer textarea');
    ok('owner created, home shown', await page.locator('.nav').count() === 1);
    await page.fill('.composer textarea', 'Hello <b>world</b> #Federation https://example.com/page <img src=x onerror=alert(1)>');
    await page.click('.composer .btn.primary'); await page.waitForSelector('.post .ptext');
    const txt = await page.locator('.post .ptext').first().innerText();
    ok('post rendered as text (HTML not interpreted)', txt.includes('<b>world</b>') && (await page.locator('.post b').count()) === 0 && (await page.locator('.post img[src=x]').count()) === 0);
    ok('hashtag and link are links', (await page.locator('.post a.tag').count()) === 1 && (await page.locator('.post a[href="https://example.com/page"]').count()) === 1);
    ok('external links are safe', (await page.locator('.post a[href^=http]').first().getAttribute('rel')).includes('noopener'));
    await page.click('.post .iconbtn.like'); await page.waitForSelector('.iconbtn.like.on'); ok('like toggles', true);
    await page.click('.post .iconbtn.bm'); await page.waitForSelector('.iconbtn.bm.on'); ok('bookmark toggles', true);
    // image upload
    await page.setInputFiles('.composer input[type=file]', png); await page.waitForSelector('.attach .chip button');
    await page.fill('.composer textarea', 'with picture'); await page.click('.composer .btn.primary'); await page.waitForSelector('.media-grid img');
    await page.waitForFunction(() => { const i = document.querySelector('.media-grid img'); return i && i.complete && i.naturalWidth > 0; });
    ok('image post shows loaded image', true);
    await page.click('.media-grid img'); await page.waitForSelector('.lightbox img'); ok('lightbox opens', true); await page.keyboard.press('Escape'); ok('lightbox closes on Escape', (await page.locator('.lightbox').count()) === 0);
    await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(100); await page.screenshot({ path: path.join(shots, '02-home.png') });
    // search
    await page.fill('.side input[type=search]', '#federation'); await page.keyboard.press('Enter'); await page.waitForSelector('.post');
    ok('hashtag search finds post', (await page.locator('.post').count()) >= 1);
    // groups
    await page.click('.nav a[data-r=groups]'); await page.click('text=Create group'); await page.fill('#g-n', 'Tech Enthusiasts'); await page.click('.modal .btn.primary'); await page.waitForSelector('.profilehead h2');
    await page.fill('.composer textarea', 'group hello'); await page.click('.composer .btn.primary'); await page.waitForSelector('.post .ptext');
    ok('group created and post shown', (await page.locator('.post .ptext', { hasText: 'group hello' }).count()) === 1);
    await page.click('.tabs button:has-text("Files")'); await page.click('.tabs button:has-text("Members")'); await page.waitForSelector('.post .badge'); ok('group tabs work', true);
    // messages disabled honestly
    await page.click('.nav a[data-r=messages]'); await page.waitForSelector('h2:has-text("not available yet")'); ok('messages honestly disabled', true);
    // network
    await page.click('.nav a[data-r=network]'); await page.waitForSelector('#peer-url'); ok('network page renders', true); await page.screenshot({ path: path.join(shots, '03-network.png') });
    // assistant in Vietnamese
    await page.click('.nav a[data-r=assistant]'); await page.fill('.composer textarea', 'Làm sao để đăng bài?'); await page.click('.composer .btn.primary');
    await page.waitForFunction(() => document.querySelectorAll('.bubble.bot').length >= 2 && /Để đăng bài/.test(document.querySelectorAll('.bubble.bot')[1].textContent));
    ok('assistant answers in Vietnamese to a Vietnamese question', true);
    await page.screenshot({ path: path.join(shots, '04-assistant.png') });
    await page.fill('.composer textarea', 'How do I follow someone?'); await page.click('.composer .btn.primary');
    await page.waitForFunction(() => /Follow/.test([...document.querySelectorAll('.bubble.bot')].pop().textContent));
    ok('assistant answers in English to an English question', true);
    // language switch
    await page.click('.nav a[data-r=settings]'); await page.click('button:has-text("Tiếng Việt")'); await page.waitForSelector('.nav a[data-r=home] .lbl:has-text("Trang chủ")');
    ok('UI switches to Vietnamese', true);
    await page.screenshot({ path: path.join(shots, '05-settings-vi.png'), fullPage: true });
    await page.click('.nav a[data-r=home]'); await page.waitForSelector('.post'); ok('Vietnamese home placeholder', (await page.locator('.composer textarea').getAttribute('placeholder')) === 'Bạn đang nghĩ gì?');
    // offline-first composition
    const before = problems.length; await ctx.setOffline(true); await page.fill('.composer textarea', 'written while offline'); await page.click('.composer .btn.primary');
    await page.waitForSelector('.post.pending'); ok('offline post queued', true);
    await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => !document.querySelector('.post.pending'), null, { timeout: 15000 }); problems.length = before; await page.reload(); await page.waitForSelector('.post');
    ok('queued post delivered after reconnect (once)', (await page.locator('.post .ptext', { hasText: 'written while offline' }).count()) === 1);
    // mobile layout
    await page.setViewportSize({ width: 390, height: 800 }); await page.waitForTimeout(200);
    const navBox = await page.locator('.nav').boundingBox();
    ok('mobile: bottom navigation', navBox.y > 600 && navBox.width > 300);
    await page.screenshot({ path: path.join(shots, '06-mobile.png') });
    // logout/login
    await page.setViewportSize({ width: 1280, height: 900 }); await page.click('.navfoot button'); await page.waitForSelector('#li-user'); ok('logout shows login', true);
    problems.length = 0; await page.fill('#li-user', 'owner'); await page.fill('#li-pass', 'wrong-wrong'); await page.click('button[type=submit]'); await page.waitForSelector('[role=alert]:not(.hidden)'); ok('wrong password shows error', true); problems.length = 0; // the 401 console line is the intended failed login
  } catch (e) { ok('E2E aborted: ' + e.message.split('\n')[0], false); await page.screenshot({ path: path.join(shots, 'error.png') }).catch(() => {}); }
  ok('no console errors / CSP violations', problems.length === 0, JSON.stringify(problems.slice(0, 5)));
  ok('no requests to external hosts', external.length === 0, JSON.stringify(external));
  await browser.close(); await hub.stop();
  const failed = results.filter((r) => !r[1]).length; console.log(`\n${results.length - failed}/${results.length} UI checks passed`); process.exit(failed ? 1 : 0);
})();
