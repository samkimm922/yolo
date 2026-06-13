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
  execSync,
  log = (..._args) => {},
} = Object()) {
  if (activeWorktree) {
    try {
      log(`  清理 worktree: ${activeWorktree}`);
      execSync(`git worktree remove --force "${activeWorktree}" 2>/dev/null`, { cwd: rootDir });
    } catch {}
  }
  if (activeBranch) {
    try {
      log(`  清理分支: ${activeBranch}`);
      execSync(`git branch -D "${activeBranch}" 2>/dev/null`, { cwd: rootDir });
    } catch {}
  }
}

export function cleanupProgressServer(progressServerProc) {
  if (progressServerProc?.pid) {
    try { process.kill(progressServerProc.pid, "SIGTERM"); } catch {}
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
  execSync,
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
        execSync,
      });
      archiveCurrentRunFile({ currentRunFile: state.currentRunFile(), stateDir: state.stateDir(), interrupted: true });
      cleanupRuntimeStateFiles({ stateDir: state.stateDir() });
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
  execSync,
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
    cleanupActiveGitSession({
      ...state.activeGitSession(),
      rootDir: state.rootDir(),
      execSync,
      log,
    });
    cleanupRuntimeStateFiles({ stateDir: state.stateDir() });
    cleanupProgressServer(state.progressServerProc());
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
  error = console.error,
  exit = process.exit,
} = Object()) {
  error("[yolo-runner] 未捕获的异常:", reason);
  try {
    writeRunEndOnCrashEvent({ reason: exitReason }, { logRun, startTimeMs });
    saveRunnerProgressSnapshot({
      stateDir: state.stateDir(),
      completedIds: runResultsTracker?.completed || [],
      failedIds: runResultsTracker?.failed || [],
      writeProgressSnapshot,
    });
    cleanupRuntimeStateFiles({ stateDir: state.stateDir() });
  } catch (_) {}
  exit(1);
}
