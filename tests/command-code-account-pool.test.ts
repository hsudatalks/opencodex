import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../src/types";
import { saveCredential } from "../src/oauth/store";
import {
  clearCommandCodeAccountPoolState,
  commandCodeAccountPoolHealthForTests,
  isCommandCodeInsufficientCreditsResponse,
  resolveCommandCodeAccountForSession,
  rotateCommandCodeAccountOn429,
  rotateCommandCodeAccountOnInsufficientCredits,
} from "../src/oauth/command-code-routing";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../src/providers/quota";

const previousHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-command-code-pool-"));
  process.env.OPENCODEX_HOME = home;
  clearCommandCodeAccountPoolState();
  clearAccountQuotaCache("command-code");
});

afterEach(() => {
  clearCommandCodeAccountPoolState();
  clearAccountQuotaCache("command-code");
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

async function seed(): Promise<{ first: string; second: string }> {
  const expires = Date.now() + 3_600_000;
  await saveCredential("command-code", { access: "cc-first", refresh: "cc-first", expires, accountId: "cc-first" });
  await saveCredential("command-code", { access: "cc-second", refresh: "cc-second", expires, accountId: "cc-second" });
  const accounts = (await import("../src/oauth/store")).getAccountSet("command-code")!.accounts;
  return { first: accounts[0]!.id, second: accounts[1]!.id };
}

function config(strategy: "quota" | "round-robin" | "fill-first" = "quota"): OcxConfig {
  return {
    defaultProvider: "command-code",
    providers: { "command-code": { adapter: "command-code", authMode: "oauth", baseUrl: "https://api.commandcode.ai" } },
    commandCodeAccountPool: { enabled: true, strategy },
  } as OcxConfig;
}

describe("Command Code account pool", () => {
  test("selects lowest known quota and keeps session affinity", async () => {
    const { first, second } = await seed();
    setCachedProviderAccountQuotaForTests("command-code", first, { fiveHourPercent: 80, weeklyPercent: 40, updatedAt: Date.now() });
    setCachedProviderAccountQuotaForTests("command-code", second, { fiveHourPercent: 10, weeklyPercent: 20, updatedAt: Date.now() });
    expect(resolveCommandCodeAccountForSession("session-a", config()).accountId).toBe(second);
    expect(resolveCommandCodeAccountForSession("session-a", config()).reason).toBe("session-affinity");
    expect(commandCodeAccountPoolHealthForTests().affinityCount).toBe(1);
  });

  test("round-robin works when quota is missing", async () => {
    const { first, second } = await seed();
    const cfg = config("round-robin");
    expect(resolveCommandCodeAccountForSession("a", cfg).accountId).toBe(first);
    expect(resolveCommandCodeAccountForSession("b", cfg).accountId).toBe(second);
  });

  test("429 cools the failed account and selects a peer", async () => {
    const { first, second } = await seed();
    expect(rotateCommandCodeAccountOn429(config(), first, "30", "session-a")).toBe(second);
    expect(commandCodeAccountPoolHealthForTests().cooledAccountIds).toEqual([first]);
    expect(resolveCommandCodeAccountForSession("session-a", config()).accountId).toBe(second);
  });

  test("a spent credit balance outranks healthy windows when choosing an account", async () => {
    // The live case this guards: one account at 33% of its weekly window but with $0.12 of credit
    // left, which the upstream refuses. Windows alone call that account healthy, so the credit
    // balance has to participate in the score.
    const { first, second } = await seed();
    setCachedProviderAccountQuotaForTests("command-code", first, {
      fiveHourPercent: 3,
      weeklyPercent: 33,
      creditsUsd: { used: 6.13, limit: 6.25, remaining: 0.12, percent: 98.08 },
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("command-code", second, {
      fiveHourPercent: 1,
      weeklyPercent: 18,
      creditsUsd: { used: 6.18, limit: 70, remaining: 63.82, percent: 8.83 },
      updatedAt: Date.now(),
    });
    // A fresh session has no affinity, so the first pick is the lowest score: the funded account.
    expect(resolveCommandCodeAccountForSession("fresh", config()).accountId).toBe(second);
  });

  test("an account whose credits are gone is not selected while a peer has headroom", async () => {
    const { first, second } = await seed();
    setCachedProviderAccountQuotaForTests("command-code", first, {
      fiveHourPercent: 3,
      weeklyPercent: 33,
      creditsUsd: { used: 10, limit: 10, remaining: 0, percent: 100 },
      updatedAt: Date.now(),
    });
    setCachedProviderAccountQuotaForTests("command-code", second, {
      fiveHourPercent: 1,
      weeklyPercent: 18,
      creditsUsd: { used: 6.18, limit: 70, remaining: 63.82, percent: 8.83 },
      updatedAt: Date.now(),
    });
    // Repeated fresh sessions must never land on the spent account.
    for (const session of ["s1", "s2", "s3", "s4"]) {
      expect(resolveCommandCodeAccountForSession(session, config()).accountId).toBe(second);
    }
  });

  test("any one budget reaching the cut-off takes the account out of rotation", async () => {
    // The live case: 99.84% of the credit balance spent while the weekly window read a healthy 33%.
    // The last percent is not worth spending, so the cut-off is 99 rather than 100.
    const { first, second } = await seed();
    setCachedProviderAccountQuotaForTests("command-code", second, {
      fiveHourPercent: 1,
      weeklyPercent: 18,
      creditsUsd: { used: 6.18, limit: 70, remaining: 63.82, percent: 8.83 },
      updatedAt: Date.now(),
    });
    const drained: Array<[string, Record<string, unknown>]> = [
      ["five-hour window", { fiveHourPercent: 99, weeklyPercent: 10, updatedAt: Date.now() }],
      ["weekly window", { fiveHourPercent: 1, weeklyPercent: 99.5, updatedAt: Date.now() }],
      ["monthly window", { fiveHourPercent: 1, weeklyPercent: 10, monthlyPercent: 99, updatedAt: Date.now() }],
      ["credit balance", { fiveHourPercent: 1, weeklyPercent: 33, creditsUsd: { used: 70.33, limit: 70.44, remaining: 0.12, percent: 99.84 }, updatedAt: Date.now() }],
    ];
    for (const [label, quota] of drained) {
      clearCommandCodeAccountPoolState();
      setCachedProviderAccountQuotaForTests("command-code", first, quota as never);
      for (const session of ["a", "b", "c"]) {
        expect(`${label}: ${resolveCommandCodeAccountForSession(session, config()).accountId}`).toBe(`${label}: ${second}`);
      }
    }
  });

  test("the cut-off is configurable, and 0 disables it", async () => {
    const { first, second } = await seed();
    setCachedProviderAccountQuotaForTests("command-code", first, { fiveHourPercent: 90, weeklyPercent: 90, updatedAt: Date.now() });
    setCachedProviderAccountQuotaForTests("command-code", second, { fiveHourPercent: 10, weeklyPercent: 10, updatedAt: Date.now() });
    // Default 99 leaves 90% with headroom, so both accounts stay in the rotation.
    const withDefault = ["a", "b", "c", "d"].map(session => resolveCommandCodeAccountForSession(session, config()).accountId);
    expect(new Set(withDefault).size).toBe(2);

    // A threshold of 80 takes the 90% account out of rotation entirely.
    const strict = { ...config(), commandCodeAccountPool: { enabled: true, strategy: "quota" as const, autoSwitchThreshold: 80 } } as OcxConfig;
    clearCommandCodeAccountPoolState();
    for (const session of ["a", "b", "c", "d"]) {
      expect(resolveCommandCodeAccountForSession(session, strict).accountId).toBe(second);
    }

    // 0 disables the cut-off, so even a fully drained account stays selectable.
    clearCommandCodeAccountPoolState();
    setCachedProviderAccountQuotaForTests("command-code", first, {
      fiveHourPercent: 100,
      weeklyPercent: 100,
      creditsUsd: { used: 10, limit: 10, remaining: 0, percent: 100 },
      updatedAt: Date.now(),
    });
    const disabled = { ...config(), commandCodeAccountPool: { enabled: true, strategy: "quota" as const, autoSwitchThreshold: 0 } } as OcxConfig;
    const picked = ["a", "b", "c", "d"].map(session => resolveCommandCodeAccountForSession(session, disabled).accountId);
    expect(new Set(picked).size).toBe(2);
  });

  test("every account being spent still yields a selectable pool rather than none", async () => {
    // Fail open: with no account holding headroom the request must reach an upstream and report the
    // provider's own error, not fail locally for lack of a candidate.
    const { first, second } = await seed();
    for (const accountId of [first, second]) {
      setCachedProviderAccountQuotaForTests("command-code", accountId, {
        fiveHourPercent: 10,
        weeklyPercent: 20,
        creditsUsd: { used: 10, limit: 10, remaining: 0, percent: 100 },
        updatedAt: Date.now(),
      });
    }
    expect([first, second]).toContain(resolveCommandCodeAccountForSession("s1", config()).accountId);
  });

  test("a spend rejection cools the account for the long window and selects a peer", async () => {
    const { first, second } = await seed();
    expect(rotateCommandCodeAccountOnInsufficientCredits(config(), first, "session-a")).toBe(second);
    expect(commandCodeAccountPoolHealthForTests().cooledAccountIds).toEqual([first]);
    expect(resolveCommandCodeAccountForSession("session-a", config()).accountId).toBe(second);
    // Credits refill on a billing period, not in a minute, so the cooldown outlives the 429 default.
    const stillCooled = commandCodeAccountPoolHealthForTests(Date.now() + 5 * 60_000).cooledAccountIds;
    expect(stillCooled).toEqual([first]);
  });

  test("recognizes the upstream spend rejection and ignores unrelated 400s", async () => {
    const spend = new Response(JSON.stringify({
      success: false,
      error: { code: "BAD_REQUEST", status: 400, message: "You have insufficient credits to make this request. Please purchase more credits to continue using the service." },
    }), { status: 400 });
    expect(await isCommandCodeInsufficientCreditsResponse(spend)).toBe(true);

    // A context-length 400 must not cool a healthy account.
    const unrelated = new Response(JSON.stringify({ error: { code: "BAD_REQUEST", message: "prompt is too long" } }), { status: 400 });
    expect(await isCommandCodeInsufficientCreditsResponse(unrelated)).toBe(false);
    // Only 400 is scanned; a 429 follows the rate-limit path instead.
    const rateLimited = new Response("insufficient credits", { status: 429 });
    expect(await isCommandCodeInsufficientCreditsResponse(rateLimited)).toBe(false);
  });
});
