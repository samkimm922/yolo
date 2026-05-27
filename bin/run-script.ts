import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const yoloRoot = resolve(__dirname, "..");

export function runLegacyScript(scriptName, argv = process.argv.slice(2)) {
  const scriptPath = resolve(yoloRoot, scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...argv], {
    cwd: process.cwd(),
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`[yolo-bin] failed to run ${scriptName}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.signal) {
    console.error(`[yolo-bin] ${scriptName} terminated by signal ${result.signal}`);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}
