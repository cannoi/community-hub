'use strict';
/** E — integrity helpers note (full tombstone E2E needs two Hubs + owner tokens). */
console.log(JSON.stringify({
  class: 'NOT RUN without two authenticated Hubs',
  steps: [
    'Hub A creates public post',
    'Hub B syncs and materializes',
    'Hub A deletes (tombstone)',
    'Hub B must not resurrect content on re-sync',
  ],
}, null, 2));
