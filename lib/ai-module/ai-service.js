'use strict';
/**
 * Minimal stub for the AI service used by Community Hub.
 * Real implementation lives outside this ZIP; this keeps the Hub startable
 * and returns "not configured" so AI features degrade gracefully.
 */
function createAIService(opts = {}) {
  const MAX_LOGS = 200;
  const logs = [];
  const pushLog = (line) => {
    logs.push(`[${new Date().toISOString()}] ${String(line || '').slice(0, 500)}`);
    while (logs.length > MAX_LOGS) logs.shift();
  };
  return {
    configured() { return false; },
    publicSettings() {
      return { provider: 'none', model: '', mode: 'off', baseUrl: '', hasKey: false, maskedKey: '' };
    },
    catalog() { return []; },
    saveSettings() { return this.publicSettings(); },
    readLogs() { return logs.slice(); },
    clearLogs() { logs.length = 0; },
    async chat() {
      pushLog('info/ai chat requested while no external model is configured');
      const e = new Error('AI module not available in this build');
      e.code = 'NO_MODEL';
      throw e;
    },
    async complete() {
      pushLog('info/ai complete requested while no external model is configured');
      const e = new Error('AI module not available in this build');
      e.code = 'NO_MODEL';
      throw e;
    },
  };
}
module.exports = { createAIService };

