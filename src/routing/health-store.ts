import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import type { PersistedUsageEntry } from "../usage/log";

export const ROUTING_HEALTH_DB_FILENAME = "routing-health.sqlite";
export const ROUTING_HEALTH_WINDOW_MS = 14 * 86_400_000;
export const ROUTING_HEALTH_MAX_SAMPLES = 100;
export const ROUTING_HEALTH_MAX_TOTAL_SAMPLES = 100_000;

const ROUTING_HEALTH_SCHEMA_VERSION = 1;
const PRUNE_INTERVAL = 256;

const HEALTH_DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS samples (
  request_id      TEXT NOT NULL,
  ordinal         INTEGER NOT NULL,
  timestamp       INTEGER NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  api_key_id      TEXT,
  status          INTEGER NOT NULL,
  close_reason    TEXT,
  terminal_status TEXT,
  duration_ms     INTEGER NOT NULL,
  PRIMARY KEY (request_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_health_target_time
  ON samples(provider, model, timestamp DESC, ordinal DESC);
CREATE INDEX IF NOT EXISTS idx_health_target_account_time
  ON samples(provider, model, api_key_id, timestamp DESC, ordinal DESC);
`;

export interface RoutingHealthSample {
  status: number;
  closeReason: string | null;
  terminalStatus: string | null;
  durationMs: number;
  timestamp: number;
}

export interface RoutingHealthStoreStats {
  path: string;
  sampleCount: number;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
  pageCount: number;
  pageSize: number;
}

interface StoredSample extends RoutingHealthSample {
  requestId: string;
  ordinal: number;
  provider: string;
  model: string;
  apiKeyId: string | null;
}

let db: Database | null = null;
let dbPath = "";
let insertsSincePrune = 0;
let sampleCountEstimate = 0;

export function routingHealthStorePath(): string {
  return join(getConfigDir(), ROUTING_HEALTH_DB_FILENAME);
}

function closeCurrentStore(): void {
  if (!db) return;
  try { db.close(); } catch { /* best effort during config-root changes */ }
  db = null;
  dbPath = "";
  insertsSincePrune = 0;
  sampleCountEstimate = 0;
}

function openRoutingHealthStore(): Database {
  const path = routingHealthStorePath();
  if (db && dbPath === path) return db;
  closeCurrentStore();

  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* unsupported on some platforms */ }
  recordOwnedConfigPath(dir, path);

  const handle = new Database(path, { create: true });
  handle.exec("PRAGMA journal_mode = WAL");
  handle.exec("PRAGMA synchronous = NORMAL");
  handle.exec("PRAGMA busy_timeout = 100");
  handle.exec(HEALTH_DDL);
  handle.query(
    "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) "
      + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(ROUTING_HEALTH_SCHEMA_VERSION));
  try { chmodSync(path, 0o600); } catch { /* unsupported on some platforms */ }
  db = handle;
  dbPath = path;
  sampleCountEstimate = Number(
    (handle.query("SELECT COUNT(*) AS count FROM samples").get() as { count: number }).count,
  );
  return handle;
}

function samplesForEntry(entry: PersistedUsageEntry): StoredSample[] {
  if (entry.attempts && entry.attempts.length > 0) {
    return entry.attempts.map(attempt => ({
      requestId: entry.requestId,
      ordinal: attempt.ordinal,
      timestamp: entry.timestamp,
      provider: attempt.provider,
      model: attempt.model,
      apiKeyId: entry.apiKeyId ?? null,
      status: attempt.status,
      closeReason: null,
      terminalStatus: null,
      durationMs: attempt.durationMs,
    }));
  }
  return [{
    requestId: entry.requestId,
    ordinal: 0,
    timestamp: entry.timestamp,
    provider: entry.provider,
    model: entry.model,
    apiKeyId: entry.apiKeyId ?? null,
    status: entry.status,
    closeReason: entry.closeReason ?? null,
    terminalStatus: entry.terminalStatus ?? null,
    durationMs: entry.durationMs,
  }];
}

function pruneRoutingHealthStore(handle: Database, now: number): void {
  const prune = handle.transaction(() => {
    handle.query("DELETE FROM samples WHERE timestamp < ?").run(now - ROUTING_HEALTH_WINDOW_MS);
    handle.exec(`
      DELETE FROM samples WHERE rowid IN (
        SELECT rowid FROM (
          SELECT rowid,
                 ROW_NUMBER() OVER (
                   PARTITION BY provider, model, COALESCE(api_key_id, '')
                   ORDER BY timestamp DESC, ordinal DESC
                 ) AS sample_rank
          FROM samples
        ) ranked
        WHERE sample_rank > ${ROUTING_HEALTH_MAX_SAMPLES}
      )
    `);
    handle.query(`
      DELETE FROM samples WHERE rowid IN (
        SELECT rowid FROM samples
        ORDER BY timestamp DESC, ordinal DESC
        LIMIT -1 OFFSET ?
      )
    `).run(ROUTING_HEALTH_MAX_TOTAL_SAMPLES);
  });
  prune();
  insertsSincePrune = 0;
  sampleCountEstimate = Number(
    (handle.query("SELECT COUNT(*) AS count FROM samples").get() as { count: number }).count,
  );
}

/**
 * Best-effort hot-path projection. Request logging remains authoritative and
 * must not fail just because this disposable health projection is unavailable.
 */
export function recordRoutingHealthEntry(entry: PersistedUsageEntry): void {
  try {
    const handle = openRoutingHealthStore();
    const samples = samplesForEntry(entry);
    const insert = handle.query(`
      INSERT INTO samples (
        request_id, ordinal, timestamp, provider, model, api_key_id,
        status, close_reason, terminal_status, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id, ordinal) DO UPDATE SET
        timestamp = excluded.timestamp,
        provider = excluded.provider,
        model = excluded.model,
        api_key_id = excluded.api_key_id,
        status = excluded.status,
        close_reason = excluded.close_reason,
        terminal_status = excluded.terminal_status,
        duration_ms = excluded.duration_ms
    `);
    const write = handle.transaction((rows: StoredSample[]) => {
      for (const sample of rows) {
        insert.run(
          sample.requestId,
          sample.ordinal,
          sample.timestamp,
          sample.provider,
          sample.model,
          sample.apiKeyId,
          sample.status,
          sample.closeReason,
          sample.terminalStatus,
          sample.durationMs,
        );
      }
    });
    write(samples);
    insertsSincePrune += samples.length;
    sampleCountEstimate += samples.length;
    if (insertsSincePrune >= PRUNE_INTERVAL || sampleCountEstimate > ROUTING_HEALTH_MAX_TOTAL_SAMPLES) {
      pruneRoutingHealthStore(handle, entry.timestamp);
    }
  } catch {
    /* Disposable projection: JSONL/Postgres remain authoritative. */
  }
}

export function recentRoutingHealthSamples(input: {
  provider: string;
  model: string;
  accountRef?: string;
  now?: number;
}): RoutingHealthSample[] {
  try {
    const handle = openRoutingHealthStore();
    const where = ["provider = ?", "model = ?", "timestamp >= ?"];
    const values: Array<string | number> = [
      input.provider,
      input.model,
      (input.now ?? Date.now()) - ROUTING_HEALTH_WINDOW_MS,
    ];
    if (input.accountRef) {
      where.push("api_key_id = ?");
      values.push(input.accountRef);
    }
    return handle.query(`
      SELECT status,
             close_reason AS closeReason,
             terminal_status AS terminalStatus,
             duration_ms AS durationMs,
             timestamp
      FROM samples
      WHERE ${where.join(" AND ")}
      ORDER BY timestamp DESC, ordinal DESC
      LIMIT ?
    `).all(...values, ROUTING_HEALTH_MAX_SAMPLES) as RoutingHealthSample[];
  } catch {
    return [];
  }
}

export function routingHealthStoreStats(): RoutingHealthStoreStats {
  const handle = openRoutingHealthStore();
  const aggregate = handle.query(`
    SELECT COUNT(*) AS sampleCount,
           MIN(timestamp) AS oldestTimestamp,
           MAX(timestamp) AS newestTimestamp
    FROM samples
  `).get() as { sampleCount: number; oldestTimestamp: number | null; newestTimestamp: number | null };
  const pageCount = handle.query("PRAGMA page_count").get() as { page_count: number };
  const pageSize = handle.query("PRAGMA page_size").get() as { page_size: number };
  return {
    path: dbPath,
    sampleCount: aggregate.sampleCount,
    oldestTimestamp: aggregate.oldestTimestamp,
    newestTimestamp: aggregate.newestTimestamp,
    pageCount: pageCount.page_count,
    pageSize: pageSize.page_size,
  };
}

export function routingHealthStoreExists(): boolean {
  return existsSync(routingHealthStorePath());
}

export function closeRoutingHealthStore(): void {
  closeCurrentStore();
}
