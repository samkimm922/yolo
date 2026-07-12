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

  test("buildContextPackFailureOutcome surfaces actionable remediation for target/readonly conflict", () => {
    const contextGate = {
      ok: false,
      result: {
        failures: [{
          code: "CONTEXT_PACK_TARGET_READONLY_CONFLICT",
          detail: "target files cannot also be readonly: src/index.ts (remove src/index.ts from scope.targets or scope.readonly_files)",
          files: ["src/index.ts"],
          remediation: "Remove src/index.ts from scope.targets (if it should be writable) or from scope.readonly_files (if it should be a write target).",
        }],
      },
    };
    const outcome = buildContextPackFailureOutcome({ taskId: "FIX-3", contextGate, attempt: 1 });

    assert.match(outcome.failReason, /CONTEXT_PACK_TARGET_READONLY_CONFLICT/);
    assert.match(outcome.failReason, /src\/index\.ts/);
    assert.match(outcome.failReason, /remove src\/index\.ts from scope\.targets or scope\.readonly_files/i);
    assert.match(outcome.result.reason, /src\/index\.ts/);
    assert.match(outcome.transition.prd_update.failReason, /remove src\/index\.ts from scope\.targets or scope\.readonly_files/i);
  });

  test("buildContextPackFailureOutcome surfaces actionable remediation for max files exceeded", () => {
    const contextGate = {
      ok: false,
      result: {
        failures: [{
          code: "CONTEXT_PACK_MAX_FILES_EXCEEDED",
          detail: "target count 5 exceeds scope.max_files 2 (split the task into smaller tasks or raise scope.max_files)",
          target_count: 5,
          max_files: 2,
          remediation: "Split the task so each task touches <= 2 target files, or raise scope.max_files.",
        }],
      },
    };
    const outcome = buildContextPackFailureOutcome({ taskId: "FIX-4", contextGate, attempt: 1 });

    assert.match(outcome.failReason, /CONTEXT_PACK_MAX_FILES_EXCEEDED/);
    assert.match(outcome.failReason, /5 exceeds scope\.max_files 2/);
    assert.match(outcome.failReason, /split the task into smaller tasks or raise scope\.max_files/i);
    assert.match(outcome.result.reason, /split the task into smaller tasks or raise scope\.max_files/i);
  });
});
