import {
  replaceSseDataPayload,
  sseDataPayload,
  type SseBlockRewrite,
} from "./sse-payload-rewrite";
import { BoundedSseFrameBuffer } from "./sse-frame-buffer";

const CAPACITY_ERROR_CODES = new Set(["server_is_overloaded", "slow_down"]);
const RETRYABLE_CAPACITY_CODE = "upstream_server_error";
const DEFAULT_CAPACITY_RETRY_SECONDS = 2;
const DEFAULT_CAPACITY_PROBE_MS = 250;
const MAX_CAPACITY_PROBE_BYTES = 64 * 1024;

type ResponsesError = {
  code?: unknown;
  message?: unknown;
  type?: unknown;
};

type ResponsesEvent = {
  type?: unknown;
  response?: {
    error?: ResponsesError | null;
    last_error?: ResponsesError | null;
  } | null;
};

function isCapacityError(error: ResponsesError | null | undefined): boolean {
  return typeof error?.code === "string" && CAPACITY_ERROR_CODES.has(error.code);
}

function retryableCapacityMessage(message: unknown): string {
  const base = typeof message === "string" && message.trim()
    ? message.trim()
    : "The selected model is temporarily at capacity.";
  if (/try again in\s+\d/i.test(base)) return base;
  return `${base} Please try again in ${DEFAULT_CAPACITY_RETRY_SECONDS}s.`;
}

function rewriteCapacityError(error: ResponsesError): ResponsesError {
  return {
    ...error,
    code: RETRYABLE_CAPACITY_CODE,
    message: retryableCapacityMessage(error.message),
    type: "server_error",
  };
}

/**
 * Only lifecycle events may precede a safely replayable capacity failure.
 * Once any content/tool event appears, replaying the turn could duplicate a
 * tool side effect, so the upstream terminal must remain untouched.
 */
function isPreOutputLifecycleEvent(type: string): boolean {
  return type === "response.created"
    || type === "response.in_progress"
    || type === "response.queued";
}

export type ResponsesPreOutputCapacityProbe = {
  response: Response;
  capacityError?: { code: string; message?: string };
};

function responseWithBody(response: Response, body: BodyInit | null): Response {
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function joinChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function replayBufferedBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefix: Uint8Array,
  pendingRead?: Promise<{ done: boolean; value?: Uint8Array }>,
): ReadableStream<Uint8Array> {
  let prefixPending = prefix.byteLength > 0;
  let pending = pendingRead;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (prefixPending) {
        prefixPending = false;
        controller.enqueue(prefix);
        return;
      }
      try {
        const next = await (pending ?? reader.read());
        pending = undefined;
        if (next.done || !next.value) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
    },
  });
}

function bodyFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function capacityErrorFromBlock(block: Uint8Array, decoder: TextDecoder): {
  kind: "lifecycle" | "capacity" | "meaningful";
  error?: { code: string; message?: string };
} {
  const payload = sseDataPayload(decoder.decode(block));
  if (payload === null) return { kind: "lifecycle" };
  if (payload === "[DONE]") return { kind: "meaningful" };
  try {
    const event = JSON.parse(payload) as ResponsesEvent;
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "response.failed" && isCapacityError(event.response?.error)) {
      const error = event.response!.error!;
      return {
        kind: "capacity",
        error: {
          code: error.code as string,
          ...(typeof error.message === "string" ? { message: error.message } : {}),
        },
      };
    }
    return type && isPreOutputLifecycleEvent(type)
      ? { kind: "lifecycle" }
      : { kind: "meaningful" };
  } catch {
    return { kind: "meaningful" };
  }
}

/**
 * Hold only the tiny lifecycle prefix of a native Responses SSE stream. If the
 * backend terminates with model capacity before any content/tool event, the
 * caller can safely resend the original request on another account. A short
 * deadline and byte cap keep normal first-token latency and memory bounded.
 */
export async function probeResponsesPreOutputCapacity(
  response: Response,
  options: { timeoutMs?: number } = {},
): Promise<ResponsesPreOutputCapacityProbe> {
  if (!response.body) return { response };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const framer = new BoundedSseFrameBuffer(MAX_CAPACITY_PROBE_BYTES);
  const decoder = new TextDecoder();
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_CAPACITY_PROBE_MS);
  const deadline = Date.now() + timeoutMs;

  const passthrough = (
    pendingRead?: Promise<{ done: boolean; value?: Uint8Array }>,
  ): ResponsesPreOutputCapacityProbe => {
    framer.dispose();
    const prefix = joinChunks(chunks, totalBytes);
    return { response: responseWithBody(response, replayBufferedBody(reader, prefix, pendingRead)) };
  };

  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return passthrough();
    const pendingRead = reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = await Promise.race([
      pendingRead.then(result => ({ kind: "read" as const, result })),
      new Promise<{ kind: "timeout" }>(resolve => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (read.kind === "timeout") return passthrough(pendingRead);
    if (read.result.done) return passthrough();

    const chunk = read.result.value;
    chunks.push(chunk);
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_CAPACITY_PROBE_BYTES) return passthrough();

    try {
      for (const frame of framer.feed(chunk)) {
        const classification = capacityErrorFromBlock(frame.block, decoder);
        if (classification.kind === "meaningful") return passthrough();
        if (classification.kind === "capacity") {
          framer.dispose();
          await reader.cancel("pre-output model capacity retry").catch(() => undefined);
          return {
            response: responseWithBody(response, bodyFromBytes(joinChunks(chunks, totalBytes))),
            capacityError: classification.error,
          };
        }
      }
    } catch {
      return passthrough();
    }
  }
}

/**
 * Make a pre-output model-capacity terminal participate in Codex's native
 * bounded retry loop. The inspection branch still receives the original
 * server_is_overloaded payload for logs and routing health.
 */
export function createResponsesCapacityRetryBlockRewrite(options?: {
  onPreOutputCapacity?: (error: { code: string; message?: string }) => void;
}): SseBlockRewrite {
  let sawMeaningfulOutput = false;

  return (block) => {
    const payload = sseDataPayload(block);
    if (payload === null || payload === "[DONE]") return [block];

    let event: ResponsesEvent;
    try {
      event = JSON.parse(payload) as ResponsesEvent;
    } catch {
      return [block];
    }

    const type = typeof event.type === "string" ? event.type : "";
    if (type !== "response.failed") {
      if (type && !isPreOutputLifecycleEvent(type)) sawMeaningfulOutput = true;
      return [block];
    }

    const response = event.response;
    if (sawMeaningfulOutput || !response || !isCapacityError(response.error)) return [block];

    options?.onPreOutputCapacity?.({
      code: response.error!.code as string,
      ...(typeof response.error!.message === "string"
        ? { message: response.error!.message }
        : {}),
    });
    const rewrittenError = rewriteCapacityError(response.error!);
    const rewritten: ResponsesEvent = {
      ...event,
      response: {
        ...response,
        error: rewrittenError,
        ...(isCapacityError(response.last_error)
          ? { last_error: rewriteCapacityError(response.last_error!) }
          : {}),
      },
    };
    return [replaceSseDataPayload(block, JSON.stringify(rewritten))];
  };
}

export function isResponsesCapacityErrorBody(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText) as { error?: ResponsesError | null };
    return isCapacityError(parsed.error);
  } catch {
    return false;
  }
}

/** Rewrite only the client-facing error code; callers retain the original body for logs. */
export function rewriteResponsesCapacityErrorBody(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { error?: ResponsesError | null };
    if (!isCapacityError(parsed.error)) return bodyText;
    return JSON.stringify({
      ...parsed,
      error: rewriteCapacityError(parsed.error!),
    });
  } catch {
    return bodyText;
  }
}
