'use strict';
const { createHub } = require('./src/hub');

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err && (err.stack || err));
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err && (err.stack || err));
});

async function main() {
  const hub = createHub();
  const port = await hub.start();
  const host = hub.cfg.host || '0.0.0.0';
  console.log(`Community Hub ${require('./package.json').version} listening on ${host}:${port} (HTTP)`);
  if (hub.cfg.p2p && hub.cfg.p2p.enabled) {
    try { console.log('P2P enabled — status:', JSON.stringify(hub.net.status())); }
    catch (e) { console.log('P2P enabled — status unavailable:', e && e.message); }
  }
  const shutdown = async (sig) => {
    console.log(`\n${sig} received — shutting down…`);
    try { await hub.stop(); process.exit(0); }
    catch (e) { console.error('shutdown error:', e && e.message); process.exit(1); }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
main().catch((e) => { console.error('fatal:', e && e.stack || e); process.exit(1); });
