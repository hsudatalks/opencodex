import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dashboardRollupRowsForTest,
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

  test("builds exact request, model, and provider hourly read-model rows", () => {
    const entry = {
      requestId: "combo",
      timestamp: Date.parse("2026-08-11T15:23:45.000Z"),
      provider: "combo",
      model: "combo",
      surface: "claude" as const,
      status: 200,
      durationMs: 12,
      usageStatus: "reported" as const,
      usage: { inputTokens: 15, outputTokens: 7, cacheReadInputTokens: 3 },
      attempts: [
        {
          ordinal: 1, provider: "alpha", model: "model-a", adapter: "openai-chat",
          status: 200, durationMs: 5, sendCount: 1, recoveryKinds: [],
          usageStatus: "reported" as const, usage: { inputTokens: 10, outputTokens: 5 },
        },
        {
          ordinal: 2, provider: "beta", model: "model-b", adapter: "openai-chat",
          status: 200, durationMs: 7, sendCount: 1, recoveryKinds: [],
          usageStatus: "estimated" as const,
          usage: { inputTokens: 5, outputTokens: 2, estimated: true },
        },
      ],
    };
    const dimensions = new Map([
      [`${1}\0alpha`, 1], [`${2}\0model-a`, 2],
      [`${1}\0beta`, 3], [`${2}\0model-b`, 4],
    ]);

    const rows = dashboardRollupRowsForTest([entry], dimensions);

    expect(rows.requests).toHaveLength(1);
    expect(rows.requests[0]).toMatchObject({
      hour: "2026-08-11T15:00:00.000Z",
      surface_code: 1,
      request_count: 1,
      attempt_count: 2,
      reported_request_count: 1,
      input_tokens: 15,
      output_tokens: 7,
      cache_read_input_tokens: 3,
    });
    expect(rows.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_id: 1, model_id: 2, request_count: 1, attempt_count: 1 }),
      expect.objectContaining({ provider_id: 3, model_id: 4, request_count: 1, attempt_count: 1, estimated_request_count: 1 }),
    ]));
    expect(rows.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_id: 1, request_count: 1, attempt_count: 1 }),
      expect.objectContaining({ provider_id: 3, request_count: 1, attempt_count: 1 }),
    ]));
  });
});
