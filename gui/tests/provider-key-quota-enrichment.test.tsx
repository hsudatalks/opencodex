import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useEffect, useRef } from "react";
import type { Root } from "react-dom/client";
import { useProviderAccountPools } from "../src/hooks/useProviderAccountPools";

/**
 * The per-key quota read costs one upstream call PER KEY, so the key list must not wait on it:
 * an operator opening the panel has to see the pool immediately, with each key's own window
 * arriving a moment later.
 *
 * The merge is keyed by CREDENTIAL ID, never by list position. Keys are listed in pool order,
 * and a probe can answer in any order (and can omit a key it could not read); matching on
 * position would silently label one key with a peer's remaining balance — the exact confusion
 * this readout exists to remove.
 */

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let originalFetch: typeof globalThis.fetch;

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
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
  originalFetch = globalThis.fetch;
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
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  await win.happyDOM?.close?.();
});

/** Renders the pool state the hook holds, so assertions read what a row would receive. */
function Probe() {
  const aliveRef = useRef(true);
  const pools = useProviderAccountPools({
    apiBase: "",
    t: (k: string) => k,
    config: null,
    oauthStatus: {},
    aliveRef,
    notify: () => {},
    fetchConfig: async () => {},
    fetchOauth: async () => {},
    fetchProviderQuotas: async () => {},
    codexActiveNeedsReauth: false,
  });
  useEffect(() => { void pools.fetchKeyPools(["zhipu"]); }, [pools.fetchKeyPools]);
  return <pre data-pools>{JSON.stringify(pools.keyPools)}</pre>;
}

async function mountProbe() {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(host);
    root.render(<Probe />);
  });
}

function poolState(): Record<string, Array<{ id: string; quota?: { fiveHourPercent?: number }; quotaError?: string }>> {
  return JSON.parse(host.querySelector("[data-pools]")!.textContent ?? "{}");
}

async function settle() {
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
}

test("the key list paints before the per-key window probe resolves, then merges by key id", async () => {
  const requests: string[] = [];
  let releaseQuotas: ((body: unknown) => void) | null = null;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("quota=1")) {
        return new Promise<Response>(resolve => { releaseQuotas = body => resolve(json(body)); });
      }
      return json({ keys: [{ id: "key-a", masked: "sk-…a", active: true }, { id: "key-b", masked: "sk-…b", active: false }] });
    },
  });

  await mountProbe();
  await settle();

  // The forced probe is already in flight, and the plain list is on screen without it.
  expect(requests.some(url => url.includes("quota=1"))).toBe(true);
  expect(poolState().zhipu.map(entry => entry.id)).toEqual(["key-a", "key-b"]);
  expect(poolState().zhipu.every(entry => entry.quota === undefined)).toBe(true);

  // Only key B is answered, and the payload does not mention A at all.
  await act(async () => { releaseQuotas?.({ quotas: [{ id: "key-b", quota: { fiveHourPercent: 90 } }] }); });
  await settle();

  const pool = poolState().zhipu;
  expect(pool.find(entry => entry.id === "key-b")?.quota?.fiveHourPercent).toBe(90);
  // An unanswered key keeps its row and stays windowless rather than borrowing a peer's number.
  expect(pool.find(entry => entry.id === "key-a")?.quota).toBeUndefined();
});

test("a probe error is reported for that key alone", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string) => {
      const url = String(input);
      if (url.includes("quota=1")) return json({ quotas: [{ id: "key-b", error: "rejected" }] });
      return json({ keys: [{ id: "key-a", masked: "sk-…a", active: false }, { id: "key-b", masked: "sk-…b", active: false }] });
    },
  });

  await mountProbe();
  await settle();
  await settle();

  const pool = poolState().zhipu;
  expect(pool.find(entry => entry.id === "key-b")?.quotaError).toBe("rejected");
  expect(pool.find(entry => entry.id === "key-a")?.quotaError).toBeUndefined();
  expect(pool.find(entry => entry.id === "key-a")?.quota).toBeUndefined();
});
