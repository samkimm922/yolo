import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  blockParentForChildFailure,
  buildChildTaskMap,
  completeParentIfAllChildrenDone,
  dependencyBlockers,
  deriveParentTaskId,
  mergedSourceTaskIds,
  updateMergedSourceTasks,
} from "../src/runtime/task-loop/status-helpers.js";

describe("task-loop status helpers", () => {
  test("mergedSourceTaskIds filters self and empty source ids", () => {
    assert.deepEqual(
      mergedSourceTaskIds({ id: "FIX-P36-003", merged_from: ["FIX-P36-001", "", null, "FIX-P36-003"] }),
      ["FIX-P36-001"],
    );
    assert.deepEqual(mergedSourceTaskIds({ id: "FIX-P36-003" }), []);
  });

  test("updateMergedSourceTasks writes merged source status updates with timestamp", () => {
    const writes = [];
    const updatedIds = updateMergedSourceTasks({
      task: { id: "FIX-P36-003", merged_from: ["FIX-P36-001", "FIX-P36-002"] },
      update: {
        status: "merged_into",
        counts_as_completed: true,
        phase: "done",
      },
      updateTaskStatus: (taskId, update) => writes.push({ taskId, update }),
      now: "2026-05-24T15:00:00.000Z",
    });

    assert.deepEqual(updatedIds, ["FIX-P36-001", "FIX-P36-002"]);
    assert.deepEqual(writes, [
      {
        taskId: "FIX-P36-001",
        update: {
          status: "merged_into",
          counts_as_completed: true,
          phase: "done",
          merged_into: "FIX-P36-003",
          updatedAt: "2026-05-24T15:00:00.000Z",
        },
      },
      {
        taskId: "FIX-P36-002",
        update: {
          status: "merged_into",
          counts_as_completed: true,
          phase: "done",
          merged_into: "FIX-P36-003",
          updatedAt: "2026-05-24T15:00:00.000Z",
        },
      },
    ]);
  });

  test("deriveParentTaskId preserves existing runner suffix rules", () => {
    assert.equal(deriveParentTaskId("FIX-P36-003-A-1"), "FIX-P36-003");
    assert.equal(deriveParentTaskId("FIX-P36-003-A"), "FIX-P36-003");
    assert.equal(deriveParentTaskId("FIX-P36-003-P1"), "FIX-P36-003");
    assert.equal(deriveParentTaskId("FIX-P36-003"), "FIX-P36-003");
    assert.equal(deriveParentTaskId(""), "");
  });

  test("buildChildTaskMap groups derived children by parent id", () => {
    const childMap = buildChildTaskMap([
      { id: "FIX-P36-003" },
      { id: "FIX-P36-003-A" },
      { id: "FIX-P36-003-B" },
      { id: "FIX-P36-003-P1" },
    ]);

    assert.deepEqual([...childMap.get("FIX-P36-003")], [
      "FIX-P36-003-A",
      "FIX-P36-003-B",
      "FIX-P36-003-P1",
    ]);
  });

  test("completeParentIfAllChildrenDone updates parent only after every child completes", () => {
    const childMap = buildChildTaskMap([
      { id: "FIX-P36-003" },
      { id: "FIX-P36-003-A" },
      { id: "FIX-P36-003-B" },
    ]);
    const completedIds = new Set(["FIX-P36-003-A"]);
    const writes = [];
    const logs = [];

    assert.equal(
      completeParentIfAllChildrenDone({
        task: { id: "FIX-P36-003-A" },
        childMap,
        completedIds,
        updateTaskStatus: (taskId, update) => writes.push({ taskId, update }),
        log: (...args) => logs.push(args),
        now: "2026-05-24T15:00:00.000Z",
      }),
      false,
    );

    completedIds.add("FIX-P36-003-B");
    assert.equal(
      completeParentIfAllChildrenDone({
        task: { id: "FIX-P36-003-B" },
        childMap,
        completedIds,
        updateTaskStatus: (taskId, update) => writes.push({ taskId, update }),
        log: (...args) => logs.push(args),
        now: "2026-05-24T15:00:00.000Z",
      }),
      true,
    );

    assert.equal(completedIds.has("FIX-P36-003"), true);
    assert.deepEqual(writes, [
      {
        taskId: "FIX-P36-003",
        update: {
          status: "done",
          completedByChildren: ["FIX-P36-003-A", "FIX-P36-003-B"],
          completedAt: "2026-05-24T15:00:00.000Z",
        },
      },
    ]);
    assert.deepEqual(logs, [["FIX-P36-003", "parent-done", "全部子任务完成: FIX-P36-003-A, FIX-P36-003-B"]]);
  });

  test("blockParentForChildFailure marks parent blocked with child context", () => {
    const childMap = buildChildTaskMap([
      { id: "FIX-P36-003" },
      { id: "FIX-P36-003-A" },
    ]);
    const writes = [];
    const logs = [];

    assert.equal(
      blockParentForChildFailure({
        task: { id: "FIX-P36-003-A" },
        childMap,
        reason: "postcondition_failed",
        updateTaskStatus: (taskId, update) => writes.push({ taskId, update }),
        log: (...args) => logs.push(args),
        now: "2026-05-24T15:00:00.000Z",
      }),
      true,
    );

    assert.deepEqual(writes, [
      {
        taskId: "FIX-P36-003",
        update: {
          status: "blocked",
          blockedByChild: "FIX-P36-003-A",
          blockedReason: "postcondition_failed",
          updatedAt: "2026-05-24T15:00:00.000Z",
        },
      },
    ]);
    assert.deepEqual(logs, [["FIX-P36-003", "parent-blocked", "子任务失败: FIX-P36-003-A"]]);
  });

  test("dependencyBlockers ignores completed and counts-as-completed dependencies", () => {
    const deps = dependencyBlockers({
      task: { id: "FIX-P36-004", depends_on: ["FIX-P36-001", "FIX-P36-002", "FIX-P36-003"] },
      completedIds: new Set(["FIX-P36-001"]),
      tasks: [
        { id: "FIX-P36-002", status: "skipped", counts_as_completed: true },
        { id: "FIX-P36-003", status: "blocked", counts_as_completed: false },
      ],
      taskCountsAsCompleted: (task) => task?.status === "done" || task?.counts_as_completed === true,
    });

    assert.deepEqual(deps, ["FIX-P36-003"]);
  });
});
