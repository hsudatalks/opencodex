import { describe, expect, test } from "bun:test";
import {
  applyCodexAccountFastModePolicy,
  isCodexAccountFastModeEnabled,
  setCodexAccountFastModeEnabled,
} from "../src/codex/account-fast-mode";
import type { OcxConfig, OcxParsedRequest } from "../src/types";

function parsedWithTier(tier = "priority"): Pick<OcxParsedRequest, "_rawBody" | "options"> {
  return {
    _rawBody: { model: "gpt-5.6-sol", service_tier: tier },
    options: { serviceTier: tier },
  };
}

describe("centrally managed per-account Codex Fast mode", () => {
  test("accounts are Standard-only until explicitly enabled", () => {
    const config = {} as OcxConfig;
    expect(isCodexAccountFastModeEnabled(config, "work")).toBe(false);

    setCodexAccountFastModeEnabled(config, "work", true);
    expect(isCodexAccountFastModeEnabled(config, "work")).toBe(true);
    expect(config.codexAccountFastModeEnabled).toEqual({ work: true });

    setCodexAccountFastModeEnabled(config, "work", false);
    expect(isCodexAccountFastModeEnabled(config, "work")).toBe(false);
    expect(config.codexAccountFastModeEnabled).toBeUndefined();
  });

  test("disabled accounts strip a client-requested Fast tier", () => {
    const parsed = parsedWithTier();
    expect(applyCodexAccountFastModePolicy({} as OcxConfig, "work", parsed)).toBe(true);
    expect(parsed._rawBody).toEqual({ model: "gpt-5.6-sol" });
    expect(parsed.options.serviceTier).toBeUndefined();
  });

  test("enabled accounts force both Fast and Standard requests through priority", () => {
    const config = { codexAccountFastModeEnabled: { work: true } } as OcxConfig;
    const fast = parsedWithTier();
    expect(applyCodexAccountFastModePolicy(config, "work", fast)).toBe(false);
    expect((fast._rawBody as Record<string, unknown>).service_tier).toBe("priority");

    const standard = { _rawBody: { model: "gpt-5.6-sol" }, options: {} };
    expect(applyCodexAccountFastModePolicy(config, "work", standard)).toBe(true);
    expect(standard._rawBody).toEqual({ model: "gpt-5.6-sol", service_tier: "priority" });
    expect(standard.options.serviceTier).toBe("priority");
  });

  test("enabled accounts replace non-Fast service tiers", () => {
    const config = { codexAccountFastModeEnabled: { work: true } } as OcxConfig;
    const parsed = parsedWithTier("default");
    expect(applyCodexAccountFastModePolicy(config, "work", parsed)).toBe(true);
    expect((parsed._rawBody as Record<string, unknown>).service_tier).toBe("priority");
    expect(parsed.options.serviceTier).toBe("priority");
  });
});
