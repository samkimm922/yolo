#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const YOLO_ROOT = resolve(__dirname, "../../..");

function argValue(argv, prefix) {
  const arg = argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeStateSnapshot({ argv = [], now = new Date() } = Object()) {
  const stateRootArg = argValue(argv, "--state-root=") || argValue(argv, "--yolo-root=");
  const stateDirArg = argValue(argv, "--state-dir=");
  const stateDir = stateDirArg
    ? resolve(stateDirArg)
    : join(resolve(stateRootArg || YOLO_ROOT), "state");
  const prd = argValue(argv, "--prd=");
  const snapshot = {
    version: "1.0",
    generated_at: now.toISOString(),
    prd,
    current_run: readJsonIfExists(join(stateDir, "current-run.json")),
    latest_progress: readJsonIfExists(join(stateDir, "runtime", "progress-snapshot.json")),
  };

  mkdirSync(join(stateDir, "progress-snapshots"), { recursive: true });
  const latestFile = join(stateDir, "progress-snapshots", "latest.json");
  writeFileSync(latestFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return { status: "ok", file: resolve(latestFile), snapshot };
}

export function runStateSnapshotCli(argv = process.argv.slice(2), io = Object()) {
  const stdout = io.stdout || process.stdout;
  const result = writeStateSnapshot({ argv });
  if (argv.includes("--json")) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    stdout.write(`[state-snapshot] wrote ${result.file}\n`);
  }
  return result;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) runStateSnapshotCli();
