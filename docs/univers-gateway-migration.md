# Univers Gateway migration and rollback

Univers Gateway introduces a new product, package, and canonical CLI identity
without migrating persisted data. Existing OpenCodex installations remain the
compatibility baseline.

## Stable compatibility contracts

The first Univers Gateway releases continue to use:

- `~/.opencodex` for configuration, credentials metadata, history, and runtime
  state;
- `OPENCODEX_*` and `OCX_*` environment variables;
- the `opencodex` Codex/OpenCode provider id;
- `x-opencodex-*` protocol headers;
- existing service-manager names and history ownership markers;
- the `ocx` and `opencodex` command aliases.

Do not rename these identifiers during package installation. A future state or
protocol migration requires a versioned, reversible migration command.

## Package transition

The canonical package is `univers-gateway`; its canonical commands are `ugw`
and `univers-gateway`. The old and new packages expose overlapping legacy bin
names, so they must not be installed globally at the same time.

After `univers-gateway` is published:

1. Stop the managed gateway service and record its current package version.
2. Uninstall the legacy npm package. Do not run an application-level uninstall
   or delete `~/.opencodex`.
3. Install the pinned `univers-gateway` version.
4. Start the service and verify `ugw ready --wait` and `ugw status`.
5. Run one native OpenAI request, one routed provider request, one account-pool
   request, and one continuation request before reopening traffic.

The production service should be switched only after the package tarball and
the exact deployed commit have passed the release gates.

## Rollback

If the new package fails the smoke checks:

1. Stop the Univers Gateway service.
2. Uninstall `univers-gateway` without deleting `~/.opencodex`.
3. Reinstall the exact previously recorded legacy package version.
4. Start the service and repeat the readiness and request smoke checks.

Because state and protocol identifiers are unchanged, package rollback does not
require a database or session-index rewrite. If a future release adds a state
schema migration, that release must add its own downgrade procedure here before
publication.

## Current release boundary

The repository and package are release-ready only after all local gates pass.
The npm package has not been published merely because `npm pack` succeeds.
Trusted Publishing or an authenticated npm maintainer must still authorize the
first `univers-gateway` publication.
