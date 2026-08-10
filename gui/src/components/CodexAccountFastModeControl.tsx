import type { TFn } from "../i18n/shared";

export function CodexAccountFastModeControl({
  t,
  enabled,
  updating,
  disabled,
  onChange,
}: {
  t: TFn;
  enabled: boolean;
  updating: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <div className="setting-row codex-account-fast-mode">
      <div className="setting-label">
        <span className="title">{t("codexAuth.fastMode")}</span>
      </div>
      <button
        type="button"
        className={`toggle ${enabled ? "on" : ""}`}
        disabled={disabled}
        aria-pressed={enabled}
        aria-label={t("codexAuth.fastModeForAccount")}
        title={t("codexAuth.fastModeHint")}
        onClick={() => onChange(!enabled)}
      >
        <span className="toggle-knob" />
        <span className="sr-only">{updating ? t("common.saving") : ""}</span>
      </button>
    </div>
  );
}
