import { describe, expect, test } from "bun:test";
import { modelInList } from "../src/types";

describe("provider model capability matching", () => {
  test("matches namespaced model ids by their bare model slug", () => {
    expect(modelInList(["deepseek-v4-flash"], "deepseek/deepseek-v4-flash")).toBe(true);
    expect(modelInList(["deepseek-v4-flash"], "deepseek-v4-flash")).toBe(true);
    expect(modelInList(["deepseek-v4-flash"], "deepseek-v4-flash:latest")).toBe(true);
    expect(modelInList(["deepseek-v4-flash"], "deepseek/deepseek-v4-pro")).toBe(false);
  });
});
