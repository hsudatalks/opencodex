import { describe, expect, test } from "bun:test";

import {
  planCodexQuotaAllocation,
  type CodexQuotaAllocationAccount,
} from "../src/codex/quota-allocation-model";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const ACCOUNT_IDS = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const LOADS = [8, 16, 24, 32, 40, 48, 56] as const;

type AccountOverride = Partial<Omit<CodexQuotaAllocationAccount, "id" | "activeTurns">>;

function accounts(overrides: readonly AccountOverride[]): CodexQuotaAllocationAccount[] {
  if (overrides.length !== 8) throw new Error(`expected 8 accounts, received ${overrides.length}`);
  return overrides.map((override, index) => ({
    id: ACCOUNT_IDS[index]!,
    plan: "pro",
    usedPercent: 50,
    weeklyResetAt: NOW + 168 * HOUR,
    activeTurns: 0,
    hardCapacity: 6,
    ...override,
  }));
}

function targetsFor(
  input: readonly CodexQuotaAllocationAccount[],
  desiredTurns: number,
): Record<string, number> {
  const plan = planCodexQuotaAllocation(input, desiredTurns, NOW);
  return Object.fromEntries(plan.rows.map(row => [row.account.id, row.targetTurns]));
}

const scenarios = [
  {
    name: "same remaining quota with staggered reset times",
    input: accounts([24, 36, 48, 72, 96, 120, 144, 168].map(hours => ({
      usedPercent: 50,
      weeklyResetAt: NOW + hours * HOUR,
    }))),
  },
  {
    name: "same reset time with staggered remaining quota",
    input: accounts([95, 80, 65, 50, 35, 20, 10, 5].map(remaining => ({
      usedPercent: 100 - remaining,
      weeklyResetAt: NOW + 72 * HOUR,
    }))),
  },
  {
    name: "crossed remaining quota and reset time",
    input: accounts([
      { usedPercent: 5, weeklyResetAt: NOW + 168 * HOUR },
      { usedPercent: 10, weeklyResetAt: NOW + 24 * HOUR },
      { usedPercent: 25, weeklyResetAt: NOW + 48 * HOUR },
      { usedPercent: 40, weeklyResetAt: NOW + 72 * HOUR },
      { usedPercent: 55, weeklyResetAt: NOW + 96 * HOUR },
      { usedPercent: 70, weeklyResetAt: NOW + 120 * HOUR },
      { usedPercent: 85, weeklyResetAt: NOW + 144 * HOUR },
      { usedPercent: 95, weeklyResetAt: NOW + 168 * HOUR },
    ]),
  },
  {
    name: "equal burn rates despite different quota and time",
    input: accounts([
      { usedPercent: 87.5, weeklyResetAt: NOW + 24 * HOUR },
      { usedPercent: 75, weeklyResetAt: NOW + 48 * HOUR },
      { usedPercent: 62.5, weeklyResetAt: NOW + 72 * HOUR },
      { usedPercent: 50, weeklyResetAt: NOW + 96 * HOUR },
      { usedPercent: 37.5, weeklyResetAt: NOW + 120 * HOUR },
      { usedPercent: 25, weeklyResetAt: NOW + 144 * HOUR },
      { usedPercent: 12.5, weeklyResetAt: NOW + 168 * HOUR },
      { usedPercent: 0, weeklyResetAt: NOW + 192 * HOUR },
    ]),
  },
  {
    name: "official and manual deadlines override weekly resets",
    input: accounts([
      { usedPercent: 10, weeklyResetAt: NOW + 168 * HOUR, officialResetAt: NOW + 8 * HOUR },
      { usedPercent: 30, weeklyResetAt: NOW + 168 * HOUR, officialResetAt: NOW + 16 * HOUR },
      {
        usedPercent: 40,
        weeklyResetAt: NOW + 168 * HOUR,
        resetCredits: 1,
        resetCreditExpiresAt: NOW + 12 * HOUR,
      },
      {
        usedPercent: 50,
        weeklyResetAt: NOW + 168 * HOUR,
        resetCredits: 2,
        resetCreditExpiresAt: NOW + 36 * HOUR,
      },
      { usedPercent: 5, weeklyResetAt: NOW + 48 * HOUR },
      { usedPercent: 25, weeklyResetAt: NOW + 72 * HOUR },
      { usedPercent: 50, weeklyResetAt: NOW + 120 * HOUR },
      { usedPercent: 75, weeklyResetAt: NOW + 168 * HOUR },
    ]),
  },
  {
    name: "recent resets with one short next window",
    input: accounts([24, 168, 168, 168, 168, 168, 168, 168].map(hours => ({
      usedPercent: 0,
      weeklyResetAt: NOW + hours * HOUR,
    }))),
  },
  {
    name: "exhausted unhealthy and unknown observations",
    input: accounts([
      { usedPercent: 100, weeklyResetAt: NOW + 8 * HOUR },
      { usedPercent: 100, weeklyResetAt: NOW + 24 * HOUR },
      { usedPercent: 20, weeklyResetAt: NOW + 48 * HOUR, healthy: false },
      { usedPercent: null, weeklyResetAt: NOW + 72 * HOUR },
      { usedPercent: Number.NaN, weeklyResetAt: NOW + 96 * HOUR },
      { usedPercent: 40, weeklyResetAt: NOW + 120 * HOUR },
      { usedPercent: 60, weeklyResetAt: NOW + 144 * HOUR },
      { usedPercent: 80, weeklyResetAt: NOW + 168 * HOUR },
    ]),
  },
  {
    name: "deadline floor and stale deadlines",
    input: accounts([
      { usedPercent: 20, weeklyResetAt: NOW + 0.01 * HOUR },
      { usedPercent: 20, weeklyResetAt: NOW + 0.5 * HOUR },
      { usedPercent: 20, weeklyResetAt: NOW + HOUR },
      { usedPercent: 20, weeklyResetAt: NOW + 2 * HOUR },
      { usedPercent: 20, weeklyResetAt: NOW },
      { usedPercent: 20, weeklyResetAt: NOW - HOUR },
      { usedPercent: 20, weeklyResetAt: NOW + 72 * HOUR },
      { usedPercent: 20, weeklyResetAt: NOW + 168 * HOUR },
    ]),
  },
] as const;

describe("eight-account quota allocation matrix", () => {
  test("preserves allocation invariants across every scenario and load", () => {
    for (const scenario of scenarios) {
      let previousTargets = Object.fromEntries(ACCOUNT_IDS.map(id => [id, 0]));
      for (const desiredTurns of LOADS) {
        const plan = planCodexQuotaAllocation(scenario.input, desiredTurns, NOW);
        const allocated = plan.rows.reduce((sum, row) => sum + row.targetTurns, 0);

        expect(plan.rows.length, scenario.name).toBeLessThanOrEqual(8);
        expect(allocated, `${scenario.name} @ ${desiredTurns}`).toBeCloseTo(plan.admittedTurns, 8);
        expect(plan.admittedTurns, scenario.name).toBeLessThanOrEqual(plan.hardCapacity);
        for (const row of plan.rows) {
          expect(Number.isFinite(row.targetTurns), `${scenario.name}/${row.account.id}`).toBe(true);
          expect(row.targetTurns, `${scenario.name}/${row.account.id}`).toBeGreaterThanOrEqual(0);
          expect(row.targetTurns, `${scenario.name}/${row.account.id}`).toBeLessThanOrEqual(6);
          expect(
            row.targetTurns + 1e-8,
            `${scenario.name}/${row.account.id} monotonic @ ${desiredTurns}`,
          ).toBeGreaterThanOrEqual(previousTargets[row.account.id] ?? 0);
        }
        previousTargets = targetsFor(scenario.input, desiredTurns);
      }
    }
  });

  test("equal burn rates produce equal targets at every unsaturated load", () => {
    const scenario = scenarios.find(row => row.name.startsWith("equal burn rates"))!;
    for (const desiredTurns of [8, 16, 24, 32, 40, 48]) {
      const targets = Object.values(targetsFor(scenario.input, desiredTurns));
      expect(Math.max(...targets) - Math.min(...targets)).toBeLessThan(1e-8);
    }
  });

  test("is invariant to every scenario being supplied in reverse order", () => {
    for (const scenario of scenarios) {
      for (const desiredTurns of LOADS) {
        const forward = targetsFor(scenario.input, desiredTurns);
        const reverse = targetsFor([...scenario.input].reverse(), desiredTurns);
        for (const id of ACCOUNT_IDS) {
          expect(reverse[id] ?? 0, `${scenario.name}/${id} @ ${desiredTurns}`)
            .toBeCloseTo(forward[id] ?? 0, 8);
        }
      }
    }
  });

  test("uses all 48 hard-cap slots before queueing the fifty-six turn load", () => {
    for (const scenario of scenarios.slice(0, 6)) {
      const plan = planCodexQuotaAllocation(scenario.input, 56, NOW);
      expect(plan.admittedTurns, scenario.name).toBe(48);
      expect(plan.rows.every(row => Math.abs(row.targetTurns - 6) < 1e-8), scenario.name).toBe(true);
    }
  });

  test("excludes exhausted and unhealthy accounts while keeping unknown observations conservative", () => {
    const scenario = scenarios.find(row => row.name.startsWith("exhausted"))!;
    const plan = planCodexQuotaAllocation(scenario.input, 32, NOW);
    const ids = plan.rows.map(row => row.account.id);

    expect(ids).not.toContain("a");
    expect(ids).not.toContain("b");
    expect(ids).not.toContain("c");
    expect(ids).toEqual(["d", "e", "f", "g", "h"]);
    expect(plan.hardCapacity).toBe(30);
    expect(plan.admittedTurns).toBe(30);
    expect(plan.rows.reduce((sum, row) => sum + row.targetTurns, 0)).toBeCloseTo(30, 8);

    const lowLoad = targetsFor(scenario.input, 8);
    expect(lowLoad.d).toBe(0);
    expect(lowLoad.e).toBe(0);
    expect((lowLoad.f ?? 0) + (lowLoad.g ?? 0) + (lowLoad.h ?? 0)).toBeCloseTo(8, 8);
  });

  test("floors sub-hour deadlines and ignores current or past deadlines", () => {
    const scenario = scenarios.find(row => row.name.startsWith("deadline floor"))!;
    const plan = planCodexQuotaAllocation(scenario.input, 16, NOW);
    const rows = Object.fromEntries(plan.rows.map(row => [row.account.id, row]));

    expect(rows.a.deadline?.hoursRemaining).toBe(1);
    expect(rows.b.deadline?.hoursRemaining).toBe(1);
    expect(rows.c.deadline?.hoursRemaining).toBe(1);
    expect(rows.d.deadline?.hoursRemaining).toBe(2);
    expect(rows.e.deadline).toBeNull();
    expect(rows.f.deadline).toBeNull();
    expect(rows.a.targetTurns).toBeCloseTo(rows.b.targetTurns, 8);
    expect(rows.b.targetTurns).toBeCloseTo(rows.c.targetTurns, 8);
  });

  test("preserves invariants across five thousand fixed-eight-account edge snapshots", () => {
    let state = 0xa341316c;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x1_0000_0000;
    };

    for (let iteration = 0; iteration < 5_000; iteration += 1) {
      const input = accounts(ACCOUNT_IDS.map(() => {
        const quotaKind = Math.floor(random() * 20);
        const usedPercent = quotaKind === 0
          ? null
          : quotaKind === 1
            ? Number.NaN
            : quotaKind === 2
              ? 100
              : random() * 100;
        const deadlineKind = Math.floor(random() * 12);
        const weeklyResetAt = deadlineKind === 0
          ? NOW - random() * 24 * HOUR
          : deadlineKind === 1
            ? NOW
            : NOW + Math.max(0.001, random() * 24 * 30) * HOUR;
        const resetCredits = random() < 0.35 ? 1 + Math.floor(random() * 3) : 0;

        return {
          usedPercent,
          weeklyResetAt,
          resetCredits,
          resetCreditExpiresAt: NOW + (random() * 96 - 12) * HOUR,
          officialResetAt: random() < 0.45
            ? NOW + (random() * 240 - 24) * HOUR
            : undefined,
          healthy: random() >= 0.08,
        };
      }));
      const desiredTurns = Math.floor(random() * 65);
      const plan = planCodexQuotaAllocation(input, desiredTurns, NOW);
      const allocated = plan.rows.reduce((sum, row) => sum + row.targetTurns, 0);

      expect(allocated).toBeCloseTo(plan.admittedTurns, 7);
      expect(plan.admittedTurns).toBe(Math.min(desiredTurns, plan.hardCapacity));
      expect(plan.hardCapacity).toBe(plan.rows.length * 6);
      for (const row of plan.rows) {
        expect(Number.isFinite(row.targetTurns)).toBe(true);
        expect(row.targetTurns).toBeGreaterThanOrEqual(0);
        expect(row.targetTurns).toBeLessThanOrEqual(6);
      }
    }
  });

  test("never lowers an account target when only its burn rate increases", () => {
    let state = 0xc8013ea4;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x1_0000_0000;
    };

    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const base = accounts(ACCOUNT_IDS.map(() => ({
        usedPercent: random() * 95,
        weeklyResetAt: NOW + (1 + random() * 167) * HOUR,
      })));
      const desiredTurns = 1 + Math.floor(random() * 47);
      const before = targetsFor(base, desiredTurns).a!;
      const improved = base.map(row => ({ ...row }));
      improved[0] = {
        ...improved[0]!,
        usedPercent: Math.max(0, (improved[0]!.usedPercent ?? 0) - random() * 25),
        weeklyResetAt: NOW + Math.max(
          0.01,
          ((improved[0]!.weeklyResetAt! - NOW) / HOUR) * (0.1 + random() * 0.9),
        ) * HOUR,
      };
      const after = targetsFor(improved, desiredTurns).a!;

      expect(after + 1e-8, `iteration ${iteration}`).toBeGreaterThanOrEqual(before);
    }
  });
});
