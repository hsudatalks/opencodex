import type { OcxConfig } from "../types";
import type { OcxParsedRequest } from "../types";
import { isValidCodexAccountId, MAIN_CODEX_ACCOUNT_ID } from "./account-id";

export function isCodexAccountFastModeKey(key: unknown): key is string {
  return key === MAIN_CODEX_ACCOUNT_ID || isValidCodexAccountId(key);
}

/** Fast mode is centrally controlled per ChatGPT account and defaults to off. */
export function isCodexAccountFastModeEnabled(config: OcxConfig, accountId: string): boolean {
  return config.codexAccountFastModeEnabled?.[accountId] === true;
}

export function setCodexAccountFastModeEnabled(
  config: OcxConfig,
  accountId: string,
  enabled: boolean,
): void {
  const entries = new Map(Object.entries(config.codexAccountFastModeEnabled ?? {}));
  if (enabled) entries.set(accountId, true);
  else entries.delete(accountId);

  if (entries.size > 0) config.codexAccountFastModeEnabled = Object.fromEntries(entries);
  else delete config.codexAccountFastModeEnabled;
}

export function forgetCodexAccountFastMode(config: OcxConfig, accountId: string): void {
  setCodexAccountFastModeEnabled(config, accountId, false);
}

/**
 * Apply the selected account's authoritative tier after pool selection.
 * Enabled forces every request through Fast; disabled forces Standard.
 */
export function applyCodexAccountFastModePolicy(
  config: OcxConfig,
  accountId: string,
  parsed: Pick<OcxParsedRequest, "_rawBody" | "options">,
): boolean {
  const enabled = isCodexAccountFastModeEnabled(config, accountId);
  let changed = false;
  if (parsed._rawBody && typeof parsed._rawBody === "object" && !Array.isArray(parsed._rawBody)) {
    const body = parsed._rawBody as Record<string, unknown>;
    if (enabled && body.service_tier !== "priority") {
      body.service_tier = "priority";
      changed = true;
    } else if (!enabled && Object.hasOwn(body, "service_tier")) {
      delete body.service_tier;
      changed = true;
    }
  }
  if (enabled && parsed.options.serviceTier !== "priority") {
    parsed.options.serviceTier = "priority";
    changed = true;
  } else if (!enabled && parsed.options.serviceTier !== undefined) {
    parsed.options.serviceTier = undefined;
    changed = true;
  }
  return changed;
}
