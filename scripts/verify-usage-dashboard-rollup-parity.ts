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

const sql = new SQL(databaseUrl, { max: 2, prepare: false });
const ranges: UsageRange[] = ["7d", "30d", "all"];
const surfaces: UsageSurface[] = ["all", "codex", "claude", "grok"];
const now = Date.now() - 5_000;

try {
  for (const range of ranges) {
    for (const surface of surfaces) {
      const rawStartedAt = performance.now();
      const raw = await summarizeUsageRawFromPostgres(sql, range, now, surface);
      const rawMs = performance.now() - rawStartedAt;
      const readModelStartedAt = performance.now();
      const readModel = await summarizeUsageFromPostgres(sql, range, now, surface);
      const readModelMs = performance.now() - readModelStartedAt;
      if (!Bun.deepEquals(normalized(readModel), normalized(raw))) {
        throw new Error(
          `Usage parity failed for ${range}/${surface}: raw=${raw.summary.requests} requests, read-model=${readModel.summary.requests} requests`,
        );
      }
      console.log(`${range}/${surface}: raw=${rawMs.toFixed(1)}ms read-model=${readModelMs.toFixed(1)}ms`);
    }
  }
} finally {
  await sql.close();
}
