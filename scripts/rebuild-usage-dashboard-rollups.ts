import { SQL } from "bun";
import { usageLedgerPaths } from "../src/usage/log";
import {
  appendUsageDashboardRollups,
  clearUsageDashboardRollups,
  markUsageDashboardRollupsReady,
  readUsageLedgerBatch,
} from "../src/usage/postgres-ingest";

const databaseUrl = process.env["OPENCODEX_USAGE_DATABASE_URL"]?.trim();
if (!databaseUrl) throw new Error("OPENCODEX_USAGE_DATABASE_URL is required");

const sql = new SQL(databaseUrl, { max: 2, prepare: false });
const seen = new Set<string>();
let scanned = 0;
let processed = 0;

async function existingRequestKeys(entries: Array<{ timestamp: number; requestId: string }>): Promise<Set<string>> {
  if (entries.length === 0) return new Set();
  const input = entries.map(entry => ({
    occurred_at: new Date(entry.timestamp).toISOString(),
    request_id: entry.requestId,
  }));
  const rows = await sql.unsafe<Array<{ occurred_at: Date | string; request_id: string }>>(`
    WITH input AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
        occurred_at timestamptz, request_id text
      )
    )
    SELECT r.occurred_at, r.request_id
    FROM input
    JOIN opencodex_usage.requests r USING (occurred_at, request_id)
  `, [JSON.stringify(input)]);
  return new Set(rows.map(row => {
    const occurredAt = row.occurred_at instanceof Date
      ? row.occurred_at.toISOString()
      : new Date(row.occurred_at).toISOString();
    return `${occurredAt}\0${row.request_id}`;
  }));
}

try {
  await clearUsageDashboardRollups(sql);
  for (const path of usageLedgerPaths()) {
    let offset = 0;
    while (true) {
      const batch = readUsageLedgerBatch(path, offset, 500);
      if (!batch || batch.nextOffset === offset) break;
      offset = batch.nextOffset;
      scanned += batch.entries.length;
      const deduplicated = batch.entries.filter(entry => {
        const key = `${entry.timestamp}\0${entry.requestId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const existing = await existingRequestKeys(deduplicated);
      const entries = deduplicated.filter(entry => existing.has(
        `${new Date(entry.timestamp).toISOString()}\0${entry.requestId}`,
      ));
      await appendUsageDashboardRollups(sql, entries);
      processed += entries.length;
      if (processed > 0 && processed % 10_000 < entries.length) {
        console.log(`rebuilt ${processed} usage requests`);
      }
    }
  }
  await markUsageDashboardRollupsReady(sql);
  console.log(`rebuilt ${processed} of ${scanned} scanned usage requests into Dashboard hourly read models`);
} finally {
  await sql.close();
}
