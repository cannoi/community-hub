'use strict';
/** D — lightweight security smoke against a running Hub (no auth). */
const base = process.argv[2] || 'http://127.0.0.1:28090';
async function get(path) {
  const r = await fetch(base + path, { redirect: 'manual' });
  return { status: r.status, ct: r.headers.get('content-type') };
}
(async () => {
  const checks = [];
  for (const p of ['/api/admin/metrics', '/api/admin/healing', '/api/admin/export/events']) {
    const r = await get(p);
    checks.push({ path: p, status: r.status, expect: '401/403 without owner session' });
  }
  const reg = await fetch(base + '/p2p/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  checks.push({ path: '/p2p/register empty', status: reg.status });
  console.log(JSON.stringify({ base, checks, class: 'field-real-network-or-loopback' }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
