import { runRetryPhase } from "../recovery/retry-orchestrator.js";
import { runReviewLoop } from "../review-loop/orchestrator.js";
import { finalizeRun } from "./finalize.js";
import { cleanupProgressServer } from "./shutdown.js";

function appendUniqueDefault(target, items = []) {
  const seen = new Set(target);
  for (const item of items) {
    if (!seen.has(item)) {
      target.push(item);
      seen.add(item);
    }
  }
}

function noop() {}

function errorExitCode(error) {
  const exitCode = Number(error?.exitCode ?? error?.exit_code);
  return Number.isInteger(exitCode) && exitCode > 0 ? exitCode : 1;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

export async function shutdownRunAfterPhaseError({
  error,
  runId,
  prdPath,
  exitOnComplete,
  progressServerProc,
  setGlobalTimeout = noop,
  logRun = noop,
  writeStateSnapshot = noop,
  processExit = process.exit,
  processKill = process.kill,
} = Object()) {
  const exitCode = errorExitCode(error);
  try { setGlobalTimeout(0, { exitOnTimeout: false }); } catch (_) {}
  try {
    logRun("run_error", {
      run_id: runId,
      prd: prdPath || "auto",
      error: errorMessage(error),
      exit_code: exitCode,
    });
  } catch (_) {}
  try { writeStateSnapshot("run_error", prdPath); } catch (_) {}
  await cleanupProgressServer(progressServerProc, { processKill });
  if (exitOnComplete) {
    processExit(exitCode);
    return {
      status: "error",
      summary: `runner failed closed: ${errorMessage(error)}`,
      exit_code: exitCode,
      error: errorMessage(error),
    };
  }
  throw error;
}

export function estimateRunTimeoutMs({ taskCount = 0, sessionTimeoutHours = 4 } = Object()) {
  const estimatedMinutes = taskCount * 8 * 1.5;
  return Math.max(sessionTimeoutHours * 3600000, Math.round(estimatedMinutes * 60000));
}

export function appendBlockedTaskFailures({ taskResults, appendUnique = appendUniqueDefault } = Object()) {
  appendUnique(
    taskResults.failed,
    (taskResults.blocked || []).filter((id) => !(taskResults.contractReview || []).includes(id)),
  );
  return taskResults;
}

export function shouldHaltPostMainAutomation(taskResults = Object()) {
  return taskResults.stop_reason === "repeated_failure_fuse";
}

export async function runTaskPipeline({
  prdPath,
  runId,
  resumeCompleted = new Set(),
  exitOnComplete = true,
  sessionTimeoutHours = 4,
  runReviewLoop: runReviewLoopOption,
  reviewLoopEnabled = runReviewLoopOption ?? true,
  maxReviewRounds = 5,
  maxReviewTasksPerRound = 5,
  projectRoot,
  stateRoot,
  toolsRoot,
  stateDir,
  runtimeDir,
  expandedTasksFile,
  progress,
  startTimeMs,
  progressServerProc,
  loadPRD,
  mainLoop,
  taskPostconditionsPass,
  updateTaskStatus,
  appendUnique = appendUniqueDefault,
  normalizeRepoPath = (value) => value,
  setGlobalTimeout = noop,
  logRun = noop,
  logProgress = noop,
  writeStateSnapshot = noop,
  writeRunReport,
  archiveCurrentRun,
  execFileSync,
  processExecPath = process.execPath,
  processExit = process.exit,
  processKill = process.kill,
  logReviewStart = noop,
  logReviewGate = noop,
  logReviewIssue = noop,
  logReviewDone = noop,
  logReviewError = noop,
  retryPhase = runRetryPhase,
  reviewLoop = runReviewLoop,
  finalize = finalizeRun,
} = Object()) {
  if (!progress) throw new Error("runTaskPipeline requires progress");
  if (typeof loadPRD !== "function") throw new Error("runTaskPipeline requires loadPRD");
  if (typeof mainLoop !== "function") throw new Error("runTaskPipeline requires mainLoop");

  try {
    const prd = loadPRD(prdPath);

    if (resumeCompleted.size > 0) {
      logProgress("RESUME", "", `${resumeCompleted.size} 个任务已在当前 PRD 中完成，跳过`);
    }
    const taskCount = (prd.tasks || []).length;
    progress.total = taskCount;
    const timeoutMs = estimateRunTimeoutMs({ taskCount, sessionTimeoutHours });
    setGlobalTimeout(timeoutMs, { exitOnTimeout: exitOnComplete });
    logRun("run_start", { run_id: runId, prd: prdPath || "auto", tasks: taskCount });
    writeStateSnapshot("run_start", prdPath);

    const taskResults = await mainLoop(prdPath, resumeCompleted);
    appendBlockedTaskFailures({ taskResults, appendUnique });
    const haltPostMainAutomation = shouldHaltPostMainAutomation(taskResults);

    if (haltPostMainAutomation) {
      logProgress("RETRY", "SKIP", "全局熔断已触发，跳过自动重试和 review loop");
    } else {
      await retryPhase({
        prd,
        prdPath,
        taskResults,
        resumeCompleted,
        runId,
        yoloRoot: stateRoot,
        expandedTasksFile,
        progress,
        mainLoop,
        taskPostconditionsPass,
        updateTaskStatus,
        appendUnique,
        normalizeRepoPath,
        maxRetryRounds: 3,
        logProgress,
      });
    }

    if (!haltPostMainAutomation && reviewLoopEnabled !== false) {
      await reviewLoop({
        prd,
        prdPath,
        taskResults,
        resumeCompleted,
        runId,
        yoloRoot: toolsRoot,
        rootDir: projectRoot,
        progress,
        mainLoop,
        loadPRD,
        appendUnique,
        normalizeRepoPath,
        maxReviewRounds,
        maxReviewTasksPerRound,
        execFileSync,
        processExecPath,
        logProgress,
        logReviewStart,
        logReviewGate,
        logReviewIssue,
        logReviewDone,
        logReviewError,
      });
    }

    setGlobalTimeout(0, { exitOnTimeout: false });
    return await finalize({
      runId,
      prdPath,
      taskResults,
      progressTotal: progress.total,
      startTimeMs,
      projectRoot,
      stateDir,
      runtimeDir,
      yoloRoot: stateRoot,
      toolsRoot,
      exitOnComplete,
      writeRunReport,
      logRun,
      logProgress,
      writeStateSnapshot,
      archiveCurrentRun,
      normalizeRepoPath,
      progressServerProc,
      processExit,
      processKill,
    });
  } catch (error) {
    return await shutdownRunAfterPhaseError({
      error,
      runId,
      prdPath,
      exitOnComplete,
      progressServerProc,
      setGlobalTimeout,
      logRun,
      writeStateSnapshot,
      processExit,
      processKill,
    });
  }
}
