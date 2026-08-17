import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Usage from "../src/pages/Usage";

test("Usage renders every section in one scrollable column with a sticky strip", async () => {
  const page = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  const app = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

  expect(page).not.toContain("viewMode");
  expect(page).not.toContain("readViewMode");
  expect(page).not.toContain("ocx-usage-view");
  expect(page).toContain("UsageWorkspaceBody");
  expect(page).toContain("UsageWorkspaceSection");
  expect(page).toContain("usage-workspace-");
  expect(page).toContain("usw-");
  // Sections are anchors in one document, not a swapped panel: the old `selectedSection`
  // state rendered exactly one section, which is why the page could not be read by scrolling.
  expect(page).not.toContain("selectedSection");
  expect(page).toContain("<SectionTabs");
  expect(page).toContain("sectionAnchorId");

  expect(app).toContain("<Usage apiBase={API_BASE} />");
  expect(css).toContain("styles-usage-workspace.css");
  // The strip has to stay reachable while reading down the page.
  expect(css).toContain(".section-tabs");
  expect(css).toContain("position: sticky");
});

test("Usage workspace sections mount report panels in order", async () => {
  const src = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();

  const order = [
    "<UsageSummaryCards",
    "<UsageHeatmapPanel",
    "<UsageModelsTable",
    "<UsageProvidersTable",
    "<UsageCoveragePanel",
  ];
  let cursor = -1;
  for (const marker of order) {
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(cursor);
    cursor = at;
  }

  expect(src).toContain("UsageWorkspaceBody");
  expect(src).toContain("usw-section");
});

test("Usage loading and empty states guard the workspace body", async () => {
  const src = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  expect(src).toContain("state.showSkeleton && !data");
  expect(src).toContain("DataSurfaceSkeleton");
  expect(src).toContain('t("usage.loading")');
  expect(src).toContain('t("usage.empty")');
  expect(src).toContain("data.summary.requests === 0");
});

test("usage workspace i18n keys exist in every locale", async () => {
  const locales = ["en", "de", "ja", "ko", "ru", "zh"] as const;
  for (const locale of locales) {
    const dict = await Bun.file(new URL(`../src/i18n/${locale}.ts`, import.meta.url)).text();
    expect(dict).toContain('"usage.workspace.sections":');
    expect(dict).toContain('"usage.workspace.report":');
    expect(dict).toContain('"usage.range.available":');
    expect(dict).toContain('"usage.range.1d":');
    expect(dict).toContain('"usage.historyTruncated":');
    expect(dict).toContain('"usage.refresh":');
    expect(dict).toContain('"usage.refreshing":');
    expect(dict).toContain('"api.attribution.totalRequestsAvailable":');
  }
});

test("Usage refresh bypasses the cache and week navigation moves one day", async () => {
  const globalKeys = ["document", "window", "navigator", "localStorage", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(globalKeys.map(key => [key, Reflect.get(globalThis, key)]));
  const originalFetch = globalThis.fetch;
  const testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    ResizeObserver: { configurable: true, value: testWindow.ResizeObserver },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearClientResourceStoresForTests();
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return Response.json({
      range: "30d", surface: "all", since: null, generatedAt: Date.now(),
      summary: {
        requests: 1, measuredRequests: 1, reportedRequests: 1, unreportedRequests: 0,
        unsupportedRequests: 0, estimatedRequests: 0, inputTokens: 1, outputTokens: 0,
        cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 1, coverageRatio: 1,
      },
      days: [], models: [], providers: [], historyTruncated: false,
      truncatedPrefixBytes: 0, entriesTruncated: false, entriesDropped: 0,
    });
  }) as typeof fetch;

  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(LanguageProvider, null, createElement(Usage, { apiBase: "http://usage-refresh-test" })));
    });
    const deadline = Date.now() + 1_000;
    while (requests.length < 1 || !container.querySelector('button[aria-label="Refresh usage"]')) {
      if (Date.now() >= deadline) throw new Error("Usage refresh button did not render");
      await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10)); });
    }

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Refresh usage"]')!.click();
    });
    while (requests.length < 2) {
      if (Date.now() >= deadline) throw new Error("Usage refresh request did not run");
      await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10)); });
    }

    expect(new URL(requests[0]!).searchParams.has("refresh")).toBe(false);
    expect(new URL(requests[0]!).searchParams.get("range")).toBe("7d");
    expect(new URL(requests[1]!).searchParams.get("refresh")).toBe("1");

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Move back one day"]')!.click();
    });
    const navigationDeadline = Date.now() + 1_000;
    while (requests.length < 3) {
      if (Date.now() >= navigationDeadline) throw new Error("Usage window navigation request did not run");
      await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10)); });
    }
    const yesterday = new Date(Date.now() + 8 * 60 * 60 * 1_000 - 24 * 60 * 60 * 1_000)
      .toISOString()
      .slice(0, 10);
    expect(new URL(requests[2]!).searchParams.get("end")).toBe(yesterday);

    const rangeGroup = container.querySelector('[role="group"][aria-label="Usage"]');
    expect([...rangeGroup!.querySelectorAll("button")].map(button => button.textContent)).toEqual([
      "Week", "Day", "Month", "All",
    ]);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    globalThis.fetch = originalFetch;
    clearClientResourceStoresForTests();
    testWindow.close();
    for (const key of globalKeys) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    }
  }
});

test("Usage renders All and a persistent qualification when history is capped", async () => {
  const globalKeys = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(globalKeys.map(key => [key, Reflect.get(globalThis, key)]));
  const originalFetch = globalThis.fetch;
  const testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  clearClientResourceStoresForTests();
  globalThis.fetch = (async () => Response.json({
    range: "30d",
    surface: "all",
    since: null,
    generatedAt: Date.now(),
    summary: {
      requests: 0,
      measuredRequests: 0,
      reportedRequests: 0,
      unreportedRequests: 0,
      unsupportedRequests: 0,
      estimatedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      coverageRatio: 1,
    },
    days: [],
    models: [],
    providers: [],
    historyTruncated: true,
    truncatedPrefixBytes: 1,
    entriesTruncated: false,
    entriesDropped: 0,
  })) as typeof fetch;

  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(createElement(LanguageProvider, null, createElement(Usage, { apiBase: "http://usage-qualification-test" })));
    });
    const deadline = Date.now() + 1_000;
    while (!(container.textContent ?? "").includes("Totals cover available history only")) {
      if (Date.now() >= deadline) throw new Error("Usage qualification did not render");
      await act(async () => {
        await new Promise<void>(resolve => testWindow.setTimeout(resolve, 10));
      });
    }

    expect(container.querySelector('button[aria-label="All"]')).not.toBeNull();
    expect(container.textContent).toContain("Totals cover available history only because older usage was not loaded.");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    globalThis.fetch = originalFetch;
    clearClientResourceStoresForTests();
    testWindow.close();
    for (const key of globalKeys) {
      Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
    }
  }
});

test("Usage source marks keep brand colors and invert only the monochrome Grok mark", async () => {
  const page = await Bun.file(new URL("../src/pages/Usage.tsx", import.meta.url)).text();
  const css = await Bun.file(new URL("../src/styles.css", import.meta.url)).text();

  // Claude and Codex ship brand-colored SVGs and must not carry the mono modifier.
  expect(page).toContain('src="/provider-icons/claude-color.svg"');
  expect(page).not.toContain('usage-source-mark usage-source-mark--mono" src="/provider-icons/claude-color.svg"');
  expect(page).toContain('src="/provider-icons/openai.svg"');
  expect(page).not.toContain('usage-source-mark usage-source-mark--mono" src="/provider-icons/openai.svg"');

  // Grok ships a black monochrome mark: it is the only one that needs dark-theme inversion.
  expect(page).toContain('usage-source-mark usage-source-mark--mono" src="/provider-icons/grok.svg"');

  // Dark-theme inversion must be scoped to the mono modifier so brand hues survive.
  expect(css).toContain(':root[data-theme="dark"] .usage-source-mark--mono { filter: invert(1); }');
  expect(css).not.toContain(':root[data-theme="dark"] .usage-source-mark { filter: invert(1); }');
  // The OS dark-mode (prefers-color-scheme) path must keep the same scoping.
  expect(css).toContain(':root:not([data-theme="light"]) .usage-source-mark--mono { filter: invert(1); }');
  expect(css).not.toContain(':root:not([data-theme="light"]) .usage-source-mark { filter: invert(1); }');
});
