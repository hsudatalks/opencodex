import type { SQL } from "bun";
import { usageCalendarPeriod } from "./calendar";
import { sqlCostRule } from "./cost";
import { USAGE_DIMENSION_KIND } from "./postgres-ingest";
import type {
  UsageDay,
  UsageDayModel,
  UsageKey,
  UsageModel,
  UsageProvider,
  UsageRange,
  UsageSummary,
  UsageSummaryOptions,
  UsageSummaryTotals,
  UsageSurface,
} from "./summary";

const DAY_MS = 86_400_000;
const MAX_BREAKDOWN_ROWS = 256;
const SUMMARY_CACHE_TTL_MS = 30_000;
const SUMMARY_CACHE_STALE_MS = 5 * 60_000;
const SUMMARY_CACHE_MAX_WINDOWS = 128;

type SqlRow = Record<string, unknown>;
interface SummaryCacheEntry {
  value?: UsageSummary;
  loadedAt?: number;
  inflight?: Promise<UsageSummary>;
}

const summaryCaches = new WeakMap<SQL, Map<string, SummaryCacheEntry>>();
function numeric(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function timestampMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

function surfaceMode(surface: UsageSurface): number {
  if (surface === "codex") return 1;
  if (surface === "claude") return 2;
  if (surface === "grok") return 3;
  return 0;
}

function sinceForRange(range: UsageRange, now: number): number | null {
  return range === "all" ? null : usageCalendarPeriod(range, now).start;
}

function singaporeDateKey(timestamp: number): string {
  return new Date(timestamp + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

function zeroTotals(): UsageSummaryTotals {
  return {
    requests: 0,
    attemptCount: 0,
    measuredRequests: 0,
    reportedRequests: 0,
    unreportedRequests: 0,
    unsupportedRequests: 0,
    estimatedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    coverageRatio: 0,
    estimatedCostUsd: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
    unmeteredRequests: 0,
  };
}

function totalsFromRow(row: SqlRow | undefined): UsageSummaryTotals {
  if (!row) return zeroTotals();
  const totals = {
    requests: numeric(row.requests),
    attemptCount: numeric(row.attempt_count),
    measuredRequests: numeric(row.measured_requests),
    reportedRequests: numeric(row.reported_requests),
    unreportedRequests: numeric(row.unreported_requests),
    unsupportedRequests: numeric(row.unsupported_requests),
    estimatedRequests: numeric(row.estimated_requests),
    inputTokens: numeric(row.input_tokens),
    outputTokens: numeric(row.output_tokens),
    cachedInputTokens: numeric(row.cache_read_input_tokens),
    cacheReadInputTokens: numeric(row.cache_read_input_tokens),
    cacheCreationInputTokens: numeric(row.cache_creation_input_tokens),
    reasoningOutputTokens: numeric(row.reasoning_output_tokens),
    totalTokens: numeric(row.total_tokens),
    coverageRatio: 0,
    estimatedCostUsd: numeric(row.estimated_cost_usd),
    pricedRequests: numeric(row.priced_requests),
    unpricedRequests: numeric(row.unpriced_requests),
    unmeteredRequests: numeric(row.unmetered_requests),
  };
  totals.coverageRatio = totals.requests === 0 ? 0 : totals.measuredRequests / totals.requests;
  return totals;
}

function cappedModels(rows: UsageModel[], totalTokens: number): UsageModel[] {
  if (rows.length <= MAX_BREAKDOWN_ROWS) return rows;
  const kept = rows.slice(0, MAX_BREAKDOWN_ROWS - 1);
  const overflow = rows.slice(MAX_BREAKDOWN_ROWS - 1);
  const other = overflow.reduce<UsageModel>((out, row) => ({
    ...out,
    requests: out.requests + row.requests,
    attemptCount: out.attemptCount + row.attemptCount,
    measuredRequests: out.measuredRequests + row.measuredRequests,
    reportedRequests: out.reportedRequests + row.reportedRequests,
    estimatedRequests: out.estimatedRequests + row.estimatedRequests,
    totalTokens: out.totalTokens + row.totalTokens,
    inputTokens: out.inputTokens + row.inputTokens,
    outputTokens: out.outputTokens + row.outputTokens,
    estimatedCostUsd: (out.estimatedCostUsd ?? 0) + (row.estimatedCostUsd ?? 0),
    shareRatio: 0,
  }), {
    provider: "other", model: "other", requests: 0, attemptCount: 0,
    measuredRequests: 0, reportedRequests: 0, estimatedRequests: 0,
    totalTokens: 0, inputTokens: 0, outputTokens: 0, shareRatio: 0,
  });
  other.shareRatio = totalTokens === 0 ? 0 : other.totalTokens / totalTokens;
  return [...kept, other];
}

function compareModels(
  left: Pick<UsageModel, "requests" | "provider" | "model">,
  right: Pick<UsageModel, "requests" | "provider" | "model">,
): number {
  return right.requests - left.requests
    || left.provider.localeCompare(right.provider)
    || left.model.localeCompare(right.model);
}

function compareProviders(left: UsageProvider, right: UsageProvider): number {
  return right.requests - left.requests || left.provider.localeCompare(right.provider);
}

function capDayModels(day: UsageDay): void {
  day.models.sort(compareModels);
  if (day.models.length <= MAX_BREAKDOWN_ROWS) return;
  const kept = day.models.slice(0, MAX_BREAKDOWN_ROWS - 1);
  const overflow = day.models.slice(MAX_BREAKDOWN_ROWS - 1);
  kept.push(overflow.reduce<UsageDayModel>((out, row) => ({
    ...out,
    requests: out.requests + row.requests,
    attemptCount: out.attemptCount + row.attemptCount,
    totalTokens: out.totalTokens + row.totalTokens,
  }), { provider: "other", model: "other", requests: 0, attemptCount: 0, totalTokens: 0 }));
  day.models = kept;
}

function dayGrid(range: UsageRange, now: number, oldest: number | undefined, rows: SqlRow[], modelRows: SqlRow[]): UsageDay[] {
  const byDate = new Map<string, UsageDay>();
  const period = usageCalendarPeriod(range, now);
  let days = range === "all" ? 1 : period.days;
  if (range === "all" && oldest !== undefined) {
    days = Math.max(1, Math.ceil((now - oldest) / DAY_MS) + 1);
  }
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = singaporeDateKey((range === "all" ? now : period.end) - offset * DAY_MS);
    byDate.set(date, { date, requests: 0, measuredRequests: 0, reportedRequests: 0, totalTokens: 0, models: [] });
  }
  for (const row of rows) {
    const date = String(row.date);
    byDate.set(date, {
      date,
      requests: numeric(row.requests),
      measuredRequests: numeric(row.measured_requests),
      reportedRequests: numeric(row.reported_requests),
      totalTokens: numeric(row.total_tokens),
      models: [],
    });
  }
  for (const row of modelRows) {
    const day = byDate.get(String(row.date));
    if (!day) continue;
    day.models.push({
      provider: String(row.provider),
      model: String(row.model),
      requests: numeric(row.requests),
      attemptCount: numeric(row.attempt_count),
      totalTokens: numeric(row.total_tokens),
    });
  }
  for (const day of byDate.values()) {
    capDayModels(day);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const FILTER = `
  ($1::timestamptz IS NULL OR r.occurred_at >= $1::timestamptz)
  AND r.occurred_at <= $3::timestamptz
  AND (
    $2::smallint = 0
    OR ($2::smallint = 1 AND r.surface_code = 0)
    OR ($2::smallint = 2 AND r.surface_code IN (1, 2))
    OR ($2::smallint = 3 AND r.surface_code = 3)
  )
  -- $4 is the admission key's dimension id, NULL for every key. An id that does not exist is
  -- passed as -1 so a filter naming an unused key yields an empty window instead of everything.
  AND ($4::bigint IS NULL OR r.api_key_id = $4::bigint)
`;

/**
 * The read model has no admission-key dimension, so a key filter (or the per-key breakdown) is
 * answered from the raw facts: the same rows the dashboard already recomputes the current hour
 * from. The key id is a `dimensions` row of kind `apiKey`; a key that never carried a request has
 * no row, and `-1` matches nothing.
 */
async function resolveApiKeyDimensionId(tx: SQL, apiKeyId: string | undefined): Promise<number | null> {
  const wanted = apiKeyId?.trim();
  if (wanted === undefined || wanted.length === 0) return null;
  const rows = await tx.unsafe<SqlRow[]>(
    `SELECT id FROM opencodex_usage.dimensions WHERE kind = $1::smallint AND value = $2 LIMIT 1`,
    [USAGE_DIMENSION_KIND.apiKey, wanted],
  );
  const id = rows[0]?.id;
  return typeof id === "number" || typeof id === "bigint" || typeof id === "string" ? Number(id) : -1;
}

const ATTRIBUTIONS = `
  filtered AS MATERIALIZED (
    SELECT * FROM opencodex_usage.requests r WHERE ${FILTER}
  ),
  attributions AS MATERIALIZED (
    SELECT r.occurred_at, r.request_id, r.api_key_id, a.canonical_provider_id, a.usage_model_id,
      a.usage_status_code, a.input_tokens, a.output_tokens, a.total_tokens
    FROM filtered r
    JOIN opencodex_usage.attempts a USING (occurred_at, request_id)
    UNION ALL
    SELECT r.occurred_at, r.request_id, r.api_key_id, r.canonical_provider_id, r.usage_model_id,
      r.usage_status_code, r.input_tokens, r.output_tokens, r.total_tokens
    FROM filtered r
    WHERE r.attempt_count = 0
  )
`;

async function readAggregateRows(
  tx: SQL,
  since: string | null,
  mode: number,
  through: string,
  apiKeyDimensionId: number | null,
  wantKeys: boolean,
): Promise<{ totals: SqlRow[]; days: SqlRow[]; dayModels: SqlRow[]; models: SqlRow[]; providers: SqlRow[]; keys: SqlRow[] }> {
  const params = [since, mode, through, apiKeyDimensionId];
  const totals = await tx.unsafe<SqlRow[]>(`
    SELECT count(*) requests, min(r.occurred_at) oldest_occurred_at,
      sum(GREATEST(r.attempt_count, 1)) attempt_count,
      count(*) FILTER (WHERE r.usage_status_code IN (1, 4)) measured_requests,
      count(*) FILTER (WHERE r.usage_status_code = 1) reported_requests,
      count(*) FILTER (WHERE r.usage_status_code = 2) unreported_requests,
      count(*) FILTER (WHERE r.usage_status_code = 3) unsupported_requests,
      count(*) FILTER (WHERE r.usage_status_code = 4) estimated_requests,
      sum(COALESCE(r.input_tokens, 0)) input_tokens,
      sum(COALESCE(r.output_tokens, 0)) output_tokens,
      sum(CASE
        WHEN r.cache_read_input_tokens IS NOT NULL THEN r.cache_read_input_tokens
        WHEN r.cached_input_tokens IS NOT NULL AND r.cache_creation_input_tokens IS NOT NULL
          THEN GREATEST(0, r.cached_input_tokens - r.cache_creation_input_tokens)
        ELSE COALESCE(r.cached_input_tokens, 0)
      END) cache_read_input_tokens,
      sum(COALESCE(r.cache_creation_input_tokens, 0)) cache_creation_input_tokens,
      sum(COALESCE(r.reasoning_output_tokens, 0)) reasoning_output_tokens,
      sum(COALESCE(r.total_tokens, 0)) total_tokens
    FROM opencodex_usage.requests r
    WHERE ${FILTER}
  `, params);
  const days = await tx.unsafe<SqlRow[]>(`
    SELECT to_char(r.occurred_at AT TIME ZONE 'Asia/Singapore', 'YYYY-MM-DD') date,
      count(*) requests,
      count(*) FILTER (WHERE r.usage_status_code IN (1, 4)) measured_requests,
      count(*) FILTER (WHERE r.usage_status_code = 1) reported_requests,
      sum(COALESCE(r.total_tokens, 0)) total_tokens
    FROM opencodex_usage.requests r
    WHERE ${FILTER}
    GROUP BY 1 ORDER BY 1
  `, params);
  const dayModels = await tx.unsafe<SqlRow[]>(`
    WITH ${ATTRIBUTIONS}, per_request AS (
      SELECT to_char(occurred_at AT TIME ZONE 'Asia/Singapore', 'YYYY-MM-DD') date,
        canonical_provider_id, usage_model_id, occurred_at, request_id,
        count(*) attempt_count, sum(COALESCE(total_tokens, 0)) total_tokens
      FROM attributions
      GROUP BY 1, 2, 3, 4, 5
    )
    SELECT per_request.date, provider.value provider, model.value model,
      count(*) requests, sum(attempt_count) attempt_count, sum(total_tokens) total_tokens
    FROM per_request
    JOIN opencodex_usage.dimensions provider ON provider.id = canonical_provider_id
    JOIN opencodex_usage.dimensions model ON model.id = usage_model_id
    GROUP BY 1, 2, 3 ORDER BY 1, requests DESC
  `, params);
  const models = await tx.unsafe<SqlRow[]>(`
    WITH ${ATTRIBUTIONS}, per_request AS (
      SELECT canonical_provider_id, usage_model_id, occurred_at, request_id,
        count(*) attempt_count,
        CASE
          WHEN bool_and(usage_status_code = 3) THEN 3
          WHEN bool_or(usage_status_code IN (2, 3)) THEN 2
          WHEN bool_or(usage_status_code = 4) THEN 4
          ELSE 1
        END usage_status_code,
        sum(COALESCE(input_tokens, 0)) input_tokens,
        sum(COALESCE(output_tokens, 0)) output_tokens,
        sum(COALESCE(total_tokens, 0)) total_tokens
      FROM attributions
      GROUP BY 1, 2, 3, 4
    )
    SELECT provider.value provider, model.value model, count(*) requests,
      sum(attempt_count) attempt_count,
      count(*) FILTER (WHERE usage_status_code IN (1, 4)) measured_requests,
      count(*) FILTER (WHERE usage_status_code = 1) reported_requests,
      count(*) FILTER (WHERE usage_status_code = 4) estimated_requests,
      sum(total_tokens) total_tokens, sum(input_tokens) input_tokens, sum(output_tokens) output_tokens
    FROM per_request
    JOIN opencodex_usage.dimensions provider ON provider.id = canonical_provider_id
    JOIN opencodex_usage.dimensions model ON model.id = usage_model_id
    GROUP BY 1, 2 ORDER BY requests DESC
  `, params);
  const providers = await tx.unsafe<SqlRow[]>(`
    WITH ${ATTRIBUTIONS}, per_request AS (
      SELECT canonical_provider_id, occurred_at, request_id,
        count(*) attempt_count,
        CASE
          WHEN bool_and(usage_status_code = 3) THEN 3
          WHEN bool_or(usage_status_code IN (2, 3)) THEN 2
          WHEN bool_or(usage_status_code = 4) THEN 4
          ELSE 1
        END usage_status_code,
        sum(COALESCE(total_tokens, 0)) total_tokens
      FROM attributions
      GROUP BY 1, 2, 3
    )
    SELECT provider.value provider, count(*) requests, sum(attempt_count) attempt_count,
      count(*) FILTER (WHERE usage_status_code IN (1, 4)) measured_requests,
      count(*) FILTER (WHERE usage_status_code = 1) reported_requests,
      count(*) FILTER (WHERE usage_status_code = 4) estimated_requests,
      sum(total_tokens) total_tokens
    FROM per_request
    JOIN opencodex_usage.dimensions provider ON provider.id = canonical_provider_id
    GROUP BY 1 ORDER BY requests DESC
  `, params);
  const keys = wantKeys ? await tx.unsafe<SqlRow[]>(`
    WITH ${ATTRIBUTIONS}, per_request AS (
      SELECT api_key_id, occurred_at, request_id,
        count(*) attempt_count,
        CASE
          WHEN bool_and(usage_status_code = 3) THEN 3
          WHEN bool_or(usage_status_code IN (2, 3)) THEN 2
          WHEN bool_or(usage_status_code = 4) THEN 4
          ELSE 1
        END usage_status_code,
        sum(COALESCE(input_tokens, 0)) input_tokens,
        sum(COALESCE(output_tokens, 0)) output_tokens,
        sum(COALESCE(total_tokens, 0)) total_tokens
      FROM attributions
      GROUP BY 1, 2, 3
    )
    SELECT COALESCE(api_key.value, '') id, count(*) requests, sum(attempt_count) attempt_count,
      count(*) FILTER (WHERE usage_status_code IN (1, 4)) measured_requests,
      count(*) FILTER (WHERE usage_status_code = 1) reported_requests,
      count(*) FILTER (WHERE usage_status_code = 4) estimated_requests,
      sum(total_tokens) total_tokens, sum(input_tokens) input_tokens, sum(output_tokens) output_tokens
    FROM per_request
    LEFT JOIN opencodex_usage.dimensions api_key ON api_key.id = per_request.api_key_id
    GROUP BY 1 ORDER BY requests DESC
  `, params) : [];
  return { totals, days, dayModels, models, providers, keys };
}

/** Cost and failure split of the per-key rows; token counts come from the aggregate pass. */
interface UsageKeyCosts {
  costs: Map<string, number>;
  unpriced: Map<string, number>;
  unmetered: Map<string, number>;
}

async function applyCosts(
  tx: SQL,
  since: string | null,
  mode: number,
  through: string,
  totals: UsageSummaryTotals,
  models: UsageModel[],
  providers: UsageProvider[],
  apiKeyDimensionId: number | null,
  wantKeys: boolean,
): Promise<UsageKeyCosts> {
  const params = [since, mode, through, apiKeyDimensionId];
  const pairs = await tx.unsafe<SqlRow[]>(`
    WITH filtered AS MATERIALIZED (
      SELECT * FROM opencodex_usage.requests r WHERE ${FILTER}
    ), basis AS (
      SELECT r.provider_id, r.model_id
      FROM filtered r WHERE r.attempt_count = 0
      UNION ALL
      SELECT a.provider_id, a.model_id
      FROM filtered r JOIN opencodex_usage.attempts a USING (occurred_at, request_id)
      WHERE r.attempt_count > 0
    )
    SELECT DISTINCT provider.value provider, model.value model
    FROM basis
    JOIN opencodex_usage.dimensions provider ON provider.id = basis.provider_id
    JOIN opencodex_usage.dimensions model ON model.id = basis.model_id
  `, params);
  const rules = pairs.flatMap(row => {
    const rule = sqlCostRule(String(row.provider), String(row.model));
    return rule ? [rule] : [];
  });
  const costRows = await tx.unsafe<SqlRow[]>(`
    WITH filtered AS MATERIALIZED (
      SELECT * FROM opencodex_usage.requests r WHERE ${FILTER}
    ), rules AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($5::jsonb) AS x(
        provider text, model text,
        "inputRate" double precision, "outputRate" double precision,
        "cacheReadRate" double precision, "cacheWriteRate" double precision,
        "imageInputRate" double precision,
        "longThreshold" bigint, "longInclusive" boolean,
        "longInputMultiplier" double precision, "longOutputMultiplier" double precision,
        "longCacheReadMultiplier" double precision, "longCacheWriteMultiplier" double precision,
        "priorityMultiplier" double precision
      )
    ), basis AS MATERIALIZED (
      SELECT r.occurred_at, r.request_id, r.attempt_count,
        r.usage_status_code request_usage_status_code,
        (r.input_tokens IS NOT NULL AND r.output_tokens IS NOT NULL) request_has_usage,
        r.provider_id, r.model_id, r.canonical_provider_id, r.usage_model_id, r.api_key_id,
        r.usage_status_code, r.input_tokens, r.output_tokens, r.image_input_tokens,
        r.cached_input_tokens, r.cache_read_input_tokens, r.cache_creation_input_tokens,
        response_tier.value response_service_tier,
        requested_tier.value requested_service_tier,
        configured_tier.value configured_service_tier
      FROM filtered r
      LEFT JOIN opencodex_usage.dimensions response_tier ON response_tier.id = r.response_service_tier_id
      LEFT JOIN opencodex_usage.dimensions requested_tier ON requested_tier.id = r.requested_service_tier_id
      LEFT JOIN opencodex_usage.dimensions configured_tier ON configured_tier.id = r.configured_service_tier_id
      WHERE r.attempt_count = 0
      UNION ALL
      SELECT r.occurred_at, r.request_id, r.attempt_count,
        r.usage_status_code request_usage_status_code,
        (r.input_tokens IS NOT NULL AND r.output_tokens IS NOT NULL) request_has_usage,
        a.provider_id, a.model_id, a.canonical_provider_id, a.usage_model_id, r.api_key_id,
        a.usage_status_code, a.input_tokens, a.output_tokens, a.image_input_tokens,
        a.cached_input_tokens, a.cache_read_input_tokens, a.cache_creation_input_tokens,
        response_tier.value response_service_tier,
        requested_tier.value requested_service_tier,
        configured_tier.value configured_service_tier
      FROM filtered r
      JOIN opencodex_usage.attempts a USING (occurred_at, request_id)
      LEFT JOIN opencodex_usage.dimensions response_tier ON response_tier.id = r.response_service_tier_id
      LEFT JOIN opencodex_usage.dimensions requested_tier ON requested_tier.id = r.requested_service_tier_id
      LEFT JOIN opencodex_usage.dimensions configured_tier ON configured_tier.id = r.configured_service_tier_id
      WHERE r.attempt_count > 0
    ), identified AS MATERIALIZED (
      SELECT basis.*, provider.value provider, model.value model,
        canonical_provider.value canonical_provider, usage_model.value usage_model,
        COALESCE(api_key.value, '') api_key,
        COALESCE(basis.cache_creation_input_tokens, 0) cache_write,
        COALESCE(basis.cache_read_input_tokens, basis.cached_input_tokens, 0) primary_cache_read,
        CASE WHEN basis.cache_read_input_tokens IS NULL
          AND basis.cached_input_tokens IS NOT NULL
          AND basis.cache_creation_input_tokens IS NOT NULL
          THEN GREATEST(0, basis.cached_input_tokens - basis.cache_creation_input_tokens)
        END legacy_cache_read
      FROM basis
      JOIN opencodex_usage.dimensions provider ON provider.id = basis.provider_id
      JOIN opencodex_usage.dimensions model ON model.id = basis.model_id
      JOIN opencodex_usage.dimensions canonical_provider ON canonical_provider.id = basis.canonical_provider_id
      JOIN opencodex_usage.dimensions usage_model ON usage_model.id = basis.usage_model_id
      LEFT JOIN opencodex_usage.dimensions api_key ON api_key.id = basis.api_key_id
    ), tokenized AS MATERIALIZED (
      SELECT identified.*, rules.*,
        CASE
          WHEN input_tokens >= 0 AND output_tokens >= 0 AND cache_write >= 0
            AND (image_input_tokens IS NULL OR image_input_tokens BETWEEN 0 AND input_tokens)
            AND primary_cache_read >= 0 AND primary_cache_read + cache_write <= input_tokens
            THEN primary_cache_read
          WHEN input_tokens >= 0 AND output_tokens >= 0 AND cache_write >= 0
            AND (image_input_tokens IS NULL OR image_input_tokens BETWEEN 0 AND input_tokens)
            AND legacy_cache_read >= 0 AND legacy_cache_read + cache_write <= input_tokens
            THEN legacy_cache_read
        END normalized_cache_read
      FROM identified
      LEFT JOIN rules USING (provider, model)
    ), attributed AS MATERIALIZED (
      SELECT tokenized.*,
        CASE WHEN "inputRate" IS NULL OR normalized_cache_read IS NULL THEN NULL
          ELSE (
            (input_tokens - normalized_cache_read - cache_write) * "inputRate"
              * CASE WHEN long_active THEN "longInputMultiplier" WHEN priority_active THEN "priorityMultiplier" ELSE 1 END
            + output_tokens * "outputRate"
              * CASE WHEN long_active THEN "longOutputMultiplier" WHEN priority_active THEN "priorityMultiplier" ELSE 1 END
            + normalized_cache_read * "cacheReadRate"
              * CASE WHEN long_active THEN "longCacheReadMultiplier" WHEN priority_active THEN "priorityMultiplier" ELSE 1 END
            + cache_write * "cacheWriteRate"
              * CASE WHEN long_active THEN "longCacheWriteMultiplier" WHEN priority_active THEN "priorityMultiplier" ELSE 1 END
            + COALESCE(image_input_tokens, 0) * (COALESCE("imageInputRate", "inputRate") - "inputRate")
          ) / 1000000.0
        END attribution_cost
      FROM (
        SELECT tokenized.*,
          ("longThreshold" IS NOT NULL
            AND response_service_tier IS DISTINCT FROM 'priority'
            AND CASE WHEN "longInclusive" THEN input_tokens >= "longThreshold" ELSE input_tokens > "longThreshold" END
          ) long_active,
          (COALESCE(response_service_tier, requested_service_tier, configured_service_tier) = 'priority'
            AND "priorityMultiplier" <> 1
            AND NOT ("longThreshold" IS NOT NULL
              AND response_service_tier IS DISTINCT FROM 'priority'
              AND CASE WHEN "longInclusive" THEN input_tokens >= "longThreshold" ELSE input_tokens > "longThreshold" END)
          ) priority_active
        FROM tokenized
      ) tokenized
    ), request_costs AS MATERIALIZED (
      SELECT occurred_at, request_id,
        (request_usage_status_code IN (2, 3) OR (attempt_count = 0 AND NOT request_has_usage)) unmetered,
        bool_and(attribution_cost IS NOT NULL) all_priced,
        sum(attribution_cost) request_cost
      FROM attributed GROUP BY 1, 2, request_usage_status_code, attempt_count, request_has_usage
    ), request_keys AS MATERIALIZED (
      -- The admission key lives on the request row, so every attribution of one request shares it;
      -- min() collapses the degenerate multi-key case instead of multiplying the request.
      SELECT occurred_at, request_id, min(api_key) api_key
      FROM attributed GROUP BY 1, 2
    ), result AS (
      SELECT 'totals' kind, '' provider, '' model,
        COALESCE(sum(request_cost) FILTER (WHERE NOT unmetered AND all_priced), 0) cost,
        count(*) FILTER (WHERE NOT unmetered AND all_priced) priced_requests,
        count(*) FILTER (WHERE NOT unmetered AND NOT all_priced) unpriced_requests,
        count(*) FILTER (WHERE unmetered) unmetered_requests
      FROM request_costs
      UNION ALL
      SELECT 'model', canonical_provider, usage_model, sum(attribution_cost), 0, 0, 0
      FROM attributed JOIN request_costs USING (occurred_at, request_id)
      WHERE NOT unmetered AND all_priced GROUP BY 2, 3
      UNION ALL
      SELECT 'provider', canonical_provider, '', sum(attribution_cost), 0, 0, 0
      FROM attributed JOIN request_costs USING (occurred_at, request_id)
      WHERE NOT unmetered AND all_priced GROUP BY 2
      UNION ALL
      SELECT 'key', rk.api_key, '', COALESCE(sum(rc.request_cost) FILTER (WHERE NOT rc.unmetered AND rc.all_priced), 0), 0, 0, 0
      FROM request_costs rc JOIN request_keys rk USING (occurred_at, request_id)
      GROUP BY 2
      UNION ALL
      SELECT 'keycount', rk.api_key, '',
        0, 0,
        count(*) FILTER (WHERE NOT rc.unmetered AND NOT rc.all_priced),
        count(*) FILTER (WHERE rc.unmetered)
      FROM request_costs rc JOIN request_keys rk USING (occurred_at, request_id)
      GROUP BY 2
    ) SELECT * FROM result
  `, [...params, JSON.stringify(rules)]);
  const totalRow = costRows.find(row => row.kind === "totals");
  totals.estimatedCostUsd = numeric(totalRow?.cost);
  totals.pricedRequests = numeric(totalRow?.priced_requests);
  totals.unpricedRequests = numeric(totalRow?.unpriced_requests);
  totals.unmeteredRequests = numeric(totalRow?.unmetered_requests);
  const modelCosts = new Map(costRows.filter(row => row.kind === "model")
    .map(row => [`${String(row.provider)}\0${String(row.model)}`, numeric(row.cost)]));
  const providerCosts = new Map(costRows.filter(row => row.kind === "provider")
    .map(row => [String(row.provider), numeric(row.cost)]));
  for (const model of models) {
    const cost = modelCosts.get(`${model.provider}\0${model.model}`);
    if (cost !== undefined) model.estimatedCostUsd = cost;
  }
  for (const provider of providers) {
    const cost = providerCosts.get(provider.provider);
    if (cost !== undefined) provider.estimatedCostUsd = cost;
  }
  return {
    costs: new Map(costRows.filter(row => row.kind === "key").map(row => [String(row.provider), numeric(row.cost)])),
    unpriced: new Map(costRows.filter(row => row.kind === "keycount").map(row => [String(row.provider), numeric(row.unpriced_requests)])),
    unmetered: new Map(costRows.filter(row => row.kind === "keycount").map(row => [String(row.provider), numeric(row.unmetered_requests)])),
  };
}

async function summarizeRawInTransaction(
  tx: SQL,
  range: UsageRange,
  now: number,
  surface: UsageSurface,
  sinceOverride?: number | null,
  throughOverride?: number,
  options: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  const sinceMs = sinceOverride === undefined ? sinceForRange(range, now) : sinceOverride;
  const since = sinceMs === null ? null : new Date(sinceMs).toISOString();
  const throughMs = throughOverride ?? now;
  const through = new Date(throughMs).toISOString();
  const apiKeyId = options.apiKeyId?.trim();
  const wantKeys = options.byKey === true || (apiKeyId !== undefined && apiKeyId.length > 0);
  const apiKeyDimensionId = await resolveApiKeyDimensionId(tx, apiKeyId);
    const aggregateStartedAt = performance.now();
    const rows = await readAggregateRows(tx, since, surfaceMode(surface), through, apiKeyDimensionId, wantKeys);
    const aggregateMs = performance.now() - aggregateStartedAt;
    const totals = totalsFromRow(rows.totals[0]);
    const models = rows.models.map<UsageModel>(row => ({
      provider: String(row.provider),
      model: String(row.model),
      requests: numeric(row.requests),
      attemptCount: numeric(row.attempt_count),
      measuredRequests: numeric(row.measured_requests),
      reportedRequests: numeric(row.reported_requests),
      estimatedRequests: numeric(row.estimated_requests),
      totalTokens: numeric(row.total_tokens),
      inputTokens: numeric(row.input_tokens),
      outputTokens: numeric(row.output_tokens),
      shareRatio: totals.totalTokens === 0 ? 0 : numeric(row.total_tokens) / totals.totalTokens,
    })).sort(compareModels);
    const providers = rows.providers.map<UsageProvider>(row => ({
      provider: String(row.provider),
      requests: numeric(row.requests),
      attemptCount: numeric(row.attempt_count),
      measuredRequests: numeric(row.measured_requests),
      reportedRequests: numeric(row.reported_requests),
      estimatedRequests: numeric(row.estimated_requests),
      totalTokens: numeric(row.total_tokens),
      shareRatio: totals.totalTokens === 0 ? 0 : numeric(row.total_tokens) / totals.totalTokens,
    })).sort(compareProviders);
    const costStartedAt = performance.now();
    const keyCosts = await applyCosts(tx, since, surfaceMode(surface), through, totals, models, providers, apiKeyDimensionId, wantKeys);
    if (process.env.OPENCODEX_USAGE_POSTGRES_DIAGNOSTICS === "1") {
      console.info("[usage-postgres] summary timings", {
        range,
        surface,
        aggregateMs: Math.round(aggregateMs),
        costMs: Math.round(performance.now() - costStartedAt),
      });
    }
    // Token/status counts come from the request rows; cost and the priced/unpriced/unmetered split
    // come from the same cost pass the totals use, so the key rows always add up to the totals.
    const keys = rows.keys.map<UsageKey>(row => {
      const id = String(row.id);
      const requests = numeric(row.requests);
      const unpricedRequests = keyCosts.unpriced.get(id) ?? 0;
      const unmeteredRequests = keyCosts.unmetered.get(id) ?? 0;
      return {
        id,
        requests,
        attemptCount: numeric(row.attempt_count),
        measuredRequests: numeric(row.measured_requests),
        reportedRequests: numeric(row.reported_requests),
        estimatedRequests: numeric(row.estimated_requests),
        inputTokens: numeric(row.input_tokens),
        outputTokens: numeric(row.output_tokens),
        totalTokens: numeric(row.total_tokens),
        pricedRequests: Math.max(0, requests - unpricedRequests - unmeteredRequests),
        unpricedRequests,
        unmeteredRequests,
        estimatedCostUsd: keyCosts.costs.get(id) ?? 0,
      };
    }).sort((a, b) => b.requests - a.requests);
    return {
      range,
      surface,
      since: sinceMs,
      generatedAt: now,
      summary: totals,
      days: dayGrid(range, now, timestampMs(rows.totals[0]?.oldest_occurred_at), rows.days, rows.dayModels),
      models: cappedModels(models, totals.totalTokens),
      providers,
      keys,
      ...(apiKeyId !== undefined && apiKeyId.length > 0 ? { apiKeyId } : {}),
    };
}

export async function summarizeUsageRawFromPostgres(
  sql: SQL,
  range: UsageRange,
  now: number,
  surface: UsageSurface,
  options: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  return sql.begin("read only", tx => summarizeRawInTransaction(tx, range, now, surface, undefined, undefined, options));
}

const DASHBOARD_FILTER = `
  ($1::timestamptz IS NULL OR h.hour >= $1::timestamptz)
  AND h.hour <= $3::timestamptz
  AND (
    $2::smallint = 0
    OR ($2::smallint = 1 AND h.surface_code = 0)
    OR ($2::smallint = 2 AND h.surface_code IN (1, 2))
    OR ($2::smallint = 3 AND h.surface_code = 3)
  )
`;

function mergeSummaries(
  range: UsageRange,
  surface: UsageSurface,
  now: number,
  left: UsageSummary,
  right: UsageSummary,
): UsageSummary {
  const totals = zeroTotals();
  const totalKeys: Array<keyof Omit<UsageSummaryTotals, "coverageRatio">> = [
    "requests", "attemptCount", "measuredRequests", "reportedRequests",
    "unreportedRequests", "unsupportedRequests", "estimatedRequests", "inputTokens",
    "outputTokens", "cachedInputTokens", "cacheReadInputTokens", "cacheCreationInputTokens",
    "reasoningOutputTokens", "totalTokens", "estimatedCostUsd", "pricedRequests",
    "unpricedRequests", "unmeteredRequests",
  ];
  for (const key of totalKeys) totals[key] = left.summary[key] + right.summary[key];
  totals.coverageRatio = totals.requests === 0 ? 0 : totals.measuredRequests / totals.requests;

  const dayMap = new Map<string, UsageDay>();
  for (const source of [left, right]) {
    for (const day of source.days) {
      let target = dayMap.get(day.date);
      if (!target) {
        target = { date: day.date, requests: 0, measuredRequests: 0, reportedRequests: 0, totalTokens: 0, models: [] };
        dayMap.set(day.date, target);
      }
      target.requests += day.requests;
      target.measuredRequests += day.measuredRequests;
      target.reportedRequests += day.reportedRequests;
      target.totalTokens += day.totalTokens;
      const models = new Map(target.models.map(model => [`${model.provider}\0${model.model}`, model]));
      for (const model of day.models) {
        const key = `${model.provider}\0${model.model}`;
        const existing = models.get(key);
        if (existing) {
          existing.requests += model.requests;
          existing.attemptCount += model.attemptCount;
          existing.totalTokens += model.totalTokens;
        } else {
          const copy = { ...model };
          target.models.push(copy);
          models.set(key, copy);
        }
      }
    }
  }
  for (const day of dayMap.values()) capDayModels(day);

  const modelMap = new Map<string, UsageModel>();
  for (const source of [left, right]) {
    for (const model of source.models) {
      const key = `${model.provider}\0${model.model}`;
      let target = modelMap.get(key);
      if (!target) {
        target = { ...model, shareRatio: 0 };
        modelMap.set(key, target);
        continue;
      }
      target.requests += model.requests;
      target.attemptCount += model.attemptCount;
      target.measuredRequests += model.measuredRequests;
      target.reportedRequests += model.reportedRequests;
      target.estimatedRequests += model.estimatedRequests;
      target.totalTokens += model.totalTokens;
      target.inputTokens += model.inputTokens;
      target.outputTokens += model.outputTokens;
      if (model.estimatedCostUsd !== undefined) {
        target.estimatedCostUsd = (target.estimatedCostUsd ?? 0) + model.estimatedCostUsd;
      }
    }
  }
  const models = [...modelMap.values()].sort(compareModels);
  for (const model of models) model.shareRatio = totals.totalTokens === 0 ? 0 : model.totalTokens / totals.totalTokens;

  const providerMap = new Map<string, UsageProvider>();
  for (const source of [left, right]) {
    for (const provider of source.providers) {
      let target = providerMap.get(provider.provider);
      if (!target) {
        target = { ...provider, shareRatio: 0 };
        providerMap.set(provider.provider, target);
        continue;
      }
      target.requests += provider.requests;
      target.attemptCount += provider.attemptCount;
      target.measuredRequests += provider.measuredRequests;
      target.reportedRequests += provider.reportedRequests;
      target.estimatedRequests += provider.estimatedRequests;
      target.totalTokens += provider.totalTokens;
      if (provider.estimatedCostUsd !== undefined) {
        target.estimatedCostUsd = (target.estimatedCostUsd ?? 0) + provider.estimatedCostUsd;
      }
    }
  }
  const providers = [...providerMap.values()].sort(compareProviders);
  for (const provider of providers) provider.shareRatio = totals.totalTokens === 0 ? 0 : provider.totalTokens / totals.totalTokens;

  // Both halves of a key-filtered read are raw and already filtered, so the key rows merge the
  // same way the provider rows do. Unfiltered reads keep the empty list the rollups return.
  const keyMap = new Map<string, UsageKey>();
  for (const source of [left, right]) {
    for (const row of source.keys) {
      let target = keyMap.get(row.id);
      if (!target) {
        keyMap.set(row.id, { ...row, name: row.name });
        continue;
      }
      target.requests += row.requests;
      target.attemptCount += row.attemptCount;
      target.measuredRequests += row.measuredRequests;
      target.reportedRequests += row.reportedRequests;
      target.estimatedRequests += row.estimatedRequests;
      target.inputTokens += row.inputTokens;
      target.outputTokens += row.outputTokens;
      target.totalTokens += row.totalTokens;
      target.pricedRequests += row.pricedRequests;
      target.unpricedRequests += row.unpricedRequests;
      target.unmeteredRequests += row.unmeteredRequests;
      target.estimatedCostUsd += row.estimatedCostUsd;
      if (target.name === undefined && row.name !== undefined) target.name = row.name;
    }
  }
  const keys = [...keyMap.values()].sort((a, b) => b.requests - a.requests);

  return {
    range,
    surface,
    since: sinceForRange(range, now),
    generatedAt: now,
    summary: totals,
    days: [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
    models: cappedModels(models, totals.totalTokens),
    providers,
    keys,
    ...(left.apiKeyId ?? right.apiKeyId ? { apiKeyId: left.apiKeyId ?? right.apiKeyId } : {}),
  };
}

async function summarizeDashboardRollupsInTransaction(
  tx: SQL,
  range: UsageRange,
  now: number,
  surface: UsageSurface,
  sinceMs: number | null,
  throughMs = now,
): Promise<UsageSummary> {
  const since = sinceMs === null ? null : new Date(sinceMs).toISOString();
  const through = new Date(throughMs).toISOString();
  const params = [since, surfaceMode(surface), through];
  const totals = await tx.unsafe<SqlRow[]>(`
    SELECT sum(h.request_count) requests, min(h.oldest_occurred_at) oldest_occurred_at,
      sum(h.attempt_count) attempt_count,
      sum(h.measured_request_count) measured_requests,
      sum(h.reported_request_count) reported_requests,
      sum(h.unreported_request_count) unreported_requests,
      sum(h.unsupported_request_count) unsupported_requests,
      sum(h.estimated_request_count) estimated_requests,
      sum(h.input_tokens) input_tokens, sum(h.output_tokens) output_tokens,
      sum(h.cache_read_input_tokens) cache_read_input_tokens,
      sum(h.cache_creation_input_tokens) cache_creation_input_tokens,
      sum(h.reasoning_output_tokens) reasoning_output_tokens,
      sum(h.total_tokens) total_tokens, sum(h.estimated_cost_usd) estimated_cost_usd,
      sum(h.priced_request_count) priced_requests,
      sum(h.unpriced_request_count) unpriced_requests,
      sum(h.unmetered_request_count) unmetered_requests
    FROM opencodex_usage.dashboard_request_hourly h WHERE ${DASHBOARD_FILTER}
  `, params);
  const days = await tx.unsafe<SqlRow[]>(`
    SELECT to_char(h.hour AT TIME ZONE 'Asia/Singapore', 'YYYY-MM-DD') date,
      sum(h.request_count) requests,
      sum(h.measured_request_count) measured_requests,
      sum(h.reported_request_count) reported_requests,
      sum(h.total_tokens) total_tokens
    FROM opencodex_usage.dashboard_request_hourly h WHERE ${DASHBOARD_FILTER}
    GROUP BY 1 ORDER BY 1
  `, params);
  const dayModels = await tx.unsafe<SqlRow[]>(`
    SELECT to_char(h.hour AT TIME ZONE 'Asia/Singapore', 'YYYY-MM-DD') date,
      provider.value provider, model.value model,
      sum(h.request_count) requests, sum(h.attempt_count) attempt_count,
      sum(h.total_tokens) total_tokens
    FROM opencodex_usage.dashboard_model_hourly h
    JOIN opencodex_usage.dimensions provider ON provider.id = h.provider_id
    JOIN opencodex_usage.dimensions model ON model.id = h.model_id
    WHERE ${DASHBOARD_FILTER}
    GROUP BY 1, 2, 3 ORDER BY 1, requests DESC
  `, params);
  const modelRows = await tx.unsafe<SqlRow[]>(`
    SELECT provider.value provider, model.value model,
      sum(h.request_count) requests, sum(h.attempt_count) attempt_count,
      sum(h.measured_request_count) measured_requests,
      sum(h.reported_request_count) reported_requests,
      sum(h.estimated_request_count) estimated_requests,
      sum(h.total_tokens) total_tokens, sum(h.input_tokens) input_tokens,
      sum(h.output_tokens) output_tokens, sum(h.estimated_cost_usd) estimated_cost_usd,
      sum(h.priced_attribution_count) priced_attribution_count
    FROM opencodex_usage.dashboard_model_hourly h
    JOIN opencodex_usage.dimensions provider ON provider.id = h.provider_id
    JOIN opencodex_usage.dimensions model ON model.id = h.model_id
    WHERE ${DASHBOARD_FILTER}
    GROUP BY 1, 2 ORDER BY requests DESC
  `, params);
  const providerRows = await tx.unsafe<SqlRow[]>(`
    SELECT provider.value provider, sum(h.request_count) requests,
      sum(h.attempt_count) attempt_count,
      sum(h.measured_request_count) measured_requests,
      sum(h.reported_request_count) reported_requests,
      sum(h.estimated_request_count) estimated_requests,
      sum(h.total_tokens) total_tokens, sum(h.estimated_cost_usd) estimated_cost_usd,
      sum(h.priced_attribution_count) priced_attribution_count
    FROM opencodex_usage.dashboard_provider_hourly h
    JOIN opencodex_usage.dimensions provider ON provider.id = h.provider_id
    WHERE ${DASHBOARD_FILTER}
    GROUP BY 1 ORDER BY requests DESC
  `, params);
  const summaryTotals = totalsFromRow(totals[0]);
  // The hourly rollups are accumulators: repricing a past window zeroes the old buckets in place
  // (the ingest role may UPDATE but not DELETE), which leaves rows carrying no requests. Such a row
  // has nothing to say and would otherwise render an empty provider/model line in the dashboard,
  // so drop it here rather than teaching every reader to ignore it.
  const models = modelRows.map<UsageModel>(row => ({
    provider: String(row.provider), model: String(row.model),
    requests: numeric(row.requests), attemptCount: numeric(row.attempt_count),
    measuredRequests: numeric(row.measured_requests), reportedRequests: numeric(row.reported_requests),
    estimatedRequests: numeric(row.estimated_requests), totalTokens: numeric(row.total_tokens),
    inputTokens: numeric(row.input_tokens), outputTokens: numeric(row.output_tokens), shareRatio: 0,
    ...(numeric(row.priced_attribution_count) > 0 ? { estimatedCostUsd: numeric(row.estimated_cost_usd) } : {}),
  })).filter(model => model.requests > 0).sort(compareModels);
  const providers = providerRows.map<UsageProvider>(row => ({
    provider: String(row.provider), requests: numeric(row.requests), attemptCount: numeric(row.attempt_count),
    measuredRequests: numeric(row.measured_requests), reportedRequests: numeric(row.reported_requests),
    estimatedRequests: numeric(row.estimated_requests), totalTokens: numeric(row.total_tokens), shareRatio: 0,
    ...(numeric(row.priced_attribution_count) > 0 ? { estimatedCostUsd: numeric(row.estimated_cost_usd) } : {}),
  })).filter(provider => provider.requests > 0).sort(compareProviders);
  for (const model of models) model.shareRatio = summaryTotals.totalTokens === 0 ? 0 : model.totalTokens / summaryTotals.totalTokens;
  for (const provider of providers) provider.shareRatio = summaryTotals.totalTokens === 0 ? 0 : provider.totalTokens / summaryTotals.totalTokens;
  return {
    range, surface, since: sinceForRange(range, now), generatedAt: now, summary: summaryTotals,
    days: dayGrid(range, now, timestampMs(totals[0]?.oldest_occurred_at), days,
      dayModels.filter(row => numeric(row.requests) > 0)),
    models: cappedModels(models, summaryTotals.totalTokens), providers,
    // The read model carries no admission-key dimension; a key-filtered read never comes here.
    keys: [],
  };
}

export async function summarizeUsageFromPostgres(
  sql: SQL,
  range: UsageRange,
  now: number,
  surface: UsageSurface,
  options: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  const apiKeyId = options.apiKeyId?.trim();
  const wantsKeys = options.byKey === true || (apiKeyId !== undefined && apiKeyId.length > 0);
  // The hourly read model has no key dimension, so a key filter or the per-key breakdown is served
  // from the raw facts for the whole window. The dashboard already does this for the current hour;
  // the trade is a slower read for a view the rollups cannot answer at all.
  if (wantsKeys) return summarizeUsageRawFromPostgres(sql, range, now, surface, options);
  try {
    return await sql.begin("read only", async tx => {
      const state = await tx.unsafe<SqlRow[]>(`
        SELECT ready FROM opencodex_usage.dashboard_read_model_state WHERE singleton = true
      `);
      if (state[0]?.ready !== true) return summarizeRawInTransaction(tx, range, now, surface);
      const since = sinceForRange(range, now);
      const currentHourStart = Math.floor(now / 3_600_000) * 3_600_000;
      const tail = await summarizeRawInTransaction(tx, range, now, surface, currentHourStart, now);
      if (since === null) {
        const rollups = await summarizeDashboardRollupsInTransaction(
          tx, range, now, surface, null, currentHourStart - 1,
        );
        return mergeSummaries(range, surface, now, rollups, tail);
      }
      const completeHourStart = Math.ceil(since / 3_600_000) * 3_600_000;
      if (completeHourStart >= currentHourStart) return summarizeRawInTransaction(tx, range, now, surface);
      const head = completeHourStart > since
        ? await summarizeRawInTransaction(tx, range, now, surface, since, completeHourStart - 1)
        : { range, surface, since, generatedAt: now, summary: zeroTotals(), days: [], models: [], providers: [], keys: [] };
      const rollups = await summarizeDashboardRollupsInTransaction(
        tx, range, now, surface, completeHourStart, currentHourStart - 1,
      );
      return mergeSummaries(
        range,
        surface,
        now,
        mergeSummaries(range, surface, now, head, rollups),
        tail,
      );
    });
  } catch (error) {
    if (process.env.OPENCODEX_USAGE_POSTGRES_DIAGNOSTICS === "1") {
      console.warn("[usage-postgres] Dashboard read model unavailable; using normalized facts:",
        error instanceof Error ? error.message : error);
    }
    return summarizeUsageRawFromPostgres(sql, range, now, surface, options);
  }
}

/** Coalesce identical Dashboard reads and serve a recent snapshot while one background
 * refresh runs. PostgreSQL remains authoritative; this cache only removes repeated
 * aggregate work caused by pane switches and concurrent browser clients. */
export async function cachedUsageSummaryFromPostgres(
  sql: SQL,
  range: UsageRange,
  now: number,
  surface: UsageSurface,
  forceRefresh = false,
  windowKey = "latest",
  options: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  let cache = summaryCaches.get(sql);
  if (!cache) {
    cache = new Map();
    summaryCaches.set(sql, cache);
  }
  // The breakdown and any key narrowing change the payload, so they belong in the cache identity;
  // without this a filtered read could be served the unfiltered window (or the reverse).
  const scope = `${options.apiKeyId?.trim() ?? ""}|${options.byKey === true ? "keys" : ""}`;
  const base = windowKey === "latest" ? `${range}:${surface}` : `${range}:${surface}:${windowKey}`;
  const key = `${base}:${scope}`;
  if (!cache.has(key) && cache.size >= SUMMARY_CACHE_MAX_WINDOWS) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  const entry = cache.get(key) ?? {};
  cache.set(key, entry);
  const age = entry.loadedAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - entry.loadedAt;
  if (!forceRefresh && entry.value && age <= SUMMARY_CACHE_TTL_MS) return entry.value;

  if (!entry.inflight) {
    entry.inflight = summarizeUsageFromPostgres(sql, range, now, surface, options)
      .then(value => {
        entry.value = value;
        entry.loadedAt = Date.now();
        return value;
      })
      .finally(() => {
        entry.inflight = undefined;
      });
  }
  if (!forceRefresh && entry.value && age <= SUMMARY_CACHE_STALE_MS) {
    void entry.inflight.catch(error => {
      console.warn("[usage-postgres] background summary refresh failed:",
        error instanceof Error ? error.message : error);
    });
    return entry.value;
  }
  return entry.inflight;
}
