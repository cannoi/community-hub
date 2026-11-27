#!/usr/bin/env node
'use strict';
// Usage: node scripts/restore.js <backup-dir | backup.zip> [--force]     (stop the Hub first)
// Offline restore: replaces the database, keys and media of a STOPPED Hub. For a running Hub use the "Restore from ZIP"
// option on the setup screen instead.
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/config');
const { restoreBackup, restoreBackupZip } = require('../src/backup');
const src = process.argv[2];
if (!src) { console.error('Usage: node scripts/restore.js <backup-dir | backup.zip> [--force]'); process.exit(2); }
try {
  const abs = path.resolve(src);
  const opts = { force: process.argv.includes('--force') };
  const isZip = fs.existsSync(abs) && fs.statSync(abs).isFile();
  const r = isZip ? restoreBackupZip(loadConfig(), abs, opts) : restoreBackup(loadConfig(), abs, opts);
  console.log(`Restored ${r.restored} files. Start the Hub again.`);
} catch (e) { console.error('Restore failed: ' + e.message); process.exit(1); }
