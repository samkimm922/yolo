import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lifecycleStageForCommand, lifecycleStageIds } from "../src/lifecycle/schema.js";

describe("roadmap-to-prd direct path (task-graph removed)", () => {
  test("task-graph stage no longer exists in lifecycle stages", () => {
    const ids = lifecycleStageIds();
    assert.ok(!ids.includes("task-graph"), "task-graph must be removed from lifecycle stages");
    assert.equal(ids.length, 11);
  });

  test("yolo-tasks command no longer maps to a lifecycle stage", () => {
    const stage = lifecycleStageForCommand("yolo-tasks");
    assert.equal(stage, null, "yolo-tasks should not resolve after task-graph removal");
  });

  test("yolo-plan command maps to the roadmap stage", () => {
    const stage = lifecycleStageForCommand("yolo-plan");
    assert.ok(stage);
    assert.equal(stage.id, "roadmap");
  });
});
