# Upstream integration review: 2026-08-10

This ledger records the review of OpenCodex commits after the common base
`57ea8df4`. Univers Gateway does not merge upstream wholesale. Each production
change must preserve the central account pool, request continuity, concurrency
scheduler, and Postgres usage pipeline.

## Adopted

| Upstream commit | Univers commit | Decision |
| --- | --- | --- |
| `b90b41ff` | `0c73baca` | Parse Codex feature flags as TOML instead of scanning lines. This removes false positives without changing routing. |
| `bd46022c` through `528dcb74` | `85a19ce2` through `5c094151` | Make account deletion persist-first, side-effect-free on write failure, and byte-exact on rollback. The conflict was resolved around Univers account namespaces rather than accepting upstream state blindly. |
| `14e94852` | `d62a0766` | Remove custom models owned by a deleted provider. |
| `794d8eb0` | `9ed43a8c` | Recover incomplete combo members from configured catalog metadata. |
| `b5d44a53` | `98724540` | Keep Google CCA session identity stable for a client thread. |
| `c75e68ec` | `e0c67306` | Preserve routed and account-qualified models in the Codex Desktop picker, including explicit native aliases. This directly supports Univers Gateway's model-routing contract. |
| `3c40df20` | `53cf8199` | Require the Windows CI shard command to be executable and unconditional, preventing a false-green workflow. |

## Deferred

| Upstream commit | Reason |
| --- | --- |
| `dea62e49` | The account-picker lifecycle patch spans 64 files and overlaps Univers Gateway's central pool, urgency scoring, six-session cap, queueing, and continuation ownership. It must be mined feature-by-feature, not cherry-picked. |
| `e8ec8d19` | Live Antigravity discovery changes outbound networking, DNS/security policy, caching, and model authority across 35 files. The current static registry remains deterministic; live discovery needs a separate threat and failure-mode review. |
| `31066bb3` plus follow-ups | OMP is an optional client integration and is not part of the current Codex/Pi production path. It can be added when a real client requires it. |

## Not imported

- FAB-00 and Compatibility Lab commits are research and planning material, not
  production gateway behavior.
- Release-only and devlog commits carry upstream metadata rather than runtime
  fixes.
- The upstream package version is not copied automatically. Univers Gateway
  uses its own prerelease and release sequence.

## Next review rule

For each future upstream release:

1. Fetch and compare from the last recorded upstream commit.
2. Classify each non-merge commit as adopted, deferred, or not imported.
3. Port the smallest coherent change and retain its upstream hash in the commit
   message.
4. Run focused tests for the touched subsystem before the complete release gate.
5. Update this ledger or add a dated successor before publishing.
