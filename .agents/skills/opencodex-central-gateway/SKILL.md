---
name: opencodex-central-gateway
description: Use when operating, deploying, rolling back, verifying, or debugging the central Univers Gateway that runs this repository's code on the public EC2 host — releases, the opencodex-central systemd service, Command Code and OpenCode account pools, provider quota, or live 4xx/5xx triage.
whenToUse: Any task that touches the deployed Gateway rather than only this checkout.
---

# Central Univers Gateway operations

The central Gateway runs **this repository's source** on one public EC2 host and
serves the Univers Gateway provider that DSH, Codex, and Claude Code consume.
Treat the deployed release as a build artifact: it must correspond to a pushed
commit in this repo, never to a direct edit on the server.

## Where things are

| Thing | Value |
| --- | --- |
| SSH | `ubuntu@47.131.65.97` |
| Service | `opencodex-central.service` (systemd, `Restart=always`) |
| Admin origin | `http://100.126.212.32:10100` (Tailscale interface; it does **not** listen on `127.0.0.1`) |
| Health | `GET http://100.126.212.32:10100/health` |
| Config home | `/home/ubuntu/.opencodex-central` (`config.json`, `auth.json`, `admin-api-token`, `service.env`) |
| Releases | `/home/ubuntu/.local/share/opencodex-univers/releases/<version>` with `current` as a symlink |

`ExecStart` runs `current/node_modules/bun/bin/bun.exe .../src/cli/index.ts start --port 10100`,
so a release directory must contain both the package (`node_modules/univers-gateway`)
and a dependency tree with the pinned Bun binary (`node_modules/bun`, deps).

## Deploy, verify, roll back

Use the Univers-machine tooling rather than hand-building a release:

```bash
# from /Users/davidxu/repos/univers-machine
scripts/deploy-central-gateway.sh <version> [git-ref]   # e.g. 2.11.0-univers.64
scripts/verify-central-gateway-multi-account.sh
```

The deploy script packages the given ref (default `HEAD`), installs it as a new
immutable release directory, switches `current`, restarts the unit, verifies
health plus the multi-account checks, and **restores the previous release
automatically if verification fails**. It reuses the live release's dependency
tree, so it needs an existing release to copy from.

Rules that exist because they have already gone wrong:

- Do not edit a release directory in place. The hand-applied patches that
  predated this workflow were the reason the multi-account features were not in
  source history.
- Bump `package.json` (`2.11.0-univers.NN`) and push before deploying; the
  release must be reproducible from a pushed commit.
- A release built with `git archive` alone is missing `node_modules` and fails
  with `status=203/EXEC`. Always go through the deploy script.
- `gui/dist` is gitignored, so it is copied from the built working tree rather
  than archived; run `build:gui` before packaging (the script does it).

## Account pools

- **Command Code** (`command-code`, OAuth): two accounts in `auth.json`, quota-aware
  selection with 6h session affinity, a 429 cools the account and retries once on
  a peer, quota-probe failure degrades to rotation instead of blocking. Strategy
  is stored in `config.json` under `commandCodeAccountPool`
  (`{ "enabled": true, "strategy": "quota" }`). An older deployment kept a
  private `command-code-pool.json`; that file is legacy and is no longer read.
- **OpenCode** (`opencode-go`, API-key pool): three keys, `apiKeyPoolStrategy: "balanced"`,
  each probe hitting the official `https://opencode.ai/zen/go/v1/usage` rolling
  usage. Falls back to healthy-key balancing when the usage endpoint is
  unavailable.

Management endpoints (send the admin token only from the server):

```text
GET /api/oauth/accounts?provider=command-code&quota=1&refresh=1
GET /api/oauth/accounts/pool?provider=command-code
PUT /api/oauth/accounts/pool   {"provider":"command-code","strategy":"quota"}
GET /api/provider-quotas?refresh=1
GET /api/logs?limit=N
```

Pool writes read the request body **once** and dispatch on `provider`; keep that
shape when adding another provider, or the other provider's writes will see an
empty body.

## Debugging a live request

1. `GET /api/logs` (admin token) to get `model`, `provider`, `status`, and the
   attempt list. Useful markers: a provider name like `command-code-<accountId>`
   proves pool selection; a bare provider name means the pool did not route.
2. `GET /api/request-history` and `/api/request-history/:id/route-decision` when
   the question is *why this route*.
3. `journalctl -u opencodex-central.service` for unhandled errors and startup
   failures. A `ReferenceError` here means the release's source is broken, not
   the configuration.

## Secrets

- Never print, log, or paste `auth.json`, API keys, bearer tokens, or
  `admin-api-token`; read them on the host and keep only the result.
- `auth.json` and `config.json` stay mode `0600`.
- When checking configuration, print key **names**, counts, and non-secret
  fields (strategy, account counts, quota windows), never credential values.
