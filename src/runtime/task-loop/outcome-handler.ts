import { blockedTaskTransition, failTaskTransition } from "../task-state/transitions.js";
import { dependencyBlockers } from "./status-helpers.js";

type LogFn = (...args: unknown[]) => void;

const IMMEDIATE_REMEDIATION_ACTIONS = new Set([
  "AUTO_REMEDIATE",
  "RETRY_WITH_CONTEXT",
  "REROUTE_REVIEW_FIX",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

// Permissive shape: callers may pass strict interfaces (LoopResults in tests)
// or open-ended records (MainLoopResults). Only fields whose call sites need to
// match canonical source patterns (results.blocked / results.failed) are
// declared explicitly; the rest flow through bagList narrowing via object cast.
interface ResultsBag {
  blocked: unknown[];
  failed: unknown[];
}

function bagList(bag: object, key: string): unknown[] {
  const rec = bag as Record<string, unknown>;
  if (!Array.isArray(rec[key])) rec[key] = [];
  return rec[key] as unknown[];
}

interface RunResultsTracker {
  completed: Set<unknown>;
  failed: unknown[];
}

interface ProgressTracker {
  done: number;
  failed: number;
  [key: string]: unknown;
}

export function appendUniqueTaskIds(target: unknown[], items: unknown = []): void {
  const seen = new Set(target);
  for (const item of asArray<unknown>(items)) {
    if (!seen.has(item)) {
      target.push(item);
      seen.add(item);
    }
  }
}

export function handleTaskPreRun({
  task,
  tasks,
  results,
  completedIds,
  taskIsSplitParent,
  taskCountsAsCompleted,
  recordTaskTransition,
  log = (..._args: unknown[]) => {},
  now = new Date().toISOString(),
}: {
  task: unknown;
  tasks: unknown;
  results: ResultsBag;
  completedIds: Set<string>;
  taskIsSplitParent: (task: Record<string, unknown>) => boolean;
  taskCountsAsCompleted: (task: Record<string, unknown> | undefined) => boolean;
  recordTaskTransition: (transition: unknown) => void;
  log?: LogFn;
  now?: string;
}) {
  const taskRec = asRecord(task);
  const taskId = asString(taskRec.id);
  if (completedIds.has(taskId)) {
    bagList(results, "skipped").push(taskId);
    return { action: "skip" as const, reason: "already_completed" };
  }

  if (taskIsSplitParent(taskRec)) {
    bagList(results, "skipped").push(taskId);
    log(taskId, "--", "跳过 split parent，等待子任务执行");
    return { action: "skip" as const, reason: "split_parent" };
  }

  const deps = dependencyBlockers({
    task,
    completedIds,
    tasks,
    taskCountsAsCompleted,
  });

  if (deps.length) {
    bagList(results, "blocked"); // ensure exists
    results.blocked.push(taskId);
    recordTaskTransition(blockedTaskTransition({
      taskId,
      reason: "dependency_blocked",
      result: {
        skip_kind: "dependency_blocked",
        blocked_by: deps,
        counts_as_completed: false,
      },
      prdUpdate: {
        skip_kind: "dependency_blocked",
        counts_as_completed: false,
        blocked_by: deps,
        phase: "blocked",
        phaseDetail: `dependency_blocked: ${deps.join(", ")}`,
        failReason: `dependency_blocked: ${deps.join(", ")}`,
        updatedAt: now,
      },
      now,
    }));
    log(taskId, "--", `跳过: 依赖 ${deps} 未完成`);
    return { action: "skip" as const, reason: "dependency_blocked", deps };
  }

  return { action: "run" as const };
}

export function handleTaskOutcome({
  task,
  outcome,
  results,
  runResultsTracker,
  progress,
  completedIds,
  childTaskMap,
  lastFailKey = "",
  loadPrd,
  skippedTaskPostconditionsPass,
  updateMergedSourceTasks,
  markParentCompleteIfAllChildrenDone,
  markParentBlockedByChildFailure,
  recordTaskTransition,
  log = (..._args: unknown[]) => {},
  stopForImmediateRemediation = false,
  now = new Date().toISOString(),
}: {
  task: unknown;
  outcome: unknown;
  results: ResultsBag;
  runResultsTracker: RunResultsTracker;
  progress: ProgressTracker;
  completedIds: Set<string>;
  childTaskMap: unknown;
  lastFailKey?: string;
  loadPrd: () => unknown;
  skippedTaskPostconditionsPass: (
    task: unknown,
    prd: unknown,
  ) => { passed: boolean; failed: string[] };
  updateMergedSourceTasks: (task: Record<string, unknown>, update: Record<string, unknown>) => string[];
  markParentCompleteIfAllChildrenDone: (
    task: Record<string, unknown>,
    childTaskMap: unknown,
    completedIds: Set<string>,
  ) => boolean;
  markParentBlockedByChildFailure: (
    task: Record<string, unknown>,
    childTaskMap: unknown,
    reason: string,
  ) => boolean;
  recordTaskTransition: (transition: unknown) => void;
  log?: LogFn;
  stopForImmediateRemediation?: boolean;
  now?: string;
}) {
  const taskRec = asRecord(task);
  const taskId = asString(taskRec.id);
  const r = asRecord(outcome);
  let immediateRemediationRequired = false;
  const remediation = asRecord(r.remediation);
  if (r.remediation) {
    const remediationRecord = {
      task_id: taskId,
      ...remediation,
    };
    bagList(results, "remediation").push(remediationRecord);
    if (
      remediation.automation_can_continue === true &&
      remediation.blocks_ship !== false &&
      typeof remediation.action === "string" &&
      IMMEDIATE_REMEDIATION_ACTIONS.has(remediation.action)
    ) {
      immediateRemediationRequired = true;
      bagList(results, "immediateRemediationQueue").push({
        source_task_id: taskId,
        routing: "before_next_feature_task",
        reason: "harness_remediation_must_be_cleared_before_new_work",
        action: remediation.action,
        status: remediation.status,
        next_actions: asArray<unknown>(remediation.next_actions),
      });
    }
  }

  if (r.status === "completed") {
    completedIds.add(taskId);
    const sourceIds = updateMergedSourceTasks(taskRec, {
      status: "merged_into",
      counts_as_completed: true,
      phase: "done",
      phaseDetail: `merged task completed: ${taskId}`,
    });
    for (const sourceId of sourceIds) completedIds.add(sourceId);
    markParentCompleteIfAllChildrenDone(taskRec, childTaskMap, completedIds);
    const completedList = bagList(results, "completed");
    completedList.push(taskId);
    appendUniqueTaskIds(completedList, sourceIds);
    runResultsTracker.completed.add(taskId);
    for (const sourceId of sourceIds) runResultsTracker.completed.add(sourceId);
    progress.done++;
    return { action: "continue", lastFailKey: "" };
  }

  if (r.status === "skipped" && r.counts_as_completed === true) {
    const prdForSkipCheck = asRecord(loadPrd());
    // Skip-path sibling of #104: tolerate null/non-object entries in prd.tasks
    // (manual edits, migration residue, retry from corrupt state). Without this
    // guard, `.find` reads `.id` on null and throws, crashing the main loop on a
    // PRD whose only invalid sibling is a legitimately parseable JSON value.
    const latestTask = asArray<unknown>(prdForSkipCheck.tasks)
      .find((item) => {
        const itemRec = asRecord(item);
        return item && typeof item === "object" && itemRec.id === taskId;
      }) || task;
    const post = skippedTaskPostconditionsPass(latestTask, prdForSkipCheck);
    if (!post.passed) {
      const reason = `invalid_skip_postconditions_failed: ${post.failed.join("; ")}`;
      recordTaskTransition(failTaskTransition({
        taskId,
        reason,
        result: { skip_kind: r.skip_kind },
        prdUpdate: {
          phase: "postcondition",
          counts_as_completed: false,
        },
        now,
      }));
      markParentBlockedByChildFailure(taskRec, childTaskMap, reason);
      bagList(results, "failed").push(taskId);
      runResultsTracker.failed.push(taskId);
      progress.failed++;
      log(taskId, "FAIL", reason);
      return { action: "continue", lastFailKey };
    }

    completedIds.add(taskId);
    const sourceIds = updateMergedSourceTasks(taskRec, {
      status: "merged_into",
      skip_kind: r.skip_kind || "valid_skip_already_satisfied",
      counts_as_completed: true,
      phase: "done",
      phaseDetail: `merged task skipped: ${taskId}`,
    });
    for (const sourceId of sourceIds) completedIds.add(sourceId);
    markParentCompleteIfAllChildrenDone(taskRec, childTaskMap, completedIds);
    bagList(results, "skipped").push(taskId);
    appendUniqueTaskIds(bagList(results, "skipped"), sourceIds);
    log(taskId, "--", `跳过: ${asString(r.reason)}`);
    return { action: "continue", lastFailKey };
  }

  if (r.status === "blocked") {
    const sourceIds = updateMergedSourceTasks(taskRec, {
      status: "blocked",
      skip_kind: "blocked_skip_missing_evidence",
      counts_as_completed: false,
      phase: "blocked",
      phaseDetail: asString(r.reason) || "blocked",
      failReason: asString(r.reason) || "blocked",
    });
    results.blocked.push(taskId);
    appendUniqueTaskIds(results.blocked, sourceIds);
    if (r.reason === "contract_suspect") {
      bagList(results, "contractReview").push(taskId);
    } else {
      runResultsTracker.failed.push(taskId);
      appendUniqueTaskIds(runResultsTracker.failed, sourceIds);
    }
    progress.failed++;
    log(taskId, "BLOCKED", asString(r.reason) || "blocked");
    if (stopForImmediateRemediation && immediateRemediationRequired) {
      return { action: "stop", reason: "immediate_remediation_required", lastFailKey };
    }
    return { action: "continue", lastFailKey };
  }

  const failKey = `${asString(r.status)}:${asString(r.reason).slice(0, 60)}`;
  // P9.M2: persist the terminal failure to the PRD so task.status agrees with the run report.
  // "failed" is not stale-reset on resume (only "running" is), leaving retry/circuit-breaker intact.
  recordTaskTransition(failTaskTransition({
    taskId,
    reason: asString(r.reason) || asString(r.status),
    prdUpdate: {
      phase: "failed",
      counts_as_completed: false,
    },
    now,
  }));
  if (lastFailKey && failKey === lastFailKey) {
    log("!!", "全局熔断", `连续 2 个 task 同因失败: ${failKey} — 疑似引擎 bug，全部停机`);
    results.failed.push(taskId);
    runResultsTracker.failed.push(taskId);
    markParentBlockedByChildFailure(taskRec, childTaskMap, asString(r.reason) || asString(r.status));
    return { action: "stop", reason: "repeated_failure_fuse", lastFailKey: failKey };
  }

  markParentBlockedByChildFailure(taskRec, childTaskMap, asString(r.reason) || asString(r.status));
  const sourceIds = updateMergedSourceTasks(taskRec, {
    status: "failed",
    counts_as_completed: false,
    phase: "failed",
    phaseDetail: asString(r.reason) || asString(r.status),
    failReason: asString(r.reason) || asString(r.status),
  });
  results.failed.push(taskId);
  appendUniqueTaskIds(results.failed, sourceIds);
  progress.failed++;
  if (stopForImmediateRemediation && immediateRemediationRequired) {
    return { action: "stop", reason: "immediate_remediation_required", lastFailKey: failKey };
  }
  return { action: "continue", lastFailKey: failKey };
}
