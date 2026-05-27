import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { prdSearchDirs, resolvePrdPath } from "../../../lib/paths.js";

export function findLatestPrd({ yoloRoot, searchDirs = prdSearchDirs(yoloRoot) } = {}) {
  try {
    const files = [];
    for (const dir of searchDirs) {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".json") || name === "package.json" || name === "tsconfig.json" || name.startsWith("retry-")) {
          continue;
        }
        const filePath = join(dir, name);
        files.push({ name, path: filePath, mtime: statSync(filePath).mtimeMs });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    for (const file of files) {
      try {
        const parsed = JSON.parse(readFileSync(file.path, "utf8"));
        if (Array.isArray(parsed.tasks) && parsed.tasks.length > 0 && parsed.tasks[0].id && parsed.tasks[0].priority) {
          return file.path;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

export function resolveRunnerCliArgs({
  argv = [],
  yoloRoot,
  resolvePrdPathFn = resolvePrdPath,
  findLatestPrdFn = () => findLatestPrd({ yoloRoot }),
} = {}) {
  const args = argv.slice(2);
  const prdFlagIndex = args.findIndex((arg) => arg.startsWith("--prd"));
  let prdArg;
  if (prdFlagIndex !== -1) {
    const prdFlag = args[prdFlagIndex];
    prdArg = prdFlag.includes("=")
      ? prdFlag.split("=").slice(1).join("=")
      : args[prdFlagIndex + 1];
  }
  if (!prdArg) {
    prdArg = args.find((arg) => !arg.startsWith("--")) || findLatestPrdFn();
  }
  const modeArg = args.find((arg) => arg.startsWith("--mode="));
  return {
    prdArg: prdArg ? resolvePrdPathFn(prdArg, yoloRoot) : null,
    mode: modeArg ? modeArg.split("=")[1] : "fix",
  };
}
