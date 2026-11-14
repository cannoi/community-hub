'use strict';
/** Server-side product context adapter for the Community Hub AI integration. */
const knowledge = require('../src/assistant-knowledge');
module.exports = {
  name: 'community-hub',
  version: '2.3.2',
  getContext({ lang = 'en' } = {}) { return knowledge.forAI({ lang, version: '2.3.2' }); },
};
