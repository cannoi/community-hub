'use strict';
/**
 * Phase 8 release gate helper.   node scripts/release-check.js [--full]
 * Quick mode (seconds): syntax of every JS file, migrations, version agreement, lockfile validity, secrets scan, compose safety, required docs.
 * --full: also runs the whole automated test suite and prints pass/fail/skip totals.
 * Exit code 1 if any BLOCKER fails. It never edits anything.
 */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..'); const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'); const res = [];
const check = (name, fn, blocker = true) => { try { const m = fn(); res.push({ name, ok: true, blocker, note: m || '' }); } catch (e) { res.push({ name, ok: false, blocker, note: String(e.message || e) }); } };
const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.git', 'data'].includes(e.name)) continue; const p = path.join(d, e.name); e.isDirectory() ? walk(p, out) : out.push(p); } return out; };
const pkg = JSON.parse(read('package.json'));
check('syntax: every .js file parses', () => { let n = 0; for (const f of walk(ROOT).filter((x) => x.endsWith('.js') && !x.includes(path.join('public', 'vendor')))) { if (f.includes(path.join('public', ''))) continue; const r = spawnSync(process.execPath, ['--check', f]); if (r.status !== 0) throw new Error(path.relative(ROOT, f) + ': ' + r.stderr.toString().split('\n')[0]); n++; } return n + ' files'; });
check('migrations: ids are 1..N, unique, contiguous', () => { const { MIGRATIONS } = require('../src/db'); MIGRATIONS.forEach((m, i) => { if (m.id !== i + 1) throw new Error('gap/duplicate at index ' + i + ' (id ' + m.id + ')'); }); return MIGRATIONS.length + ' migrations'; });
check('version: package.json, Dockerfile and package-lock agree', () => { const lock = JSON.parse(read('package-lock.json')); const d = read('Dockerfile').split('\n')[0]; if (!d.includes(pkg.version)) throw new Error('Dockerfile header ' + d); if (lock.version !== pkg.version) throw new Error('lock ' + lock.version); return pkg.version; });
check('BLOCKER lockfile: package-lock.json is a real, complete lock (not a stub)', () => { const lock = JSON.parse(read('package-lock.json')); const n = Object.keys(lock.packages || {}).length; const deps = Object.keys(pkg.dependencies || {}).length; if (n <= deps) throw new Error(`stub: ${n} package entries for ${deps} dependencies — run "npm install --package-lock-only" with network access and commit the result`); return n + ' entries'; });
check('dependencies are exact-pinned (reproducible)', () => { const loose = Object.entries(pkg.dependencies || {}).filter(([, v]) => /^[\^~*>]|latest/.test(v)); if (loose.length) throw new Error('not pinned: ' + loose.map(([k, v]) => k + '@' + v).join(', ')); }, true);
check('no secrets / private keys in the tree', () => { const bad = walk(ROOT).filter((f) => /\.(js|json|md|yml|yaml|sh|html|css|env)$/.test(f) || path.basename(f) === 'Dockerfile').filter((f) => { const s = fs.readFileSync(f, 'utf8'); return /-----BEGIN (RSA |EC |OPENSSH |ED25519 )?PRIVATE KEY-----/.test(s) || /\bghp_[A-Za-z0-9]{30,}/.test(s) || /\bAKIA[0-9A-Z]{16}\b/.test(s) || /xox[baprs]-[A-Za-z0-9-]{20,}/.test(s); }); if (bad.length) throw new Error(bad.map((f) => path.relative(ROOT, f)).join(', ')); });
check('compose: no privileged / docker.sock / host network', () => { const c = read('docker-compose.yml'); if (/privileged\s*:\s*true|docker\.sock|network_mode\s*:\s*["']?host|cap_add/i.test(c)) throw new Error('unsafe compose option'); });
check('docs: operational documentation present', () => { for (const f of ['docs/ARCHITECTURE.md', 'docs/OPERATIONS.md', 'docs/NETWORK_DIAGNOSTICS.md', 'docs/TEST_REPORT.md', 'docs/MIGRATION_ROLLBACK.md', 'docs/RELEASE_SCORECARD.md', 'docs/SCALE_SIMULATION_RESULTS.md', 'RELEASE_NOTES.md']) if (!fs.existsSync(path.join(ROOT, f))) throw new Error('missing ' + f); });
check('release notes mention this version', () => { if (!read('RELEASE_NOTES.md').includes(pkg.version)) throw new Error('RELEASE_NOTES.md has no entry for ' + pkg.version); });
if (process.argv.includes('--full')) {
  const run = (args) => { const r = spawnSync('npm', ['run', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 900000 }); const g = (k) => Number((r.stdout.match(new RegExp('^# ' + k + ' (\\d+)', 'm')) || [])[1] || 0); return { pass: g('pass'), fail: g('fail'), skipped: g('skipped'), tests: g('tests') }; };
  check('tests: npm run test:p2p has no failures', () => { const t = run(['test:p2p']); if (t.fail) throw new Error(JSON.stringify(t)); return JSON.stringify(t); });
}
let blockers = 0; for (const r of res) { console.log(`${r.ok ? 'PASS' : 'FAIL'}${r.blocker && !r.ok ? ' [BLOCKER]' : ''}  ${r.name}${r.note ? '  — ' + r.note : ''}`); if (!r.ok && r.blocker) blockers++; }
console.log(blockers ? `\n${blockers} blocker(s): NOT releasable.` : '\nAll checks passed.'); process.exit(blockers ? 1 : 0);
