import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createOpenAIChatAdapter } from "../src/adapters/openai-chat";
import { parseRequest } from "../src/responses/parser";
import {
  clearReasoningReplayCacheForTests,
  rememberReasoningForCall,
} from "../src/responses/reasoning-replay-cache";
import { routeModel } from "../src/router";
import { canonicalDestinationCapabilities, PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxConfig } from "../src/types";

/**
 * Regression coverage for the live `deepseek-flash` route failure:
 *
 *   Provider error 400: The `reasoning_content` in the thinking mode must be
 *   passed back to the API.
 *
 * Two independent gaps produced it, and both are asserted here:
 *
 * 1. The alias `deepseek-flash` was missing from DeepSeek's
 *    `preserveReasoningContentModels`, so a tool continuation on the live alias
 *    was serialized without `reasoning_content`.
 * 2. An operator-defined provider pointed at the canonical DeepSeek API
 *    (`deepseek-official`) matches no registry id, so it inherited no
 *    capabilities at all — even for models the registry does list.
 */

const CUSTOM_PROVIDER = "deepseek-official";
const ALIAS = "deepseek-flash";
const CANONICAL_IDS_MODEL = "deepseek-v4-flash";
const REASONING = "I should read the file before answering.";

function customConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: CUSTOM_PROVIDER,
    providers: {
      [CUSTOM_PROVIDER]: {
        adapter: "openai-chat",
        baseUrl: "https://api.deepseek.com",
        apiKey: "custom-key",
        // Deliberately no capability lists: this mirrors the live config that failed.
      },
    },
  };
}

function wireAssistant(body: string): Record<string, unknown> | undefined {
  const parsed = JSON.parse(body) as { messages: Array<Record<string, unknown>> };
  return parsed.messages.find(m => m.role === "assistant" && Array.isArray(m.tool_calls));
}

/** History whose assistant turn survived compaction but lost its reasoning item. */
function compactedToolRound() {
  return [
    { type: "message", role: "user", content: [{ type: "input_text", text: "inspect the repo" }] },
    { type: "compaction", encrypted_content: "ocx1:c3VtbWFyeQ==" },
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"README.md"}' },
    { type: "function_call_output", call_id: "call_1", output: "contents" },
  ];
}

async function buildCustomProviderRequest(modelRef: string): Promise<Record<string, unknown> | undefined> {
  const parsed = parseRequest({ model: modelRef, input: compactedToolRound(), stream: true });
  const route = routeModel(customConfig(), parsed.modelId);
  parsed.modelId = route.modelId;
  const request = await createOpenAIChatAdapter(route.provider).buildRequest(parsed);
  return wireAssistant(request.body as string);
}

describe("deepseek thinking mode — reasoning_content replay capability", () => {
  beforeEach(() => {
    clearReasoningReplayCacheForTests();
  });
  afterEach(() => {
    clearReasoningReplayCacheForTests();
  });

  test("the live deepseek-flash alias is registered as requiring reasoning replay", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "deepseek");
    expect(entry).toBeDefined();
    expect(entry!.preserveReasoningContentModels).toContain(ALIAS);
    // The canonical ids must not be displaced by adding the alias.
    expect(entry!.preserveReasoningContentModels).toContain(CANONICAL_IDS_MODEL);
  });

  test("a custom provider pointed at the canonical DeepSeek API inherits the replay requirement", () => {
    const route = routeModel(customConfig(), `${CUSTOM_PROVIDER}/${ALIAS}`);
    expect(route.providerName).toBe(CUSTOM_PROVIDER);
    expect(route.provider.preserveReasoningContentModels).toContain(ALIAS);
  });

  test("a custom provider elsewhere does not gain DeepSeek replay behaviour", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "my-gateway",
      providers: {
        "my-gateway": {
          adapter: "openai-chat",
          baseUrl: "https://gateway.example.com/v1",
          apiKey: "key",
        },
      },
    };
    const route = routeModel(config, `my-gateway/${ALIAS}`);
    expect(route.provider.preserveReasoningContentModels).toBeUndefined();
    expect(canonicalDestinationCapabilities("https://gateway.example.com/v1")).toBeUndefined();
  });

  test("destination capabilities only cover HTTPS canonical DeepSeek", () => {
    expect(canonicalDestinationCapabilities("https://api.deepseek.com")?.preserveReasoningContentModels).toContain(ALIAS);
    expect(canonicalDestinationCapabilities("https://api.deepseek.com/v1")?.preserveReasoningContentModels).toContain(ALIAS);
    expect(canonicalDestinationCapabilities("http://api.deepseek.com")).toBeUndefined();
    expect(canonicalDestinationCapabilities("https://api.deepseek.com.evil.example")).toBeUndefined();
    expect(canonicalDestinationCapabilities(undefined)).toBeUndefined();
  });

  test("CONTROL: the custom DeepSeek route replays reasoning_content on a compacted tool continuation", async () => {
    rememberReasoningForCall("call_1", REASONING);
    const assistant = await buildCustomProviderRequest(`${CUSTOM_PROVIDER}/${ALIAS}`);
    expect(assistant).toBeDefined();
    expect(assistant!.reasoning_content).toBe(REASONING);
  });

  test("the canonical id on the same custom route replays too", async () => {
    rememberReasoningForCall("call_1", REASONING);
    const assistant = await buildCustomProviderRequest(`${CUSTOM_PROVIDER}/${CANONICAL_IDS_MODEL}`);
    expect(assistant).toBeDefined();
    expect(assistant!.reasoning_content).toBe(REASONING);
  });
});
