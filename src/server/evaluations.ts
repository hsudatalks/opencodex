import { formatErrorResponse } from "../bridge";
import { evaluationConfigSchema } from "../evaluation/config";
import { evaluationRequestSchema, validateEvaluationResponse } from "../evaluation/contract";
import { signalWithTimeout } from "../lib/abort";
import type { OcxConfig } from "../types";
import { isProxyAdmissionSecret } from "./auth-cors";
import type { RequestLogContext } from "./request-log";

const REQUEST_LIMIT = 512 * 1024;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const activeByConfig = new WeakMap<OcxConfig, number>();

function routes(config: OcxConfig) {
  const parsed = evaluationConfigSchema.safeParse(config.evaluations);
  if (!parsed.success) return [];
  const disabled = new Set(config.disabledModels ?? []);
  return Object.entries(parsed.data.providers).flatMap(([name, provider]) => provider.disabled ? [] :
    provider.models.filter(model => !disabled.has(model) && !disabled.has(`${name}/${model}`))
      .map(model => ({ id: `${name}/${model}`, name, model, provider })));
}

/** Separate discovery prevents evaluation-only models from entering chat/Codex pickers. */
export function evaluationModelList(config: OcxConfig) {
  return { object: "list", data: routes(config).map(route => ({
    id: route.id, object: "model", created: 0, owned_by: route.name,
    capabilities: ["evaluation"], supported_endpoints: ["/v1/evaluate", "/v1/systemone"],
    evaluation_protocol: route.provider.protocol,
  })) };
}

class BodyLimitError extends Error {}
async function boundedJson(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<unknown> {
  if (!body) throw new SyntaxError("Missing body");
  const reader = body.getReader();
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new BodyLimitError();
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}

/** A single bounded TypeSafe call. Neither admission credentials nor caller-selected URLs reach upstream. */
export async function handleEvaluation(req: Request, config: OcxConfig, log: RequestLogContext): Promise<Response> {
  const settings = evaluationConfigSchema.safeParse(config.evaluations);
  if (!settings.success) return formatErrorResponse(503, "evaluation_unavailable", "Typed evaluation is not configured");
  const active = activeByConfig.get(config) ?? 0;
  if (active >= (settings.data.maxConcurrent ?? 16)) return formatErrorResponse(503, "server_busy", "Evaluation capacity reached");
  activeByConfig.set(config, active + 1);
  const deadline = signalWithTimeout(settings.data.timeoutMs ?? 20_000, req.signal);
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers.get("content-type") ?? "")) return formatErrorResponse(415, "invalid_request_error", "Use application/json");
    if (!["", "identity"].includes(req.headers.get("content-encoding") ?? "")) return formatErrorResponse(415, "invalid_request_error", "Evaluation requires an uncompressed JSON body");
    if (Number(req.headers.get("content-length")) > REQUEST_LIMIT) return formatErrorResponse(413, "request_too_large", "Evaluation request exceeds 512 KiB");
    let raw: unknown;
    try { raw = await boundedJson(req.body, REQUEST_LIMIT, deadline.signal); }
    catch (error) {
      if (deadline.signal.aborted) throw error;
      return formatErrorResponse(error instanceof BodyLimitError ? 413 : 400, "invalid_request_error", "Invalid or oversized evaluation JSON");
    }
    const parsed = evaluationRequestSchema.safeParse(raw);
    if (!parsed.success) return formatErrorResponse(400, "invalid_request_error", "Expected model, state and 1–100 typed Choice/Score/Noul questions");
    const candidates = routes(config).filter(route => route.id === parsed.data.model || route.model === parsed.data.model);
    if (candidates.length !== 1) return formatErrorResponse(candidates.length ? 400 : 404, "evaluation_model_unavailable", "Choose one enabled evaluation model from /v1/models?capability=evaluate");
    const route = candidates[0];
    log.model = route.model; log.provider = route.name; log.providerAdapter = route.provider.protocol;
    log.requestedModel = parsed.data.model;
    const key = process.env[route.provider.apiKeyEnv];
    if (!key || key.length < 8 || /\s/.test(key) || isProxyAdmissionSecret(key, config))
      return formatErrorResponse(503, "evaluation_credential_unavailable", "Evaluation provider credential is unavailable");
    const request = { ...parsed.data, model: route.model };
    const upstream = await fetch(route.provider.endpoint, {
      method: "POST", redirect: "error", signal: deadline.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(request),
    });
    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => {});
      const status = upstream.status === 429 ? 429 : upstream.status === 400 || upstream.status === 422 ? 400 : 502;
      return formatErrorResponse(status, upstream.status === 429 ? "rate_limit_error" : "evaluation_upstream_error", "Evaluation provider rejected the request; no automatic retry was performed");
    }
    let result;
    try { result = validateEvaluationResponse(await boundedJson(upstream.body, RESPONSE_LIMIT, deadline.signal), request, route.provider.models); }
    catch (error) {
      if (deadline.signal.aborted) throw error;
      return formatErrorResponse(502, "invalid_evaluation_response", "Evaluation provider returned an invalid typed response");
    }
    log.usage = { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens,
      totalTokens: result.usage.input_tokens + result.usage.output_tokens };
    log.usageFromBridge = true;
    return Response.json(result);
  } catch {
    if (req.signal.aborted) return formatErrorResponse(499, "client_closed_request", "Evaluation canceled by client");
    if (deadline.signal.aborted) return formatErrorResponse(504, "evaluation_timeout", "Evaluation deadline exceeded");
    return formatErrorResponse(502, "evaluation_upstream_error", "Evaluation provider connection failed");
  } finally {
    deadline.cleanup();
    activeByConfig.set(config, Math.max(0, (activeByConfig.get(config) ?? 1) - 1));
  }
}
