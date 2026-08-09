import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import {
  DEFAULT_ACCOUNT_POOL_STRATEGY,
  DEFAULT_ACCOUNT_POOL_STICKY_LIMIT,
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  parseAccountPoolStickyLimitDraft,
  putCodexPoolStrategy,
  type AccountPoolStrategy,
} from "../account-pool-strategy";
import AccountPoolStrategyControls from "./AccountPoolStrategyControls";
import type { CodexAccountLoadObserver } from "../hooks/useCodexAccountPool";
import {
  fromSingaporeDateTimeInput,
  toSingaporeDateTimeInput,
} from "../singapore-time";

function strategyFieldsFromActive(value: unknown): {
  strategy: AccountPoolStrategy;
  stickyLimit: number;
  officialResetAt: number | null;
} | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (!("accountPoolStrategy" in row) && !("accountPoolStickyLimit" in row)) return null;
  return {
    strategy: normalizeAccountPoolStrategy(row.accountPoolStrategy),
    stickyLimit: normalizeAccountPoolStickyLimit(row.accountPoolStickyLimit),
    officialResetAt: typeof row.accountPoolOfficialResetAt === "number"
      ? row.accountPoolOfficialResetAt
      : null,
  };
}

/**
 * Codex account-pool rotation strategy controls.
 * Prefers the shared /active read from the account-pool controller (no blocked wait).
 * Falls back to its own GET only when no shared observer is wired.
 */
export default function CodexPoolStrategySetting({
  apiBase,
  subscribeLoadObserver,
  readLastActive,
  onStrategyResolved,
}: {
  apiBase: string;
  subscribeLoadObserver?: (observer: CodexAccountLoadObserver) => () => void;
  readLastActive?: () => unknown;
  onStrategyResolved?: (strategy: AccountPoolStrategy) => void;
}) {
  const t = useT();
  // Seed defaults immediately — never gate the control chrome on a network round-trip.
  const [strategy, setStrategy] = useState<AccountPoolStrategy>(DEFAULT_ACCOUNT_POOL_STRATEGY);
  const [stickyLimit, setStickyLimit] = useState(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT);
  const [stickyDraft, setStickyDraft] = useState(String(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT));
  const [officialResetAt, setOfficialResetAt] = useState<number | null>(null);
  const [officialResetDraft, setOfficialResetDraft] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const hydratedRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  /** Set when an /active read arrives mid-save; triggers one post-save refresh. */
  const deferredActiveRefreshRef = useRef(false);
  const revisionRef = useRef(0);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyServer = useCallback((json: {
    accountPoolStrategy?: unknown;
    accountPoolStickyLimit?: unknown;
    accountPoolOfficialResetAt?: unknown;
  }) => {
    const nextStrategy = normalizeAccountPoolStrategy(json.accountPoolStrategy);
    const nextSticky = normalizeAccountPoolStickyLimit(json.accountPoolStickyLimit);
    setStrategy(nextStrategy);
    onStrategyResolved?.(nextStrategy);
    setStickyLimit(nextSticky);
    setStickyDraft(String(nextSticky));
    const nextOfficialResetAt = typeof json.accountPoolOfficialResetAt === "number"
      ? json.accountPoolOfficialResetAt
      : null;
    setOfficialResetAt(nextOfficialResetAt);
    setOfficialResetDraft(toSingaporeDateTimeInput(nextOfficialResetAt));
    hydratedRef.current = true;
    setHydrated(true);
    setLoadError(false);
    setError(null);
  }, [onStrategyResolved]);

  const applyActivePayload = useCallback((value: unknown) => {
    const fields = strategyFieldsFromActive(value);
    if (!fields) return;
    applyServer({
      accountPoolStrategy: fields.strategy,
      accountPoolStickyLimit: fields.stickyLimit,
      accountPoolOfficialResetAt: fields.officialResetAt,
    });
  }, [applyServer]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/api/codex-auth/active`);
      if (!res.ok) throw new Error("load");
      const payload = await res.json() as {
        accountPoolStrategy?: unknown;
        accountPoolStickyLimit?: unknown;
        accountPoolOfficialResetAt?: unknown;
      };
      // A save started while this GET was in flight — retry once after it settles.
      if (savingRef.current) {
        deferredActiveRefreshRef.current = true;
        return;
      }
      applyServer(payload);
    } catch {
      if (!savingRef.current) setLoadError(true);
    }
  }, [apiBase, applyServer]);

  const scheduleDeferredActiveRefresh = useCallback(() => {
    if (!deferredActiveRefreshRef.current) return;
    deferredActiveRefreshRef.current = false;
    queueMicrotask(() => {
      if (savingRef.current) {
        deferredActiveRefreshRef.current = true;
        return;
      }
      void load();
    });
  }, [load]);

  // Shared /active observer (preferred): same payload the pool already fetched.
  // Ignore stale polls that started before a PUT bumped revision; mid-save reads
  // arm one post-save /active refresh instead of being dropped forever.
  // Replay readLastActive on subscribe so late mounts hydrate without waiting a poll.
  useEffect(() => {
    if (!subscribeLoadObserver) return;
    const observer: CodexAccountLoadObserver = {
      beginActiveRead: () => revisionRef.current,
      acceptActiveRead: (value, startedRevision) => {
        if (startedRevision !== revisionRef.current) return;
        if (savingRef.current) {
          deferredActiveRefreshRef.current = true;
          return;
        }
        applyActivePayload(value);
      },
      rejectActiveRead: () => {
        if (!hydratedRef.current) setLoadError(true);
      },
    };
    const unsubscribe = subscribeLoadObserver(observer);
    if (!savingRef.current && readLastActive) applyActivePayload(readLastActive());
    return unsubscribe;
  }, [subscribeLoadObserver, applyActivePayload, readLastActive]);

  useEffect(() => {
    if (!readLastActive || subscribeLoadObserver) return;
    if (savingRef.current) return;
    applyActivePayload(readLastActive());
  }, [readLastActive, applyActivePayload, subscribeLoadObserver]);

  // Standalone fallback when no shared controller observer is wired (keeps tests without observer green).
  useEffect(() => {
    if (subscribeLoadObserver) return;
    // Not a synchronous cascade: load() reaches `await fetch(...)` before it touches any
    // setter, so state never updates during this effect's own render pass.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, subscribeLoadObserver]);

  const save = useCallback(async (next: {
    strategy?: AccountPoolStrategy;
    stickyLimit?: number;
    officialResetAt?: number | null;
  }) => {
    if (savingRef.current) return;
    const previousStrategy = strategy;
    const previousSticky = stickyLimit;
    const previousOfficialResetAt = officialResetAt;
    if (next.strategy !== undefined) {
      setStrategy(next.strategy);
      onStrategyResolved?.(next.strategy);
    }
    if (next.stickyLimit !== undefined) {
      setStickyLimit(next.stickyLimit);
      setStickyDraft(String(next.stickyLimit));
    }
    if (next.officialResetAt !== undefined) {
      setOfficialResetAt(next.officialResetAt);
      setOfficialResetDraft(toSingaporeDateTimeInput(next.officialResetAt));
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    revisionRef.current += 1;
    const result = await putCodexPoolStrategy(apiBase, next);
    revisionRef.current += 1;
    if (result.ok) {
      setStrategy(result.strategy);
      onStrategyResolved?.(result.strategy);
      setStickyLimit(result.stickyLimit);
      setStickyDraft(String(result.stickyLimit));
      setOfficialResetAt(result.officialResetAt);
      setOfficialResetDraft(toSingaporeDateTimeInput(result.officialResetAt));
      hydratedRef.current = true;
      setHydrated(true);
    } else {
      const detail = [
        result.status ? String(result.status) : null,
        result.message,
      ].filter((value): value is string => Boolean(value)).join(": ");
      setError(`${t("accountPool.strategyUpdateFailed")}${detail ? ` ${detail}` : ""}`);
      setStrategy(previousStrategy);
      onStrategyResolved?.(previousStrategy);
      setStickyLimit(previousSticky);
      setStickyDraft(String(previousSticky));
      setOfficialResetAt(previousOfficialResetAt);
      setOfficialResetDraft(toSingaporeDateTimeInput(previousOfficialResetAt));
    }
    savingRef.current = false;
    setSaving(false);
    scheduleDeferredActiveRefresh();
  }, [apiBase, officialResetAt, onStrategyResolved, scheduleDeferredActiveRefresh, stickyLimit, strategy, t]);

  // Block writes until /active confirms — defaults paint for CLS but must not overwrite server state.
  const controlsDisabled = saving || loadError || !hydrated;

  return (
    <div className="card account-pool-strategy-card" aria-busy={saving || (!hydrated && !loadError)}>
      {/*
        The title and description now live in the setting row itself, so the card no longer
        repeats them above an unnamed select. Only the load failure still needs its own line:
        there is no row to attach it to when the controls are replaced by a retry button.
      */}
      {loadError && (
        <div className="card-sub" role="alert">{t("accountPool.strategyLoadFailed")}</div>
      )}
      {loadError && (
        <button type="button" className="btn btn-ghost btn-sm account-pool-strategy-card__retry" onClick={() => { void load(); }}>
          {t("common.retry")}
        </button>
      )}
      {!loadError && (
        <AccountPoolStrategyControls
          strategy={strategy}
          stickyDraft={stickyDraft}
          disabled={controlsDisabled}
          strategySelectId="codex-pool-strategy"
          stickyInputId="codex-pool-sticky-limit"
          onStrategyChange={(next) => {
            if (controlsDisabled || next === strategy) return;
            void save({ strategy: next });
          }}
          onStickyDraftChange={setStickyDraft}
          onStickyCommit={(nextDraft) => {
            if (controlsDisabled) return;
            const parsed = parseAccountPoolStickyLimitDraft(nextDraft ?? stickyDraft);
            if (parsed === null) {
              setStickyDraft(String(stickyLimit));
              setError(t("accountPool.stickyLimitInvalid"));
              return;
            }
            if (parsed === stickyLimit) {
              setStickyDraft(String(parsed));
              return;
            }
            void save({ stickyLimit: parsed });
          }}
        />
      )}
      {!loadError && (
        <div className="setting-row account-pool-official-reset">
          <label className="setting-label" htmlFor="codex-pool-official-reset">
            <span className="title">{t("accountPool.officialReset")}</span>
            <span className="desc">{t("accountPool.officialResetHelp")}</span>
            <span className="desc">{t("accountPool.singaporeTime")}</span>
          </label>
          <div className="setting-controls account-pool-official-reset__controls">
            <input
              id="codex-pool-official-reset"
              className="input mono"
              type="datetime-local"
              step={60}
              value={officialResetDraft}
              disabled={controlsDisabled}
              aria-label={t("accountPool.officialReset")}
              onChange={(event) => setOfficialResetDraft(event.target.value)}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={controlsDisabled || (() => {
                const parsed = fromSingaporeDateTimeInput(officialResetDraft);
                return parsed === null || parsed === officialResetAt;
              })()}
              onClick={() => {
                const parsed = fromSingaporeDateTimeInput(officialResetDraft);
                if (parsed === null || parsed <= Date.now()) {
                  setError(t("accountPool.officialResetInvalid"));
                  return;
                }
                void save({ officialResetAt: parsed });
              }}
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
            {officialResetAt !== null && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={controlsDisabled}
                onClick={() => { void save({ officialResetAt: null }); }}
              >
                {t("common.remove")}
              </button>
            )}
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="card-sub account-pool-strategy-card__error">
          {error}
        </div>
      )}
    </div>
  );
}
