'use strict';
/**
 * Feedback Hub defaults — server-side only.
 * Token must NEVER appear in API responses, browser bundles, or logs.
 * Fixed CANNOI integration. Credentials stay server-side and are never sent to AI or browsers.
 */
module.exports = Object.freeze({
  hubId: 'SHFH-CANNOI-0905428801',
  baseUrl: 'http://14.176.78.46:8090',
  ingestToken: 'cannoi_7Kp9xV2mQ8rN4tY6cL3wA5zD1eF0uH9',
  appId: 'community-hub',
  appName: 'Community Hub',
});
