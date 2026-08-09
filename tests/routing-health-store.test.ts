import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeRoutingHealthStore,
  recentRoutingHealthSamples,
  recordRoutingHealthEntry,
  ROUTING_HEALTH_MAX_SAMPLES,
  ROUTING_HEALTH_MAX_TOTAL_SAMPLES,
  ROUTING_HEALTH_WINDOW_MS,
  routingHealthStoreStats,
} from "../src/routing/health-store";
import type { PersistedUsageEntry } from "../src/usage/log";

let testDir = "";
let previousHome: string | undefined;

function entry(requestId: string, overrides: Partial<PersistedUsageEntry> = {}): PersistedUsageEntry {
  return {
    requestId,
    timestamp: Date.now(),
    provider: "provider-a",
    model: "model-a",
    status: 200,
    durationMs: 100,
    usageStatus: "reported",
    ...overrides,
  };
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-routing-health-"));
  process.env.OPENCODEX_HOME = testDir;
  closeRoutingHealthStore();
});

afterEach(() => {
  closeRoutingHealthStore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  rmSync(testDir, { recursive: true, force: true });
});

describe("compact routing health store", () => {
  test("normalizes combo attempts without retaining the parent outcome", () => {
    recordRoutingHealthEntry(entry("combo", {
      provider: "provider-b",
      model: "model-b",
      attempts: [
        {
          ordinal: 1,
          provider: "provider-a",
          model: "model-a",
          adapter: "openai-chat",
          status: 503,
          durationMs: 400,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
        },
        {
          ordinal: 2,
          provider: "provider-b",
          model: "model-b",
          adapter: "openai-chat",
          status: 200,
          durationMs: 200,
          sendCount: 1,
          recoveryKinds: [],
          usageStatus: "reported",
        },
      ],
    }));

    expect(recentRoutingHealthSamples({ provider: "provider-a", model: "model-a" }))
      .toEqual([{ status: 503, closeReason: null, terminalStatus: null, durationMs: 400, timestamp: expect.any(Number) }]);
    expect(recentRoutingHealthSamples({ provider: "provider-b", model: "model-b" }))
      .toEqual([{ status: 200, closeReason: null, terminalStatus: null, durationMs: 200, timestamp: expect.any(Number) }]);
  });

  test("filters account-scoped evidence", () => {
    recordRoutingHealthEntry(entry("account-a", { apiKeyId: "key-a", status: 503 }));
    recordRoutingHealthEntry(entry("account-b", { apiKeyId: "key-b", status: 200 }));
    expect(recentRoutingHealthSamples({ provider: "provider-a", model: "model-a", accountRef: "key-a" }))
      .toHaveLength(1);
    expect(recentRoutingHealthSamples({ provider: "provider-a", model: "model-a", accountRef: "key-a" })[0]!.status)
      .toBe(503);
  });

  test("bounds queries and periodically prunes expired and excess samples", () => {
    const now = Date.now();
    recordRoutingHealthEntry(entry("expired", { timestamp: now - ROUTING_HEALTH_WINDOW_MS - 1 }));
    for (let index = 0; index < 300; index++) {
      recordRoutingHealthEntry(entry(`fresh-${index}`, { timestamp: now + index }));
    }

    const samples = recentRoutingHealthSamples({ provider: "provider-a", model: "model-a", now: now + 300 });
    expect(samples).toHaveLength(ROUTING_HEALTH_MAX_SAMPLES);
    expect(samples[0]!.timestamp).toBe(now + 299);
    expect(samples.at(-1)!.timestamp).toBe(now + 200);

    const stats = routingHealthStoreStats();
    expect(stats.oldestTimestamp).toBeGreaterThanOrEqual(now);
    expect(stats.sampleCount).toBeLessThanOrEqual(ROUTING_HEALTH_MAX_SAMPLES + 255);
    expect(stats.sampleCount).toBeLessThanOrEqual(ROUTING_HEALTH_MAX_TOTAL_SAMPLES);
    expect(stats.pageCount * stats.pageSize).toBeLessThan(512 * 1024);
  });
});
