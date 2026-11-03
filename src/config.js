'use strict';
const path = require('path');

const int = (v, d, min = -Infinity, max = Infinity) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Build the runtime configuration from an env-like object (process.env by default). */
function loadConfig(env = process.env, overrides = {}) {
  const root = path.resolve(__dirname, '..');
  const dataDir = path.resolve(env.DATA_DIR || path.join(root, 'data'));
  const cfg = {
    root,
    port: int(env.PORT, 8080, 0, 65535),
    host: env.HOST || '0.0.0.0',
    dataDir,
    dbFile: path.join(dataDir, 'community.db'), // same path as the original app
    uploadDir: path.resolve(env.UPLOAD_DIR || path.join(dataDir, 'uploads')),
    legacyUploadDir: path.join(root, 'uploads'), // old location, still served read-only for old links
    keyDir: path.join(dataDir, 'keys'),
    publicDir: path.join(root, 'public'),
    logLevel: env.LOG_LEVEL || 'info',
    nodeEnv: env.NODE_ENV || 'development',

    // identity / auth
    keyPassphrase: env.HUB_KEY_PASSPHRASE || '',
    setupToken: env.HUB_SETUP_TOKEN || '',
    allowRegistration: bool(env.HUB_ALLOW_REGISTRATION, false),
    sessionDays: int(env.HUB_SESSION_DAYS, 14, 1, 90),
    cookieSecure: env.HUB_COOKIE_SECURE === undefined ? 'auto' : bool(env.HUB_COOKIE_SECURE, false),
    trustProxy: bool(env.HUB_TRUST_PROXY, false) ? int(env.HUB_TRUST_PROXY_HOPS, 1, 1, 5) : 0,
    scryptN: int(env.HUB_SCRYPT_N, 16384, 1024, 1 << 20),

    // limits
    maxUploadBytes: int(env.MAX_UPLOAD_MB, 512, 1, 4096) * 1024 * 1024, // default 512 MiB videos
    userQuotaBytes: int(env.HUB_USER_QUOTA_MB, 2048, 1, 1048576) * 1024 * 1024, // default 2 GiB per user
    remoteCacheBytes: int(env.HUB_REMOTE_CACHE_MB, 0, 0, 1048576) * 1024 * 1024, // 0 = never mirror remote media to disk (opt-in)
    maxJsonBytes: 256 * 1024,
    maxRangeBytes: int(env.HUB_MAX_RANGE_MB, 8, 1, 256) * 1024 * 1024,
    maxPostChars: 2000,
    rateLimit: { // requests per window (60s) per client IP unless noted
      general: int(env.HUB_RL_GENERAL, 600, 1),
      write: int(env.HUB_RL_WRITE, 90, 1),
      login: int(env.HUB_RL_LOGIN, 8, 1),
      upload: int(env.HUB_RL_UPLOAD, 20, 1),
      federation: int(env.HUB_RL_FEDERATION, 240, 1),
      assistant: int(env.HUB_RL_ASSISTANT, 20, 1),
      presence: int(env.HUB_RL_PRESENCE, 120, 1),
    },

    // federation
    publicUrl: (env.HUB_PUBLIC_URL || '').replace(/\/+$/, ''),
    bootstrapPeers: list(env.HUB_BOOTSTRAP_PEERS),
    federationEnabled: bool(env.HUB_FEDERATION, true),
    federationMode: env.HUB_FEDERATION_MODE === 'allowlist' ? 'allowlist' : 'open',
    allowPrivatePeers: bool(env.HUB_ALLOW_PRIVATE_PEERS, false), // SSRF guard; enable for LAN/test only
    syncIntervalMs: int(env.HUB_SYNC_INTERVAL_MS, 30000, 200),
    syncBatch: int(env.HUB_SYNC_BATCH, 100, 1, 200),
    syncMaxBatchesPerCycle: 20,
    maxPeers: int(env.HUB_MAX_PEERS, 50, 1, 500),
    backoffBaseMs: int(env.HUB_BACKOFF_BASE_MS, 5000, 10),
    backoffMaxMs: int(env.HUB_BACKOFF_MAX_MS, 900000, 100),
    peerTimeoutMs: int(env.HUB_PEER_TIMEOUT_MS, 8000, 100),

    // Global Presence, Local Content
    // Content (posts/media/timelines) is NOT synchronised in bulk by default; remote content is fetched on demand.
    contentSync: env.HUB_CONTENT_SYNC === 'trusted' ? 'trusted' : 'off',
    presence: {
      enabled: bool(env.PRESENCE_ENABLED, true),
      seeds: list(env.PRESENCE_SEEDS || env.HUB_SEEDS),     // bootstrap directory seeds (no built-in IPs)
      serve: bool(env.PRESENCE_SERVE, false),               // act as a directory seed (register / heartbeat / resolve only)
      heartbeatMs: int(env.PRESENCE_HEARTBEAT_MS, 300000, 200),
      timeoutMs: int(env.PRESENCE_TIMEOUT_MS, 3000, 100, 30000),
      onlineMs: int(env.PRESENCE_ONLINE_MS, 900000, 1000),
      retainMs: int(env.PRESENCE_RETAIN_DAYS, 7, 1, 365) * 86400000,
      maxEntries: int(env.PRESENCE_MAX_ENTRIES, 20000, 10, 1000000),
      region: String(env.PRESENCE_REGION || '').toUpperCase().slice(0, 2),
    },
    remote: { // on-demand remote content cache (bounded, never part of the ledger)
      maxEvents: int(env.HUB_REMOTE_VIEW_MAX_EVENTS, 3000, 100, 100000),
      perActor: 80,
      ttlMs: int(env.HUB_REMOTE_VIEW_TTL_MIN, 1440, 1) * 60000,
      freshMs: 120000,
    },

    // optional AI (never required)
    ai: {
      baseUrl: (env.AI_BASE_URL || '').replace(/\/+$/, ''),
      apiKey: env.AI_API_KEY || '',
      model: env.AI_MODEL || '',
      timeoutMs: int(env.AI_TIMEOUT_MS, 30000, 1000),
    },

    // P2P network adapter (Phase 1 foundation). Disabled by default.
    // When false (default), HTTPS federation + Presence behave exactly as before.
    // libp2p is not required and is not loaded until Phase 2+.
    p2p: {
      enabled: bool(env.P2P_ENABLED, false),
      maxConnections: int(env.P2P_MAX_CONNECTIONS, 50, 1, 500),
      dialTimeoutMs: int(env.P2P_DIAL_TIMEOUT_MS, 15000, 1000, 120000),
      bootstrap: list(env.P2P_BOOTSTRAP),
      listen: list(env.P2P_LISTEN),
    },
  };
  return Object.assign(cfg, overrides);
}
module.exports = { loadConfig };
