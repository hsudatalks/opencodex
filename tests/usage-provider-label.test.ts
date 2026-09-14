import { describe, expect, test } from "bun:test";
import { baseProviderLabel } from "../src/providers/label";

describe("baseProviderLabel", () => {
  test("returns the input when there is no pool suffix", () => {
    expect(baseProviderLabel("openai")).toBe("openai");
    expect(baseProviderLabel("anthropic")).toBe("anthropic");
  });

  test("normalizes ChatGPT auth usage into the OpenAI display provider", () => {
    expect(baseProviderLabel("chatgpt")).toBe("openai");
    expect(baseProviderLabel("chatgpt-main")).toBe("openai");
    expect(baseProviderLabel("chatgpt-p104398")).toBe("openai");
  });

  test("normalizes historical Multi rows while keeping API-key usage distinct", () => {
    expect(baseProviderLabel("openai-multi")).toBe("openai");
    expect(baseProviderLabel("openai-multi-p104398")).toBe("openai");
    expect(baseProviderLabel("openai-multi-main")).toBe("openai");
    expect(baseProviderLabel("openai-apikey")).toBe("openai-apikey");
  });

  test("strips a lowercase-hex pool suffix matching CODEX_ACCOUNT_LOG_LABEL_RE", () => {
    expect(baseProviderLabel("openai-p104398")).toBe("openai");
    expect(baseProviderLabel("anthropic-pabc123")).toBe("anthropic");
  });

  test("strips the legacy -main suffix so historical main-account rows aggregate", () => {
    expect(baseProviderLabel("openai-main")).toBe("openai");
    expect(baseProviderLabel("codex-main")).toBe("codex");
  });

  test("strips a pool ACCOUNT ID suffix, which is what Command Code logs", () => {
    // Live symptom: today's usage page showed 4,936 unbillable requests. Every command-code
    // attempt was logged as `command-code-<8 hex account id>`, which never matched the
    // provider's price rows, and any combo turn whose attempt chain touched one lost its
    // whole-entry price too.
    expect(baseProviderLabel("command-code-93b610d2")).toBe("command-code");
    expect(baseProviderLabel("command-code-95a23976")).toBe("command-code");
    expect(baseProviderLabel("deepseek-official-0a1b2c3d")).toBe("deepseek-official");
  });

  test("keeps suffixes that do not match the pool log-label shape", () => {
    expect(baseProviderLabel("chatgpt-pABC123")).toBe("chatgpt-pABC123"); // uppercase not allowed
    expect(baseProviderLabel("chatgpt-p12345")).toBe("chatgpt-p12345");   // 5 hex, not 6
    expect(baseProviderLabel("chatgpt-p1234567")).toBe("chatgpt-p1234567"); // 7 hex, not 6
    expect(baseProviderLabel("anthropic-claude")).toBe("anthropic-claude");
    // The account-id shape is exactly 8 lowercase hex characters.
    expect(baseProviderLabel("command-code-93b610d")).toBe("command-code-93b610d");   // 7
    expect(baseProviderLabel("command-code-93b610d2a")).toBe("command-code-93b610d2a"); // 9
    expect(baseProviderLabel("command-code-93B610D2")).toBe("command-code-93B610D2"); // uppercase
    expect(baseProviderLabel("command-code-zzzzzzzz")).toBe("command-code-zzzzzzzz"); // not hex
  });

  test("leaves bare provider names with leading or trailing dashes alone", () => {
    expect(baseProviderLabel("-pabc123")).toBe("-pabc123"); // empty head
    expect(baseProviderLabel("chatgpt-")).toBe("chatgpt-");  // empty tail
  });
});
