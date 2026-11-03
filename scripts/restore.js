#!/usr/bin/env node
'use strict';
// Usage: node scripts/restore.js <backup-dir> [--force]     (stop the Hub first)
const { loadConfig } = require('../src/config');
const { restoreBackup } = require('../src/backup');
const src = process.argv[2];
if (!src) { console.error('Usage: node scripts/restore.js <backup-dir> [--force]'); process.exit(2); }
try { const r = restoreBackup(loadConfig(), require('path').resolve(src), { force: process.argv.includes('--force') }); console.log(`Restored ${r.restored} files. Start the Hub again.`); } catch (e) { console.error('Restore failed: ' + e.message); process.exit(1); }
