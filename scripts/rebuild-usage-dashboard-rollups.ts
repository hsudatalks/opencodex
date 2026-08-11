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
let processed = 0;

try {
  await clearUsageDashboardRollups(sql);
  for (const path of usageLedgerPaths()) {
    let offset = 0;
    while (true) {
      const batch = readUsageLedgerBatch(path, offset, 500);
      if (!batch || batch.nextOffset === offset) break;
      offset = batch.nextOffset;
      const entries = batch.entries.filter(entry => {
        const key = `${entry.timestamp}\0${entry.requestId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      await appendUsageDashboardRollups(sql, entries);
      processed += entries.length;
      if (processed > 0 && processed % 10_000 < entries.length) {
        console.log(`rebuilt ${processed} usage requests`);
      }
    }
  }
  await markUsageDashboardRollupsReady(sql);
  console.log(`rebuilt ${processed} usage requests into Dashboard hourly read models`);
} finally {
  await sql.close();
}
