import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCommitExceptionRetryOutcome,
  buildPreMergePostconditionFailureOutcome,
} from "../src/runtime/execution/gate-pass-outcome.js";

describe("gate pass outcome helpers", () => {
  test("buildPreMergePostconditionFailureOutcome fails before merge with a postcondition transition", () => {
    const outcome = buildPreMergePostconditionFailureOutcome({
      taskId: "FIX-1",
      postResult: { passed: false, failed: ["code_contains: missing text", "tests_pass: failed"] },
      attempt: 2,
    });

    assert.equal(outcome.reason, "post_conditions failed before merge: code_contains: missing text; tests_pass: failed");
    assert.deepEqual(outcome.result, {
      status: "failed",
      reason: "post_conditions failed before merge: code_contains: missing text; tests_pass: failed",
    });
    assert.equal(outcome.transition.task_id, "FIX-1");
    assert.equal(outcome.transition.result.status, "FAIL");
    assert.equal(outcome.transition.result.reason, outcome.reason);
    assert.equal(outcome.transition.result.retries, 2);
    assert.deepEqual(outcome.transition.prd_update, {
      status: "failed",
      failReason: outcome.reason,
      phase: "postcondition",
    });
  });

  test("buildCommitExceptionRetryOutcome preserves runner retry diagnostics", () => {
    const error = new Error("commit failed");
    const outcome = buildCommitExceptionRetryOutcome(error);

    assert.equal(outcome.reason, "commit 异常（将重试）: commit failed");
    assert.equal(outcome.errorTitle, "commit 异常（将重试）");
    assert.equal(outcome.errorDetail, "Error: commit failed");
    assert.deepEqual(outcome.gateResult, {
      exitCode: 1,
      stdout: "",
      stderr: "commit 异常: commit failed",
      results: [],
      allPassed: false,
    });
  });

  test("buildCommitExceptionRetryOutcome keeps legacy undefined message behavior for non-errors", () => {
    const outcome = buildCommitExceptionRetryOutcome("plain failure");

    assert.equal(outcome.reason, "commit 异常（将重试）: undefined");
    assert.equal(outcome.errorDetail, "plain failure");
    assert.equal(outcome.gateResult.stderr, "commit 异常: undefined");
  });
});
