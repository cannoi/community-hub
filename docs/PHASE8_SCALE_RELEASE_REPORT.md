# PHASE 8 — SCALE AND RELEASE (2.4.0-rc1)

**Verdict: release CANDIDATE, not release-ready (57/100).** See RELEASE_SCORECARD.md.

## Delivered
Scale simulation (100 → 1,000,000 Hubs, labelled algorithmic) · attack-matrix security suite · SoloHost compliance + constrained-process load tests · 150-session search load · release-check script · Architecture, Operations, Network Diagnostics, Test Report, Migration/Rollback, Scorecard documents · release notes · ZIP with SHA-256.

## Product defects found and fixed in this phase
1. Per-peer "sync off" ignored for trusted peers (privacy-relevant switch had no effect). 2. Index backfill blocked the event loop (p99 lag 8.7 s → 59 ms). 3. `busy/rate_limited` counted as peer failure, tripping circuit breakers against healthy peers. 4. Search planning cost unbounded in peer count. 5. `planAssignments`/`Directory.query` did full sorts per call. 6. HTTP timeouts enforced only every 30 s (slowloris window) — now 5 s. 7. `partial` reported for a single slow peer. 8. Seven stale tests (zero-config default, probe-back, error code) repaired.

## Findings that are design limits, NOT fixed (documented)
Plan agreement under partial views; 24-peer budget vs index coverage above ~1,000 Hubs; `capacityPower` does not help; no query anonymity; application-level DoS limits only.

## Remaining blockers
B1 real-network evidence (libp2p, multi-machine, Internet) · B2 real lockfile + audit · B3 browser/mobile UI check. Prompts to close them: `prompts/PROMPT_A_COMPLETE_REMAINING_UPGRADE.md`, `prompts/PROMPT_B_CLOUDFLARE_BOOTSTRAP_INTEGRATION.md`.

## Risk, SoloHost, rollback
Memory/CPU measured under a 192 MB heap cap (Pi hardware not measured). No privileged containers, no docker.sock. Rollback: feature flags or restore pre-upgrade backup (MIGRATION_ROLLBACK.md).
