import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildGateFailureRetryDecision } from "../src/runtime/execution/gate-failure-outcome.js";

const repeatedHistory = [
  { gate: 1, fingerprint: "same", message: "first" },
  { gate: 1, fingerprint: "same", message: "second" },
];

describe("gate failure retry decision helpers", () => {
  test("returns contract_suspect when repeated failures are contract-like", () => {
    const decision = buildGateFailureRetryDecision({
      taskId: "FIX-1",
      gateExitCode: 1,
      failures: [{ type: "code_contains", detail: "missing text" }],
      history: repeatedHistory,
      failedSummary: "code_contains: missing text",
      attempt: 2,
      maxRetryForGate: 3,
    });

    assert.equal(decision.action, "contract_suspect");
    assert.deepEqual(decision.stopLog, {
      id: "FIX-1",
      marker: "!! 停机",
      message: "连续 2 次同 gate code 失败",
    });
    assert.equal(decision.errorTitle, "连续同因停机");
    assert.equal(decision.errorDetail, "gate exit 1: code_contains: missing text");
    assert.equal(decision.learnMessage, "连续同因停机: code_contains: missing text");
    assert.equal(decision.cleanupWorktree, true);
    assert.equal(decision.transition, undefined);
  });

  test("returns stuck transition when repeated failures are not contract-like", () => {
    const decision = buildGateFailureRetryDecision({
      taskId: "FIX-2",
      gateExitCode: 1,
      failures: [{ type: "eslint", detail: "unused var" }],
      history: repeatedHistory,
      failedSummary: "eslint: unused var",
      attempt: 3,
    });

    assert.equal(decision.action, "stuck");
    assert.equal(decision.transition.result.status, "FAIL");
    assert.equal(decision.transition.result.reason, "连续同因");
    assert.equal(decision.transition.result.retries, 3);
    assert.equal(decision.doneReason, "连续同因停机");
    assert.deepEqual(decision.result, {
      status: "stuck",
      reason: "连续同因",
      history: repeatedHistory,
    });
  });

  test("returns max_retry decision after gate retry budget is exhausted", () => {
    const decision = buildGateFailureRetryDecision({
      taskId: "FIX-3",
      gateExitCode: 2,
      failures: [{ type: "tsc", detail: "type error" }],
      history: [],
      failedSummary: "tsc: type error",
      lastGateError: "long gate output",
      attempt: 4,
      maxRetryForGate: 3,
    });

    assert.equal(decision.action, "max_retry");
    assert.equal(decision.errorTitle, "闸门 exit 2, 重试 4 次仍失败");
    assert.equal(decision.errorDetail, "long gate output");
    assert.equal(decision.transition.result.status, "FAIL");
    assert.equal(decision.transition.result.reason, "闸门 exit 2, 重试 4 次仍失败");
    assert.equal(decision.transition.prd_update.retry, 4);
    assert.deepEqual(decision.result, {
      status: "failed",
      reason: "闸门 exit 2, 重试 4 次仍失败",
    });
  });

  test("returns retry decision while retry budget remains", () => {
    const decision = buildGateFailureRetryDecision({
      taskId: "FIX-4",
      gateExitCode: 1,
      attempt: 1,
      maxRetryForGate: 2,
    });

    assert.deepEqual(decision, {
      action: "retry",
      retryMessage: "exit=1, 重试 1/2",
      cleanupWorktree: true,
      cleanupMessage: "worktree: 已丢弃失败改动，从干净基线重试",
    });
  });
});
