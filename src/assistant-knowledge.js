'use strict';
/**
 * Canonical, server-side product knowledge injected into the Community Hub AI Panel.
 * Keep this file synchronized whenever product behavior or integration defaults change.
 * Never place credentials or private keys in this knowledge document.
 */
const FEEDBACK = Object.freeze({
  hubId: 'SHFH-CANNOI-0905428801',
  baseUrl: 'http://14.176.78.46:8090',
  appId: 'community-hub',
  appName: 'Community Hub',
});

const KNOWLEDGE = Object.freeze({
  product: 'Community Hub',
  purpose: 'A lightweight, international, self-hosted community and social app for ordinary users.',
  release: '2.3.2',
  languages: ['English', 'Vietnamese'],
  principles: [
    'Zero configuration for ordinary users: do not ask users to enter bootstrap URLs, Peer IDs, ports, Feedback Hub IDs, server URLs, or ingest tokens.',
    'Generate and persist a local cryptographic Peer ID automatically on first start.',
    'Use the built-in CANNOI bootstrap seed configuration to discover peers and exchange peer addresses automatically.',
    'Show actual P2P discovery/connection state; an HTTP health response alone is not proof of P2P reachability.',
    'Keep advanced network controls optional; do not require them for normal app use.',
    'Preserve existing social features, user data, identity keys, and Docker volumes during upgrades.',
    'Answer in the same language as the latest user message; supported product UI languages are English and Vietnamese.',
    'Never claim direct messages, relay traversal, or external connectivity works unless the running app verifies it.',
  ],
  bootstrap: {
    seedHttpUrl: 'http://14.176.78.46:28090',
    healthUrl: 'http://14.176.78.46:28090/health',
    bootstrapRegistryUrl: 'http://14.176.78.46:28090/p2p/bootstrap',
    p2pTransport: 'libp2p over WebSocket using the existing public application port where reverse-proxy WebSocket upgrade is supported',
    userAction: 'None for normal users; automatic discovery and retry are expected.',
    caveat: 'NAT, firewall rules, and reverse-proxy WebSocket support can prevent inbound connectivity. Distinguish seed discovery from an established P2P connection.',
  },
  feedbackHub: {
    hubId: FEEDBACK.hubId,
    publicBaseUrl: FEEDBACK.baseUrl,
    appId: FEEDBACK.appId,
    appName: FEEDBACK.appName,
    configuration: 'Fixed server-side defaults; users must not be asked to configure these values.',
    credentialPolicy: 'The ingest token is server-only. Never return it from an API, include it in AI context, expose it in browser assets, or write it to logs.',
    integrationVerification: 'A configured Hub ID and URL do not prove the remote Feedback Hub API is working. Verify real send/sync endpoints and report failures honestly.',
  },
  ai: {
    language: 'Reply in the language of the latest user message (Vietnamese or English).',
    style: 'Concise, friendly, practical, beginner-friendly; explain technical terms simply.',
    honesty: 'Do not invent current network state, remote API success, feature availability, or deployment status.',
  },
});

function forAI({ lang = 'en', version = KNOWLEDGE.release } = {}) {
  return {
    ...KNOWLEDGE,
    release: version || KNOWLEDGE.release,
    responseLanguage: lang === 'vi' ? 'Vietnamese' : 'English',
    // Return only non-secret product configuration. The ingest token is intentionally excluded.
  };
}

function prompt(lang = 'en', version = KNOWLEDGE.release) {
  const k = forAI({ lang, version });
  return [
    `PRODUCT KNOWLEDGE — ${k.product} ${k.release}`,
    `Purpose: ${k.purpose}`,
    `Response language: ${k.responseLanguage}. ${k.ai.style}`,
    'ZERO-CONFIGURATION: ordinary users must not be asked to enter technical bootstrap or Feedback Hub parameters.',
    `Bootstrap seed: ${k.bootstrap.seedHttpUrl}; health: ${k.bootstrap.healthUrl}; registry: ${k.bootstrap.bootstrapRegistryUrl}.`,
    `P2P transport: ${k.bootstrap.p2pTransport}. Caveat: ${k.bootstrap.caveat}`,
    `Feedback Hub ID: ${k.feedbackHub.hubId}; public base URL: ${k.feedbackHub.publicBaseUrl}; app ID: ${k.feedbackHub.appId}.`,
    'Security: never reveal or request the Feedback Hub ingest token, user passwords, private keys, or recovery files.',
    'Accuracy: distinguish configured endpoints, successful health checks, peer discovery, and real established P2P connections.',
    'Never claim the Feedback Hub send/sync API works until it is verified against the actual remote service.',
  ].join('\n');
}

module.exports = { KNOWLEDGE, FEEDBACK, forAI, prompt };
