import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, validateConfigCandidate } from "../src/config";
import { startServer } from "../src/server";
import { handleEvaluation, evaluationModelList } from "../src/server/evaluations";
import { getRequestLogEntries, clearRequestLogsForTests, type RequestLogContext } from "../src/server/request-log";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

const originals = { home: process.env.OPENCODEX_HOME, key: process.env.OCX_TEST_EVALUATION_KEY, auth: process.env.OPENCODEX_API_AUTH_TOKEN };
let home: string, codex: IsolatedCodexHome;
const dataKey = "ocx_data_evaluation_fixture";
const providerKey = "evaluation-provider-fixture";
const input = { model: "typesafe/jev-1.13.0", state: "Private test evidence", questions: {
  urgent: { type: "noul", instructions: "Is this urgent?" },
  team: { type: "choice", instructions: "Which team?", criteria: { a: "One", b: "Two" } },
  score: { type: "score", instructions: "Rate it", criteria: ["Low", "High"] },
} };
const output = { model: "jev-1.13.0", answers: {
  urgent: { type: "noul", noul: 0.9 },
  team: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.6 },
  score: { type: "score", score: 0.7, probabilities: { "0": 0.3, "1": 0.7 } },
}, usage: { input_tokens: 120, output_tokens: 25 } };
function config(endpoint: string): OcxConfig {
  return { port: 0, hostname: "0.0.0.0", deploymentMode: "server", defaultProvider: "unused",
    providers: { unused: { adapter: "openai-chat", baseUrl: "https://example.test/v1", disabled: true, models: ["chat-only"] } },
    clientIntegrations: { codex: false },
    apiKeys: [{ id: "evaluation-client", name: "fixture", key: dataKey, createdAt: "2026-09-20T00:00:00Z" }],
    evaluations: { providers: { typesafe: { protocol: "typesafe", endpoint, apiKeyEnv: "OCX_TEST_EVALUATION_KEY", models: ["jev-1.13.0"] } } },
  };
}
function request(body: unknown = input, signal?: AbortSignal) {
  return new Request("http://127.0.0.1/v1/evaluate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
}
const log = (): RequestLogContext => ({ model: "unknown", provider: "unknown", inboundProtocol: "evaluate" });
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-evaluation-")); process.env.OPENCODEX_HOME = home;
  process.env.OCX_TEST_EVALUATION_KEY = providerKey; delete process.env.OPENCODEX_API_AUTH_TOKEN;
  codex = installIsolatedCodexHome(); clearRequestLogsForTests();
});
afterEach(() => {
  for (const [key, value] of Object.entries({ OPENCODEX_HOME: originals.home, OCX_TEST_EVALUATION_KEY: originals.key, OPENCODEX_API_AUTH_TOKEN: originals.auth })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  codex.restore(); rmSync(home, { recursive: true, force: true }); clearRequestLogsForTests();
});

test("typed routes enforce gateway admission and CORS; use only the provider key; attribute usage without evidence", async () => {
  const captured: Array<{ headers: Headers; body: unknown }> = [];
  const upstream = Bun.serve({ port: 0, async fetch(req) { captured.push({ headers: req.headers, body: await req.json() }); return Response.json({ ...output, privateDebug: providerKey }); } });
  saveConfig(config(upstream.url.href)); const server = startServer(0);
  try {
    for (const path of ["/v1/evaluate", "/v1/systemone"]) {
      for (const headers of [{}, { authorization: "Bearer access-token-arbitrary-upstream" }, { "x-api-key": dataKey }]) {
        const denied = await fetch(new URL(path, server.url), { method: "POST", headers, body: "not-json" });
        expect(denied.status).toBe(401);
      }
      const deniedOrigin = await fetch(new URL(path, server.url), { method: "POST", headers: { authorization: `Bearer ${dataKey}`, origin: "https://foreign.example" } });
      expect(deniedOrigin.status).toBe(403);
      expect(captured).toHaveLength(path === "/v1/evaluate" ? 0 : 1);
      const good = await fetch(new URL(path, server.url), { method: "POST",
        headers: { authorization: `Bearer ${dataKey}`, "content-type": "application/json", "x-api-key": "caller-provider-key", "x-secret-custom": "must-not-forward" }, body: JSON.stringify(input) });
      expect(good.status).toBe(200); expect(await good.json()).toEqual(output);
    }
    expect(captured).toHaveLength(2);
    expect(captured[0].headers.get("authorization")).toBe(`Bearer ${providerKey}`);
    expect(captured[0].headers.has("x-api-key")).toBe(false);
    expect(captured[0].headers.has("x-secret-custom")).toBe(false);
    expect(captured[0].body).toEqual({ ...input, model: "jev-1.13.0" });
    const entries = getRequestLogEntries().filter(row => row.inboundProtocol === "evaluate");
    expect(entries).toHaveLength(2); expect(entries[0].apiKeyId).toBe("evaluation-client");
    expect(entries[0].usage?.inputTokens).toBe(120); expect(entries[0].usage?.outputTokens).toBe(25);
    expect(entries[0].usageStatus).toBe("reported");
    const serialized = JSON.stringify(entries);
    for (const secret of [providerKey, dataKey, input.state]) expect(serialized).not.toContain(secret);
    const catalog = await fetch(new URL("/v1/models?capability=evaluate", server.url), { headers: { authorization: `Bearer ${dataKey}` } });
    expect((await catalog.json()).data).toMatchObject([{ id: "typesafe/jev-1.13.0", evaluation_protocol: "typesafe" }]);
    const chat = await fetch(new URL("/v1/models", server.url), { headers: { authorization: `Bearer ${dataKey}` } });
    expect(await chat.text()).not.toContain("jev-");
  } finally { await server.stop(true); await upstream.stop(true); }
});

test("configuration requires administrator-owned destinations and environment credential references", () => {
  const base = config("https://api.typesafe.ai/v1/systemone");
  expect(validateConfigCandidate(base).ok).toBe(true);
  for (const endpoint of ["http://public.example/eval", "https://user:pass@example.test/eval", "https://example.test/eval?key=secret"]) {
    const candidate = structuredClone(base); candidate.evaluations!.providers.typesafe.endpoint = endpoint;
    expect(validateConfigCandidate(candidate).ok).toBe(false);
  }
  const embedded = structuredClone(base) as any; embedded.evaluations.providers.typesafe.apiKey = "do-not-store-me";
  const rejected = validateConfigCandidate(embedded); expect(rejected.ok).toBe(false);
  expect(JSON.stringify(rejected)).not.toContain("do-not-store-me");
  // A malformed hand edit disables evaluations while preserving admission keys.
  writeFileSync(join(home, "config.json"), JSON.stringify(embedded));
  const loaded = loadConfig();
  expect(loaded.evaluations).toBeUndefined();
  expect(loaded.apiKeys?.[0].id).toBe("evaluation-client");
});

test("disabled, unknown, ambiguous and caller-overridden routes never reach upstream", async () => {
  let calls = 0; const upstream = Bun.serve({ port: 0, fetch() { calls++; return Response.json(output); } });
  try {
    const cfg = config(upstream.url.href);
    expect((await handleEvaluation(request({ ...input, endpoint: upstream.url.href }), cfg, log())).status).toBe(400);
    expect((await handleEvaluation(request({ ...input, model: "unknown" }), cfg, log())).status).toBe(404);
    cfg.disabledModels = ["typesafe/jev-1.13.0"];
    expect(evaluationModelList(cfg).data).toHaveLength(0);
    expect((await handleEvaluation(request(), cfg, log())).status).toBe(404);
    delete cfg.disabledModels; cfg.evaluations!.providers.second = cfg.evaluations!.providers.typesafe;
    expect((await handleEvaluation(request({ ...input, model: "jev-1.13.0" }), cfg, log())).status).toBe(400);
    expect(calls).toBe(0);
  } finally { await upstream.stop(true); }
});

test("admission secrets cannot be configured as evaluation provider credentials", async () => {
  let calls = 0; const upstream = Bun.serve({ port: 0, fetch() { calls++; return Response.json(output); } });
  try {
    const cfg = config(upstream.url.href); process.env.OCX_TEST_EVALUATION_KEY = dataKey;
    expect((await handleEvaluation(request(), cfg, log())).status).toBe(503); expect(calls).toBe(0);
  } finally { await upstream.stop(true); }
});

test("upstream failures and malformed successes are redacted without retries", async () => {
  let calls = 0; let status = 401; let payload: unknown = { error: `${providerKey}: ${input.state}` };
  const upstream = Bun.serve({ port: 0, fetch() { calls++; return Response.json(payload, { status }); } });
  try {
    const cfg = config(upstream.url.href);
    for (const next of [401, 429, 503]) {
      status = next; const response = await handleEvaluation(request(), cfg, log());
      expect(response.status).toBe(next === 429 ? 429 : 502);
      const text = await response.text(); expect(text).not.toContain(providerKey); expect(text).not.toContain(input.state);
    }
    status = 200; payload = { ...output, answers: { ...output.answers, invented: { type: "noul", noul: 1 } } };
    expect((await handleEvaluation(request(), cfg, log())).status).toBe(502);
    payload = { ...output, answers: { ...output.answers, team: { ...output.answers.team, choice: providerKey } } };
    const response = await handleEvaluation(request(), cfg, log()); expect(response.status).toBe(502); expect(await response.text()).not.toContain(providerKey);
    expect(calls).toBe(5);
  } finally { await upstream.stop(true); }
});

test("deadline bounds stalled bodies and client abort; concurrency slot is released", async () => {
  let finish!: () => void; let calls = 0;
  const upstream = Bun.serve({ port: 0, async fetch() { calls++; await new Promise<void>(resolve => { finish = resolve; }); return Response.json(output); } });
  try {
    const cfg = config(upstream.url.href); cfg.evaluations!.timeoutMs = 100; cfg.evaluations!.maxConcurrent = 1;
    const first = handleEvaluation(request(), cfg, log());
    for (let i = 0; i < 100 && calls === 0; i++) await Bun.sleep(1);
    expect((await handleEvaluation(request(), cfg, log())).status).toBe(503);
    expect((await first).status).toBe(504); finish();
    const controller = new AbortController(); controller.abort();
    expect((await handleEvaluation(request(input, controller.signal), cfg, log())).status).toBe(499);
    expect(calls).toBe(1);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"model":')); } });
    const slow = new Request("http://127.0.0.1/v1/evaluate", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect((await handleEvaluation(slow, cfg, log())).status).toBe(504);
  } finally { finish?.(); await upstream.stop(true); }
});

test("redirects and oversized inputs/outputs fail closed", async () => {
  let destinationCalls = 0;
  const destination = Bun.serve({ port: 0, fetch() { destinationCalls++; return Response.json(output); } });
  let mode = "redirect";
  const upstream = Bun.serve({ port: 0, fetch() { return mode === "redirect" ? Response.redirect(destination.url.href) : new Response("x".repeat(2 * 1024 * 1024 + 1)); } });
  try {
    const cfg = config(upstream.url.href);
    expect((await handleEvaluation(request(), cfg, log())).status).toBe(502); expect(destinationCalls).toBe(0);
    mode = "oversized"; expect((await handleEvaluation(request(), cfg, log())).status).toBe(502);
    expect((await handleEvaluation(request({ ...input, state: "x".repeat(512 * 1024) }), cfg, log())).status).toBe(413);
  } finally { await upstream.stop(true); await destination.stop(true); }
});
