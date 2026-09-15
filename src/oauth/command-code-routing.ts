/**
 * Command Code OAuth account pool.
 *
 * Uses per-account official quota when available, but never blocks a request on
 * the quota service. Missing/stale quota falls back to deterministic rotation;
 * 429 responses cool the account and permit one bounded same-request failover.
 */
import { createHash } from "node:crypto";
import type { OcxAccountPoolRotationStrategy, OcxConfig } from "../types";
import { getCachedProviderAccountQuota } from "../providers/quota";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { getAccountSet, getAccountCredential } from "./store";

const PROVIDER = "command-code";
const AFFINITY_TTL_MS = 6 * 60 * 60_000;
const MAX_AFFINITY_ENTRIES = 4_096;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
/** At or above this usage a budget is spent and the account cannot serve a request. */
const EXHAUSTED_PERCENT = 100;
/** Bounded scan for the spend rejection; the upstream prefixes it with a JSON error object. */
const INSUFFICIENT_CREDITS_MESSAGE = /insufficient credits/i;
const MAX_CREDITS_BODY_SCAN = 512;

interface AffinityEntry { accountId: string; touchedAt: number }
const sessionAffinity = new Map<string, AffinityEntry>();
const cooldownUntil = new Map<string, number>();
let cursor = 0;

export interface CommandCodeAccountPoolConfig {
  enabled?: boolean;
  strategy?: OcxAccountPoolRotationStrategy;
}

export function commandCodeAccountPoolConfig(config: OcxConfig): CommandCodeAccountPoolConfig {
  return config.commandCodeAccountPool && typeof config.commandCodeAccountPool === "object"
    ? config.commandCodeAccountPool
    : {};
}

export function isCommandCodeAccountPoolEnabled(config: OcxConfig): boolean {
  return commandCodeAccountPoolConfig(config).enabled !== false;
}

function strategyFor(config: OcxConfig): OcxAccountPoolRotationStrategy {
  const strategy = commandCodeAccountPoolConfig(config).strategy;
  return strategy === "round-robin" || strategy === "fill-first" ? strategy : "quota";
}

function affinityKey(value: string): string {
  return createHash("sha256").update(PROVIDER).update("\0").update(value).digest("hex");
}

function isCooled(accountId: string, now: number): boolean {
  const until = cooldownUntil.get(accountId) ?? 0;
  if (until > now) return true;
  if (until) cooldownUntil.delete(accountId);
  return false;
}

function eligibleAccounts(now: number): string[] {
  const set = getAccountSet(PROVIDER);
  if (!set) return [];
  const usable = set.accounts
    .filter(account => account.needsReauth !== true && !isCooled(account.id, now))
    .filter(account => Boolean(getAccountCredential(PROVIDER, account.id)))
    .map(account => account.id);
  // Prefer accounts that still have headroom. Never return an empty pool: when every account is
  // spent the caller must still attempt one and surface the upstream's own error, rather than
  // failing the request locally with nothing to report.
  const withHeadroom = usable.filter(accountId => usageScore(accountId) < EXHAUSTED_PERCENT);
  return withHeadroom.length ? withHeadroom : usable;
}

/**
 * Highest known usage for an account across every budget it reports: the five-hour and weekly
 * windows and the monthly credit balance.
 *
 * Credits are not interchangeable with the windows. An account can sit at 33% of its weekly window
 * and still be unable to serve a single request because its credit balance is spent, so reading
 * only the windows is what let a spent account keep taking half the traffic. Infinity means
 * "nothing known", which keeps an unprobed account selectable.
 */
function usageScore(accountId: string): number {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  if (!quota) return Number.POSITIVE_INFINITY;
  const credits = quota.creditsUsd;
  const values = [
    quota.fiveHourPercent,
    quota.weeklyPercent,
    quota.monthlyPercent,
    credits && credits.unlimited !== true ? credits.percent : undefined,
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length ? Math.max(...values) : Number.POSITIVE_INFINITY;
}

function remember(key: string | null, accountId: string, now: number): void {
  if (!key) return;
  if (sessionAffinity.size >= MAX_AFFINITY_ENTRIES) {
    const oldest = [...sessionAffinity.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (oldest) sessionAffinity.delete(oldest[0]);
  }
  sessionAffinity.set(affinityKey(key), { accountId, touchedAt: now });
}

export function clearCommandCodeAccountPoolState(): void {
  sessionAffinity.clear();
  cooldownUntil.clear();
  cursor = 0;
}

export function resolveCommandCodeAccountForSession(
  sessionKey: string | null | undefined,
  config: OcxConfig,
  now = Date.now(),
): { accountId: string | null; reason: string } {
  const eligible = eligibleAccounts(now);
  if (!eligible.length) return { accountId: null, reason: "no-eligible-account" };
  if (!isCommandCodeAccountPoolEnabled(config) || eligible.length === 1) {
    return { accountId: eligible[0]!, reason: eligible.length === 1 ? "single-account" : "pool-disabled" };
  }
  const key = sessionKey?.trim() ? affinityKey(sessionKey.trim()) : null;
  if (key) {
    const bound = sessionAffinity.get(key);
    if (bound && now - bound.touchedAt < AFFINITY_TTL_MS && eligible.includes(bound.accountId)) {
      bound.touchedAt = now;
      return { accountId: bound.accountId, reason: "session-affinity" };
    }
    if (bound) sessionAffinity.delete(key);
  }
  const strategy = strategyFor(config);
  let candidates = eligible;
  if (strategy === "fill-first") candidates = eligible.slice(0, 1);
  if (strategy === "quota") {
    const scored = eligible.map(accountId => ({ accountId, score: usageScore(accountId) }));
    const known = scored.filter(row => Number.isFinite(row.score)).sort((a, b) => a.score - b.score);
    if (known.length) candidates = known.map(row => row.accountId);
  }
  const selected = candidates[cursor++ % candidates.length]!;
  remember(sessionKey?.trim() || null, selected, now);
  return {
    accountId: selected,
    reason: strategy === "quota" && Number.isFinite(usageScore(selected)) ? "lowest-known-quota" : strategy,
  };
}

export async function getCommandCodePoolAccessToken(accountId: string): Promise<string> {
  const { getValidAccessTokenForAccount } = await import("./index");
  return getValidAccessTokenForAccount(PROVIDER, accountId);
}

/** Cool the failed account and select a peer to retry on, or null when no peer is left. */
function coolAndSelectPeer(
  currentAccountId: string,
  delayMs: number,
  sessionKey: string | null | undefined,
  now: number,
): string | null {
  cooldownUntil.set(currentAccountId, now + delayMs);
  if (sessionKey?.trim()) sessionAffinity.delete(affinityKey(sessionKey.trim()));
  const next = eligibleAccounts(now).filter(accountId => accountId !== currentAccountId);
  if (!next.length) return null;
  const selected = next[cursor++ % next.length]!;
  remember(sessionKey?.trim() || null, selected, now);
  return selected;
}

export function rotateCommandCodeAccountOn429(
  currentAccountId: string,
  retryAfter: string | null | undefined,
  sessionKey: string | null | undefined,
  now = Date.now(),
): string | null {
  const seconds = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : NaN;
  const delay = Number.isFinite(seconds)
    ? Math.min(MAX_COOLDOWN_MS, Math.max(1_000, Math.ceil(seconds * 1_000)))
    : DEFAULT_COOLDOWN_MS;
  return coolAndSelectPeer(currentAccountId, delay, sessionKey, now);
}

/**
 * Cool an account the upstream refused for lack of credits, and select a peer.
 *
 * Credit exhaustion is a billing state rather than a transient rate limit: the account cannot serve
 * another request until credits are added or the billing period rolls over, and the upstream sends
 * no `Retry-After` for it. This therefore cools for the maximum window instead of the 429 default,
 * which turns a permanently spent account into one refused request per cooldown rather than half of
 * every request.
 */
export function rotateCommandCodeAccountOnInsufficientCredits(
  currentAccountId: string,
  sessionKey: string | null | undefined,
  now = Date.now(),
): string | null {
  return coolAndSelectPeer(currentAccountId, MAX_COOLDOWN_MS, sessionKey, now);
}

/**
 * True when Command Code refused the request because the account is out of credits.
 *
 * The upstream reports this as `400 BAD_REQUEST` carrying "You have insufficient credits to make
 * this request" — not `429` and not `402` — so a status-only failover test never fires and the spent
 * account keeps serving every request routed to it. The scan is bounded and clones the body, so the
 * caller can still forward the original error when no peer account is available.
 */
export async function isCommandCodeInsufficientCreditsResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<boolean> {
  if (response.status !== 400) return false;
  try {
    const body = await readBoundedResponseBody(response.clone(), {
      ...(signal !== undefined ? { signal } : {}),
      maxBytes: MAX_CREDITS_BODY_SCAN,
    });
    if (!body.displaySafe || body.truncated) return false;
    return INSUFFICIENT_CREDITS_MESSAGE.test(body.text);
  } catch {
    return false;
  }
}

export function commandCodeAccountPoolHealthForTests(now = Date.now()): { affinityCount: number; cooledAccountIds: string[] } {
  return {
    affinityCount: sessionAffinity.size,
    cooledAccountIds: [...cooldownUntil].filter(([, until]) => until > now).map(([accountId]) => accountId),
  };
}
