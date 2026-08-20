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

function failedEvent(code: string): Record<string, unknown> {
  const error = {
    code,
    message: "Our servers are currently overloaded. Please try again later.",
    type: "server_error",
  };
  return {
    type: "response.failed",
    response: { error, last_error: error, status: "failed" },
  };
}

describe("Responses capacity retry adaptation", () => {
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
    const original = eventBlock(failedEvent("invalid_prompt"));
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
