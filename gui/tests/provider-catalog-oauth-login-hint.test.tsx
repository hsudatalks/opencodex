import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderCatalog from "../src/components/provider-catalog/ProviderCatalog";
import { LanguageProvider } from "../src/i18n/provider";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
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
  if (root) await act(async () => root?.unmount());
  root = null;
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  await win.happyDOM?.close?.();
});

test("account catalog exposes GitHub Copilot device login handoff", async () => {
  const cancel = mock(() => {});
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderCatalog
          presets={[]}
          initialTier="accounts"
          onSelectPreset={() => {}}
          onSelectCustom={() => {}}
          accountRows={[{ id: "github-copilot", label: "GitHub Copilot", kind: "oauth" }]}
          accountStatus={{ "github-copilot": { loggedIn: false } }}
          busyProvider="github-copilot"
          loginHint={{
            provider: "github-copilot",
            url: "https://github.com/login/device",
            instructions: "Enter the code on GitHub.",
            deviceCode: "ABCD-EFGH",
          }}
          onCancelLogin={cancel}
        />
      </LanguageProvider>,
    );
  });

  expect(host.textContent).toContain("ABCD-EFGH");
  expect(host.textContent).toContain("https://github.com/login/device");
  expect(host.textContent).toContain("Enter the code on GitHub.");

  const cancelButton = Array.from(host.querySelectorAll("button")).find(
    button => button.textContent?.trim() === "Cancel",
  );
  expect(cancelButton).toBeTruthy();
  await act(async () => cancelButton?.dispatchEvent(new win.MouseEvent("click", { bubbles: true })));
  expect(cancel).toHaveBeenCalledWith("github-copilot");
});
