'use strict';
/**
 * Minimal stub for the AI service used by Community Hub.
 * Real implementation lives outside this ZIP; this keeps the Hub startable
 * and returns "not configured" so AI features degrade gracefully.
 */
function createAIService(opts = {}) {
  return {
    configured() { return false; },
    publicSettings() {
      return { provider: 'none', model: '', mode: 'off', baseUrl: '', hasKey: false, maskedKey: '' };
    },
    catalog() { return []; },
    saveSettings() { return this.publicSettings(); },
    async chat() {
      const e = new Error('AI module not available in this build');
      e.code = 'NO_MODEL';
      throw e;
    },
    async complete() {
      const e = new Error('AI module not available in this build');
      e.code = 'NO_MODEL';
      throw e;
    },
  };
}
module.exports = { createAIService };
