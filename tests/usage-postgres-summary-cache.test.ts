import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { cachedUsageSummaryFromPostgres, summarizeUsageFromPostgres } from "../src/usage/postgres-summary";

describe("PostgreSQL usage summary cache", () => {
  test("serves completed all-range hours from the read model and the current hour from facts", async () => {
    const factWindows: unknown[][] = [];
    const tx = {
      unsafe: async (query: string, params: unknown[] = []) => {
        if (query.includes("dashboard_read_model_state")) return [{ ready: true }];
        if (query.includes("SELECT count(*) requests")) factWindows.push(params);
        if (query.includes("FROM opencodex_usage.requests")) return [];
        if (query.includes("dashboard_request_hourly") && !query.includes("GROUP BY")) {
          return [{
            requests: 3, oldest_occurred_at: "2026-08-10T00:00:00.000Z", attempt_count: 4,
            measured_requests: 2, reported_requests: 2, unreported_requests: 1,
            unsupported_requests: 0, estimated_requests: 0, input_tokens: 30, output_tokens: 6,
            cache_read_input_tokens: 5, cache_creation_input_tokens: 1,
            reasoning_output_tokens: 2, total_tokens: 36, estimated_cost_usd: 0.5,
            priced_requests: 2, unpriced_requests: 0, unmetered_requests: 1,
          }];
        }
        if (query.includes("dashboard_request_hourly")) {
          return [{ date: "2026-08-10", requests: 3, measured_requests: 2, reported_requests: 2, total_tokens: 36 }];
        }
        if (query.includes("dashboard_model_hourly") && query.includes("to_char")) {
          return [{ date: "2026-08-10", provider: "openai", model: "gpt-5.5", requests: 3, attempt_count: 4, total_tokens: 36 }];
        }
        if (query.includes("dashboard_model_hourly")) {
          return [{ provider: "openai", model: "gpt-5.5", requests: 3, attempt_count: 4,
            measured_requests: 2, reported_requests: 2, estimated_requests: 0,
            total_tokens: 36, input_tokens: 30, output_tokens: 6,
            estimated_cost_usd: 0.5, priced_attribution_count: 2 }];
        }
        if (query.includes("dashboard_provider_hourly")) {
          return [{ provider: "openai", requests: 3, attempt_count: 4,
            measured_requests: 2, reported_requests: 2, estimated_requests: 0,
            total_tokens: 36, estimated_cost_usd: 0.5, priced_attribution_count: 2 }];
        }
        return [];
      },
    };
    const sql = { begin: async (_mode: string, run: (transaction: typeof tx) => Promise<unknown>) => run(tx) } as unknown as SQL;

    const result = await summarizeUsageFromPostgres(sql, "all", Date.parse("2026-08-11T00:00:00Z"), "all");

    // The fourth parameter is the admission-key dimension id: null unless a key narrows the read.
    expect(factWindows).toEqual([[
      "2026-08-11T00:00:00.000Z", 0, "2026-08-11T00:00:00.000Z", null,
    ]]);
    expect(result.summary).toMatchObject({ requests: 3, attemptCount: 4, totalTokens: 36, estimatedCostUsd: 0.5 });
    expect(result.models[0]).toMatchObject({ provider: "openai", model: "gpt-5.5", requests: 3, estimatedCostUsd: 0.5 });
  });

  test("reads calendar week from completed hours and only the current hour from facts", async () => {
    const factWindows: unknown[][] = [];
    const rollupWindows: unknown[][] = [];
    const tx = {
      unsafe: async (query: string, params: unknown[] = []) => {
        if (query.includes("dashboard_read_model_state")) return [{ ready: true }];
        if (query.includes("SELECT count(*) requests")) {
          factWindows.push(params);
          return [{
            requests: 1, attempt_count: 1, measured_requests: 1, reported_requests: 1,
            unreported_requests: 0, unsupported_requests: 0, estimated_requests: 0,
            input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 5,
          }];
        }
        if (query.includes("dashboard_request_hourly") && !query.includes("GROUP BY")) {
          rollupWindows.push(params);
          return [{
            requests: 2, attempt_count: 3, measured_requests: 2, reported_requests: 2,
            unreported_requests: 0, unsupported_requests: 0, estimated_requests: 0,
            input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 10,
            estimated_cost_usd: 0, priced_requests: 0, unpriced_requests: 0, unmetered_requests: 2,
          }];
        }
        return [];
      },
    };
    const sql = { begin: async (_mode: string, run: (transaction: typeof tx) => Promise<unknown>) => run(tx) } as unknown as SQL;
    const now = Date.parse("2026-08-12T12:30:00.000Z");

    const result = await summarizeUsageFromPostgres(sql, "7d", now, "all");

    expect(result.summary).toMatchObject({ requests: 3, attemptCount: 4, totalTokens: 15 });
    expect(factWindows).toEqual([
      ["2026-08-12T12:00:00.000Z", 0, "2026-08-12T12:30:00.000Z", null],
    ]);
    expect(rollupWindows[0]).toEqual([
      "2026-08-09T16:00:00.000Z", 0, "2026-08-12T11:59:59.999Z",
    ]);
  });

  test("month uses Singapore boundaries and a complete leap-month day grid", async () => {
    const windows: unknown[][] = [];
    const tx = { unsafe: async (query: string, params: unknown[] = []) => {
      if (query.includes("dashboard_read_model_state")) return [{ ready: true }];
      if (query.includes("dashboard_request_hourly") && !query.includes("GROUP BY")) windows.push(params);
      return [];
    } };
    const sql = { begin: async (_mode: string, run: (transaction: typeof tx) => Promise<unknown>) => run(tx) } as unknown as SQL;
    const result = await summarizeUsageFromPostgres(sql, "30d", Date.parse("2024-02-29T23:59:59.999+08:00"), "all");
    expect(windows[0]?.[0]).toBe("2024-01-31T16:00:00.000Z");
    expect(result.days).toHaveLength(29);
    expect(result.days[0]?.date).toBe("2024-02-01");
    expect(result.days.at(-1)?.date).toBe("2024-02-29");
  });

  test("1d reads exactly one Singapore calendar day", async () => {
    const factWindows: unknown[][] = [];
    const rollupWindows: unknown[][] = [];
    const tx = {
      unsafe: async (query: string, params: unknown[] = []) => {
        if (query.includes("dashboard_read_model_state")) return [{ ready: true }];
        if (query.includes("SELECT count(*) requests")) factWindows.push(params);
        if (query.includes("dashboard_request_hourly") && !query.includes("GROUP BY")) rollupWindows.push(params);
        return [];
      },
    };
    const sql = { begin: async (_mode: string, run: (transaction: typeof tx) => Promise<unknown>) => run(tx) } as unknown as SQL;
    const endOfSingaporeDay = Date.parse("2026-08-12T23:59:59.999+08:00");

    const result = await summarizeUsageFromPostgres(sql, "1d", endOfSingaporeDay, "all");

    expect(result.since).toBe(Date.parse("2026-08-12T00:00:00.000+08:00"));
    expect(result.days.map(day => day.date)).toEqual(["2026-08-12"]);
    expect(factWindows).toEqual([
      ["2026-08-12T15:00:00.000Z", 0, "2026-08-12T15:59:59.999Z", null],
    ]);
    expect(rollupWindows[0]).toEqual([
      "2026-08-11T16:00:00.000Z", 0, "2026-08-12T14:59:59.999Z",
    ]);
  });

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

  test("a zero-request rollup bucket never reaches the provider or model breakdown", async () => {
    // Repricing a past window zeroes the accumulator rows it replaces (the ingest role can UPDATE
    // but not DELETE), so the read model can legitimately hold bucket rows with no requests. They
    // must not render as empty provider/model lines.
    const tx = {
      unsafe: async (query: string) => {
        if (query.includes("dashboard_read_model_state")) return [{ ready: true }];
        if (query.includes("FROM opencodex_usage.requests")) return [];
        if (query.includes("dashboard_request_hourly") && !query.includes("GROUP BY")) {
          return [{
            requests: 5, oldest_occurred_at: "2026-08-10T00:00:00.000Z", attempt_count: 5,
            measured_requests: 5, reported_requests: 5, unreported_requests: 0,
            unsupported_requests: 0, estimated_requests: 0, input_tokens: 10, output_tokens: 2,
            cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
            reasoning_output_tokens: 0, total_tokens: 12, estimated_cost_usd: 0.25,
            priced_requests: 5, unpriced_requests: 0, unmetered_requests: 0,
          }];
        }
        if (query.includes("dashboard_request_hourly")) {
          return [{ date: "2026-08-10", requests: 5, measured_requests: 5, reported_requests: 5, total_tokens: 12 }];
        }
        if (query.includes("dashboard_model_hourly") && query.includes("to_char")) {
          return [
            { date: "2026-08-10", provider: "command-code", model: "deepseek/deepseek-v4.1-flash", requests: 5, attempt_count: 5, total_tokens: 12 },
            { date: "2026-08-10", provider: "command-code-93b610d2", model: "deepseek/deepseek-v4.1-flash", requests: 0, attempt_count: 0, total_tokens: 0 },
          ];
        }
        if (query.includes("dashboard_model_hourly")) {
          return [
            { provider: "command-code", model: "deepseek/deepseek-v4.1-flash", requests: 5, attempt_count: 5,
              measured_requests: 5, reported_requests: 5, estimated_requests: 0,
              total_tokens: 12, input_tokens: 10, output_tokens: 2,
              estimated_cost_usd: 0.25, priced_attribution_count: 5 },
            { provider: "command-code-93b610d2", model: "deepseek/deepseek-v4.1-flash", requests: 0, attempt_count: 0,
              measured_requests: 0, reported_requests: 0, estimated_requests: 0,
              total_tokens: 0, input_tokens: 0, output_tokens: 0,
              estimated_cost_usd: 0, priced_attribution_count: 0 },
          ];
        }
        if (query.includes("dashboard_provider_hourly")) {
          return [
            { provider: "command-code", requests: 5, attempt_count: 5, measured_requests: 5,
              reported_requests: 5, estimated_requests: 0, total_tokens: 12,
              estimated_cost_usd: 0.25, priced_attribution_count: 5 },
            { provider: "command-code-93b610d2", requests: 0, attempt_count: 0, measured_requests: 0,
              reported_requests: 0, estimated_requests: 0, total_tokens: 0,
              estimated_cost_usd: 0, priced_attribution_count: 0 },
          ];
        }
        return [];
      },
    };
    const sql = { begin: async (_mode: string, run: (transaction: typeof tx) => Promise<unknown>) => run(tx) } as unknown as SQL;

    const result = await summarizeUsageFromPostgres(sql, "all", Date.parse("2026-08-11T00:00:00Z"), "all");

    expect(result.providers.map(row => row.provider)).toEqual(["command-code"]);
    expect(result.models.map(row => row.provider)).toEqual(["command-code"]);
    expect(result.days.flatMap(day => day.models).map(row => row.provider)).toEqual(["command-code"]);
  });

  test("caches historical windows by their stable window key", async () => {
    let aggregateReads = 0;
    const tx = {
      unsafe: async (query: string) => {
        if (query.includes("SELECT count(*) requests")) aggregateReads++;
        return [];
      },
    };
    const sql = {
      begin: async (_mode: string, run: (transaction: typeof tx) => Promise<unknown>) => run(tx),
    } as unknown as SQL;
    const historicalEnd = Date.parse("2025-01-07T23:59:59.999+08:00");

    await cachedUsageSummaryFromPostgres(sql, "7d", historicalEnd, "all", false, "2025-01-07");
    await cachedUsageSummaryFromPostgres(sql, "7d", historicalEnd, "all", false, "2025-01-07");
    await cachedUsageSummaryFromPostgres(sql, "7d", historicalEnd, "all", false, "2025-01-14");

    expect(aggregateReads).toBe(2);
  });
});
