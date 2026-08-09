/**
 * Source-backed routing analytics (RI-03).
 *
 * Central deployments query normalized PostgreSQL facts. Standalone/offline
 * deployments fall back to the bounded request-history SQLite projection;
 * neither path repeatedly scans JSONL. The analysis is read-only: no routing
 * decision, profile, or weight changes here (ADR-10 - no automatic self-tuning).
 *
 * Bounds: at most ANALYTICS_MAX_ROWS matching rows are analyzed per call; a
 * larger population sets `historyTruncated: true` so readers never mistake a
 * sample for the full history.
 */

import type { PersistedUsageEntry, PersistedUsageAttempt } from "../usage/log";
import { estimateRequestCost, serviceTierContext } from "../usage/cost";
import { usagePostgresClient } from "../usage/postgres-ingest";
import { openRequestHistoryIndex, requestHistoryDb } from "./history/indexer";
import type { SQL } from "bun";

export const ANALYTICS_MAX_ROWS = 50_000;
/** Default row cap for the management API (full cap remains available via `limit`). */
export const ANALYTICS_API_DEFAULT_ROWS = 5_000;

export interface RoutingAnalyticsFilters {
  provider?: string;
  model?: string;
  profileId?: string;
  surface?: string;
  from?: number;
  to?: number;
}

export type AnalyticsConfidence = "high" | "medium" | "low";

export interface AnalyticsBreakdownRow {
  provider: string;
  model: string;
  accountRef?: string;
  profileId?: string;
  requests: number;
  successes: number;
  failures: number;
  cancelled: number;
  successRate: number | null;
  p50DurationMs?: number;
  estimatedCostUsdPerSuccessfulRequest?: number | null;
}

export interface AnalyticsProfileRow {
  profileId: string;
  profileRevision?: string;
  requests: number;
  successes: number;
  failures: number;
  fallbacks: number;
  successRate: number | null;
}

export interface RoutingAnalyticsResult {
  generatedAt: number;
  totalRequests: number;
  scannedRows: number;
  historyTruncated: boolean;
  confidence: AnalyticsConfidence | null;
  successRate: number | null;
  failureRate: number | null;
  cancelledRate: number | null;
  fallbackRate: number | null;
  totalAttempts: number;
  averageAttemptsPerRequest: number | null;
  incompleteStreamRate: number | null;
  cooldownTriggeringFailures: number;
  durationMs: {
    p50?: number;
    p95?: number;
    p99?: number;
    sampleCount: number;
  };
  firstOutputMs: {
    p50?: number;
    p95?: number;
    p99?: number;
    sampleCount: number;
    /** Share of scanned requests with a TTFT measurement (0..1). */
    coverage: number | null;
  };
  estimatedCostUsdPerSuccessfulRequest: number | null;
  estimatedCostUsdTotalSuccessful: number | null;
  usageCoverage: number | null;
  priceCoverage: number | null;
  breakdown: AnalyticsBreakdownRow[];
  profileBreakdown: AnalyticsProfileRow[];
}

interface ScannedRow {
  provider: string;
  model: string;
  apiKeyId?: string | null;
  profileId?: string | null;
  profileRevision?: string | null;
  status: number;
  durationMs: number;
  firstOutputMs?: number | null;
  closeReason?: string | null;
  terminalStatus?: string | null;
  usageStatus: string;
  usageJson?: string | null;
  attemptCount: number;
  fallback: number;
  rowJson: string;
  cooldownTriggeringFailure?: boolean;
}

interface Bucket extends AnalyticsBreakdownRow {
  durations: number[];
  costUsdSum: number;
  costRows: number;
}

const COOLDOWN_RECOVERY_KINDS = new Set([
  "rate-limit-429",
  "key-429",
  "oauth-401",
  "anthropic-oauth-429",
]);

function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)];
}

function classifyRow(row: ScannedRow): "success" | "failure" | "cancelled" {
  if (row.closeReason === "client_cancel" || row.status === 499) return "cancelled";
  if (row.terminalStatus === "incomplete") return "failure";
  if (row.terminalStatus && row.terminalStatus !== "completed") return "failure";
  if (row.status >= 400) return "failure";
  return "success";
}

function parseEntry(rowJson: string): PersistedUsageEntry | null {
  try {
    const parsed = JSON.parse(rowJson) as PersistedUsageEntry;
    return parsed && typeof parsed === "object" && typeof parsed.requestId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function attemptsOf(entry: PersistedUsageEntry | null): PersistedUsageAttempt[] | undefined {
  return entry?.attempts;
}

function cooldownTriggering(entry: PersistedUsageEntry | null, status: number): boolean {
  if (status === 429) return true;
  const attempts = attemptsOf(entry) ?? [];
  return attempts.some(attempt => attempt.recoveryKinds.some(kind => COOLDOWN_RECOVERY_KINDS.has(kind)));
}

function successCostUsd(
  row: Pick<ScannedRow, "provider" | "model">,
  entry: PersistedUsageEntry,
): number | null {
  if (!entry.usage) return null;
  const estimate = estimateRequestCost({
    provider: row.provider,
    model: row.model,
    usage: entry.usage,
    usageStatus: entry.usageStatus,
    serviceTier: serviceTierContext(entry),
  });
  return estimate ? estimate.cost.total : null;
}

function sqliteAnalyticsRows(
  filters: RoutingAnalyticsFilters,
  maxRows: number,
): ScannedRow[] {
  const handle = requestHistoryDb();
  const where: string[] = [];
  const values: Array<string | number> = [];
  const add = (clause: string, value: string | number) => {
    where.push(clause);
    values.push(value);
  };
  if (filters.provider !== undefined) add("provider = ?", filters.provider);
  if (filters.model !== undefined) add("model = ?", filters.model);
  if (filters.profileId !== undefined) add("profile_id = ?", filters.profileId);
  if (filters.surface !== undefined) add("surface = ?", filters.surface);
  if (filters.from !== undefined) add("timestamp >= ?", filters.from);
  if (filters.to !== undefined) add("timestamp <= ?", filters.to);
  const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";

  return handle.query(
    `SELECT provider, model, api_key_id AS apiKeyId, profile_id AS profileId,
            profile_revision AS profileRevision, status,
            duration_ms AS durationMs, first_output_ms AS firstOutputMs,
            close_reason AS closeReason, terminal_status AS terminalStatus,
            usage_status AS usageStatus, usage_json AS usageJson,
            attempt_count AS attemptCount, fallback, row_json AS rowJson
     FROM requests${whereSql} ORDER BY timestamp DESC LIMIT ?`,
  ).all(...values, maxRows + 1) as ScannedRow[];
}

const SURFACE_FILTER_CODES: Record<string, number> = {
  claude: 1,
  "claude-desktop": 2,
  grok: 3,
};

function usageStatusFromCode(code: unknown): PersistedUsageEntry["usageStatus"] {
  if (Number(code) === 1) return "reported";
  if (Number(code) === 3) return "unsupported";
  if (Number(code) === 4) return "estimated";
  return "unreported";
}

function closeReasonFromCode(code: unknown): PersistedUsageEntry["closeReason"] | undefined {
  return ({
    1: "terminal",
    2: "client_cancel",
    3: "non_stream",
    4: "body_stall",
    5: "body_overflow",
  } as const)[Number(code) as 1 | 2 | 3 | 4 | 5];
}

function finiteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function postgresAnalyticsRow(raw: Record<string, unknown>): ScannedRow {
  const usageStatus = usageStatusFromCode(raw.usage_status_code);
  const optionalUsageValues = {
    contextTotalTokens: finiteNumber(raw.context_total_tokens),
    cachedInputTokens: finiteNumber(raw.cached_input_tokens),
    cacheReadInputTokens: finiteNumber(raw.cache_read_input_tokens),
    cacheCreationInputTokens: finiteNumber(raw.cache_creation_input_tokens),
    reasoningOutputTokens: finiteNumber(raw.reasoning_output_tokens),
  };
  const inputTokens = finiteNumber(raw.input_tokens);
  const outputTokens = finiteNumber(raw.output_tokens);
  const hasUsage = inputTokens !== undefined
    || outputTokens !== undefined
    || Object.values(optionalUsageValues).some(value => value !== undefined);
  const usageValues = {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(optionalUsageValues.contextTotalTokens !== undefined
      ? { contextTotalTokens: optionalUsageValues.contextTotalTokens }
      : {}),
    ...(optionalUsageValues.cachedInputTokens !== undefined
      ? { cachedInputTokens: optionalUsageValues.cachedInputTokens }
      : {}),
    ...(optionalUsageValues.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: optionalUsageValues.cacheReadInputTokens }
      : {}),
    ...(optionalUsageValues.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: optionalUsageValues.cacheCreationInputTokens }
      : {}),
    ...(optionalUsageValues.reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens: optionalUsageValues.reasoningOutputTokens }
      : {}),
  };
  const entry: PersistedUsageEntry = {
    requestId: String(raw.request_id),
    timestamp: new Date(String(raw.occurred_at)).getTime(),
    provider: String(raw.provider),
    model: String(raw.model),
    status: Number(raw.http_status),
    durationMs: Number(raw.duration_ms),
    usageStatus,
    ...(hasUsage ? { usage: usageValues } : {}),
    ...(raw.requested_service_tier ? { requestedServiceTier: String(raw.requested_service_tier) } : {}),
    ...(raw.requested_speed_label ? { requestedSpeedLabel: String(raw.requested_speed_label) } : {}),
    ...(raw.configured_service_tier ? { configuredServiceTier: String(raw.configured_service_tier) } : {}),
    ...(raw.configured_speed_label ? { configuredSpeedLabel: String(raw.configured_speed_label) } : {}),
    ...(typeof raw.model_supports_service_tier === "boolean"
      ? { modelSupportsServiceTier: raw.model_supports_service_tier }
      : {}),
    ...(raw.response_service_tier ? { responseServiceTier: String(raw.response_service_tier) } : {}),
  };
  return {
    provider: entry.provider,
    model: entry.model,
    apiKeyId: raw.api_key_id ? String(raw.api_key_id) : null,
    profileId: raw.profile_id ? String(raw.profile_id) : null,
    profileRevision: raw.profile_revision ? String(raw.profile_revision) : null,
    status: entry.status,
    durationMs: entry.durationMs,
    firstOutputMs: finiteNumber(raw.first_output_ms),
    closeReason: closeReasonFromCode(raw.close_reason_code) ?? null,
    terminalStatus: raw.terminal_status ? String(raw.terminal_status) : null,
    usageStatus,
    usageJson: hasUsage ? JSON.stringify(entry.usage) : null,
    attemptCount: Number(raw.attempt_count),
    fallback: Number(raw.attempt_count) > 1 ? 1 : 0,
    rowJson: JSON.stringify(entry),
    cooldownTriggeringFailure: Boolean(raw.cooldown_triggering_failure),
  };
}

export async function postgresRoutingAnalyticsRows(
  sql: SQL,
  filters: RoutingAnalyticsFilters,
  maxRows: number,
): Promise<ScannedRow[]> {
  const where: string[] = [];
  const values: Array<string | number> = [];
  const add = (clause: string, value: string | number) => {
    values.push(value);
    where.push(clause.replace("?", `$${values.length}`));
  };
  if (filters.provider !== undefined) add("provider.value = ?", filters.provider);
  if (filters.model !== undefined) add("model.value = ?", filters.model);
  if (filters.profileId !== undefined) add("profile.value = ?", filters.profileId);
  if (filters.surface !== undefined) add("request.surface_code = ?", SURFACE_FILTER_CODES[filters.surface] ?? -1);
  if (filters.from !== undefined) add("request.occurred_at >= to_timestamp(? / 1000.0)", filters.from);
  if (filters.to !== undefined) add("request.occurred_at <= to_timestamp(? / 1000.0)", filters.to);
  values.push(maxRows + 1);
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await sql.unsafe<Array<Record<string, unknown>>>(`
    SELECT request.occurred_at, request.request_id,
           provider.value AS provider, model.value AS model,
           api_key.value AS api_key_id,
           profile.value AS profile_id, profile_revision.value AS profile_revision,
           request.http_status, request.duration_ms, request.first_output_ms,
           request.close_reason_code, terminal_status.value AS terminal_status,
           request.usage_status_code,
           request.input_tokens, request.output_tokens, request.context_total_tokens,
           request.cached_input_tokens, request.cache_read_input_tokens,
           request.cache_creation_input_tokens, request.reasoning_output_tokens,
           request.attempt_count,
           requested_service_tier.value AS requested_service_tier,
           requested_speed_label.value AS requested_speed_label,
           configured_service_tier.value AS configured_service_tier,
           configured_speed_label.value AS configured_speed_label,
           request.model_supports_service_tier,
           response_service_tier.value AS response_service_tier,
           EXISTS (
             SELECT 1 FROM opencodex_usage.attempt_recoveries recovery
             WHERE recovery.occurred_at = request.occurred_at
               AND recovery.request_id = request.request_id
               AND recovery.recovery_code IN (3, 4, 5, 6)
           ) AS cooldown_triggering_failure
    FROM opencodex_usage.requests request
    JOIN opencodex_usage.dimensions provider ON provider.id = request.provider_id
    JOIN opencodex_usage.dimensions model ON model.id = request.model_id
    LEFT JOIN opencodex_usage.dimensions api_key ON api_key.id = request.api_key_id
    LEFT JOIN opencodex_usage.dimensions terminal_status ON terminal_status.id = request.terminal_status_id
    LEFT JOIN opencodex_usage.route_decisions decision
      ON decision.occurred_at = request.occurred_at AND decision.request_id = request.request_id
    LEFT JOIN opencodex_usage.dimensions profile ON profile.id = decision.profile_id
    LEFT JOIN opencodex_usage.dimensions profile_revision ON profile_revision.id = decision.profile_revision_id
    LEFT JOIN opencodex_usage.dimensions requested_service_tier ON requested_service_tier.id = request.requested_service_tier_id
    LEFT JOIN opencodex_usage.dimensions requested_speed_label ON requested_speed_label.id = request.requested_speed_label_id
    LEFT JOIN opencodex_usage.dimensions configured_service_tier ON configured_service_tier.id = request.configured_service_tier_id
    LEFT JOIN opencodex_usage.dimensions configured_speed_label ON configured_speed_label.id = request.configured_speed_label_id
    LEFT JOIN opencodex_usage.dimensions response_service_tier ON response_service_tier.id = request.response_service_tier_id
    ${whereSql}
    ORDER BY request.occurred_at DESC, request.request_id DESC
    LIMIT $${values.length}
  `, values);
  return rows.map(postgresAnalyticsRow);
}

export async function computeRoutingAnalytics(
  filters: RoutingAnalyticsFilters,
  options: { maxRows?: number } = {},
): Promise<RoutingAnalyticsResult> {
  const maxRows = Math.min(
    Math.max(1, Math.trunc(options.maxRows ?? ANALYTICS_MAX_ROWS)),
    ANALYTICS_MAX_ROWS,
  );
  let rows: ScannedRow[];
  const postgres = usagePostgresClient();
  if (postgres) {
    try {
      rows = await postgresRoutingAnalyticsRows(postgres, filters, maxRows);
    } catch (error) {
      console.warn(
        "[usage-postgres] routing analytics unavailable; falling back to bounded SQLite:",
        error instanceof Error ? error.message : String(error),
      );
      await openRequestHistoryIndex();
      rows = sqliteAnalyticsRows(filters, maxRows);
    }
  } else {
    await openRequestHistoryIndex();
    rows = sqliteAnalyticsRows(filters, maxRows);
  }

  const scanned = rows.slice(0, maxRows);
  const historyTruncated = rows.length > maxRows;

  let successes = 0;
  let failures = 0;
  let cancelled = 0;
  let fallbacks = 0;
  let totalAttempts = 0;
  let incompleteStreams = 0;
  let cooldownFailures = 0;
  let usageReported = 0;
  const durations: number[] = [];
  const firstOutputs: number[] = [];
  let costTotalUsd = 0;
  let costCount = 0;

  const byKey = new Map<string, Bucket>();
  const byProfile = new Map<string, AnalyticsProfileRow>();

  for (const row of scanned) {
    const kind = classifyRow(row);
    if (kind === "success") successes += 1;
    else if (kind === "failure") failures += 1;
    else cancelled += 1;
    if (row.fallback === 1) fallbacks += 1;
    totalAttempts += row.attemptCount;
    if (row.terminalStatus === "incomplete") incompleteStreams += 1;
    durations.push(row.durationMs);
    if (row.firstOutputMs !== null && row.firstOutputMs !== undefined && row.firstOutputMs >= 0) {
      firstOutputs.push(row.firstOutputMs);
    }
    if (row.usageStatus !== "unreported") usageReported += 1;

    let rowCostUsd: number | null = null;
    if (kind === "success") {
      const entry = parseEntry(row.rowJson);
      if (entry) {
        rowCostUsd = successCostUsd(row, entry);
        if (rowCostUsd !== null) {
          costTotalUsd += rowCostUsd;
          costCount += 1;
        }
      }
    }

    if (kind === "failure") {
      const failureEntry = parseEntry(row.rowJson);
      if (row.cooldownTriggeringFailure || cooldownTriggering(failureEntry, row.status)) cooldownFailures += 1;
    }

    const key = `${row.provider}\0${row.model}\0${row.apiKeyId ?? ""}\0${row.profileId ?? ""}`;
    let bucket: Bucket | undefined = byKey.get(key);
    if (!bucket) {
      bucket = {
        provider: row.provider,
        model: row.model,
        ...(row.apiKeyId ? { accountRef: row.apiKeyId } : {}),
        ...(row.profileId ? { profileId: row.profileId } : {}),
        requests: 0,
        successes: 0,
        failures: 0,
        cancelled: 0,
        successRate: null,
        durations: [],
        costUsdSum: 0,
        costRows: 0,
      };
      byKey.set(key, bucket);
    }
    bucket.requests += 1;
    if (kind === "success") bucket.successes += 1;
    else if (kind === "failure") bucket.failures += 1;
    else bucket.cancelled += 1;
    bucket.durations.push(row.durationMs);
    if (rowCostUsd !== null) {
      bucket.costUsdSum += rowCostUsd;
      bucket.costRows += 1;
    }

    if (row.profileId) {
      let profile = byProfile.get(row.profileId);
      if (!profile) {
        profile = {
          profileId: row.profileId,
          ...(row.profileRevision ? { profileRevision: row.profileRevision } : {}),
          requests: 0,
          successes: 0,
          failures: 0,
          fallbacks: 0,
          successRate: null,
        };
        byProfile.set(row.profileId, profile);
      }
      profile.requests += 1;
      if (kind === "success") profile.successes += 1;
      else if (kind === "failure") profile.failures += 1;
      if (row.fallback === 1) profile.fallbacks += 1;
    }
  }

  durations.sort((a, b) => a - b);
  firstOutputs.sort((a, b) => a - b);
  const total = scanned.length;
  const rate = (count: number): number | null => (total > 0 ? count / total : null);

  const breakdown: AnalyticsBreakdownRow[] = [...byKey.values()].map(bucket => {
    const sorted = bucket.durations.sort((a, b) => a - b);
    const p50DurationMs = percentile(sorted, 50);
    return {
      provider: bucket.provider,
      model: bucket.model,
      ...(bucket.accountRef ? { accountRef: bucket.accountRef } : {}),
      ...(bucket.profileId ? { profileId: bucket.profileId } : {}),
      requests: bucket.requests,
      successes: bucket.successes,
      failures: bucket.failures,
      cancelled: bucket.cancelled,
      successRate: bucket.requests > 0 ? bucket.successes / bucket.requests : null,
      ...(p50DurationMs !== undefined ? { p50DurationMs } : {}),
      ...(bucket.requests > 0
        ? { estimatedCostUsdPerSuccessfulRequest: bucket.costRows > 0
          ? bucket.costUsdSum / bucket.costRows
          : null }
        : {}),
    };
  }).sort((a, b) => b.requests - a.requests);

  const profileBreakdown: AnalyticsProfileRow[] = [...byProfile.values()].map(profile => ({
    ...profile,
    successRate: profile.requests > 0 ? profile.successes / profile.requests : null,
  })).sort((a, b) => b.requests - a.requests);

  const confidence: AnalyticsConfidence | null = total === 0
    ? null
    : total >= 100 ? "high" : total >= 20 ? "medium" : "low";

  return {
    generatedAt: Date.now(),
    totalRequests: total,
    scannedRows: scanned.length,
    historyTruncated,
    confidence,
    successRate: rate(successes),
    failureRate: rate(failures),
    cancelledRate: rate(cancelled),
    fallbackRate: rate(fallbacks),
    totalAttempts,
    averageAttemptsPerRequest: total > 0 ? totalAttempts / total : null,
    incompleteStreamRate: rate(incompleteStreams),
    cooldownTriggeringFailures: cooldownFailures,
    durationMs: {
      ...(percentile(durations, 50) !== undefined ? { p50: percentile(durations, 50) } : {}),
      ...(percentile(durations, 95) !== undefined ? { p95: percentile(durations, 95) } : {}),
      ...(percentile(durations, 99) !== undefined ? { p99: percentile(durations, 99) } : {}),
      sampleCount: durations.length,
    },
    firstOutputMs: {
      ...(percentile(firstOutputs, 50) !== undefined ? { p50: percentile(firstOutputs, 50) } : {}),
      ...(percentile(firstOutputs, 95) !== undefined ? { p95: percentile(firstOutputs, 95) } : {}),
      ...(percentile(firstOutputs, 99) !== undefined ? { p99: percentile(firstOutputs, 99) } : {}),
      sampleCount: firstOutputs.length,
      coverage: total > 0 ? firstOutputs.length / total : null,
    },
    estimatedCostUsdPerSuccessfulRequest: costCount > 0 ? costTotalUsd / costCount : null,
    estimatedCostUsdTotalSuccessful: costCount > 0 ? costTotalUsd : null,
    usageCoverage: total > 0 ? usageReported / total : null,
    priceCoverage: successes > 0 ? costCount / successes : null,
    breakdown,
    profileBreakdown,
  };
}
