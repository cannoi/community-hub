'use strict';
/**
 * Directory seeds come ONLY from configuration (PRESENCE_SEEDS, alias HUB_SEEDS). The source code ships no IP address:
 * a seed is infrastructure the operator chooses, not something baked into every user's Hub.
 */
function configuredSeeds(cfg) {
  if (cfg && cfg.presence && Array.isArray(cfg.presence.seeds)) return cfg.presence.seeds.slice();
  return String(process.env.PRESENCE_SEEDS || process.env.HUB_SEEDS || '').split(',').map((s) => s.trim()).filter(Boolean);
}
/** First configured seed (kept for the optional "default" trusted-peer shortcut); '' when none is configured. */
function resolveDefaultSeed(cfg) { return configuredSeeds(cfg)[0] || ''; }

module.exports = { configuredSeeds, resolveDefaultSeed, seeds: Object.freeze([]) };
