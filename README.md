<h1 align="center">Univers Gateway</h1>
<p align="center"><b>A production AI model gateway for Codex, Pi, Claude Code, Claude Desktop, and OpenAI-compatible clients.</b><br>
Centralize providers, account pools, routing continuity, observability, and client integration behind one stable gateway.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/univers-gateway"><img src="https://img.shields.io/npm/v/univers-gateway?color=cb3837&label=npm&logo=npm" alt="npm version"></a>
  <a href="https://github.com/hsudatalks/opencodex/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/univers-gateway?color=blue" alt="license"></a>
  <img src="https://img.shields.io/node/v/univers-gateway?logo=node.js&label=node" alt="node version">
</p>

```bash
npm install -g univers-gateway
ugw start        # proxy + dashboard on localhost:10100
```

<table align="center">
  <tr>
    <td width="50%" align="center">
      <img src="assets/claude-code-models.gif" alt="Claude Code running a routed model through Univers Gateway — the status bar shows gpt-5.6-luna-medium as the active model" width="410"><br>
      <sub><b>Claude Code, running any model.</b><br>The picker is stock Claude Code. The brain behind it isn't.</sub>
    </td>
    <td width="50%" align="center">
      <img src="assets/demo.gif" alt="Univers Gateway demo — running a task in the Codex app on a routed non-OpenAI model" width="410"><br>
      <sub><b>Codex, running any model.</b><br>Pick a provider and go — same workflow, different brain.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" align="center">
      <img src="assets/claude-desktop-subagent.gif" alt="Claude Desktop answering as Claude Opus 4.8, then dispatching a GPT-5.6 Sol subagent through Univers Gateway" width="410"><br>
      <sub><b>Claude Desktop, running any model.</b><br>Opus answers, then hands the task to a GPT-5.6 Sol subagent.</sub>
    </td>
    <td width="50%" align="center">
      <img src="assets/grok-build-subagent.gif" alt="Grok Build running GPT-5.6 Sol through Univers Gateway and calling a Kimi K3 subagent" width="410"><br>
      <sub><b>Grok Build, running any model.</b><br>Sol drives the session and calls a Kimi K3 subagent.</sub>
    </td>
  </tr>
</table>

<p align="center">
  <a href="README.md">English</a> · <a href="readme/README.ko.md">한국어</a> · <a href="readme/README.zh-CN.md">简体中文</a> · <a href="readme/README.ru.md">Русский</a> · <a href="readme/README.ja.md">日本語</a> · 📖 <a href="https://opencodex.me/"><b>Full documentation →</b></a>
</p>

Univers Gateway translates Codex's Responses API into whatever your
provider speaks — streaming, tool calls, reasoning tokens, images, in both directions. Use Claude,
Gemini, Grok, GLM, DeepSeek, Kimi, Qwen, Ollama, or any other LLM with Codex, Claude Code, Claude
Desktop, and Grok Build. It can also manage a **ChatGPT account pool** for Codex auth: add accounts,
refresh their quotas in the dashboard, and let new sessions auto-route to the healthy account whose
remaining weekly or monthly capacity is most urgent to use before reset while existing threads stay
pinned to the account that started them.

## Quick start

### For humans

```bash
npm install -g univers-gateway   # Node 18+; the Bun runtime is bundled automatically
ugw start                            # or `ugw service` to run it in the background
```

Open **http://localhost:10100** and configure everything in the web dashboard — add providers
(40+ built-ins, or any OpenAI-compatible endpoint), pick models, manage accounts. `ugw gui`
re-opens the dashboard at any time.
It can also manage a **ChatGPT account pool** for Codex auth. Add multiple ChatGPT / Codex accounts,
refresh their 5h / weekly / 30d quota in the dashboard. Under quota routing, remaining capacity is
normalized to a 144-hour horizon using the weekly/30-day reset or nearest manual-reset expiry. A
freshly reset governing window gets bootstrap urgency 10000 until its first nonzero usage report. New
sessions balance across every account in the highest 10-point urgency bucket; round-robin and
fill-first use their own policies. Existing Codex threads retain affinity across successful turns;
urgency changes affect new or otherwise unbound sessions instead of churning an established
conversation. Failover, account exclusion, affinity expiry, or 401/403 and 429 recovery can still
rebind it. Give the accounts a
selection order when one of them — usually your Codex Desktop login — should only be reached for
once the others are drained.

### For agents

```bash
npm install -g univers-gateway
ugw start     # or `ugw service`
ugw init      # interactive setup: writes ~/.opencodex/config.json and wires Codex
```

`ugw init` never starts the proxy; start it first (or after — either order works, but headless
commands like `ugw provider add` and `ugw combo set` talk to the **live** proxy and exit nonzero
when it is unreachable). `ugw status` / `ugw doctor` / `ugw health` report the running state.

> **Agents installing or running Univers Gateway:** read
> [`AGENTS_INSTALL.md`](./AGENTS_INSTALL.md). An interactive `ugw start` may ask once whether to
> star this repository — that is the user's decision, never an agent's. The CLI suppresses the
> prompt for agent-driven runs and the API refuses them with `403 agent_consent_required`.

## Supported platforms

| OS | Status | Service manager |
|---|---|---|
| macOS (arm64 / x64) | Fully supported | launchd |
| Linux (x64 / arm64) | Fully supported | systemd (user unit) |
| Windows (x64) | Fully supported | Task Scheduler (hidden) / opt-in native service (`--native`, WinSW) |

Requires [Node](https://nodejs.org) 18+. The Bun runtime is bundled on `npm install` — no separate
Bun install needed, no WSL needed on Windows. If npm blocked the bundled runtime's install scripts,
see the [installation docs](https://opencodex.me/getting-started/installation/).

## Highlights

- **Use any LLM with Codex, Claude Code, Claude Desktop, and Grok Build** — 40+ providers out of
  the box, each keeping its own native UI.
- **Pool ChatGPT accounts safely** — thread affinity, quota-aware auto-switching, cooldown and
  fail-closed auth handling.
- **Combos** — one virtual model id with failover or weighted round-robin across providers. See
  the [combo guide](https://opencodex.me/guides/combos/).
- **Sub-agents on any model** — feature routed models in Codex's sub-agent picker, with v1/v2
  surface control and fallback chains. See the
  [sub-agent guide](https://opencodex.me/guides/sub-agent-surface/).
- **Log in once, skip the API key** — OAuth for xAI, Anthropic, and Kimi; or forward
  `codex login`, paste a key, or use `${ENV_VAR}` references.
- **Web search & vision sidecars** — non-OpenAI models get real web search and image understanding
  through a sidecar over your ChatGPT login.
- **See what's happening** — the dashboard shows providers, OAuth status, model selection, and a
  live request log with cache token counts.
- **Clean exit, zero residue** — `ugw stop` restores Codex to its original configuration.

## Model routing

Target any configured provider and model with the `provider/model` syntax:

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "google/gemini-3-pro" "Write unit tests for auth.ts"
codex -m "ollama/llama3" "Refactor this function"
```

Omit the `provider/` prefix to use the default provider or auto-match by model name pattern.
Provider model ids containing `/` are exposed with inner slashes aliased to `-`; the raw
full-slash form keeps working too. Details: [model routing docs](https://opencodex.me/guides/model-routing/).

## Providers & adapters

OpenAI (ChatGPT login or API key), Anthropic, Google Gemini, xAI, Kimi, Azure OpenAI, Ollama
(local + Cloud), Cursor (experimental), and every OpenAI-compatible endpoint — plus DeepSeek,
Groq, OpenRouter, Together, Fireworks, Cerebras, Mistral, Hugging Face, NVIDIA NIM, MiniMax,
Qwen Cloud, SiliconFlow, and more. Full list: `ugw init` or the
[provider docs](https://opencodex.me/guides/providers/).

## CLI

```bash
ugw init                       # interactive setup (writes config, wires Codex, offers the shim)
ugw start [--port 10100]       # start the proxy in the foreground
ugw stop                       # stop + restore native Codex
ugw service [install|start|stop|status|uninstall|remove]  # background service
ugw codex-shim install         # start the proxy on demand whenever `codex` launches
ugw health [--json]            # check immediate proxy liveness
ugw ready [--json] [--wait [--timeout <seconds>]]  # check post-sync readiness
ugw status                     # is the proxy running?
ugw gui                        # open the web dashboard
ugw provider <...>             # manage providers (list/add/edit/test/remove)
ugw account <...>              # manage ChatGPT accounts & API-key pools
ugw combo <...>                # manage failover / round-robin combos
ugw v2 <...>                   # multi-agent v1/v2 surface controls
ugw update [--tag preview]     # update Univers Gateway
```

Unpinned starts may pick another free port if the preferred one is busy; an explicit `--port`
never hops. Full reference: [CLI docs](https://opencodex.me/reference/cli/).

### Health and readiness

`GET /healthz` reports immediate proxy liveness. The unauthenticated `GET /readyz` endpoint reports
post-sync readiness with the sanitized JSON identity `{service, version, uptime, pid, port, status}`.
It returns `200` when `status` is `ready`; `pending` and terminal `failed` return `503` with
`Retry-After: 1`.

`ugw ready [--json] [--wait [--timeout <seconds>]]` performs one probe by default. `--wait` polls
for up to 45 seconds by default, but exits immediately when it observes terminal `failed`;
`--timeout <seconds>` sets a 1–300 second limit, requires `--wait`, and accepts only positive integers. CLI `--json` output is
`{ready, status, pid, port}`, where `status` is `ready`, `pending`, `failed`, or `unreachable`.

| Exit | Result |
| --- | --- |
| `0` | Ready |
| `1` | Not ready: pending, failed, timeout, or unreachable |
| `64` | Invalid arguments |

An older proxy without `/readyz` fails closed as `unreachable` with exit 1, while `ugw health`
remains compatible.

### Autostart: service vs shim

Use the **service** (`ugw service`) for an always-on proxy that restarts on crash. Use the
**shim** (`ugw codex-shim install`) for lightweight, on-demand startup without a background
daemon. Remove them with `ugw service uninstall` / `ugw codex-shim uninstall`.

### Uninstall

```bash
ugw uninstall                  # stop, remove service/shim, restore native Codex, clean up state
npm uninstall -g univers-gateway
```

## Remote access

By default Univers Gateway binds to `127.0.0.1` and needs no extra authentication. Binding beyond
loopback (`"hostname": "0.0.0.0"`) **requires** a bearer token — the proxy refuses to start
without `OPENCODEX_API_AUTH_TOKEN`, and every client request must carry it as
`x-opencodex-api-key`. Details: [configuration reference](https://opencodex.me/reference/configuration/).

## Documentation

The install, provider, routing, combo, sub-agent, sidecar, integration, CLI, configuration, and
management API references are built from [`docs-site/`](./docs-site). The compatibility and
branding boundary is documented in [`docs/univers-gateway-brand.md`](./docs/univers-gateway-brand.md).

Maintainer source-of-truth notes live under [`structure/`](./structure), contributor setup in
[`CONTRIBUTING.md`](./CONTRIBUTING.md), and security reporting in [`SECURITY.md`](./SECURITY.md).
Report undisclosed vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/hsudatalks/opencodex/security/advisories/new),
not a public issue.

Univers Gateway is derived from the MIT-licensed OpenCodex project. Upstream changes are reviewed
and adopted selectively; compatibility identifiers such as `~/.opencodex`, `OPENCODEX_*`, `ocx`,
and the `opencodex` provider id remain supported for existing installations and session history.

## Development

Source development requires the `bun` CLI on your `PATH`. This is separate from the published npm
package's bundled Bun runtime, which is used only by installed `ugw` commands.

```bash
git clone https://github.com/hsudatalks/opencodex.git
cd opencodex
bun install
bun run typecheck
bun run test
```

See **[Contributing](./CONTRIBUTING.md)**.

## Disclaimer

Univers Gateway is an independent, community-maintained project and is **not affiliated with or endorsed by OpenAI, Anthropic, or any other provider**.

Some providers — notably Anthropic (Claude) — may suspend or restrict accounts that route API traffic through third-party proxies. **Use at your own risk (UAYOR).** Before connecting a provider, review its Terms of Service to confirm that proxy-based access is permitted. The Univers Gateway maintainers are not responsible for any account actions taken by upstream providers.

## License

MIT
