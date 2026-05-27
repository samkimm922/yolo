import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildContextPackFailureOutcome } from "../src/runtime/execution/context-pack-outcome.js";

describe("context pack outcome helpers", () => {
  test("buildContextPackFailureOutcome blocks failed context pack gates", () => {
    const contextGate = {
      ok: false,
      result: {
        failures: [
          { code: "readonly_target_overlap" },
          { code: "unsafe_target" },
        ],
      },
    };
    const outcome = buildContextPackFailureOutcome({
      taskId: "FIX-1",
      contextGate,
      attempt: 2,
    });

    assert.equal(outcome.failReason, "context-pack-validator blocked: readonly_target_overlap, unsafe_target");
    assert.deepEqual(outcome.result, {
      status: "failed",
      reason: "context-pack-validator blocked: readonly_target_overlap, unsafe_target",
    });
    assert.equal(outcome.transition.task_id, "FIX-1");
    assert.deepEqual(outcome.transition.result, {
      id: "FIX-1",
      status: "FAIL",
      reason: "context-pack-validator blocked: readonly_target_overlap, unsafe_target",
      retries: 2,
      timestamp: outcome.transition.result.timestamp,
    });
    assert.deepEqual(outcome.transition.prd_update, {
      status: "blocked",
      phase: "context_pack",
      failReason: "context-pack-validator blocked: readonly_target_overlap, unsafe_target",
      contextPackGate: contextGate.result,
    });
  });

  test("buildContextPackFailureOutcome also accepts a raw gate result", () => {
    const rawGate = {
      failures: [{ code: "missing_context" }],
    };
    const outcome = buildContextPackFailureOutcome({
      taskId: "FIX-2",
      contextGate: rawGate,
      attempt: 1,
    });

    assert.equal(outcome.failReason, "context-pack-validator blocked: missing_context");
    assert.equal(outcome.transition.prd_update.contextPackGate, rawGate);
  });
});
