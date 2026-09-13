import { expect, test } from "bun:test";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../src/codex/catalog/native-models";
import { DOCUMENTED_NATIVE_OPENAI_ADDITIONS, nativeInputModalities, nativeOpenAiContextWindow, nativeReasoningEfforts, upstreamNativeEntry } from "../src/codex/catalog/metadata";

test("Astra survives native discovery and carries the Codex subscription metadata", () => {
  const slug = "gpt-6-astra";
  expect(SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)).toBe(true);
  expect(DOCUMENTED_NATIVE_OPENAI_ADDITIONS).toContain(slug);
  expect(upstreamNativeEntry(slug)?.slug).toBe(slug);
  expect(upstreamNativeEntry(slug)?.minimal_client_version).toBeUndefined();
  expect(nativeOpenAiContextWindow(slug)).toBe(272000);
  expect(nativeInputModalities(slug)).toEqual(["text", "image"]);
  expect(nativeReasoningEfforts(slug)).toContain("high");
});
