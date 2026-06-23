import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  appendUniqueTaskIds,
  handleTaskOutcome,
  handleTaskPreRun,
} from "../src/runtime/task-loop/outcome-handler.js";

interface LoopResults {
  completed: string[];
  failed: string[];
  skipped: string[];
  blocked: string[];
  contractReview: string[];
  remediation: { task_id: string; schema: string; action: string; status: string; automation_can_continue: boolean }[];
  immediateRemediationQueue: { source_task_id: string; routing: string; reason: string; action: string; status: string; next_actions: string[] }[];
}

function makeLoopState() {
  return {
    results: { completed: [], failed: [], skipped: [], blocked: [], contractReview: [], remediation: [], immediateRemediationQueue: [] } as LoopResults,
    runResultsTracker: { completed: new Set<string>(), failed: [] as string[] },
    progress: { done: 0, failed: 0 },
    completedIds: new Set<string>(),
    childTaskMap: new Map<string, unknown>(),
  };
}

function makeOutcomeCallbacks(options: { prd?: { tasks: { id: string; status: string }[] }; post?: { passed: boolean; failed: string[] }; sourceIds?: string[] } = {}) {
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

  test("handleTaskOutcome persists a PRD failed transition for terminal failures (prompt/gate/etc.)", () => {
    const state = makeLoopState();
    const callbacks = makeOutcomeCallbacks();

    const result = handleTaskOutcome({
      ...state,
      task: { id: "FIX-P36-007" },
      outcome: { status: "failed", reason: "prompt 生成失败" },
      ...callbacks,
      now: "2026-06-13T00:00:00.000Z",
    });

    assert.equal(result.action, "continue");
    const failedTransition = callbacks.calls.transitions.find(
      (transition) => transition.task_id === "FIX-P36-007" && transition.prd_update?.status === "failed",
    );
    assert.ok(failedTransition, "a PRD transition with status=failed must be recorded");
    assert.equal(failedTransition.prd_update.phase, "failed");
    assert.equal(failedTransition.prd_update.counts_as_completed, false);
    assert.equal(failedTransition.prd_update.failReason, "prompt 生成失败");
    assert.equal(failedTransition.result.status, "FAIL");
  });

  test("handleTaskOutcome does not record a failed transition for completed tasks", () => {
    const state = makeLoopState();
    const callbacks = makeOutcomeCallbacks();

    handleTaskOutcome({
      ...state,
      task: { id: "FIX-P36-008" },
      outcome: { status: "completed" },
      ...callbacks,
    });

    const failedTransition = callbacks.calls.transitions.find(
      (transition) => transition.prd_update?.status === "failed",
    );
    assert.equal(failedTransition, undefined, "completed tasks must not emit a failed PRD transition");
  });

  test("handleTaskOutcome records the failed transition even when the repeated-failure fuse trips", () => {
    const state = makeLoopState();
    const callbacks = makeOutcomeCallbacks();

    handleTaskOutcome({
      ...state,
      task: { id: "FIX-P36-009" },
      outcome: { status: "failed", reason: "same root cause" },
      lastFailKey: "failed:same root cause",
      ...callbacks,
    });

    const failedTransition = callbacks.calls.transitions.find(
      (transition) => transition.task_id === "FIX-P36-009" && transition.prd_update?.status === "failed",
    );
    assert.ok(failedTransition, "the fuse trip must still persist the failure to the PRD");
  });

  test("handleTaskOutcome tolerates null/non-object siblings in prd.tasks during valid-skip check (same family as #104)", () => {
    // PRD state can carry null / string / number siblings (hand-edits, migration
    // residue, retry from corrupt state). Without the guard, the skip path's
    // `.find((item) => item.id === task.id)` reads `.id` on null and throws,
    // crashing the main loop on a legitimately parseable PRD.
    const state = makeLoopState();
    const callbacks = makeOutcomeCallbacks({
      // Deliberately malformed entries (null/string/number) to exercise the skip guard.
      prd: { tasks: [null, { id: "FIX-P36-010", status: "pending" }, "stray", 42] as unknown as { id: string; status: string }[] },
      post: { passed: true, failed: [] },
    });

    const result = handleTaskOutcome({
      ...state,
      task: { id: "FIX-P36-010" },
      outcome: { status: "skipped", counts_as_completed: true, skip_kind: "valid_skip_already_satisfied" },
      ...callbacks,
    });

    assert.deepEqual(result, { action: "continue", lastFailKey: "" });
    assert.deepEqual(state.results.skipped, ["FIX-P36-010"]);
  });
});
