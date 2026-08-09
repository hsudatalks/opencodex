import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readUsageLedgerBatch,
  resetUsagePostgresIngestionForTests,
} from "../src/usage/postgres-ingest";

const testDirs: string[] = [];

afterEach(() => {
  resetUsagePostgresIngestionForTests();
  for (const dir of testDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function usageLine(requestId: string, timestamp: number): string {
  return JSON.stringify({
    requestId,
    timestamp,
    provider: "openai",
    model: "gpt-5.4",
    status: 200,
    durationMs: 12,
    usageStatus: "reported",
    usage: { inputTokens: 10, outputTokens: 5 },
  });
}

describe("Postgres usage ledger reader", () => {
  test("advances only across complete newline-terminated records", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-usage-pg-"));
    testDirs.push(dir);
    const path = join(dir, "usage.jsonl");
    const first = `${usageLine("first", 1_700_000_000_000)}\n`;
    const partial = usageLine("partial", 1_700_000_000_001).slice(0, 40);
    writeFileSync(path, first + partial);

    const batch = readUsageLedgerBatch(path, 0);
    expect(batch?.entries.map(entry => entry.requestId)).toEqual(["first"]);
    expect(batch?.nextOffset).toBe(Buffer.byteLength(first));
    expect(batch?.invalidLines).toBe(0);
  });

  test("counts malformed complete rows and continues with later valid rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-usage-pg-"));
    testDirs.push(dir);
    const path = join(dir, "usage.jsonl");
    const contents = [
      usageLine("first", 1_700_000_000_000),
      "not-json",
      usageLine("second", 1_700_000_000_001),
      "",
    ].join("\n");
    writeFileSync(path, contents);

    const batch = readUsageLedgerBatch(path, 0);
    expect(batch?.entries.map(entry => entry.requestId)).toEqual(["first", "second"]);
    expect(batch?.invalidLines).toBe(1);
    expect(batch?.nextOffset).toBe(Buffer.byteLength(contents));
  });

  test("honors complete-line batch limits without skipping the next row", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-usage-pg-"));
    testDirs.push(dir);
    const path = join(dir, "usage.jsonl");
    const first = `${usageLine("first", 1_700_000_000_000)}\n`;
    const second = `${usageLine("second", 1_700_000_000_001)}\n`;
    writeFileSync(path, first + second);

    const batch1 = readUsageLedgerBatch(path, 0, 1);
    const batch2 = readUsageLedgerBatch(path, batch1!.nextOffset, 1);
    expect(batch1?.entries.map(entry => entry.requestId)).toEqual(["first"]);
    expect(batch2?.entries.map(entry => entry.requestId)).toEqual(["second"]);
  });
});
