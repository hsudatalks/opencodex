import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";

export const RESPONSE_STATE_DB_FILENAME = "responses-state.sqlite";
export const RESPONSE_STATE_STORE_SCHEMA_VERSION = 1;
export const RESPONSE_STATE_WAL_AUTOCHECKPOINT_PAGES = 256;
export const RESPONSE_STATE_WAL_SIZE_LIMIT_BYTES = 4 * 1024 * 1024;
export const RESPONSE_STATE_COMPRESSION_THRESHOLD_BYTES = 4 * 1024;
const RESPONSE_STATE_MAX_DECOMPRESSED_ROW_BYTES = 128 * 1024 * 1024;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS response_states (
  response_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  encoding TEXT NOT NULL,
  state_payload BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_response_states_sequence
  ON response_states(sequence);
`;

export interface PersistedResponseStateRow {
  responseId: string;
  stateJson: string;
}

export interface ResponseStateMutation {
  responseId: string;
  stateJson: string | null;
}

export interface ResponseStateStoreLoadResult {
  rows: PersistedResponseStateRow[];
  legacyImported: boolean;
}

export interface ResponseStateStoreCommitResult {
  rowsWritten: number;
  payloadBytes: number;
  logicalPayloadBytes: number;
}

export interface ResponseStateStoreStats {
  path: string;
  open: boolean;
  rowCount: number;
  commits: number;
  rowsWritten: number;
  payloadBytes: number;
  logicalPayloadBytes: number;
  failures: number;
  dbBytes: number;
  walBytes: number;
}

let db: Database | null = null;
let dbPath = "";
let rowCount = 0;
let commits = 0;
let rowsWritten = 0;
let payloadBytes = 0;
let logicalPayloadBytes = 0;
let failures = 0;

export function responseStateStorePath(configDir = getConfigDir()): string {
  return join(configDir, RESPONSE_STATE_DB_FILENAME);
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

function metaValue(handle: Database, key: string): string | null {
  const row = handle.query("SELECT value FROM schema_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setMeta(handle: Database, key: string, value: string | number): void {
  handle.query(
    "INSERT INTO schema_meta (key, value) VALUES (?, ?) "
      + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}

function encodeStateJson(stateJson: string): { encoding: "raw" | "zstd"; payload: Buffer; logicalBytes: number } {
  const raw = Buffer.from(stateJson, "utf8");
  if (raw.byteLength < RESPONSE_STATE_COMPRESSION_THRESHOLD_BYTES) {
    return { encoding: "raw", payload: raw, logicalBytes: raw.byteLength };
  }
  const compressed = Buffer.from(zstdCompressSync(raw));
  if (compressed.byteLength >= raw.byteLength) {
    return { encoding: "raw", payload: raw, logicalBytes: raw.byteLength };
  }
  return { encoding: "zstd", payload: compressed, logicalBytes: raw.byteLength };
}

function decodeStatePayload(row: { responseId: string; encoding: string; statePayload: Uint8Array }): PersistedResponseStateRow | null {
  try {
    const payload = Buffer.from(row.statePayload);
    const decoded = row.encoding === "raw"
      ? payload
      : row.encoding === "zstd"
        ? Buffer.from(zstdDecompressSync(payload, { maxOutputLength: RESPONSE_STATE_MAX_DECOMPRESSED_ROW_BYTES }))
        : null;
    if (!decoded) return null;
    return { responseId: row.responseId, stateJson: decoded.toString("utf8") };
  } catch {
    failures += 1;
    return null;
  }
}

function closeCurrentStore(): void {
  if (!db) return;
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best effort */ }
  try { db.close(); } catch { /* best effort */ }
  db = null;
  dbPath = "";
  rowCount = 0;
}

function openStore(configDir = getConfigDir()): Database {
  const path = responseStateStorePath(configDir);
  if (db && dbPath === path) return db;
  closeCurrentStore();

  const dir = configDir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* unsupported on some platforms */ }
  recordOwnedConfigPath(dir, path);

  const handle = new Database(path, { create: true });
  try {
    handle.exec("PRAGMA journal_mode = WAL");
    handle.exec("PRAGMA synchronous = FULL");
    handle.exec("PRAGMA busy_timeout = 1000");
    handle.exec(`PRAGMA wal_autocheckpoint = ${RESPONSE_STATE_WAL_AUTOCHECKPOINT_PAGES}`);
    handle.exec(`PRAGMA journal_size_limit = ${RESPONSE_STATE_WAL_SIZE_LIMIT_BYTES}`);
    handle.exec(DDL);
    const existingVersion = metaValue(handle, "schema_version");
    if (existingVersion !== null && Number(existingVersion) !== RESPONSE_STATE_STORE_SCHEMA_VERSION) {
      throw new Error(`Unsupported response-state schema version: ${existingVersion}`);
    }
    setMeta(handle, "schema_version", RESPONSE_STATE_STORE_SCHEMA_VERSION);
    try { chmodSync(path, 0o600); } catch { /* unsupported on some platforms */ }
    rowCount = Number(
      (handle.query("SELECT COUNT(*) AS count FROM response_states").get() as { count: number }).count,
    );
    db = handle;
    dbPath = path;
    return handle;
  } catch (error) {
    try { handle.close(); } catch { /* best effort */ }
    failures += 1;
    throw error;
  }
}

export function loadResponseStateStore(configDir = getConfigDir()): ResponseStateStoreLoadResult {
  const handle = openStore(configDir);
  const storedRows = handle.query(
    "SELECT response_id AS responseId, encoding, state_payload AS statePayload "
      + "FROM response_states ORDER BY sequence ASC",
  ).all() as Array<{ responseId: string; encoding: string; statePayload: Uint8Array }>;
  const rows = storedRows.flatMap(row => {
    const decoded = decodeStatePayload(row);
    return decoded ? [decoded] : [];
  });
  return { rows, legacyImported: metaValue(handle, "legacy_imported") === "1" };
}

export function importLegacyResponseStates(
  rows: readonly PersistedResponseStateRow[],
  configDir = getConfigDir(),
): void {
  const handle = openStore(configDir);
  const encodedRows = rows.map(row => ({ responseId: row.responseId, ...encodeStateJson(row.stateJson) }));
  const insert = handle.query(
    "INSERT INTO response_states (response_id, sequence, encoding, state_payload) VALUES (?, ?, ?, ?) "
      + "ON CONFLICT(response_id) DO UPDATE SET sequence = excluded.sequence, "
      + "encoding = excluded.encoding, state_payload = excluded.state_payload",
  );
  const migrate = handle.transaction(() => {
    handle.exec("DELETE FROM response_states");
    let sequence = 0;
    for (const row of encodedRows) {
      insert.run(row.responseId, ++sequence, row.encoding, row.payload);
    }
    setMeta(handle, "next_sequence", sequence);
    setMeta(handle, "legacy_imported", 1);
  });
  try {
    migrate();
    rowCount = encodedRows.length;
    commits += 1;
    rowsWritten += encodedRows.length;
    for (const row of encodedRows) {
      payloadBytes += row.payload.byteLength;
      logicalPayloadBytes += row.logicalBytes;
    }
  } catch (error) {
    failures += 1;
    throw error;
  }
}

export function applyResponseStateMutations(
  mutations: readonly ResponseStateMutation[],
  configDir = getConfigDir(),
): ResponseStateStoreCommitResult {
  if (mutations.length === 0) return { rowsWritten: 0, payloadBytes: 0, logicalPayloadBytes: 0 };
  const handle = openStore(configDir);
  const upsert = handle.query(
    "INSERT INTO response_states (response_id, sequence, encoding, state_payload) VALUES (?, ?, ?, ?) "
      + "ON CONFLICT(response_id) DO UPDATE SET sequence = excluded.sequence, "
      + "encoding = excluded.encoding, state_payload = excluded.state_payload",
  );
  const remove = handle.query("DELETE FROM response_states WHERE response_id = ?");
  let written = 0;
  let bytes = 0;
  let logicalBytes = 0;
  const commit = handle.transaction(() => {
    let sequence = Number(metaValue(handle, "next_sequence") ?? 0);
    for (const mutation of mutations) {
      if (mutation.stateJson === null) {
        remove.run(mutation.responseId);
      } else {
        const encoded = encodeStateJson(mutation.stateJson);
        upsert.run(mutation.responseId, ++sequence, encoded.encoding, encoded.payload);
        bytes += encoded.payload.byteLength;
        logicalBytes += encoded.logicalBytes;
      }
      written += 1;
    }
    setMeta(handle, "next_sequence", sequence);
    setMeta(handle, "legacy_imported", 1);
  });
  try {
    commit();
    rowCount = Number(
      (handle.query("SELECT COUNT(*) AS count FROM response_states").get() as { count: number }).count,
    );
    commits += 1;
    rowsWritten += written;
    payloadBytes += bytes;
    logicalPayloadBytes += logicalBytes;
    return { rowsWritten: written, payloadBytes: bytes, logicalPayloadBytes: logicalBytes };
  } catch (error) {
    failures += 1;
    throw error;
  }
}

export function responseStateStoreStats(configDir = getConfigDir()): ResponseStateStoreStats {
  const path = responseStateStorePath(configDir);
  return {
    path,
    open: db !== null && dbPath === path,
    rowCount,
    commits,
    rowsWritten,
    payloadBytes,
    logicalPayloadBytes,
    failures,
    dbBytes: fileSize(path),
    walBytes: fileSize(`${path}-wal`),
  };
}

export function closeResponseStateStore(): void {
  closeCurrentStore();
}

export function clearResponseStateStoreForTests(configDir = getConfigDir()): void {
  const path = responseStateStorePath(configDir);
  closeCurrentStore();
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try { unlinkSync(candidate); } catch { /* absent */ }
  }
  commits = 0;
  rowsWritten = 0;
  payloadBytes = 0;
  logicalPayloadBytes = 0;
  failures = 0;
}
