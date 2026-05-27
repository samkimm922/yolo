import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiffQualityFailureOutcome,
  buildProviderFailureOutcome,
  buildTestGenerationFailureOutcome,
  providerFailureDiagnostic,
} from "../src/runtime/execution/session-failure-outcome.js";

describe("session failure outcome helpers", () => {
  test("providerFailureDiagnostic preserves runner diagnostic fields", () => {
    assert.equal(providerFailureDiagnostic({
      exitCode: 2,
      signal: "SIGTERM",
      stderr: "network failed",
    }), "exit=2 signal=SIGTERM stderr=network failed");

    assert.equal(providerFailureDiagnostic({ exitCode: null, stderr: "" }), "");
  });

  test("buildProviderFailureOutcome returns retryable provider failures before max retry", () => {
    const outcome = buildProviderFailureOutcome({
      taskId: "FIX-1",
      providerName: "codex",
      providerRun: {
        success: false,
        exitCode: 1,
        signal: null,
        stderr: "network failed",
        timedOut: false,
      },
      attempt: 1,
      maxRetry: 2,
    });

    assert.equal(outcome.failReason, "codex 退出失败: exit=1 stderr=network failed");
    assert.equal(outcome.retryMessage, "codex 失败, 重试 1/2");
    assert.equal(outcome.result, null);
    assert.equal(outcome.transition.result.status, "FAIL");
    assert.equal(outcome.transition.result.provider, "codex");
    assert.equal(outcome.transition.result.retries, 1);
    assert.deepEqual(outcome.transition.prd_update, {
      status: "failed",
      failReason: "codex 退出失败: exit=1 stderr=network failed",
      phase: "claude",
      phaseDetail: undefined,
    });
  });

  test("buildProviderFailureOutcome returns terminal provider budget blockers", () => {
    const outcome = buildProviderFailureOutcome({
      taskId: "FIX-2",
      providerName: "claude",
      providerRun: {
        success: false,
        exitCode: 1,
        stderr: "Exceeded USD budget for this session",
      },
      attempt: 1,
      maxRetry: 3,
    });

    assert.equal(outcome.failReason, "claude 退出失败: exit=1 stderr=Exceeded USD budget for this session");
    assert.deepEqual(outcome.result, {
      status: "blocked",
      reason: "provider_budget_exceeded",
    });
    assert.equal(outcome.transition.result.status, "BLOCKED");
    assert.equal(outcome.transition.result.reason, "provider_budget_exceeded");
    assert.equal(outcome.transition.prd_update.status, "blocked");
    assert.equal(outcome.transition.prd_update.phase, "provider_budget");
  });

  test("buildProviderFailureOutcome fails when retry budget is exhausted", () => {
    const outcome = buildProviderFailureOutcome({
      taskId: "FIX-3",
      providerName: "claude",
      providerRun: {
        success: true,
        stdout: "",
        stderr: "",
      },
      attempt: 2,
      maxRetry: 1,
    });

    assert.equal(outcome.failReason, "claude 输出为空");
    assert.equal(outcome.retryMessage, null);
    assert.deepEqual(outcome.result, {
      status: "failed",
      reason: "claude 输出为空",
    });
    assert.equal(outcome.transition.result.status, "FAIL");
  });

  test("buildDiffQualityFailureOutcome returns retry metadata before max retry", () => {
    const gate = {
      recovery_hint: "reduce diff",
      failures: [
        { code: "oversized_diff", detail: "too many files" },
        { code: "unsafe_rewrite", detail: "unexpected rewrite" },
      ],
    };
    const outcome = buildDiffQualityFailureOutcome({
      taskId: "FIX-4",
      diffQualityGate: gate,
      attempt: 1,
      maxRetry: 2,
    });

    assert.equal(outcome.failReason, "diff-quality-gate blocked: oversized_diff, unsafe_rewrite");
    assert.equal(outcome.recoveryHint, "reduce diff");
    assert.match(outcome.lastGateError, /- oversized_diff: too many files/);
    assert.deepEqual(outcome.historyEntry, {
      gate: 1,
      fingerprint: "diff-quality:oversized_diff|unsafe_rewrite",
      message: "diff-quality-gate blocked: oversized_diff, unsafe_rewrite",
    });
    assert.equal(outcome.retryMessage, "diff quality 失败, 重试 1/2");
    assert.equal(outcome.transition, null);
    assert.equal(outcome.result, null);
  });

  test("buildDiffQualityFailureOutcome fails with a transition after retry exhaustion", () => {
    const gate = {
      failures: [{ code: "oversized_diff", detail: "too many files" }],
    };
    const outcome = buildDiffQualityFailureOutcome({
      taskId: "FIX-5",
      diffQualityGate: gate,
      attempt: 3,
      maxRetry: 2,
    });

    assert.deepEqual(outcome.result, {
      status: "failed",
      reason: "diff-quality-gate blocked: oversized_diff",
    });
    assert.equal(outcome.transition.result.status, "FAIL");
    assert.equal(outcome.transition.result.reason, "diff-quality-gate blocked: oversized_diff");
    assert.equal(outcome.transition.result.detail, gate);
    assert.equal(outcome.transition.prd_update.phase, "diff_quality");
    assert.equal(outcome.transition.prd_update.diffQualityGate, gate);
  });

  test("buildTestGenerationFailureOutcome preserves blocked PRD update semantics", () => {
    const gate = {
      blocks_execution: true,
      failures: [
        { code: "new_test_file_forbidden" },
      ],
    };
    const outcome = buildTestGenerationFailureOutcome({
      taskId: "FIX-6",
      testGenerationGate: gate,
      attempt: 2,
    });

    assert.equal(outcome.failReason, "test-generation-validator blocked: new_test_file_forbidden");
    assert.deepEqual(outcome.result, {
      status: "failed",
      reason: "test-generation-validator blocked: new_test_file_forbidden",
    });
    assert.equal(outcome.transition.result.status, "FAIL");
    assert.equal(outcome.transition.result.retries, 2);
    assert.deepEqual(outcome.transition.prd_update, {
      status: "blocked",
      phase: "test_generation",
      failReason: "test-generation-validator blocked: new_test_file_forbidden",
      testGenerationGate: gate,
    });
  });
});
