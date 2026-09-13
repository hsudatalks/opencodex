---
name: opencodex-release
description: Use when cutting, versioning, packaging, or pushing a release of this repository, including the Univers Gateway release train, version bumps, package contents, or deciding whether a change is ready to ship.
whenToUse: Version bumps, packaging, "is this ready", or publishing commits and releases.
---

# Releasing this repository

Two release lines exist and they are not interchangeable:

- **Upstream line** — `scripts/release.ts` (npm publish, `gh`-driven CI, clean
  tree required). Targets `main`/`preview` and the public package.
- **Univers line** — `2.11.0-univers.NN` versions on the `univers/univers-gateway`
  branch, deployed to the central Gateway. This is the line that carries the
  multi-account and DeepSeek replay work.

Ship the Univers line unless the task is explicitly about the public package.

## Branch and remotes

```text
origin   https://github.com/hsudatalks/opencodex.git      # Univers fork
upstream https://github.com/lidge-jun/opencodex.git       # upstream project
branch   univers/univers-gateway
```

Upstream's own policy (in `AGENTS.md`) is that every PR targets `dev`. Do not
open upstream PRs against `main`.

## Gates

```bash
./node_modules/bun/bin/bun.exe run typecheck    # tsc --noEmit
./node_modules/bun/bin/bun.exe run test         # full tests/ suite
./node_modules/bun/bin/bun.exe run build:gui    # required: gui/dist is gitignored
./node_modules/bun/bin/bun.exe run privacy:scan # credential/privacy scan
```

Typecheck must be **clean** before shipping. Do not accept "pre-existing" type
errors without identifying the commit that introduced them — one was a real
runtime `ReferenceError` in a live release.

### Use the pinned Bun explicitly

There is no `bun` on this host's `PATH`. Always call
`./node_modules/bun/bin/bun.exe`. Plain `bun run ...` works only where a shell
resolves it. Note that `bun pm pack` and the `prepack` hook spawn a bare `bun`
and fail with `bun: command not found`; call
`./node_modules/bun/bin/bun.exe scripts/prepare-package.ts` directly, or use the
deploy script from `univers-machine`, which packages without npm hooks.

### Known test baseline

On this macOS host some suites fail for environmental reasons and are **not**
caused by your change. Establish a baseline instead of guessing — a clean
worktree at the parent commit plus a symlinked `node_modules` is enough:

```bash
git worktree add -f /tmp/ocx-baseline <parent-commit>
ln -sfn "$PWD/node_modules" /tmp/ocx-baseline/node_modules
(cd /tmp/ocx-baseline && ./node_modules/bun/bin/bun.exe test <files>)
```

As of `2.11.0-univers.63` the standing failures are:

- `generated model metadata stays in sync with its source`,
  `routeModel registry effort defaults … (issue #88)`, and the DeepSeek legacy
  reasoner replay expectation — stale assertions versus the DeepSeek V4.1 model
  work; decide which side is authoritative before "fixing".
- `two real processes contend for one lock` — needs real process isolation.
- `doctor-gui-if-changed` / `lint-gui-if-changed` — spawn a bare `bun`.
- `production adapter contract rejects omitted translator budgets at typecheck`
  and two combo-failover cases.

## Cutting a Univers release

1. Land the change with tests; `typecheck` clean.
2. Bump `"version"` in `package.json` to the next `2.11.0-univers.NN`.
3. Commit and push promptly, in reviewable batches — one concern per commit.
   Long-lived uncommitted work is how features end up living only on the server.
4. Deploy with the `opencodex-central-gateway` skill's script, passing the pushed
   ref, and keep the previous release as the rollback target.
5. Verify the live source matches the pushed commit, not just that health is 200:

```bash
git archive <commit> src | tar -x -C /tmp/ref
(cd /tmp/ref/src && find . -type f | sort | xargs sha256sum) > /tmp/ref.txt
ssh ubuntu@47.131.65.97 'cd /home/ubuntu/.local/share/opencodex-univers/current/node_modules/univers-gateway/src && find . -type f | sort | xargs sha256sum' > /tmp/live.txt
diff -q /tmp/ref.txt /tmp/live.txt
```

## Package contents

`package.json` `files` is the package set: `bin`, `src`, `gui/dist`, `assets`,
`README.md`, `AGENTS_INSTALL.md`, `LICENSE`. Keep release archives to that set —
archiving the whole tree ships `tests/`, `docs-site/`, and `devlog/` into the
release directory for no runtime benefit.
