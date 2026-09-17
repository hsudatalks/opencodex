import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { applyProviderConfigHints } from "../src/codex/catalog";
import { catalogHintsFromProviderConfig } from "../src/codex/catalog/provider-fetch";
import { providerConfigSeed } from "../src/providers/derive";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxConfig } from "../src/types";

/**
 * A model's IMAGE support used to be declared on only one of the two discovery paths.
 *
 * The Codex catalog stamps `input_modalities` from the vendored model bundle
 * (`applyCatalogMetadata`), while the gathered rows behind the plain `/v1/models` shape — and
 * behind the Anthropic discovery shape, which turns the same field into
 * `capabilities.image_input` — read only the provider config and the `noVisionModels` sidecar
 * list. For a provider that reports no modality metadata of its own and has no registry
 * `modelInputModalities` entry (Anthropic, Gemini, MiniMax, Kimi…), every one of those models
 * therefore published NO modality at all through `/v1/models`, and Claude Code/Desktop were told
 * routed Claude models do not accept images.
 *
 * A missing field and a text-only field are the same refusal to a client that gates attachments
 * on it, so these tests pin the bundle as the last-resort source — after live discovery and the
 * operator's own config, exactly the rank the bundled context window already has.
 */
const previousHome = process.env.OPENCODEX_HOME;
let testHome = "";

function modalityConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "anthropic",
    providers: {
      // Registry declares NO modelInputModalities for either: the bundle is the only source.
      anthropic: {
        adapter: "anthropic",
        authMode: "oauth",
        baseUrl: "https://api.anthropic.com/v1",
        liveModels: false,
      },
      minimax: {
        adapter: "openai-chat",
        authMode: "key",
        baseUrl: "https://api.minimax.io/v1",
        liveModels: false,
      },
    },
  };
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-input-modalities-"));
  process.env.OPENCODEX_HOME = testHome;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

async function listRows(): Promise<Array<Record<string, unknown>>> {
  saveConfig(modalityConfig());
  const server = startServer(0);
  try {
    const res = await fetch(new URL("/v1/models", server.url));
    expect(res.status).toBe(200);
    const body = await res.json() as { data?: Array<Record<string, unknown>> };
    return body.data ?? [];
  } finally {
    await server.stop(true);
  }
}

describe("plain /v1/models input-modality advertisement", () => {
  test("vision models the bundle knows about are no longer published as modality-less", async () => {
    const rows = await listRows();
    // Every Claude row is image-capable; before the bundle fallback all of them published no
    // `input_modalities` at all while the Codex catalog advertised ["text","image"] for them.
    for (const id of [
      "anthropic/claude-opus-4-8",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4-5",
    ]) {
      const row = rows.find(r => r.id === id);
      expect(row).toBeDefined();
      expect(row!.input_modalities).toEqual(["text", "image"]);
    }
  });

  test("a bundle that also says video publishes only the enum Codex accepts", async () => {
    const rows = await listRows();
    // The bundle records MiniMax-M3 as text + image + video. Codex parses `input_modalities` as a
    // closed enum of text | image | audio, and one out-of-enum value makes it reject the whole
    // catalog (#759), so "video" must never survive onto the wire.
    const row = rows.find(r => r.id === "minimax/MiniMax-M3");
    expect(row).toBeDefined();
    expect(row!.input_modalities).toEqual(["text", "image"]);
    expect(row!.input_modalities as string[]).not.toContain("video");
  });

  test("the Anthropic discovery shape reports routed Claude rows as image-capable", async () => {
    saveConfig(modalityConfig());
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/models?flavor=anthropic&ids=cli", server.url));
      expect(res.status).toBe(200);
      const body = await res.json() as { data?: Array<Record<string, unknown>> };
      const routed = (body.data ?? []).filter(row => String(row.display_name ?? "").includes("(anthropic)"));
      // This is the client-visible half of the defect: Claude Code gates its attach button on
      // `capabilities.image_input.supported`, and every routed row used to answer false.
      expect(routed.length).toBeGreaterThan(0);
      for (const row of routed) {
        const capabilities = row.capabilities as { image_input?: { supported?: boolean } } | undefined;
        expect(capabilities?.image_input?.supported).toBe(true);
      }
    } finally {
      await server.stop(true);
    }
  });
});

describe("input-modality precedence", () => {
  const anthropicSeed = providerConfigSeed(PROVIDER_REGISTRY.find(e => e.id === "anthropic")!);

  test("live discovery outranks the bundled bundle", () => {
    const hinted = applyProviderConfigHints("anthropic", anthropicSeed, {
      id: "claude-opus-4-8",
      provider: "anthropic",
      inputModalities: ["text"],
    });
    expect(hinted.inputModalities).toEqual(["text"]);
  });

  test("an operator's explicit text-only declaration outranks the bundle", () => {
    const prov = { ...anthropicSeed, modelInputModalities: { "claude-opus-4-8": ["text"] } };
    const hinted = applyProviderConfigHints("anthropic", prov, { id: "claude-opus-4-8", provider: "anthropic" });
    expect(hinted.inputModalities).toEqual(["text"]);
  });

  test("the sidecar rule still outranks the bundle for a text-only model it describes", () => {
    // noVisionModels means "the proxy describes this model's images", so the catalog must
    // advertise image even though the bundle records the model itself as text-only.
    const prov = { ...anthropicSeed, noVisionModels: ["claude-opus-4-8"] };
    const hinted = applyProviderConfigHints("anthropic", prov, { id: "claude-opus-4-8", provider: "anthropic" });
    expect(hinted.inputModalities).toContain("image");
  });

  test("a provider the bundle does not cover stays silent instead of guessing", () => {
    // Unknown must stay unknown: publishing ["text"] for every uncovered model would tell a
    // vision model's clients that images are unsupported, which is the defect being fixed.
    const hints = catalogHintsFromProviderConfig("groq", { adapter: "openai-chat" }, "some-unlisted-model");
    expect(hints.inputModalities).toBeUndefined();
  });
});

describe("registry declarations the bundle cannot supply", () => {
  function hintsFor(provider: string, modelId: string) {
    const entry = PROVIDER_REGISTRY.find(e => e.id === provider);
    expect(entry).toBeDefined();
    return catalogHintsFromProviderConfig(provider, providerConfigSeed(entry!), modelId);
  }

  test("kimi-for-coding is image-capable despite the text-only-sounding id", () => {
    // The Kimi Code model table's "Multimodal input" column lists image + video for
    // `kimi-for-coding`; only the `k3` family was declared. The provider has no bundle of its
    // own, so the registry is the only place this can be stated.
    // Evidence: https://www.kimi.com/code/docs/en/kimi-code/models.html
    for (const provider of ["kimi", "kimi-code"]) {
      expect(hintsFor(provider, "kimi-for-coding").inputModalities).toEqual(["text", "image"]);
    }
  });

  test("the DeepSeek V4.1 rows share their V4 siblings' sidecar coverage", () => {
    // The pair was hand-written as V4-only, so V4.1 got neither an image declaration nor the
    // sidecar while the official `deepseek` provider treated the same upstream model the
    // opposite way. Both providers now derive the list from DEEPSEEK_ALL_THINKING_MODELS.
    for (const id of ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-v4.1-flash", "deepseek-v4.1-pro"]) {
      expect(hintsFor("opencode-go", id).inputModalities).toEqual(["text", "image"]);
    }
  });
});
