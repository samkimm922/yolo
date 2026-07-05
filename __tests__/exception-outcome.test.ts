import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRunTaskExceptionOutcome,
  exceptionFailureKey,
  hasRepeatedExceptionFailure,
} from "../src/runtime/execution/exception-outcome.js";

describe("runTask exception outcome helpers", () => {
  test("exceptionFailureKey preserves legacy message-based keys", () => {
    assert.equal(exceptionFailureKey(new Error("boom")), "exception:boom");
    assert.equal(exceptionFailureKey("plain failure"), "exception:unknown");
  });

  test("hasRepeatedExceptionFailure checks only the last two history entries", () => {
    assert.equal(hasRepeatedExceptionFailure([
      { gate: -1, message: "exception:boom" },
      { gate: -1, message: "exception:boom" },
    ], "exception:boom"), true);

    assert.equal(hasRepeatedExceptionFailure([
      { gate: -1, message: "exception:boom" },
      { gate: -1, message: "exception:other" },
    ], "exception:boom"), false);

    assert.equal(hasRepeatedExceptionFailure([{ gate: -1, message: "exception:boom" }], "exception:boom"), false);
  });

  test("hasRepeatedExceptionFailure honors configured circuit breaker thresholds", () => {
    const history = [
      { gate: -1, message: "exception:boom at provider" },
      { gate: -1, message: "exception:boom at provider again" },
    ];

    assert.equal(hasRepeatedExceptionFailure(history, "exception:boom at provider", 3), false);
    assert.equal(hasRepeatedExceptionFailure([...history, { gate: -1, message: "exception:boom at provider third" }], "exception:boom at provider", 3), true);
    assert.equal(hasRepeatedExceptionFailure([{ gate: -1, message: "exception:boom at provider" }], "exception:boom at provider", 1), true);
    assert.equal(hasRepeatedExceptionFailure(history, "exception:boom at provider", "abc"), true);
  });

  test("buildRunTaskExceptionOutcome stops on repeated exceptions", () => {
    const error = new Error("same crash");
    const outcome = buildRunTaskExceptionOutcome({
      taskId: "FIX-1",
      error,
      attempt: 3,
      history: [
        { gate: -1, message: "exception:same crash" },
        { gate: -1, message: "exception:same crash" },
      ],
      maxAttempts: 5,
    });

    assert.equal(outcome.action, "return");
    assert.equal(outcome.failKey, "exception:same crash");
    assert.equal(outcome.historyEntry, undefined);
    assert.equal(outcome.consoleMessage, "[runTask] FIX-1 连续异常停机: exception:same crash");
    assert.equal(outcome.doneReason, "连续异常停机: same crash");
    assert.deepEqual(outcome.result, {
      status: "failed",
      reason: "stuck_exception",
      error: "Error: same crash",
    });
    assert.equal(outcome.transition.result.status, "FAIL");
    assert.equal(outcome.transition.result.reason, "连续异常停机: same crash");
    assert.equal(outcome.transition.result.retries, 3);
    assert.deepEqual(outcome.transition.prd_update, {
      status: "failed",
      failReason: "连续异常停机",
    });
  });

  test("buildRunTaskExceptionOutcome fails when retry attempts are exhausted", () => {
    const error = new Error("still broken");
    const outcome = buildRunTaskExceptionOutcome({
      taskId: "FIX-2",
      error,
      attempt: 4,
      history: [],
      maxAttempts: 3,
    });

    assert.equal(outcome.action, "return");
    assert.deepEqual(outcome.historyEntry, { gate: -1, message: "exception:still broken" });
    assert.equal(outcome.consoleMessage, "[runTask] FIX-2 重试耗尽: Error: still broken");
    assert.equal(outcome.doneReason, "重试耗尽 (异常)");
    assert.deepEqual(outcome.result, {
      status: "failed",
      reason: "max_retry_exception",
      error: "Error: still broken",
    });
    assert.equal(outcome.transition.result.status, "FAIL");
    assert.equal(outcome.transition.result.reason, "重试耗尽 (异常): still broken");
    assert.equal(outcome.transition.prd_update.failReason, "重试耗尽 (异常): still broken");
  });

  test("buildRunTaskExceptionOutcome returns retry instructions before terminal failure", () => {
    const outcome = buildRunTaskExceptionOutcome({
      taskId: "FIX-3",
      error: new Error("temporary"),
      attempt: 1,
      history: [],
      maxAttempts: 3,
    });

    assert.equal(outcome.action, "retry");
    assert.deepEqual(outcome.historyEntry, { gate: -1, message: "exception:temporary" });
    assert.equal(outcome.retryMessage, "异常, 重试 1/3: temporary");
    assert.equal(outcome.sleepMs, 2000);
    assert.equal(outcome.transition, undefined);
    assert.equal(outcome.result, undefined);
  });
});
