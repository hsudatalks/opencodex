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

  test("queries every OpenCode Go key and prefers lower official rolling usage", async () => {
    const p = { ...provider(), baseUrl: "https://opencode.ai/zen/go/v1" };
    const urls: string[] = [];
    const selected = await balanceProviderApiKey("opencode-go", p, "thread-opencode", {
      now: 1_000,
      fetchImpl: (async (url: string | URL, init?: RequestInit) => {
        urls.push(String(url));
        const key = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        const percent = key === "glm-plan-one" ? 72 : 18;
        return Response.json({ usage: { rolling: { percent, resetsAt: "2026-08-22T00:00:00Z" } } });
      }) as typeof fetch,
    });
    expect(urls).toEqual([
      "https://opencode.ai/zen/go/v1/usage",
      "https://opencode.ai/zen/go/v1/usage",
    ]);
    expect(selected.apiKey).toBe("glm-plan-two");
    expect(apiKeyQuotaSnapshotForTests("opencode-go", "one")?.usedPercent).toBe(72);
    expect(apiKeyQuotaSnapshotForTests("opencode-go", "two")?.usedPercent).toBe(18);
  });

  test("the headroom cut-off is per provider, and 0 disables it", async () => {
    // Same knob and default as the Command Code account pool: any window at the cut-off takes the
    // credential out of rotation, and an operator can move or disable the line.
    const strict = { ...provider(), baseUrl: "https://opencode.ai/zen/go/v1", apiKeyPoolHeadroomPercent: 50 };
    const chose = await balanceProviderApiKey("opencode-go", strict, "thread-cfg", {
      now: 1_000,
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        const key = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        return Response.json({ usage: { rolling: { percent: key === "glm-plan-one" ? 60 : 20 } } });
      }) as typeof fetch,
    });
    expect(chose.apiKey).toBe("glm-plan-two");

    // 0 disables the cut-off, so a key past any threshold stays selectable.
    clearApiKeyBalancerState();
    const disabled = { ...provider(), baseUrl: "https://opencode.ai/zen/go/v1", apiKeyPoolHeadroomPercent: 0 };
    const anyKey = await balanceProviderApiKey("opencode-go", disabled, "thread-cfg-2", {
      now: 1_000,
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        const key = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        return Response.json({ usage: { rolling: { percent: key === "glm-plan-one" ? 100 : 100 } } });
      }) as typeof fetch,
    });
    expect(["glm-plan-one", "glm-plan-two"]).toContain(anyKey.apiKey);
  });

  test("treats a key at the headroom cut-off as spent even when a peer is worse", async () => {
    // The last percent of a budget is not worth spending: a key at 99% is about to start refusing,
    // so new conversations belong to the key that can still serve them.
    const p = { ...provider(), baseUrl: "https://opencode.ai/zen/go/v1" };
    const selected = await balanceProviderApiKey("opencode-go", p, "thread-headroom", {
      now: 1_000,
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        const key = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        return Response.json({ usage: { rolling: { percent: key === "glm-plan-one" ? 99 : 99.5 } } });
      }) as typeof fetch,
    });
    // Both are past the cut-off, so the pool fails open rather than starving the request.
    expect(["glm-plan-one", "glm-plan-two"]).toContain(selected.apiKey);
    expect(apiKeyQuotaSnapshotForTests("opencode-go", "one")?.usedPercent).toBe(99);

    // With one key under the cut-off, it is the only candidate.
    const second = await balanceProviderApiKey("opencode-go", p, "thread-headroom-2", {
      now: 1_000 + 120_000,
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        const key = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        return Response.json({ usage: { rolling: { percent: key === "glm-plan-one" ? 99 : 50 } } });
      }) as typeof fetch,
    });
    expect(second.apiKey).toBe("glm-plan-two");
  });

  test("meters every OpenCode Go window, not only the rolling one", async () => {
    // A key can be idle in its five-hour window and still be out of weekly budget. Reading only
    // `rolling` scored that key as free, handed it new conversations, and the request then failed
    // upstream with a quota error instead of using the key that had room.
    const p = { ...provider(), baseUrl: "https://opencode.ai/zen/go/v1" };
    const selected = await balanceProviderApiKey("opencode-go", p, "thread-opencode", {
      now: 1_000,
      fetchImpl: (async (_url: string | URL, init?: RequestInit) => {
        const key = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
        return key === "glm-plan-one"
          ? Response.json({ usage: {
            rolling: { percent: 2, resetsAt: "2026-08-22T00:00:00Z" },
            weekly: { percent: 100, resetsAt: "2026-08-25T00:00:00Z" },
          } })
          : Response.json({ usage: {
            rolling: { percent: 30, resetsAt: "2026-08-22T00:00:00Z" },
            weekly: { percent: 40, resetsAt: "2026-08-25T00:00:00Z" },
          } });
      }) as typeof fetch,
    });
    // The binding window decides: 100% weekly is spent, so the busier-looking key wins.
    expect(apiKeyQuotaSnapshotForTests("opencode-go", "one")?.usedPercent).toBe(100);
    expect(apiKeyQuotaSnapshotForTests("opencode-go", "two")?.usedPercent).toBe(40);
    expect(selected.apiKey).toBe("glm-plan-two");
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
