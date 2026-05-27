import {
  buildRetryCompletedSet,
  buildRetryPrd,
  cleanupRetryPrdFile,
  loadExpandedTasksForRetryFile,
  mergeRetryRoundResults,
  prepareRetryTasks,
  syncRetryCompletions,
  writeRetryPrdFile,
} from "./retry-round.js";

function noop() {}

function appendUniqueDefault(target, items = []) {
  const seen = new Set(target);
  for (const item of items) {
    if (!seen.has(item)) {
      target.push(item);
      seen.add(item);
    }
  }
}

export async function runRetryPhase({
  prd,
  prdPath,
  taskResults,
  resumeCompleted = new Set(),
  runId,
  yoloRoot,
  expandedTasksFile,
  progress,
  mainLoop,
  taskPostconditionsPass,
  updateTaskStatus,
  appendUnique = appendUniqueDefault,
  normalizeRepoPath = (value) => value,
  maxRetryRounds = 3,
  logProgress = noop,
} = {}) {
  if (!taskResults) throw new Error("runRetryPhase requires taskResults");
  if (!progress) throw new Error("runRetryPhase requires progress");

  for (let round = 1; round <= maxRetryRounds && taskResults.failed.length > 0; round++) {
    const ids = [...taskResults.failed];
    logProgress("RETRY", `=== 第 ${round} 轮`, `${ids.length} 个失败任务`);
    const expandedRetryTasks = loadExpandedTasksForRetryFile(expandedTasksFile);
    const { retryTasks, missingRetryTaskIds } = prepareRetryTasks({
      failedIds: ids,
      prd,
      expandedTasks: expandedRetryTasks,
    });

    if (missingRetryTaskIds.length > 0) {
      appendUnique(taskResults.failed, missingRetryTaskIds);
      logProgress("RETRY", "BLOCKED", `找不到失败任务定义，保留 failed: ${missingRetryTaskIds.join(", ")}`);
    }

    if (retryTasks.length === 0) {
      logProgress("RETRY", "STOP", "没有可重试任务，保留 failed 状态");
      break;
    }

    if (typeof mainLoop !== "function") throw new Error("runRetryPhase requires mainLoop");
    if (typeof taskPostconditionsPass !== "function") throw new Error("runRetryPhase requires taskPostconditionsPass");
    if (typeof updateTaskStatus !== "function") throw new Error("runRetryPhase requires updateTaskStatus");

    const retryPrd = buildRetryPrd({
      prd,
      prdPath,
      retryTasks,
      round,
      parentRunId: runId,
      normalizePrdPath: normalizeRepoPath,
    });
    const retryPrdPath = writeRetryPrdFile({ yoloRoot, retryPrd, round });
    const previousDone = progress.done;
    progress.total = retryPrd.tasks.length;
    progress.done = 0;
    progress.failed = 0;
    const retryCompleted = buildRetryCompletedSet({
      resumeCompleted,
      completed: taskResults.completed,
      skipped: taskResults.skipped,
    });
    const retryResults = await mainLoop(retryPrdPath, retryCompleted);
    syncRetryCompletions({
      retryResults,
      prd,
      taskResults,
      taskPostconditionsPass,
      updateTaskStatus,
      log: (id, phase, detail) => logProgress(id, phase, detail),
    });
    mergeRetryRoundResults({ taskResults, retryResults });
    progress.done = previousDone + progress.done;
    cleanupRetryPrdFile(retryPrdPath);
    if (!retryResults.failed.length) break;
  }

  return taskResults;
}
