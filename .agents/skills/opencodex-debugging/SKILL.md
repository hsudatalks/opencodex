---
name: opencodex-debugging
description: Use when diagnosing a provider error, a wrong or failed route, a missing capability such as reasoning replay or image input, an adapter wire mismatch, account/key rotation, or quota behavior in this proxy.
whenToUse: Debugging 4xx/5xx from upstream providers, routing surprises, or writing a regression test for one.
---

# Debugging providers and routing

Run the proxy locally before touching the deployment:

```bash
./node_modules/bun/bin/bun.exe run src/cli/index.ts start --port 10199
```

For live behavior use `opencodex-central-gateway`; never change the live release
to test a hypothesis.

## Where a request is decided

| Concern | File |
| --- | --- |
| Provider selection, registry capability merge | `src/router.ts` (`routedProviderConfig`) |
| Provider presets, model lists, capability lists | `src/providers/registry.ts` |
| Wire adapters (`openai-chat`, `anthropic`, `command-code`, …) | `src/adapters/` |
| Request pipeline, retries, account failover | `src/server/responses/core.ts` |
| Responses input → messages | `src/responses/parser.ts` |
| Provider events → Responses SSE, reasoning capture | `src/bridge.ts` |
| Raw-reasoning replay cache | `src/responses/reasoning-replay-cache.ts` |
| Provider quota probes | `src/providers/quota.ts` |
| Balanced API-key pools | `src/providers/api-key-balancer.ts` |
| OAuth account pools | `src/oauth/anthropic-routing.ts`, `src/oauth/command-code-routing.ts` |

Two resolution facts cause most "capability missing" bugs:

- `routedProviderConfig` merges registry capabilities **by provider id**. An
  operator-defined provider (`deepseek-official`) matches no id, so it inherits
  nothing by name; destination-level requirements are backfilled separately
  through `canonicalDestinationCapabilities`.
- `modelInList` (`src/types.ts`) matches the exact id, the prefix before `:`,
  and the final `/` segment. A prefixed id such as `deepseek/deepseek-v4-flash`
  will not match a `deepseek-v4-flash` entry without that last rule.

## DeepSeek thinking mode: `reasoning_content`

The upstream rejects a tool-call continuation whose assistant turn omits the
original reasoning:

```text
400 invalid_request_error
The `reasoning_content` in the thinking mode must be passed back to the API.
```

Contract:

- Models listed in `preserveReasoningContentModels` get `reasoning_content`
  replayed on tool-call continuations (`src/adapters/openai-chat.ts`).
- The live alias `deepseek-flash` **is** a thinking model and must stay in
  DeepSeek's replay list (`DEEPSEEK_REASONING_REPLAY_MODELS`), even though it is
  deliberately not a catalog enum member.
- Custom providers pointed at `https://api.deepseek.com` inherit the requirement
  from the destination.
- Reasoning is recovered from history when present and otherwise from the
  bridge's in-memory replay cache, keyed by call id and scoped to the
  conversation. A fresh synthetic conversation with no recorded reasoning will
  legitimately have nothing to replay.

Never "fix" this 400 by inventing reasoning text. Extend the replay path or
report that no reasoning was recorded.

Regression tests to run for any change here:

```bash
./node_modules/bun/bin/bun.exe test \
  tests/deepseek-reasoning-replay-gaps.test.ts \
  tests/deepseek-official-reasoning-replay.test.ts \
  tests/model-capability-list.test.ts \
  tests/provider-registry-parity.test.ts
```

The parity suite pins exact capability lists, so a deliberate list change must
update its expectation in the same commit.

## Account and key rotation

- A 429 fails over to a peer account/key and records a recovery kind. Adding a
  new kind means touching `src/usage/log.ts` (`AttemptRecoveryKind`) **and**
  `src/usage/postgres-ingest.ts` (`RECOVERY_CODES`); the type error only appears
  under `typecheck`.
- Balanced key pools must fail open: a quota probe that errors degrades to
  healthy-key balancing and must never block a request.
- Never log or persist key material; pool entries carry ids, and tests should
  assert on ids, not on secrets.

## Live triage

Check whether the failure is the code or the configuration first: compare the
deployed source hash to the commit (see `opencodex-release`). If they match and
the route still fails, collect `GET /api/logs` for the request — it carries the
model, resolved provider, attempt ordinals, statuses, and recovery kinds.
