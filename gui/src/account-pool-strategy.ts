export type AccountPoolStrategy = "quota" | "round-robin" | "fill-first";

export const ACCOUNT_POOL_STRATEGIES: readonly AccountPoolStrategy[] = [
  "quota",
  "round-robin",
  "fill-first",
] as const;

export const DEFAULT_ACCOUNT_POOL_STRATEGY: AccountPoolStrategy = "quota";
export const DEFAULT_ACCOUNT_POOL_STICKY_LIMIT = 1;
export const MIN_ACCOUNT_POOL_STICKY_LIMIT = 1;
export const MAX_ACCOUNT_POOL_STICKY_LIMIT = 100;

const STRATEGY_SET = new Set<string>(ACCOUNT_POOL_STRATEGIES);

export function normalizeAccountPoolStrategy(value: unknown): AccountPoolStrategy {
  return typeof value === "string" && STRATEGY_SET.has(value)
    ? value as AccountPoolStrategy
    : DEFAULT_ACCOUNT_POOL_STRATEGY;
}

export function normalizeAccountPoolStickyLimit(value: unknown): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_ACCOUNT_POOL_STICKY_LIMIT
    && value <= MAX_ACCOUNT_POOL_STICKY_LIMIT
    ? value
    : DEFAULT_ACCOUNT_POOL_STICKY_LIMIT;
}

/** Strict draft parse for sticky-limit inputs (1–100 integer). */
export function parseAccountPoolStickyLimitDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= MIN_ACCOUNT_POOL_STICKY_LIMIT && n <= MAX_ACCOUNT_POOL_STICKY_LIMIT ? n : null;
}

export type PoolStrategyFetch = (input: string, init: RequestInit) => Promise<Response>;

export async function putCodexPoolStrategy(
  apiBase: string,
  body: {
    strategy?: AccountPoolStrategy;
    stickyLimit?: number;
    officialResetAt?: number | null;
  },
  fetchImpl: PoolStrategyFetch = (input, init) => fetch(input, init),
): Promise<{
  ok: true;
  strategy: AccountPoolStrategy;
  stickyLimit: number;
  officialResetAt: number | null;
} | { ok: false; status?: number; message?: string }> {
  if (body.strategy === undefined && body.stickyLimit === undefined && body.officialResetAt === undefined) {
    return { ok: false };
  }
  try {
    const response = await fetchImpl(`${apiBase}/api/codex-auth/pool-strategy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(body.strategy !== undefined ? { strategy: body.strategy } : {}),
        ...(body.stickyLimit !== undefined ? { stickyLimit: body.stickyLimit } : {}),
        ...(body.officialResetAt !== undefined ? { officialResetAt: body.officialResetAt } : {}),
      }),
    });
    if (!response.ok) {
      let message: string | undefined;
      try {
        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const json = await response.json() as { error?: unknown; message?: unknown };
          const candidate = typeof json.error === "string" ? json.error : json.message;
          if (typeof candidate === "string" && candidate.trim()) message = candidate.trim();
        } else {
          const text = (await response.text()).trim();
          if (text && text.length <= 240) message = text;
        }
      } catch {
        // The HTTP status remains enough to distinguish auth, validation, and server failures.
      }
      return { ok: false, status: response.status, message };
    }
    const json = await response.json() as {
      accountPoolStrategy?: unknown;
      accountPoolStickyLimit?: unknown;
      accountPoolOfficialResetAt?: unknown;
    };
    return {
      ok: true,
      strategy: normalizeAccountPoolStrategy(json.accountPoolStrategy ?? body.strategy),
      stickyLimit: normalizeAccountPoolStickyLimit(json.accountPoolStickyLimit ?? body.stickyLimit),
      officialResetAt: typeof json.accountPoolOfficialResetAt === "number"
        ? json.accountPoolOfficialResetAt
        : null,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
