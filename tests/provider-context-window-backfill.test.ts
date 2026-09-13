import { describe, expect, test } from "bun:test";
import { applyProviderConfigHints } from "../src/codex/catalog";
import { enrichProviderFromRegistry } from "../src/providers/derive";
import type { OcxProviderConfig } from "../src/types";

/**
 * `modelContextWindows` backfill, in both directions it can fail.
 *
 * Name-based: `enrichProviderFromRegistry` used to fill the map all-or-nothing, so a config
 * persisted before the registry learned a model kept that model without any capacity — the
 * Codex catalog then published its 128k conservative floor and `/v1/models` published nothing,
 * which is how the central Gateway understated a 1M DeepSeek by 8x. `modelReasoningEfforts`
 * and `modelInputModalities` were already fixed to per-key fill; this map was missed.
 *
 * Destination-based: the live Gateway's row is named `deepseek-official`, which matches no
 * registry id at all, so only the destination match can reach it.
 */
describe("modelContextWindows registry backfill", () => {
  test("a partial persisted map keeps operator keys and gains newer registry ids", () => {
    const opencodeGo = {
      adapter: "openai-chat",
      baseUrl: "https://opencode.ai/zen/go/v1",
      authMode: "key",
      modelContextWindows: { "kimi-k3": 262_144 },
    } as OcxProviderConfig;
    enrichProviderFromRegistry("opencode-go", opencodeGo);
    // The operator's own entry survives untouched...
    expect(opencodeGo.modelContextWindows?.["kimi-k3"]).toBe(262_144);
    // ...and the registry's newer ids are backfilled beneath it instead of being skipped.
    expect(opencodeGo.modelContextWindows?.["deepseek-flash"]).toBe(1_048_576);

    const zhipu = {
      adapter: "openai-chat",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      authMode: "key",
      modelContextWindows: { "glm-5.2": 1_000_000, "glm-5.2[1m]": 1_000_000 },
    } as OcxProviderConfig;
    enrichProviderFromRegistry("zhipu-bigmodel-coding", zhipu);
    expect(zhipu.modelContextWindows?.["glm-5.2"]).toBe(1_000_000);
    expect(zhipu.modelContextWindows?.["glm-5.3"]).toBe(1_000_000);
    expect(zhipu.modelContextWindows?.["glm-5.3-flash"]).toBe(1_000_000);
  });

  test("an operator window still overrides the registry for that same model", () => {
    const prov = {
      adapter: "openai-chat",
      baseUrl: "https://opencode.ai/zen/go/v1",
      authMode: "key",
      modelContextWindows: { "deepseek-flash": 200_000 },
    } as OcxProviderConfig;
    enrichProviderFromRegistry("opencode-go", prov);
    expect(prov.modelContextWindows?.["deepseek-flash"]).toBe(200_000);
  });

  test("a row at the official DeepSeek destination inherits the official V4 windows", () => {
    const prov = {
      adapter: "openai-chat",
      baseUrl: "https://api.deepseek.com",
    } as OcxProviderConfig;
    enrichProviderFromRegistry("deepseek-official", prov);
    expect(prov.modelContextWindows?.["deepseek-v4-flash"]).toBe(1_048_576);
    expect(prov.modelContextWindows?.["deepseek-v4-pro"]).toBe(1_048_576);
    // The live alias the official API resolves itself is the same V4 flash model.
    expect(prov.modelContextWindows?.["deepseek-flash"]).toBe(1_048_576);
  });

  test("an unrecognized destination gets no invented window", () => {
    const prov = {
      adapter: "openai-chat",
      baseUrl: "https://unknown-vendor.test/v1",
    } as OcxProviderConfig;
    enrichProviderFromRegistry("some-private-row", prov);
    expect(prov.modelContextWindows).toBeUndefined();
  });
});

/**
 * The vendored metadata bundle is the repo's own record of a model's capacity, and the Codex
 * catalog already stamped entries from it. Gathered rows (`/v1/models`, `/api/models`) did not,
 * so the same model was sized on one surface and blank on another.
 */
describe("vendored metadata as the last-resort context window", () => {
  const opencodeGo = () => ({
    adapter: "openai-chat",
    baseUrl: "https://opencode.ai/zen/go/v1",
    authMode: "key",
  } as OcxProviderConfig);

  test("a model neither configured nor discoverable takes the bundled capacity", () => {
    const hinted = applyProviderConfigHints(
      "opencode-go",
      opencodeGo(),
      { provider: "opencode-go", id: "deepseek-v4-flash" },
    );
    expect(hinted.contextWindow).toBe(1_000_000);
  });

  test("a configured window still outranks the bundle", () => {
    const prov = opencodeGo();
    prov.modelContextWindows = { "deepseek-v4-flash": 300_000 };
    const hinted = applyProviderConfigHints(
      "opencode-go",
      prov,
      { provider: "opencode-go", id: "deepseek-v4-flash" },
    );
    expect(hinted.contextWindow).toBe(300_000);
  });

  test("a live-discovered window still outranks the bundle", () => {
    const hinted = applyProviderConfigHints(
      "opencode-go",
      opencodeGo(),
      { provider: "opencode-go", id: "deepseek-v4-flash", contextWindow: 500_000 },
    );
    expect(hinted.contextWindow).toBe(500_000);
  });

  test("a model the bundle does not describe stays unsized rather than guessed", () => {
    const hinted = applyProviderConfigHints(
      "opencode-go",
      opencodeGo(),
      { provider: "opencode-go", id: "totally-unknown-model" },
    );
    expect(hinted.contextWindow).toBeUndefined();
  });
});
