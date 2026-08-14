import { createHash } from "node:crypto";
import type { OcxProviderConfig } from "../types";
import { getKeyCooldownUntil } from "./key-failover";

const QUOTA_CACHE_TTL_MS = 60_000;
const AFFINITY_TTL_MS = 6 * 60 * 60_000;
const MAX_AFFINITIES_PER_PROVIDER = 4_096;
const QUOTA_REQUEST_TIMEOUT_MS = 3_000;

interface QuotaSnapshot {
  fetchedAt: number;
  usedPercent?: number;
  resetAt?: number;
}

interface AffinityEntry {
  keyId: string;
  touchedAt: number;
}

interface ProviderPoolState {
  affinities: Map<string, AffinityEntry>;
  quotas: Map<string, QuotaSnapshot>;
  quotaRefreshes: Map<string, Promise<void>>;
  cursor: number;
}

const states = new Map<string, ProviderPoolState>();

function stateFor(providerName: string): ProviderPoolState {
  let state = states.get(providerName);
  if (!state) {
    state = {
      affinities: new Map(),
      quotas: new Map(),
      quotaRefreshes: new Map(),
      cursor: 0,
    };
    states.set(providerName, state);
  }
  return state;
}

function affinityId(providerName: string, affinity: string): string {
  return createHash("sha256").update(providerName).update("\0").update(affinity).digest("hex").slice(0, 32);
}

function quotaEndpoint(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "open.bigmodel.cn" && url.pathname.startsWith("/api/coding/paas/v4")) {
      return "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
    }
    if (url.hostname === "api.z.ai" && url.pathname.startsWith("/api/coding/paas/v4")) {
      return "https://api.z.ai/api/monitor/usage/quota/limit";
    }
  } catch {
    // Invalid or user-defined destinations have no trusted quota endpoint.
  }
  return null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseFiveHourQuota(payload: unknown, fetchedAt: number): QuotaSnapshot {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const data = body?.data && typeof body.data === "object" ? body.data as Record<string, unknown> : null;
  const limits = Array.isArray(data?.limits) ? data.limits : [];
  for (const raw of limits) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (String(row.type).toUpperCase() !== "TOKENS_LIMIT") continue;
    const unit = finiteNumber(row.unit);
    const number = finiteNumber(row.number);
    if (unit !== 3 || number !== 5) continue;
    const percent = finiteNumber(row.percentage);
    const resetAt = finiteNumber(row.nextResetTime);
    return {
      fetchedAt,
      ...(percent !== undefined ? { usedPercent: Math.min(100, Math.max(0, percent)) } : {}),
      ...(resetAt !== undefined ? { resetAt: resetAt > 10_000_000_000 ? resetAt : resetAt * 1_000 } : {}),
    };
  }
  return { fetchedAt };
}

async function refreshQuota(
  provider: OcxProviderConfig,
  entry: NonNullable<OcxProviderConfig["apiKeyPool"]>[number],
  state: ProviderPoolState,
  now: number,
  fetchImpl: typeof fetch,
): Promise<void> {
  const cached = state.quotas.get(entry.id);
  if (cached && now - cached.fetchedAt < QUOTA_CACHE_TTL_MS) return;
  const existing = state.quotaRefreshes.get(entry.id);
  if (existing) return existing;
  const endpoint = quotaEndpoint(provider.baseUrl);
  if (!endpoint) {
    state.quotas.set(entry.id, { fetchedAt: now });
    return;
  }
  const refresh = (async () => {
    try {
      const response = await fetchImpl(endpoint, {
        headers: { Accept: "application/json", Authorization: `Bearer ${entry.key}` },
        redirect: "error",
        signal: AbortSignal.timeout(QUOTA_REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        state.quotas.set(entry.id, { fetchedAt: now });
        return;
      }
      state.quotas.set(entry.id, parseFiveHourQuota(await response.json().catch(() => null), now));
    } catch {
      state.quotas.set(entry.id, { fetchedAt: now });
    }
  })().finally(() => state.quotaRefreshes.delete(entry.id));
  state.quotaRefreshes.set(entry.id, refresh);
  await refresh;
}

function sweepState(state: ProviderPoolState, validKeyIds: Set<string>, now: number): void {
  for (const [id, affinity] of state.affinities) {
    if (!validKeyIds.has(affinity.keyId) || now - affinity.touchedAt >= AFFINITY_TTL_MS) {
      state.affinities.delete(id);
    }
  }
  for (const id of state.quotas.keys()) {
    if (!validKeyIds.has(id)) state.quotas.delete(id);
  }
  while (state.affinities.size > MAX_AFFINITIES_PER_PROVIDER) {
    const oldest = state.affinities.keys().next().value as string | undefined;
    if (!oldest) break;
    state.affinities.delete(oldest);
  }
}

function affinityCounts(state: ProviderPoolState): Map<string, number> {
  const counts = new Map<string, number>();
  for (const affinity of state.affinities.values()) {
    counts.set(affinity.keyId, (counts.get(affinity.keyId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Select one key for a request without mutating the persisted active key. Balanced
 * pools keep a conversation sticky, then use five-hour quota and active-affinity
 * counts to distribute new conversations. Any quota failure degrades to balancing.
 */
export async function balanceProviderApiKey(
  providerName: string,
  provider: OcxProviderConfig,
  affinity: string | null | undefined,
  options: { now?: number; fetchImpl?: typeof fetch } = {},
): Promise<OcxProviderConfig> {
  if (provider.apiKeyPoolStrategy !== "balanced") return provider;
  if (provider.authMode === "oauth" || provider.authMode === "forward") return provider;
  const pool = provider.apiKeyPool?.filter(entry => entry.id && entry.key) ?? [];
  if (pool.length < 2) return provider;

  const now = options.now ?? Date.now();
  const state = stateFor(providerName);
  const validKeyIds = new Set(pool.map(entry => entry.id));
  sweepState(state, validKeyIds, now);
  await Promise.all(pool.map(entry => refreshQuota(
    provider,
    entry,
    state,
    now,
    options.fetchImpl ?? fetch,
  )));

  const id = affinity?.trim() ? affinityId(providerName, affinity.trim()) : null;
  const pinned = id ? state.affinities.get(id) : undefined;
  if (pinned) {
    const entry = pool.find(candidate => candidate.id === pinned.keyId);
    const quota = entry ? state.quotas.get(entry.id) : undefined;
    if (entry && getKeyCooldownUntil(providerName, entry.id, now) === null && (quota?.usedPercent ?? 0) < 100) {
      pinned.touchedAt = now;
      state.affinities.delete(id!);
      state.affinities.set(id!, pinned);
      return { ...provider, apiKey: entry.key };
    }
    state.affinities.delete(id!);
  }

  const healthy = pool.filter(entry => getKeyCooldownUntil(providerName, entry.id, now) === null);
  const candidates = healthy.filter(entry => (state.quotas.get(entry.id)?.usedPercent ?? 0) < 100);
  const eligible = candidates.length > 0 ? candidates : healthy.length > 0 ? healthy : pool;
  const allQuotaKnown = eligible.every(entry => state.quotas.get(entry.id)?.usedPercent !== undefined);
  const counts = affinityCounts(state);
  const remainingQuota = (entry: (typeof eligible)[number]): number => allQuotaKnown
    ? Math.max(0.01, 100 - state.quotas.get(entry.id)!.usedPercent!)
    : 1;
  const score = (entry: (typeof eligible)[number]): number => {
    return (counts.get(entry.id) ?? 0) / remainingQuota(entry);
  };
  const minimumScore = Math.min(...eligible.map(score));
  const leastLoaded = eligible.filter(entry => Math.abs(score(entry) - minimumScore) < 1e-12);
  const maximumRemaining = Math.max(...leastLoaded.map(remainingQuota));
  const bestCapacity = leastLoaded.filter(entry => remainingQuota(entry) === maximumRemaining);
  const selected = bestCapacity[state.cursor % bestCapacity.length]!;
  state.cursor = (state.cursor + 1) % Number.MAX_SAFE_INTEGER;
  if (id) state.affinities.set(id, { keyId: selected.id, touchedAt: now });
  return { ...provider, apiKey: selected.key };
}

export function clearApiKeyBalancerState(providerName?: string): void {
  if (providerName) states.delete(providerName);
  else states.clear();
}

export function apiKeyQuotaSnapshotForTests(providerName: string, keyId: string): QuotaSnapshot | null {
  return states.get(providerName)?.quotas.get(keyId) ?? null;
}

export function reconcileApiKeyBalancerProviders(providerNames: ReadonlySet<string>): number {
  let removed = 0;
  for (const providerName of states.keys()) {
    if (providerNames.has(providerName)) continue;
    states.delete(providerName);
    removed += 1;
  }
  return removed;
}
