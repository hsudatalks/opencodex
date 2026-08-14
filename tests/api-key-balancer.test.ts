import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiKeyQuotaSnapshotForTests,
  balanceProviderApiKey,
  clearApiKeyBalancerState,
  reconcileApiKeyBalancerProviders,
} from "../src/providers/api-key-balancer";
import { clearKeyCooldowns, rotateKeyOn429 } from "../src/providers/key-failover";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const keys = [
  { id: "one", key: "glm-plan-one" },
  { id: "two", key: "glm-plan-two" },
];

function provider(): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    authMode: "key",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    apiKey: keys[0]!.key,
    apiKeyPool: keys,
    apiKeyPoolStrategy: "balanced",
  };
}

function quotaFetch(percentByKey: Record<string, number>): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const key = auth.replace(/^Bearer\s+/i, "");
    return Response.json({
      success: true,
      data: {
        limits: [{
          type: "TOKENS_LIMIT",
          unit: 3,
          number: 5,
          percentage: percentByKey[key],
          nextResetTime: 2_000_000,
        }],
      },
    });
  }) as typeof fetch;
}

afterEach(() => {
  clearApiKeyBalancerState();
  clearKeyCooldowns();
});

describe("balanced API-key pools", () => {
  test("keeps a conversation sticky and balances new conversations", async () => {
    const p = provider();
    const fetchImpl = quotaFetch({ "glm-plan-one": 10, "glm-plan-two": 10 });
    const first = await balanceProviderApiKey("glm", p, "thread-a", { now: 1_000, fetchImpl });
    const repeated = await balanceProviderApiKey("glm", p, "thread-a", { now: 2_000, fetchImpl });
    const second = await balanceProviderApiKey("glm", p, "thread-b", { now: 2_000, fetchImpl });
    expect(repeated.apiKey).toBe(first.apiKey);
    expect(second.apiKey).not.toBe(first.apiKey);
  });

  test("prefers the account with more five-hour quota remaining", async () => {
    const p = provider();
    const selected = await balanceProviderApiKey("glm", p, "thread-a", {
      now: 1_000,
      fetchImpl: quotaFetch({ "glm-plan-one": 65, "glm-plan-two": 20 }),
    });
    expect(selected.apiKey).toBe("glm-plan-two");
    expect(apiKeyQuotaSnapshotForTests("glm", "one")?.usedPercent).toBe(65);
    expect(apiKeyQuotaSnapshotForTests("glm", "two")?.usedPercent).toBe(20);
  });

  test("weights new conversations by remaining quota without funneling them to one plan", async () => {
    const p = provider();
    const fetchImpl = quotaFetch({ "glm-plan-one": 80, "glm-plan-two": 20 });
    const selections: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      const selected = await balanceProviderApiKey("glm", p, `thread-${index}`, {
        now: 1_000 + index,
        fetchImpl,
      });
      selections.push(selected.apiKey!);
    }
    expect(selections.filter(key => key === "glm-plan-one")).toHaveLength(20);
    expect(selections.filter(key => key === "glm-plan-two")).toHaveLength(80);
  });

  test("moves a pinned conversation away from a cooled-down key", async () => {
    const p = provider();
    const fetchImpl = quotaFetch({ "glm-plan-one": 10, "glm-plan-two": 10 });
    const first = await balanceProviderApiKey("glm", p, "thread-a", { now: 1_000, fetchImpl });
    const config = {
      port: 10199,
      defaultProvider: "glm",
      providers: { glm: p },
    } as OcxConfig;
    const previousHome = process.env.OPENCODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-api-key-balancer-"));
    process.env.OPENCODEX_HOME = home;
    try {
      rotateKeyOn429(config, "glm", null, 2_000, first.apiKey);
      const next = await balanceProviderApiKey("glm", p, "thread-a", { now: 3_000, fetchImpl });
      expect(next.apiKey).not.toBe(first.apiKey);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("fails open when quota lookup is unavailable", async () => {
    const p = provider();
    const fetchImpl = (async () => { throw new Error("offline"); }) as typeof fetch;
    const first = await balanceProviderApiKey("glm", p, "thread-a", { now: 1_000, fetchImpl });
    const second = await balanceProviderApiKey("glm", p, "thread-b", { now: 2_000, fetchImpl });
    expect(new Set([first.apiKey, second.apiKey])).toEqual(new Set(keys.map(entry => entry.key)));
  });

  test("does not change legacy failover-only pools", async () => {
    const p = provider();
    p.apiKeyPoolStrategy = "failover";
    const selected = await balanceProviderApiKey("glm", p, "thread-a", {
      fetchImpl: quotaFetch({ "glm-plan-one": 90, "glm-plan-two": 0 }),
    });
    expect(selected).toBe(p);
    expect(selected.apiKey).toBe("glm-plan-one");
  });

  test("drops state when the provider is removed", async () => {
    await balanceProviderApiKey("glm", provider(), "thread-a", {
      fetchImpl: quotaFetch({ "glm-plan-one": 10, "glm-plan-two": 10 }),
    });
    expect(apiKeyQuotaSnapshotForTests("glm", "one")).not.toBeNull();
    expect(reconcileApiKeyBalancerProviders(new Set())).toBe(1);
    expect(apiKeyQuotaSnapshotForTests("glm", "one")).toBeNull();
  });
});
