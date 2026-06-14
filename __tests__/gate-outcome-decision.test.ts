import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decideGateOutcome } from "../src/runtime/task-loop/gate-outcome-decision.js";

// B4: behavioral tests for the task-runner exitCode branch.
// task-runner.ts:174 routes gate results to handleGatePassFlow (exitCode===0)
// or handleGateFailureFlow (exitCode!==0) via decideGateOutcome.
// Each test exercises the pure decision function, not source text.

describe("gate outcome decision (task-runner exitCode branch)", () => {
  test("exitCode 0 routes to gate pass flow", () => {
    const decision = decideGateOutcome(0);
    assert.equal(decision.branch, "pass");
    assert.equal(decision.handler, "handleGatePassFlow");
    // mutation: if condition flipped to !== 0 → branch would be "failure"
  });

  test("exitCode 1 routes to gate failure flow with maxRetry lookup", () => {
    const decision = decideGateOutcome(1, { maxRetry: { 1: 3, 2: 1 } });
    assert.equal(decision.branch, "failure");
    assert.equal(decision.handler, "handleGateFailureFlow");
    assert.equal(decision.exitCode, 1);
    assert.equal(decision.maxRetryForGate, 3);
    // mutation: if exitCode not forwarded → decision.exitCode would be undefined
  });

  test("exitCode 2 routes to gate failure with different maxRetry", () => {
    const decision = decideGateOutcome(2, { maxRetry: { 1: 3, 2: 1 } });
    assert.equal(decision.branch, "failure");
    assert.equal(decision.maxRetryForGate, 1);
    // mutation: if maxRetry lookup used wrong key → maxRetryForGate would be 0 or 3
  });

  test("unknown exitCode falls back to maxRetry 0", () => {
    const decision = decideGateOutcome(127, { maxRetry: { 1: 3 } });
    assert.equal(decision.branch, "failure");
    assert.equal(decision.maxRetryForGate, 0);
    // mutation: if ?? 0 fallback removed → maxRetryForGate would be undefined
  });

  test("empty maxRetry map yields 0 for any non-zero exitCode", () => {
    const decision = decideGateOutcome(1, {});
    assert.equal(decision.maxRetryForGate, 0);
    // mutation: if default {} replaced with { 1: 5 } → maxRetryForGate would be 5
  });
});
