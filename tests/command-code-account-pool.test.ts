import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../src/types";
import { saveCredential } from "../src/oauth/store";
import {
  clearCommandCodeAccountPoolState,
  commandCodeAccountPoolHealthForTests,
  resolveCommandCodeAccountForSession,
  rotateCommandCodeAccountOn429,
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
    expect(rotateCommandCodeAccountOn429(first, "30", "session-a")).toBe(second);
    expect(commandCodeAccountPoolHealthForTests().cooledAccountIds).toEqual([first]);
    expect(resolveCommandCodeAccountForSession("session-a", config()).accountId).toBe(second);
  });
});
