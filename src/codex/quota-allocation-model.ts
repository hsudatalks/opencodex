import { codexQuotaWindowForPlan } from "./quota";

export type CodexQuotaDeadlineSource = "weekly" | "monthly" | "manual" | "official";

export interface CodexQuotaAllocationAccount {
  id: string;
  plan?: string | null;
  usedPercent?: number | null;
  weeklyResetAt?: number;
  monthlyResetAt?: number;
  resetCredits?: number;
  resetCreditExpiresAt?: number;
  officialResetAt?: number;
  activeTurns: number;
  affinityCount?: number;
  healthy?: boolean;
  needsProbe?: boolean;
  probeInFlight?: boolean;
  hardCapacity?: number;
}

export interface CodexQuotaDeadline {
  at: number;
  source: CodexQuotaDeadlineSource;
  hoursRemaining: number;
}

export interface CodexQuotaAllocationRow {
  account: CodexQuotaAllocationAccount;
  deadline: CodexQuotaDeadline | null;
  remainingPercent: number | null;
  requiredRate: number | null;
  targetTurns: number;
  deficitTurns: number;
}

export interface CodexQuotaAllocationPlan {
  desiredTurns: number;
  admittedTurns: number;
  hardCapacity: number;
  rows: readonly CodexQuotaAllocationRow[];
}

export interface CodexQuotaRouteDecision {
  kind: "keep" | "switch" | "queue";
  accountId?: string;
  reason: "affinity" | "probe" | "deficit" | "capacity" | "unavailable";
  plan: CodexQuotaAllocationPlan;
}

export interface CodexQuotaAllocationOptions {
  defaultHardCapacity?: number;
  deadlineFloorHours?: number;
  migrationHysteresisTurns?: number;
}

const DEFAULT_HARD_CAPACITY = 6;
const DEFAULT_DEADLINE_FLOOR_HOURS = 1;
const DEFAULT_MIGRATION_HYSTERESIS_TURNS = 1;
const EPSILON = 1e-9;

function epochMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function finitePercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

export function effectiveCodexQuotaDeadline(
  account: CodexQuotaAllocationAccount,
  now: number,
  deadlineFloorHours = DEFAULT_DEADLINE_FLOOR_HOURS,
): CodexQuotaDeadline | null {
  const governingSource = codexQuotaWindowForPlan(account.plan);
  const governingResetAt = governingSource === "monthly"
    ? epochMs(account.monthlyResetAt)
    : epochMs(account.weeklyResetAt);
  const deadlines: Array<{ at: number; source: CodexQuotaDeadlineSource }> = [];
  if (governingResetAt !== undefined && governingResetAt > now) {
    deadlines.push({ at: governingResetAt, source: governingSource });
  }

  const manualResetAt = account.resetCredits && account.resetCredits > 0
    ? epochMs(account.resetCreditExpiresAt)
    : undefined;
  if (manualResetAt !== undefined && manualResetAt > now) {
    deadlines.push({ at: manualResetAt, source: "manual" });
  }

  const officialResetAt = epochMs(account.officialResetAt);
  if (officialResetAt !== undefined && officialResetAt > now) {
    deadlines.push({ at: officialResetAt, source: "official" });
  }

  if (deadlines.length === 0) return null;
  deadlines.sort((left, right) => left.at - right.at || left.source.localeCompare(right.source));
  const earliest = deadlines[0]!;
  return {
    ...earliest,
    hoursRemaining: Math.max((earliest.at - now) / 3_600_000, Math.max(deadlineFloorHours, EPSILON)),
  };
}

function allocationFacts(
  account: CodexQuotaAllocationAccount,
  now: number,
  options: CodexQuotaAllocationOptions,
): Omit<CodexQuotaAllocationRow, "targetTurns" | "deficitTurns"> {
  const usedPercent = finitePercent(account.usedPercent);
  const remainingPercent = usedPercent === null ? null : 100 - usedPercent;
  const deadline = effectiveCodexQuotaDeadline(
    account,
    now,
    options.deadlineFloorHours ?? DEFAULT_DEADLINE_FLOOR_HOURS,
  );
  return {
    account,
    deadline,
    remainingPercent,
    requiredRate: remainingPercent !== null && deadline !== null
      ? remainingPercent / deadline.hoursRemaining
      : null,
  };
}

function weightedWaterFill(
  facts: readonly ReturnType<typeof allocationFacts>[],
  capacities: readonly number[],
  requested: number,
): number[] {
  const targets = facts.map(() => 0);
  let remaining = Math.max(0, requested);
  let candidates = facts
    .map((fact, index) => ({
      index,
      capacity: Math.max(0, capacities[index] ?? 0),
      weight: Math.max(0, fact.requiredRate ?? 0),
    }))
    .filter(row => row.capacity > EPSILON);

  while (remaining > EPSILON && candidates.length > 0) {
    const positiveWeight = candidates.some(row => row.weight > EPSILON);
    const totalWeight = candidates.reduce(
      (sum, row) => sum + (positiveWeight ? row.weight : 1),
      0,
    );
    if (totalWeight <= EPSILON) break;

    const scale = remaining / totalWeight;
    const saturated = candidates.filter(row => (
      scale * (positiveWeight ? row.weight : 1) >= row.capacity - EPSILON
    ));
    if (saturated.length === 0) {
      for (const row of candidates) {
        targets[row.index] += scale * (positiveWeight ? row.weight : 1);
      }
      remaining = 0;
      break;
    }

    const saturatedIndexes = new Set(saturated.map(row => row.index));
    for (const row of saturated) {
      targets[row.index] += row.capacity;
      remaining -= row.capacity;
    }
    candidates = candidates.filter(row => !saturatedIndexes.has(row.index));
  }

  return targets;
}

export function planCodexQuotaAllocation(
  accounts: readonly CodexQuotaAllocationAccount[],
  desiredTurns: number,
  now: number,
  options: CodexQuotaAllocationOptions = {},
): CodexQuotaAllocationPlan {
  const defaultHardCapacity = positiveInteger(options.defaultHardCapacity, DEFAULT_HARD_CAPACITY);
  const facts = accounts
    .filter(account => account.healthy !== false && finitePercent(account.usedPercent) !== 100)
    .map(account => allocationFacts(account, now, options));
  const hardCapacities = facts.map(({ account }) => positiveInteger(account.hardCapacity, defaultHardCapacity));
  const hardCapacity = hardCapacities.reduce((sum, value) => sum + value, 0);
  const admittedTurns = Math.max(0, Math.min(desiredTurns, hardCapacity));
  const targets = weightedWaterFill(facts, hardCapacities, admittedTurns);

  return {
    desiredTurns,
    admittedTurns,
    hardCapacity,
    rows: facts.map((fact, index) => {
      const targetTurns = targets[index] ?? 0;
      return {
        ...fact,
        targetTurns,
        deficitTurns: targetTurns - Math.max(0, fact.account.activeTurns),
      };
    }),
  };
}

function compareRouteRows(left: CodexQuotaAllocationRow, right: CodexQuotaAllocationRow): number {
  if (left.deficitTurns !== right.deficitTurns) return right.deficitTurns - left.deficitTurns;
  if (left.account.activeTurns !== right.account.activeTurns) {
    return left.account.activeTurns - right.account.activeTurns;
  }
  const leftAffinities = left.account.affinityCount ?? 0;
  const rightAffinities = right.account.affinityCount ?? 0;
  if (leftAffinities !== rightAffinities) return leftAffinities - rightAffinities;
  const leftDeadline = left.deadline?.at ?? Number.POSITIVE_INFINITY;
  const rightDeadline = right.deadline?.at ?? Number.POSITIVE_INFINITY;
  return leftDeadline - rightDeadline || left.account.id.localeCompare(right.account.id);
}

export function decideCodexQuotaRoute(
  accounts: readonly CodexQuotaAllocationAccount[],
  currentAccountId: string | null,
  now: number,
  options: CodexQuotaAllocationOptions = {},
): CodexQuotaRouteDecision {
  const desiredTurns = accounts.reduce((sum, account) => sum + Math.max(0, account.activeTurns), 0) + 1;
  const plan = planCodexQuotaAllocation(accounts, desiredTurns, now, options);
  const current = currentAccountId
    ? plan.rows.find(row => row.account.id === currentAccountId)
    : undefined;
  const probeCandidates = plan.rows
    .filter(row => {
      const hardCapacity = positiveInteger(
        row.account.hardCapacity,
        options.defaultHardCapacity ?? DEFAULT_HARD_CAPACITY,
      );
      return row.account.needsProbe === true
        && row.account.probeInFlight !== true
        && row.account.activeTurns < hardCapacity;
    })
    .sort((left, right) => (
      left.account.activeTurns - right.account.activeTurns
      || compareRouteRows(left, right)
    ));
  const ordinaryCandidates = plan.rows
    .filter(row => {
      const hardCapacity = positiveInteger(
        row.account.hardCapacity,
        options.defaultHardCapacity ?? DEFAULT_HARD_CAPACITY,
      );
      return row.account.activeTurns < hardCapacity;
    })
    .sort(compareRouteRows);
  const selected = probeCandidates[0] ?? ordinaryCandidates[0];

  if (!selected) {
    return { kind: "queue", reason: "capacity", plan };
  }
  if (!currentAccountId) {
    return {
      kind: "switch",
      accountId: selected.account.id,
      reason: probeCandidates[0] ? "probe" : "deficit",
      plan,
    };
  }
  if (!current) {
    return {
      kind: "switch",
      accountId: selected.account.id,
      reason: "unavailable",
      plan,
    };
  }
  if (selected.account.id === current.account.id) {
    return { kind: "keep", accountId: current.account.id, reason: "affinity", plan };
  }
  const currentHardCapacity = positiveInteger(
    current.account.hardCapacity,
    options.defaultHardCapacity ?? DEFAULT_HARD_CAPACITY,
  );
  if (current.account.activeTurns >= currentHardCapacity) {
    return { kind: "switch", accountId: selected.account.id, reason: "capacity", plan };
  }
  if (probeCandidates[0] && current.account.needsProbe !== true) {
    return { kind: "switch", accountId: selected.account.id, reason: "probe", plan };
  }

  const hysteresis = options.migrationHysteresisTurns ?? DEFAULT_MIGRATION_HYSTERESIS_TURNS;
  if (selected.deficitTurns - current.deficitTurns > hysteresis) {
    return { kind: "switch", accountId: selected.account.id, reason: "deficit", plan };
  }
  return { kind: "keep", accountId: current.account.id, reason: "affinity", plan };
}
