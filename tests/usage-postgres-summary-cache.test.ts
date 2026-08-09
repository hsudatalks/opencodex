import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { cachedUsageSummaryFromPostgres } from "../src/usage/postgres-summary";

describe("PostgreSQL usage summary cache", () => {
  test("explicit refresh waits for and stores a fresh aggregate", async () => {
    let requests = 1;
    let aggregateReads = 0;
    const tx = {
      unsafe: async (query: string) => {
        if (query.includes("SELECT count(*) requests")) {
          aggregateReads++;
          return [{
            requests,
            attempt_count: requests,
            measured_requests: requests,
            reported_requests: requests,
            unreported_requests: 0,
            unsupported_requests: 0,
            estimated_requests: 0,
            input_tokens: requests,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: requests,
          }];
        }
        return [];
      },
    };
    const sql = {
      begin: async (_mode: string, run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
    } as unknown as SQL;

    const first = await cachedUsageSummaryFromPostgres(sql, "30d", Date.now(), "all");
    requests = 2;
    const cached = await cachedUsageSummaryFromPostgres(sql, "30d", Date.now(), "all");
    const refreshed = await cachedUsageSummaryFromPostgres(sql, "30d", Date.now(), "all", true);
    const afterRefresh = await cachedUsageSummaryFromPostgres(sql, "30d", Date.now(), "all");

    expect(first.summary.requests).toBe(1);
    expect(cached.summary.requests).toBe(1);
    expect(refreshed.summary.requests).toBe(2);
    expect(afterRefresh.summary.requests).toBe(2);
    expect(aggregateReads).toBe(2);
  });
});
