import {
  decideCodexQuotaRoute,
  effectiveCodexQuotaDeadline,
  type CodexQuotaAllocationAccount,
} from "../../src/codex/quota-allocation-model";

const BASE_TIME = 1_800_000_000_000;
const HOUR_MS = 3_600_000;
const LEGACY_BOOTSTRAP_URGENCY = 10_000;
const LEGACY_BUCKET_SIZE = 10;
const LEGACY_RELEASE_GAP = 1_000;

export type SimulationPolicy = "legacy" | "target";
export type SimulationResetSource = "weekly" | "monthly" | "manual" | "official";

export interface SimulationAccountSpec {
  id: string;
  plan?: string;
  usedPercent: number;
  weeklyResetAtHour?: number;
  weeklyPeriodHours?: number;
  monthlyResetAtHour?: number;
  monthlyPeriodHours?: number;
  resetCredits?: number;
  resetCreditExpiresAtHour?: number;
  officialResetAtHour?: number;
  hardCapacity?: number;
}

export interface SimulationTurnSpec {
  atHour: number;
  sessionId: string;
  durationHours: number;
  costPercent: number;
}

export interface SimulationResetEvent {
  atHour: number;
  source: SimulationResetSource;
  accountIds?: readonly string[];
}

export interface SimulationCreditExpiryEvent {
  atHour: number;
  source: "manual-expiry";
  accountId: string;
}

export interface SimulationHealthEvent {
  atHour: number;
  accountId: string;
  healthy: boolean;
}

export interface QuotaSimulationScenario {
  durationHours: number;
  observationLagHours?: number;
  accounts: readonly SimulationAccountSpec[];
  turns: readonly SimulationTurnSpec[];
  events?: readonly (SimulationResetEvent | SimulationCreditExpiryEvent | SimulationHealthEvent)[];
}

export interface QuotaSimulationMetrics {
  policy: SimulationPolicy;
  offeredTurns: number;
  completedTurns: number;
  pendingTurns: number;
  failed429: number;
  queuedTurns: number;
  maxQueueDepth: number;
  totalQueueWaitHours: number;
  affinitySwitches: number;
  speculativeAffinityReleases: number;
  capacityViolations: number;
  resetEpochs: number;
  unusedPercentAtReset: number;
  probeAssignments: Record<string, number>;
  probeCompletions: Record<string, number>;
  assignments: Record<string, number>;
  maxActiveTurns: Record<string, number>;
}

export interface QuotaSimulationResult {
  metrics: QuotaSimulationMetrics;
  trace: readonly string[];
}

interface AccountState {
  spec: SimulationAccountSpec;
  actualUsedPercent: number;
  observedUsedPercent: number;
  actualWeeklyResetAtHour?: number;
  observedWeeklyResetAtHour?: number;
  actualMonthlyResetAtHour?: number;
  observedMonthlyResetAtHour?: number;
  actualResetCredits: number;
  observedResetCredits: number;
  actualResetCreditExpiresAtHour?: number;
  observedResetCreditExpiresAtHour?: number;
  actualOfficialResetAtHour?: number;
  observedOfficialResetAtHour?: number;
  actualResetGeneration: number;
  observedResetGeneration: number;
  observationSequence: number;
  appliedObservationSequence: number;
  activeTurns: number;
  healthy: boolean;
  needsProbe: boolean;
  probeInFlightGeneration?: number;
  lastActualResetAtHour?: number;
}

interface QueuedTurn extends SimulationTurnSpec {
  queuedAtHour: number;
  countedAsQueued: boolean;
}

interface RunningTurn extends SimulationTurnSpec {
  accountId: string;
  probeGeneration?: number;
}

interface ObservationSnapshot {
  accountId: string;
  sequence: number;
  usedPercent: number;
  weeklyResetAtHour?: number;
  monthlyResetAtHour?: number;
  resetCredits: number;
  resetCreditExpiresAtHour?: number;
  officialResetAtHour?: number;
  resetGeneration: number;
}

type InternalEvent =
  | { atHour: number; order: number; kind: "arrival"; turn: SimulationTurnSpec }
  | { atHour: number; order: number; kind: "complete"; turn: RunningTurn }
  | { atHour: number; order: number; kind: "observe"; snapshot: ObservationSnapshot }
  | { atHour: number; order: number; kind: "reset"; event: SimulationResetEvent }
  | { atHour: number; order: number; kind: "manual-expiry"; event: SimulationCreditExpiryEvent }
  | { atHour: number; order: number; kind: "health"; event: SimulationHealthEvent };

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function atMs(hour: number): number {
  return BASE_TIME + hour * HOUR_MS;
}

function deadlineAt(hour: number | undefined): number | undefined {
  return hour === undefined ? undefined : atMs(hour);
}

function makeAccountState(spec: SimulationAccountSpec): AccountState {
  return {
    spec,
    actualUsedPercent: clampPercent(spec.usedPercent),
    observedUsedPercent: clampPercent(spec.usedPercent),
    actualWeeklyResetAtHour: spec.weeklyResetAtHour,
    observedWeeklyResetAtHour: spec.weeklyResetAtHour,
    actualMonthlyResetAtHour: spec.monthlyResetAtHour,
    observedMonthlyResetAtHour: spec.monthlyResetAtHour,
    actualResetCredits: Math.max(0, spec.resetCredits ?? 0),
    observedResetCredits: Math.max(0, spec.resetCredits ?? 0),
    actualResetCreditExpiresAtHour: spec.resetCreditExpiresAtHour,
    observedResetCreditExpiresAtHour: spec.resetCreditExpiresAtHour,
    actualOfficialResetAtHour: spec.officialResetAtHour,
    observedOfficialResetAtHour: spec.officialResetAtHour,
    actualResetGeneration: 0,
    observedResetGeneration: 0,
    observationSequence: 0,
    appliedObservationSequence: 0,
    activeTurns: 0,
    healthy: true,
    needsProbe: false,
  };
}

function allocationAccount(
  state: AccountState,
  affinities: number,
): CodexQuotaAllocationAccount {
  return {
    id: state.spec.id,
    plan: state.spec.plan ?? "pro",
    usedPercent: state.observedUsedPercent,
    weeklyResetAt: deadlineAt(state.observedWeeklyResetAtHour),
    monthlyResetAt: deadlineAt(state.observedMonthlyResetAtHour),
    resetCredits: state.observedResetCredits,
    resetCreditExpiresAt: deadlineAt(state.observedResetCreditExpiresAtHour),
    officialResetAt: deadlineAt(state.observedOfficialResetAtHour),
    activeTurns: state.activeTurns,
    affinityCount: affinities,
    healthy: state.healthy,
    needsProbe: state.needsProbe,
    probeInFlight: state.probeInFlightGeneration === state.observedResetGeneration,
    hardCapacity: state.spec.hardCapacity ?? 6,
  };
}

function legacyUrgency(state: AccountState, nowHour: number): number | null {
  const account = allocationAccount(state, 0);
  const deadline = effectiveCodexQuotaDeadline(account, atMs(nowHour));
  if (!deadline) return null;
  if (state.observedUsedPercent === 0) return LEGACY_BOOTSTRAP_URGENCY;
  return (100 - state.observedUsedPercent) * 144 / Math.max(deadline.hoursRemaining, 1);
}

function legacyBucket(state: AccountState, nowHour: number): number | null {
  const urgency = legacyUrgency(state, nowHour);
  return urgency === null ? null : Math.floor(urgency / LEGACY_BUCKET_SIZE) * LEGACY_BUCKET_SIZE;
}

function eventPriority(event: InternalEvent): number {
  switch (event.kind) {
    case "reset": return 0;
    case "manual-expiry": return 1;
    case "health": return 2;
    case "complete": return 3;
    case "observe": return 4;
    case "arrival": return 5;
  }
}

function sortEvents(events: InternalEvent[]): void {
  events.sort((left, right) => (
    left.atHour - right.atHour
    || eventPriority(left) - eventPriority(right)
    || left.order - right.order
  ));
}

export function runQuotaSimulation(
  scenario: QuotaSimulationScenario,
  policy: SimulationPolicy,
): QuotaSimulationResult {
  const states = new Map(scenario.accounts.map(spec => [spec.id, makeAccountState(spec)]));
  const affinities = new Map<string, string>();
  const pending: QueuedTurn[] = [];
  const events: InternalEvent[] = [];
  const trace: string[] = [];
  let nextOrder = 0;
  const lag = Math.max(0, scenario.observationLagHours ?? 0);
  const metrics: QuotaSimulationMetrics = {
    policy,
    offeredTurns: scenario.turns.length,
    completedTurns: 0,
    pendingTurns: 0,
    failed429: 0,
    queuedTurns: 0,
    maxQueueDepth: 0,
    totalQueueWaitHours: 0,
    affinitySwitches: 0,
    speculativeAffinityReleases: 0,
    capacityViolations: 0,
    resetEpochs: 0,
    unusedPercentAtReset: 0,
    probeAssignments: {},
    probeCompletions: {},
    assignments: {},
    maxActiveTurns: {},
  };

  const push = (event: Omit<InternalEvent, "order">) => {
    events.push({ ...event, order: nextOrder++ } as InternalEvent);
  };
  for (const turn of scenario.turns) push({ atHour: turn.atHour, kind: "arrival", turn });
  for (const event of scenario.events ?? []) {
    if (event.source === "manual-expiry") push({ atHour: event.atHour, kind: "manual-expiry", event });
    else if ("healthy" in event) push({ atHour: event.atHour, kind: "health", event });
    else push({ atHour: event.atHour, kind: "reset", event });
  }
  for (const state of states.values()) {
    const recurring: Array<{
      source: "weekly" | "monthly";
      first?: number;
      period?: number;
    }> = [
      { source: "weekly", first: state.spec.weeklyResetAtHour, period: state.spec.weeklyPeriodHours },
      { source: "monthly", first: state.spec.monthlyResetAtHour, period: state.spec.monthlyPeriodHours },
    ];
    for (const reset of recurring) {
      if (reset.first === undefined || reset.period === undefined || reset.period <= 0) continue;
      for (let atHour = reset.first; atHour <= scenario.durationHours; atHour += reset.period) {
        push({
          atHour,
          kind: "reset",
          event: { atHour, source: reset.source, accountIds: [state.spec.id] },
        });
      }
    }
  }

  const affinityCounts = (): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const accountId of affinities.values()) {
      counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
    }
    return counts;
  };

  const observedAccounts = () => {
    const counts = affinityCounts();
    return [...states.values()].map(state => allocationAccount(state, counts.get(state.spec.id) ?? 0));
  };

  const scheduleObservation = (state: AccountState, nowHour: number) => {
    const sequence = ++state.observationSequence;
    push({
      atHour: nowHour + lag,
      kind: "observe",
      snapshot: {
        accountId: state.spec.id,
        sequence,
        usedPercent: state.actualUsedPercent,
        weeklyResetAtHour: state.actualWeeklyResetAtHour,
        monthlyResetAtHour: state.actualMonthlyResetAtHour,
        resetCredits: state.actualResetCredits,
        resetCreditExpiresAtHour: state.actualResetCreditExpiresAtHour,
        officialResetAtHour: state.actualOfficialResetAtHour,
        resetGeneration: state.actualResetGeneration,
      },
    });
  };

  const legacySelect = (turn: SimulationTurnSpec, nowHour: number): string | null => {
    const affinedId = affinities.get(turn.sessionId);
    if (affinedId) {
      const affined = states.get(affinedId);
      if (affined && affined.healthy && affined.observedUsedPercent < 100) {
        return affined.activeTurns < (affined.spec.hardCapacity ?? 6) ? affinedId : null;
      }
      affinities.delete(turn.sessionId);
    }

    const counts = affinityCounts();
    const eligible = [...states.values()]
      .filter(state => state.healthy
        && state.observedUsedPercent < 100
        && state.activeTurns < (state.spec.hardCapacity ?? 6))
      .sort((left, right) => {
        const leftUrgency = legacyUrgency(left, nowHour);
        const rightUrgency = legacyUrgency(right, nowHour);
        if (leftUrgency !== null && rightUrgency !== null && leftUrgency !== rightUrgency) {
          return rightUrgency - leftUrgency;
        }
        if (leftUrgency === null && rightUrgency !== null) return 1;
        if (leftUrgency !== null && rightUrgency === null) return -1;
        return left.observedUsedPercent - right.observedUsedPercent || left.spec.id.localeCompare(right.spec.id);
      });
    if (eligible.length === 0) return null;
    const highestBucket = legacyBucket(eligible[0]!, nowHour);
    const highestBucketSize = eligible.filter(state => legacyBucket(state, nowHour) === highestBucket).length;
    const workingSet = eligible.slice(0, Math.max(3, highestBucketSize));
    workingSet.sort((left, right) => (
      left.activeTurns - right.activeTurns
      || (counts.get(left.spec.id) ?? 0) - (counts.get(right.spec.id) ?? 0)
      || left.spec.id.localeCompare(right.spec.id)
    ));
    return workingSet[0]!.spec.id;
  };

  const targetSelect = (turn: SimulationTurnSpec, nowHour: number): string | null => {
    const currentId = affinities.get(turn.sessionId) ?? null;
    const decision = decideCodexQuotaRoute(observedAccounts(), currentId, atMs(nowHour));
    return decision.kind === "queue" ? null : decision.accountId ?? null;
  };

  const tryStart = (turn: QueuedTurn, nowHour: number): boolean => {
    const previousAffinity = affinities.get(turn.sessionId);
    let accountId = policy === "legacy"
      ? legacySelect(turn, nowHour)
      : targetSelect(turn, nowHour);
    if (!accountId) return false;

    let state = states.get(accountId)!;
    if (state.actualUsedPercent >= 100) {
      metrics.failed429 += 1;
      state.observedUsedPercent = 100;
      if (affinities.get(turn.sessionId) === accountId) affinities.delete(turn.sessionId);
      accountId = policy === "legacy" ? legacySelect(turn, nowHour) : targetSelect(turn, nowHour);
      if (!accountId) return false;
      state = states.get(accountId)!;
    }

    const hardCapacity = state.spec.hardCapacity ?? 6;
    if (state.activeTurns >= hardCapacity) return false;
    state.activeTurns += 1;
    if (state.activeTurns > hardCapacity) metrics.capacityViolations += 1;
    metrics.maxActiveTurns[accountId] = Math.max(metrics.maxActiveTurns[accountId] ?? 0, state.activeTurns);
    metrics.assignments[accountId] = (metrics.assignments[accountId] ?? 0) + 1;
    if (previousAffinity && previousAffinity !== accountId) metrics.affinitySwitches += 1;
    affinities.set(turn.sessionId, accountId);
    if (turn.countedAsQueued) metrics.totalQueueWaitHours += nowHour - turn.queuedAtHour;
    // Gateway quota observations arrive with upstream response headers, before a
    // streamed turn completes. Charging here keeps long turns in the reset epoch
    // where they were admitted instead of moving their cost to completion time.
    state.actualUsedPercent = clampPercent(state.actualUsedPercent + Math.max(0, turn.costPercent));
    scheduleObservation(state, nowHour);

    const probeGeneration = policy === "target"
      && state.needsProbe
      && state.probeInFlightGeneration !== state.observedResetGeneration
      ? state.observedResetGeneration
      : undefined;
    if (probeGeneration !== undefined) {
      state.probeInFlightGeneration = probeGeneration;
      metrics.probeAssignments[accountId] = (metrics.probeAssignments[accountId] ?? 0) + 1;
    }
    push({
      atHour: nowHour + Math.max(0, turn.durationHours),
      kind: "complete",
      turn: { ...turn, accountId, probeGeneration },
    });
    trace.push(
      `${nowHour.toFixed(3)} start ${turn.sessionId} -> ${accountId}`
      + (probeGeneration !== undefined ? ` probe:${probeGeneration}` : ""),
    );
    return true;
  };

  const enqueue = (turn: SimulationTurnSpec, nowHour: number) => {
    pending.push({ ...turn, queuedAtHour: nowHour, countedAsQueued: true });
    metrics.queuedTurns += 1;
    metrics.maxQueueDepth = Math.max(metrics.maxQueueDepth, pending.length);
    trace.push(`${nowHour.toFixed(3)} queue ${turn.sessionId}`);
  };

  const drainQueue = (nowHour: number) => {
    for (let index = 0; index < pending.length;) {
      if (tryStart(pending[index]!, nowHour)) pending.splice(index, 1);
      else index += 1;
    }
  };

  const legacyRelease = (turn: RunningTurn, nowHour: number) => {
    if (affinities.get(turn.sessionId) !== turn.accountId) return;
    const eligible = [...states.values()]
      .filter(state => state.healthy && state.observedUsedPercent < 100)
      .sort((left, right) => (legacyUrgency(right, nowHour) ?? -1) - (legacyUrgency(left, nowHour) ?? -1));
    const highest = eligible[0] ? legacyBucket(eligible[0], nowHour) : null;
    const current = legacyBucket(states.get(turn.accountId)!, nowHour);
    if (highest !== null && current !== null && highest - current > LEGACY_RELEASE_GAP) {
      affinities.delete(turn.sessionId);
      metrics.speculativeAffinityReleases += 1;
      trace.push(`${nowHour.toFixed(3)} release ${turn.sessionId} from ${turn.accountId}`);
    }
  };

  const applyReset = (event: SimulationResetEvent, nowHour: number) => {
    const accountIds = event.accountIds ?? [...states.keys()];
    for (const accountId of accountIds) {
      const state = states.get(accountId);
      if (!state) continue;
      if (event.source === "manual" && state.actualResetCredits <= 0) {
        trace.push(`${nowHour.toFixed(3)} reject manual reset ${accountId}`);
        continue;
      }
      const sameEpoch = state.lastActualResetAtHour === nowHour;
      if (!sameEpoch) {
        metrics.unusedPercentAtReset += Math.max(0, 100 - state.actualUsedPercent);
        metrics.resetEpochs += 1;
        state.actualUsedPercent = 0;
        state.actualResetGeneration += 1;
        state.lastActualResetAtHour = nowHour;
      }
      if (event.source === "manual" && state.actualResetCredits > 0) {
        state.actualResetCredits -= 1;
        if (state.actualResetCredits === 0) state.actualResetCreditExpiresAtHour = undefined;
      } else if (event.source === "weekly" && state.spec.weeklyPeriodHours) {
        state.actualWeeklyResetAtHour = nowHour + state.spec.weeklyPeriodHours;
      } else if (event.source === "monthly" && state.spec.monthlyPeriodHours) {
        state.actualMonthlyResetAtHour = nowHour + state.spec.monthlyPeriodHours;
      } else if (event.source === "official") {
        state.actualOfficialResetAtHour = undefined;
      }
      scheduleObservation(state, nowHour);
      trace.push(`${nowHour.toFixed(3)} reset ${event.source} ${accountId}${sameEpoch ? " coalesced" : ""}`);
    }
  };

  sortEvents(events);
  while (events.length > 0) {
    const event = events.shift()!;
    if (event.atHour > scenario.durationHours) break;
    switch (event.kind) {
      case "arrival": {
        const queued: QueuedTurn = { ...event.turn, queuedAtHour: event.atHour, countedAsQueued: false };
        if (!tryStart(queued, event.atHour)) enqueue(event.turn, event.atHour);
        break;
      }
      case "complete": {
        const state = states.get(event.turn.accountId)!;
        state.activeTurns = Math.max(0, state.activeTurns - 1);
        metrics.completedTurns += 1;
        if (event.turn.probeGeneration !== undefined) {
          if (state.probeInFlightGeneration === event.turn.probeGeneration) {
            state.probeInFlightGeneration = undefined;
          }
          if (event.turn.probeGeneration === state.observedResetGeneration) {
            state.needsProbe = false;
            metrics.probeCompletions[state.spec.id] = (metrics.probeCompletions[state.spec.id] ?? 0) + 1;
          }
        }
        if (policy === "legacy") legacyRelease(event.turn, event.atHour);
        trace.push(`${event.atHour.toFixed(3)} complete ${event.turn.sessionId} @ ${event.turn.accountId}`);
        drainQueue(event.atHour);
        break;
      }
      case "observe": {
        const state = states.get(event.snapshot.accountId)!;
        if (event.snapshot.sequence < state.appliedObservationSequence) break;
        state.appliedObservationSequence = event.snapshot.sequence;
        state.observedUsedPercent = event.snapshot.usedPercent;
        state.observedWeeklyResetAtHour = event.snapshot.weeklyResetAtHour;
        state.observedMonthlyResetAtHour = event.snapshot.monthlyResetAtHour;
        state.observedResetCredits = event.snapshot.resetCredits;
        state.observedResetCreditExpiresAtHour = event.snapshot.resetCreditExpiresAtHour;
        state.observedOfficialResetAtHour = event.snapshot.officialResetAtHour;
        if (event.snapshot.resetGeneration > state.observedResetGeneration) {
          state.observedResetGeneration = event.snapshot.resetGeneration;
          if (policy === "target") {
            state.needsProbe = true;
          }
        }
        drainQueue(event.atHour);
        break;
      }
      case "reset":
        applyReset(event.event, event.atHour);
        drainQueue(event.atHour);
        break;
      case "manual-expiry": {
        const state = states.get(event.event.accountId);
        if (!state) break;
        state.actualResetCredits = 0;
        state.actualResetCreditExpiresAtHour = undefined;
        scheduleObservation(state, event.atHour);
        trace.push(`${event.atHour.toFixed(3)} manual credit expired ${state.spec.id}`);
        break;
      }
      case "health": {
        const state = states.get(event.event.accountId);
        if (!state) break;
        state.healthy = event.event.healthy;
        if (!state.healthy) {
          for (const [sessionId, accountId] of affinities) {
            if (accountId === state.spec.id) affinities.delete(sessionId);
          }
        }
        drainQueue(event.atHour);
        break;
      }
    }
    sortEvents(events);
  }

  metrics.pendingTurns = pending.length
    + events.filter(event => event.kind === "arrival" || event.kind === "complete").length;
  return { metrics, trace };
}
