'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadI18n() {
  const code = fs.readFileSync(path.join(__dirname, '../../public/i18n.js'), 'utf8');
  const sandbox = { console, window: {}, document: { documentElement: { lang: '' } }, localStorage: { getItem: () => null, setItem: () => {} } };
  vm.createContext(sandbox);
  // i18n attaches to window.I18n
  vm.runInContext(code + '\nthis.I18n = window.I18n;', sandbox);
  return sandbox.window.I18n || sandbox.I18n;
}

function extractKeys(src) {
  const set = new Set();
  for (const m of src.matchAll(/['"]([^'"]+)['"]\s*:/g)) set.add(m[1]);
  for (const m of src.matchAll(/(?:^|,)\s*([a-zA-Z_][\w]*)\s*:/gm)) set.add(m[1]);
  return set;
}

describe('2.2.0 WP7 i18n + cleanup', () => {
  it('EN and VI share the same key set', () => {
    const raw = fs.readFileSync(path.join(__dirname, '../../public/i18n.js'), 'utf8');
    const viIdx = raw.indexOf('const vi = {');
    const en = extractKeys(raw.slice(raw.indexOf('const en = {'), viIdx));
    const vi = extractKeys(raw.slice(viIdx));
    const onlyEn = [...en].filter((k) => !vi.has(k)).sort();
    const onlyVi = [...vi].filter((k) => !en.has(k)).sort();
    assert.deepEqual(onlyEn, [], 'keys only in EN: ' + onlyEn.join(','));
    assert.deepEqual(onlyVi, [], 'keys only in VI: ' + onlyVi.join(','));
  });

  it('critical dynamic keys exist in both languages', () => {
    const I18n = loadI18n();
    assert.ok(I18n && I18n.t);
    const keys = [
      'groups.role.owner', 'groups.role.admin', 'notif.mention', 'notif.group', 'vis.private',
      'auth.connectHubIntro', 'net.addHelp', 'assistant.tabChat', 'assistant.fbSend',
      'media.chunking', 'embed.preview',
    ];
    for (const lang of ['en', 'vi']) {
      I18n.set(lang);
      for (const k of keys) {
        const v = I18n.t(k);
        assert.ok(v && v !== k, lang + ' missing ' + k);
        // EN strings should not be predominantly Vietnamese for connect intro
        if (lang === 'en' && k === 'auth.connectHubIntro') {
          assert.ok(!/Bước này|tách biệt/.test(v), 'EN intro still Vietnamese');
        }
      }
    }
  });

  it('dead ai-panel.css is removed', () => {
    assert.equal(fs.existsSync(path.join(__dirname, '../../public/ai-panel.css')), false);
  });
});
