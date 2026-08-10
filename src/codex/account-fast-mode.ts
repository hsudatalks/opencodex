import type { OcxConfig } from "../types";
import type { OcxParsedRequest } from "../types";
import { isValidCodexAccountId, MAIN_CODEX_ACCOUNT_ID } from "./account-id";

export function isCodexAccountFastModeKey(key: unknown): key is string {
  return key === MAIN_CODEX_ACCOUNT_ID || isValidCodexAccountId(key);
}

/** Fast mode can be centrally forced per ChatGPT account and defaults to passthrough. */
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
 * Apply the selected account's tier after pool selection. Enabled forces every
 * request through Fast; disabled restores the immutable pre-selection tier.
 *
 * `passthroughServiceTier` must come from before any account policy was applied.
 * That matters when a 429 rotates from a forced-Fast account to a passthrough
 * account: the retry must recover the client's original choice, not inherit the
 * first account's rewrite.
 */
export function applyCodexAccountFastModePolicy(
  config: OcxConfig,
  accountId: string,
  parsed: Pick<OcxParsedRequest, "_rawBody" | "options">,
  passthroughServiceTier: string | undefined,
): boolean {
  const enabled = isCodexAccountFastModeEnabled(config, accountId);
  const effectiveServiceTier = enabled ? "priority" : passthroughServiceTier;
  let changed = false;
  if (parsed._rawBody && typeof parsed._rawBody === "object" && !Array.isArray(parsed._rawBody)) {
    const body = parsed._rawBody as Record<string, unknown>;
    if (effectiveServiceTier !== undefined && body.service_tier !== effectiveServiceTier) {
      body.service_tier = effectiveServiceTier;
      changed = true;
    } else if (effectiveServiceTier === undefined && Object.hasOwn(body, "service_tier")) {
      delete body.service_tier;
      changed = true;
    }
  }
  if (parsed.options.serviceTier !== effectiveServiceTier) {
    parsed.options.serviceTier = effectiveServiceTier;
    changed = true;
  }
  return changed;
}
