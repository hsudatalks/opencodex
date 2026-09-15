/**
 * The headroom cut-off shared by every pooled credential.
 *
 * Command Code OAuth accounts and balanced API-key pools (OpenCode Go, GLM Coding, …) make the same
 * decision from the same numbers — the five-hour, weekly and monthly budgets a credential reports —
 * so they read the cut-off through this module rather than each carrying its own constant. One
 * definition keeps "any budget at the cut-off takes the credential out of rotation" true for both.
 */

/**
 * Default usage % at or above which a pooled credential is skipped.
 *
 * The last percent is not worth spending. An account at 99.84% of its credit balance refused every
 * request while the pool kept alternating to it, and a budget within 1% of its ceiling is about to
 * start refusing anyway — so the request that would have discovered that is better spent on a peer.
 */
export const POOL_HEADROOM_PERCENT_DEFAULT = 99;

/**
 * Resolve a configured cut-off. `0` disables the exclusion, which leaves the pool to discover a
 * drained credential from the upstream refusal instead. Anything that is not an integer in 0..100
 * falls back to the default rather than silently reinterpreting a hand-edited value.
 */
export function resolvePoolHeadroomPercent(value: unknown, fallback = POOL_HEADROOM_PERCENT_DEFAULT): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100) return value;
  return fallback;
}
