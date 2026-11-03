'use strict';
// Browser end-to-end test (headless Chromium via Playwright). Not part of `npm test` because Playwright is a dev-only tool:
//   NODE_PATH=$(npm root -g) node tests/ui.e2e.js
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const os = require('os');
const { chromium } = require('playwright');
const { startHub, PNG } = require('./helpers');

(async () => {
  const hub = await startHub({ allowRegistration: false });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  let xss = false; page.on('dialog', (d) => { xss = true; d.dismiss(); });
  const out = path.join(os.tmpdir(), 'hub-shots'); fs.mkdirSync(out, { recursive: true });
  const step = (n) => console.log('  ✓ ' + n);

  await page.goto(hub.base);
  await page.waitForSelector('#su-user'); step('first run shows setup form');
  await page.fill('#su-user', 'owner'); await page.fill('#su-name', 'Hub Owner'); await page.fill('#su-pass', 'correct-horse-9');
  await page.screenshot({ path: path.join(out, '1-setup.png') });
  await page.click('button[type=submit]');
  await page.waitForSelector('.composer textarea'); step('setup → home with composer');

  // post with hashtag, link and an XSS attempt
  await page.fill('.composer textarea', 'Hello #World https://example.com/x <img src=x onerror=alert(1)> <script>alert(2)</script>');
  await page.click('.composer .btn.primary');
  await page.waitForSelector('.post .ptext');
  const html = await page.innerHTML('.post .ptext');
  assert.ok(html.includes('&lt;img'), 'markup shown as text'); assert.equal(await page.locator('.post .ptext img').count(), 0);
  assert.match(await page.getAttribute('.post .ptext a[href^="https://example.com"]', 'rel'), /noopener/);
  assert.equal(await page.locator('.post .ptext a.tag').innerText(), '#World'); step('post rendered safely (XSS payload inert, links hardened)');
  await page.waitForTimeout(300); assert.equal(xss, false);

  // image upload
  const png = path.join(out, 'pic.png'); fs.writeFileSync(png, PNG);
  await page.setInputFiles('.composer input[type=file]', png);
  await page.waitForSelector('.composer .chip');
  await page.fill('.composer textarea', 'with picture');
  await page.click('.composer .btn.primary');
  await page.waitForSelector('.media-grid img');
  await page.waitForFunction(() => { const i = document.querySelector('.media-grid img'); return i && i.complete && i.naturalWidth > 0; });
  step('image uploaded and displayed (lazy-loaded)');
  await page.click('.media-grid img'); await page.waitForSelector('.lightbox img'); await page.keyboard.press('Escape'); assert.equal(await page.locator('.lightbox').count(), 0); step('lightbox opens/closes with keyboard');

  // like / bookmark / notifications badge-less flow
  await page.click('.post .iconbtn.like'); await page.waitForSelector('.post .iconbtn.like.on');
  await page.click('.post .iconbtn.bm'); await page.waitForSelector('.post .iconbtn.bm.on'); step('like + bookmark toggles');
  await page.screenshot({ path: path.join(out, '2-home-desktop.png') });

  // Vietnamese UI
  await page.goto(hub.base + '/#/settings'); await page.waitForSelector('text=English');
  await page.click('button:has-text("Tiếng Việt")'); await page.waitForSelector('text=Cài đặt');
  assert.equal(await page.locator('.nav [data-r=home] .lbl').innerText(), 'Trang chủ'); assert.equal(await page.evaluate(() => document.documentElement.lang), 'vi'); step('switch to Vietnamese (labels + <html lang>)');

  // assistant answers in the user's language
  await page.goto(hub.base + '/#/assistant'); await page.waitForSelector('.chat');
  await page.fill('textarea', 'Làm sao để đăng bài?'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Để đăng bài/.test(document.querySelector('.chat').innerText));
  await page.fill('textarea', 'How can I follow someone?'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Open a profile/.test(document.querySelector('.chat').innerText));
  step('assistant replies in Vietnamese to Vietnamese and English to English');
  await page.screenshot({ path: path.join(out, '3-assistant-vi.png') });

  // messages screen is honest
  await page.goto(hub.base + '/#/messages'); await page.waitForSelector('text=Tin nhắn riêng chưa khả dụng'); step('messages shows honest disabled state');

  // groups: create, post
  await page.goto(hub.base + '/#/groups'); await page.fill('#g-name', 'Tech Enthusiasts'); await page.click('form button[type=submit]');
  await page.waitForSelector('text=Thảo luận'); await page.fill('.composer textarea', 'group hello'); await page.click('.composer .btn.primary'); await page.waitForSelector('text=group hello'); step('group create + post');

  // network view
  await page.goto(hub.base + '/#/network'); await page.waitForSelector('text=Chỉ cục bộ'); step('network view renders local-only state');

  // offline-first composition
  await page.goto(hub.base + '/#/home'); await page.waitForSelector('.composer textarea');
  await ctx.setOffline(true);
  await page.fill('.composer textarea', 'written while offline'); await page.click('.composer .btn.primary');
  await page.waitForSelector('.post.pending'); step('offline post queued and shown as pending');
  await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => !document.querySelector('.post.pending'), null, { timeout: 15000 });
  await page.reload(); await page.waitForSelector('text=written while offline'); step('queued post delivered after reconnect (exactly once)');
  assert.equal(hub.db.get("SELECT COUNT(*) c FROM posts WHERE content='written while offline'").c, 1);

  // mobile layout
  const m = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true }); const mp = await m.newPage();
  await mp.goto(hub.base); await mp.waitForSelector('#li-user'); await mp.fill('#li-user', 'owner'); await mp.fill('#li-pass', 'correct-horse-9'); await mp.click('button[type=submit]');
  await mp.waitForSelector('.composer textarea');
  const nav = await mp.locator('nav.nav').boundingBox(); assert.ok(nav.y > 700 && nav.width >= 380, 'bottom nav on mobile');
  assert.equal(await mp.locator('.side').isVisible(), false);
  assert.ok(await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal overflow');
  await mp.screenshot({ path: path.join(out, '4-home-mobile.png') }); step('mobile: bottom navigation, single column, no overflow');

  const bad = problems.filter((p) => !/Failed to load resource.*(40[14]|502|ERR_INTERNET_DISCONNECTED)/.test(p));
  assert.deepEqual(bad, [], 'no console errors / CSP violations: ' + bad.join(' | '));
  step('no console errors or CSP violations');
  await browser.close(); await hub.stop();
  console.log('UI E2E: PASS (screenshots in ' + out + ')');
})().catch((e) => { console.error('UI E2E: FAIL\n', e); process.exit(1); });
