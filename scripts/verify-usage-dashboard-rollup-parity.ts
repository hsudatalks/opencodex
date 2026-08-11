import { SQL } from "bun";
import {
  summarizeUsageFromPostgres,
  summarizeUsageRawFromPostgres,
} from "../src/usage/postgres-summary";
import type { UsageRange, UsageSurface } from "../src/usage/summary";

const databaseUrl = process.env["OPENCODEX_USAGE_DATABASE_URL"]?.trim();
if (!databaseUrl) throw new Error("OPENCODEX_USAGE_DATABASE_URL is required");

function normalized(value: unknown): unknown {
  if (typeof value === "number") return Number.isInteger(value) ? value : Number(value.toFixed(9));
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalized(child)]));
  }
  return value;
}

function differences(left: unknown, right: unknown, path = "$", out: string[] = []): string[] {
  if (out.length >= 32) return out;
  if (Object.is(left, right)) return out;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) out.push(`${path}.length: ${left.length} != ${right.length}`);
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      differences(left[index], right[index], `${path}[${index}]`, out);
    }
    return out;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      differences(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        `${path}.${key}`,
        out,
      );
    }
    return out;
  }
  out.push(`${path}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
  return out;
}

const sql = new SQL(databaseUrl, { max: 2, prepare: false });
const ranges: UsageRange[] = ["7d", "30d", "all"];
const surfaces: UsageSurface[] = ["all", "codex", "claude", "grok"];
const settlementLagMs = Number(process.env["OPENCODEX_USAGE_PARITY_SETTLEMENT_MS"] ?? 300_000);
if (!Number.isFinite(settlementLagMs) || settlementLagMs < 0) {
  throw new Error("OPENCODEX_USAGE_PARITY_SETTLEMENT_MS must be a non-negative number");
}
// Raw and read-model summaries use separate read transactions so their timings remain
// representative. Compare a settled cutoff to prevent concurrent ingestion from making
// the second transaction appear to contain more history than the first.
const now = Date.now() - settlementLagMs;

try {
  for (const range of ranges) {
    for (const surface of surfaces) {
      const rawStartedAt = performance.now();
      const raw = await summarizeUsageRawFromPostgres(sql, range, now, surface);
      const rawMs = performance.now() - rawStartedAt;
      const readModelStartedAt = performance.now();
      const readModel = await summarizeUsageFromPostgres(sql, range, now, surface);
      const readModelMs = performance.now() - readModelStartedAt;
      const normalizedReadModel = normalized(readModel);
      const normalizedRaw = normalized(raw);
      if (!Bun.deepEquals(normalizedReadModel, normalizedRaw)) {
        throw new Error(
          `Usage parity failed for ${range}/${surface}: raw=${raw.summary.requests} requests, read-model=${readModel.summary.requests} requests\n${differences(normalizedReadModel, normalizedRaw).join("\n")}`,
        );
      }
      console.log(`${range}/${surface}: raw=${rawMs.toFixed(1)}ms read-model=${readModelMs.toFixed(1)}ms`);
    }
  }
} finally {
  await sql.close();
}
