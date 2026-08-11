import { describe, expect, test } from "bun:test";

import {
  runQuotaSimulation,
  type QuotaSimulationScenario,
  type SimulationAccountSpec,
  type SimulationResetEvent,
  type SimulationTurnSpec,
} from "./helpers/codex-quota-simulator";

function account(id: string, overrides: Partial<SimulationAccountSpec> = {}): SimulationAccountSpec {
  return {
    id,
    plan: "pro",
    usedPercent: 40,
    weeklyResetAtHour: 168,
    weeklyPeriodHours: 168,
    hardCapacity: 6,
    ...overrides,
  };
}

function turns(
  count: number,
  atHour: number,
  options: { durationHours?: number; costPercent?: number; sessionPrefix?: string } = {},
): SimulationTurnSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    atHour: atHour + index * 0.001,
    sessionId: `${options.sessionPrefix ?? "session"}-${index}`,
    durationHours: options.durationHours ?? 0.25,
    costPercent: options.costPercent ?? 0.5,
  }));
}

describe("quota routing reset simulation", () => {
  test("coalesces simultaneous weekly and official resets into one probe epoch", () => {
    const accounts = ["a", "b", "c", "d"].map(id => account(id, {
      weeklyResetAtHour: 10,
      weeklyPeriodHours: undefined,
      officialResetAtHour: 10,
    }));
    const resetEvents: SimulationResetEvent[] = [
      { atHour: 10, source: "weekly" },
      { atHour: 10, source: "official" },
    ];
    const result = runQuotaSimulation({
      durationHours: 14,
      accounts,
      events: resetEvents,
      turns: turns(8, 10.1),
    }, "target");

    expect(result.metrics.resetEpochs).toBe(4);
    expect(result.metrics.probeAssignments).toEqual({ a: 1, b: 1, c: 1, d: 1 });
    expect(result.metrics.probeCompletions).toEqual({ a: 1, b: 1, c: 1, d: 1 });
    expect(result.metrics.capacityViolations).toBe(0);
  });

  test("manual credit expiry changes the deadline but does not reset capacity", () => {
    const result = runQuotaSimulation({
      durationHours: 20,
      accounts: [account("a", {
        usedPercent: 25,
        resetCredits: 1,
        resetCreditExpiresAtHour: 10,
        weeklyResetAtHour: 100,
        weeklyPeriodHours: undefined,
      })],
      events: [{ atHour: 10, source: "manual-expiry", accountId: "a" }],
      turns: [
        ...turns(1, 9, { sessionPrefix: "before" }),
        ...turns(1, 11, { sessionPrefix: "after" }),
      ],
    }, "target");

    expect(result.metrics.resetEpochs).toBe(0);
    expect(result.metrics.unusedPercentAtReset).toBe(0);
    expect(result.metrics.probeAssignments).toEqual({});
    expect(result.metrics.completedTurns).toBe(2);
  });

  test("redeeming a manual credit creates exactly one reset epoch and one probe", () => {
    const result = runQuotaSimulation({
      durationHours: 20,
      accounts: [account("a", {
        resetCredits: 1,
        resetCreditExpiresAtHour: 40,
        weeklyResetAtHour: 100,
        weeklyPeriodHours: undefined,
      })],
      events: [
        { atHour: 10, source: "manual", accountIds: ["a"] },
        { atHour: 11, source: "manual", accountIds: ["a"] },
      ],
      turns: turns(3, 10.1),
    }, "target");

    expect(result.metrics.resetEpochs).toBe(1);
    expect(result.metrics.probeAssignments).toEqual({ a: 1 });
    expect(result.metrics.probeCompletions).toEqual({ a: 1 });
    expect(result.trace.some(line => line.includes("reject manual reset a"))).toBe(true);
  });

  test("a declared official deadline without an actual reset creates no probe epoch", () => {
    const result = runQuotaSimulation({
      durationHours: 30,
      accounts: [
        account("a", { officialResetAtHour: 10, weeklyResetAtHour: 100, weeklyPeriodHours: undefined }),
        account("b", { weeklyResetAtHour: 50, weeklyPeriodHours: undefined }),
      ],
      turns: [
        ...turns(4, 9, { sessionPrefix: "before" }),
        ...turns(4, 11, { sessionPrefix: "after" }),
      ],
    }, "target");

    expect(result.metrics.resetEpochs).toBe(0);
    expect(result.metrics.probeAssignments).toEqual({});
    expect(result.metrics.completedTurns).toBe(8);
  });

  test("quota observation lag delays probing without duplicating it", () => {
    const result = runQuotaSimulation({
      durationHours: 20,
      observationLagHours: 2,
      accounts: [account("a", { weeklyResetAtHour: 100, weeklyPeriodHours: undefined })],
      events: [{ atHour: 10, source: "official", accountIds: ["a"] }],
      turns: [
        ...turns(1, 10.5, { sessionPrefix: "before-observation" }),
        ...turns(3, 12.1, { sessionPrefix: "after-observation" }),
      ],
    }, "target");

    expect(result.metrics.probeAssignments).toEqual({ a: 1 });
    expect(result.metrics.probeCompletions).toEqual({ a: 1 });
  });

  test("a probe from an older reset generation cannot satisfy a newer reset", () => {
    const result = runQuotaSimulation({
      durationHours: 18,
      accounts: [account("a", { weeklyResetAtHour: 100, weeklyPeriodHours: undefined })],
      events: [
        { atHour: 10, source: "official", accountIds: ["a"] },
        { atHour: 11, source: "weekly", accountIds: ["a"] },
      ],
      turns: [
        { atHour: 10.1, sessionId: "old-probe", durationHours: 5, costPercent: 1 },
        { atHour: 11.1, sessionId: "new-probe", durationHours: 1, costPercent: 1 },
      ],
    }, "target");

    expect(result.metrics.resetEpochs).toBe(2);
    expect(result.metrics.probeAssignments).toEqual({ a: 2 });
    expect(result.metrics.probeCompletions).toEqual({ a: 1 });
    expect(result.trace.some(line => line.includes("old-probe -> a probe:1"))).toBe(true);
    expect(result.trace.some(line => line.includes("new-probe -> a probe:2"))).toBe(true);
  });

  test("charges a long turn to the reset epoch where upstream admitted it", () => {
    const result = runQuotaSimulation({
      durationHours: 16,
      accounts: [account("a", {
        usedPercent: 0,
        weeklyResetAtHour: 100,
        weeklyPeriodHours: undefined,
      })],
      events: [{ atHour: 10, source: "official", accountIds: ["a"] }],
      turns: [{
        atHour: 9,
        sessionId: "cross-reset",
        durationHours: 5,
        costPercent: 10,
      }],
    }, "target");

    expect(result.metrics.unusedPercentAtReset).toBe(90);
    expect(result.metrics.completedTurns).toBe(1);
  });

  test("covers every ordering and coincidence of weekly, manual, and official resets", () => {
    const resetHours = [6, 12];
    for (const weekly of resetHours) {
      for (const manual of resetHours) {
        for (const official of resetHours) {
          const events: SimulationResetEvent[] = [
            { atHour: weekly, source: "weekly", accountIds: ["a"] },
            { atHour: manual, source: "manual", accountIds: ["a"] },
            { atHour: official, source: "official", accountIds: ["a"] },
          ];
          const result = runQuotaSimulation({
            durationHours: 18,
            accounts: [account("a", {
              resetCredits: 1,
              resetCreditExpiresAtHour: 20,
              weeklyResetAtHour: 30,
              weeklyPeriodHours: undefined,
              officialResetAtHour: official,
            })],
            events,
            turns: [
              ...turns(2, 6.1, { sessionPrefix: "early" }),
              ...turns(2, 12.1, { sessionPrefix: "late" }),
            ],
          }, "target");
          const expectedEpochs = new Set([weekly, manual, official]).size;
          expect(result.metrics.resetEpochs, `${weekly}/${manual}/${official}`).toBe(expectedEpochs);
          expect(result.metrics.capacityViolations).toBe(0);
        }
      }
    }
  });
});

describe("quota routing load simulation", () => {
  test("admits forty-eight and queues eight in a simultaneous fixed-eight-account burst", () => {
    const result = runQuotaSimulation({
      durationHours: 2,
      accounts: Array.from({ length: 8 }, (_, index) => account(`a-${index}`)),
      turns: turns(56, 0, { durationHours: 0.5 }),
    }, "target");

    expect(result.metrics.completedTurns).toBe(56);
    expect(result.metrics.pendingTurns).toBe(0);
    expect(result.metrics.queuedTurns).toBe(8);
    expect(result.metrics.maxQueueDepth).toBe(8);
    expect(result.metrics.capacityViolations).toBe(0);
    expect(Object.keys(result.metrics.assignments)).toHaveLength(8);
    for (const active of Object.values(result.metrics.maxActiveTurns)) {
      expect(active).toBe(6);
    }
  });

  test("survives a fixed eight-account calendar with resets, lag, health flaps, and bursts", () => {
    const accounts = [
      account("a", { usedPercent: 5, weeklyResetAtHour: 36 }),
      account("b", { usedPercent: 20, weeklyResetAtHour: 48 }),
      account("c", {
        usedPercent: 35,
        weeklyResetAtHour: 72,
        resetCredits: 1,
        resetCreditExpiresAtHour: 30,
      }),
      account("d", { usedPercent: 50, weeklyResetAtHour: 96, officialResetAtHour: 24 }),
      account("e", { usedPercent: 65, weeklyResetAtHour: 120 }),
      account("f", {
        usedPercent: 80,
        weeklyResetAtHour: 144,
        resetCredits: 2,
        resetCreditExpiresAtHour: 18,
      }),
      account("g", { usedPercent: 90, weeklyResetAtHour: 168, officialResetAtHour: 60 }),
      account("h", { usedPercent: 10, weeklyResetAtHour: 168 }),
    ];
    const durations = [0.05, 0.2, 0.75, 2, 8];
    const costs = [0.03, 0.08, 0.15, 0.3, 0.6];
    const workload = Array.from({ length: 1_600 }, (_, index) => ({
      atHour: index * 0.1 + (index % 80 === 0 ? 0 : (index % 8) * 0.0001),
      sessionId: `session-${index % 64}`,
      durationHours: durations[index % durations.length]!,
      costPercent: costs[index % costs.length]!,
    }));
    const scenario: QuotaSimulationScenario = {
      durationHours: 220,
      observationLagHours: 2.5,
      accounts,
      turns: workload,
      events: [
        { atHour: 18, source: "manual", accountIds: ["f"] },
        { atHour: 24, source: "official", accountIds: ["d"] },
        { atHour: 30, source: "manual-expiry", accountId: "c" },
        { atHour: 40, accountId: "e", healthy: false },
        { atHour: 52, accountId: "e", healthy: true },
        { atHour: 60, source: "official", accountIds: ["g"] },
        { atHour: 80, accountId: "b", healthy: false },
        { atHour: 84, accountId: "b", healthy: true },
        { atHour: 110, source: "manual", accountIds: ["f"] },
      ],
    };

    const result = runQuotaSimulation(scenario, "target");
    expect(result.metrics.capacityViolations).toBe(0);
    expect(result.metrics.speculativeAffinityReleases).toBe(0);
    expect(result.metrics.completedTurns + result.metrics.pendingTurns).toBe(1_600);
    expect(result.metrics.resetEpochs).toBeGreaterThanOrEqual(10);
    expect(Object.keys(result.metrics.assignments)).toHaveLength(8);
    expect(Object.values(result.metrics.probeAssignments).reduce((sum, count) => sum + count, 0))
      .toBeGreaterThanOrEqual(8);
    for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      expect(result.metrics.maxActiveTurns[id]).toBeLessThanOrEqual(6);
    }
  });

  test("queues bursts instead of violating the hard per-account turn cap", () => {
    const scenario: QuotaSimulationScenario = {
      durationHours: 5,
      accounts: [
        account("a", { hardCapacity: 2 }),
        account("b", { hardCapacity: 2 }),
      ],
      turns: turns(20, 0, { durationHours: 0.5 }),
    };
    const result = runQuotaSimulation(scenario, "target");

    expect(result.metrics.completedTurns).toBe(20);
    expect(result.metrics.pendingTurns).toBe(0);
    expect(result.metrics.queuedTurns).toBeGreaterThan(0);
    expect(result.metrics.maxQueueDepth).toBeGreaterThan(0);
    expect(result.metrics.capacityViolations).toBe(0);
    expect(result.metrics.maxActiveTurns.a).toBeLessThanOrEqual(2);
    expect(result.metrics.maxActiveTurns.b).toBeLessThanOrEqual(2);
  });

  test("removes speculative settlement releases while retaining deliberate next-turn switching", () => {
    const scenario: QuotaSimulationScenario = {
      durationHours: 8,
      accounts: [
        account("a", { usedPercent: 50, weeklyResetAtHour: 144, weeklyPeriodHours: undefined }),
        account("b", { usedPercent: 50, weeklyResetAtHour: 144, weeklyPeriodHours: undefined }),
      ],
      events: [{ atHour: 2, source: "official", accountIds: ["b"] }],
      turns: [
        ...turns(8, 0, { durationHours: 3, sessionPrefix: "sticky" }),
        ...turns(8, 4, { durationHours: 0.5, sessionPrefix: "sticky" }),
      ],
    };
    const legacy = runQuotaSimulation(scenario, "legacy");
    const target = runQuotaSimulation(scenario, "target");

    expect(legacy.metrics.speculativeAffinityReleases).toBeGreaterThan(0);
    expect(target.metrics.speculativeAffinityReleases).toBe(0);
    expect(target.metrics.probeAssignments.b).toBe(1);
    expect(target.metrics.capacityViolations).toBe(0);
  });

  test("survives deterministic mixed-reset Monte Carlo workloads", () => {
    let state = 0x9e3779b9;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x1_0000_0000;
    };

    for (let run = 0; run < 100; run += 1) {
      const accounts = Array.from({ length: 8 }, (_, index) => account(`a-${index}`, {
        usedPercent: random() * 90,
        weeklyResetAtHour: 48 + random() * 120,
        weeklyPeriodHours: undefined,
        resetCredits: random() < 0.6 ? 1 : 0,
        resetCreditExpiresAtHour: 24 + random() * 120,
        officialResetAtHour: random() < 0.7 ? 36 + random() * 100 : undefined,
      }));
      const workload = Array.from({ length: 300 }, (_, index) => ({
        atHour: random() * 167,
        sessionId: `s-${Math.floor(random() * 40)}`,
        durationHours: 0.02 + random() * 6,
        costPercent: 0.02 + random() * 1.2,
      }));
      const events: Array<SimulationResetEvent | { atHour: number; source: "manual-expiry"; accountId: string }> = [];
      for (const row of accounts) {
        events.push({ atHour: row.weeklyResetAtHour!, source: "weekly", accountIds: [row.id] });
        if ((row.resetCredits ?? 0) > 0) {
          if (random() < 0.5) {
            events.push({
              atHour: Math.min(row.resetCreditExpiresAtHour! - 0.1, 20 + random() * 100),
              source: "manual",
              accountIds: [row.id],
            });
          } else {
            events.push({ atHour: row.resetCreditExpiresAtHour!, source: "manual-expiry", accountId: row.id });
          }
        }
      }
      if (run % 3 === 0) events.push({ atHour: 72, source: "official" });

      const scenario: QuotaSimulationScenario = {
        durationHours: 180,
        observationLagHours: random() * 4,
        accounts,
        turns: workload,
        events,
      };

      for (const policy of ["legacy", "target"] as const) {
        const result = runQuotaSimulation(scenario, policy);
        expect(result.metrics.capacityViolations, `${policy} run ${run}`).toBe(0);
        expect(
          result.metrics.completedTurns + result.metrics.pendingTurns,
          `${policy} run ${run}`,
        ).toBe(300);
        if (policy === "target") expect(result.metrics.speculativeAffinityReleases).toBe(0);
        for (const active of Object.values(result.metrics.maxActiveTurns)) {
          expect(active).toBeLessThanOrEqual(6);
        }
      }
    }
  });
});
