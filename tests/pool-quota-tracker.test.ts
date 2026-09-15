import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../src/types";
import { saveCredential } from "../src/oauth/store";
import { clearAccountQuotaCache, getCachedProviderAccountQuota } from "../src/providers/quota";
import { clearApiKeyBalancerState, apiKeyQuotaSnapshotForTests } from "../src/providers/api-key-balancer";
import {
  POOL_QUOTA_TRACK_INTERVAL_MS,
  resetPoolQuotaTrackerStateForTests,
  runPoolQuotaTrack,
  runPoolQuotaTrackerTick,
} from "../src/providers/pool-quota-tracker";

const previousHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-pool-tracker-"));
  process.env.OPENCODEX_HOME = home;
  clearAccountQuotaCache();
  clearApiKeyBalancerState();
  resetPoolQuotaTrackerStateForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearAccountQuotaCache();
  clearApiKeyBalancerState();
  resetPoolQuotaTrackerStateForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

function commandCodeConfig(): OcxConfig {
  return {
    defaultProvider: "command-code",
    providers: { "command-code": { adapter: "command-code", authMode: "oauth", baseUrl: "https://api.commandcode.ai" } },
    commandCodeAccountPool: { enabled: true, strategy: "quota" },
  } as OcxConfig;
}

function openCodeGoConfig(): OcxConfig {
  return {
    defaultProvider: "opencode-go",
    providers: {
      "opencode-go": {
        adapter: "openai-responses",
        authMode: "key",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "k-one",
        apiKeyPoolStrategy: "balanced",
        apiKeyPool: [
          { id: "one", key: "k-one" },
          { id: "two", key: "k-two" },
        ],
      },
    },
  } as OcxConfig;
}

async function seedTwoCommandCodeAccounts(): Promise<void> {
  const expires = Date.now() + 3_600_000;
  await saveCredential("command-code", { access: "cc-1", refresh: "cc-1", expires, accountId: "cc-1" });
  await saveCredential("command-code", { access: "cc-2", refresh: "cc-2", expires, accountId: "cc-2" });
}

describe("pool quota tracker", () => {
  test("keeps Command Code per-account quota warm without a dashboard visit", async () => {
    // Selection reads cached quota, so before this tracker the headroom cut-off only worked if
    // somebody had opened the dashboard recently. The routing cache starts empty here.
    await seedTwoCommandCodeAccounts();
    expect(getCachedProviderAccountQuota("command-code", "anything")).toBeNull();
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/alpha/whoami")) return Response.json({ data: { org: { id: "org-1" } } });
      if (url.includes("/alpha/billing/credits")) {
        return Response.json({
          credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 },
          windowLimits: { fiveHour: { cap: 14, used: 1 }, weekly: { cap: 35, used: 7 } },
        });
      }
      if (url.includes("/alpha/billing/subscriptions")) {
        return Response.json({ data: { currentPeriodStart: "2026-08-01T00:00:00.000Z" } });
      }
      if (url.includes("/alpha/usage/summary")) return Response.json({ data: { totalCost: 1 } });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await runPoolQuotaTrack(commandCodeConfig());

    // Every account now holds a cached quota, credits included.
    const { getAccountSet } = await import("../src/oauth/store");
    for (const account of getAccountSet("command-code")!.accounts) {
      const quota = getCachedProviderAccountQuota("command-code", account.id);
      expect(quota?.weeklyPercent).toBeCloseTo((7 / 35) * 100, 3);
      expect(quota?.creditsUsd?.remaining).toBeCloseTo(5, 4);
    }
    expect(calls.some(url => url.includes("/alpha/billing/credits"))).toBe(true);
  });

  test("an opted-out pool is not polled in the background", async () => {
    // The Anthropic pool is opt-in; polling its usage endpoint for an operator who never enabled it
    // would be background work they did not ask for.
    const expires = Date.now() + 3_600_000;
    await saveCredential("anthropic", { access: "an-1", refresh: "an-1", expires, accountId: "an-1" });
    await saveCredential("anthropic", { access: "an-2", refresh: "an-2", expires, accountId: "an-2" });
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return Response.json({});
    }) as typeof fetch;
    const config = {
      defaultProvider: "anthropic",
      providers: { anthropic: { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com" } },
    } as OcxConfig;

    await runPoolQuotaTrack(config);
    expect(urls.length).toBe(0);
  });

  test("a single-account pool is not polled, and a balanced key pool is", async () => {
    const expires = Date.now() + 3_600_000;
    await saveCredential("command-code", { access: "cc-only", refresh: "cc-only", expires, accountId: "cc-only" });
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("opencode.ai")) {
        return Response.json({ usage: { rolling: { percent: 12 }, weekly: { percent: 40 } } });
      }
      return Response.json({});
    }) as typeof fetch;

    await runPoolQuotaTrack(openCodeGoConfig());

    // No peer to switch to, so the single Command Code account is skipped...
    expect(urls.some(url => url.includes("commandcode.ai"))).toBe(false);
    // ...while the balanced key pool is refreshed, so its quota is available to selection.
    expect(apiKeyQuotaSnapshotForTests("opencode-go", "one")?.usedPercent).toBe(40);
    expect(apiKeyQuotaSnapshotForTests("opencode-go", "two")?.usedPercent).toBe(40);
  });

  test("the tick throttles the refresh instead of probing on every sweep", async () => {
    await seedTwoCommandCodeAccounts();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ data: {} });
    }) as typeof fetch;

    const first = runPoolQuotaTrackerTick(commandCodeConfig(), 1_000_000);
    expect(first).not.toBeNull();
    await first;
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);

    // A tick inside the interval is skipped rather than probing again.
    expect(runPoolQuotaTrackerTick(commandCodeConfig(), 1_000_000 + POOL_QUOTA_TRACK_INTERVAL_MS - 1)).toBeNull();
    expect(calls).toBe(afterFirst);

    // Past the interval it refreshes again, which is what keeps the limits current.
    const later = runPoolQuotaTrackerTick(commandCodeConfig(), 1_000_000 + POOL_QUOTA_TRACK_INTERVAL_MS);
    expect(later).not.toBeNull();
    await later;
    expect(calls).toBeGreaterThan(afterFirst);
  });
});
