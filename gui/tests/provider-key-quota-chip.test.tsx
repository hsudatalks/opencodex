import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { ApiKeyRow, ProviderAuthHandlers } from "../src/components/provider-workspace/types";
import { en } from "../src/i18n/en";

/**
 * A pool exists because its credentials are independent entitlements, so the "active" badge
 * says nothing about how much of its own 5-hour window a given key has burned. Without a
 * per-key readout an exhausted key and an untouched peer look identical in the list.
 *
 * The wire field is UTILISATION ("percent used"), so the chip must invert it — rendering the
 * used percentage as if it were the remainder would label the dying key as the healthy one.
 */
const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

const ITEM: WorkspaceItem = {
  name: "zhipu",
  adapter: "openai",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  authMode: "key",
  hasApiKey: true,
};

const HANDLERS: ProviderAuthHandlers = {
  onLogin: () => {},
  onLogout: () => {},
  onReauth: () => {},
  onSwitchAccount: () => {},
  onRemoveAccount: () => {},
  onAddApiKey: async () => true,
  onSwitchApiKey: () => {},
  onRemoveApiKey: () => {},
  onEditAlias: () => {},
};

function key(overrides: Partial<ApiKeyRow> & { id: string }): ApiKeyRow {
  return { label: undefined, masked: "sk-…", active: false, ...overrides };
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://localhost:10100/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const g of globals) {
    Object.defineProperty(globalThis, g, { configurable: true, value: previous[g] });
  }
  await win.happyDOM?.close?.();
});

async function mountPanel(keys: ApiKeyRow[]) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel item={ITEM} apiBase="" keys={keys} authHandlers={HANDLERS} />
      </LanguageProvider>,
    );
  });
}

/** The chip is the only key-row badge carrying the window's own label as its tooltip. */
function keyQuotaChips(): Element[] {
  return [...host.querySelectorAll(`.pwi-auth-list .badge[title="${en["quota.fiveHourLimit"]}"]`)];
}

/** Every window chip on the row, in DOM order, keyed by the label it advertises. */
function chipsByTitle(): Array<{ title: string; text: string }> {
  const titles = [en["quota.fiveHourLimit"], en["quota.weeklyLimit"], en["quota.monthlyLimit"]];
  return [...host.querySelectorAll(".pwi-auth-list .badge")]
    .map(el => ({ title: el.getAttribute("title") ?? "", text: (el.textContent ?? "").trim() }))
    .filter(chip => titles.includes(chip.title as never));
}

function expectedChipFor(key: "fiveHour" | "weekly" | "monthly", pct: number): string {
  const tkey = key === "fiveHour"
    ? "quota.fiveHourRemaining"
    : key === "weekly" ? "quota.weeklyRemaining" : "quota.monthlyRemaining";
  return en[tkey].replace("{pct}", String(pct));
}

function expectedChip(pct: number): string {
  return en["quota.fiveHourRemaining"].replace("{pct}", String(pct));
}

test("each pool key reports its OWN remaining 5-hour window", async () => {
  await mountPanel([
    key({ id: "fresh", quota: { fiveHourPercent: 12 } }),
    key({ id: "spent", quota: { fiveHourPercent: 99 } }),
  ]);

  const chips = keyQuotaChips().map(el => (el.textContent ?? "").trim());
  // 12% used is 88 left; 99% used is 1 left. The order is the key order in the list.
  expect(chips).toEqual([expectedChip(88), expectedChip(1)]);
});

test("a nearly-exhausted key is warned on, a comfortable one is not", async () => {
  await mountPanel([
    key({ id: "comfortable", quota: { fiveHourPercent: 12 } }),
    key({ id: "nearly-done", quota: { fiveHourPercent: 85 } }),
  ]);

  const [comfortable, nearlyDone] = keyQuotaChips();
  expect(comfortable.classList.contains("badge-muted")).toBe(true);
  expect(comfortable.classList.contains("badge-amber")).toBe(false);
  expect(nearlyDone.classList.contains("badge-amber")).toBe(true);
  expect(nearlyDone.classList.contains("badge-muted")).toBe(false);
});

test("a key with no readable window shows no chip instead of 0%", async () => {
  await mountPanel([
    key({ id: "unknown", quotaError: "unavailable" }),
    key({ id: "no-plan" }),
    key({ id: "known", quota: { fiveHourPercent: 50 } }),
  ]);

  expect(keyQuotaChips().map(el => (el.textContent ?? "").trim())).toEqual([expectedChip(50)]);
});

test("the chip sits outside the row button so the active key's own control cannot dim it", async () => {
  await mountPanel([key({ id: "active", active: true, quota: { fiveHourPercent: 30 } })]);

  const [chip] = keyQuotaChips();
  expect(chip).toBeTruthy();
  // The row button is disabled on the active key; a nested badge would inherit that state.
  expect(chip.closest(".pwi-auth-row-main")).toBeNull();
  expect(chip.closest(".pwi-auth-row")).not.toBeNull();
});

/**
 * A key can be comfortable on its 5-hour window and nearly out of its 30-day budget (OpenCode
 * reports rolling, weekly and monthly). Rendering only the 5-hour window let such a key read as
 * healthy, so every window the provider reports needs its own chip.
 */
test("a key reporting all three windows shows one labelled chip per window, shortest first", async () => {
  await mountPanel([key({ id: "full", quota: { fiveHourPercent: 4, weeklyPercent: 67, monthlyPercent: 41 } })]);

  expect(chipsByTitle()).toEqual([
    { title: en["quota.fiveHourLimit"], text: expectedChipFor("fiveHour", 96) },
    { title: en["quota.weeklyLimit"], text: expectedChipFor("weekly", 33) },
    { title: en["quota.monthlyLimit"], text: expectedChipFor("monthly", 59) },
  ]);
});

test("a provider reporting only a 30-day budget shows just that chip", async () => {
  await mountPanel([key({ id: "monthly-only", quota: { monthlyPercent: 90 } })]);

  expect(chipsByTitle()).toEqual([
    { title: en["quota.monthlyLimit"], text: expectedChipFor("monthly", 10) },
  ]);
});

test("each window warns on its own utilisation", async () => {
  await mountPanel([key({ id: "mixed", quota: { fiveHourPercent: 4, weeklyPercent: 85, monthlyPercent: 10 } })]);

  const chips = [...host.querySelectorAll(".pwi-auth-list .badge")]
    .filter(el => [en["quota.fiveHourLimit"], en["quota.weeklyLimit"], en["quota.monthlyLimit"]]
      .includes((el.getAttribute("title") ?? "") as never));
  const [fiveHour, weekly, monthly] = chips;
  // A comfortable 5-hour window must not mask a nearly-spent week, and vice versa.
  expect(fiveHour?.classList.contains("badge-muted")).toBe(true);
  expect(weekly?.classList.contains("badge-amber")).toBe(true);
  expect(monthly?.classList.contains("badge-muted")).toBe(true);
});

test("a window the provider omitted produces no chip rather than a fabricated 0%", async () => {
  await mountPanel([key({ id: "partial", quota: { fiveHourPercent: 50, monthlyPercent: 20 } })]);

  expect(chipsByTitle().map(c => c.title)).toEqual([en["quota.fiveHourLimit"], en["quota.monthlyLimit"]]);
});
