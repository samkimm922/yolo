import {
  blockParentForChildFailure,
  buildChildTaskMap,
  completeParentIfAllChildrenDone,
  updateMergedSourceTasks,
} from "./status-helpers.js";
import {
  handleTaskOutcome,
  handleTaskPreRun,
} from "./outcome-handler.js";
import {
  runLessonsAnalyzer,
  updateExpandedTaskSnapshot,
  writeExpandedTasksSnapshot,
} from "./side-effects.js";
import { expandTasksForMainLoop } from "./expansion.js";

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
} = {}) {
  const prd = loadPRD(prdPath);
  const results = { completed: [], failed: [], skipped: [], blocked: [], contractReview: [], remediation: [] };
  const completedIds = new Set(preCompleted);
  const { expanded, beforeMerge, mergedCount } = expandTasksForMainLoop({
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
  const childTaskMap = buildChildTaskMap(expanded);

  progress.total = expanded.filter((task) => task.status !== "completed").length;

  writeExpandedTasksSnapshot({
    filePath: expandedTasksFile,
    source: prdPath,
    tasks: expanded,
    completedIds,
  });

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

    const outcome = await runTask(task, prdPath);
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
    });
    lastFailKey = outcomeResult.lastFailKey;
    if (outcomeResult.action === "stop") {
      return results;
    }

    updateExpandedTaskSnapshot({
      filePath: expandedTasksFile,
      taskId: task.id,
      outcome,
    });

    runLessonsAnalyzer({ yoloRoot });
  }
  return results;
}
