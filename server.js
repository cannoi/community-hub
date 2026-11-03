'use strict';
// Community Hub entry point. `npm start` / `node server.js` — listens on 0.0.0.0:$PORT (default 8080), GET /health.
const { createHub } = require('./src/hub');

let hub;
try { hub = createHub(); } catch (e) { console.error('Startup failed: ' + e.message); process.exit(1); }

hub.start().then((port) => {
  console.log(`Community Hub server running on port ${port}`);
  if (!hub.peers.self()) console.warn('Hub is not initialised yet: open the web UI to create the owner identity' + (hub.cfg.setupToken ? ' (setup token required).' : ' — set HUB_SETUP_TOKEN to restrict who can do this.'));
  if (hub.cfg.federationEnabled && !hub.cfg.publicUrl) console.warn('HUB_PUBLIC_URL is not set: other Hubs cannot verify or reach this Hub (outbound sync still works).');
}).catch((e) => { console.error('Cannot listen: ' + e.message); process.exit(1); });

let closing = false;
const shutdown = (sig) => {
  if (closing) return; closing = true;
  console.log(`${sig} received, shutting down...`);
  const t = setTimeout(() => process.exit(1), 10000); t.unref();
  hub.stop().then(() => process.exit(0), () => process.exit(1));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('unhandledRejection: ' + (e && e.message)));
