'use strict';
/**
 * Community Hub entry point.
 * Creates exactly one Hub instance and listens. SIGTERM/SIGINT trigger graceful stop.
 */
const { createHub } = require('./src/hub');

async function main() {
  const hub = createHub();
  const port = await hub.start();
  const host = hub.cfg.host || '0.0.0.0';
  console.log(`Community Hub ${require('./package.json').version} listening on http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
  if (hub.cfg.p2p && hub.cfg.p2p.enabled) {
    console.log('P2P enabled — status:', JSON.stringify(hub.net.status()));
  }

  const shutdown = async (sig) => {
    console.log(`\n${sig} received — shutting down…`);
    try {
      await hub.stop();
      process.exit(0);
    } catch (e) {
      console.error('shutdown error:', e && e.message);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('fatal:', e && e.stack || e);
  process.exit(1);
});
