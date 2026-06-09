import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { classifyRecovery } from "../src/runtime/execution/recovery-classification.js";

describe("recovery-classification", () => {
  test("timed_out maps to retry_narrower", () => {
    assert.equal(classifyRecovery("timed_out").strategy, "retry_narrower");
  });

  test("killed maps to retry (transient)", () => {
    assert.equal(classifyRecovery("killed").strategy, "retry");
  });

  test("no_output maps to retry (transient)", () => {
    assert.equal(classifyRecovery("no_output").strategy, "retry");
  });

  test("verification_failed maps to retry_with_hint", () => {
    assert.equal(classifyRecovery("verification_failed").strategy, "retry_with_hint");
  });

  test("failed maps to retry_with_hint", () => {
    assert.equal(classifyRecovery("failed").strategy, "retry_with_hint");
  });

  test("repeated failure after max retries maps to escalate", () => {
    assert.equal(classifyRecovery("failed", { attempt: 5, maxRetry: 3 }).strategy, "escalate");
  });

  test("timed_out after max retries maps to escalate", () => {
    assert.equal(classifyRecovery("timed_out", { attempt: 4, maxRetry: 3 }).strategy, "escalate");
  });

  test("unknown status maps to abort", () => {
    assert.equal(classifyRecovery("unknown_status_xyz").strategy, "abort");
  });

  test("result includes reason string", () => {
    const result = classifyRecovery("timed_out");
    assert.ok(typeof result.reason === "string" && result.reason.length > 0);
  });
});
