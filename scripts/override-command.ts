/**
 * Parse a `*_CMD` command-override environment variable.
 *
 * These hooks exist so the doctor/lint/build gates can be driven against fixtures. A JSON
 * array is the exact form: it is the only one that survives an executable path containing a
 * space, which a Windows install under `Program Files` has. A plain string keeps the original
 * space-split behavior, so every override already written keeps working.
 *
 * @param raw - the environment value.
 * @param label - variable name, used to make a malformed value actionable.
 * @returns the argv to spawn.
 */
export function parseOverrideCommand(raw: string, label: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[")) return trimmed.split(" ");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label} must be a JSON array of strings or a space-separated command: ${String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(entry => typeof entry !== "string")) {
    throw new Error(`${label} must be a non-empty JSON array of strings`);
  }
  return parsed as string[];
}
