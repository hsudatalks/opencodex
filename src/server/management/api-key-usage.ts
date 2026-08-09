import {
  currentUsageLedgerRevision,
  readUsageSnapshotForManagement,
  usageLogRevisionKey,
  type PersistedUsageEntry,
} from "../../usage/log";
import type { SQL } from "bun";
import { USAGE_DIMENSION_KIND, usagePostgresClient } from "../../usage/postgres-ingest";

/**
 * Per-key usage as the API tab renders it.
 *
 * A discriminated union rather than numbers with a flag beside them: when two
 * config entries share an id there IS no per-key total, and an optional marker
 * next to `requests7d: 7` invites a consumer to render the 7 anyway.
 */
export type ApiKeyUsage =
  | { ambiguous: true }
  | { ambiguous?: false; requests7d: number; totalRequests: number; lastUsedAt?: string };

export interface ApiKeyUsageSnapshot {
  rollup: Map<string, ApiKeyUsage>;
  historyTruncated?: true;
  /**
   * Earliest row carrying a recognized `admissionKind`. A property of the DATA
   * SET, not of a key, so it is singular and lives beside the map: it is what
   * lets the GUI tell "this key was used zero times" from "nothing is
   * attributable yet". Keyed on the kind rather than on `apiKeyId`, because an
   * environment or loopback row is attributed traffic with no configured key.
   */
  attributionSince?: string;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A timestamp we can actually do date arithmetic with.
 *
 * `usage.jsonl` is hand-editable and JSON permits numbers outside the Date
 * range: `1e309` survives normalization and then throws `RangeError` from
 * `toISOString()`. Since the caller catches to protect key management, one bad
 * row would have zeroed the rollup for EVERY key — active keys reported as
 * unused is exactly the wrong answer to hand someone deciding what to delete.
 */
function usableTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

/**
 * Pure: one pass over an already-read snapshot, so it is unit-testable without
 * touching the filesystem.
 *
 * Rows are bucketed only when `admissionKind === "configured"`. Keying on
 * `apiKeyId` alone would let a hand-edited entry whose id is `loopback` absorb
 * traffic it never admitted.
 */
export function rollupApiKeyUsage(
  entries: PersistedUsageEntry[],
  configuredIds: string[],
  now: number = Date.now(),
): ApiKeyUsageSnapshot {
  const duplicated = new Set<string>();
  const seen = new Set<string>();
  for (const id of configuredIds) {
    if (seen.has(id)) duplicated.add(id);
    seen.add(id);
  }

  const totals = new Map<string, { requests7d: number; totalRequests: number; lastUsedAt?: string }>();
  let attributionSince: number | undefined;
  const cutoff = now - SEVEN_DAYS_MS;

  for (const entry of entries) {
    if (!entry.admissionKind) continue;
    const timestamp = usableTimestamp(entry.timestamp);
    if (timestamp !== null && (attributionSince === undefined || timestamp < attributionSince)) {
      attributionSince = timestamp;
    }
    if (entry.admissionKind !== "configured" || !entry.apiKeyId) continue;

    const bucket = totals.get(entry.apiKeyId) ?? { requests7d: 0, totalRequests: 0 };
    // The request happened even if its clock reading is unusable, so it still
    // counts toward the total; only the time-based fields are skipped.
    bucket.totalRequests += 1;
    if (timestamp !== null) {
      if (timestamp >= cutoff) bucket.requests7d += 1;
      const iso = new Date(timestamp).toISOString();
      if (!bucket.lastUsedAt || iso > bucket.lastUsedAt) bucket.lastUsedAt = iso;
    }
    totals.set(entry.apiKeyId, bucket);
  }

  const rollup = new Map<string, ApiKeyUsage>();
  for (const id of configuredIds) {
    if (duplicated.has(id)) {
      rollup.set(id, { ambiguous: true });
      continue;
    }
    rollup.set(id, totals.get(id) ?? { requests7d: 0, totalRequests: 0 });
  }
  return {
    rollup,
    ...(attributionSince !== undefined ? { attributionSince: new Date(attributionSince).toISOString() } : {}),
  };
}

/**
 * Rollup cache keyed by the exact usage-log revision, mirroring the /api/usage
 * summary cache. Without it, every key-list read reparses an append-only log
 * that only ever grows — and the GUI fetches this route on mount and after every
 * create/rename/delete. The compact rollup is a handful of counters per key, so
 * caching it costs nothing; a new row changes the revision and invalidates it.
 */
let rollupCache: { revisionKey: string; expiresAt: number; snapshot: ApiKeyUsageSnapshot } | null = null;
let postgresRollupCaches = new WeakMap<SQL, Map<string, { expiresAt: number; snapshot: ApiKeyUsageSnapshot }>>();

/**
 * The rollup is a function of the log AND of the clock: a request ages out of
 * the seven-day window with no write to bump the file revision, so a purely
 * revision-keyed entry would report a stale `requests7d` indefinitely.
 *
 * A minute is the whole rule. Deriving the exact next-transition instant would
 * mean tracking the OLDEST counted request per key, which the compact rollup
 * deliberately does not keep — and a count that can be at most 60s stale is
 * already far tighter than the window it describes.
 */
const ROLLUP_CACHE_TTL_MS = 60_000;

/** Test seam: the cache is module state and would otherwise leak between cases. */
export function clearApiKeyUsageCacheForTests(): void {
  rollupCache = null;
  postgresRollupCaches = new WeakMap();
}

type ApiKeyUsageSqlRow = {
  api_key_id: string | null;
  requests_7d: number | string | bigint | null;
  total_requests: number | string | bigint | null;
  last_used_at: Date | string | null;
  attribution_since: Date | string | null;
};

function count(value: ApiKeyUsageSqlRow["total_requests"]): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isoTimestamp(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Exact all-history rollup over normalized facts. No raw request JSON or label scan. */
export async function readApiKeyUsageRollupFromPostgres(
  sql: SQL,
  configuredIds: string[],
  now: number = Date.now(),
): Promise<ApiKeyUsageSnapshot> {
  const duplicated = new Set<string>();
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const id of configuredIds) {
    if (seen.has(id)) duplicated.add(id);
    else uniqueIds.push(id);
    seen.add(id);
  }

  const rows = await sql.unsafe<ApiKeyUsageSqlRow[]>(`
    WITH wanted(value) AS (
      SELECT value FROM jsonb_array_elements_text($1::jsonb)
    ), attribution AS (
      SELECT min(occurred_at) AS attribution_since
      FROM opencodex_usage.requests
      WHERE admission_code IN (1, 2, 3)
    ), per_key AS (
      SELECT d.value AS api_key_id,
        count(*) FILTER (WHERE r.occurred_at >= $2::timestamptz - interval '7 days') AS requests_7d,
        count(*) AS total_requests,
        max(r.occurred_at) AS last_used_at
      FROM wanted w
      JOIN opencodex_usage.dimensions d
        ON d.kind = $3::smallint AND d.value = w.value
      JOIN opencodex_usage.requests r ON r.api_key_id = d.id
      WHERE r.admission_code = 1
      GROUP BY d.value
    )
    SELECT p.api_key_id, p.requests_7d, p.total_requests, p.last_used_at,
      a.attribution_since
    FROM attribution a
    LEFT JOIN per_key p ON true
  `, [JSON.stringify(uniqueIds), new Date(now).toISOString(), USAGE_DIMENSION_KIND.apiKey]);

  const rollup = new Map<string, ApiKeyUsage>();
  for (const id of uniqueIds) rollup.set(id, { requests7d: 0, totalRequests: 0 });
  for (const row of rows) {
    if (!row.api_key_id || !seen.has(row.api_key_id)) continue;
    const lastUsedAt = isoTimestamp(row.last_used_at);
    rollup.set(row.api_key_id, {
      requests7d: count(row.requests_7d),
      totalRequests: count(row.total_requests),
      ...(lastUsedAt ? { lastUsedAt } : {}),
    });
  }
  for (const id of duplicated) rollup.set(id, { ambiguous: true });
  const attributionSince = isoTimestamp(rows[0]?.attribution_since ?? null);
  return { rollup, ...(attributionSince ? { attributionSince } : {}) };
}

async function cachedApiKeyUsageRollupFromPostgres(
  sql: SQL,
  configuredIds: string[],
  now: number,
): Promise<ApiKeyUsageSnapshot> {
  let cache = postgresRollupCaches.get(sql);
  if (!cache) {
    cache = new Map();
    postgresRollupCaches.set(sql, cache);
  }
  const key = JSON.stringify(configuredIds);
  const cached = cache.get(key);
  if (cached && now < cached.expiresAt) return cached.snapshot;
  const snapshot = await readApiKeyUsageRollupFromPostgres(sql, configuredIds, now);
  cache.set(key, { expiresAt: now + ROLLUP_CACHE_TTL_MS, snapshot });
  return snapshot;
}

/**
 * Reads the durable usage snapshot the way /api/usage does, then rolls it up.
 *
 * Never throws: an unreadable snapshot yields empty rollups and no
 * `attributionSince`. Key management working matters more than usage numbers
 * being present, and the GUI already treats an absent field as "no data".
 */
export async function readApiKeyUsageRollup(configuredIds: string[], maxReadBytes?: number): Promise<ApiKeyUsageSnapshot> {
  // JSON rather than a joined string: ids are only validated as non-empty
  // strings, so `["a\0b","c"]` and `["a","b\0c"]` join to the same value and one
  // config could be served the other's cached rollup.
  const idsKey = JSON.stringify([configuredIds, maxReadBytes]);
  const now = Date.now();
  const postgres = usagePostgresClient();
  if (postgres) {
    try {
      return await cachedApiKeyUsageRollupFromPostgres(postgres, configuredIds, now);
    } catch (error) {
      console.warn(
        "[usage-postgres] API key rollup unavailable; falling back to JSONL:",
        error instanceof Error ? error.message : error,
      );
    }
  }
  try {
    const observedKey = `${usageLogRevisionKey(currentUsageLedgerRevision())}|${idsKey}`;
    if (rollupCache?.revisionKey === observedKey && now < rollupCache.expiresAt) {
      return rollupCache.snapshot;
    }

    const snapshot = await readUsageSnapshotForManagement(maxReadBytes);
    const rolled = {
      ...rollupApiKeyUsage(snapshot.entries, configuredIds, now),
      ...(snapshot.truncatedPrefixBytes > 0 || snapshot.entriesTruncated ? { historyTruncated: true as const } : {}),
    };
    rollupCache = {
      revisionKey: `${usageLogRevisionKey(snapshot.revision)}|${idsKey}`,
      expiresAt: now + ROLLUP_CACHE_TTL_MS,
      snapshot: rolled,
    };
    return rolled;
  } catch {
    const rollup = new Map<string, ApiKeyUsage>();
    for (const id of configuredIds) rollup.set(id, { requests7d: 0, totalRequests: 0 });
    return { rollup };
  }
}
