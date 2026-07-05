import { blockedTaskTransition, failTaskTransition } from "../task-state/transitions.js";
import {
  circuitBreakerThreshold as configuredCircuitBreakerThreshold,
  hasRepeatedFailure,
} from "../recovery/retry-policy.js";
import { dependencyBlockers } from "./status-helpers.js";

const IMMEDIATE_REMEDIATION_ACTIONS = new Set([
  "AUTO_REMEDIATE",
  "RETRY_WITH_CONTEXT",
  "REROUTE_REVIEW_FIX",
]);

export function appendUniqueTaskIds(target, items = []) {
  const seen = new Set(target);
  for (const item of items) {
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
  log = (..._args) => {},
  now = new Date().toISOString(),
}) {
  if (completedIds.has(task.id)) {
    results.skipped.push(task.id);
    return { action: "skip", reason: "already_completed" };
  }

  if (taskIsSplitParent(task)) {
    results.skipped.push(task.id);
    log(task.id, "--", "跳过 split parent，等待子任务执行");
    return { action: "skip", reason: "split_parent" };
  }

  const deps = dependencyBlockers({
    task,
    completedIds,
    tasks,
    taskCountsAsCompleted,
  });

  if (deps.length) {
    results.blocked.push(task.id);
    recordTaskTransition(blockedTaskTransition({
      taskId: task.id,
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
    log(task.id, "--", `跳过: 依赖 ${deps} 未完成`);
    return { action: "skip", reason: "dependency_blocked", deps };
  }

  return { action: "run" };
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
  failureHistory = null,
  circuitBreakerThreshold: repeatedFailureThreshold = configuredCircuitBreakerThreshold(),
  loadPrd,
  skippedTaskPostconditionsPass,
  updateMergedSourceTasks,
  markParentCompleteIfAllChildrenDone,
  markParentBlockedByChildFailure,
  recordTaskTransition,
  log = (..._args) => {},
  stopForImmediateRemediation = false,
  now = new Date().toISOString(),
}) {
  const r = outcome;
  const tracksFailureHistory = Array.isArray(failureHistory);
  const withFailureHistory = (result, nextHistory = failureHistory) =>
    tracksFailureHistory ? { ...result, failureHistory: nextHistory } : result;
  let immediateRemediationRequired = false;
  if (r?.remediation) {
    if (!Array.isArray(results.remediation)) results.remediation = [];
    const remediationRecord = {
      task_id: task.id,
      ...r.remediation,
    };
    results.remediation.push(remediationRecord);
    if (
      r.remediation.automation_can_continue === true &&
      r.remediation.blocks_ship !== false &&
      IMMEDIATE_REMEDIATION_ACTIONS.has(r.remediation.action)
    ) {
      immediateRemediationRequired = true;
      if (!Array.isArray(results.immediateRemediationQueue)) results.immediateRemediationQueue = [];
      results.immediateRemediationQueue.push({
        source_task_id: task.id,
        routing: "before_next_feature_task",
        reason: "harness_remediation_must_be_cleared_before_new_work",
        action: r.remediation.action,
        status: r.remediation.status,
        next_actions: r.remediation.next_actions || [],
      });
    }
  }

  if (r.status === "completed") {
    completedIds.add(task.id);
    const sourceIds = updateMergedSourceTasks(task, {
      status: "merged_into",
      counts_as_completed: true,
      phase: "done",
      phaseDetail: `merged task completed: ${task.id}`,
    });
    for (const sourceId of sourceIds) completedIds.add(sourceId);
    markParentCompleteIfAllChildrenDone(task, childTaskMap, completedIds);
    results.completed.push(task.id);
    appendUniqueTaskIds(results.completed, sourceIds);
    runResultsTracker.completed.add(task.id);
    for (const sourceId of sourceIds) runResultsTracker.completed.add(sourceId);
    progress.done++;
    return withFailureHistory({ action: "continue", lastFailKey: "" }, []);
  }

  if (r.status === "skipped" && r.counts_as_completed === true) {
    const prdForSkipCheck = loadPrd();
    // Skip-path sibling of #104: tolerate null/non-object entries in prd.tasks
    // (manual edits, migration residue, retry from corrupt state). Without this
    // guard, `.find` reads `.id` on null and throws, crashing the main loop on a
    // PRD whose only invalid sibling is a legitimately parseable JSON value.
    const latestTask = (Array.isArray(prdForSkipCheck.tasks) ? prdForSkipCheck.tasks : [])
      .find((item) => item && typeof item === "object" && item.id === task.id) || task;
    const post = skippedTaskPostconditionsPass(latestTask, prdForSkipCheck);
    if (!post.passed) {
      const reason = `invalid_skip_postconditions_failed: ${post.failed.join("; ")}`;
      recordTaskTransition(failTaskTransition({
        taskId: task.id,
        reason,
        result: { skip_kind: r.skip_kind },
        prdUpdate: {
          phase: "postcondition",
          counts_as_completed: false,
        },
        now,
      }));
      markParentBlockedByChildFailure(task, childTaskMap, reason);
      results.failed.push(task.id);
      runResultsTracker.failed.push(task.id);
      progress.failed++;
      log(task.id, "FAIL", reason);
      return withFailureHistory({ action: "continue", lastFailKey });
    }

    completedIds.add(task.id);
    const sourceIds = updateMergedSourceTasks(task, {
      status: "merged_into",
      skip_kind: r.skip_kind || "valid_skip_already_satisfied",
      counts_as_completed: true,
      phase: "done",
      phaseDetail: `merged task skipped: ${task.id}`,
    });
    for (const sourceId of sourceIds) completedIds.add(sourceId);
    markParentCompleteIfAllChildrenDone(task, childTaskMap, completedIds);
    results.skipped.push(task.id);
    appendUniqueTaskIds(results.skipped, sourceIds);
    log(task.id, "--", `跳过: ${r.reason}`);
    return withFailureHistory({ action: "continue", lastFailKey });
  }

  if (r.status === "blocked") {
    const sourceIds = updateMergedSourceTasks(task, {
      status: "blocked",
      skip_kind: "blocked_skip_missing_evidence",
      counts_as_completed: false,
      phase: "blocked",
      phaseDetail: r.reason || "blocked",
      failReason: r.reason || "blocked",
    });
    results.blocked.push(task.id);
    appendUniqueTaskIds(results.blocked, sourceIds);
    if (r.reason === "contract_suspect") {
      results.contractReview.push(task.id);
    } else {
      runResultsTracker.failed.push(task.id);
      appendUniqueTaskIds(runResultsTracker.failed, sourceIds);
    }
    progress.failed++;
    log(task.id, "BLOCKED", r.reason || "blocked");
    if (stopForImmediateRemediation && immediateRemediationRequired) {
      return withFailureHistory({ action: "stop", reason: "immediate_remediation_required", lastFailKey });
    }
    return withFailureHistory({ action: "continue", lastFailKey });
  }

  const failKey = `${r.status}:${(r.reason || "").slice(0, 60)}`;
  const priorFailureHistory = tracksFailureHistory ? failureHistory : (lastFailKey ? [lastFailKey] : []);
  const nextFailureHistory = [...priorFailureHistory, failKey];
  // P9.M2: persist the terminal failure to the PRD so task.status agrees with the run report.
  // "failed" is not stale-reset on resume (only "running" is), leaving retry/circuit-breaker intact.
  recordTaskTransition(failTaskTransition({
    taskId: task.id,
    reason: r.reason || r.status,
    prdUpdate: {
      phase: "failed",
      counts_as_completed: false,
    },
    now,
  }));
  if (hasRepeatedFailure(nextFailureHistory, repeatedFailureThreshold)) {
    log("!!", "全局熔断", `连续 ${repeatedFailureThreshold} 个 task 同因失败: ${failKey} — 疑似引擎 bug，全部停机`);
    results.failed.push(task.id);
    runResultsTracker.failed.push(task.id);
    markParentBlockedByChildFailure(task, childTaskMap, r.reason || r.status);
    return withFailureHistory(
      { action: "stop", reason: "repeated_failure_fuse", lastFailKey: failKey },
      nextFailureHistory,
    );
  }

  markParentBlockedByChildFailure(task, childTaskMap, r.reason || r.status);
  const sourceIds = updateMergedSourceTasks(task, {
    status: "failed",
    counts_as_completed: false,
    phase: "failed",
    phaseDetail: r.reason || r.status,
    failReason: r.reason || r.status,
  });
  results.failed.push(task.id);
  appendUniqueTaskIds(results.failed, sourceIds);
  progress.failed++;
  if (stopForImmediateRemediation && immediateRemediationRequired) {
    return withFailureHistory(
      { action: "stop", reason: "immediate_remediation_required", lastFailKey: failKey },
      nextFailureHistory,
    );
  }
  return withFailureHistory({ action: "continue", lastFailKey: failKey }, nextFailureHistory);
}
