'use strict';
const { HttpError } = require('../util');
const A = require('../assistant');
const { createQuota } = require('../ai/quota');

module.exports = function register(hub) {
  const { app, cfg, log, db } = hub;
  const quota = hub.aiQuota || createQuota({ daily: Number(process.env.AI_DAILY_QUOTA) || 40, db });

  function aiConfigured() {
    if (hub.ai && typeof hub.ai.configured === 'function' && hub.ai.configured()) return true;
    if (hub.ai && hub.ai.publicSettings) {
      try {
        const s = hub.ai.publicSettings();
        if (s && s.hasKey && s.provider && s.provider !== 'none') return true;
      } catch (_) { /* ignore */ }
    }
    return !!(cfg.ai && cfg.ai.baseUrl && cfg.ai.model);
  }

  app.get('/api/assistant/status', { auth: 'user' }, () => ({
    provider: aiConfigured() ? 'external' : 'local',
    model: aiConfigured() && hub.ai && hub.ai.publicSettings
      ? (hub.ai.publicSettings().model || null)
      : ((cfg.ai && cfg.ai.model) || null),
    external_disclosure: aiConfigured(),
  }));

  app.post('/api/assistant/chat', { auth: 'user', limit: 'assistant' }, async (ctx) => {
    const msg = typeof ctx.body.message === 'string' ? ctx.body.message.trim() : '';
    if (!msg || msg.length > 2000) throw new HttpError(400, 'E_INVALID', 'message is required (max 2000 characters)');
    const lang = A.detectLang(msg, ctx.body.lang || ctx.user.lang);
    if (!aiConfigured()) return { reply: A.localReply(msg, lang), lang, provider: 'local' };
    const q = quota.check(ctx.user.id);
    if (!q.allowed) return { reply: A.localReply(msg, lang), lang, provider: 'local', quota_exceeded: true, quota: q };
    const hist = (Array.isArray(ctx.body.history) ? ctx.body.history : []).slice(-10)
      .filter((h) => h && ['user', 'assistant'].includes(h.role) && typeof h.content === 'string')
      .map((h) => ({ role: h.role, content: h.content.slice(0, 2000) }));
    try {
      if (hub.ai && typeof hub.ai.chat === 'function') {
        const out = await hub.ai.chat({
          message: msg,
          history: hist,
          lang,
          context: { version: hub.version, features: { federation: !!(hub.peers && hub.peers.enabled) } },
        });
        const used = quota.consume(ctx.user.id);
        return { reply: out.reply || out.text || '', lang, provider: out.provider || 'external', quota: used };
      }
      const reply = await A.callModel(cfg.ai, [{ role: 'system', content: A.systemPrompt(lang) }, ...hist, { role: 'user', content: msg }]);
      const used = quota.consume(ctx.user.id);
      return { reply, lang, provider: 'external', quota: used };
    } catch (e) {
      log.warn('AI provider error: ' + e.message);
      return { reply: `${A.T.unavailable[lang]}\n\n${A.localReply(msg, lang)}`, lang, provider: 'local', ai_error: true };
    }
  });

  app.post('/api/assistant/compose', { auth: 'user', limit: 'assistant' }, async (ctx) => {
    const { text, mode } = ctx.body || {};
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new HttpError(400, 'E_INVALID', 'text is required (max 2000 characters)');
    if (!['improve', 'translate', 'hashtags', 'summarize'].includes(mode)) throw new HttpError(400, 'E_INVALID', 'invalid mode');
    const lang = A.detectLang(text, ctx.user.lang);
    const allowed = ['en', 'vi', 'zh', 'ja', 'ko', 'fr', 'es', 'de', 'th', 'id'];
    const targetLang = allowed.includes(ctx.body.target_lang)
      ? ctx.body.target_lang
      : (lang === 'vi' ? 'en' : 'vi');
    const langNames = {
      en: 'English', vi: 'Vietnamese', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
      fr: 'French', es: 'Spanish', de: 'German', th: 'Thai', id: 'Indonesian',
    };
    if (!aiConfigured()) {
      if (mode === 'hashtags') return { result: A.localHashtags(text).join(' '), provider: 'local', lang };
      throw new HttpError(503, 'E_AI_NOT_CONFIGURED', A.T.noai[lang], { lang });
    }
    const q = quota.check(ctx.user.id);
    if (!q.allowed) throw new HttpError(429, 'E_AI_QUOTA', 'Daily AI quota reached', { lang, quota: q });
    const target = langNames[targetLang] || targetLang;
    const instr = {
      improve: 'Improve the clarity and tone of this social media post. Keep the same language and meaning. Return only the rewritten post.',
      translate: `Translate this post into ${target}. Return only the translation, no quotes or commentary.`,
      hashtags: 'Suggest up to 5 relevant hashtags for this post, space separated, nothing else.',
      summarize: 'Summarize this text in one or two sentences in the same language.',
    }[mode];
    try {
      let result;
      if (hub.ai && typeof hub.ai.chat === 'function') {
        const out = await hub.ai.chat({
          message: instr + '\n\n---\n' + text,
          history: [],
          lang: targetLang,
          context: { task: mode, target_lang: targetLang },
        });
        result = out.reply || out.text || '';
      } else {
        result = await A.callModel(cfg.ai, [{ role: 'system', content: instr }, { role: 'user', content: text }]);
      }
      quota.consume(ctx.user.id);
      return { result, provider: 'external', lang, target_lang: targetLang };
    } catch (e) {
      log.warn('AI provider error: ' + e.message);
      throw new HttpError(502, 'E_AI_UNAVAILABLE', 'AI model unavailable', { lang });
    }
  });
};
