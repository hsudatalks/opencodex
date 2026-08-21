import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const gui = join(root, "gui");

function run(args: string[], cwd: string): void {
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["install", "--frozen-lockfile"], gui);
run(["run", "build"], gui);
run(["scripts/prepare-package.ts"], root);
