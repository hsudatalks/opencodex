import { describe, expect, test } from "bun:test";
import { classifyCodexUpstreamOutcome } from "../src/codex/routing";
import {
  createResponsesCapacityRetryBlockRewrite,
  isResponsesCapacityErrorBody,
  probeResponsesPreOutputCapacity,
  rewriteResponsesCapacityErrorBody,
} from "../src/server/responses-capacity-retry";
import { sseDataPayload } from "../src/server/sse-payload-rewrite";

function eventBlock(event: Record<string, unknown>): string {
  return `event: ${String(event.type ?? "message")}\ndata: ${JSON.stringify(event)}`;
}

function failedEvent(
  code: string,
  message = "Our servers are currently overloaded. Please try again later.",
): Record<string, unknown> {
  const error = {
    code,
    message,
    type: "server_error",
  };
  return {
    type: "response.failed",
    response: { error, last_error: error, status: "failed" },
  };
}

describe("Responses capacity retry adaptation", () => {
  test("recognizes the stable capacity message with a provider-specific code", () => {
    expect(isResponsesCapacityErrorBody(JSON.stringify({ error: {
      code: "model_at_capacity", message: "Selected model is at capacity.", type: "server_error",
    } }))).toBe(true);
  });

  test("detects delayed capacity beyond the old 250ms probe", async () => {
    const response = new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(`${eventBlock({ type: "response.created" })}\n\n`));
        await Bun.sleep(350);
        controller.enqueue(new TextEncoder().encode(`${eventBlock(failedEvent("server_is_overloaded"))}\n\n`));
        controller.close();
      },
    }));
    expect((await probeResponsesPreOutputCapacity(response)).capacityError?.code).toBe("server_is_overloaded");
  });
  test("rewrites a pre-output capacity terminal for Codex native retry", () => {
    const rewrite = createResponsesCapacityRetryBlockRewrite();
    rewrite(eventBlock({ type: "response.created", response: { status: "in_progress" } }));

    const [block] = rewrite(eventBlock(failedEvent("server_is_overloaded")));
    const payload = JSON.parse(sseDataPayload(block!)!) as {
      response: { error: { code: string; message: string }; last_error: { code: string } };
    };
    expect(payload.response.error.code).toBe("upstream_server_error");
    expect(payload.response.error.message).toContain("try again in 2s");
    expect(payload.response.last_error.code).toBe("upstream_server_error");
  });

  test("does not replay a capacity failure after meaningful output", () => {
    const rewrite = createResponsesCapacityRetryBlockRewrite();
    rewrite(eventBlock({ type: "response.output_text.delta", delta: "partial" }));
    const original = eventBlock(failedEvent("server_is_overloaded"));
    expect(rewrite(original)).toEqual([original]);
  });

  test("does not rewrite unrelated failures", () => {
    const rewrite = createResponsesCapacityRetryBlockRewrite();
    // The overload wording is itself a capacity signal now, so an unrelated failure has to carry
    // an unrelated message for this to test what it says it tests.
    const original = eventBlock(failedEvent("invalid_prompt", "Invalid prompt: unsafe content."));
    expect(rewrite(original)).toEqual([original]);
  });

  test("rewrites pre-stream capacity JSON without losing the original classifier", () => {
    const body = JSON.stringify({ error: {
      code: "slow_down",
      message: "Model busy",
      type: "server_error",
    } });
    expect(isResponsesCapacityErrorBody(body)).toBe(true);
    const rewritten = JSON.parse(rewriteResponsesCapacityErrorBody(body)) as {
      error: { code: string; message: string };
    };
    expect(rewritten.error.code).toBe("upstream_server_error");
    expect(rewritten.error.message).toContain("try again in 2s");
  });

  test("recognizes the overload 503 however the backend wraps it", () => {
    // The gateway's own 24h of ChatGPT-pool logs: every 503 on gpt-5.6-sol carried the overload
    // sentence, and none of them failed the turn over to another account (all had one attempt).
    // The body classifier only read the OpenAI error object, so the shapes below were invisible.
    const overload = "Our servers are currently overloaded. Please try again later.";
    expect(isResponsesCapacityErrorBody(overload)).toBe(true);
    expect(isResponsesCapacityErrorBody(JSON.stringify({ detail: overload }))).toBe(true);
    expect(isResponsesCapacityErrorBody(JSON.stringify({
      error: { code: "model_at_capacity", message: overload, type: "server_error" },
    }))).toBe(true);
    // A non-capacity pre-stream rejection must stay terminal: `{"detail": ...}` is also how this
    // backend reports "Stream must be set to true", and retrying that on another account is futile.
    expect(isResponsesCapacityErrorBody(JSON.stringify({ detail: "Stream must be set to true" }))).toBe(false);
    expect(isResponsesCapacityErrorBody(JSON.stringify({
      error: { code: "invalid_request_error", message: "Unknown parameter: store", type: "invalid_request_error" },
    }))).toBe(false);
    expect(isResponsesCapacityErrorBody("")).toBe(false);
  });

  test("model capacity is neutral account-health evidence", () => {
    expect(classifyCodexUpstreamOutcome("model_capacity")).toBe("neutral");
  });

  test("bounded probe detects capacity before meaningful output", async () => {
    const response = new Response([
      eventBlock({ type: "response.created", response: { status: "in_progress" } }),
      eventBlock(failedEvent("server_is_overloaded")),
      "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });

    const probed = await probeResponsesPreOutputCapacity(response);
    expect(probed.capacityError).toMatchObject({ code: "server_is_overloaded" });
    expect(await probed.response.text()).toContain("response.failed");
  });

  test("bounded probe preserves the exact stream once meaningful output starts", async () => {
    const original = [
      eventBlock({ type: "response.created", response: { status: "in_progress" } }),
      eventBlock({ type: "response.output_text.delta", delta: "hello" }),
      eventBlock(failedEvent("server_is_overloaded")),
      "",
    ].join("\n\n");
    const probed = await probeResponsesPreOutputCapacity(new Response(original));
    expect(probed.capacityError).toBeUndefined();
    expect(await probed.response.text()).toBe(original);
  });

  test("bounded probe deadline preserves a delayed stream", async () => {
    const encoder = new TextEncoder();
    const original = `${eventBlock({ type: "response.output_text.delta", delta: "late" })}\n\n`;
    const response = new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        await Bun.sleep(20);
        controller.enqueue(encoder.encode(original));
        controller.close();
      },
    }));
    const probed = await probeResponsesPreOutputCapacity(response, { timeoutMs: 1 });
    expect(probed.capacityError).toBeUndefined();
    expect(await probed.response.text()).toBe(original);
  });
});
