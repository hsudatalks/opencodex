import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useI18n, type TFn, type Locale } from "../i18n/shared";
import { formatProviderDisplayName } from "../provider-icons";
import { formatTokens } from "../format-tokens";
import { formatEstimatedUsdValue as formatUsdEstimate } from "../intl-formatters";
import { readSessionListCache, writeSessionListCache } from "../session-list-cache";
import { EmptyState, Notice } from "../ui";
import { modelLabel } from "../model-display";
import { useDataSurface } from "../data-surface";
import { DataSurfaceSkeleton } from "../components/data-surface";
import { SectionTabs } from "../components/section-tabs";
import { sectionAnchorId } from "../section-anchors";
import { IconChevron, IconRefresh } from "../icons";

type Range = "1d" | "7d" | "30d" | "all";
type UsageSurface = "all" | "codex" | "claude" | "grok";

interface UsageSummaryTotals {
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  unreportedRequests: number;
  unsupportedRequests: number;
  estimatedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  coverageRatio: number;
  estimatedCostUsd?: number;
  pricedRequests?: number;
  unpricedRequests?: number;
  unmeteredRequests?: number;
}

interface UsageDay {
  date: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  totalTokens: number;
  models: UsageDayModel[];
}

interface UsageDayModel {
  model: string;
  provider: string;
  requests: number;
  totalTokens: number;
}

interface UsageModel {
  provider: string;
  model: string;
  resolvedModel?: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  shareRatio: number;
}

interface UsageProvider {
  provider: string;
  requests: number;
  measuredRequests: number;
  reportedRequests: number;
  estimatedRequests: number;
  totalTokens: number;
  shareRatio: number;
}

interface UsageResponse {
  range: Range;
  surface: UsageSurface;
  since: number | null;
  generatedAt: number;
  summary: UsageSummaryTotals;
  days: UsageDay[];
  models: UsageModel[];
  providers: UsageProvider[];
  historyTruncated: boolean;
  truncatedPrefixBytes: number;
  entriesTruncated: boolean;
  entriesDropped: number;
  error?: string;
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

// Stable per-model bar color: hash the provider/model id to a hue so the same model keeps its color
// across days and renders. Saturation/lightness are fixed for a cohesive palette on the dark chart.
function modelColor(model: string, provider: string): string {
  const key = `${provider}/${model}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 55%)`;
}

function singaporeDateOffset(offsetDays: number): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Date.now() + offsetDays * 86_400_000));
  const part = (type: "year" | "month" | "day") => parts.find(value => value.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function formatWeekWindow(days: UsageDay[], locale: Locale): string {
  const first = days.at(0)?.date;
  const last = days.at(-1)?.date;
  if (!first || !last) return "";
  const formatter = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "Asia/Singapore" });
  return `${formatter.format(new Date(`${first}T12:00:00+08:00`))} – ${formatter.format(new Date(`${last}T12:00:00+08:00`))}`;
}

function quantileBuckets(values: number[]): number[] {
  const positive = values.filter(v => v > 0).sort((a, b) => a - b);
  if (positive.length === 0) return [0, 0, 0, 0];
  const q = (p: number) => positive[Math.min(positive.length - 1, Math.floor(p * positive.length))];
  return [q(0.25), q(0.5), q(0.75), q(0.95)];
}

function bucketLevel(value: number, buckets: number[]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (value <= buckets[0]) return 1;
  if (value <= buckets[1]) return 2;
  if (value <= buckets[2]) return 3;
  return 4;
}

interface HeatmapCell {
  date: string;
  requests: number;
  totalTokens: number;
  level: 0 | 1 | 2 | 3 | 4;
  dayOfWeek: number;
}

function buildHeatmap(days: UsageDay[]): { weeks: HeatmapCell[][]; months: { label: string; col: number }[]; buckets: number[] } {
  const buckets = quantileBuckets(days.map(d => d.totalTokens));
  const dayMap = new Map(days.map(d => [d.date, d]));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  // Align to Sunday
  start.setDate(start.getDate() - start.getDay());

  const weeks: HeatmapCell[][] = [];
  const months: { label: string; col: number }[] = [];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let lastMonthCol = -4;
  let prevMonthIdx = -1;
  let week: HeatmapCell[] = [];
  const cursor = new Date(start);

  while (cursor <= today) {
    const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
    const m = cursor.getMonth();
    if (cursor.getDay() === 0 && m !== prevMonthIdx && weeks.length - lastMonthCol >= 4) {
      months.push({ label: monthNames[m], col: weeks.length });
      lastMonthCol = weeks.length;
      prevMonthIdx = m;
    }
    const d = dayMap.get(iso);
    week.push({
      date: iso,
      requests: d?.requests ?? 0,
      totalTokens: d?.totalTokens ?? 0,
      level: d ? bucketLevel(d.totalTokens, buckets) : 0,
      dayOfWeek: cursor.getDay(),
    });
    if (cursor.getDay() === 6) {
      weeks.push(week);
      week = [];
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  if (week.length > 0) {
    while (week.length < 7) {
      week.push({ date: "", requests: 0, totalTokens: 0, level: 0, dayOfWeek: week.length });
    }
    weeks.push(week);
  }
  return { weeks, months, buckets };
}

function UsageFilters({
  surface,
  range,
  refreshing,
  onSurface,
  onRange,
  onRefresh,
  t,
}: {
  surface: UsageSurface;
  range: Range;
  refreshing: boolean;
  onSurface: (surface: UsageSurface) => void;
  onRange: (range: Range) => void;
  onRefresh: () => void;
  t: TFn;
}) {
  return (
    <div className="usage-filters">
      <div className="usage-segmented" role="group" aria-label={t("logs.filter.surface.label")}>
        {(["all", "codex", "claude", "grok"] as UsageSurface[]).map(choice => {
          const label = t(`logs.filter.surface.${choice}`);
          return (
            <button
              key={choice}
              type="button"
              className={`usage-segmented-btn usage-source-btn${surface === choice ? " active" : ""}`}
              aria-label={label}
              aria-pressed={surface === choice}
              onClick={() => onSurface(choice)}
            >
              {choice === "codex" && (
                <img className="usage-source-mark" src="/provider-icons/openai.svg" alt="" aria-hidden="true" />
              )}
              {choice === "claude" && (
                <img className="usage-source-mark" src="/provider-icons/claude-color.svg" alt="" aria-hidden="true" />
              )}
              {choice === "grok" && (
                <img className="usage-source-mark usage-source-mark--mono" src="/provider-icons/grok.svg" alt="" aria-hidden="true" />
              )}
              <span className={choice === "all" ? "usage-source-label" : "usage-source-label usage-source-label-collapsible"}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
      <div className="usage-segmented" role="group" aria-label={t("usage.title")}>
        {(["7d", "1d", "30d", "all"] as Range[]).map(choice => {
          const label = t(`usage.range.${choice}`);
          return (
            <button
              key={choice}
              type="button"
              className={`usage-segmented-btn${range === choice ? " active" : ""}`}
              aria-label={label}
              aria-pressed={range === choice}
              onClick={() => onRange(choice)}
            >
              {label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label={refreshing ? t("usage.refreshing") : t("usage.refresh")}
        title={refreshing ? t("usage.refreshing") : t("usage.refresh")}
        disabled={refreshing}
        onClick={onRefresh}
      >
        <IconRefresh className={refreshing ? "spin-icon" : undefined} aria-hidden="true" />
      </button>
    </div>
  );
}

function UsageSummaryCards({
  summary,
  activeDays,
  locale,
  t,
}: {
  summary: UsageSummaryTotals;
  activeDays: number;
  locale: Locale;
  t: TFn;
}) {
  return (
    <>
    <div className="usage-cards usage-cards-3x2" role="group" aria-label={t("usage.title")}>
      <div className="stat"><div className="muted">{t("usage.card.requests")}</div><div className="stat-value">{summary.requests}</div></div>
      <div className="stat"><div className="muted">{t("usage.card.measured")}</div><div className="stat-value">{summary.measuredRequests}</div></div>
      <div className="stat"><div className="muted">{t("usage.card.totalTokens")}</div><div className="stat-value">{formatTokens(summary.totalTokens, locale)}</div></div>
      <div className="stat" title={t("usage.card.cachedTokensHint")}>
        <div className="muted">{t("usage.card.cachedTokens")}</div>
        <div className="stat-value">{formatTokens(summary.cacheReadInputTokens ?? summary.cachedInputTokens, locale)}</div>
        {(summary.cacheCreationInputTokens ?? 0) > 0 && (
          <div className="muted text-caption">
            {t("usage.card.cacheWriteTokens")}: {formatTokens(summary.cacheCreationInputTokens ?? 0, locale)}
          </div>
        )}
      </div>
      <div className="stat"><div className="muted">{t("usage.card.coverage")}</div><div className="stat-value">{formatPct(summary.coverageRatio)}</div></div>
      <div className="stat"><div className="muted">{t("usage.card.activeDays")}</div><div className="stat-value">{activeDays}</div></div>
    </div>
      {summary.estimatedCostUsd !== undefined && (
        <div className="usage-cost-row" role="note">
          <span className="muted">{t("usage.cost.total")}</span>
          <span className="stat-value mono usage-cost-value">
            {formatUsdEstimate(summary.estimatedCostUsd, locale)}
          </span>
          <span className="muted text-caption">{t("usage.cost.disclaimer")}</span>
          {((summary.unpricedRequests ?? 0) + (summary.unmeteredRequests ?? 0)) > 0 && (
            <span className="muted text-caption">
              {t("usage.cost.unpricedNote").replace("{count}", String((summary.unpricedRequests ?? 0) + (summary.unmeteredRequests ?? 0)))}
            </span>
          )}
        </div>
      )}
    </>
  );
}

function UsageDayBars({
  dayBars,
  locale,
  showWindowNavigation,
  canMoveNewer,
  onMove,
  t,
}: {
  dayBars: UsageDay[];
  locale: Locale;
  showWindowNavigation: boolean;
  canMoveNewer: boolean;
  onMove: (direction: "older" | "newer") => void;
  t: TFn;
}) {
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const dragStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const max = Math.max(1, ...dayBars.map(day => day.totalTokens));

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!showWindowNavigation) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    dragStart.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!showWindowNavigation) return;
    const start = dragStart.current;
    dragStart.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.25) return;
    if (dx > 0) onMove("older");
    else if (canMoveNewer) onMove("newer");
  };

  return (
    <>
      {showWindowNavigation && (
        <div className="usage-week-window-head">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t("usage.window.older")}
            title={t("usage.window.older")}
            onClick={() => onMove("older")}
          >
            <IconChevron aria-hidden="true" style={{ transform: "rotate(180deg)" }} />
          </button>
          <span className="usage-week-window-label" aria-live="polite">{formatWeekWindow(dayBars, locale)}</span>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={t("usage.window.newer")}
            title={t("usage.window.newer")}
            disabled={!canMoveNewer}
            onClick={() => onMove("newer")}
          >
            <IconChevron aria-hidden="true" />
          </button>
        </div>
      )}
      <div
        className={`daybars${showWindowNavigation ? " usage-week-swipe" : ""}`}
        role="img"
        aria-label={`${t("usage.section.heatmap")}: ${formatWeekWindow(dayBars, locale)}`}
        style={{ gridTemplateColumns: `repeat(${Math.max(1, dayBars.length)}, minmax(0, 1fr))` }}
        onPointerDown={onPointerDown}
        onPointerUp={finishPointer}
        onPointerCancel={() => { dragStart.current = null; }}
      >
        {dayBars.map(day => {
          const percentage = Math.round((day.totalTokens / max) * 100);
          const label = day.date.slice(5);
          return (
            <div
              key={day.date}
              className="daybar"
              onMouseEnter={() => setHoverDay(day.date)}
              onMouseLeave={() => setHoverDay(current => (current === day.date ? null : current))}
            >
              <div className="daybar-track">
                <div
                  className="daybar-stack"
                  style={{ ["--daybar-scale" as string]: String(Math.max(0, Math.min(1, percentage / 100))) }}
                >
                  {day.models.map(model => (
                    <div
                      key={`${model.provider}/${model.model}`}
                      className="daybar-seg"
                      style={{ flexGrow: model.totalTokens, background: modelColor(model.model, model.provider) }}
                    />
                  ))}
                  {day.models.length === 0 && day.totalTokens > 0 && (
                    <div className="daybar-seg" style={{ flexGrow: 1, background: "var(--green)" }} />
                  )}
                </div>
              </div>
              {hoverDay === day.date && day.totalTokens > 0 && (
                <div className="daybar-tip" role="tooltip">
                  <div className="daybar-tip-date">{day.date}</div>
                  {day.models.slice(0, 8).map(model => (
                    <div key={`${model.provider}/${model.model}`} className="daybar-tip-row">
                      <span className="daybar-tip-swatch" style={{ background: modelColor(model.model, model.provider) }} />
                      <span className="daybar-tip-name">{modelLabel(model.model)}</span>
                      <span className="daybar-tip-val">{formatTokens(model.totalTokens, locale)}</span>
                    </div>
                  ))}
                </div>
              )}
              <span className="daybar-count">{formatTokens(day.totalTokens, locale)}</span>
              <span className="daybar-label muted">{label}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function UsageHeatmapPanel({
  range,
  heatmap,
  periodBars,
  windowDayOffset,
  onMoveWeek,
  locale,
  t,
}: {
  range: Range;
  heatmap: ReturnType<typeof buildHeatmap>;
  periodBars: UsageDay[];
  windowDayOffset: number;
  onMoveWeek: (direction: "older" | "newer") => void;
  locale: Locale;
  t: TFn;
}) {
  const heatmapRef = useRef<HTMLDivElement | null>(null);
  const [hoverCell, setHoverCell] = useState<{ weekIndex: number; dayIndex: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const element = heatmapRef.current;
    if (!element) return;
    const pinRight = () => { element.scrollLeft = element.scrollWidth; };
    pinRight();
    const observer = new ResizeObserver(pinRight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [heatmap, range]);

  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby="usage-heatmap-title">
      <h3 id="usage-heatmap-title" className="panel-title">{t("usage.section.heatmap")}</h3>
      {range === "7d" || range === "1d" ? (
        <UsageDayBars
          dayBars={periodBars}
          locale={locale}
          showWindowNavigation={range === "7d"}
          canMoveNewer={windowDayOffset < 0}
          onMove={onMoveWeek}
          t={t}
        />
      ) : (
        <div className="heatmap" ref={heatmapRef} role="img" aria-labelledby="usage-heatmap-title">
          <div className="heatmap-months" style={{ gridTemplateColumns: `28px repeat(${heatmap.weeks.length}, calc(var(--hm-cell) + var(--hm-gap)))` }}>
            <span className="heatmap-day-spacer" />
            {heatmap.months.map(month => (
              <span key={`${month.label}-${month.col}`} className="heatmap-month" style={{ gridColumn: month.col + 2 }}>{month.label}</span>
            ))}
          </div>
          <div className="heatmap-body">
            <div className="heatmap-days">
              <span /><span>{t("usage.dayMon")}</span><span /><span>{t("usage.dayWed")}</span><span /><span>{t("usage.dayFri")}</span><span />
            </div>
            <div className="heatmap-grid" style={{ gridTemplateColumns: `repeat(${heatmap.weeks.length}, var(--hm-cell))` }}>
              {heatmap.weeks.map((week, weekIndex) => (
                <div key={week[0]?.date || `week-${weekIndex}`} className="heatmap-week">
                  {week.map((cell, dayIndex) => (
                    <div
                      key={cell.date || `pad-${weekIndex}-${dayIndex}`}
                      className={`heatmap-cell heatmap-cell-${cell.level}`}
                      onMouseEnter={event => {
                        if (!cell.date) return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        setHoverCell({ weekIndex, dayIndex, x: rect.left + rect.width / 2, y: rect.top });
                      }}
                      onMouseLeave={() => setHoverCell(current => (
                        current?.weekIndex === weekIndex && current.dayIndex === dayIndex ? null : current
                      ))}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
          {hoverCell && (() => {
            const cell = heatmap.weeks[hoverCell.weekIndex]?.[hoverCell.dayIndex];
            if (!cell?.date) return null;
            return (
              <div className="heatmap-tip" role="tooltip" style={{ left: hoverCell.x, top: hoverCell.y }}>
                <div className="heatmap-tip-date">{cell.date}</div>
                <div className="heatmap-tip-val">{t("usage.heatmap.tooltipTokens", { tokens: formatTokens(cell.totalTokens, locale) })}</div>
                <div className="heatmap-tip-req muted">{t("usage.heatmap.tooltipRequests", { requests: cell.requests })}</div>
              </div>
            );
          })()}
          <div className="heatmap-legend muted">
            <span>{t("usage.heatmap.less")}</span>
            {[0, 1, 2, 3, 4].map(level => <span key={level} className={`heatmap-cell heatmap-cell-${level}`} />)}
            <span>{t("usage.heatmap.more")}</span>
          </div>
        </div>
      )}
    </section>
  );
}

function UsageWorkspaceSection({
  title,
  titleId,
  children,
}: {
  title: string;
  titleId: string;
  children: ReactNode;
}) {
  return (
    <section className="usw-section" aria-labelledby={titleId}>
      <h3 id={titleId} className="h-section">{title}</h3>
      {children}
    </section>
  );
}

function UsageModelsTable({
  models,
  modelQuery,
  onModelQuery,
  locale,
  t,
  workspace = false,
}: {
  models: UsageModel[];
  modelQuery: string;
  onModelQuery: (query: string) => void;
  locale: Locale;
  t: TFn;
  workspace?: boolean;
}) {
  const searchLabel = t("usage.search.models");
  const sectionLabel = t("usage.section.models");
  const titleId = "usage-models-title";
  const searchInput = (
    <input
      className="input"
      aria-label={searchLabel}
      placeholder={searchLabel}
      value={modelQuery}
      onChange={event => onModelQuery(event.target.value)}
    />
  );
  const table = (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>{t("logs.col.model")}</th>
            <th>{t("logs.col.provider")}</th>
            <th className="num">{t("usage.col.requests")}</th>
            <th className="num">{t("usage.col.measured")}</th>
            <th className="num">{t("usage.col.tokens")}</th>
            <th>{t("usage.col.share")}</th>
          </tr>
        </thead>
        <tbody>
          {models.map(model => (
            <tr key={`${model.provider}/${model.model}`}>
              <td className="mono">{modelLabel(model.model)}</td>
              <td className="muted">{formatProviderDisplayName(model.provider, t)}</td>
              <td className="num">{model.requests}</td>
              <td className="num">{model.measuredRequests}</td>
              <td className="num mono">{formatTokens(model.totalTokens, locale)}</td>
              <td><div className="usage-bar"><div className="usage-bar-fill" style={{ width: `${Math.round(model.shareRatio * 100)}%` }} /></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (workspace) {
    return (
      <UsageWorkspaceSection title={sectionLabel} titleId={titleId}>
        <div className="usw-section-toolbar">{searchInput}</div>
        {table}
      </UsageWorkspaceSection>
    );
  }

  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby={titleId}>
      <div className="panel-head">
        <h3 id={titleId} className="panel-title">{sectionLabel}</h3>
        {searchInput}
      </div>
      {table}
    </section>
  );
}

function UsageProvidersTable({
  providers,
  locale,
  t,
  workspace = false,
}: {
  providers: UsageProvider[];
  locale: Locale;
  t: TFn;
  workspace?: boolean;
}) {
  const sectionLabel = t("usage.section.providers");
  const titleId = "usage-providers-title";
  const table = (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>{t("logs.col.provider")}</th>
            <th className="num">{t("usage.col.requests")}</th>
            <th className="num">{t("usage.col.measured")}</th>
            <th className="num">{t("usage.col.tokens")}</th>
            <th>{t("usage.col.share")}</th>
          </tr>
        </thead>
        <tbody>
          {providers.map(provider => (
            <tr key={provider.provider}>
              <td className="mono">{formatProviderDisplayName(provider.provider, t)}</td>
              <td className="num">{provider.requests}</td>
              <td className="num">{provider.measuredRequests}</td>
              <td className="num mono">{formatTokens(provider.totalTokens, locale)}</td>
              <td><div className="usage-bar"><div className="usage-bar-fill" style={{ width: `${Math.round(provider.shareRatio * 100)}%` }} /></div></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (workspace) {
    return (
      <UsageWorkspaceSection title={sectionLabel} titleId={titleId}>
        {table}
      </UsageWorkspaceSection>
    );
  }

  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby={titleId}>
      <h3 id={titleId} className="panel-title">{sectionLabel}</h3>
      {table}
    </section>
  );
}

function UsageCoveragePanel({
  summary,
  t,
  workspace = false,
}: {
  summary: UsageSummaryTotals;
  t: TFn;
  workspace?: boolean;
}) {
  const sectionLabel = t("usage.section.coverage");
  const titleId = "usage-coverage-title";
  const body = (
    <>
      <div className="usage-cards usage-cards-3x2">
        <div className="stat"><div className="muted">{t("usage.coverage.measured")}</div><div className="stat-value">{summary.measuredRequests}</div></div>
        <div className="stat"><div className="muted">{t("usage.coverage.reported")}</div><div className="stat-value">{summary.reportedRequests}</div></div>
        <div className="stat"><div className="muted">{t("usage.coverage.estimated")}</div><div className="stat-value">{summary.estimatedRequests}</div></div>
        <div className="stat"><div className="muted">{t("logs.tokens.unreported")}</div><div className="stat-value">{summary.unreportedRequests}</div></div>
        <div className="stat"><div className="muted">{t("logs.tokens.unsupported")}</div><div className="stat-value">{summary.unsupportedRequests}</div></div>
      </div>
      <p className="muted text-control" style={{ marginTop: 12 }}>{t("usage.coverage.note")}</p>
    </>
  );

  if (workspace) {
    return (
      <UsageWorkspaceSection title={sectionLabel} titleId={titleId}>
        {body}
      </UsageWorkspaceSection>
    );
  }

  return (
    <section className="panel" style={{ marginTop: 16 }} aria-labelledby={titleId}>
      <h3 id={titleId} className="panel-title">{sectionLabel}</h3>
      {body}
    </section>
  );
}

/**
 * Workspace layout for Usage: left rail picks one report section so Overview /
 * Models / Providers / Coverage do not stack into a long scroll.
 */
function UsageWorkspaceBody({
  data,
  heatmap,
  periodBars,
  activeDays,
  filteredModels,
  modelQuery,
  onModelQuery,
  sortedProviders,
  range,
  windowDayOffset,
  onMoveWeek,
  locale,
  t,
}: {
  data: UsageResponse | null;
  heatmap: ReturnType<typeof buildHeatmap>;
  periodBars: UsageDay[];
  activeDays: number;
  filteredModels: UsageModel[];
  modelQuery: string;
  onModelQuery: (query: string) => void;
  sortedProviders: UsageProvider[];
  range: Range;
  windowDayOffset: number;
  onMoveWeek: (direction: "older" | "newer") => void;
  locale: Locale;
  t: TFn;
}) {
  // A zero-activity historical week must keep the chart navigator visible so the
  // user can continue paging instead of getting trapped in a generic empty state.
  const empty = !!data && data.summary.requests === 0 && range !== "7d";
  const sections = [
    {
      id: "overview",
      label: t("usage.section.overview"),
      meta: data ? `${data.summary.requests}` : "—",
      body: data ? (
        <>
          <UsageSummaryCards summary={data.summary} activeDays={activeDays} locale={locale} t={t} />
          <UsageHeatmapPanel
            range={range}
            heatmap={heatmap}
            periodBars={periodBars}
            windowDayOffset={windowDayOffset}
            onMoveWeek={onMoveWeek}
            locale={locale}
            t={t}
          />
        </>
      ) : null,
    },
    {
      id: "models",
      label: t("usage.section.models"),
      meta: data ? `${data.models.length}` : "—",
      body: data
        ? <UsageModelsTable models={filteredModels} modelQuery={modelQuery} onModelQuery={onModelQuery} locale={locale} t={t} workspace />
        : null,
    },
    {
      id: "providers",
      label: t("usage.section.providers"),
      meta: data ? `${data.providers.length}` : "—",
      body: data
        ? <UsageProvidersTable providers={sortedProviders} locale={locale} t={t} workspace />
        : null,
    },
    {
      id: "coverage",
      label: t("usage.section.coverage"),
      meta: data ? formatPct(data.summary.coverageRatio) : "—",
      body: data ? <UsageCoveragePanel summary={data.summary} t={t} workspace /> : null,
    },
  ];
  return (
    <div className="usage-workspace-shell">
      <div className="usage-workspace-root">
        {/*
          Every section stays in the document and the page scrolls; the pinned strip scrolls
          to one instead of swapping the panel. Switching by replacement meant only one
          section existed at a time, so the report could not be read by scrolling at all.
        */}
        <SectionTabs
          scope="usage"
          ariaLabel={t("usage.workspace.sections")}
          items={sections.map(s => ({ id: s.id, label: s.label, meta: s.meta }))}
        />
        <section className="usage-workspace-main" aria-label={t("usage.workspace.report")}>
          {empty ? <EmptyState title={t("usage.empty")} /> : sections.map(s => (
            <div key={s.id} id={sectionAnchorId("usage", s.id)} className="usw-body usw-section-block">
              {s.body}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

/** Held usage payloads so provider/surface tab switches skip a cold ~5s refetch. */
const usageMemoryCache = new Map<string, UsageResponse>();

function usageCacheKey(apiBase: string, range: Range, surface: UsageSurface, weekEnd: string | null): string {
  return `ocx.usage.v2:${apiBase}:${range}:${surface}:${weekEnd ?? "latest"}`;
}

function readHeldUsage(apiBase: string, range: Range, surface: UsageSurface, weekEnd: string | null): UsageResponse | null {
  const key = usageCacheKey(apiBase, range, surface, weekEnd);
  return usageMemoryCache.get(key) ?? readSessionListCache<UsageResponse>(key);
}

function writeHeldUsage(apiBase: string, range: Range, surface: UsageSurface, weekEnd: string | null, value: UsageResponse) {
  const key = usageCacheKey(apiBase, range, surface, weekEnd);
  if (!usageMemoryCache.has(key) && usageMemoryCache.size >= 96) {
    usageMemoryCache.delete(usageMemoryCache.keys().next().value!);
  }
  usageMemoryCache.set(key, value);
  writeSessionListCache(key, value);
}

export default function Usage({ apiBase }: { apiBase: string }) {
  const { t, locale } = useI18n();
  const [range, setRange] = useState<Range>("7d");
  const [surface, setSurface] = useState<UsageSurface>("all");
  const [windowDayOffset, setWindowDayOffset] = useState(0);
  const [modelQuery, setModelQuery] = useState("");
  const forceRefreshRef = useRef(false);
  const weekEnd = range === "7d" && windowDayOffset < 0
    ? singaporeDateOffset(windowDayOffset)
    : null;

  const loadUsage = useCallback(async (signal: AbortSignal): Promise<UsageResponse> => {
    const forceRefresh = forceRefreshRef.current;
    forceRefreshRef.current = false;
    const params = new URLSearchParams({ range, surface });
    if (weekEnd) params.set("end", weekEnd);
    if (forceRefresh) params.set("refresh", "1");
    const response = await fetch(`${apiBase}/api/usage?${params}`, { signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
    const next = await response.json() as UsageResponse;
    writeHeldUsage(apiBase, range, surface, weekEnd, next);
    return next;
  }, [apiBase, range, surface, weekEnd]);

  const resourceKey = usageCacheKey(apiBase, range, surface, weekEnd);
  const cached = readHeldUsage(apiBase, range, surface, weekEnd);
  // Range and surface identify different reports, so the key changes with both. That prevents
  // a force-loading dependency revalidation from ever showing a previous report as this one.
  const resource = useDataSurface<UsageResponse>(
    resourceKey,
    [apiBase, range, surface, weekEnd],
    loadUsage,
    { isEmpty: () => false, initialData: cached ?? undefined },
  );
  const { state } = resource;
  const data = state.data ?? cached ?? null;
  const refreshUsage = useCallback(() => {
    forceRefreshRef.current = true;
    resource.refresh();
  }, [resource]);

  const heatmap = useMemo(() => buildHeatmap(data?.days ?? []), [data?.days]);
  const periodBars = useMemo(
    () => (data?.days ?? []).slice(range === "1d" ? -1 : -7),
    [data?.days, range],
  );
  const moveWeek = useCallback((direction: "older" | "newer") => {
    setWindowDayOffset(current => direction === "older" ? current - 1 : Math.min(0, current + 1));
  }, []);
  const changeRange = useCallback((next: Range) => {
    setRange(next);
    if (next !== "7d") setWindowDayOffset(0);
  }, []);
  const activeDays = useMemo(() => (data?.days ?? []).filter(d => d.requests > 0).length, [data?.days]);
  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const models = data?.models ?? [];
    const sorted = models.toSorted((a, b) => b.totalTokens - a.totalTokens);
    if (!q) return sorted.slice(0, 100);
    return sorted.filter(m =>
      m.model.toLowerCase().includes(q) ||
      m.provider.toLowerCase().includes(q) ||
      (m.resolvedModel ?? "").toLowerCase().includes(q),
    ).slice(0, 100);
  }, [data?.models, modelQuery]);

  const sortedProviders = useMemo(() =>
    (data?.providers ?? []).toSorted((a, b) => b.totalTokens - a.totalTokens),
    [data?.providers],
  );

  return (
    <>
      <div className="page-head usage-head">
        <h2 id="usage-page-title">{t("usage.title")}</h2>
        <UsageFilters
          surface={surface}
          range={range}
          refreshing={state.refreshing}
          onSurface={setSurface}
          onRange={changeRange}
          onRefresh={refreshUsage}
          t={t}
        />
      </div>
      <p className="page-sub">{t("usage.subtitle")}</p>

      {state.showSkeleton && !data ? (
        <DataSurfaceSkeleton label={t("usage.loading")} rows={5} />
      ) : state.kind === "failed-cold" ? (
        <Notice tone="err">
          {state.error instanceof Error ? `${t("usage.loadError")} ${state.error.message}` : t("usage.loadError")}{" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => resource.refresh()}>
            {t("common.retry")}
          </button>
        </Notice>
      ) : (
        <>
          {state.showError && <Notice tone="err">{t("usage.loadError")}</Notice>}
          {data?.historyTruncated && <Notice tone="ok">{t("usage.historyTruncated")}</Notice>}
          <UsageWorkspaceBody
            data={data}
            heatmap={heatmap}
            periodBars={periodBars}
            activeDays={activeDays}
            filteredModels={filteredModels}
            modelQuery={modelQuery}
            onModelQuery={setModelQuery}
            sortedProviders={sortedProviders}
            range={range}
            windowDayOffset={windowDayOffset}
            onMoveWeek={moveWeek}
            locale={locale}
            t={t}
          />
        </>
      )}
    </>
  );
}
