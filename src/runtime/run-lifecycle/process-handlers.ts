import {
  cleanupActiveGitSession,
  createGracefulShutdownHandler,
  handleRunnerFatalError,
  saveRunnerProgressSnapshot,
  writeRunEndOnCrashEvent,
} from "./shutdown.js";

export function registerRunnerProcessHandlers({
  processLike = process,
  progress,
  runResultsTracker,
  state,
  startTimeMs,
  logRun,
  writeProgressSnapshot,
  archiveCurrentRunFile,
  cleanupRuntimeStateFiles,
  execSync,
} = Object()) {
  const gracefulShutdown = createGracefulShutdownHandler({
    progress,
    runResultsTracker,
    state,
    startTimeMs,
    logRun,
    writeProgressSnapshot,
    archiveCurrentRunFile,
    cleanupRuntimeStateFiles,
    execSync,
  });

  processLike.on("SIGINT", () => gracefulShutdown("SIGINT"));
  processLike.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  processLike.on("unhandledRejection", (reason) => {
    handleRunnerFatalError({
      reason,
      exitReason: "unhandledRejection",
      runResultsTracker,
      state,
      startTimeMs,
      logRun,
      writeProgressSnapshot,
      cleanupRuntimeStateFiles,
      error: (_message, value) => console.error("[yolo-runner] 未捕获的 Promise rejection:", value),
    });
  });
  processLike.on("uncaughtException", (err) => {
    handleRunnerFatalError({
      reason: err,
      exitReason: "uncaughtException",
      runResultsTracker,
      state,
      startTimeMs,
      logRun,
      writeProgressSnapshot,
      cleanupRuntimeStateFiles,
      error: (_message, value) => console.error("[yolo-runner] 未捕获的异常:", value),
    });
  });
  return { gracefulShutdown };
}

export function handleRunCliFailure({
  error,
  progress,
  runResultsTracker,
  state,
  startTimeMs,
  logRun,
  writeProgressSnapshot,
  archiveCurrentRunFile,
  cleanupRuntimeStateFiles,
  execSync,
  logError = console.error,
  exit = process.exit,
} = Object()) {
  logError("[yolo-runner] run() 顶层异常:", error);
  try {
    writeRunEndOnCrashEvent({
      reason: "run_catch",
      passed: progress.done,
      failed: progress.failed,
    }, { logRun, startTimeMs });
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
  exit(1);
}
