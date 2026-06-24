#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "scripts", "quality", "strict-typecheck-baseline.json");
const COMMAND = "tsc -p tsconfig.json --noEmit --strict --pretty false";

type Baseline = {
  max_errors: number;
  command: string;
  updated_at: string;
};

function countStrictErrors() {
  const tscBin = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [
    tscBin,
    "-p",
    "tsconfig.json",
    "--noEmit",
    "--strict",
    "--pretty",
    "false",
  ], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const errorCount = (output.match(/\berror TS\d+:/g) || []).length;
  if ((result.status ?? 1) !== 0 && errorCount === 0) {
    throw new Error("strict tsc failed but produced no parseable TypeScript errors");
  }
  return {
    errorCount,
    exitCode: result.status ?? 1,
  };
}

function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

function writeBaseline(errorCount: number) {
  const baseline: Baseline = {
    max_errors: errorCount,
    command: COMMAND,
    updated_at: new Date().toISOString(),
  };
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

function main() {
  const checkMode = process.argv.includes("--check");
  const updateBaseline = process.argv.includes("--update-baseline");
  const { errorCount, exitCode } = countStrictErrors();
  console.log(`[strict-typecheck] ${COMMAND}`);
  console.log(`[strict-typecheck] current strict errors: ${errorCount}`);

  if (updateBaseline) {
    writeBaseline(errorCount);
    console.log(`[strict-typecheck] wrote baseline ${BASELINE_PATH}`);
    return;
  }

  if (!checkMode) {
    if (exitCode === 0) console.log("[strict-typecheck] strict mode is clean.");
    else console.log("[strict-typecheck] read-only (pass --check to enforce or --update-baseline to ratchet).");
    return;
  }

  const baseline = readBaseline();
  if (!Number.isFinite(baseline.max_errors) || baseline.max_errors < 0) {
    throw new Error(`Invalid strict typecheck baseline at ${BASELINE_PATH}`);
  }
  console.log(`[strict-typecheck] baseline max errors: ${baseline.max_errors}`);
  if (errorCount > baseline.max_errors) {
    console.error(`[strict-typecheck] REGRESSION: ${errorCount} > baseline ${baseline.max_errors}`);
    process.exit(1);
  }
  if (errorCount < baseline.max_errors) {
    console.log(`[strict-typecheck] ratchet can be lowered: ${errorCount} < ${baseline.max_errors}`);
  }
  console.log("[strict-typecheck] ratchet OK (strict errors did not increase).");
}

try {
  main();
} catch (error) {
  console.error(`[strict-typecheck] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
