import {
  blockParentForChildFailure,
  buildChildTaskMap,
  completeParentIfAllChildrenDone,
  updateMergedSourceTasks,
} from "./status-helpers.js";
import {
  appendUniqueTaskIds,
  handleTaskOutcome,
  handleTaskPreRun,
} from "./outcome-handler.js";
import {
  runLessonsAnalyzer,
  updateExpandedTaskSnapshot,
  writeExpandedTasksSnapshot,
} from "./side-effects.js";
import { expandTasksForMainLoop } from "./expansion.js";
import { buildTaskSummary } from "../execution/task-summary.js";
import { buildRelayInjection } from "../execution/summary-relay.js";

function noop() {}

export async function runMainLoopWithRuntime({
  prdPath,
  preCompleted = new Set(),
  mode,
  rootDir,
  yoloRoot,
  expandedTasksFile,
  progress,
  runResultsTracker,
  priorityOrder,
  loadPRD,
  runTask,
  updateTaskStatus,
  recordTaskTransition,
  taskCountsAsCompleted,
  taskIsSplitParent,
  skippedTaskPostconditionsPass,
  log = noop,
  writeRelayArtifact = null,
} = Object()) {
  const prd = loadPRD(prdPath);
  const results = { completed: [], failed: [], skipped: [], blocked: [], contractReview: [], remediation: [], immediateRemediationQueue: [], preflight: null, blockers: [], stop_reason: null, stop_fail_key: null };
  const completedIds = new Set(preCompleted);
  const { expanded, beforeMerge, mergedCount, preflight } = expandTasksForMainLoop({
    tasks: prd.tasks || [],
    completedIds,
    priorityOrder,
    mode,
    rootDir,
    taskCountsAsCompleted,
    taskIsSplitParent,
    log,
  });
  if (mergedCount < beforeMerge) {
    log("合并器", "", `合并前 ${beforeMerge} 个任务 → 合并后 ${mergedCount} 个`);
  }

  progress.total = expanded.filter((task) => task.status !== "completed").length;

  writeExpandedTasksSnapshot({
    filePath: expandedTasksFile,
    source: prdPath,
    tasks: expanded,
    completedIds,
  });

  if (preflight?.blocks_execution) {
    results.preflight = preflight;
    results.blockers = preflight.blockers || [];
    for (const blocker of preflight.blockers || []) {
      appendUniqueTaskIds(results.blocked, blocker.task_ids || (blocker.task_id ? [blocker.task_id] : []));
      log("preflight", "blocked", `${blocker.code}: ${blocker.message}`);
    }
    return results;
  }

  const childTaskMap = buildChildTaskMap(expanded);

  const completedTaskSummaries = [];
  let relayText = "";

  let lastFailKey = "";
  for (const task of expanded) {
    const preRun = handleTaskPreRun({
      task,
      tasks: expanded,
      results,
      completedIds,
      taskIsSplitParent,
      taskCountsAsCompleted,
      recordTaskTransition,
      log,
    });
    if (preRun.action !== "run") {
      continue;
    }

    // P2.18: inject relay from prior tasks into the current task run
    const outcome = await runTask(task, prdPath, { relayText });
    const outcomeResult = handleTaskOutcome({
      task,
      outcome,
      results,
      runResultsTracker,
      progress,
      completedIds,
      childTaskMap,
      lastFailKey,
      loadPrd: () => loadPRD(prdPath),
      skippedTaskPostconditionsPass,
      updateMergedSourceTasks: (item, update) => updateMergedSourceTasks({
        task: item,
        update,
        updateTaskStatus,
      }),
      markParentCompleteIfAllChildrenDone: (item, map, ids) => completeParentIfAllChildrenDone({
        task: item,
        childMap: map,
        completedIds: ids,
        updateTaskStatus,
        log,
      }),
      markParentBlockedByChildFailure: (item, map, reason) => blockParentForChildFailure({
        task: item,
        childMap: map,
        reason,
        updateTaskStatus,
        log,
      }),
      recordTaskTransition,
      log,
      stopForImmediateRemediation: true,
    });
    lastFailKey = outcomeResult.lastFailKey;

    // P2.18: write task-summary with Forward Intelligence after each task
    const summary = buildTaskSummary({
      task,
      outcome,
      projectRoot: rootDir,
    });
    completedTaskSummaries.push(summary);
    relayText = buildRelayInjection(completedTaskSummaries, { maxTokens: 2500 });

    if (outcomeResult.action === "stop") {
      results.stop_reason = outcomeResult.reason || "stopped";
      results.stop_fail_key = outcomeResult.lastFailKey || null;
      if (writeRelayArtifact && completedTaskSummaries.length) {
        writeRelayArtifact(relayText, completedTaskSummaries);
      }
      return results;
    }

    updateExpandedTaskSnapshot({
      filePath: expandedTasksFile,
      taskId: task.id,
      outcome,
    });

    runLessonsAnalyzer({ yoloRoot });
  }

  // P2.18: write final relay artifact for batch rollup
  if (writeRelayArtifact && completedTaskSummaries.length) {
    writeRelayArtifact(relayText, completedTaskSummaries);
  }

  return results;
}
