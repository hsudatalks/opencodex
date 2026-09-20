---
title: Typed evaluation (Jev)
description: Route TypeSafe Choice, Score and Noul evaluation through Univers Gateway.
---

The Univers Gateway release line supports non-chat evaluation models from
`2.11.0-univers.79`. Jev evaluates supplied `state` against typed `questions`; it
does not implement Chat Completions or Responses. This opt-in data plane keeps
evaluation providers separate from chat adapters and Codex model pickers.

## Configure the gateway

Add the following to the gateway's `config.json` and provide `TYPESAFE_API_KEY`
in the **gateway service environment**, not in client configuration:

```json
{
  "evaluations": {
    "providers": {
      "typesafe": {
        "protocol": "typesafe",
        "endpoint": "https://api.typesafe.ai/v1/systemone",
        "apiKeyEnv": "TYPESAFE_API_KEY",
        "models": ["jev-1.13.0"]
      }
    },
    "timeoutMs": 20000,
    "maxConcurrent": 16
  }
}
```

Follow the [configuration editing rules](/reference/configuration). Restart the
service after changing its environment. Each provider explicitly owns its
destination, protocol, credential variable and model allowlist. A request cannot
supply or override those settings. Providers can be disabled with `disabled: true`;
the shared `disabledModels` list also applies to bare and qualified evaluation ids.
An invalid hand edit disables this optional capability without resetting existing
gateway providers or admission keys. Live config writes reject invalid values.

## Discover and call

Use your existing **gateway** bearer key:

```sh
curl -fsS 'https://gateway.arkconsole.app/v1/models?capability=evaluate' \
  -H "Authorization: Bearer $UNIVERS_GATEWAY_API_KEY"

curl -fsS https://gateway.arkconsole.app/v1/evaluate \
  -H "Authorization: Bearer $UNIVERS_GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"typesafe/jev-1.13.0","state":"The test process exited with code 1.","questions":{"failed":{"type":"noul","instructions":"Did this test fail?"}}}'
```

`POST /v1/systemone` is a compatibility alias with the same TypeSafe wire contract.
`POST /v1/evaluate` also uses **TypeSafe** Choice / Score / Noul, not Vercel's Boolean
contract. Responses preserve typed answers, the reported upstream model, and
`usage.input_tokens` / `usage.output_tokens`. Bare model ids work only when exactly
one enabled provider owns them. The qualified id avoids ambiguity.

Ordinary `/v1/models` remains the chat catalog. The `capability=evaluate` query
returns only evaluation models, including `evaluation_protocol`, `capabilities`
and `supported_endpoints`. These models do not enter normal chat routing.

## Univers AIP MCP

The MCP plugin can use its existing `typesafe` adapter:

```json
{
  "protocol": "typesafe",
  "endpoint": "https://gateway.arkconsole.app/v1/evaluate",
  "model": "typesafe/jev-1.13.0",
  "keyEnv": "UNIVERS_GATEWAY_API_KEY",
  "envFile": "/absolute/path/to/private-gateway.env"
}
```

The client needs only the gateway key. The TypeSafe key stays on the gateway.
Univers AIP means Univers AI Platform; `univers-aip-mcp` is the MCP service/plugin.

## Admission, limits and logging

- Both POST routes accept a configured gateway bearer key or
  `x-opencodex-api-key`; they reject `x-api-key`, foreign bearer tokens and rejected
  browser origins. Existing listener, draining and global turn-admission rules apply.
- The optional unauthenticated loopback listener does not add these POST routes.
- Upstream requests contain only JSON plus the selected provider's bearer key.
  Gateway admission secrets are explicitly rejected as provider credentials.
- Requests require uncompressed JSON, up to 512 KiB and 100 questions. Responses
  are buffered up to 2 MiB and checked for matching question ids, answer types,
  choices, score ranges and probabilities. Unknown response fields are omitted.
- Timeout covers request-body consumption, the upstream request and response body.
  Client cancellation propagates upstream. Default evaluation concurrency is 16.
- One request makes one upstream attempt: no redirect following, automatic retries
  or chat/provider fallback. Rate limits return 429, deadline expiry 504, unavailable
  configuration/credentials 503, and malformed upstream answers 502.
- Existing request/usage ledgers retain provider, model, gateway key attribution,
  status and reported token usage with `inboundProtocol: "evaluate"` (Postgres
  protocol code 4). They do not record evaluation state, questions or answers.
  Token counts are reported usage, not a claim of known provider pricing.

Contract source: [TypeSafe API reference](https://docs.typesafe.ai/api), verified
2026-09-20. Models and aliases must be added to the explicit allowlist by the
gateway administrator; this integration does not auto-register third-party presets.
