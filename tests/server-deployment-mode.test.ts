import { describe, expect, test } from "bun:test";
import {
  deploymentMode,
  effectiveProviderCodexAccountMode,
  nativeMainAccountEnabled,
} from "../src/deployment-mode";
import {
  codexAccountNamespaceEntries,
  defaultCodexAccountNamespaces,
} from "../src/codex/account-namespaces";
import { isCodexAccountUsable } from "../src/codex/account-usability";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { routeModel } from "../src/router";
import type { OcxConfig } from "../src/types";

function config(deploymentModeValue?: "local" | "server"): OcxConfig {
  return {
    port: 10100,
    ...(deploymentModeValue ? { deploymentMode: deploymentModeValue } : {}),
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "direct",
        models: ["gpt-test"],
      },
    },
    codexAccounts: [{ id: "pool-a", email: "pool-a@example.test", isMain: false, logLabel: "acct-a" }],
    codexAccountNamespaces: { main: "@main", managed: "pool-a" },
  };
}

describe("server deployment credential ownership", () => {
  test("keeps historical local defaults but makes server mode pool-only", () => {
    expect(deploymentMode(config())).toBe("local");
    expect(nativeMainAccountEnabled(config())).toBe(true);
    expect(effectiveProviderCodexAccountMode(config(), "openai")).toBe("direct");

    const server = config("server");
    expect(deploymentMode(server)).toBe("server");
    expect(nativeMainAccountEnabled(server)).toBe(false);
    expect(effectiveProviderCodexAccountMode(server, "openai")).toBe("pool");
    expect(routeModel(server, "gpt-test").codexAccountMode).toBe("pool");
  });

  test("never probes or selects the process user's native Codex profile", () => {
    let nativeProbeCalled = false;
    expect(isCodexAccountUsable(config("server"), MAIN_CODEX_ACCOUNT_ID, {
      isMainAccountTokenLive: () => {
        nativeProbeCalled = true;
        return true;
      },
    })).toBe(false);
    expect(nativeProbeCalled).toBe(false);
  });

  test("omits generated and stale explicit main-account namespaces", () => {
    const server = config("server");
    expect(Object.values(defaultCodexAccountNamespaces(server))).toEqual(["pool-a"]);
    expect(codexAccountNamespaceEntries(server)).toEqual([["managed", "pool-a"]]);

    const local = config("local");
    expect(Object.values(defaultCodexAccountNamespaces(local))).toContain("@main");
    expect(codexAccountNamespaceEntries(local)).toContainEqual(["main", MAIN_CODEX_ACCOUNT_ID]);
  });
});
