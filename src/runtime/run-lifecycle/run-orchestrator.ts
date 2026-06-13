import { runRetryPhase } from "../recovery/retry-orchestrator.js";
import { runReviewLoop } from "../review-loop/orchestrator.js";
import { finalizeRun } from "./finalize.js";

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

export async function runTaskPipeline({
  prdPath,
  runId,
  resumeCompleted = new Set(),
  exitOnComplete = true,
  sessionTimeoutHours = 4,
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

  return finalize({
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
  });
}
