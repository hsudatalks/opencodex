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
import { getAccountSet, getAccountCredential } from "./store";

const PROVIDER = "command-code";
const AFFINITY_TTL_MS = 6 * 60 * 60_000;
const MAX_AFFINITY_ENTRIES = 4_096;
const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

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
  return set.accounts
    .filter(account => account.needsReauth !== true && !isCooled(account.id, now))
    .filter(account => Boolean(getAccountCredential(PROVIDER, account.id)))
    .map(account => account.id);
}

function usageScore(accountId: string): number {
  const quota = getCachedProviderAccountQuota(PROVIDER, accountId);
  if (!quota) return Number.POSITIVE_INFINITY;
  const values = [quota.fiveHourPercent, quota.weeklyPercent]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
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
  cooldownUntil.set(currentAccountId, now + delay);
  if (sessionKey?.trim()) sessionAffinity.delete(affinityKey(sessionKey.trim()));
  const next = eligibleAccounts(now).filter(accountId => accountId !== currentAccountId);
  if (!next.length) return null;
  const selected = next[cursor++ % next.length]!;
  remember(sessionKey?.trim() || null, selected, now);
  return selected;
}

export function commandCodeAccountPoolHealthForTests(now = Date.now()): { affinityCount: number; cooledAccountIds: string[] } {
  return {
    affinityCount: sessionAffinity.size,
    cooledAccountIds: [...cooldownUntil].filter(([, until]) => until > now).map(([accountId]) => accountId),
  };
}
