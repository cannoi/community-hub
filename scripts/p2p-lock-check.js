#!/usr/bin/env node
'use strict';
/**
 * Gate used by Dockerfile.p2p (and by humans before committing a lockfile). Exit 0 = package.json and package-lock.json are
 * consistent, fully pinned and carry integrity hashes; exit 1 = print every problem. Pure Node, no dependencies.
 *   node scripts/p2p-lock-check.js [--dir <project dir>]
 */
const fs = require('fs');
const path = require('path');

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

function check(dir) {
  const problems = []; const warnings = [];
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { problems.push(`${f}: cannot read (${e.code || e.message})`); return null; } };
  const pkg = read('package.json'); const lock = read('package-lock.json');
  if (!pkg || !lock) return { ok: false, problems, warnings };
  const deps = pkg.dependencies || {};
  for (const [n, v] of Object.entries(deps)) if (!EXACT.test(v)) problems.push(`package.json: "${n}": "${v}" is not an exact version (ranges/URLs are not allowed for the P2P stack)`);
  if (!(lock.lockfileVersion >= 2)) problems.push(`package-lock.json: lockfileVersion ${lock.lockfileVersion} (need >= 2)`);
  const pk = lock.packages || {};
  const root = pk[''] || {};
  const rootDeps = root.dependencies || {};
  for (const [n, v] of Object.entries(deps)) if (rootDeps[n] !== v) problems.push(`package-lock.json: root entry does not list ${n}@${v} (lock is stale or was never generated — run scripts/p2p-lock.sh)`);
  for (const n of Object.keys(rootDeps)) if (!(n in deps)) problems.push(`package-lock.json: root lists ${n} which package.json does not`);
  for (const [n, v] of Object.entries(deps)) {
    const e = pk['node_modules/' + n];
    if (!e) problems.push(`package-lock.json: no entry for node_modules/${n}`);
    else if (e.version !== v) problems.push(`package-lock.json: ${n} is ${e.version}, package.json pins ${v}`);
  }
  const entries = Object.entries(pk).filter(([k]) => k !== '');
  if (Object.keys(deps).length && entries.length < Object.keys(deps).length) problems.push(`package-lock.json: only ${entries.length} package entries for ${Object.keys(deps).length} direct dependencies (empty/stub lockfile)`);
  for (const [k, e] of entries) {
    if (e.link) { problems.push(`${k}: symlinked package (link:true) is not allowed`); continue; }
    if (!e.resolved || !/^https:\/\/registry\.npmjs\.org\//.test(e.resolved)) problems.push(`${k}: resolved "${String(e.resolved).slice(0, 60)}" is not an https://registry.npmjs.org/ tarball`);
    if (!e.integrity || !SHA512.test(e.integrity)) problems.push(`${k}: missing or non-sha512 integrity`);
    if (e.hasInstallScript) warnings.push(`${k}: has an install script (the Docker build runs npm with --ignore-scripts)`);
  }
  if (root.version && pkg.version && root.version !== pkg.version) warnings.push(`package-lock.json root version ${root.version} != package.json ${pkg.version}`);
  return { ok: problems.length === 0, problems, warnings, packages: entries.length };
}

module.exports = { check };
if (require.main === module) {
  const i = process.argv.indexOf('--dir'); const dir = path.resolve(i > 0 ? process.argv[i + 1] : path.join(__dirname, '..'));
  const r = check(dir);
  for (const w of r.warnings) console.warn('WARN  ' + w);
  if (!r.ok) { for (const p of r.problems) console.error('FAIL  ' + p); console.error(`lock check FAILED (${r.problems.length} problem(s))`); process.exit(1); }
  console.log(`lock check OK (${r.packages} locked packages, all pinned with sha512 integrity)`);
}
