import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_NAME,
  LEGACY_CLI_NAMES,
  LEGACY_CONFIG_DIR_NAME,
  LEGACY_PROVIDER_ID,
  PACKAGE_NAME,
  PRODUCT_NAME,
  PRODUCT_SLUG,
} from "../src/brand";

const root = join(import.meta.dir, "..");

describe("Univers Gateway brand contract", () => {
  test("defines one canonical public identity", () => {
    expect(PRODUCT_NAME).toBe("Univers Gateway");
    expect(PRODUCT_SLUG).toBe("univers-gateway");
    expect(PACKAGE_NAME).toBe("univers-gateway");
    expect(CLI_NAME).toBe("ugw");
  });

  test("keeps legacy entry points and storage identifiers compatible", () => {
    expect(LEGACY_CLI_NAMES).toEqual(["ocx", "opencodex"]);
    expect(LEGACY_CONFIG_DIR_NAME).toBe(".opencodex");
    expect(LEGACY_PROVIDER_ID).toBe("opencodex");
  });

  test("publishes canonical and legacy executable aliases", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name: string;
      bin: Record<string, string>;
      repository: { url: string };
    };

    expect(pkg.name).toBe(PACKAGE_NAME);
    expect(pkg.bin).toEqual({
      "univers-gateway": "./bin/ocx.mjs",
      ugw: "./bin/ocx.mjs",
      opencodex: "./bin/ocx.mjs",
      ocx: "./bin/ocx.mjs",
    });
    expect(pkg.repository.url).toBe("git+https://github.com/hsudatalks/opencodex.git");
  });

  test("uses the public brand in the dashboard shell", () => {
    const html = readFileSync(join(root, "gui", "index.html"), "utf8");
    const app = readFileSync(join(root, "gui", "src", "App.tsx"), "utf8");

    expect(html).toContain("<title>Univers Gateway</title>");
    expect(app).toContain("{PRODUCT_NAME}");
  });
});
