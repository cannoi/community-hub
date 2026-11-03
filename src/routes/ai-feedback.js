'use strict';
const { HttpError } = require('../util');
const path = require('path');
const { createAIService } = require('../../lib/ai-module/ai-service');
const { createFeedbackService } = require('../../lib/feedback-module/feedback-service');
const adapter = require('../../lib/app-adapter');
const { createQuota } = require('../ai/quota');
const A = require('../assistant');
const fbDefaults = require('../integrations/feedback-defaults');

function safePublicError(e) {
  const s = String((e && e.message) || e || 'AI provider unavailable');
  return s
    .replace(/([?&](?:key|api_key|token|access_token)=[^&\s]+)/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .slice(0, 700);
}

function errorCode(e) {
  if (e && e.code === 'NO_MODEL') return 'NO_MODEL';
  if (e && e.code === 'TIMEOUT') return 'TIMEOUT';
  if (e && e.code === 'NETWORK') return 'NETWORK_ERROR';
  if (e && e.code === 'NOT_JSON') return 'BAD_BASE_URL';
  if (e && e.code === 'EMPTY_RESPONSE') return 'EMPTY_RESPONSE';
  const st = e && e.status;
  return st === 401 ? 'AUTH_ERROR' : st === 403 ? 'FORBIDDEN' : st === 404 ? 'MODEL_OR_ENDPOINT_NOT_FOUND' : st === 429 ? 'RATE_LIMIT' : 'AI_PROVIDER_ERROR';
}

/** Sanitize client history: only user/assistant, max 8, each ≤ 2000 chars (AI-01). */
function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(-12)) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role === 'assistant' || item.role === 'bot' ? 'assistant' : item.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = String(item.content || item.text || '').slice(0, 2000);
    if (!content) continue;
    out.push({ role, content });
    if (out.length >= 8) break;
  }
  return out;
}

module.exports = function register(hub) {
  const { app, cfg, log, db } = hub;
  const dataDir = path.join(cfg.dataDir || path.join(__dirname, '..', '..', 'data'));

  const ai = createAIService({
    dataDir,
    appName: 'Community Hub',
    adapter,
  });

  const fbOpts = {
    hubId: process.env.SHFH_HUB_ID || fbDefaults.hubId,
    baseUrl: process.env.SHFH_HUB_URL || fbDefaults.baseUrl,
    ingestToken: process.env.SHFH_INGEST_TOKEN || fbDefaults.ingestToken,
    appId: fbDefaults.appId,
    appName: fbDefaults.appName,
    version: hub.version || require('../../package.json').version,
  };
  const fb = createFeedbackService(fbOpts);
  hub.ai = ai;
  hub.feedback = fb;
  const quota = createQuota({ daily: Number(process.env.AI_DAILY_QUOTA) || 40, db: hub.db });
  hub.aiQuota = quota;

  // ---- AI ----
  // Anonymous: only configured boolean (AI-04)
  app.get('/api/ai/status', { auth: 'none' }, (ctx) => {
    if (!ctx.user) return { configured: ai.configured() };
    const s = ai.publicSettings();
    return {
      configured: ai.configured(),
      provider: s.provider || 'none',
      modelLabel: s.model || 'auto',
    };
  });

  app.get('/api/ai/catalog', { auth: 'owner' }, () => ({ providers: ai.catalog() }));

  app.get('/api/ai/settings', { auth: 'owner' }, () => {
    const s = ai.publicSettings();
    // Owner sees provider/model/mode/hasKey/maskedKey but not full key; baseUrl only for owner
    return {
      provider: s.provider,
      model: s.model,
      mode: s.mode,
      baseUrl: s.baseUrl || '',
      hasKey: !!s.hasKey,
      maskedKey: s.maskedKey || '',
    };
  });

  app.post('/api/ai/settings', { auth: 'owner', limit: 'write' }, (ctx) => {
    try {
      return { ok: true, settings: ai.saveSettings(ctx.body || {}) };
    } catch (e) {
      throw new HttpError(400, 'E_AI_SETTINGS', e.message || 'save failed');
    }
  });

  app.get('/api/ai/models', { auth: 'owner' }, async () => {
    try { return await ai.refreshModels(); }
    catch (e) { throw new HttpError(502, errorCode(e), safePublicError(e)); }
  });

  app.post('/api/ai/test', { auth: 'owner', limit: 'assistant' }, async () => {
    try { return await ai.testConnection(); }
    catch (e) { throw new HttpError(502, errorCode(e), safePublicError(e)); }
  });

  app.post('/api/ai/chat', { auth: 'user', limit: 'assistant' }, async (ctx) => {
    const b = ctx.body || {};
    const message = String(b.message || '').trim().slice(0, 4000);
    if (!message) throw new HttpError(400, 'E_INVALID', 'message required');
    // AI-01: ignore client knowledge / system roles / confirmedActions
    const history = sanitizeHistory(b.history);
    const lang = b.lang === 'vi' || b.lang === 'en' ? b.lang : undefined;
    const screen = typeof b.screen === 'string' ? b.screen.slice(0, 40) : undefined;
    const detectedLang = lang || A.detectLang(message, ctx.user && ctx.user.lang);
    // Prefer offline guide first when model not configured
    if (!ai.configured()) {
      const text = A.localReply(message, detectedLang);
      return { ok: true, reply: text, provider: 'local', model: 'offline-guide', lang: detectedLang };
    }
    const q = quota.check(ctx.user.id);
    if (!q.allowed) {
      const text = A.localReply(message, detectedLang);
      return { ok: true, reply: text, provider: 'local', model: 'offline-guide', lang: detectedLang, quota: q, quota_exceeded: true };
    }
    try {
      const out = await ai.chat({
        message,
        history,
        context: {
          lang: detectedLang,
          screen,
          version: hub.version,
          features: {
            federation: !!(hub.peers && hub.peers.enabled),
          },
        },
      });
      const used = quota.consume(ctx.user.id);
      return { ok: true, reply: out.reply || out.text || '', provider: out.provider, model: out.model, source: out.source, lang: detectedLang, quota: used };
    } catch (e) {
      try {
        const text = A.localReply(message, detectedLang);
        if (text) return { ok: true, reply: text, provider: 'local', model: 'offline-guide', lang: detectedLang, ai_error: true };
      } catch (_) { /* fall through */ }
      throw new HttpError(502, errorCode(e), safePublicError(e));
    }
  });

  app.get('/api/ai/logs', { auth: 'owner' }, () => ({ logs: ai.readLogs() }));
  app.delete('/api/ai/logs', { auth: 'owner' }, () => { ai.clearLogs(); return { ok: true }; });
  app.get('/api/logs', { auth: 'owner' }, () => ({ logs: ai.readLogs() }));
  app.delete('/api/logs', { auth: 'owner' }, () => { ai.clearLogs(); return { ok: true }; });

  // ---- Feedback (FB-01..03) — session required; token never returned ----
  app.get('/api/feedback/config', { auth: 'none' }, () => ({
    enabled: true,
    appName: fbOpts.appName,
    version: fbOpts.version,
  }));

  const syncCache = { at: 0, data: null, key: '' };

  app.get('/api/feedback/sync', { auth: 'user' }, async (ctx) => {
    const anonymousId = String((ctx.query && ctx.query.anonymous_id) || '').slice(0, 80);
    const cacheKey = ctx.user.id + ':' + anonymousId;
    try {
      // feedback-service.sync expects a string, not an object (FB-02)
      const data = await Promise.race([
        fb.sync(anonymousId),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
      ]);
      syncCache.at = Date.now();
      syncCache.data = data;
      syncCache.key = cacheKey;
      return data;
    } catch (e) {
      if (syncCache.data && syncCache.key === cacheKey && Date.now() - syncCache.at < 300000) {
        return Object.assign({}, syncCache.data, { stale: true });
      }
      throw new HttpError(502, 'E_FEEDBACK_UNAVAILABLE', 'Feedback Hub unavailable');
    }
  });

  app.post('/api/feedback', { auth: 'user', limit: 'write' }, async (ctx) => {
    const b = ctx.body || {};
    const message = String(b.message || '').trim().slice(0, 4000);
    const type = ['bug', 'improvement', 'question'].includes(b.type) ? b.type : 'improvement';
    const rating = Math.min(5, Math.max(1, Number(b.rating) || 5));
    if (!message) throw new HttpError(400, 'E_INVALID', 'message required');
    // Server forces app_id / version — ignore client (FB-01)
    const safe = {
      type,
      rating,
      message,
      anonymous_id: String(b.anonymous_id || '').slice(0, 80),
      lang: b.lang === 'vi' ? 'vi' : 'en',
      app_id: fbOpts.appId,
      app_name: fbOpts.appName,
      version: fbOpts.version,
    };
    try {
      const data = await Promise.race([
        fb.send(safe),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
      ]);
      return data;
    } catch (e) {
      // Durable queue (WP3) — max 50 rows
      try {
        const n = db.get('SELECT COUNT(*) AS c FROM feedback_outbox')?.c || 0;
        if (n < 50) {
          db.run(
            'INSERT INTO feedback_outbox(user_id,payload,attempts,next_at,created_at) VALUES(?,?,?,?,?)',
            ctx.user.id, JSON.stringify(safe), 0, Date.now() + 30000, Date.now()
          );
          return { ok: true, queued: true, message: 'Saved offline; will send when connected' };
        }
      } catch (_) { /* table may not exist on very old db mid-start */ }
      throw new HttpError(502, 'E_FEEDBACK_UNAVAILABLE', 'Feedback Hub unavailable');
    }
  });

  app.post('/api/feedback/read/:id', { auth: 'user', limit: 'write' }, async (ctx) => {
    const id = String(ctx.params.id || '').slice(0, 80);
    if (!id) throw new HttpError(400, 'E_INVALID', 'id required');
    // Per-user local mark (FB-01) — still notify hub best-effort
    try {
      db.run("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", 'fb_read_' + ctx.user.id + '_' + id, '1');
    } catch (_) { /* meta ok */ }
    try {
      await Promise.race([
        fb.markRead(id),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
      ]);
    } catch (_) { /* local mark still counts */ }
    return { ok: true };
  });
};
