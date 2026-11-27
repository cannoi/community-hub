# WP completion report — 2.4.0 from 2.4.0-rc1

## Environment limits
- npm full install hit upstream 502 for some tarballs; `package-lock.json` regenerated via `npm install --package-lock-only`.
- No multi-region hosts available → WP2 field suites marked **NOT RUN**.
- Real libp2p multi-process tests require successful `npm ci` in CI image.

## Done
| WP | Item | Result |
|----|------|--------|
| WP1 | mDNS / multiaddr `getPeerId` TypeError | **PASS unit** — `src/net/p2p/peer-info.js` + discovery handler |
| WP1 | Contract tests for shapes | **PASS** 5/5 `tests/p2p-peer-info-normalize.test.js` |
| WP1 | Real libp2p suite unskipped | **NOT RUN** (packages not fully installed here) |
| WP2 | Field-test scripts + runbook | **Delivered** `scripts/field-test/` — evidence NOT RUN |
| WP3 | Scale design (manifest / 24-peer / metadata) | **Partial** — deferred full implement; documented as remaining risk |
| WP4 | chain_broken missing predecessor | **Code** fillGap-first repair |
| WP4 | Adaptive audit batch | **Code** |
| WP4 | `/api/admin/metrics` | **Code** owner-only |
| WP5 | Browser Explore | **NOT RUN** |
| WP6 | Real lockfile | **Yes** (lockfileVersion 3, full tree from registry metadata) |
| WP7 | Security follow-ups doc | **Yes** `docs/SECURITY_FOLLOWUPS_2.4.0.md` |
| WP8 | Scorecard | **62/100** honest (was 57) |

## Changed files (this pass)
- `src/net/p2p/peer-info.js` (new)
- `src/net/p2p/libp2p-adapter.js`
- `src/net/p2p/self-healing.js`
- `src/routes/admin.js`
- `tests/p2p-peer-info-normalize.test.js` (new)
- `scripts/field-test/*` (new)
- `docs/RELEASE_SCORECARD.md`, `docs/SECURITY_FOLLOWUPS_2.4.0.md`, `docs/WP_COMPLETION_2.4.0.md`
- `package-lock.json`, `package.json` version 2.4.0, `RELEASE_NOTES.md`

## Rollback
Revert to 2.4.0-rc1 tag/zip. Additive only; no schema migration in this pass.

## Remaining risks
- GA still blocked without real multi-machine evidence.
- WP3 scale plan agreement under partial views not fully implemented.
- Playwright UX not executed.
