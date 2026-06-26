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

type LogFn = (...args: unknown[]) => void;

function noop(): void {}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

interface MainLoopResults extends Record<string, unknown> {
  completed: string[];
  failed: string[];
  blocked: string[];
  contractReview: string[];
  remediation: unknown[];
  immediateRemediationQueue: unknown[];
  preflight: { status?: string; blocks_execution?: boolean; blockers?: Record<string, unknown>[] } | null;
  blockers: Record<string, unknown>[];
  stop_reason: string | null;
  stop_fail_key: string | null;
}

export async function runMainLoopWithRuntime({
  prdPath,
  preCompleted = new Set<string>(),
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
}: {
  prdPath: string;
  preCompleted?: Set<unknown>;
  mode: string;
  rootDir: string;
  yoloRoot: string;
  expandedTasksFile: string;
  progress: { total: number; done: number; failed: number; [key: string]: unknown };
  runResultsTracker: { completed: Set<unknown>; failed: unknown[] };
  priorityOrder: Record<string, number>;
  loadPRD: (prdPath: string) => unknown;
  runTask: (task: Record<string, unknown>, prdPath: string, options: { relayText: string }) => Promise<unknown>;
  updateTaskStatus: (id: string, update: Record<string, unknown>) => void;
  recordTaskTransition: (transition: unknown) => void;
  taskCountsAsCompleted: (task: Record<string, unknown> | undefined) => boolean;
  taskIsSplitParent: (task: Record<string, unknown>) => boolean;
  skippedTaskPostconditionsPass: (task: unknown, prd: unknown) => { passed: boolean; failed: string[] };
  log?: LogFn;
  writeRelayArtifact?: ((relayText: string, summaries: unknown[]) => void) | null;
} = Object() as never): Promise<MainLoopResults> {
  const prd = asRecord(loadPRD(prdPath));
  const results: MainLoopResults = {
    completed: [],
    failed: [],
    skipped: [],
    blocked: [],
    contractReview: [],
    remediation: [],
    immediateRemediationQueue: [],
    preflight: null,
    blockers: [],
    stop_reason: null,
    stop_fail_key: null,
  };
  const completedIds = new Set<string>([...preCompleted].map((id) => String(id)));
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

  progress.total = expanded.filter((task) => asRecord(task).status !== "completed").length;

  writeExpandedTasksSnapshot({
    filePath: expandedTasksFile,
    source: prdPath,
    tasks: expanded,
    completedIds,
  });

  if (preflight?.blocks_execution) {
    results.preflight = preflight;
    results.blockers = asArray<unknown>(preflight.blockers).map((b) => asRecord(b));
    for (const blocker of asArray<unknown>(preflight.blockers)) {
      const blockerRec = asRecord(blocker);
      const taskIds = asArray<unknown>(blockerRec.task_ids);
      const ids = taskIds.length > 0
        ? taskIds.map(String)
        : (blockerRec.task_id ? [asString(blockerRec.task_id)] : []);
      appendUniqueTaskIds(results.blocked, ids);
      log("preflight", "blocked", `${asString(blockerRec.code)}: ${asString(blockerRec.message)}`);
    }
    return results;
  }

  const childTaskMap = buildChildTaskMap(expanded);

  const completedTaskSummaries: ReturnType<typeof buildTaskSummary>[] = [];
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
      updateMergedSourceTasks: (item: Record<string, unknown>, update: Record<string, unknown>) => updateMergedSourceTasks({
        task: item,
        update,
        updateTaskStatus,
      }),
      markParentCompleteIfAllChildrenDone: (
        item: Record<string, unknown>,
        map: unknown,
        ids: Set<string>,
      ) => completeParentIfAllChildrenDone({
        task: item,
        childMap: map as Map<string, Set<string>>,
        completedIds: ids,
        updateTaskStatus,
        log,
      }),
      markParentBlockedByChildFailure: (
        item: Record<string, unknown>,
        map: unknown,
        reason: string,
      ) => blockParentForChildFailure({
        task: item,
        childMap: map as Map<string, Set<string>>,
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
      taskId: asString(asRecord(task).id),
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
