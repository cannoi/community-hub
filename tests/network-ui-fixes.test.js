'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');

test('network registration checkbox reflects the saved enabled setting while still local/connecting', () => {
  const src = fs.readFileSync(path.join(root, 'public/views.js'), 'utf8');
  assert.match(src, /const enabled = !!\(ps && ps\.enabled !== false\);/);
  assert.doesNotMatch(src, /ps\.enabled !== false && state !== 'local'/);
  assert.match(src, /state === 'network'.*t\('presence\.online'\)/s);
});

test('invite copy supports Clipboard API, execCommand fallback, and a manual-copy dialog', () => {
  const src = fs.readFileSync(path.join(root, 'public/views.js'), 'utf8');
  assert.match(src, /navigator\.clipboard\.writeText\(code\)/);
  assert.match(src, /loadInviteCode\(\)\.catch/);
  assert.match(src, /hadCodeBeforeClick/);
  assert.match(src, /document\.execCommand\('copy'\)/);
  assert.match(src, /t\('net\.copyInviteManual'\)/);
  const i18n = fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8');
  assert.match(i18n, /net\.copyInviteManual/);
});


test('network UI exposes explicit public-content sync controls and explains privacy', () => {
  const src = fs.readFileSync(path.join(root, 'public/views.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'public/i18n.js'), 'utf8');
  assert.match(src, /content_sync: ev\.target\.checked \? 'trusted' : 'off'/);
  assert.match(src, /sync_content: !!ev\.target\.checked/);
  assert.match(i18n, /net\.contentSyncHelp/);
  assert.match(i18n, /net\.peerContentSync/);
  assert.match(i18n, /net\.p2p\.dialError/);
});
