import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_MAX_RUNNER_CORE_LINES = 600;
const REQUIRED_RUNTIME_EXPORTS = Object.freeze([
  { export: "./runtime", target: "./dist/src/runtime/runner-runtime.js" },
]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function check(code, passed, message, extra = {}) {
  return { code, passed, message, ...extra };
}

function lineCount(source) {
  if (typeof source !== "string") return 0;
  const trimmed = source.trimEnd();
  return trimmed.length === 0 ? 0 : trimmed.split(/\r?\n/).length;
}

function runtimeBoundaryEntry(apiBoundary, exportName) {
  return (apiBoundary.package_exports || []).find((entry) => entry.export === exportName) || null;
}

export function exportedRunBody(source = "") {
  const match = /export\s+async\s+function\s+run\s*\([^)]*\)\s*\{/.exec(source);
  if (!match) return "";
  let depth = 0;
  const start = match.index + match[0].length - 1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start + 1, index);
    }
  }
  return source.slice(start + 1);
}

export function exportedRunCallsProcessExit(source = "") {
  return /\bprocess\.exit\s*\(/.test(exportedRunBody(source));
}

export function inspectRunnerRuntimeApiFreeze(options = {}) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const packageJson = options.packageJson || readJson(join(yoloRoot, "package.json"));
  const apiBoundary = options.apiBoundary || readJson(join(yoloRoot, "docs/public-sdk-api-boundary.json"));
  const runnerCoreSource = options.runnerCoreSource ?? readFileSync(join(yoloRoot, "src/runtime/runner-core.ts"), "utf8");
  const maxRunnerCoreLines = options.maxRunnerCoreLines || options.max_runner_core_lines || DEFAULT_MAX_RUNNER_CORE_LINES;
  const runnerCoreLineCount = options.runnerCoreLineCount ?? options.runner_core_line_count ?? lineCount(runnerCoreSource);

  const checks = [
    ...REQUIRED_RUNTIME_EXPORTS.map((entry) => check(
      "RUNTIME_API_EXPORT_TARGET",
      packageJson.exports?.[entry.export] === entry.target,
      `${entry.export} must point at ${entry.target}`,
      { export: entry.export, expected_target: entry.target, actual_target: packageJson.exports?.[entry.export] || null },
    )),
    ...REQUIRED_RUNTIME_EXPORTS.map((entry) => {
      const boundary = runtimeBoundaryEntry(apiBoundary, entry.export);
      return check(
        "RUNTIME_API_BOUNDARY_STABLE",
        boundary?.tier === "stable",
        `${entry.export} must be classified stable before runtime API freeze`,
        { export: entry.export, tier: boundary?.tier || null },
      );
    }),
    check(
      "RUNTIME_CORE_LINE_BUDGET",
      runnerCoreLineCount <= maxRunnerCoreLines,
      "runner-core must be below the stable runtime line budget",
      { runner_core_lines: runnerCoreLineCount, max_runner_core_lines: maxRunnerCoreLines },
    ),
    check(
      "RUNTIME_CORE_NO_PROCESS_EXIT_IN_RUN",
      !exportedRunCallsProcessExit(runnerCoreSource),
      "SDK run() path must not call process.exit directly",
    ),
  ];

  const blockers = checks.filter((item) => item.passed !== true);
  const boundaryBlockers = blockers.filter((item) => item.code === "RUNTIME_API_BOUNDARY_STABLE");
  const implementationBlockers = blockers.filter((item) => item.code !== "RUNTIME_API_BOUNDARY_STABLE");
  return {
    schema: "yolo.runtime.api_freeze.v1",
    status: blockers.length === 0 ? "pass" : "blocked",
    yolo_root: yoloRoot,
    max_runner_core_lines: maxRunnerCoreLines,
    runner_core_lines: runnerCoreLineCount,
    checks,
    blockers,
    boundary_blockers: boundaryBlockers,
    implementation_blockers: implementationBlockers,
    implementation_ready: implementationBlockers.length === 0,
    stable_boundary_decision_required: boundaryBlockers.length > 0,
    frozen: blockers.length === 0,
  };
}
