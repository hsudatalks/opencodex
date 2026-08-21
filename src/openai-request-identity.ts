import { randomUUID } from "node:crypto";

/** Credentials describe the selected upstream account, never the caller. */
export const OPENAI_CREDENTIAL_HEADERS = [
  "authorization",
  "chatgpt-account-id",
] as const;

/** Identity and session context owned by the client that originated the turn. */
export const OPENAI_CALLER_IDENTITY_HEADERS = [
  "originator",
  "user-agent",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-subagent",
] as const;

/** Protocol negotiation owned by the originating client. */
export const OPENAI_CALLER_PROTOCOL_HEADERS = [
  "openai-beta",
  "x-codex-beta-features",
  "x-responsesapi-include-timing-metrics",
] as const;

/**
 * Safe OpenAI headers that survive a routed user request. Representation
 * headers such as Accept and Content-Encoding are deliberately absent: the
 * gateway reserializes the body and chooses the upstream response transport.
 */
export const OPENAI_FORWARD_HEADERS = [
  ...OPENAI_CREDENTIAL_HEADERS,
  ...OPENAI_CALLER_IDENTITY_HEADERS,
  ...OPENAI_CALLER_PROTOCOL_HEADERS,
] as const;

export const UNIVERS_GATEWAY_OPENAI_ORIGINATOR = "univers_gateway";
export const UNIVERS_GATEWAY_USER_AGENT = "univers-gateway";

/** Headers for model requests genuinely initiated by the gateway itself. */
export function universGatewayOpenAiRequestHeaders(): Record<string, string> {
  return {
    Accept: "text/event-stream",
    Originator: UNIVERS_GATEWAY_OPENAI_ORIGINATOR,
    "User-Agent": UNIVERS_GATEWAY_USER_AGENT,
    "X-Client-Request-Id": randomUUID(),
  };
}
