import { existsSync } from "node:fs";
import { join } from "node:path";

function runtimeScript(packageRoot, relativePath) {
  const direct = join(packageRoot, relativePath);
  if (existsSync(direct)) return direct;
  return join(packageRoot, "dist", relativePath);
}

export function detectRunnerModelProvider({ config, execSync, detectProvider }) {
  return detectProvider({
    config,
    commandExists(command) {
      return execSync(`command -v ${command} >/dev/null 2>&1; echo $?`, { shell: true, encoding: "utf8" }).trim() === "0";
    },
  }).selected;
}

export function createRunnerWorktreeHandlers({
  getRootDir,
  getWorktreeRoot,
  config,
  createTaskWorktree,
  cleanupTaskWorktree,
  setActiveGitSession,
  clearActiveGitSession,
  log,
} = {}) {
  return {
    createWorktree(taskId) {
      const wt = createTaskWorktree({
        taskId,
        rootDir: getRootDir(),
        worktreeRoot: getWorktreeRoot(),
        config,
      });
      setActiveGitSession({ activeWorktree: wt.path, activeBranch: wt.branch });
      return wt;
    },
    cleanupWorktree(wtPath, wtBranch, mergeToMain = false, allowedScope = [], baseRef = null) {
      const copiedFiles = cleanupTaskWorktree({
        wtPath,
        wtBranch,
        rootDir: getRootDir(),
        mergeToMain,
        allowedScope,
        baseRef,
        log: (phase, detail) => log("", phase, detail),
      });
      clearActiveGitSession({ activeWorktree: wtPath, activeBranch: wtBranch });
      return copiedFiles;
    },
  };
}

export function runRunnerGateInWorktree({
  taskId,
  prdPath,
  wtPath,
  mode,
  packageRoot,
  stateRoot,
  runtimeDir,
  rootDir,
  spawnSync,
} = {}) {
  const gateResult = spawnSync(
    "node",
    [
      runtimeScript(packageRoot, "gate.js"),
      `--task=${taskId}`,
      `--prd=${prdPath}`,
      `--mode=${mode}`,
      `--cwd=${wtPath}`,
      `--state-root=${stateRoot || packageRoot}`,
      `--log-dir=${runtimeDir}`,
    ],
    {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 300000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return {
    exitCode: gateResult.status ?? 1,
    stdout: (gateResult.stdout || "").trim(),
    stderr: (gateResult.stderr || "").trim(),
  };
}

export function refreshRunnerBaselinesAfterCommit({
  rootDir,
  runtimeDir,
  config,
  refreshBaselineAfterCommit,
  log,
} = {}) {
  const results = refreshBaselineAfterCommit({ rootDir, runtimeDir, config });
  for (const result of results) {
    if (!result.skipped && result.removed > 0) {
      log("BASELINE", "update", `${result.tool} baseline: 移除 ${result.removed} 个已修复条目，剩余 ${result.after}`);
    }
  }
  return results;
}
