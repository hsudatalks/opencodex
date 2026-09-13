#!/usr/bin/env bash
# Start DeepSeek Harness with THIS repository as the workspace (cwd).
#
# Why this script exists:
#   - the harness CLI must be launched from its own checkout, but the session's
#     project root is the process cwd, so the cwd has to be this repo;
#   - tsx resolves bare specifiers through the cwd's tsconfig.json, so the
#     harness tsconfig must be pinned or profile boot fails with
#     "@deepseek-ai/cordis does not provide an export named 'FiberState'";
#   - UNIVERS_GATEWAY_API_KEY is required by the Univers provider but is not set
#     in a plain login shell.
#
# No secret is stored or printed here. The key is resolved at every launch from
# the same sources this machine's other Gateway clients use.
set -euo pipefail

DSH_SOURCE_DIR="${DSH_SOURCE_DIR:-$HOME/repos/deepseek-harness}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"

[ -f "$DSH_SOURCE_DIR/apps/cli/src/bin.ts" ] || {
  echo "run-dsh: harness CLI not found under $DSH_SOURCE_DIR (set DSH_SOURCE_DIR)" >&2
  exit 1
}

# Optional per-host environment (may itself define UNIVERS_GATEWAY_API_KEY).
ENVF="$HOME/.local/share/dsh/env"
if [ -f "$ENVF" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENVF"
  set +a
fi

# Reuse the credential this machine's Codex uses, so DSH and Codex share one key.
AUTH="$HOME/.codex/auth.json"
if [ -z "${UNIVERS_GATEWAY_API_KEY:-}" ] && [ -r "$AUTH" ]; then
  K=$(AUTH_FILE="$AUTH" python3 -c 'import json,os; print(json.load(open(os.environ["AUTH_FILE"])).get("OPENAI_API_KEY",""))' 2>/dev/null || true)
  case "$K" in
    ocx_data_*) export UNIVERS_GATEWAY_API_KEY="$K" ;;
  esac
fi

for TOKF in \
  "$HOME/.config/ark-console/opencodex-central-admission-token" \
  "$HOME/.config/ark-console/opencodex-direct-token"; do
  if [ -z "${UNIVERS_GATEWAY_API_KEY:-}" ] && [ -r "$TOKF" ]; then
    T=$(cat "$TOKF")
    case "$T" in
      ocx_data_*) export UNIVERS_GATEWAY_API_KEY="$T" ;;
    esac
  fi
done

if [ -z "${UNIVERS_GATEWAY_API_KEY:-}" ]; then
  echo "run-dsh: no Univers Gateway key found (codex auth.json or ark-console token)" >&2
  exit 1
fi

export TSX_TSCONFIG_PATH="$DSH_SOURCE_DIR/tsconfig.json"
cd "$REPO_DIR"
exec node --import "$DSH_SOURCE_DIR/node_modules/tsx/dist/esm/index.mjs" \
  "$DSH_SOURCE_DIR/apps/cli/src/bin.ts" web --no-open "$@"
