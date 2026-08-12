import { useT } from "../i18n/shared";
import type { LoginHint } from "./provider-workspace/types";
import { LoginUrlBlock } from "./login-url-block";
import { useCopyFeedback } from "./use-copy-feedback";

/** Shared visible handoff for OAuth flows that require browser or device-code action. */
export function OAuthLoginWait({
  hint,
  onCancel,
}: {
  hint: LoginHint;
  onCancel?: () => void;
}) {
  const t = useT();
  const deviceCode = hint.deviceCode ?? "";
  const deviceCodeCopy = useCopyFeedback<string>();
  const deviceCodeOutcome = deviceCodeCopy.outcomeFor(deviceCode);
  const deviceCodeCopyLabel = deviceCodeOutcome === "copied"
    ? t("prov.codeCopied")
    : deviceCodeOutcome === "unavailable"
      ? t("prov.linkCopyUnavailable")
      : t("prov.copyCode");

  return (
    <div className="pwi-auth-wait">
      <span className="pwi-spin-inline" aria-hidden="true" />
      <div className="pwi-auth-wait-copy">
        <div className="pwi-auth-wait-title">{t("prov.waitingBrowser")}</div>
        {hint.instructions && <div>{hint.instructions}</div>}
        {hint.deviceCode && (
          <div className="pwi-device-code-wrap">
            <span>{t("prov.deviceCode")}</span>
            <code className="pwi-device-code">{hint.deviceCode}</code>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => deviceCodeCopy.copy(deviceCode, deviceCode)}
            >
              <span aria-live="polite">{deviceCodeCopyLabel}</span>
            </button>
          </div>
        )}
        <LoginUrlBlock url={hint.url ?? ""} />
        {onCancel && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        )}
      </div>
    </div>
  );
}
