#!/usr/bin/env node
'use strict';
// Usage: node scripts/backup.js <destination-dir>      (safe while the Hub is running)
const { loadConfig } = require('../src/config');
const { createBackup } = require('../src/backup');
const dest = process.argv[2];
if (!dest) { console.error('Usage: node scripts/backup.js <destination-dir>'); process.exit(2); }
const r = createBackup(loadConfig(), require('path').resolve(dest));
console.log(`Backup written to ${r.dest} (${r.files} files). Keep it private: it contains the encrypted identity key and the key-encryption material.`);
