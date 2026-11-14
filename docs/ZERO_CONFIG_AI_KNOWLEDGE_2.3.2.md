# Community Hub 2.3.2 — Zero Configuration & AI Product Knowledge

## User experience

Ordinary users must not be asked to enter bootstrap URLs, Peer IDs, P2P ports, Feedback Hub IDs, Feedback Hub base URLs, or ingest tokens. The app uses built-in CANNOI integration defaults. Account creation and sign-in credentials remain normal user actions. Advanced peer controls may remain available for administrators but are not required for normal use.

## Feedback Hub integration

- Hub ID: `SHFH-CANNOI-0905428801`
- Public base URL: `http://14.176.78.46:8090`
- App ID: `community-hub`
- App name: `Community Hub`
- Ingest credential: fixed in server-only `src/integrations/feedback-defaults.js`; intentionally excluded from browser assets, public API responses, logs and AI context.
- API contract: `GET /api/client-policy?app_id=...&version=...`, `GET /api/notices?app_id=...&anonymous_id=...`, `POST /api/feedback`, and `POST /api/notices/:id/read`.

The integration client follows the authoritative `lib/feedback-module/feedback-service.cjs` contract in `cannoi/solohost-feedback-hub`. A configured endpoint is not proof of live service availability; runtime send/sync must be verified against the deployed Hub.

## Security note

The supplied base URL uses plain HTTP. The server-side bearer credential is therefore not encrypted in transit. Do not publish this source ZIP or repository with the credential embedded. For production, rotate/restrict the credential and move the Feedback Hub endpoint to a trusted HTTPS deployment before distributing widely.

## AI Panel knowledge

`src/assistant-knowledge.js` is the canonical bilingual product knowledge source. It is injected into the legacy assistant system prompt, the AI chat request context and the app adapter context. It includes current release facts, zero-configuration guidance, bootstrap endpoint semantics, P2P caveats, Feedback Hub metadata and secret-handling rules. It deliberately excludes the ingest credential. Update this file whenever product behavior changes.

## Known limitations

The supplied ZIP's `lib/ai-module/ai-service.js` remains a stub. It reports no configured provider and does not implement the full AI Kernel/provider-management feature set. The new knowledge is wired into the app context and offline bilingual helper, but a live AI Kernel cannot consume it until the real AI module is restored/integrated.
