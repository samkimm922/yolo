import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
  writeFileSync as defaultWriteFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, join } from "node:path";
import { safeExecSync as defaultExecSync, safeExecFileSync as defaultExecFileSync } from "../../lib/security/safe-exec.js";
import { parseCommandToArgv } from "../../lib/security/command-guard.js";

export const BASELINE_TOOLS = ["tsc", "eslint"];
export const BASELINE_FILE_NAMES = {
  tsc: "tsc-baseline.json",
  eslint: "eslint-baseline.json",
};
export const BASELINE_RUNTIME_FILES = Object.values(BASELINE_FILE_NAMES);

export function baselineFileName(tool) {
  return BASELINE_FILE_NAMES[tool] || `${tool}-baseline.json`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function parseTscBaselineKeys(output = "") {
  return [...new Set(
    String(output).split("\n")
      .map((line) => {
        const match = line.match(/^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+)/);
        return match ? `${match[1]}:${match[2]}:${match[3]}` : null;
      })
      .filter(Boolean),
  )];
}

// H12: Fail-closed baseline parsing. Tool output that is non-empty but not
// parseable as JSON is CORRUPT — treating it as "zero issues" would silently
// establish a clean baseline (fail-open). Empty output legitimately means zero
// issues. On corrupt output we throw BASELINE_CORRUPT so callers block.
export class BaselineParseError extends Error {
  code = "BASELINE_CORRUPT";
}

function parseEslintJsonArray(output = "") {
  const text = String(output || "");
  const jsonStart = text.indexOf("[");
  if (jsonStart < 0) {
    // No array start: only acceptable if there is genuinely no diagnostic output.
    if (text.trim() === "") return [];
    throw new BaselineParseError("eslint output has no JSON array");
  }
  let results;
  try {
    results = JSON.parse(text.slice(jsonStart));
  } catch {
    throw new BaselineParseError("eslint output is not valid JSON");
  }
  if (!Array.isArray(results)) throw new BaselineParseError("eslint output JSON is not an array");
  return results;
}

export function parseEslintBaselineKeys(output = "", rootDir = "") {
  const results = parseEslintJsonArray(output);
  const keys = [];
  for (const result of results) {
    const file = result.filePath?.replace(`${rootDir}/`, "") || "";
    for (const message of result.messages || []) {
      if (message.ruleId) keys.push(`${file}:${message.line}:${message.ruleId}`);
    }
  }
  return [...new Set(keys)];
}

export function parseEslintBaselineErrorKeys(output = "", rootDir = "") {
  const results = parseEslintJsonArray(output);
  const keys = [];
  for (const result of results) {
    const file = result.filePath?.replace(`${rootDir}/`, "") || "";
    for (const message of result.messages || []) {
      if (message.ruleId && message.severity >= 2) {
        keys.push(`${file}:${message.line}:${message.ruleId}`);
      }
    }
  }
  return [...new Set(keys)];
}

export function normalizeBaselineIssueKey(key = "", rootDir = "") {
  return String(key || "").replace(`${rootDir}/`, "").replace(/^\.\//, "");
}

export function pruneResolvedBaselineKeys(baselineKeys = [], currentKeys = [], rootDir = "") {
  const current = new Set(currentKeys.map((key) => normalizeBaselineIssueKey(key, rootDir)));
  return baselineKeys
    .map((key) => normalizeBaselineIssueKey(key, rootDir))
    .filter((key) => {
      if (current.has(key)) return true;
      const parts = key.split(":");
      if (parts.length === 2) {
        const [file, code] = parts;
        return [...current].some((currentKey) => {
          const currentParts = currentKey.split(":");
          return currentParts[0] === file && currentParts[currentParts.length - 1] === code;
        });
      }
      return false;
    });
}

function tail(value = "", limit = 4000) {
  return String(value || "").slice(-limit);
}

function commandOutput(error) {
  return (error?.stdout || "") + (error?.stderr || "");
}

function commandStderr(error) {
  return String(error?.stderr || "");
}

function commandStdout(error) {
  return String(error?.stdout || "");
}

function commandExitCode(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (Number.isInteger(error?.code)) return error.code;
  return 1;
}

function currentCommit(rootDir, execSync = defaultExecSync) {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function baselineCommandEnv(rootDir) {
  const localBin = join(rootDir, "node_modules", ".bin");
  return {
    ...process.env,
    PATH: [localBin, process.env.PATH || ""].filter(Boolean).join(delimiter),
  };
}

export function baselineArtifactHash(baseline = Object()) {
  const meta = { ...(baseline.meta || {}) };
  delete meta.artifact_hash;
  return sha256({ ...baseline, meta });
}

export function buildBaselineArtifact({
  tool,
  keys = [],
  command = "",
  exitCode = 0,
  stdout = "",
  stderr = "",
  commit = null,
  status = "pass",
  reason = null,
  createdAt = new Date().toISOString(),
  updatedAt = createdAt,
} = Object()) {
  const baseline = {
    keys,
    meta: Object.assign(Object(), {
      schema: "yolo.execution.baseline.v1",
      tool,
      command,
      exit_code: exitCode,
      status,
      reason,
      stderr_tail: tail(stderr),
      stdout_tail: tail(stdout),
      commit,
      created_at: createdAt,
      updated_at: updatedAt,
    }),
  };
  baseline.meta.artifact_hash = baselineArtifactHash(baseline);
  return baseline;
}

function writeBaseline(filePath, baseline, writeFileSync = defaultWriteFileSync) {
  writeFileSync(filePath, JSON.stringify(baseline, null, 2), "utf8");
  return baseline;
}

export function runBaselineCommand({
  rootDir,
  command,
  execSync = defaultExecSync,
  timeout = 60000,
} = Object()) {
  // P12.I1: default executor is safeExecSync (argv parse, reject shell metacharacters,
  // no shell). Tests may inject a mock execSync for unit control.
  const rawCommand = String(command || "").trim();
  if (!rawCommand) {
    return {
      command: rawCommand,
      exit_code: 0,
      stdout: "",
      stderr: "",
      output: "",
      signal: null,
      error: null,
      status: "skipped",
      reason: "baseline_command_not_configured",
    };
  }
  try {
    const stdout = execSync(rawCommand, {
      cwd: rootDir,
      encoding: "utf8",
      timeout,
      env: baselineCommandEnv(rootDir),
    });
    return {
      command: rawCommand,
      exit_code: 0,
      stdout,
      stderr: "",
      output: stdout,
      signal: null,
      error: null,
      status: "pass",
    };
  } catch (error) {
    const stdout = commandStdout(error);
    const stderr = commandStderr(error);
    const output = commandOutput(error);
    const exitCode = commandExitCode(error);
    const blocked = Boolean(error?.signal) ||
      exitCode === 127 ||
      /\bnot found\b|is not recognized|command not found/i.test(output) ||
      (!output.trim() && exitCode !== 0);
    return {
      command: rawCommand,
      exit_code: exitCode,
      stdout,
      stderr,
      output,
      signal: error?.signal || null,
      error: error?.message || String(error),
      status: blocked ? "blocked" : "pass",
      reason: blocked ? (error?.signal ? "baseline_command_timeout_or_signal" : "baseline_command_unavailable") : null,
    };
  }
}

export function createDirtyWorktreeSnapshot({ rootDir, execSync = defaultExecSync } = Object()) {
  try {
    const diffOut = execSync("git status --porcelain", {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (!diffOut.trim()) return null;
    const stashOut = execSync("git stash create", {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return stashOut.trim() || null;
  } catch {
    return null;
  }
}

export function restoreDirtyWorktreeSnapshot(stashRef, { rootDir, execSync = defaultExecSync } = Object()) {
  if (!stashRef) return false;
  // P12.I1: default executor is safeExecSync — parses "git stash apply <sha>" to argv,
  // rejects metacharacters, no shell. stashRef is a git-generated SHA (alphanumeric).
  try {
    execSync(`git stash apply ${stashRef}`, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function captureTscBaseline({
  rootDir,
  command,
  baselinePath,
  execSync = defaultExecSync,
  writeFileSync = defaultWriteFileSync,
  nowIso = () => new Date().toISOString(),
} = Object()) {
  const run = runBaselineCommand({ rootDir, command, execSync, timeout: 60000 });
  let keys = [];
  let status = run.status;
  let reason = run.reason;
  try {
    keys = parseTscBaselineKeys(run.output);
  } catch (error) {
    // H12: corrupt tool output must not establish a clean baseline.
    status = "blocked";
    reason = (error instanceof BaselineParseError && error.code) || "BASELINE_CORRUPT";
  }
  const baseline = buildBaselineArtifact({
    tool: "tsc",
    keys,
    command,
    exitCode: run.exit_code,
    stdout: run.stdout || run.output,
    stderr: run.stderr,
    commit: currentCommit(rootDir, execSync),
    status,
    reason,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  return writeBaseline(baselinePath, baseline, writeFileSync);
}

export function captureEslintBaseline({
  rootDir,
  command,
  baselinePath,
  execSync = defaultExecSync,
  writeFileSync = defaultWriteFileSync,
  nowIso = () => new Date().toISOString(),
} = Object()) {
  const run = runBaselineCommand({ rootDir, command, execSync, timeout: 60000 });
  let keys = [];
  let status = run.status;
  let reason = run.reason;
  try {
    keys = parseEslintBaselineKeys(run.output, rootDir);
  } catch (error) {
    // H12: corrupt tool output must not establish a clean baseline.
    status = "blocked";
    reason = (error instanceof BaselineParseError && error.code) || "BASELINE_CORRUPT";
  }
  const baseline = buildBaselineArtifact({
    tool: "eslint",
    keys,
    command,
    exitCode: run.exit_code,
    stdout: run.stdout || run.output,
    stderr: run.stderr,
    commit: currentCommit(rootDir, execSync),
    status,
    reason,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  return writeBaseline(baselinePath, baseline, writeFileSync);
}

export function captureExecutionBaselines({
  rootDir,
  config,
  tscBaselinePath,
  eslintBaselinePath,
  execSync = defaultExecSync,
  writeFileSync = defaultWriteFileSync,
  nowIso = () => new Date().toISOString(),
} = Object()) {
  const stashRef = createDirtyWorktreeSnapshot({ rootDir, execSync });
  const tscBaseline = captureTscBaseline({
    rootDir,
    command: config.build?.type_check || "",
    baselinePath: tscBaselinePath,
    execSync,
    writeFileSync,
    nowIso,
  });
  const eslintBaseline = captureEslintBaseline({
    rootDir,
    command: config.build?.lint || "",
    baselinePath: eslintBaselinePath,
    execSync,
    writeFileSync,
    nowIso,
  });
  const restored = restoreDirtyWorktreeSnapshot(stashRef, { rootDir, execSync });
  const baselineResults = [
    { tool: "tsc", baseline: tscBaseline },
    { tool: "eslint", baseline: eslintBaseline },
  ];
  const blocked = baselineResults
    .filter((result) => result.baseline.meta?.status === "blocked")
    .map((result) => ({
      tool: result.tool,
      reason: result.baseline.meta?.reason || "baseline_capture_failed",
      command: result.baseline.meta?.command || "",
      exit_code: result.baseline.meta?.exit_code ?? null,
    }));
  return {
    status: blocked.length > 0 ? "blocked" : "pass",
    blocks_execution: blocked.length > 0,
    blockers: blocked,
    stash_ref: stashRef,
    restored,
    tsc_keys: tscBaseline.keys,
    eslint_keys: eslintBaseline.keys,
    tsc_baseline: tscBaseline,
    eslint_baseline: eslintBaseline,
  };
}

export function refreshBaselineAfterCommit({
  rootDir,
  runtimeDir,
  config,
  execFileSync = defaultExecFileSync,
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
  writeFileSync = defaultWriteFileSync,
  nowIso = () => new Date().toISOString(),
} = Object()) {
  const results = [];
  for (const tool of ["tsc", "eslint"]) {
    const baselinePath = join(runtimeDir, `${tool}-baseline.json`);
    if (!existsSync(baselinePath)) {
      results.push({ tool, skipped: true, reason: "missing_baseline" });
      continue;
    }
    try {
      const command = tool === "tsc"
        ? config.build?.type_check || ""
        : config.build?.lint || "";
      if (!String(command).trim()) {
        results.push({ tool, skipped: true, reason: "baseline_command_not_configured" });
        continue;
      }
      // P12.I1: parse config command to argv, route through execFileSync DI
      // (default = safeExecFileSync, no shell). Rejects metacharacters at parse.
      const parsed = parseCommandToArgv(command);
      let output = "";
      let exitCode = 0;
      let blocked = false;
      if (!parsed.ok) {
        output = `command rejected: ${parsed.detail}`;
        exitCode = 127;
        blocked = true;
      } else {
        const argv = parsed.argv ?? [];
        try {
          const stdout = execFileSync(argv[0], argv.slice(1), {
            cwd: rootDir,
            encoding: "utf8",
            timeout: 120000,
            env: baselineCommandEnv(rootDir),
          });
          output = String(stdout || "");
        } catch (error) {
          output = `${String(error?.stdout || "")}${String(error?.stderr || "")}`;
          exitCode = Number.isInteger(error?.status) ? error.status : (Number.isInteger(error?.code) ? error.code : 1);
          blocked = Boolean(error?.signal) ||
            exitCode === 127 ||
            /\bnot found\b|is not recognized|command not found/i.test(output) ||
            (exitCode !== 0 && !output.trim());
        }
      }
      if (blocked) {
        results.push({
          tool,
          skipped: true,
          reason: "refresh_failed",
          exit_code: exitCode,
          error: `baseline refresh 工具失败 (exit ${exitCode})，保留旧 baseline 不清零`,
        });
        continue;
      }
      const currentKeys = tool === "tsc"
        ? parseTscBaselineKeys(output)
        : parseEslintBaselineErrorKeys(output, rootDir);
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
      const oldKeys = baseline.keys || [];
      baseline.keys = pruneResolvedBaselineKeys(oldKeys, currentKeys, rootDir);
      baseline.meta = baseline.meta || {};
      baseline.meta.command = command;
      baseline.meta.exit_code = exitCode;
      baseline.meta.commit = currentCommit(rootDir);
      baseline.meta.updated_at = nowIso();
      baseline.meta.artifact_hash = baselineArtifactHash(baseline);
      writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
      results.push({
        tool,
        skipped: false,
        before: oldKeys.length,
        after: baseline.keys.length,
        removed: oldKeys.length - baseline.keys.length,
        baseline_path: baselinePath,
      });
    } catch (error) {
      results.push({ tool, skipped: true, reason: "refresh_failed", error: error.message });
    }
  }
  return results;
}
