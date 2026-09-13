---
name: opencodex-dsh-workspace
description: Use when working in this repository with DeepSeek Harness (DSH) — launching DSH with this checkout as the workspace, understanding which AGENTS.md and project skills load, or setting up the Gateway credential for the Univers provider.
whenToUse: Starting an agent session in this repo, or when project instructions or skills appear not to load.
---

# Running DSH in this workspace

This repository is designed to be driven by DeepSeek Harness with the
**central Univers Gateway** as the model provider.

## What loads from this directory

DSH resolves the project root as the nearest ancestor containing `.git`, then
loads:

- `AGENTS.md` at the project root, plus the nearest nested `AGENTS.md` for a
  scoped directory (`src/`, `gui/`, `docs-site/`, `scripts/`, `.github/`).
- Skills from, in precedence order: `<project>/.dsh/skills`,
  `<project>/.agents/skills`, then `~/.dsh/skills` and `~/.agents/skills`.

Project skills are directory bundles: `<skill-name>/SKILL.md` with YAML
frontmatter whose `name` is **kebab-case** and matches the directory, plus a
`description`. A file missing either field is silently ignored with a warning —
if a skill does not appear, check the frontmatter first.

This repository's project skills:

- `opencodex-release` — versioning, gates, packaging, pushing.
- `opencodex-central-gateway` — deploying and operating the EC2 Gateway.
- `opencodex-debugging` — provider/routing diagnosis and regression tests.
- `opencodex-dsh-workspace` — this file.

## Launching with this checkout as cwd

Use [`references/run-dsh-in-opencodex.sh`](./references/run-dsh-in-opencodex.sh),
which resolves the Gateway key, pins the harness tsconfig, and starts the web
profile with this repository as the working directory.

**Pitfall:** running the harness CLI with this repository as cwd fails without
the tsconfig pin:

```text
SyntaxError: The requested module '@deepseek-ai/cordis' does not provide an export named 'FiberState'
```

The harness CLI resolves bare specifiers through tsx, which reads the cwd's
`tsconfig.json`. This repository's tsconfig is not the harness's, so the pin is
required:

```bash
TSX_TSCONFIG_PATH="$DSH_SOURCE_DIR/tsconfig.json" \
  node --import "$DSH_SOURCE_DIR/node_modules/tsx/dist/esm/index.mjs" \
       "$DSH_SOURCE_DIR/apps/cli/src/bin.ts" web
```

## Gateway credential

`~/.dsh/settings.yaml` declares the Univers provider with
`apiKeyEnv: UNIVERS_GATEWAY_API_KEY` pointing at
`http://100.126.212.32:10100/v1`, and `agent-default-model` is
`deepseek-official/deepseek-flash`. DSH therefore needs that environment
variable at launch; it is not set in a plain login shell on this host. Resolve
it from the same place this machine's other clients use, in order:

1. `~/.codex/auth.json` → `OPENAI_API_KEY` (only when it starts with `ocx_data_`)
2. `~/.config/ark-console/opencodex-central-admission-token`
3. `~/.config/ark-console/opencodex-direct-token`
4. `~/.local/share/dsh/env` (sourced when present)

Never echo the key; the launcher assigns it without printing it.

The provider's model list is merged with the Gateway's own `GET /v1/models`
answer, so a model the Gateway adds shows up without editing `settings.yaml`.
The Gateway's listing authors no input modalities, so image support is declared
per model in that file.

## Working agreement for this repo

- Prefer the project skills over re-deriving process; they encode the shipped
  paths (`release`, `central-gateway`, `debugging`).
- Deploy only from a pushed commit, and never edit a live release in place.
- Batch commits by concern and push promptly.
