'use strict';
/**
 * Ring buffer of recent P2P / network events for diagnostics (AI panel + Network page).
 * Plain text lines, no secrets. Max ~200 entries.
 */
const MAX = 200;
const buf = [];

function push(level, code, message, extra) {
  const line = {
    at: new Date().toISOString(),
    level: String(level || 'info').slice(0, 16),
    code: String(code || 'net').slice(0, 40),
    message: String(message || '').slice(0, 240),
  };
  if (extra && typeof extra === 'object') {
    try {
      const s = JSON.stringify(extra);
      if (s.length < 200) line.extra = s;
    } catch { /* ignore */ }
  }
  buf.push(line);
  while (buf.length > MAX) buf.shift();
  return line;
}

function list(limit = 100) {
  const n = Math.min(MAX, Math.max(1, Number(limit) || 100));
  return buf.slice(-n);
}

function clear() { buf.length = 0; }

function formatLines(limit = 100) {
  return list(limit).map((e) => `[${e.at}] ${e.level}/${e.code} ${e.message}${e.extra ? ' ' + e.extra : ''}`);
}

module.exports = { push, list, clear, formatLines };
