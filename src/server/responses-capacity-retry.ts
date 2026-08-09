import {
  replaceSseDataPayload,
  sseDataPayload,
  type SseBlockRewrite,
} from "./sse-payload-rewrite";

const CAPACITY_ERROR_CODES = new Set(["server_is_overloaded", "slow_down"]);
const RETRYABLE_CAPACITY_CODE = "upstream_server_error";
const DEFAULT_CAPACITY_RETRY_SECONDS = 2;

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
