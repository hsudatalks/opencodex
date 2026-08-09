import { SQL } from "bun";
import { readUsageEntries } from "../src/usage/log";
import { summarizeUsage, type UsageRange, type UsageSurface } from "../src/usage/summary";
import { summarizeUsageFromPostgres } from "../src/usage/postgres-summary";

const databaseUrl = process.env["OPENCODEX_USAGE_DATABASE_URL"]?.trim();
if (!databaseUrl) throw new Error("OPENCODEX_USAGE_DATABASE_URL is required");

const allEntries = readUsageEntries();
if (allEntries.length === 0) throw new Error("usage.jsonl is empty or unavailable under OPENCODEX_HOME");

// Leave a stable tail behind: a live process may append a completed request with an
// earlier start timestamp after the ledger snapshot has already been copied.
const through = Date.now() - 10 * 60 * 1_000;
const entries = allEntries.filter(entry => entry.timestamp <= through);
const sql = new SQL(databaseUrl, { max: 2, prepare: false });
const ranges: UsageRange[] = ["7d", "30d", "all"];
const surfaces: UsageSurface[] = ["all", "codex", "claude", "grok"];

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    const rows = value.map(canonical);
    if (rows.every(row => row && typeof row === "object" && !Array.isArray(row))) {
      const key = (row: unknown): string => {
        const record = row as Record<string, unknown>;
        return [record["date"], record["provider"], record["model"]].map(part => String(part ?? "")).join("\0");
      };
      return rows.sort((left, right) => key(left).localeCompare(key(right)));
    }
    return rows;
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().flatMap(key => {
    if (key === "generatedAt" || key === "resolvedModel") return [];
    return [[key, canonical(record[key])]];
  }));
}

function differences(left: unknown, right: unknown, path = "$", out: string[] = []): string[] {
  if (out.length >= 100) return out;
  if (typeof left === "number" && typeof right === "number") {
    const tolerance = Math.max(1e-9, Math.abs(left) * 1e-9, Math.abs(right) * 1e-9);
    if (Math.abs(left - right) > tolerance) out.push(`${path}: jsonl=${left} postgres=${right}`);
    return out;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) out.push(`${path}.length: jsonl=${left.length} postgres=${right.length}`);
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index++) differences(left[index], right[index], `${path}[${index}]`, out);
    return out;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      differences((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${path}.${key}`, out);
    }
    return out;
  }
  if (left !== right) out.push(`${path}: jsonl=${JSON.stringify(left)} postgres=${JSON.stringify(right)}`);
  return out;
}

let failed = false;
try {
  for (const range of ranges) {
    for (const surface of surfaces) {
      const jsonlStartedAt = performance.now();
      const jsonl = summarizeUsage(entries, range, through, surface);
      const jsonlMs = Math.round(performance.now() - jsonlStartedAt);
      const postgresStartedAt = performance.now();
      const postgres = await summarizeUsageFromPostgres(sql, range, through, surface);
      const postgresMs = Math.round(performance.now() - postgresStartedAt);
      const mismatches = differences(canonical(jsonl), canonical(postgres));
      if (mismatches.length === 0) {
        console.log(`PASS range=${range} surface=${surface} requests=${jsonl.summary.requests} jsonl=${jsonlMs}ms postgres=${postgresMs}ms`);
        continue;
      }
      failed = true;
      console.error(`FAIL range=${range} surface=${surface} mismatches=${mismatches.length} jsonl=${jsonlMs}ms postgres=${postgresMs}ms`);
      for (const mismatch of mismatches.slice(0, 20)) console.error(`  ${mismatch}`);
    }
  }
} finally {
  await sql.close();
}

if (failed) process.exitCode = 1;
