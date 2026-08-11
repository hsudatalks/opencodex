import { describe, expect, test } from "bun:test";

import {
  decideCodexQuotaRoute,
  effectiveCodexQuotaDeadline,
  planCodexQuotaAllocation,
  type CodexQuotaAllocationAccount,
} from "../src/codex/quota-allocation-model";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function account(
  id: string,
  overrides: Partial<CodexQuotaAllocationAccount> = {},
): CodexQuotaAllocationAccount {
  return {
    id,
    plan: "pro",
    usedPercent: 20,
    weeklyResetAt: NOW + 144 * HOUR,
    activeTurns: 0,
    hardCapacity: 6,
    ...overrides,
  };
}

describe("effective Codex quota deadline", () => {
  test("selects the earliest valid weekly, manual, and official deadline", () => {
    const cases: Array<{
      name: string;
      input: Partial<CodexQuotaAllocationAccount>;
      source: "weekly" | "manual" | "official";
      hours: number;
    }> = [
      {
        name: "weekly only",
        input: { weeklyResetAt: NOW + 72 * HOUR },
        source: "weekly",
        hours: 72,
      },
      {
        name: "manual before weekly",
        input: {
          weeklyResetAt: NOW + 72 * HOUR,
          resetCredits: 1,
          resetCreditExpiresAt: NOW + 24 * HOUR,
        },
        source: "manual",
        hours: 24,
      },
      {
        name: "official before manual and weekly",
        input: {
          weeklyResetAt: NOW + 72 * HOUR,
          resetCredits: 1,
          resetCreditExpiresAt: NOW + 48 * HOUR,
          officialResetAt: NOW + 12 * HOUR,
        },
        source: "official",
        hours: 12,
      },
      {
        name: "weekly before manual and official",
        input: {
          weeklyResetAt: NOW + 6 * HOUR,
          resetCredits: 2,
          resetCreditExpiresAt: NOW + 24 * HOUR,
          officialResetAt: NOW + 12 * HOUR,
        },
        source: "weekly",
        hours: 6,
      },
      {
        name: "expired manual credit is ignored",
        input: {
          weeklyResetAt: NOW + 72 * HOUR,
          resetCredits: 1,
          resetCreditExpiresAt: NOW - HOUR,
          officialResetAt: NOW + 12 * HOUR,
        },
        source: "official",
        hours: 12,
      },
      {
        name: "manual deadline without credits is ignored",
        input: {
          weeklyResetAt: NOW + 72 * HOUR,
          resetCredits: 0,
          resetCreditExpiresAt: NOW + HOUR,
          officialResetAt: NOW + 12 * HOUR,
        },
        source: "official",
        hours: 12,
      },
    ];

    for (const row of cases) {
      const deadline = effectiveCodexQuotaDeadline(account(row.name, row.input), NOW);
      expect(deadline?.source, row.name).toBe(row.source);
      expect(deadline?.hoursRemaining, row.name).toBe(row.hours);
    }
  });

  test("uses the monthly governing window for Go and Free plans", () => {
    for (const plan of ["go", "free"]) {
      const deadline = effectiveCodexQuotaDeadline(account(plan, {
        plan,
        weeklyResetAt: NOW + HOUR,
        monthlyResetAt: NOW + 30 * 24 * HOUR,
      }), NOW);
      expect(deadline?.source).toBe("monthly");
      expect(deadline?.hoursRemaining).toBe(30 * 24);
    }
  });

  test("handles second and millisecond epochs identically", () => {
    const milliseconds = effectiveCodexQuotaDeadline(account("ms", {
      weeklyResetAt: NOW + 24 * HOUR,
    }), NOW);
    const seconds = effectiveCodexQuotaDeadline(account("seconds", {
      weeklyResetAt: (NOW + 24 * HOUR) / 1000,
    }), NOW);
    expect(milliseconds).toEqual(seconds);
  });
});

describe("quota target allocation", () => {
  test("allocates equal remaining quota by inverse time to reset", () => {
    const plan = planCodexQuotaAllocation([
      account("24h", { usedPercent: 50, weeklyResetAt: NOW + 24 * HOUR }),
      account("72h", { usedPercent: 50, weeklyResetAt: NOW + 72 * HOUR }),
      account("144h", { usedPercent: 50, weeklyResetAt: NOW + 144 * HOUR }),
    ], 12, NOW);
    const targets = Object.fromEntries(plan.rows.map(row => [row.account.id, row.targetTurns]));

    expect(targets["24h"]).toBeCloseTo(6, 8);
    expect(targets["72h"]).toBeCloseTo(4, 8);
    expect(targets["144h"]).toBeCloseTo(2, 8);
  });

  test("allocates equal reset time by remaining quota", () => {
    const plan = planCodexQuotaAllocation([
      account("80-left", { usedPercent: 20, weeklyResetAt: NOW + 72 * HOUR }),
      account("50-left", { usedPercent: 50, weeklyResetAt: NOW + 72 * HOUR }),
      account("20-left", { usedPercent: 80, weeklyResetAt: NOW + 72 * HOUR }),
    ], 12, NOW);
    const targets = Object.fromEntries(plan.rows.map(row => [row.account.id, row.targetTurns]));

    expect(targets["80-left"]).toBe(6);
    expect(targets["50-left"]).toBe(4);
    expect(targets["20-left"]).toBe(2);
  });

  test("redistributes demand after urgent accounts reach the hard cap", () => {
    const plan = planCodexQuotaAllocation([
      account("official-12h", {
        usedPercent: 10,
        weeklyResetAt: NOW + 120 * HOUR,
        officialResetAt: NOW + 12 * HOUR,
      }),
      account("weekly-36h", { usedPercent: 30, weeklyResetAt: NOW + 36 * HOUR }),
      account("weekly-144h", { usedPercent: 5, weeklyResetAt: NOW + 144 * HOUR }),
    ], 15, NOW);
    const targets = Object.fromEntries(plan.rows.map(row => [row.account.id, row.targetTurns]));

    expect(targets["official-12h"]).toBeCloseTo(6, 8);
    expect(targets["weekly-36h"]).toBeCloseTo(6, 8);
    expect(targets["weekly-144h"]).toBeCloseTo(3, 8);
  });

  test("apportions integer targets from demand and urgency without a soft cap", () => {
    const accounts = [
      account("urgent-a", { usedPercent: 1, weeklyResetAt: NOW + 40 * HOUR, activeTurns: 4 }),
      account("urgent-b", { usedPercent: 1, weeklyResetAt: NOW + 40 * HOUR, activeTurns: 4 }),
      account("urgent-c", { usedPercent: 1, weeklyResetAt: NOW + 40 * HOUR, activeTurns: 3 }),
      ...["d", "e", "f", "g", "h"].map(id => account(id, {
        usedPercent: 1,
        weeklyResetAt: NOW + 168 * HOUR,
        activeTurns: 1,
      })),
    ];
    const plan = planCodexQuotaAllocation(accounts, 16, NOW);
    const target = new Map(plan.rows.map(row => [row.account.id, row.targetTurns]));

    expect(target.get("urgent-a")).toBe(4);
    expect(target.get("urgent-b")).toBe(4);
    expect(target.get("urgent-c")).toBe(3);
    for (const id of ["d", "e", "f", "g", "h"]) expect(target.get(id)).toBe(1);
    expect(plan.rows.every(row => Number.isInteger(row.targetTurns))).toBe(true);
  });

  test("advances eight equally urgent accounts together when demand permits", () => {
    const accounts = Array.from({ length: 8 }, (_, index) => account(`a-${index}`));

    expect(planCodexQuotaAllocation(accounts, 8, NOW).rows.map(row => row.targetTurns))
      .toEqual(Array(8).fill(1));
    expect(planCodexQuotaAllocation(accounts, 16, NOW).rows.map(row => row.targetTurns))
      .toEqual(Array(8).fill(2));
  });

  test("keeps a production-shaped low load proportional without fractional turns", () => {
    const accounts = [
      account("urgent-a", { usedPercent: 5, weeklyResetAt: NOW + 38.1 * HOUR, activeTurns: 2 }),
      account("urgent-b", { usedPercent: 7, weeklyResetAt: NOW + 38.1 * HOUR, activeTurns: 2 }),
      account("urgent-c", { usedPercent: 8, weeklyResetAt: NOW + 38 * HOUR, activeTurns: 2 }),
      ...["d", "e", "f", "g", "h"].map(id => account(id, {
        usedPercent: 1,
        weeklyResetAt: NOW + 164 * HOUR,
      })),
    ];

    expect(planCodexQuotaAllocation(accounts, 6, NOW).rows.map(row => row.targetTurns))
      .toEqual([2, 2, 2, 0, 0, 0, 0, 0]);
    expect(planCodexQuotaAllocation(accounts, 7, NOW).rows.map(row => row.targetTurns))
      .toEqual([2, 2, 2, 1, 0, 0, 0, 0]);
  });

  test("derives a greater-than-four target from demand without changing configuration", () => {
    const accounts = [
      account("urgent-a", { usedPercent: 1, weeklyResetAt: NOW + 40 * HOUR, activeTurns: 4 }),
      account("urgent-b", { usedPercent: 1, weeklyResetAt: NOW + 40 * HOUR, activeTurns: 4 }),
      account("urgent-c", { usedPercent: 1, weeklyResetAt: NOW + 40 * HOUR, activeTurns: 4 }),
      ...["d", "e", "f", "g", "h"].map(id => account(id, {
        usedPercent: 1,
        weeklyResetAt: NOW + 168 * HOUR,
        activeTurns: 3,
      })),
    ];
    const plan = planCodexQuotaAllocation(accounts, 40, NOW);
    const urgent = plan.rows.find(row => row.account.id === "urgent-a")!;

    expect(urgent.targetTurns).toBeGreaterThan(4);
    expect(urgent.targetTurns).toBeLessThanOrEqual(6);
    expect(urgent.deficitTurns).toBeGreaterThan(1.8);
  });

  test("preserves hard capacity and total allocation for randomized extreme snapshots", () => {
    let state = 0x7f4a7c15;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x1_0000_0000;
    };

    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const count = 1 + Math.floor(random() * 64);
      const accounts = Array.from({ length: count }, (_, index) => account(`a-${index}`, {
        usedPercent: random() < 0.03 ? 100 : random() * 100,
        weeklyResetAt: NOW + Math.max(0.01, random() * 24 * 30) * HOUR,
        resetCredits: random() < 0.4 ? Math.floor(random() * 4) : 0,
        resetCreditExpiresAt: NOW + (random() * 48 - 6) * HOUR,
        officialResetAt: random() < 0.5 ? NOW + (random() * 240 - 12) * HOUR : undefined,
        activeTurns: Math.floor(random() * 7),
        healthy: random() >= 0.05,
      }));
      const desired = Math.floor(random() * (count * 8 + 1));
      const plan = planCodexQuotaAllocation(accounts, desired, NOW);
      const allocated = plan.rows.reduce((sum, row) => sum + row.targetTurns, 0);

      expect(allocated).toBeCloseTo(plan.admittedTurns, 6);
      for (const row of plan.rows) {
        expect(Number.isFinite(row.targetTurns)).toBe(true);
        expect(Number.isInteger(row.targetTurns)).toBe(true);
        expect(row.targetTurns).toBeGreaterThanOrEqual(0);
        expect(row.targetTurns).toBeLessThanOrEqual(row.account.hardCapacity ?? 6);
      }
    }
  });

  test("is invariant to account input order", () => {
    const accounts = [
      account("a", { weeklyResetAt: NOW + 12 * HOUR }),
      account("b", { weeklyResetAt: NOW + 48 * HOUR }),
      account("c", { weeklyResetAt: NOW + 144 * HOUR }),
    ];
    const forward = planCodexQuotaAllocation(accounts, 8, NOW);
    const reverse = planCodexQuotaAllocation([...accounts].reverse(), 8, NOW);
    const targets = (plan: typeof forward) => Object.fromEntries(
      plan.rows.map(row => [row.account.id, Number(row.targetTurns.toFixed(8))]),
    );
    expect(targets(forward)).toEqual(targets(reverse));
  });
});

describe("quota route decision", () => {
  test("switches only when target deficit exceeds affinity migration cost", () => {
    const accounts = [
      account("urgent", { usedPercent: 50, weeklyResetAt: NOW + 24 * HOUR, activeTurns: 2 }),
      account("normal", { usedPercent: 50, weeklyResetAt: NOW + 72 * HOUR, activeTurns: 3 }),
      account("relaxed", { usedPercent: 50, weeklyResetAt: NOW + 144 * HOUR, activeTurns: 1 }),
    ];

    expect(decideCodexQuotaRoute(accounts, "normal", NOW)).toMatchObject({
      kind: "switch",
      accountId: "urgent",
      reason: "deficit",
    });
    expect(decideCodexQuotaRoute([
      { ...accounts[0]!, activeTurns: 5 },
      accounts[1]!,
      accounts[2]!,
    ], "normal", NOW)).toMatchObject({
      kind: "keep",
      accountId: "normal",
      reason: "affinity",
    });
  });

  test("does not leave a fed account for another account that is also fed", () => {
    const accounts = [
      account("a", { weeklyResetAt: NOW + 24 * HOUR, activeTurns: 4 }),
      account("b", { weeklyResetAt: NOW + 24 * HOUR, activeTurns: 4 }),
      account("c", { weeklyResetAt: NOW + 24 * HOUR, activeTurns: 3 }),
    ];
    expect(decideCodexQuotaRoute(accounts, "a", NOW)).toMatchObject({
      kind: "keep",
      accountId: "a",
    });
  });

  test("routes one turn to an explicit post-reset probe without magic urgency", () => {
    const accounts = [
      account("a", { activeTurns: 2 }),
      account("b", { activeTurns: 0, needsProbe: true }),
    ];
    expect(decideCodexQuotaRoute(accounts, "a", NOW)).toMatchObject({
      kind: "switch",
      accountId: "b",
      reason: "probe",
    });
    expect(decideCodexQuotaRoute([
      accounts[0]!,
      { ...accounts[1]!, activeTurns: 1, probeInFlight: true },
    ], "a", NOW)).toMatchObject({ kind: "keep", accountId: "a" });
  });

  test("queues when every healthy account is at hard capacity", () => {
    const accounts = [
      account("a", { activeTurns: 6 }),
      account("b", { activeTurns: 6 }),
      account("unhealthy", { activeTurns: 0, healthy: false }),
    ];
    expect(decideCodexQuotaRoute(accounts, null, NOW)).toMatchObject({
      kind: "queue",
      reason: "capacity",
    });
  });

  test("moves off a hard-full affinity before applying migration hysteresis", () => {
    const accounts = [
      account("a", { activeTurns: 6 }),
      account("b", { activeTurns: 5 }),
    ];
    expect(decideCodexQuotaRoute(accounts, "a", NOW)).toMatchObject({
      kind: "switch",
      accountId: "b",
      reason: "capacity",
    });
  });
});
