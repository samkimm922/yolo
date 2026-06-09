import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lifecycleStageForCommand } from "../src/lifecycle/schema.js";

describe("task-graph lifecycle stage reachability", () => {
  test("yolo-tasks command maps to the task-graph stage", () => {
    const stage = lifecycleStageForCommand("yolo-tasks");
    assert.ok(stage, "yolo-tasks must resolve to a lifecycle stage");
    assert.equal(stage.id, "task-graph");
  });

  test("yolo-plan command maps to the roadmap stage only", () => {
    const stage = lifecycleStageForCommand("yolo-plan");
    assert.ok(stage);
    assert.equal(stage.id, "roadmap");
  });

  test("slash-prefixed yolo-tasks also resolves to task-graph", () => {
    assert.equal(lifecycleStageForCommand("/yolo-tasks").id, "task-graph");
  });
});
