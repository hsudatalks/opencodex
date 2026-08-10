import { existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir, resolveWriteTarget } from "../config";
import { enforceAppOwnedMemoryBudget, type RetainedStoreSnapshot } from "../lib/app-owned-memory";
import type { OcxProviderContinuationState } from "../types";
import {
  deleteResponseSpill,
  noteStubSwapForTest,
  readResponseSpill,
  recoverOrphanedResponseSpills,
  responseSpillDirectory,
  responseSpillPayloadCap,
  type ResponseSpillRef,
  writeResponseSpillDurably,
} from "./spill-store";
import {
  applyResponseStateMutations,
  clearResponseStateStoreForTests,
  closeResponseStateStore,
  importLegacyResponseStates,
  loadResponseStateStore,
  responseStateStoreStats,
  type PersistedResponseStateRow,
  type ResponseStateMutation,
} from "./state-store";

/** Replay grace for response ids that have already been advanced by a child. */
const SUPERSEDED_RESPONSE_TTL_MS = 60 * 60 * 1_000;
/** A chain head is authoritative session state, not an ordinary cache entry. */
const RESPONSE_HEAD_TTL_MS = 24 * 60 * 60 * 1_000;
/** Soft budget applies only to superseded history. Live chain heads are protected. */
const MAX_STORED_RESPONSES = 1_000;
/** Emergency bound for abandoned heads when clients never advance or resume them. */
const MAX_STORED_RESPONSE_HEADS = 10_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
/** In-memory high-water byte cap across all entries. Forced store:false retention (kiro/cursor
 * continuation chains) stores the full expanded input each turn — ~quadratic bytes per chain —
 * so a count cap alone cannot bound memory. Oldest-first eviction applies past this mark. */
export const MAX_STORED_RESPONSE_BYTES = 64 * 1024 * 1024;
/** Refuse-to-parse ceiling for an existing snapshot file (above the 24 MiB write
 * bound, so anything we wrote ourselves always loads; guards against externally
 * planted or pre-cap unbounded files being parsed whole). */
const SNAPSHOT_FILE_MAX_BYTES = 32 * 1024 * 1024;
const STALE_TEMP_GRACE_MS = 15 * 60 * 1_000;
const STALE_TEMP_MAX_ENTRIES = 4_096;
const STALE_TEMP_MAX_CLEANUPS = 512;
const RESPONSE_STATE_TEMP_NAME = /^responses-state\.json\.ocx\.(\d+)\.(\d+)\.tmp$/;
const MAX_INCREMENTAL_COMMIT_ATTEMPTS = 8;

interface ResidentResponseState {
  kind: "resident";
  createdAt: number;
  supersededAt?: number;
  items: unknown[];
  providers?: OcxProviderContinuationState;
  sizeBytes: number;
}

interface SpilledResponseState {
  kind: "spill";
  createdAt: number;
  supersededAt?: number;
  providers?: OcxProviderContinuationState;
  spill: ResponseSpillRef;
  sizeBytes: number;
}

interface SpillFailedResponseState {
  kind: "spill-failed";
  createdAt: number;
  supersededAt?: number;
  sizeBytes: number;
}

type StoredResponseState = ResidentResponseState | SpilledResponseState | SpillFailedResponseState;
type ResidentInput = Omit<ResidentResponseState, "kind" | "sizeBytes">;

export type PreviousResponseReplayFailure = {
  code: "previous_response_not_found";
  reason: "spill_missing" | "spill_corrupt" | "spill_failed" | "spill_too_large";
};

const states = new Map<string, StoredResponseState>();
let storedResponseBytes = 0;
let residentResponseBytes = 0;
let oldestResidentId: string | undefined;
let oldestResidentAt: number | null = null;
let byteCapOverride: number | null = null;
let stateRevision = 0;
let mutationRevision = 0;
let hydrating = false;
interface PendingStateMutation {
  responseId: string;
  state: StoredResponseState | null;
  revision: number;
}
const pendingStateMutations = new Map<string, PendingStateMutation>();
let incrementalStoreConfigDir: string | null = null;
const spillCounters = { writes: 0, writeFailures: 0, readFailures: 0 };
const retentionCounters = {
  headTtlEvictions: 0,
  supersededTtlEvictions: 0,
  supersededCapacityEvictions: 0,
  emergencyHeadEvictions: 0,
  replayMisses: 0,
};
/**
 * Admission-boundary observability (test-visible). directSpills: oversized
 * candidates routed straight to durable spill without a resident stay or
 * unrelated demotion. oversizedDrops: candidates above the single-spill
 * payload ceiling, tombstoned instead of retained. snapshotOversizedRefusals:
 * snapshot files refused before parse.
 */
const admissionCounters = { directSpills: 0, oversizedDrops: 0, snapshotOversizedRefusals: 0 };

/** Test-only: admission-boundary counters (proves the new paths fire). */
export function responseAdmissionCountersForTests(): Readonly<typeof admissionCounters> {
  return admissionCounters;
}
// Superseded spill generations awaiting a committed metadata mutation. A crash
// before the SQLite transaction leaves the old row and old payload intact; a
// crash after commit leaves at worst an orphan reclaimed by startup GC.
const committedSpillRefs = new Map<string, ResponseSpillRef>();
const pendingSpillUnlinks = new Map<string, ResponseSpillRef>();

function byteCap(): number {
  return byteCapOverride ?? MAX_STORED_RESPONSE_BYTES;
}

/** Test-only: lower/restore the in-memory byte cap (null restores the default). */
export function setResponseStateByteCapForTests(bytes: number | null): void {
  byteCapOverride = bytes;
}

/** Test-only: current in-memory byte accounting (proves evictions release their bytes). */
export function getStoredResponseBytesForTests(): number {
  return storedResponseBytes;
}

function serializedBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
}

function persistedStateJson(entry: StoredResponseState): string {
  if (entry.kind === "resident") {
    const { sizeBytes: _sizeBytes, kind: _kind, ...resident } = entry;
    return JSON.stringify(resident);
  }
  const { sizeBytes: _sizeBytes, ...smallState } = entry;
  return JSON.stringify(smallState);
}

function noteStateMutation(id: string, entry: StoredResponseState | null): void {
  if (hydrating) return;
  const mutation: PendingStateMutation = {
    responseId: id,
    state: entry,
    revision: ++mutationRevision,
  };
  // Reinsert so Map iteration preserves the order of the latest mutation,
  // matching the in-memory map's delete+set ordering for capacity eviction.
  pendingStateMutations.delete(id);
  pendingStateMutations.set(id, mutation);
}

function deferSpillUnlink(id: string, ref: ResponseSpillRef): void {
  if (committedSpillRefs.get(id)?.fileName === ref.fileName) {
    // At most one generation per response id can be referenced by SQLite.
    pendingSpillUnlinks.set(id, ref);
    return;
  }
  // This generation never became authoritative. It cannot be recovered after
  // a crash and can be reclaimed immediately without risking the committed row.
  deleteResponseSpill(ref);
}

function measureResidentEntry(id: string, entry: ResidentInput): ResidentResponseState | null {
  const sizeBytes = serializedBytes({
    responseId: id,
    createdAt: entry.createdAt,
    items: entry.items,
    ...(entry.providers ? { providers: entry.providers } : {}),
  });
  return sizeBytes === null ? null : { kind: "resident", ...entry, sizeBytes };
}

function recomputeOldestResident(): void {
  oldestResidentId = undefined;
  oldestResidentAt = null;
  for (const [id, state] of states) {
    if (state.kind !== "resident") continue;
    if (oldestResidentAt !== null && state.createdAt >= oldestResidentAt) continue;
    oldestResidentId = id;
    oldestResidentAt = state.createdAt;
  }
}

function replaceMapEntry(id: string, next: StoredResponseState, expected?: StoredResponseState): boolean {
  const existing = states.get(id);
  if (expected && existing !== expected) return false;
  storedResponseBytes -= existing?.sizeBytes ?? 0;
  storedResponseBytes += next.sizeBytes;
  if (existing?.kind === "resident") {
    residentResponseBytes -= existing.sizeBytes;
  }
  if (next.kind === "resident") {
    residentResponseBytes += next.sizeBytes;
  }
  if (storedResponseBytes < 0) storedResponseBytes = 0;
  if (residentResponseBytes < 0) residentResponseBytes = 0;
  if (existing) states.delete(id);
  states.set(id, next);
  if (oldestResidentId === id) {
    recomputeOldestResident();
  } else if (next.kind === "resident" && (oldestResidentAt === null || next.createdAt < oldestResidentAt)) {
    oldestResidentId = id;
    oldestResidentAt = next.createdAt;
  }
  stateRevision += 1;
  noteStateMutation(id, next);
  return true;
}

function stubSize(id: string, entry: Omit<SpilledResponseState, "sizeBytes">): number {
  return serializedBytes({ responseId: id, ...entry }) ?? 0;
}

function tombstone(id: string, createdAt: number, supersededAt?: number): SpillFailedResponseState {
  const base = {
    kind: "spill-failed" as const,
    createdAt,
    ...(supersededAt !== undefined ? { supersededAt } : {}),
  };
  return { ...base, sizeBytes: serializedBytes({ responseId: id, ...base }) ?? 0 };
}

function deleteOwnedSpills(entry: StoredResponseState): void {
  if (entry.kind === "spill") deleteResponseSpill(entry.spill);
}

/** The ONLY deletion point: TTL, count, byte, and explicit deletes all route here. */
function deleteEntry(id: string, options: { deleteSpill?: boolean } = {}): void {
  const existing = states.get(id);
  if (!existing) return;
  storedResponseBytes -= existing.sizeBytes;
  if (existing.kind === "resident") {
    residentResponseBytes -= existing.sizeBytes;
  }
  if (storedResponseBytes < 0) storedResponseBytes = 0;
  if (residentResponseBytes < 0) residentResponseBytes = 0;
  states.delete(id);
  if (oldestResidentId === id) recomputeOldestResident();
  stateRevision += 1;
  noteStateMutation(id, null);
  if (options.deleteSpill !== false && existing.kind === "spill") deferSpillUnlink(id, existing.spill);
}

function replaceWithSpillFailure(
  id: string,
  expected?: StoredResponseState,
  _options: { deferSpillUnlink?: boolean } = {},
): void {
  const existing = states.get(id);
  if (expected && existing !== expected) return;
  const failed = tombstone(
    id,
    expected?.createdAt ?? existing?.createdAt ?? now(),
    expected?.supersededAt ?? existing?.supersededAt,
  );
  if (replaceMapEntry(id, failed, expected)) {
    if (existing) {
      if (existing.kind === "spill") deferSpillUnlink(id, existing.spill);
    }
  }
}

function swapResidentForSpill(id: string, expected: ResidentResponseState, ref: ResponseSpillRef): boolean {
  const base: Omit<SpilledResponseState, "sizeBytes"> = {
    kind: "spill",
    createdAt: expected.createdAt,
    ...(expected.providers ? { providers: expected.providers } : {}),
    spill: ref,
  };
  const next: SpilledResponseState = { ...base, sizeBytes: stubSize(id, base) };
  if (!replaceMapEntry(id, next, expected)) {
    deleteResponseSpill(ref);
    return false;
  }
  noteStubSwapForTest();
  return true;
}

function replaceSpillEntryAtomically(
  id: string,
  expected: SpilledResponseState,
  candidate: ResidentResponseState,
): void {
  try {
    const ref = writeResponseSpillDurably(id, {
      createdAt: candidate.createdAt,
      items: candidate.items,
      ...(candidate.providers ? { providers: candidate.providers } : {}),
    });
    const base: Omit<SpilledResponseState, "sizeBytes"> = {
      kind: "spill",
      createdAt: candidate.createdAt,
      ...(candidate.supersededAt !== undefined ? { supersededAt: candidate.supersededAt } : {}),
      ...(candidate.providers ? { providers: candidate.providers } : {}),
      spill: ref,
    };
    const next: SpilledResponseState = { ...base, sizeBytes: stubSize(id, base) };
    if (!replaceMapEntry(id, next, expected)) {
      deleteResponseSpill(ref);
      return;
    }
    spillCounters.writes += 1;
    noteStubSwapForTest();
    // The new stub is durable only after its SQLite transaction commits. A
    // crash before that reloads the old row, which must retain its payload.
    deferSpillUnlink(id, expected.spill);
  } catch {
    spillCounters.writeFailures += 1;
    // The durable row may still reference the old generation; deleting it now
    // would strand that row after a crash.
    replaceWithSpillFailure(id, expected, { deferSpillUnlink: true });
  }
}

function setResidentEntry(id: string, entry: ResidentInput): void {
  const expected = states.get(id);
  const candidate = measureResidentEntry(id, entry);
  if (!candidate) {
    replaceWithSpillFailure(id, expected);
    // A tombstone is tiny but still resident state: the hard-cap invariant
    // must hold on EVERY mutation path (review C2-1 — with a test cap below
    // tombstone size, skipping the prune leaves the store over cap).
    pruneResponses();
    return;
  }
  if (candidate.sizeBytes > byteCap()) {
    admitOversizedCandidate(id, candidate, expected);
    pruneResponses();
    return;
  }
  if (expected?.kind === "spill") {
    replaceSpillEntryAtomically(id, expected, candidate);
    pruneResponses();
    return;
  }
  if (!replaceMapEntry(id, candidate, expected)) return;
  pruneResponses();
}

function markResponseSuperseded(id: string, at: number): void {
  const existing = states.get(id);
  if (!existing || existing.supersededAt !== undefined) return;
  if (existing.kind === "resident") {
    const measured = measureResidentEntry(id, { ...existing, supersededAt: at });
    if (measured) replaceMapEntry(id, measured, existing);
    return;
  }
  if (existing.kind === "spill") {
    const { sizeBytes: _sizeBytes, ...spill } = existing;
    const base: Omit<SpilledResponseState, "sizeBytes"> = { ...spill, supersededAt: at };
    replaceMapEntry(id, { ...base, sizeBytes: stubSize(id, base) }, existing);
    return;
  }
  replaceMapEntry(id, tombstone(id, existing.createdAt, at), existing);
}

/** Install a completed response as a durable spill as soon as its terminal event is observed. */
function setDurableEntry(id: string, entry: ResidentInput): void {
  const expected = states.get(id);
  const candidate = measureResidentEntry(id, entry);
  if (!candidate) {
    replaceWithSpillFailure(id, expected);
    pruneResponses();
    return;
  }
  admitOversizedCandidate(id, candidate, expected, true);
  pruneResponses();
}

/**
 * Admission boundary for candidates that can never fit as resident (larger
 * than the whole resident-map cap). Writes them DIRECTLY to durable spill and
 * installs only the stub — the oversized candidate never becomes resident and
 * no unrelated resident is demoted to make room for it. Candidates above the
 * single-spill payload ceiling are tombstoned instead: retaining a spill the
 * replay ceiling would refuse to read is write-only waste.
 */
function admitOversizedCandidate(
  id: string,
  candidate: ResidentResponseState,
  expected?: StoredResponseState,
  forceDurable = false,
): void {
  if (candidate.sizeBytes > responseSpillPayloadCap()) {
    admissionCounters.oversizedDrops += 1;
    replaceWithSpillFailure(id, expected, { deferSpillUnlink: true });
    return;
  }
  try {
    const ref = writeResponseSpillDurably(id, {
      createdAt: candidate.createdAt,
      items: candidate.items,
      ...(candidate.providers ? { providers: candidate.providers } : {}),
    });
    // Enforce the ceiling against the REAL envelope: the spill payload adds
    // the {version, responseId, ...} wrapper, so a candidate within the
    // wrapper's size of the cap would otherwise be retained unreadably.
    if (ref.payloadBytes > responseSpillPayloadCap()) {
      deleteResponseSpill(ref);
      admissionCounters.oversizedDrops += 1;
      replaceWithSpillFailure(id, expected, { deferSpillUnlink: true });
      return;
    }
    const base: Omit<SpilledResponseState, "sizeBytes"> = {
      kind: "spill",
      createdAt: candidate.createdAt,
      ...(candidate.supersededAt !== undefined ? { supersededAt: candidate.supersededAt } : {}),
      ...(candidate.providers ? { providers: candidate.providers } : {}),
      spill: ref,
    };
    const next: SpilledResponseState = { ...base, sizeBytes: stubSize(id, base) };
    if (!replaceMapEntry(id, next, expected)) {
      deleteResponseSpill(ref);
      return;
    }
    spillCounters.writes += 1;
    if (forceDurable || candidate.sizeBytes > byteCap()) admissionCounters.directSpills += 1;
    noteStubSwapForTest();
    if (expected?.kind === "spill") {
      // Same deferred-unlink rule as replaceSpillEntryAtomically: retain the
      // old generation until the replacement metadata transaction commits.
      deferSpillUnlink(id, expected.spill);
    }
  } catch {
    spillCounters.writeFailures += 1;
    replaceWithSpillFailure(id, expected, { deferSpillUnlink: true });
  }
}

// Expansion provenance must stay proxy-private: a WeakMap distinguishes replayed history from the
// newly appended input suffix without adding an unknown field that native passthrough could send
// upstream. The parser uses this boundary to acknowledge historical compaction markers exactly once.
const replayedInputPrefixLengths = new WeakMap<object, number>();
const replayFailures = new WeakMap<object, PreviousResponseReplayFailure>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPersistPath: string | null = null;
/** Single-flight gate: overlapping response-state writes serialize (#612). */
let persistGate: Promise<void> = Promise.resolve();
let persistAttemptHookForTests: (() => void) | null = null;

function now(): number {
  return Date.now();
}

function snapshotPath(): string {
  return join(getConfigDir(), "responses-state.json");
}

interface LegacySnapshotState {
  createdAt?: unknown;
  supersededAt?: unknown;
  items?: unknown;
  providers?: OcxProviderContinuationState;
  conversationId?: unknown;
  cursorCheckpointUsable?: unknown;
}

function isSpillRef(value: unknown): value is ResponseSpillRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as ResponseSpillRef;
  return ref.version === 1
    && typeof ref.fileName === "string"
    && /^[0-9a-f]{64}$/.test(ref.digest)
    && Number.isSafeInteger(ref.payloadBytes)
    && ref.payloadBytes >= 0;
}

function loadSnapshotEntry(id: string, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const rec = value as LegacySnapshotState & { kind?: unknown; spill?: unknown };
  if (typeof rec.createdAt !== "number" || !Number.isFinite(rec.createdAt)) return;
  const supersededAt = typeof rec.supersededAt === "number" && Number.isFinite(rec.supersededAt)
    ? rec.supersededAt
    : undefined;
  if (rec.kind === "spill") {
    if (!isSpillRef(rec.spill)) return;
    const base: Omit<SpilledResponseState, "sizeBytes"> = {
      kind: "spill",
      createdAt: rec.createdAt,
      ...(supersededAt !== undefined ? { supersededAt } : {}),
      ...(rec.providers ? { providers: rec.providers } : {}),
      spill: rec.spill,
    };
    replaceMapEntry(id, { ...base, sizeBytes: stubSize(id, base) });
    return;
  }
  if (rec.kind === "spill-failed") {
    replaceMapEntry(id, tombstone(id, rec.createdAt, supersededAt));
    return;
  }
  if (rec.kind !== undefined && rec.kind !== "resident") return;
  if (!Array.isArray(rec.items)) return;
  const providers = rec.providers ?? (typeof rec.conversationId === "string"
    ? {
        cursor: {
          conversationId: rec.conversationId,
          ...(typeof rec.cursorCheckpointUsable === "boolean"
            ? { checkpointUsable: rec.cursorCheckpointUsable }
            : {}),
        },
      }
    : undefined);
  const resident = measureResidentEntry(id, {
    createdAt: rec.createdAt,
    ...(supersededAt !== undefined ? { supersededAt } : {}),
    items: rec.items,
    ...(providers ? { providers } : {}),
  });
  if (!resident) {
    replaceMapEntry(id, tombstone(id, rec.createdAt, supersededAt));
    return;
  }
  // Same admission boundary as live writes: an oversized snapshot row goes
  // straight to spill (or tombstone above the payload ceiling) instead of
  // entering the resident map and demoting unrelated rows on the first prune.
  if (resident.sizeBytes > byteCap()) {
    admitOversizedCandidate(id, resident, undefined);
    return;
  }
  replaceMapEntry(id, resident);
}

export interface ResponseStateTempRecoveryResult {
  matched: number;
  removed: number;
  failed: number;
  bytesRemoved: number;
}

interface ResponseStateTempRecoveryIO {
  now: () => number;
  list: (dir: string) => Iterable<string>;
  inspect: (path: string) => { isFile: boolean; mtimeMs: number; size: number };
  isProcessAlive: (pid: number) => boolean;
  unlink: (path: string) => void;
}

type ResponseStateTempRecoveryOptions = Partial<ResponseStateTempRecoveryIO> & {
  maxEntries?: number;
  maxCleanups?: number;
};

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled. Unknown platform errors
    // are also protected; cleanup should prefer a false negative over touching a live writer.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const responseStateTempRecoveryIO: ResponseStateTempRecoveryIO = {
  now: Date.now,
  list: function* list(dir) {
    const handle = opendirSync(dir);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) yield entry.name;
    } finally {
      handle.closeSync();
    }
  },
  inspect: path => {
    const stat = lstatSync(path);
    return { isFile: stat.isFile() && !stat.isSymbolicLink(), mtimeMs: stat.mtimeMs, size: stat.size };
  },
  isProcessAlive: processIsAlive,
  unlink: unlinkSync,
};

/**
 * Recover only abandoned response-state atomic-write files. The exact basename,
 * regular-file check, age gate, and PID liveness check protect unrelated/active files.
 * Cleanup is capped and best-effort because continuation state is only a cache. Removal
 * deliberately uses unlink only: path-based truncation could follow a replacement symlink.
 */
export function recoverStaleResponseStateTemps(
  dir = getConfigDir(),
  options: ResponseStateTempRecoveryOptions = {},
): ResponseStateTempRecoveryResult {
  const { maxEntries = STALE_TEMP_MAX_ENTRIES, maxCleanups = STALE_TEMP_MAX_CLEANUPS, ...overrides } = options;
  const io = { ...responseStateTempRecoveryIO, ...overrides };
  const result: ResponseStateTempRecoveryResult = {
    matched: 0,
    removed: 0,
    failed: 0,
    bytesRemoved: 0,
  };
  let names: Iterable<string>;
  try { names = io.list(dir); } catch { return result; }
  let iterator: Iterator<string>;
  try { iterator = names[Symbol.iterator](); } catch { return result; }
  let scanned = 0;
  for (;;) {
    let next: IteratorResult<string>;
    try { next = iterator.next(); } catch { return result; }
    if (next.done) break;
    const name = next.value;
    scanned += 1;
    if (scanned > maxEntries || result.removed + result.failed >= maxCleanups) break;
    const match = RESPONSE_STATE_TEMP_NAME.exec(name);
    if (!match) continue;
    result.matched += 1;
    const pid = Number(match[1]);
    const sequence = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(sequence) || sequence <= 0) continue;
    const path = join(dir, name);
    let file: ReturnType<ResponseStateTempRecoveryIO["inspect"]>;
    try { file = io.inspect(path); } catch { continue; }
    if (!file.isFile || io.now() - file.mtimeMs < STALE_TEMP_GRACE_MS) continue;
    if (pid === process.pid || io.isProcessAlive(pid)) continue;

    try {
      io.unlink(path);
      result.removed += 1;
      result.bytesRemoved += file.size;
    } catch {
      // Locked files remain for a later startup. Do not truncate by path: a same-user
      // replacement could turn that fallback into an arbitrary symlink-target write.
      result.failed += 1;
    }
  }
  return result;
}

function hydratePersistedRows(rows: readonly PersistedResponseStateRow[]): void {
  for (const row of rows) {
    try {
      loadSnapshotEntry(row.responseId, JSON.parse(row.stateJson) as unknown);
    } catch {
      // A corrupt row is isolated to its response id; valid continuation rows
      // remain available and a later mutation can overwrite the bad row.
    }
  }
}

function legacySnapshotRows(path: string): PersistedResponseStateRow[] {
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (!stat.isFile()) return [];
  if (stat.size > SNAPSHOT_FILE_MAX_BYTES) {
    admissionCounters.snapshotOversizedRefusals += 1;
    return [];
  }
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; states?: unknown };
  if ((raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.states)) return [];
  const rows: PersistedResponseStateRow[] = [];
  for (const entry of raw.states) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") continue;
    try {
      rows.push({ responseId: entry[0], stateJson: JSON.stringify(entry[1]) });
    } catch { /* one invalid legacy row must not block the migration */ }
  }
  return rows;
}

function refreshCommittedSpillRefsFromMemory(): void {
  committedSpillRefs.clear();
  for (const [id, state] of states) {
    if (state.kind === "spill") committedSpillRefs.set(id, state.spill);
  }
}

function noteCommittedMutation(mutation: ResponseStateMutation): void {
  if (mutation.stateJson === null) {
    committedSpillRefs.delete(mutation.responseId);
    return;
  }
  try {
    const value = JSON.parse(mutation.stateJson) as { kind?: unknown; spill?: unknown };
    if (value.kind === "spill" && isSpillRef(value.spill)) {
      committedSpillRefs.set(mutation.responseId, value.spill);
    } else {
      committedSpillRefs.delete(mutation.responseId);
    }
  } catch {
    committedSpillRefs.delete(mutation.responseId);
  }
}

function ensureIncrementalStoreReady(configDir: string): void {
  if (incrementalStoreConfigDir === configDir) return;
  const persisted = loadResponseStateStore(configDir);
  if (!persisted.legacyImported) {
    // This also repairs a transient first-load SQLite failure: import the
    // current normalized in-memory state before accepting row-level writes.
    importLegacyResponseStates(
      [...states].map(([responseId, state]) => ({ responseId, stateJson: persistedStateJson(state) })),
      configDir,
    );
  }
  incrementalStoreConfigDir = configDir;
  refreshCommittedSpillRefsFromMemory();
}

/**
 * Load the incremental SQLite store lazily. A v1/v2 JSON snapshot is imported
 * exactly once when the database is first created, then left untouched as a
 * migration audit artifact. Runtime persistence is row-level and never rewrites it.
 */
function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  hydrating = true;
  const path = snapshotPath();
  // Atomic writes place their temp beside the RESOLVED target, so a symlinked
  // snapshot (dotfiles-managed config dir) strands temps in the link's real
  // directory where a scan of the literal config dir would never see them.
  // Both locations are swept; they collapse to one when nothing is symlinked.
  // resolveWriteTarget refuses a dangling link; snapshot loading stays independent.
  let resolvedDir = dirname(path);
  try {
    resolvedDir = dirname(resolveWriteTarget(path));
  } catch {
    /* unresolvable link: sweep the literal dir only */
  }
  for (const dir of new Set([dirname(path), resolvedDir])) {
    try {
      recoverStaleResponseStateTemps(dir);
    } catch {
      /* best-effort cleanup only; snapshot loading must remain independent */
    }
  }
  const configDir = getConfigDir();
  let storeAvailable = false;
  try {
    const persisted = loadResponseStateStore(configDir);
    storeAvailable = true;
    if (persisted.legacyImported) {
      hydratePersistedRows(persisted.rows);
    } else {
      const rows = legacySnapshotRows(path);
      hydratePersistedRows(rows);
      // Serialize normalized rows so v1 Cursor fields become provider-keyed
      // state in the canonical store during the same migration transaction.
      importLegacyResponseStates(
        [...states].map(([responseId, state]) => ({ responseId, stateJson: persistedStateJson(state) })),
        configDir,
      );
    }
    incrementalStoreConfigDir = configDir;
    refreshCommittedSpillRefsFromMemory();
  } catch {
    // If SQLite cannot open, retain the previous best-effort behavior and load
    // the bounded legacy snapshot. A later mutation may recover persistence.
    try { hydratePersistedRows(legacySnapshotRows(path)); } catch { /* corrupt legacy snapshot */ }
    // Treat fallback rows conservatively as durable until SQLite can be
    // reopened; this prevents deleting a payload referenced by either store.
    refreshCommittedSpillRefsFromMemory();
  } finally {
    hydrating = false;
  }
  const referenced = new Set<string>();
  for (const state of states.values()) {
    if (state.kind === "spill") referenced.add(state.spill.fileName);
  }
  try { recoverOrphanedResponseSpills(referenced); } catch { /* best effort */ }
  pruneResponses();
  if (storeAvailable && pendingStateMutations.size > 0) schedulePersist();
}

type IncrementalCommitOutcome = "stable" | "unstable" | "failed";

async function commitPendingMutations(configDir: string): Promise<IncrementalCommitOutcome> {
  // Serialize writers so concurrent flush + debounce cannot race on mutation
  // acknowledgement or superseded-spill cleanup.
  const previous = persistGate;
  let release!: () => void;
  persistGate = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const batch = [...pendingStateMutations.values()];
    if (batch.length === 0) return "stable";
    const serializedBatch: ResponseStateMutation[] = batch.map(mutation => ({
      responseId: mutation.responseId,
      stateJson: mutation.state ? persistedStateJson(mutation.state) : null,
    }));
    try {
      ensureIncrementalStoreReady(configDir);
      applyResponseStateMutations(serializedBatch, configDir);
    } catch {
      return "failed";
    }
    for (const mutation of serializedBatch) noteCommittedMutation(mutation);
    for (const mutation of batch) {
      if (pendingStateMutations.get(mutation.responseId)?.revision === mutation.revision) {
        pendingStateMutations.delete(mutation.responseId);
      }
    }
    drainPendingSpillUnlinks();
    persistAttemptHookForTests?.();
    return pendingStateMutations.size === 0 ? "stable" : "unstable";
  } finally {
    release();
  }
}

function drainPendingSpillUnlinks(): void {
  for (const [id, ref] of pendingSpillUnlinks) {
    if (committedSpillRefs.get(id)?.fileName === ref.fileName) continue;
    deleteResponseSpill(ref);
    pendingSpillUnlinks.delete(id);
  }
}

function schedulePersistAt(configDir: string, replace = false): void {
  if (persistTimer && !replace) return;
  if (persistTimer) clearTimeout(persistTimer);
  pendingPersistPath = configDir;
  persistTimer = setTimeout(() => { void persistNow(configDir); }, SNAPSHOT_DEBOUNCE_MS);
  (persistTimer as { unref?: () => void }).unref?.();
}

async function persistNow(configDir: string, awaitFollowUp = false): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersistPath = null;
  let outcome: IncrementalCommitOutcome = "stable";
  const maxAttempts = awaitFollowUp ? MAX_INCREMENTAL_COMMIT_ATTEMPTS : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    outcome = await commitPendingMutations(configDir);
    if (outcome !== "unstable") break;
  }
  if (outcome === "unstable" && !awaitFollowUp) schedulePersistAt(configDir, true);
}

function schedulePersist(): void {
  // Resolve the target path NOW: tests (and anything else) may swap OPENCODEX_HOME before the
  // debounce fires, and a late write must land in the home that owned the recorded state.
  schedulePersistAt(getConfigDir());
}

/** Flush pending incremental mutations (graceful shutdown / deterministic tests). */
export async function flushResponseState(): Promise<void> {
  if (persistTimer) {
    await persistNow(pendingPersistPath ?? getConfigDir(), true);
    return;
  }
  // No pending timer: still await any in-flight write so shutdown does not race (#612).
  await persistGate;
  // A bounded background pass may have scheduled its same-path follow-up while
  // this flush was waiting on the single-flight gate. Shutdown owns one awaited
  // bounded follow-up rather than returning behind that unref'd timer.
  if (persistTimer) await persistNow(pendingPersistPath ?? getConfigDir(), true);
  else if (pendingStateMutations.size > 0) await persistNow(getConfigDir(), true);
}

function inputItems(input: unknown): unknown[] {
  if (input === undefined) return [];
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return [{ role: "user", content: input }];
  return [input];
}

function pruneResponses(at = now()): void {
  for (const [id, state] of states) {
    if (state.supersededAt !== undefined) {
      if (at - state.supersededAt > SUPERSEDED_RESPONSE_TTL_MS) {
        retentionCounters.supersededTtlEvictions += 1;
        deleteEntry(id);
      }
    } else if (at - state.createdAt > RESPONSE_HEAD_TTL_MS) {
      retentionCounters.headTtlEvictions += 1;
      deleteEntry(id);
    }
  }
  while (states.size > MAX_STORED_RESPONSES) {
    const oldest = [...states].find(([, state]) => state.supersededAt !== undefined)?.[0];
    if (!oldest) break;
    retentionCounters.supersededCapacityEvictions += 1;
    deleteEntry(oldest);
  }
  while (states.size > MAX_STORED_RESPONSE_HEADS) {
    const oldest = states.keys().next().value;
    if (!oldest) break;
    retentionCounters.emergencyHeadEvictions += 1;
    deleteEntry(oldest);
  }
  // Unconditional RAM cap. Resident payloads demote durably; stubs/tombstones are
  // deleted only when even their bounded metadata cannot fit the override.
  while (storedResponseBytes > byteCap() && states.size > 0) {
    const oldestResident = [...states].find(([, entry]) => entry.kind === "resident");
    const oldestId = oldestResident?.[0] ?? states.keys().next().value as string | undefined;
    if (!oldestId) break;
    const entry = states.get(oldestId)!;
    if (entry.kind !== "resident") {
      deleteEntry(oldestId);
      continue;
    }
    try {
      const ref = writeResponseSpillDurably(oldestId, {
        createdAt: entry.createdAt,
        items: entry.items,
        ...(entry.providers ? { providers: entry.providers } : {}),
      });
      if (swapResidentForSpill(oldestId, entry, ref)) spillCounters.writes += 1;
    } catch {
      spillCounters.writeFailures += 1;
      replaceWithSpillFailure(oldestId, entry);
    }
  }
}

/** Periodic TTL-only sweep; count/byte eviction remains owned by mutation paths. */
export function sweepExpiredResponseStates(at = now()): number {
  let removed = 0;
  for (const [id, state] of states) {
    const expired = state.supersededAt !== undefined
      ? at - state.supersededAt > SUPERSEDED_RESPONSE_TTL_MS
      : at - state.createdAt > RESPONSE_HEAD_TTL_MS;
    if (!expired) continue;
    if (state.supersededAt !== undefined) retentionCounters.supersededTtlEvictions += 1;
    else retentionCounters.headTtlEvictions += 1;
    deleteEntry(id);
    removed += 1;
  }
  if (removed > 0) schedulePersist();
  return removed;
}

export function responseContinuationRetainedStoreSnapshot(): RetainedStoreSnapshot {
  return {
    count: states.size,
    bytes: storedResponseBytes,
    evictableBytes: residentResponseBytes,
    pinnedBytes: Math.max(0, storedResponseBytes - residentResponseBytes),
    oldestAt: oldestResidentAt,
  };
}

export function evictOldestResponseContinuationForBudget(): number {
  if (oldestResidentId === undefined) return 0;
  const id = oldestResidentId;
  const entry = states.get(id);
  if (!entry || entry.kind !== "resident") return 0;
  try {
    const ref = writeResponseSpillDurably(id, {
      createdAt: entry.createdAt,
      items: entry.items,
      ...(entry.providers ? { providers: entry.providers } : {}),
    });
    if (swapResidentForSpill(id, entry, ref)) spillCounters.writes += 1;
  } catch {
    spillCounters.writeFailures += 1;
    replaceWithSpillFailure(id, entry);
  }
  schedulePersist();
  const replacement = states.get(id);
  return !replacement || replacement.kind === "resident"
    ? 0
    : Math.max(0, entry.sizeBytes - replacement.sizeBytes);
}

function materializeEntry(
  id: string,
  entry: StoredResponseState,
): { ok: true; state: ResidentResponseState } | { ok: false; failure: PreviousResponseReplayFailure } {
  if (entry.kind === "resident") return { ok: true, state: entry };
  if (entry.kind === "spill-failed") {
    return { ok: false, failure: { code: "previous_response_not_found", reason: "spill_failed" } };
  }
  const result = readResponseSpill(id, entry.spill);
  if (!result.ok) {
    spillCounters.readFailures += 1;
    const failure: PreviousResponseReplayFailure = {
      code: "previous_response_not_found",
      reason: result.reason === "missing"
        ? "spill_missing"
        : result.reason === "too_large"
          ? "spill_too_large"
          : "spill_corrupt",
    };
    replaceWithSpillFailure(id, entry);
    schedulePersist();
    return { ok: false, failure };
  }
  const state = measureResidentEntry(id, {
    createdAt: result.payload.createdAt,
    items: result.payload.items,
    ...(result.payload.providers ? { providers: result.payload.providers } : {}),
  });
  if (!state) {
    spillCounters.readFailures += 1;
    replaceWithSpillFailure(id, entry);
    schedulePersist();
    return { ok: false, failure: { code: "previous_response_not_found", reason: "spill_corrupt" } };
  }
  return { ok: true, state };
}

export function expandPreviousResponseInput(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const request = body as Record<string, unknown>;
  const previousId = typeof request.previous_response_id === "string" ? request.previous_response_id : undefined;
  if (!previousId) return body;
  ensureLoaded();
  pruneResponses();
  const previous = states.get(previousId);
  if (!previous) {
    retentionCounters.replayMisses += 1;
    return body;
  }
  const materialized = materializeEntry(previousId, previous);
  if (!materialized.ok) {
    replayFailures.set(request, materialized.failure);
    return body;
  }
  const expanded = {
    ...request,
    input: [...materialized.state.items, ...inputItems(request.input)],
  };
  replayedInputPrefixLengths.set(expanded, materialized.state.items.length);
  return expanded;
}

export function previousResponseReplayFailure(body: unknown): PreviousResponseReplayFailure | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  return replayFailures.get(body);
}

/** Number of leading input items restored from previous_response_id state for this exact body. */
export function previousResponseReplayPrefixLength(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  return replayedInputPrefixLengths.get(body) ?? 0;
}

export function previousResponseConversationId(responseId: string | undefined): string | undefined {
  return previousResponseProviderState(responseId)?.cursor?.conversationId;
}

export function previousResponseProviderState(responseId: string | undefined): OcxProviderContinuationState | undefined {
  if (!responseId) return undefined;
  ensureLoaded();
  pruneResponses();
  const state = states.get(responseId);
  const providers = state?.kind === "spill-failed" ? undefined : state?.providers;
  return providers ? structuredClone(providers) : undefined;
}

export interface ResponseStateMetrics {
  count: number;
  residentCount: number;
  spillStubCount: number;
  tombstoneCount: number;
  totalBytes: number;
  spillPayloadBytes: number;
  largestBytes: number;
  oldestAgeMs: number;
  spillWrites: number;
  spillWriteFailures: number;
  spillReadFailures: number;
  headCount: number;
  supersededCount: number;
  headTtlEvictions: number;
  supersededTtlEvictions: number;
  supersededCapacityEvictions: number;
  emergencyHeadEvictions: number;
  replayMisses: number;
  persistenceBackend: "sqlite-incremental";
  persistencePendingMutations: number;
  persistenceRows: number;
  persistenceCommits: number;
  persistenceRowsWritten: number;
  persistencePayloadBytes: number;
  persistenceLogicalPayloadBytes: number;
  persistenceFailures: number;
  persistenceDbBytes: number;
  persistenceWalBytes: number;
}

/**
 * Observe-only snapshot of the in-RAM continuation store, surfaced via GET /api/system/memory.
 * Additive and side-effect free — it does NOT lazy-load the disk snapshot, prune, or evict — so a
 * diagnostics probe can sample it without perturbing request handling. `totalBytes` reads the
 * running byte counter and `largestBytes` reads each entry's cached `sizeBytes`, so a probe never
 * re-serializes the whole store (a large transient allocation that would fire exactly when memory
 * is already under pressure). This is the seam for deciding whether RAM growth originates in this
 * store (JS heap) or in the runtime allocator (native).
 */
export function responseStateMetrics(): ResponseStateMetrics {
  const at = now();
  let largestBytes = 0;
  let oldestCreatedAt = at;
  let residentCount = 0;
  let spillStubCount = 0;
  let tombstoneCount = 0;
  let spillPayloadBytes = 0;
  let headCount = 0;
  let supersededCount = 0;
  const persistence = responseStateStoreStats();
  for (const state of states.values()) {
    const bytes = state.sizeBytes;
    if (bytes > largestBytes) largestBytes = bytes;
    if (state.createdAt < oldestCreatedAt) oldestCreatedAt = state.createdAt;
    if (state.supersededAt === undefined) headCount += 1;
    else supersededCount += 1;
    if (state.kind === "resident") {
      residentCount += 1;
    } else if (state.kind === "spill") {
      spillStubCount += 1;
      spillPayloadBytes += state.spill.payloadBytes;
    } else tombstoneCount += 1;
  }
  return {
    count: states.size,
    residentCount,
    spillStubCount,
    tombstoneCount,
    totalBytes: storedResponseBytes,
    spillPayloadBytes,
    largestBytes,
    oldestAgeMs: states.size > 0 ? at - oldestCreatedAt : 0,
    spillWrites: spillCounters.writes,
    spillWriteFailures: spillCounters.writeFailures,
    spillReadFailures: spillCounters.readFailures,
    headCount,
    supersededCount,
    ...retentionCounters,
    persistenceBackend: "sqlite-incremental",
    persistencePendingMutations: pendingStateMutations.size,
    persistenceRows: persistence.rowCount,
    persistenceCommits: persistence.commits,
    persistenceRowsWritten: persistence.rowsWritten,
    persistencePayloadBytes: persistence.payloadBytes,
    persistenceLogicalPayloadBytes: persistence.logicalPayloadBytes,
    persistenceFailures: persistence.failures,
    persistenceDbBytes: persistence.dbBytes,
    persistenceWalBytes: persistence.walBytes,
  };
}

/**
 * Cache completed output and max_output_tokens partial output for previous_response_id replay.
 * Content-filtered incomplete and failed output are not authoritative replay history.
 */
export function rememberResponseState(
  requestBody: unknown,
  response: { id?: unknown; output?: unknown; status?: unknown; incomplete_details?: unknown },
  providerState?: OcxProviderContinuationState | string,
  opts?: { force?: boolean; durable?: boolean },
): void {
  if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody)) return;
  const request = requestBody as Record<string, unknown>;
  // `force` bypasses only the store:false skip: Codex sends `store:false` on every non-Azure
  // HTTP request (and WS inherits it), yet its WS turns still chain with previous_response_id.
  // The passthrough branch records with force so those chains can be expanded locally; the
  // store keeps durable forward-mode chain heads for 24h. Superseded ids retain a bounded
  // replay grace, while capacity pressure may discard only those historical ids first.
  if (request.store === false && !opts?.force) return;
  if (typeof response.id !== "string" || !Array.isArray(response.output)) return;
  if (response.status === "incomplete") {
    const details = response.incomplete_details;
    if (!details || typeof details !== "object" || Array.isArray(details)
      || (details as { reason?: unknown }).reason !== "max_output_tokens") return;
  } else if (response.status !== undefined && response.status !== "completed") return;
  ensureLoaded();
  const previousId = typeof request.previous_response_id === "string"
    ? request.previous_response_id
    : undefined;
  const normalizedProviderState: OcxProviderContinuationState = typeof providerState === "string"
    ? { cursor: { conversationId: providerState } }
    : structuredClone(providerState ?? {});
  if (normalizedProviderState.cursor?.conversationId) {
    normalizedProviderState.cursor.checkpointUsable = !response.output.some(item => {
      return !!item && typeof item === "object" && (item as { type?: unknown }).type === "function_call";
    });
  }
  const entry: ResidentInput = {
    createdAt: now(),
    items: [...inputItems(request.input), ...response.output],
    // Always preserve the Cursor conversation id so the next tool-result turn can continue the SAME
    // Cursor conversation (multi-turn continuation). Separately track whether Cursor's own
    // checkpoint/cache is safe to reuse: a turn that ended with a pending client tool call produced an
    // incomplete agent turn on the Cursor side (we suspended without a real mcpResult), so its
    // checkpoint must not be reused — but the conversation id string itself is still valid.
    ...(Object.keys(normalizedProviderState).length > 0 ? { providers: normalizedProviderState } : {}),
  };
  if (opts?.durable) setDurableEntry(response.id, entry);
  else setResidentEntry(response.id, entry);
  // Advance the authoritative head only after the child is replayable. A failed
  // spill write installs a tombstone for the child, but must not age the last
  // known-good parent into the shorter superseded-history window.
  if (
    previousId
    && previousId !== response.id
    && states.get(response.id)?.kind !== "spill-failed"
  ) {
    markResponseSuperseded(previousId, now());
  }
  enforceAppOwnedMemoryBudget();
  schedulePersist();
}

/** Test-only persistence churn hook; invoked after each committed mutation batch. */
export function setResponseStatePersistAttemptHookForTests(hook: (() => void) | null): void {
  persistAttemptHookForTests = hook;
}

/** Test-only: deterministically run the pending background debounce pass. */
export async function runPendingResponseStatePersistForTests(): Promise<void> {
  if (!persistTimer) return;
  await persistNow(pendingPersistPath ?? getConfigDir());
}

/** Test-only: observe whether a debounce/follow-up pass is pending. */
export function responseStatePersistPendingForTests(): boolean {
  return persistTimer !== null;
}

/** Memory-only reset (simulates a process restart: durable state survives). */
export function clearResponseStateMemoryForTests(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersistPath = null;
  closeResponseStateStore();
  states.clear();
  storedResponseBytes = 0;
  residentResponseBytes = 0;
  oldestResidentId = undefined;
  oldestResidentAt = null;
  stateRevision = 0;
  mutationRevision = 0;
  hydrating = false;
  incrementalStoreConfigDir = null;
  pendingStateMutations.clear();
  committedSpillRefs.clear();
  pendingSpillUnlinks.clear();
  spillCounters.writes = 0;
  spillCounters.writeFailures = 0;
  spillCounters.readFailures = 0;
  retentionCounters.headTtlEvictions = 0;
  retentionCounters.supersededTtlEvictions = 0;
  retentionCounters.supersededCapacityEvictions = 0;
  retentionCounters.emergencyHeadEvictions = 0;
  retentionCounters.replayMisses = 0;
  persistAttemptHookForTests = null;
  loaded = false;
}

export function clearResponseStateForTests(): void {
  for (const entry of states.values()) deleteOwnedSpills(entry);
  clearResponseStateMemoryForTests();
  try {
    unlinkSync(snapshotPath());
  } catch {
    /* no snapshot on disk */
  }
  clearResponseStateStoreForTests();
  try { rmSync(responseSpillDirectory(), { recursive: true, force: true }); } catch { /* no spill directory */ }
}
