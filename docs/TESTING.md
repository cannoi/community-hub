# Testing

```bash
npm test                                       # 40 tests: unit + multi-instance integration + real-process tests (≈15–20 s)
NODE_PATH=$(npm root -g) node tests/ui.e2e.js  # browser E2E (Playwright + Chromium, dev tool only)
npm run test:health                            # legacy probe of a running server (test.js)
```
Integration tests start **independent Hub instances** (own data dir, SQLite DB, keystore, uploads, HTTP port) in one process and talk to each other over real HTTP; network partitions are simulated by a transport wrapper. Reliability tests spawn the real `node server.js`.

## Scenario → test map
| # | Scenario | Test file / name |
|---|---|---|
| 1,2 | identity created, survives restart | identity: A1/A2 |
| 3,4 | forged actor/invalid signature, unauthorized edit/react/group changes | identity: A3/A4 |
| 5 | private keys never in responses/logs/DB | identity: A5 |
| 6–9 | valid event, tamper, duplicate, missing sequence | ledger: B6/B7, B8, B9 (+fork, rollback, canonical form) |
| 10 | rebuild views from persisted events | ledger: B10; reliability: admin reindex |
| 11 | incompatible schema fails safely | ledger: B11 |
| 12,13,17 | two/three independent Hubs replicate; no central DB | federation: C12/C13, C17 gossip |
| 14,15 | partition → catch-up; duplicates ignored | federation: C14/C15 |
| 16 | invalid/unauthorized events and peers | federation: C16, C16b (malicious proxy), endpoint change |
| 18,19 | posts/replies/reactions/follows; cursors + permissions | social: D18, D19 |
| 20,21 | image upload/retrieval; oversize/invalid | social: D20/D21 |
| 22 | video range + seeking | social: D22 |
| 23 | restricted media not public (also to peers) | social: D23; federation: media test |
| 24 | existing groups & file sharing | social: D24; identity: legacy DB adoption |
| 25,26 | health, persistence across restart | reliability: E25/E26 (real process, SIGTERM) |
| 27 | backup/restore keeps identity + history | reliability: E27, E27b; CLI checked manually |
| 28,29 | bounded input, safe errors, rate limits | reliability: E28/E29 |
| 30 | dependency/security checks | reliability: E30 + hardening (SQLi) + static scan + `npm audit` |
| – | performance guards | perf.test.js |
| – | i18n key parity, SQL injection | hardening.test.js |

## Recorded results (this delivery)
See the final report. `npm test` → 40 tests, 40 pass (3 consecutive runs identical); browser E2E → PASS (14 steps); `npm audit` → 0 vulnerabilities (no dependencies).
