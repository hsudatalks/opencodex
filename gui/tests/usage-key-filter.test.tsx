import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { clearClientResourceStoresForTests } from "../src/client-resource";
import { LanguageProvider } from "../src/i18n/provider";
import Usage from "../src/pages/Usage";

/**
 * The Usage page could only ever answer "how much was spent", never "by whom". A gateway key
 * belongs to one client, so the per-key table is the only view that attributes a spike to a
 * machine — and filtering has to reach the request, not just hide rows client-side.
 */
test("Usage lists per-key spend and filters the report by the selected key", async () => {
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

  const usageRequests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    usageRequests.push(url);
    const params = new URL(url, "http://localhost").searchParams;
    const keyed = params.get("apiKeyId");
    const wide = params.get("range") === "30d";
    return Response.json({
      range: "7d",
      surface: "all",
      since: null,
      generatedAt: Date.now(),
      summary: {
        requests: 4, measuredRequests: 4, reportedRequests: 4, unreportedRequests: 0,
        unsupportedRequests: 0, estimatedRequests: 0, inputTokens: 30, outputTokens: 5,
        cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 35, coverageRatio: 1,
        estimatedCostUsd: 1.5, pricedRequests: 4, unpricedRequests: 0, unmeteredRequests: 0,
      },
      days: [],
      models: [],
      providers: [],
      keys: keyed === "key-alpha"
        ? [{ id: "key-alpha", name: "ark-workbench:domain-dev::host", requests: 3, attemptCount: 3, measuredRequests: 3, reportedRequests: 3, estimatedRequests: 0, inputTokens: 25, outputTokens: 5, totalTokens: 30, pricedRequests: 3, unpricedRequests: 0, unmeteredRequests: 0, estimatedCostUsd: 1.5 }]
        : [
          { id: "key-alpha", name: "ark-workbench:domain-dev::host", requests: 3, attemptCount: 3, measuredRequests: 3, reportedRequests: 3, estimatedRequests: 0, inputTokens: 25, outputTokens: 5, totalTokens: 30, pricedRequests: 3, unpricedRequests: 0, unmeteredRequests: 0, estimatedCostUsd: 1.5 },
          { id: "", requests: 1, attemptCount: 1, measuredRequests: 1, reportedRequests: 1, estimatedRequests: 0, inputTokens: 5, outputTokens: 0, totalTokens: 5, pricedRequests: 1, unpricedRequests: 0, unmeteredRequests: 0, estimatedCostUsd: 0 },
        ],
      ...(keyed ? { apiKeyId: keyed } : {}),
      ...(wide ? { keyBreakdownUnavailable: true, keys: [] } : {}),
      historyTruncated: false,
      truncatedPrefixBytes: 0,
      entriesTruncated: false,
      entriesDropped: 0,
    });
  }) as typeof fetch;

  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  const settle = async (ms = 20) => {
    await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, ms)); });
  };
  try {
    await act(async () => {
      root.render(createElement(LanguageProvider, null, createElement(Usage, { apiBase: "http://usage-key-test" })));
    });
    const deadline = Date.now() + 2_000;
    while (!(container.textContent ?? "").includes("Admission keys")) {
      if (Date.now() >= deadline) throw new Error("per-key section did not render");
      await settle();
    }

    // The breakdown is requested up front and every row is listed.
    expect(new URL(usageRequests[0]!).searchParams.get("byKey")).toBe("1");
    expect(container.textContent).toContain("ark-workbench:domain-dev::host");
    expect(container.textContent).toContain("No admission key");
    // The selector is built from the same report, so the page needs no second request.
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Admission key"]')!;
    expect([...select.options].map(option => option.textContent)).toEqual([
      "All keys", "ark-workbench:domain-dev::host", "No admission key",
    ]);
    expect(usageRequests.every(url => url.includes("/api/usage"))).toBe(true);

    // Clicking a key row narrows the report server-side.
    const row = [...container.querySelectorAll<HTMLButtonElement>("button.usage-key-filter")]
      .find(button => button.textContent === "ark-workbench:domain-dev::host")!;
    await act(async () => { row.click(); });
    await settle(40);
    const filtered = usageRequests.map(url => new URL(url)).filter(url => url.searchParams.get("apiKeyId") === "key-alpha");
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.at(-1)!.searchParams.get("byKey")).toBe("1");

    // The clear control drops the filter again.
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find(button => button.textContent === "Clear key filter")!.click();
    });
    await settle(40);
    expect(new URL(usageRequests.at(-1)!).searchParams.has("apiKeyId")).toBe(false);

    // A range the read model cannot answer drops the filter and explains itself instead of
    // making the page wait on a raw-facts scan.
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Month")!.click();
    });
    await settle(60);
    const wideRequest = new URL(usageRequests.at(-1)!);
    expect(wideRequest.searchParams.get("range")).toBe("30d");
    expect(wideRequest.searchParams.has("byKey")).toBe(false);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Admission key"]')!.disabled).toBe(true);
    expect(container.textContent).toContain("The per-key breakdown covers the day and week windows");
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
