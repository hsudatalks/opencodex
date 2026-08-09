# Univers Gateway brand contract

Univers Gateway is the public product identity of this fork. It is a production AI model gateway for Codex, Pi, Claude Code, and other OpenAI-compatible clients.

## Canonical identity

- Product: `Univers Gateway`
- npm package: `univers-gateway`
- CLI: `ugw` and `univers-gateway`
- Source repository: `https://github.com/hsudatalks/opencodex` until the repository is explicitly renamed

## Compatibility boundary

Existing installations, sessions, and clients must continue to work. The following identifiers are compatibility contracts and are not renamed as part of branding:

- CLI aliases: `ocx`, `opencodex`
- State directory: `~/.opencodex`
- Environment variables: `OPENCODEX_*` and `OCX_*`
- Provider id: `opencodex`
- OpenCode provider id: `opencodex`
- HTTP headers: `x-opencodex-*`
- Existing service-manager identifiers and history ownership markers

New public copy should say Univers Gateway. Internal compatibility identifiers should only change through an explicit, versioned migration.

## Upstream integration

Upstream OpenCodex changes are reviewed individually. A change is adopted when it improves correctness, interoperability, account lifecycle, model discovery, or operational reliability without weakening Univers Gateway's central account pool, routing continuity, concurrency scheduling, or Postgres usage architecture.

The current review ledger is recorded in
[`upstream-integration-2026-08-10.md`](./upstream-integration-2026-08-10.md). The
package migration and rollback contract is recorded in
[`univers-gateway-migration.md`](./univers-gateway-migration.md).
