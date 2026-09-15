/**
 * Background quota tracking for pooled credentials.
 *
 * Account and key selection read CACHED quotas: it never probes upstream inline, so a pool whose
 * numbers were never fetched has nothing to score and cannot apply its headroom cut-off. Only the
 * dashboard populated these caches — which meant the protection that keeps a drained account out of
 * rotation depended on somebody having the GUI open.
 *
 * This refreshes them on the state-store sweep tick, throttled, so the five-hour, weekly and monthly
 * limits that gate selection stay current while the proxy is idle. It is best-effort throughout: a
 * failed probe degrades to the existing "unknown quota" behaviour and never blocks a request or the
 * sweep.
 */
import type { OcxConfig, OcxProviderConfig } from "../types";
import { registerStateSweepAfterTick } from "../lib/state-store-sweeper";
import { getAccountSet } from "../oauth/store";
import { fetchProviderAccountQuotas, supportsPerAccountQuota } from "./quota";
import { refreshProviderApiKeyQuotas } from "./api-key-balancer";

/**
 * Refresh cadence. The quota endpoints are cheap metadata reads (a handful of calls per credential),
 * and five minutes is well inside the window in which a budget crosses the cut-off.
 */
export const POOL_QUOTA_TRACK_INTERVAL_MS = 5 * 60_000;

let lastRunAt = 0;
let inFlight: Promise<void> | null = null;

/** Test-only: reset the throttle so a scheduled run can be replayed. */
export function resetPoolQuotaTrackerStateForTests(): void {
  lastRunAt = 0;
  inFlight = null;
}

/** Account pools worth tracking: an enabled OAuth pool with a peer to switch to. */
function trackedAccountPoolProviders(config: OcxConfig): string[] {
  const names: string[] = [];
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    if (!provider || provider.disabled === true) continue;
    if (provider.authMode !== "oauth" || !supportsPerAccountQuota(name)) continue;
    // Only poll a pool that is actually routing across accounts. The Anthropic pool is opt-in, and
    // polling its usage endpoint in the background for an operator who never enabled it would be
    // work they did not ask for.
    const poolEnabled = name === "command-code"
      ? config.commandCodeAccountPool?.enabled !== false
      : config.anthropicAccountPool?.enabled === true;
    if (!poolEnabled) continue;
    // A single account has no peer to move to, so its quota cannot change a routing decision;
    // the dashboard still probes it on demand.
    const set = getAccountSet(name);
    if (!set || set.accounts.length < 2) continue;
    names.push(name);
  }
  return names;
}

/** Balanced API-key pools: selection is scored by each key's own remaining quota. */
function trackedKeyPoolProviders(config: OcxConfig): Array<[string, OcxProviderConfig]> {
  const entries: Array<[string, OcxProviderConfig]> = [];
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    if (!provider || provider.disabled === true) continue;
    if (provider.apiKeyPoolStrategy !== "balanced") continue;
    if (provider.authMode === "oauth" || provider.authMode === "forward") continue;
    if ((provider.apiKeyPool?.filter(entry => entry.id && entry.key).length ?? 0) < 2) continue;
    entries.push([name, provider]);
  }
  return entries;
}

/**
 * One tracking pass. Exposed so a caller (or a test) can force a refresh without waiting for the
 * sweep tick; `force` propagates to the probes and bypasses their cache TTLs.
 */
export async function runPoolQuotaTrack(config: OcxConfig, now = Date.now()): Promise<void> {
  const tasks: Array<Promise<unknown>> = [];
  for (const name of trackedAccountPoolProviders(config)) {
    // forceRefresh: the point of the tracker is freshness, so it must not be a cache read.
    tasks.push(fetchProviderAccountQuotas(name, true).catch(() => []));
  }
  for (const [name, provider] of trackedKeyPoolProviders(config)) {
    tasks.push(refreshProviderApiKeyQuotas(name, provider, { now, force: true }).catch(() => 0));
  }
  await Promise.all(tasks);
}

/**
 * One scheduler-driven tick: refresh when the interval has elapsed and no run is already in flight.
 * Returns null when the tick was skipped, which is what bounds upstream calls to one pass per
 * interval regardless of how often the sweep fires.
 */
export function runPoolQuotaTrackerTick(config: OcxConfig, now = Date.now()): Promise<void> | null {
  if (inFlight) return null;
  if (now - lastRunAt < POOL_QUOTA_TRACK_INTERVAL_MS) return null;
  lastRunAt = now;
  inFlight = runPoolQuotaTrack(config, now)
    .catch(() => {
      // Best-effort: selection keeps whatever the caches already hold.
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Register the tracker on the sweep tick. Idempotent per registration name. */
export function registerPoolQuotaTrackerWorker(config: OcxConfig): void {
  registerStateSweepAfterTick({
    name: "pool-quota-tracker",
    afterTick: () => { void runPoolQuotaTrackerTick(config); },
  });
}
