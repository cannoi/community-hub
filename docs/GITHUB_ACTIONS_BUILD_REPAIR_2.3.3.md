# GitHub Actions Docker build repair — Community Hub 2.3.3

## Root cause

The 2.3.2 manifest pinned `@libp2p/gossipsub` to `14.1.0`. That version is not published under the `@libp2p` package scope, so npm returned `ETARGET`. The downstream Smoke test and Push tested image steps could not run successfully because the image build had already failed.

## Repair

- Pin `@libp2p/gossipsub` to `17.2.1`, a published release in the current `@libp2p` package line.
- Keep the runtime import specifier unchanged (`@libp2p/gossipsub`).
- Add a Docker build-time import/export check for `gossipsub`.
- For `Dockerfile.p2p`, generate a complete package lock from exact direct dependency pins during the build, validate lock integrity and registry URLs, and install with `npm ci`.

## Verification boundary

The source archive can be syntax-checked and its Node test suites can be run offline. A real Docker build and GitHub Actions run require access to `registry.npmjs.org` and GitHub's build environment; those are not available in this execution environment. The successful result must be confirmed by a new Actions run.

## Scope

No intentional changes to social features, chat, AI behavior, UI, identity format, persisted data, or Feedback Hub routes. Package version is bumped to 2.3.3.
