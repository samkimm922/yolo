import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  appendUniqueTaskIds,
  handleTaskOutcome,
  handleTaskPreRun,
} from "../src/runtime/task-loop/outcome-handler.js";

function makeLoopState() {
  return {
    results: { completed: [], failed: [], skipped: [], blocked: [], contractReview: [] },
    runResultsTracker: { completed: new Set(), failed: [] },
    progress: { done: 0, failed: 0 },
    completedIds: new Set(),
    childTaskMap: new Map(),
  };
}

function makeOutcomeCallbacks(options = {}) {
  const calls = {
    logs: [],
    mergedUpdates: [],
    parentDone: [],
    parentBlocked: [],
    transitions: [],
  };
  return {
    calls,
    loadPrd: () => options.prd || { tasks: [] },
    skippedTaskPostconditionsPass: () => options.post || { passed: true, failed: [] },
    updateMergedSourceTasks: (task, update) => {
      calls.mergedUpdates.push({ taskId: task.id, update });
      return options.sourceIds || [];
    },
    markParentCompleteIfAllChildrenDone: (task, childTaskMap, completedIds) => {
      calls.parentDone.push({ taskId: task.id, childTaskMap, completedIds: new Set(completedIds) });
      return true;
    },
    markParentBlockedByChildFailure: (task, childTaskMap, reason) => {
      calls.parentBlocked.push({ taskId: task.id, childTaskMap, reason });
      return true;
    },
    recordTaskTransition: (transition) => calls.transitions.push(transition),
    log: (...args) => calls.logs.push(args),
  };
}

describe("task-loop outcome handler", () => {
  test("appendUniqueTaskIds appends only unseen ids", () => {
    const ids = ["A", "B"];
    appendUniqueTaskIds(ids, ["B", "C", "A", "D"]);
    assert.deepEqual(ids, ["A", "B", "C", "D"]);
  });

  test("handleTaskPreRun records dependency-blocked tasks before execution", () => {
    const { results, completedIds } = makeLoopState();
    completedIds.add("FIX-P36-001");
    const transitions = [];
    const logs = [];

    const decision = handleTaskPreRun({
      task: { id: "FIX-P36-003", depends_on: ["FIX-P36-001", "FIX-P36-002"] },
      tasks: [{ id: "FIX-P36-002", status: "pending" }],
      results,
      completedIds,
      taskIsSplitParent: () => false,
      taskCountsAsCompleted: (task) => task?.status === "done",
      recordTaskTransition: (transition) => transitions.push(transition),
      log: (...args) => logs.push(args),
      now: "2026-05-24T15:00:00.000Z",
    });

    assert.deepEqual(decision, {
      action: "skip",
      reason: "dependency_blocked",
      deps: ["FIX-P36-002"],
    });
    assert.deepEqual(results.blocked, ["FIX-P36-003"]);
    assert.equal(transitions[0].task_id, "FIX-P36-003");
    assert.equal(transitions[0].result.status, "BLOCKED");
    assert.deepEqual(transitions[0].result.blocked_by, ["FIX-P36-002"]);
    assert.equal(transitions[0].prd_update.phaseDetail, "dependency_blocked: FIX-P36-002");
    assert.deepEqual(logs, [["FIX-P36-003", "--", "跳过: 依赖 FIX-P36-002 未完成"]]);
  });

  test("handleTaskOutcome records completed tasks, merged sources, parent completion, and progress", () => {
    const state = makeLoopState();
    const callbacks = makeOutcomeCallbacks({ sourceIds: ["FIX-P36-001"] });

    const result = handleTaskOutcome({
      ...state,
      task: { id: "FIX-P36-003", merged_from: ["FIX-P36-001"] },
      outcome: { status: "completed" },
      lastFailKey: "failed:old",
      ...callbacks,
      now: "2026-05-24T15:00:00.000Z",
    });

    assert.deepEqual(result, { action: "continue", lastFailKey: "" });
    assert.deepEqual(state.results.completed, ["FIX-P36-003", "FIX-P36-001"]);
    assert.deepEqual([...state.runResultsTracker.completed], ["FIX-P36-003", "FIX-P36-001"]);
    assert.equal(state.completedIds.has("FIX-P36-003"), true);
    assert.equal(state.completedIds.has("FIX-P36-001"), true);
    assert.equal(state.progress.done, 1);
    assert.equal(callbacks.calls.mergedUpdates[0].update.phaseDetail, "merged task completed: FIX-P36-003");
    assert.equal(callbacks.calls.parentDone[0].taskId, "FIX-P36-003");
  });

  test("handleTaskOutcome turns invalid valid-skip claims into failed tasks", () => {
    const state = makeLoopState();
    const callbacks = makeOutcomeCallbacks({
      prd: { tasks: [{ id: "FIX-P36-003", status: "pending" }] },
      post: { passed: false, failed: ["post condition missing"] },
    });

    const result = handleTaskOutcome({
      ...state,
      task: { id: "FIX-P36-003" },
      outcome: { status: "skipped", counts_as_completed: true, skip_kind: "valid_skip_already_satisfied" },
      ...callbacks,
      now: "2026-05-24T15:00:00.000Z",
    });

    assert.deepEqual(result, { action: "continue", lastFailKey: "" });
    assert.deepEqual(state.results.failed, ["FIX-P36-003"]);
    assert.deepEqual(state.runResultsTracker.failed, ["FIX-P36-003"]);
    assert.equal(state.progress.failed, 1);
    assert.equal(callbacks.calls.transitions[0].result.status, "FAIL");
    assert.equal(callbacks.calls.transitions[0].result.reason, "invalid_skip_postconditions_failed: post condition missing");
    assert.equal(callbacks.calls.parentBlocked[0].reason, "invalid_skip_postconditions_failed: post condition missing");
  });

  test("handleTaskOutcome routes contract-suspect blocked tasks to contract review", () => {
    const state = makeLoopState();
    const callbacks = makeOutcomeCallbacks({ sourceIds: ["FIX-P36-001"] });

    const result = handleTaskOutcome({
      ...state,
      task: { id: "FIX-P36-003" },
      outcome: { status: "blocked", reason: "contract_suspect" },
      ...callbacks,
    });

    assert.deepEqual(result, { action: "continue", lastFailKey: "" });
    assert.deepEqual(state.results.blocked, ["FIX-P36-003", "FIX-P36-001"]);
    assert.deepEqual(state.results.contractReview, ["FIX-P36-003"]);
    assert.deepEqual(state.runResultsTracker.failed, []);
    assert.equal(state.progress.failed, 1);
  });

  test("handleTaskOutcome preserves remediation plans without changing normal routing", () => {
    const state = makeLoopState();
    const callbacks = makeOutcomeCallbacks();

    const result = handleTaskOutcome({
      ...state,
      task: { id: "FIX-P40-015" },
      outcome: {
        status: "failed",
        reason: "gate failed",
        remediation: {
          schema: "yolo.gate.remediation_plan.v1",
          action: "REROUTE_REVIEW_FIX",
          status: "remediation_required",
          automation_can_continue: true,
        },
      },
      ...callbacks,
    });

    assert.equal(result.action, "continue");
    assert.deepEqual(state.results.remediation, [{
      task_id: "FIX-P40-015",
      schema: "yolo.gate.remediation_plan.v1",
      action: "REROUTE_REVIEW_FIX",
      status: "remediation_required",
      automation_can_continue: true,
    }]);
    assert.deepEqual(state.results.failed, ["FIX-P40-015"]);
    assert.deepEqual(state.results.immediateRemediationQueue, [{
      source_task_id: "FIX-P40-015",
      routing: "before_next_feature_task",
      reason: "harness_remediation_must_be_cleared_before_new_work",
      action: "REROUTE_REVIEW_FIX",
      status: "remediation_required",
      next_actions: [],
    }]);
  });

  test("handleTaskOutcome can stop new work when immediate remediation is required", () => {
    const state = makeLoopState();
    const callbacks = makeOutcomeCallbacks();

    const result = handleTaskOutcome({
      ...state,
      task: { id: "FIX-HARNESS-001" },
      outcome: {
        status: "failed",
        reason: "fixture evidence missing",
        remediation: {
          action: "AUTO_REMEDIATE",
          status: "remediation_required",
          automation_can_continue: true,
          blocks_ship: true,
          next_actions: ["Generate a bounded remediation task now."],
        },
      },
      stopForImmediateRemediation: true,
      ...callbacks,
    });

    assert.deepEqual(result, {
      action: "stop",
      reason: "immediate_remediation_required",
      lastFailKey: "failed:fixture evidence missing",
    });
    assert.equal(state.results.immediateRemediationQueue[0].routing, "before_next_feature_task");
  });

  test("handleTaskOutcome stops the loop on repeated same failure", () => {
    const state = makeLoopState();
    const callbacks = makeOutcomeCallbacks();

    const result = handleTaskOutcome({
      ...state,
      task: { id: "FIX-P36-004" },
      outcome: { status: "failed", reason: "same root cause" },
      lastFailKey: "failed:same root cause",
      ...callbacks,
    });

    assert.deepEqual(result, {
      action: "stop",
      reason: "repeated_failure_fuse",
      lastFailKey: "failed:same root cause",
    });
    assert.deepEqual(state.results.failed, ["FIX-P36-004"]);
    assert.deepEqual(state.runResultsTracker.failed, ["FIX-P36-004"]);
    assert.equal(state.progress.failed, 0);
    assert.equal(callbacks.calls.parentBlocked[0].reason, "same root cause");
    assert.match(callbacks.calls.logs[0][2], /连续 2 个 task 同因失败/);
  });
});
