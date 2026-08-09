export const packageName = "univers-gateway";
export const cliCommand = "ugw";

export async function loadBunApi() {
  if (typeof Bun === "undefined") {
    throw new Error("The Univers Gateway programmatic API requires the Bun runtime. Use `ugw` for the CLI entrypoint.");
  }
  return import("../src/index.ts");
}
