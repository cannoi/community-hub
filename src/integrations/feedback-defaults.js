'use strict';
/**
 * Feedback Hub defaults — server-side only.
 * Token must NEVER appear in API responses, browser bundles, or logs.
 * Override via SHFH_HUB_ID / SHFH_HUB_URL / SHFH_INGEST_TOKEN for operators.
 */
module.exports = Object.freeze({
  hubId: 'SHFH-CANNOI-0905428801',
  baseUrl: 'http://14.176.78.46:8090',
  ingestToken: 'cannoi_7Kp9xV2mQ8rN4tY6cL3wA5zD1eF0uH9',
  appId: 'community-hub',
  appName: 'Community Hub',
});
