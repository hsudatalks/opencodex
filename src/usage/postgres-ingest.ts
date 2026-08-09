import { closeSync, existsSync, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import { SQL } from "bun";
import { canonicalAntigravityUsageModel } from "../providers/antigravity-models";
import { baseProviderLabel } from "../providers/label";
import {
  normalizeUsageEntryForTest,
  usageLedgerPaths,
  usageLogPath,
  usageSegmentTimestamp,
  type PersistedUsageAttempt,
  type PersistedUsageEntry,
} from "./log";

const DEFAULT_BATCH_ENTRIES = 500;
const DEFAULT_POLL_MS = 1_000;
const READ_CHUNK_BYTES = 256 * 1024;
const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const RETRY_MAX_MS = 30_000;

export const USAGE_DIMENSION_KIND = {
  provider: 1,
  model: 2,
  account: 3,
  effort: 4,
  reasoningField: 5,
  reasoningValue: 6,
  serviceTier: 7,
  speedLabel: 8,
  errorCode: 9,
  terminalStatus: 10,
  adapter: 11,
  profileId: 12,
  profileRevision: 13,
  decisionReason: 14,
  decisionTieBreak: 15,
  apiKey: 16,
} as const;

const SURFACE_CODES = { claude: 1, "claude-desktop": 2, grok: 3 } as const;
const ADMISSION_CODES = { configured: 1, environment: 2, loopback: 3 } as const;
const PROTOCOL_CODES = { responses: 1, chat: 2, messages: 3 } as const;
const USAGE_STATUS_CODES = { reported: 1, unreported: 2, unsupported: 3, estimated: 4 } as const;
const CLOSE_REASON_CODES = { terminal: 1, client_cancel: 2, non_stream: 3, body_stall: 4, body_overflow: 5 } as const;
const RECOVERY_CODES = {
  "transient-5xx": 1,
  "connection-reset": 2,
  "oauth-401": 3,
  "key-429": 4,
  "rate-limit-429": 5,
  "anthropic-oauth-429": 6,
  "image-413": 7,
} as const;
const ROUTE_KIND_CODES = {
  "explicit-account": 1,
  "explicit-provider": 2,
  native: 3,
  combo: 4,
  policy: 5,
  "default-provider": 6,
} as const;

type DimensionKind = typeof USAGE_DIMENSION_KIND[keyof typeof USAGE_DIMENSION_KIND];
type DimensionInput = { kind: DimensionKind; value: string };
type DimensionRow = DimensionInput & { id: number | string | bigint };
type SourceIdentity = { path: string; device: number; inode: number; size: number };
type UsageCursor = {
  source_id: string;
  source_path: string;
  source_device: number | string | bigint;
  source_inode: number | string | bigint;
  byte_offset: number | string | bigint;
};

export interface UsageLedgerBatch {
  identity: SourceIdentity;
  fromOffset: number;
  nextOffset: number;
  entries: PersistedUsageEntry[];
  invalidLines: number;
}

type ReasoningColumns = {
  reasoning_wire_value_id: number | null;
  reasoning_wire_number: number | null;
  reasoning_wire_boolean: boolean | null;
};

let sqlClient: SQL | null = null;
let workerTimer: ReturnType<typeof setTimeout> | null = null;
let workerFlight: Promise<void> | null = null;
let workerStopped = true;
let retryMs = DEFAULT_POLL_MS;
let lastWarningAt = 0;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sourceIdentity(path: string): SourceIdentity | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    return {
      path,
      device: Number(stat.dev),
      inode: Number(stat.ino),
      size: Number(stat.size),
    };
  } finally {
    closeSync(fd);
  }
}

function parseUsageLine(line: Buffer): PersistedUsageEntry | null {
  if (line.length === 0) return null;
  try {
    const parsed = JSON.parse(line.toString("utf-8")) as PersistedUsageEntry;
    if (!parsed || typeof parsed !== "object"
      || typeof parsed.requestId !== "string" || !parsed.requestId
      || typeof parsed.timestamp !== "number" || !Number.isFinite(parsed.timestamp)
      || typeof parsed.provider !== "string" || !parsed.provider
      || typeof parsed.model !== "string" || !parsed.model
      || typeof parsed.status !== "number"
      || typeof parsed.durationMs !== "number") return null;
    return normalizeUsageEntryForTest(parsed);
  } catch {
    return null;
  }
}

export function readUsageLedgerBatch(
  path: string,
  fromOffset: number,
  maxEntries = DEFAULT_BATCH_ENTRIES,
  maxBytes = MAX_BATCH_BYTES,
): UsageLedgerBatch | null {
  const identity = sourceIdentity(path);
  if (!identity) return null;
  const safeOffset = Number.isSafeInteger(fromOffset) && fromOffset >= 0 && fromOffset <= identity.size
    ? fromOffset
    : 0;
  const fd = openSync(path, "r");
  try {
    const entries: PersistedUsageEntry[] = [];
    const chunks: Buffer[] = [];
    const readBuffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let bufferedBytes = 0;
    let invalidLines = 0;
    let position = safeOffset;
    let nextOffset = safeOffset;
    let completeLines = 0;
    let oversized = false;

    while (position < identity.size && position - safeOffset < maxBytes && completeLines < maxEntries) {
      const remainingBudget = maxBytes - (position - safeOffset);
      const requested = Math.min(readBuffer.length, identity.size - position, remainingBudget);
      if (requested <= 0) break;
      const bytesRead = readSync(fd, readBuffer, 0, requested, position);
      if (bytesRead <= 0) break;
      let lineStart = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (readBuffer[index] !== 0x0a) continue;
        const segment = readBuffer.subarray(lineStart, index);
        let parsed: PersistedUsageEntry | null = null;
        if (!oversized && bufferedBytes + segment.length <= MAX_RECORD_BYTES) {
          const line = chunks.length === 0
            ? segment
            : Buffer.concat([...chunks, segment], bufferedBytes + segment.length);
          parsed = parseUsageLine(line);
        }
        if (parsed) entries.push(parsed);
        else invalidLines += 1;
        completeLines += 1;
        chunks.length = 0;
        bufferedBytes = 0;
        oversized = false;
        lineStart = index + 1;
        nextOffset = position + index + 1;
        if (completeLines >= maxEntries) break;
      }
      if (completeLines >= maxEntries) break;
      const remainder = readBuffer.subarray(lineStart, bytesRead);
      if (!oversized && bufferedBytes + remainder.length <= MAX_RECORD_BYTES) {
        chunks.push(Buffer.from(remainder));
        bufferedBytes += remainder.length;
      } else if (remainder.length > 0) {
        chunks.length = 0;
        bufferedBytes = 0;
        oversized = true;
      }
      position += bytesRead;
    }

    return { identity, fromOffset: safeOffset, nextOffset, entries, invalidLines };
  } finally {
    closeSync(fd);
  }
}

function lastCompleteOffset(path: string, size: number): number {
  if (size <= 0) return 0;
  const fd = openSync(path, "r");
  try {
    let end = size;
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size));
    while (end > 0) {
      const start = Math.max(0, end - buffer.length);
      const bytesRead = readSync(fd, buffer, 0, end - start, start);
      for (let index = bytesRead - 1; index >= 0; index--) {
        if (buffer[index] === 0x0a) return start + index + 1;
      }
      end = start;
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

function addDimension(target: Map<string, DimensionInput>, kind: DimensionKind, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) return;
  target.set(`${kind}\0${value}`, { kind, value });
}

function collectDimensions(entries: PersistedUsageEntry[]): DimensionInput[] {
  const values = new Map<string, DimensionInput>();
  for (const entry of entries) {
    addDimension(values, USAGE_DIMENSION_KIND.provider, entry.provider);
    addDimension(values, USAGE_DIMENSION_KIND.model, entry.model);
    addDimension(values, USAGE_DIMENSION_KIND.provider, baseProviderLabel(entry.provider));
    addDimension(values, USAGE_DIMENSION_KIND.model, requestUsageModel(entry));
    addDimension(values, USAGE_DIMENSION_KIND.model, entry.requestedModel);
    addDimension(values, USAGE_DIMENSION_KIND.model, entry.resolvedModel);
    addDimension(values, USAGE_DIMENSION_KIND.apiKey, entry.apiKeyId);
    addDimension(values, USAGE_DIMENSION_KIND.effort, entry.requestedEffort);
    addDimension(values, USAGE_DIMENSION_KIND.effort, entry.effectiveEffort);
    addDimension(values, USAGE_DIMENSION_KIND.reasoningField, entry.reasoningWireField);
    if (typeof entry.reasoningWireValue === "string") {
      addDimension(values, USAGE_DIMENSION_KIND.reasoningValue, entry.reasoningWireValue);
    }
    addDimension(values, USAGE_DIMENSION_KIND.serviceTier, entry.requestedServiceTier);
    addDimension(values, USAGE_DIMENSION_KIND.speedLabel, entry.requestedSpeedLabel);
    addDimension(values, USAGE_DIMENSION_KIND.serviceTier, entry.configuredServiceTier);
    addDimension(values, USAGE_DIMENSION_KIND.speedLabel, entry.configuredSpeedLabel);
    addDimension(values, USAGE_DIMENSION_KIND.serviceTier, entry.responseServiceTier);
    addDimension(values, USAGE_DIMENSION_KIND.errorCode, entry.errorCode);
    addDimension(values, USAGE_DIMENSION_KIND.terminalStatus, entry.terminalStatus);
    for (const attempt of entry.attempts ?? []) collectAttemptDimensions(values, attempt);
    const decision = entry.routeDecision;
    if (decision) {
      addDimension(values, USAGE_DIMENSION_KIND.profileId, decision.profile?.id);
      addDimension(values, USAGE_DIMENSION_KIND.profileRevision, decision.profile?.revision);
      addDimension(values, USAGE_DIMENSION_KIND.provider, decision.selected.provider);
      addDimension(values, USAGE_DIMENSION_KIND.model, decision.selected.model);
      addDimension(values, USAGE_DIMENSION_KIND.account, decision.selected.accountRef);
      addDimension(values, USAGE_DIMENSION_KIND.decisionReason, decision.selected.reason);
      addDimension(values, USAGE_DIMENSION_KIND.decisionTieBreak, decision.selected.tieBreak);
    }
  }
  return [...values.values()];
}

function collectAttemptDimensions(target: Map<string, DimensionInput>, attempt: PersistedUsageAttempt): void {
  addDimension(target, USAGE_DIMENSION_KIND.provider, attempt.provider);
  addDimension(target, USAGE_DIMENSION_KIND.model, attempt.model);
  addDimension(target, USAGE_DIMENSION_KIND.provider, baseProviderLabel(attempt.provider));
  addDimension(target, USAGE_DIMENSION_KIND.model, attributionUsageModel(attempt.provider, attempt.model));
  addDimension(target, USAGE_DIMENSION_KIND.adapter, attempt.adapter);
  addDimension(target, USAGE_DIMENSION_KIND.errorCode, attempt.errorCode);
  addDimension(target, USAGE_DIMENSION_KIND.effort, attempt.requestedEffort);
  addDimension(target, USAGE_DIMENSION_KIND.effort, attempt.effectiveEffort);
  addDimension(target, USAGE_DIMENSION_KIND.reasoningField, attempt.reasoningWireField);
  if (typeof attempt.reasoningWireValue === "string") {
    addDimension(target, USAGE_DIMENSION_KIND.reasoningValue, attempt.reasoningWireValue);
  }
}

function dimensionId(map: Map<string, number>, kind: DimensionKind, value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const id = map.get(`${kind}\0${value}`);
  if (id === undefined) throw new Error(`usage dimension missing for kind ${kind}`);
  return id;
}

function reasoningColumns(map: Map<string, number>, value: unknown): ReasoningColumns {
  return {
    reasoning_wire_value_id: typeof value === "string"
      ? dimensionId(map, USAGE_DIMENSION_KIND.reasoningValue, value)
      : null,
    reasoning_wire_number: typeof value === "number" ? value : null,
    reasoning_wire_boolean: typeof value === "boolean" ? value : null,
  };
}

function occurredAt(entry: PersistedUsageEntry): string {
  const date = new Date(entry.timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid usage timestamp for ${entry.requestId}`);
  return date.toISOString();
}

function attributionUsageModel(provider: string, model: string): string {
  return baseProviderLabel(provider) === "google-antigravity"
    ? canonicalAntigravityUsageModel(model)
    : model;
}

function requestUsageModel(entry: PersistedUsageEntry): string {
  if (baseProviderLabel(entry.provider) !== "google-antigravity") return entry.model;
  const fromModel = canonicalAntigravityUsageModel(entry.model);
  const fromResolved = entry.resolvedModel
    ? canonicalAntigravityUsageModel(entry.resolvedModel)
    : undefined;
  return fromModel !== entry.model
    ? fromModel
    : fromResolved && fromResolved !== entry.resolvedModel
      ? fromResolved
      : fromModel;
}

function requestRows(entries: PersistedUsageEntry[], dimensions: Map<string, number>): Array<Record<string, unknown>> {
  return entries.map(entry => ({
    occurred_at: occurredAt(entry),
    request_id: entry.requestId,
    provider_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.provider, entry.provider),
    model_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.model, entry.model),
    canonical_provider_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.provider, baseProviderLabel(entry.provider)),
    usage_model_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.model, requestUsageModel(entry)),
    surface_code: entry.surface ? SURFACE_CODES[entry.surface] : 0,
    api_key_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.apiKey, entry.apiKeyId),
    admission_code: entry.admissionKind ? ADMISSION_CODES[entry.admissionKind] : 0,
    protocol_code: entry.inboundProtocol ? PROTOCOL_CODES[entry.inboundProtocol] : 0,
    conversation_id: entry.conversationId ?? null,
    resolved_model_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.model, entry.resolvedModel),
    requested_model_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.model, entry.requestedModel),
    requested_effort_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.effort, entry.requestedEffort),
    effective_effort_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.effort, entry.effectiveEffort),
    reasoning_wire_field_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.reasoningField, entry.reasoningWireField),
    ...reasoningColumns(dimensions, entry.reasoningWireValue),
    requested_service_tier_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.serviceTier, entry.requestedServiceTier),
    requested_speed_label_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.speedLabel, entry.requestedSpeedLabel),
    configured_service_tier_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.serviceTier, entry.configuredServiceTier),
    configured_speed_label_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.speedLabel, entry.configuredSpeedLabel),
    model_supports_service_tier: entry.modelSupportsServiceTier ?? null,
    response_service_tier_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.serviceTier, entry.responseServiceTier),
    http_status: entry.status,
    duration_ms: entry.durationMs,
    first_output_ms: entry.firstOutputMs ?? null,
    usage_status_code: USAGE_STATUS_CODES[entry.usageStatus],
    input_tokens: entry.usage?.inputTokens ?? null,
    output_tokens: entry.usage?.outputTokens ?? null,
    context_total_tokens: entry.usage?.contextTotalTokens ?? null,
    cached_input_tokens: entry.usage?.cachedInputTokens ?? null,
    cache_read_input_tokens: entry.usage?.cacheReadInputTokens ?? null,
    cache_creation_input_tokens: entry.usage?.cacheCreationInputTokens ?? null,
    reasoning_output_tokens: entry.usage?.reasoningOutputTokens ?? null,
    total_tokens: entry.totalTokens ?? entry.usage?.totalTokens ?? null,
    attempt_count: entry.attempts?.length ?? 0,
    error_code_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.errorCode, entry.errorCode),
    terminal_status_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.terminalStatus, entry.terminalStatus),
    close_reason_code: entry.closeReason ? CLOSE_REASON_CODES[entry.closeReason] : 0,
  }));
}

function attemptRows(entries: PersistedUsageEntry[], dimensions: Map<string, number>): Array<Record<string, unknown>> {
  return entries.flatMap(entry => (entry.attempts ?? []).map(attempt => ({
    occurred_at: occurredAt(entry),
    request_id: entry.requestId,
    ordinal: attempt.ordinal,
    provider_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.provider, attempt.provider),
    model_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.model, attempt.model),
    canonical_provider_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.provider, baseProviderLabel(attempt.provider)),
    usage_model_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.model, attributionUsageModel(attempt.provider, attempt.model)),
    adapter_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.adapter, attempt.adapter),
    http_status: attempt.status,
    duration_ms: attempt.durationMs,
    first_output_ms: attempt.firstOutputMs ?? null,
    send_count: attempt.sendCount,
    usage_status_code: USAGE_STATUS_CODES[attempt.usageStatus],
    input_token_estimate: attempt.inputTokenEstimate ?? null,
    input_tokens: attempt.usage?.inputTokens ?? null,
    output_tokens: attempt.usage?.outputTokens ?? null,
    context_total_tokens: attempt.usage?.contextTotalTokens ?? null,
    cached_input_tokens: attempt.usage?.cachedInputTokens ?? null,
    cache_read_input_tokens: attempt.usage?.cacheReadInputTokens ?? null,
    cache_creation_input_tokens: attempt.usage?.cacheCreationInputTokens ?? null,
    reasoning_output_tokens: attempt.usage?.reasoningOutputTokens ?? null,
    total_tokens: attempt.totalTokens ?? attempt.usage?.totalTokens ?? null,
    error_code_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.errorCode, attempt.errorCode),
    requested_effort_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.effort, attempt.requestedEffort),
    effective_effort_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.effort, attempt.effectiveEffort),
    reasoning_wire_field_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.reasoningField, attempt.reasoningWireField),
    ...reasoningColumns(dimensions, attempt.reasoningWireValue),
  })));
}

function recoveryRows(entries: PersistedUsageEntry[]): Array<Record<string, unknown>> {
  return entries.flatMap(entry => (entry.attempts ?? []).flatMap(attempt => attempt.recoveryKinds.map(kind => ({
    occurred_at: occurredAt(entry),
    request_id: entry.requestId,
    ordinal: attempt.ordinal,
    recovery_code: RECOVERY_CODES[kind],
  }))));
}

function errorRows(entries: PersistedUsageEntry[]): Array<Record<string, unknown>> {
  return entries.flatMap(entry => entry.upstreamError ? [{
    occurred_at: occurredAt(entry),
    request_id: entry.requestId,
    upstream_error: entry.upstreamError,
  }] : []);
}

function routeRows(entries: PersistedUsageEntry[], dimensions: Map<string, number>): Array<Record<string, unknown>> {
  return entries.flatMap(entry => {
    const route = entry.routeDecision;
    if (!route) return [];
    return [{
      occurred_at: occurredAt(entry),
      request_id: entry.requestId,
      decision_id: route.decisionId,
      route_kind_code: ROUTE_KIND_CODES[route.routeKind],
      profile_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.profileId, route.profile?.id),
      profile_revision_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.profileRevision, route.profile?.revision),
      selected_provider_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.provider, route.selected.provider),
      selected_model_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.model, route.selected.model),
      selected_account_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.account, route.selected.accountRef),
      selected_reason_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.decisionReason, route.selected.reason),
      selected_tie_break_id: dimensionId(dimensions, USAGE_DIMENSION_KIND.decisionTieBreak, route.selected.tieBreak),
      candidate_count: route.candidates.length,
      trace: route,
    }];
  });
}

async function loadDimensions(tx: SQL, entries: PersistedUsageEntry[]): Promise<Map<string, number>> {
  const input = collectDimensions(entries);
  if (input.length === 0) return new Map();
  const payload = JSON.stringify(input);
  await tx.unsafe(`
    INSERT INTO opencodex_usage.dimensions (kind, value)
    SELECT DISTINCT kind, value
    FROM jsonb_to_recordset($1::jsonb) AS input(kind smallint, value text)
    ORDER BY kind, value
    ON CONFLICT (kind, value) DO NOTHING
  `, [payload]);
  const rows = await tx.unsafe<DimensionRow[]>(`
    WITH input AS (
      SELECT DISTINCT kind, value
      FROM jsonb_to_recordset($1::jsonb) AS source(kind smallint, value text)
    )
    SELECT dimensions.id, dimensions.kind, dimensions.value
    FROM opencodex_usage.dimensions AS dimensions
    INNER JOIN input USING (kind, value)
  `, [payload]);
  return new Map(rows.map(row => [`${row.kind}\0${row.value}`, Number(row.id)]));
}

async function ensurePartitions(tx: SQL, entries: PersistedUsageEntry[]): Promise<void> {
  const months = new Map<string, string>();
  for (const entry of entries) {
    const timestamp = occurredAt(entry);
    months.set(timestamp.slice(0, 7), timestamp);
  }
  for (const timestamp of months.values()) {
    await tx.unsafe("SELECT opencodex_usage.ensure_month_partitions($1::timestamptz)", [timestamp]);
  }
}

const REQUEST_INSERT_SQL = `
  WITH input AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
      occurred_at timestamptz, request_id text, provider_id bigint, model_id bigint,
      canonical_provider_id bigint, usage_model_id bigint,
      surface_code smallint, api_key_id bigint, admission_code smallint, protocol_code smallint,
      conversation_id text, resolved_model_id bigint, requested_model_id bigint,
      requested_effort_id bigint, effective_effort_id bigint, reasoning_wire_field_id bigint,
      reasoning_wire_value_id bigint, reasoning_wire_number double precision, reasoning_wire_boolean boolean,
      requested_service_tier_id bigint, requested_speed_label_id bigint,
      configured_service_tier_id bigint, configured_speed_label_id bigint,
      model_supports_service_tier boolean, response_service_tier_id bigint,
      http_status smallint, duration_ms bigint, first_output_ms bigint, usage_status_code smallint,
      input_tokens bigint, output_tokens bigint, context_total_tokens bigint, cached_input_tokens bigint,
      cache_read_input_tokens bigint, cache_creation_input_tokens bigint, reasoning_output_tokens bigint,
      total_tokens bigint, attempt_count smallint, error_code_id bigint, terminal_status_id bigint,
      close_reason_code smallint
    )
  ), inserted AS (
    INSERT INTO opencodex_usage.requests (
      occurred_at, request_id, provider_id, model_id, canonical_provider_id, usage_model_id,
      surface_code, api_key_id,
      admission_code, protocol_code, conversation_id, resolved_model_id, requested_model_id,
      requested_effort_id, effective_effort_id, reasoning_wire_field_id, reasoning_wire_value_id,
      reasoning_wire_number, reasoning_wire_boolean, requested_service_tier_id, requested_speed_label_id,
      configured_service_tier_id, configured_speed_label_id, model_supports_service_tier,
      response_service_tier_id, http_status, duration_ms, first_output_ms, usage_status_code,
      input_tokens, output_tokens, context_total_tokens, cached_input_tokens, cache_read_input_tokens,
      cache_creation_input_tokens, reasoning_output_tokens, total_tokens, attempt_count,
      error_code_id, terminal_status_id, close_reason_code
    )
    SELECT
      occurred_at, request_id, provider_id, model_id, canonical_provider_id, usage_model_id,
      surface_code, api_key_id,
      admission_code, protocol_code, conversation_id, resolved_model_id, requested_model_id,
      requested_effort_id, effective_effort_id, reasoning_wire_field_id, reasoning_wire_value_id,
      reasoning_wire_number, reasoning_wire_boolean, requested_service_tier_id, requested_speed_label_id,
      configured_service_tier_id, configured_speed_label_id, model_supports_service_tier,
      response_service_tier_id, http_status, duration_ms, first_output_ms, usage_status_code,
      input_tokens, output_tokens, context_total_tokens, cached_input_tokens, cache_read_input_tokens,
      cache_creation_input_tokens, reasoning_output_tokens, total_tokens, attempt_count,
      error_code_id, terminal_status_id, close_reason_code
    FROM input
    ON CONFLICT (occurred_at, request_id) DO NOTHING
    RETURNING *
  )
  INSERT INTO opencodex_usage.usage_hourly_rollups (
    hour, surface_code, provider_id, model_id, account_id,
    request_count, success_count, error_count, duration_ms_sum,
    first_output_ms_sum, first_output_count, input_tokens, output_tokens,
    cached_input_tokens, reasoning_output_tokens, total_tokens
  )
  SELECT
    date_trunc('hour', occurred_at), surface_code, provider_id, model_id, COALESCE(api_key_id, 0),
    count(*), count(*) FILTER (WHERE http_status < 400), count(*) FILTER (WHERE http_status >= 400),
    sum(duration_ms), sum(COALESCE(first_output_ms, 0)), count(first_output_ms),
    sum(COALESCE(input_tokens, 0)), sum(COALESCE(output_tokens, 0)),
    sum(COALESCE(cached_input_tokens, 0)), sum(COALESCE(reasoning_output_tokens, 0)),
    sum(COALESCE(total_tokens, 0))
  FROM inserted
  GROUP BY 1, 2, 3, 4, 5
  ORDER BY 1, 2, 3, 4, 5
  ON CONFLICT (hour, surface_code, provider_id, model_id, account_id) DO UPDATE SET
    request_count = opencodex_usage.usage_hourly_rollups.request_count + EXCLUDED.request_count,
    success_count = opencodex_usage.usage_hourly_rollups.success_count + EXCLUDED.success_count,
    error_count = opencodex_usage.usage_hourly_rollups.error_count + EXCLUDED.error_count,
    duration_ms_sum = opencodex_usage.usage_hourly_rollups.duration_ms_sum + EXCLUDED.duration_ms_sum,
    first_output_ms_sum = opencodex_usage.usage_hourly_rollups.first_output_ms_sum + EXCLUDED.first_output_ms_sum,
    first_output_count = opencodex_usage.usage_hourly_rollups.first_output_count + EXCLUDED.first_output_count,
    input_tokens = opencodex_usage.usage_hourly_rollups.input_tokens + EXCLUDED.input_tokens,
    output_tokens = opencodex_usage.usage_hourly_rollups.output_tokens + EXCLUDED.output_tokens,
    cached_input_tokens = opencodex_usage.usage_hourly_rollups.cached_input_tokens + EXCLUDED.cached_input_tokens,
    reasoning_output_tokens = opencodex_usage.usage_hourly_rollups.reasoning_output_tokens + EXCLUDED.reasoning_output_tokens,
    total_tokens = opencodex_usage.usage_hourly_rollups.total_tokens + EXCLUDED.total_tokens
`;

const ATTEMPT_INSERT_SQL = `
  INSERT INTO opencodex_usage.attempts (
    occurred_at, request_id, ordinal, provider_id, model_id, canonical_provider_id,
    usage_model_id, adapter_id, http_status,
    duration_ms, first_output_ms, send_count, usage_status_code, input_token_estimate,
    input_tokens, output_tokens, context_total_tokens, cached_input_tokens,
    cache_read_input_tokens, cache_creation_input_tokens, reasoning_output_tokens,
    total_tokens, error_code_id, requested_effort_id, effective_effort_id,
    reasoning_wire_field_id, reasoning_wire_value_id, reasoning_wire_number, reasoning_wire_boolean
  )
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
    occurred_at timestamptz, request_id text, ordinal smallint, provider_id bigint,
    model_id bigint, canonical_provider_id bigint, usage_model_id bigint,
    adapter_id bigint, http_status smallint, duration_ms bigint,
    first_output_ms bigint, send_count integer, usage_status_code smallint,
    input_token_estimate bigint, input_tokens bigint, output_tokens bigint,
    context_total_tokens bigint, cached_input_tokens bigint, cache_read_input_tokens bigint,
    cache_creation_input_tokens bigint, reasoning_output_tokens bigint, total_tokens bigint,
    error_code_id bigint, requested_effort_id bigint, effective_effort_id bigint,
    reasoning_wire_field_id bigint, reasoning_wire_value_id bigint,
    reasoning_wire_number double precision, reasoning_wire_boolean boolean
  )
  ON CONFLICT (occurred_at, request_id, ordinal) DO NOTHING
`;

async function ingestBatch(
  sql: SQL,
  sourceId: string,
  batch: UsageLedgerBatch,
): Promise<void> {
  await sql.begin(async tx => {
    if (batch.entries.length > 0) {
      await ensurePartitions(tx, batch.entries);
      const dimensions = await loadDimensions(tx, batch.entries);
      await tx.unsafe(REQUEST_INSERT_SQL, [JSON.stringify(requestRows(batch.entries, dimensions))]);
      const attempts = attemptRows(batch.entries, dimensions);
      if (attempts.length > 0) await tx.unsafe(ATTEMPT_INSERT_SQL, [JSON.stringify(attempts)]);
      const recoveries = recoveryRows(batch.entries);
      if (recoveries.length > 0) {
        await tx.unsafe(`
          INSERT INTO opencodex_usage.attempt_recoveries (occurred_at, request_id, ordinal, recovery_code)
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
            occurred_at timestamptz, request_id text, ordinal smallint, recovery_code smallint
          )
          ON CONFLICT (occurred_at, request_id, ordinal, recovery_code) DO NOTHING
        `, [JSON.stringify(recoveries)]);
      }
      const errors = errorRows(batch.entries);
      if (errors.length > 0) {
        await tx.unsafe(`
          INSERT INTO opencodex_usage.request_errors (occurred_at, request_id, upstream_error)
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
            occurred_at timestamptz, request_id text, upstream_error text
          )
          ON CONFLICT (occurred_at, request_id) DO NOTHING
        `, [JSON.stringify(errors)]);
      }
      const routes = routeRows(batch.entries, dimensions);
      if (routes.length > 0) {
        await tx.unsafe(`
          INSERT INTO opencodex_usage.route_decisions (
            occurred_at, request_id, decision_id, route_kind_code, profile_id, profile_revision_id,
            selected_provider_id, selected_model_id, selected_account_id, selected_reason_id,
            selected_tie_break_id, candidate_count, trace
          )
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
            occurred_at timestamptz, request_id text, decision_id text, route_kind_code smallint,
            profile_id bigint, profile_revision_id bigint, selected_provider_id bigint,
            selected_model_id bigint, selected_account_id bigint, selected_reason_id bigint,
            selected_tie_break_id bigint, candidate_count smallint, trace jsonb
          )
          ON CONFLICT (occurred_at, request_id) DO NOTHING
        `, [JSON.stringify(routes)]);
      }
    }
    const latest = batch.entries.at(-1);
    await tx.unsafe(`
      INSERT INTO opencodex_usage.ingestion_cursors (
        source_id, source_path, source_device, source_inode, byte_offset,
        invalid_lines, last_occurred_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, now())
      ON CONFLICT (source_id) DO UPDATE SET
        source_path = EXCLUDED.source_path,
        source_device = EXCLUDED.source_device,
        source_inode = EXCLUDED.source_inode,
        byte_offset = EXCLUDED.byte_offset,
        invalid_lines = opencodex_usage.ingestion_cursors.invalid_lines + EXCLUDED.invalid_lines,
        last_occurred_at = COALESCE(EXCLUDED.last_occurred_at, opencodex_usage.ingestion_cursors.last_occurred_at),
        updated_at = now()
    `, [
      sourceId,
      batch.identity.path,
      batch.identity.device,
      batch.identity.inode,
      batch.nextOffset,
      batch.invalidLines,
      latest ? occurredAt(latest) : null,
    ]);
  });
}

async function readCursor(sql: SQL, sourceId: string): Promise<UsageCursor | null> {
  const rows = await sql.unsafe<UsageCursor[]>(`
    SELECT source_id, source_path, source_device, source_inode, byte_offset
    FROM opencodex_usage.ingestion_cursors
    WHERE source_id = $1
  `, [sourceId]);
  return rows[0] ?? null;
}

async function initializeCursor(sql: SQL, sourceId: string, identity: SourceIdentity, isSegment: boolean): Promise<number> {
  const startMode = process.env.OPENCODEX_USAGE_POSTGRES_START_MODE === "backfill" ? "backfill" : "tail";
  const initialOffset = isSegment || startMode === "backfill" ? 0 : lastCompleteOffset(identity.path, identity.size);
  await sql.unsafe(`
    INSERT INTO opencodex_usage.ingestion_cursors (
      source_id, source_path, source_device, source_inode, byte_offset
    ) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (source_id) DO NOTHING
  `, [sourceId, identity.path, identity.device, identity.inode, initialOffset]);
  const cursor = await readCursor(sql, sourceId);
  return cursor ? Number(cursor.byte_offset) : initialOffset;
}

function ledgerSourceId(baseSourceId: string, path: string): string {
  return path === usageLogPath() ? baseSourceId : `${baseSourceId}:segment:${basename(path)}`;
}

async function pollUsagePostgresPath(sql: SQL, baseSourceId: string, path: string): Promise<boolean> {
  const sourceId = ledgerSourceId(baseSourceId, path);
  const identity = sourceIdentity(path);
  if (!identity) return false;
  const cursor = await readCursor(sql, sourceId);
  const isSegment = usageSegmentTimestamp(path) !== null;
  let offset = cursor ? Number(cursor.byte_offset) : await initializeCursor(sql, sourceId, identity, isSegment);
  if (cursor && (
    Number(cursor.source_device) !== identity.device
    || Number(cursor.source_inode) !== identity.inode
    || offset > identity.size
  )) offset = 0;
  const batch = readUsageLedgerBatch(
    path,
    offset,
    positiveInteger(process.env.OPENCODEX_USAGE_POSTGRES_BATCH_ENTRIES, DEFAULT_BATCH_ENTRIES),
  );
  if (!batch || batch.nextOffset === offset) return false;
  await ingestBatch(sql, sourceId, batch);
  return true;
}

async function removeAcknowledgedExpiredSegments(sql: SQL, baseSourceId: string): Promise<void> {
  const retentionHours = positiveInteger(process.env.OPENCODEX_USAGE_SEGMENT_RETENTION_HOURS, 168);
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1_000;
  for (const path of usageLedgerPaths()) {
    const segmentTimestamp = usageSegmentTimestamp(path);
    if (segmentTimestamp === null || segmentTimestamp >= cutoff) continue;
    const identity = sourceIdentity(path);
    if (!identity) continue;
    const cursor = await readCursor(sql, ledgerSourceId(baseSourceId, path));
    if (!cursor
      || Number(cursor.source_device) !== identity.device
      || Number(cursor.source_inode) !== identity.inode
      || Number(cursor.byte_offset) < identity.size) continue;
    try { unlinkSync(path); } catch { /* retention is best-effort; retry next poll */ }
  }
}

async function pollUsagePostgresOnce(sql: SQL, sourceId: string): Promise<boolean> {
  for (const path of usageLedgerPaths()) {
    if (await pollUsagePostgresPath(sql, sourceId, path)) return true;
  }
  await removeAcknowledgedExpiredSegments(sql, sourceId);
  return false;
}

function warnThrottled(error: unknown): void {
  const now = Date.now();
  if (now - lastWarningAt < 30_000) return;
  lastWarningAt = now;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[usage-postgres] ingestion delayed; recoverable JSONL WAL retained: ${message}`);
}

function scheduleNext(delayMs: number): void {
  if (workerStopped) return;
  workerTimer = setTimeout(runWorkerTick, delayMs);
  workerTimer.unref?.();
}

function runWorkerTick(): void {
  if (workerStopped || !sqlClient || workerFlight) return;
  const sourceId = process.env.OPENCODEX_USAGE_SOURCE_ID?.trim() || `usage:${hostname()}`;
  const client = sqlClient;
  workerFlight = pollUsagePostgresOnce(client, sourceId)
    .then(hasMore => {
      retryMs = DEFAULT_POLL_MS;
      scheduleNext(hasMore ? 0 : positiveInteger(process.env.OPENCODEX_USAGE_POSTGRES_POLL_MS, DEFAULT_POLL_MS));
    })
    .catch(error => {
      warnThrottled(error);
      retryMs = Math.min(RETRY_MAX_MS, Math.max(DEFAULT_POLL_MS, retryMs * 2));
      scheduleNext(retryMs);
    })
    .finally(() => {
      workerFlight = null;
    });
}

export function startUsagePostgresIngestion(): boolean {
  const databaseUrl = process.env.OPENCODEX_USAGE_DATABASE_URL?.trim();
  if (!databaseUrl || !workerStopped) return false;
  sqlClient = new SQL(databaseUrl, {
    max: positiveInteger(process.env.OPENCODEX_USAGE_POSTGRES_POOL_SIZE, 2),
    idleTimeout: 30,
    connectionTimeout: 10,
    // Supabase's port 6543 is a transaction pooler. Named prepared statements
    // are connection-local and can collide when the pooler reuses a backend.
    prepare: false,
  });
  workerStopped = false;
  retryMs = DEFAULT_POLL_MS;
  scheduleNext(0);
  return true;
}

export function usagePostgresClient(): SQL | null {
  return sqlClient;
}

export async function stopUsagePostgresIngestion(): Promise<void> {
  workerStopped = true;
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
  const flight = workerFlight;
  if (flight) await flight.catch(() => {});
  workerFlight = null;
  const client = sqlClient;
  sqlClient = null;
  if (client) await client.close({ timeout: 1 }).catch(() => {});
}

export function resetUsagePostgresIngestionForTests(): void {
  workerStopped = true;
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
  workerFlight = null;
  sqlClient = null;
  retryMs = DEFAULT_POLL_MS;
  lastWarningAt = 0;
}
