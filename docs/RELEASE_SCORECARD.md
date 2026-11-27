# Release scorecard — 2.4.0

Target: **>= 90/100 with evidence**. Critical privacy/data-loss/auth defects block release.

| Criterion | Weight | Score | Evidence / reason |
|---|---|---|---|
| Correctness & regression | 15 | 14 | Prior 314 pass path + new peer-info normalize tests; real libp2p suite still environment-dependent |
| Security & privacy | 20 | 15 | Prior attack matrix; metrics owner-only; no external pentest |
| Data integrity & recovery | 15 | 13 | chain_broken missing-pred fillGap path; adaptive audit batch; −2 long-disk-fault unproven |
| Zero-config & UX honesty | 10 | 6 | Defaults unchanged; browser/phone Explore not re-verified here (−4) |
| Real-network evidence | 20 | 0 | Field scripts delivered; **NOT RUN** on multi-region hosts in this environment |
| Performance & scale | 10 | 5 | Scale sim prior; search budget design limits remain |
| Operability & docs | 5 | 5 | field-test runbook, security follow-ups, metrics, scorecard |
| Supply chain & release hygiene | 5 | 4 | Real package-lock.json regenerated (`npm install --package-lock-only`); full `npm audit`/CI still operator-side |
| **Total** | **100** | **62** | |

## Verdict
**Still not general GA (62 < 90).** Improved RC: discovery crash class fixed, healing gap path, metrics, lockfile, field-test scaffolding. **Blocking for GA:** real multi-machine evidence (B1/WP2), browser UX pass (B3), scale design limits (WP3).

## NOT RUN (explicit)
- Multi-region Hub A/B/C acceptance A–F
- Real libp2p multi-process on CI image with full packages (sandbox may lack complete install)
- Playwright Explore Network EN/VI mobile
