import {
  execFileSync as defaultExecFileSync,
  execSync as defaultExecSync,
} from "node:child_process";
import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
  writeFileSync as defaultWriteFileSync,
} from "node:fs";
import { join } from "node:path";

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

function writeBaseline(filePath, keys, writeFileSync = defaultWriteFileSync) {
  writeFileSync(filePath, JSON.stringify({ keys }, null, 2), "utf8");
  return keys;
}

function commandOutput(error) {
  return (error?.stdout || "") + (error?.stderr || "");
}

export function createDirtyWorktreeSnapshot({ rootDir, execSync = defaultExecSync } = {}) {
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

export function restoreDirtyWorktreeSnapshot(stashRef, { rootDir, execSync = defaultExecSync } = {}) {
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
} = {}) {
  let output = "";
  try {
    output = execSync(`${command} 2>&1 || true`, {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 60000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    output = commandOutput(error);
  }
  return writeBaseline(baselinePath, parseTscBaselineKeys(output), writeFileSync);
}

export function captureEslintBaseline({
  rootDir,
  command,
  baselinePath,
  execSync = defaultExecSync,
  writeFileSync = defaultWriteFileSync,
} = {}) {
  let output = "";
  try {
    output = execSync(`${command} 2>&1 || true`, {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 60000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    output = commandOutput(error);
  }
  return writeBaseline(baselinePath, parseEslintBaselineKeys(output, rootDir), writeFileSync);
}

export function captureExecutionBaselines({
  rootDir,
  config,
  tscBaselinePath,
  eslintBaselinePath,
  execSync = defaultExecSync,
  writeFileSync = defaultWriteFileSync,
} = {}) {
  const stashRef = createDirtyWorktreeSnapshot({ rootDir, execSync });
  const tscKeys = captureTscBaseline({
    rootDir,
    command: config.build.type_check,
    baselinePath: tscBaselinePath,
    execSync,
    writeFileSync,
  });
  const eslintKeys = captureEslintBaseline({
    rootDir,
    command: config.build.lint,
    baselinePath: eslintBaselinePath,
    execSync,
    writeFileSync,
  });
  const restored = restoreDirtyWorktreeSnapshot(stashRef, { rootDir, execSync });
  return {
    stash_ref: stashRef,
    restored,
    tsc_keys: tscKeys,
    eslint_keys: eslintKeys,
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
} = {}) {
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
      baseline.meta.updated_at = nowIso();
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
