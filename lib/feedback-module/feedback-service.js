'use strict';
/**
 * CANNOI SoloHost Feedback Hub client.
 * Credential is injected by the server-only integration defaults and never returned.
 * API contract verified against cannoi/solohost-feedback-hub/lib/feedback-module/feedback-service.cjs.
 */
function createFeedbackService(opts = {}) {
  const cfg = {
    hubId: String(opts.hubId || ''),
    baseUrl: String(opts.baseUrl || '').replace(/\/$/, ''),
    ingestToken: String(opts.ingestToken || ''),
    appId: String(opts.appId || 'community-hub'),
    appName: String(opts.appName || 'Community Hub'),
    version: String(opts.version || '2.3.2'),
  };
  if (!cfg.baseUrl || !/^https?:\/\//i.test(cfg.baseUrl)) throw new Error('Feedback Hub base URL is invalid');

  async function request(method, pathname, body) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (cfg.ingestToken) headers.Authorization = 'Bearer ' + cfg.ingestToken;
    }
    const response = await fetch(cfg.baseUrl + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(`Feedback Hub HTTP ${response.status}`);
      error.status = response.status;
      error.code = 'FEEDBACK_HUB_HTTP';
      throw error;
    }
    return payload;
  }

  function publicConfig() {
    return {
      enabled: true,
      hubId: cfg.hubId,
      appId: cfg.appId,
      appName: cfg.appName,
      version: cfg.version,
    };
  }

  async function sync(anonymousId) {
    const policyQuery = `?app_id=${encodeURIComponent(cfg.appId)}&version=${encodeURIComponent(cfg.version)}`;
    const noticeQuery = `?app_id=${encodeURIComponent(cfg.appId)}&anonymous_id=${encodeURIComponent(String(anonymousId || '').slice(0, 80))}`;
    const [policy, notices] = await Promise.all([
      request('GET', '/api/client-policy' + policyQuery),
      request('GET', '/api/notices' + noticeQuery),
    ]);
    return { ok: true, policy, notices: Array.isArray(notices.items) ? notices.items : [], donate: policy.donate || null };
  }

  async function send(payload) {
    return request('POST', '/api/feedback', {
      ...payload,
      app_id: cfg.appId,
      app_name: cfg.appName,
      version: cfg.version,
    });
  }

  async function markRead(id) {
    return request('POST', '/api/notices/' + encodeURIComponent(String(id)) + '/read', {});
  }

  return { publicConfig, sync, send, markRead, appId: cfg.appId, appName: cfg.appName, version: cfg.version };
}

module.exports = { createFeedbackService };
