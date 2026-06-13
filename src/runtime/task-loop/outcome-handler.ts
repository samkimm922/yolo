import { blockedTaskTransition, failTaskTransition } from "../task-state/transitions.js";
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
    return { action: "continue", lastFailKey: "" };
  }

  if (r.status === "skipped" && r.counts_as_completed === true) {
    const prdForSkipCheck = loadPrd();
    const latestTask = (prdForSkipCheck.tasks || []).find((item) => item.id === task.id) || task;
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
      return { action: "continue", lastFailKey };
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
    return { action: "continue", lastFailKey };
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
      return { action: "stop", reason: "immediate_remediation_required", lastFailKey };
    }
    return { action: "continue", lastFailKey };
  }

  const failKey = `${r.status}:${(r.reason || "").slice(0, 60)}`;
  if (lastFailKey && failKey === lastFailKey) {
    log("!!", "全局熔断", `连续 2 个 task 同因失败: ${failKey} — 疑似引擎 bug，全部停机`);
    results.failed.push(task.id);
    runResultsTracker.failed.push(task.id);
    markParentBlockedByChildFailure(task, childTaskMap, r.reason || r.status);
    return { action: "stop", reason: "repeated_failure_fuse", lastFailKey: failKey };
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
    return { action: "stop", reason: "immediate_remediation_required", lastFailKey: failKey };
  }
  return { action: "continue", lastFailKey: failKey };
}
