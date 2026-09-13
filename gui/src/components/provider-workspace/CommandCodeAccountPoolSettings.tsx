import { useCallback, useEffect, useState } from "react";
import { useT } from "../../i18n/shared";
import {
  DEFAULT_ACCOUNT_POOL_STRATEGY,
  normalizeAccountPoolStrategy,
  type AccountPoolStrategy,
} from "../../account-pool-strategy";
import { Select } from "../../ui";

export default function CommandCodeAccountPoolSettings({ apiBase, accountCount }: { apiBase: string; accountCount: number }) {
  const t = useT();
  const [enabled, setEnabled] = useState(true);
  const [strategy, setStrategy] = useState<AccountPoolStrategy>(DEFAULT_ACCOUNT_POOL_STRATEGY);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    void fetch(`${apiBase}/api/oauth/accounts/pool?provider=command-code`, { signal: ac.signal })
      .then(response => response.ok ? response.json() : Promise.reject(new Error("load")))
      .then((json: { enabled?: boolean; strategy?: unknown }) => {
        setEnabled(json.enabled !== false);
        setStrategy(normalizeAccountPoolStrategy(json.strategy));
        setLoaded(true);
      })
      .catch(() => { if (!ac.signal.aborted) { setError(true); setLoaded(true); } });
    return () => ac.abort();
  }, [apiBase]);

  const save = useCallback(async (nextEnabled: boolean, nextStrategy: AccountPoolStrategy) => {
    setSaving(true);
    setError(false);
    try {
      const response = await fetch(`${apiBase}/api/oauth/accounts/pool`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "command-code", enabled: nextEnabled, strategy: nextStrategy }),
      });
      if (!response.ok) throw new Error("save");
      const json = await response.json() as { enabled?: boolean; strategy?: unknown };
      setEnabled(json.enabled !== false);
      setStrategy(normalizeAccountPoolStrategy(json.strategy ?? nextStrategy));
    } catch { setError(true); }
    finally { setSaving(false); }
  }, [apiBase]);

  const toggleDisabled = !loaded || saving || (!enabled && accountCount < 2);
  return (
    <div className="card" style={{ marginTop: 12 }} aria-busy={!loaded || saving}>
      <div className="card-row" style={{ alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <strong>{t("provider.name.commandCodeAuth")} — {t("accountPool.strategy")}</strong>
          <div className="card-sub" style={{ marginTop: 4 }}>
            {error ? t("accountPool.strategyUpdateFailed")
              : enabled ? t("accountPool.strategyDesc")
                : t("pws.notLoggedInTitle")}
          </div>
        </div>
        <button type="button" className={`toggle ${enabled ? "on" : ""}`} disabled={toggleDisabled}
          aria-pressed={enabled} aria-label="Command Code account pool"
          onClick={() => void save(!enabled, strategy)}><span className="toggle-knob" /></button>
      </div>
      {accountCount < 2 && <div className="card-sub" style={{ marginTop: 8 }}>{t("pws.addAccount")}</div>}
      {enabled && loaded && (
        <div className="setting-row" style={{ marginTop: 12 }}>
          <label className="setting-label" htmlFor="command-code-pool-strategy">
            <span className="title">{t("accountPool.strategy")}</span>
            <span className="desc">{t("accountPool.strategyDesc")}</span>
          </label>
          <div className="setting-controls">
            <Select
              id="command-code-pool-strategy"
              value={strategy}
              options={[
                { value: "quota", label: t("accountPool.strategyQuota") },
                { value: "round-robin", label: t("accountPool.strategyRoundRobin") },
                { value: "fill-first", label: t("accountPool.strategyFillFirst") },
              ]}
              disabled={saving}
              label={t("accountPool.strategy")}
              onChange={next => { const value = next as AccountPoolStrategy; if (value !== strategy) void save(true, value); }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
