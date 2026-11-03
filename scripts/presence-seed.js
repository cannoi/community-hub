#!/usr/bin/env node
'use strict';
// Usage: PORT=8080 PRESENCE_DB=./presence.db node scripts/presence-seed.js
const { createSeed } = require('../src/presence/seed-server');
const seed = createSeed();
seed.start().then((port) => console.log(`Presence seed listening on ${port} (register / heartbeat / resolve / search only)`)).catch((e) => { console.error('Cannot start seed: ' + e.message); process.exit(1); });
const stop = () => seed.stop().then(() => process.exit(0), () => process.exit(1));
process.on('SIGTERM', stop); process.on('SIGINT', stop);
