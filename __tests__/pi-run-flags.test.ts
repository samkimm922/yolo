import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPiRunPlan } from "../src/agents/pi.js";

describe("PI runner flag propagation", () => {
  test("forwards no-review-loop and progress-server flags into runner action", () => {
    const plan = createPiRunPlan({
      prdPath: "/tmp/no-review-loop-prd.json",
      executor: "claude",
      runReviewLoop: false,
      startProgressServer: false,
    }, {
      yoloRoot: "/tmp/yolo",
      projectRoot: "/tmp/project",
      stateRoot: "/tmp/project/.yolo",
    });

    const runner = plan.actions.find((action) => action.id === "pi.execute.runner");
    assert.ok(runner);
    assert.equal(runner.params.runReviewLoop, false);
    assert.equal(runner.params.startProgressServer, false);
  });
});
