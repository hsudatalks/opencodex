import type { CodexAccountMode, OcxConfig, OcxProviderConfig } from "./types";
import { providerCodexAccountMode } from "./providers/registry";

export type DeploymentMode = "local" | "server";

export function deploymentMode(config: Pick<OcxConfig, "deploymentMode">): DeploymentMode {
  return config.deploymentMode === "server" ? "server" : "local";
}

export function nativeMainAccountEnabled(config: Pick<OcxConfig, "deploymentMode">): boolean {
  return deploymentMode(config) === "local";
}

/** Server gateways own managed credentials only; Direct/native login is a local-runtime concept. */
export function effectiveProviderCodexAccountMode(
  config: Pick<OcxConfig, "deploymentMode" | "providers">,
  providerId: string,
  provider?: OcxProviderConfig,
): CodexAccountMode | undefined {
  const mode = providerCodexAccountMode(providerId, provider ?? config.providers[providerId]);
  if (providerId === "openai" && mode && !nativeMainAccountEnabled(config)) return "pool";
  return mode;
}
