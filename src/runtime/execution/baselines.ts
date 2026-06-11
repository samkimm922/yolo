import {
  execFileSync as defaultExecFileSync,
  execSync as defaultExecSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
  writeFileSync as defaultWriteFileSync,
} from "node:fs";
import { join } from "node:path";

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

export function parseEslintBaselineKeys(output = "", rootDir = "") {
  const jsonStart = String(output).indexOf("[");
  let results = [];
  try {
    results = jsonStart >= 0 ? JSON.parse(String(output).slice(jsonStart)) : [];
  } catch {
    results = [];
  }
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
  const jsonStart = String(output).indexOf("[");
  let results = [];
  try {
    results = jsonStart >= 0 ? JSON.parse(String(output).slice(jsonStart)) : [];
  } catch {
    results = [];
  }
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
  try {
    const stdout = execSync(`${command} 2>&1`, {
      cwd: rootDir,
      encoding: "utf8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      command,
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
      command,
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
  const keys = parseTscBaselineKeys(run.output);
  const baseline = buildBaselineArtifact({
    tool: "tsc",
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

export function captureEslintBaseline({
  rootDir,
  command,
  baselinePath,
  execSync = defaultExecSync,
  writeFileSync = defaultWriteFileSync,
  nowIso = () => new Date().toISOString(),
} = Object()) {
  const run = runBaselineCommand({ rootDir, command, execSync, timeout: 60000 });
  const keys = parseEslintBaselineKeys(run.output, rootDir);
  const baseline = buildBaselineArtifact({
    tool: "eslint",
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
    command: config.build.type_check,
    baselinePath: tscBaselinePath,
    execSync,
    writeFileSync,
    nowIso,
  });
  const eslintBaseline = captureEslintBaseline({
    rootDir,
    command: config.build.lint,
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
        ? `${config.build.type_check} 2>&1 || true`
        : `${config.build.lint} 2>&1 || true`;
      const output = execFileSync("sh", ["-c", command], {
        cwd: rootDir,
        encoding: "utf8",
        timeout: 120000,
      });
      const currentKeys = tool === "tsc"
        ? parseTscBaselineKeys(output)
        : parseEslintBaselineErrorKeys(output, rootDir);
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
      const oldKeys = baseline.keys || [];
      baseline.keys = pruneResolvedBaselineKeys(oldKeys, currentKeys, rootDir);
      baseline.meta = baseline.meta || {};
      baseline.meta.command = command.replace(/\s+2>&1\s+\|\|\s+true$/, "");
      baseline.meta.exit_code = 0;
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
