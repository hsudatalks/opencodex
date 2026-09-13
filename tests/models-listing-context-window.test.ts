import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";

/**
 * The plain (non-Codex, non-Anthropic) `/v1/models` shape is what a generic OpenAI-style client
 * discovers an endpoint with — DeepSeek Harness reads `contextWindow` / `context_window` /
 * `context_length` / `max_input_tokens` from it and falls back to its own 262144 default when none
 * is present. A model the proxy knows the capacity of must therefore advertise it here, and a model
 * it knows nothing about must stay silent rather than inherit the Codex catalog's 128k floor.
 */
const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";

function contextConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "deepseek-official",
    providers: {
      "deepseek-official": {
        adapter: "openai-chat",
        baseUrl: "https://api.deepseek.com",
        liveModels: false,
        models: ["deepseek-v4-flash", "deepseek-v4-pro"],
        modelContextWindows: {
          "deepseek-v4-flash": 1_048_576,
          "deepseek-v4-pro": 1_048_576,
        },
      },
      // No configured window and no live discovery: the proxy has no evidence for this model.
      "undocumented": {
        adapter: "openai-chat",
        baseUrl: "https://undocumented.test/v1",
        liveModels: false,
        models: ["mystery-model"],
      },
      // Native rows come from the pinned upstream snapshot, not from any provider config.
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        liveModels: false,
      },
    },
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-context-window-list-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("raw /v1/models list context-window advertisement", () => {
  test("routed models with a known window advertise it for generic discovery clients", async () => {
    saveConfig(contextConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as { data: Array<Record<string, unknown>> };
      for (const id of ["deepseek-official/deepseek-v4-flash", "deepseek-official/deepseek-v4-pro"]) {
        const row = body.data.find(m => m.id === id);
        expect(row).toBeDefined();
        expect(row!.context_window).toBe(1_048_576);
      }
    } finally {
      await server.stop(true);
    }
  });

  test("native rows advertise the pinned upstream window", async () => {
    saveConfig(contextConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      const body = await res.json() as { data: Array<Record<string, unknown>> };
      const sol = body.data.find(m => m.id === "gpt-5.6-sol");
      expect(sol).toBeDefined();
      expect(sol!.context_window).toBe(372_000);
    } finally {
      await server.stop(true);
    }
  });

  test("an unknown window stays absent instead of leaking the catalog's 128k floor", async () => {
    saveConfig(contextConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models", server.url));
      const body = await res.json() as { data: Array<Record<string, unknown>> };
      const row = body.data.find(m => m.id === "undocumented/mystery-model");
      expect(row).toBeDefined();
      expect("context_window" in row!).toBe(false);
    } finally {
      await server.stop(true);
    }
  });
});
