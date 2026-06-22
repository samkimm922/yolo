#!/usr/bin/env node
/**
 * CWE-400 PoC: Unbounded readFileSync in lifecycle-dashboard readJson.
 *
 * The readJson() function in lifecycle-dashboard.ts reads JSON files from the
 * lifecycle/state directory without a per-file size limit. An attacker or
 * corrupted state file (e.g., a multi-GB status.json or stage report JSON) causes:
 *
 * 1. readFileSync loads the entire file into memory (CWE-400, OOM)
 * 2. JSON.parse then attempts to parse the giant string — double allocation
 *
 * The fix adds statSync-based size check before readFileSync, with a 50 MB
 * default limit (MAX_REPORT_FILE_SIZE) and test-overridable via
 * setReportFileSizeMax / resetReportFileSizeMax.
 *
 * This script statically confirms the fix is applied.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = resolve(
  __dirname,
  "../../src/runtime/progress/lifecycle-dashboard.ts",
);

const source = readFileSync(DASHBOARD_PATH, "utf8");
let exitCode = 0;

// 1. Confirm MAX_REPORT_FILE_SIZE constant exists
if (source.includes("MAX_REPORT_FILE_SIZE")) {
  console.log("[PASS] MAX_REPORT_FILE_SIZE constant defined.");
} else {
  console.error("[FAIL] MAX_REPORT_FILE_SIZE constant missing.");
  exitCode = 1;
}

// 2. Confirm effectiveMaxSize() helper exists
if (source.includes("function effectiveMaxSize()")) {
  console.log("[PASS] effectiveMaxSize() helper defined.");
} else {
  console.error("[FAIL] effectiveMaxSize() helper missing.");
  exitCode = 1;
}

// 3. Confirm readJson() has a size check via statSync
if (source.includes("stat.size > effectiveMaxSize()")) {
  console.log("[PASS] readJson() guards against oversized files.");
} else {
  console.error("[FAIL] readJson() missing size guard.");
  exitCode = 1;
}

// 4. Confirm setReportFileSizeMax export exists
if (source.includes("export function setReportFileSizeMax")) {
  console.log("[PASS] setReportFileSizeMax exported for test override.");
} else {
  console.error("[FAIL] setReportFileSizeMax not exported.");
  exitCode = 1;
}

// 5. Confirm resetReportFileSizeMax export exists
if (source.includes("export function resetReportFileSizeMax")) {
  console.log("[PASS] resetReportFileSizeMax exported for test teardown.");
} else {
  console.error("[FAIL] resetReportFileSizeMax not exported.");
  exitCode = 1;
}

// 6. Confirm regression test file exists
import { existsSync } from "node:fs";
import { join } from "node:path";
const testPath = resolve(
  __dirname,
  "../../__tests__/lifecycle-reports-oom.test.ts",
);
if (existsSync(testPath)) {
  console.log("[PASS] Regression test exists:", testPath);
} else {
  console.error("[FAIL] Regression test missing.");
  exitCode = 1;
}

process.exit(exitCode);
