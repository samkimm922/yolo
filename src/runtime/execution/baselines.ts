import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
  writeFileSync as defaultWriteFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { safeExecSync as defaultExecSync, safeExecFileSync as defaultExecFileSync } from "../../lib/security/safe-exec.js";
import { parseCommandToArgv } from "../../lib/security/command-guard.js";
import { buildCommandEnv, commandUnavailableDetail, resolveBuildCommand, resolveGateTimeout } from "../../lib/toolchain.js";
import { commandOutputSnapshotKeys } from "../gates/error-output-policy.js";

export const BASELINE_KINDS = ["type_check", "lint"] as const;
export const BASELINE_TOOLS = BASELINE_KINDS;
export const BASELINE_FILE_NAMES = {
  type_check: "tsc-baseline.json",
  lint: "eslint-baseline.json",
};
export const BASELINE_RUNTIME_FILES = BASELINE_KINDS.map((kind) => BASELINE_FILE_NAMES[kind]);

function normalizeBaselineKind(kind) {
  if (kind === "tsc") return "type_check";
  if (kind === "eslint") return "lint";
  return kind;
}

export function baselineFileName(kind) {
  const normalized = normalizeBaselineKind(kind);
  return BASELINE_FILE_NAMES[normalized] || `${normalized}-baseline.json`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function snapshotCommandOutput(output = "", ...declarations) {
  return commandOutputSnapshotKeys(output, ...declarations);
}

// Compatibility aliases for callers that used the old helper names. The
// implementation is intentionally tool-agnostic; the names only identify the
// legacy API, not an output schema.
export const parseTscBaselineKeys = snapshotCommandOutput;
export const parseEslintBaselineKeys = snapshotCommandOutput;
export const parseEslintBaselineErrorKeys = snapshotCommandOutput;

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
  return buildCommandEnv(rootDir);
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
      output_schema: "yolo.execution.output_snapshot.v1",
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

export function captureCommandBaseline({
  kind,
  rootDir,
  command,
  timeout = 60000,
  baselinePath,
  config = Object(),
  execSync = defaultExecSync,
  writeFileSync = defaultWriteFileSync,
  nowIso = () => new Date().toISOString(),
} = Object()) {
  const run = runBaselineCommand({ rootDir, command, execSync, timeout });
  const keys = run.output.trim() ? snapshotCommandOutput(run.output, config) : [];
  const baseline = buildBaselineArtifact({
    tool: kind,
    keys,
    command,
    exitCode: run.exit_code,
    stdout: run.stdout || run.output,
    stderr: run.stderr,
    commit: currentCommit(rootDir, execSync),
    status: run.status,
    reason: run.reason,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  return writeBaseline(baselinePath, baseline, writeFileSync);
}

export const captureTscBaseline = (options = Object()) => captureCommandBaseline({ ...options, kind: "type_check" });
export const captureEslintBaseline = (options = Object()) => captureCommandBaseline({ ...options, kind: "lint" });

export function captureExecutionBaselines({
  rootDir,
  config,
  typeCheckBaselinePath,
  lintBaselinePath,
  tscBaselinePath,
  eslintBaselinePath,
  execSync = defaultExecSync,
  writeFileSync = defaultWriteFileSync,
  nowIso = () => new Date().toISOString(),
} = Object()) {
  const stashRef = createDirtyWorktreeSnapshot({ rootDir, execSync });
  const typeCheckCommand = resolveBuildCommand("type_check", config, rootDir);
  const lintCommand = resolveBuildCommand("lint", config, rootDir);
  const typeCheckBaseline = captureCommandBaseline({
    kind: "type_check",
    rootDir,
    command: typeCheckCommand,
    timeout: resolveGateTimeout("type_check", config),
    baselinePath: typeCheckBaselinePath || tscBaselinePath,
    config,
    execSync,
    writeFileSync,
    nowIso,
  });
  const lintBaseline = captureCommandBaseline({
    kind: "lint",
    rootDir,
    command: lintCommand,
    timeout: resolveGateTimeout("lint", config),
    baselinePath: lintBaselinePath || eslintBaselinePath,
    config,
    execSync,
    writeFileSync,
    nowIso,
  });
  const restored = restoreDirtyWorktreeSnapshot(stashRef, { rootDir, execSync });
  const baselineResults = [
    { kind: "type_check", tool: "type_check", baseline: typeCheckBaseline },
    { kind: "lint", tool: "lint", baseline: lintBaseline },
  ];
  const blocked = baselineResults
    .filter((result) => result.baseline.meta?.status === "blocked")
    .map((result) => ({
      kind: result.kind,
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
    type_check_keys: typeCheckBaseline.keys,
    lint_keys: lintBaseline.keys,
    type_check_baseline: typeCheckBaseline,
    lint_baseline: lintBaseline,
    // Legacy result aliases; their contents are the generic line snapshot.
    tsc_keys: typeCheckBaseline.keys,
    eslint_keys: lintBaseline.keys,
    tsc_baseline: typeCheckBaseline,
    eslint_baseline: lintBaseline,
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
  for (const kind of BASELINE_KINDS) {
    const baselinePath = join(runtimeDir, baselineFileName(kind));
    if (!existsSync(baselinePath)) {
      results.push({ kind, tool: kind, skipped: true, reason: "missing_baseline" });
      continue;
    }
    try {
      const command = resolveBuildCommand(kind, config, rootDir);
      if (!String(command).trim()) {
        results.push({ kind, tool: kind, skipped: true, reason: "baseline_command_not_configured" });
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
            timeout: resolveGateTimeout(kind, config),
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
          kind,
          tool: kind,
          skipped: true,
          reason: "refresh_failed",
          exit_code: exitCode,
          message: commandUnavailableDetail(kind, command, rootDir),
          error: `baseline refresh 工具失败 (exit ${exitCode})，保留旧 baseline 不清零`,
        });
        continue;
      }
      const currentKeys = output.trim() ? snapshotCommandOutput(output, config) : [];
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
        kind,
        tool: kind,
        skipped: false,
        before: oldKeys.length,
        after: baseline.keys.length,
        removed: oldKeys.length - baseline.keys.length,
        baseline_path: baselinePath,
      });
    } catch (error) {
      results.push({ kind, tool: kind, skipped: true, reason: "refresh_failed", error: error.message });
    }
  }
  return results;
}
