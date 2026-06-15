import { existsSync } from "node:fs";
import { join } from "node:path";
import { commandExistsSync } from "../../lib/security/safe-exec.js";

function runtimeScript(packageRoot, relativePath) {
  const direct = join(packageRoot, relativePath);
  if (existsSync(direct)) return direct;
  return join(packageRoot, "dist", relativePath);
}

function resolveConfig(config) {
  return typeof config === "function" ? config() : config;
}

export function detectRunnerModelProvider({ config, execSync: _execSync, detectProvider }) {
  // P12.I1: PATH walk via fs.accessSync — no sh -c, no shell:true.
  return detectProvider({
    config,
    commandExists(command) {
      return commandExistsSync(String(command ?? "").trim());
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
} = Object()) {
  return {
    createWorktree(taskId) {
      const wt = createTaskWorktree({
        taskId,
        rootDir: getRootDir(),
        worktreeRoot: getWorktreeRoot(),
        config: resolveConfig(config),
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
} = Object()) {
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
} = Object()) {
  const results = refreshBaselineAfterCommit({ rootDir, runtimeDir, config });
  for (const result of results) {
    if (!result.skipped && result.removed > 0) {
      log("BASELINE", "update", `${result.tool} baseline: 移除 ${result.removed} 个已修复条目，剩余 ${result.after}`);
    }
  }
  return results;
}
