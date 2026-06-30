import { safeExecFileSync as defaultExecFileSync } from "../../lib/security/safe-exec.js";
import { killActiveProviderProcesses as defaultKillActiveProviderProcesses } from "../execution/provider-adapter.js";

const GIT_CLEANUP_EXEC_OPTIONS = { timeout: 15000, maxBuffer: 1024 * 1024 };

export function writeRunEndOnCrashEvent(result = Object(), { logRun, startTimeMs, nowMs = Date.now } = Object()) {
  try {
    logRun("run_end", {
      prd: result.prd || "unknown",
      passed: result.passed || 0,
      failed: result.failed || 0,
      duration_sec: result.durationSec || ((nowMs() - startTimeMs) / 1000).toFixed(1),
      exit_reason: result.reason || "signal",
    });
  } catch {}
}

export function saveRunnerProgressSnapshot({ stateDir, completedIds, failedIds, writeProgressSnapshot }) {
  writeProgressSnapshot({ stateDir, completedIds, failedIds });
}

export function cleanupActiveGitSession({
  activeWorktree,
  activeBranch,
  rootDir,
  execFileSync = defaultExecFileSync,
  log = (..._args) => {},
} = Object()) {
  if (activeWorktree) {
    try {
      log(`  清理 worktree: ${activeWorktree}`);
      execFileSync("git", ["worktree", "remove", "--force", activeWorktree], { cwd: rootDir, ...GIT_CLEANUP_EXEC_OPTIONS });
    } catch {}
  }
  if (activeBranch) {
    try {
      log(`  清理分支: ${activeBranch}`);
      execFileSync("git", ["branch", "-D", activeBranch], { cwd: rootDir, ...GIT_CLEANUP_EXEC_OPTIONS });
    } catch {}
  }
}

export async function cleanupProgressServer(progressServerProc, { processKill = process.kill } = Object()) {
  if (!progressServerProc) return;
  if (typeof progressServerProc.close === "function") {
    try {
      await progressServerProc.close();
      return;
    } catch (_) {}
  }
  if (typeof progressServerProc.kill === "function") {
    try { progressServerProc.kill("SIGTERM"); } catch {}
    return;
  }
  if (progressServerProc.pid) {
    try { processKill(progressServerProc.pid, "SIGTERM"); } catch {}
  }
}

export function createRunnerTimeoutController({
  initialTimeoutMs,
  startTimeMs,
  runResultsTracker,
  state,
  logRun,
  writeProgressSnapshot,
  archiveCurrentRunFile,
  cleanupRuntimeStateFiles,
  execFileSync = defaultExecFileSync,
  killActiveProviderProcesses = defaultKillActiveProviderProcesses,
  log = console.log,
  exit = process.exit,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowMs = Date.now,
} = Object()) {
  let timeoutId = null;
  let timeoutMs = initialTimeoutMs;

  function handleGlobalTimeout() {
    const durH = (timeoutMs / 3600000).toFixed(1);
    log(`[yolo-runner] 全局超时（${durH} 小时）`);
    try {
      // H7: kill provider children on the timeout path too (previously only
      // gracefulShutdown did), or they orphan and outlive the runner.
      killActiveProviderProcesses({ log });
      logRun("run_end", {
        prd: "unknown",
        exit_reason: "timeout",
        duration_sec: ((nowMs() - startTimeMs) / 1000).toFixed(1),
      });
      saveRunnerProgressSnapshot({
        stateDir: state.stateDir(),
        completedIds: runResultsTracker.completed,
        failedIds: runResultsTracker.failed,
        writeProgressSnapshot,
      });
      cleanupActiveGitSession({
        ...state.activeGitSession(),
        rootDir: state.rootDir(),
        execFileSync,
      });
      archiveCurrentRunFile({ currentRunFile: state.currentRunFile(), stateDir: state.stateDir(), interrupted: true });
      cleanupRuntimeStateFiles({ stateDir: state.stateDir() });
      void cleanupProgressServer(state.progressServerProc());
    } catch (_) {}
    exit(2);
  }

  function setGlobalTimeout(ms, options = Object()) {
    if (options.exitOnTimeout === false) {
      if (timeoutId) clearTimeoutFn(timeoutId);
      timeoutId = null;
      return;
    }
    const durH = (ms / 3600000).toFixed(1);
    timeoutMs = ms;
    if (timeoutId) clearTimeoutFn(timeoutId);
    timeoutId = setTimeoutFn(handleGlobalTimeout, ms);
    log(`[yolo-runner] 全局超时: ${durH}h (${Math.round(ms / 60000)}min)`);
  }

  function registerInitialGlobalTimeout() {
    if (timeoutId) return;
    timeoutId = setTimeoutFn(handleGlobalTimeout, timeoutMs);
  }

  return {
    handleGlobalTimeout,
    registerInitialGlobalTimeout,
    setGlobalTimeout,
  };
}

export function createGracefulShutdownHandler({
  progress,
  runResultsTracker,
  state,
  startTimeMs,
  logRun,
  writeProgressSnapshot,
  archiveCurrentRunFile,
  cleanupRuntimeStateFiles,
  execFileSync = defaultExecFileSync,
  killActiveProviderProcesses = defaultKillActiveProviderProcesses,
  log = console.log,
  exit = process.exit,
} = Object()) {
  return async function gracefulShutdown(signal) {
    log(`\n⚠️ 收到 ${signal}，正在清理...`);
    writeRunEndOnCrashEvent({
      reason: signal,
      passed: progress.done,
      failed: progress.failed,
    }, { logRun, startTimeMs });
    saveRunnerProgressSnapshot({
      stateDir: state.stateDir(),
      completedIds: runResultsTracker.completed,
      failedIds: runResultsTracker.failed,
      writeProgressSnapshot,
    });
    archiveCurrentRunFile({ currentRunFile: state.currentRunFile(), stateDir: state.stateDir(), interrupted: true });
    killActiveProviderProcesses({ log });
    cleanupActiveGitSession({
      ...state.activeGitSession(),
      rootDir: state.rootDir(),
      execFileSync,
      log,
    });
    cleanupRuntimeStateFiles({ stateDir: state.stateDir() });
    await cleanupProgressServer(state.progressServerProc());
    log("✅ 清理完成，已记录中断并以失败状态退出");
    exit(130);
  };
}

export function handleRunnerFatalError({
  reason,
  exitReason = "fatal",
  runResultsTracker,
  state,
  startTimeMs,
  logRun,
  writeProgressSnapshot,
  cleanupRuntimeStateFiles,
  execFileSync = defaultExecFileSync,
  killActiveProviderProcesses = defaultKillActiveProviderProcesses,
  error = console.error,
  exit = process.exit,
} = Object()) {
  error("[yolo-runner] 未捕获的异常:", reason);
  try {
    // H7: kill provider children on the fatal path too (previously only
    // gracefulShutdown did), or they orphan and outlive the runner.
    killActiveProviderProcesses({ log: error });
    writeRunEndOnCrashEvent({ reason: exitReason }, { logRun, startTimeMs });
    saveRunnerProgressSnapshot({
      stateDir: state.stateDir(),
      completedIds: runResultsTracker?.completed || [],
      failedIds: runResultsTracker?.failed || [],
      writeProgressSnapshot,
    });
    cleanupActiveGitSession({
      ...state.activeGitSession(),
      rootDir: state.rootDir(),
      execFileSync,
    });
    cleanupRuntimeStateFiles({ stateDir: state.stateDir() });
    void cleanupProgressServer(state.progressServerProc());
  } catch (_) {}
  exit(1);
}
