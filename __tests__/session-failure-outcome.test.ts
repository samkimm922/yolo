import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDiffQualityFailureOutcome,
  buildProviderFailureOutcome,
  buildTestGenerationFailureOutcome,
  providerFailureDiagnostic,
} from "../src/runtime/execution/session-failure-outcome.js";
import { validateTestGeneration } from "../src/runtime/gates/test-generation-validator.js";

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
    assert.equal(outcome.transition.result.provider_status, "failed");
    assert.equal(outcome.transition.result.retries, 1);
    assert.equal(outcome.transition.result.attempt_ledger[0].task_id, "FIX-1");
    assert.equal(outcome.transition.result.attempt_ledger[0].attempt, 1);
    assert.equal(outcome.transition.result.attempt_ledger[0].status, "failed");
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

  test("buildProviderFailureOutcome returns terminal provider preflight blockers without retry", () => {
    const outcome = buildProviderFailureOutcome({
      taskId: "FIX-SETTINGS",
      providerName: "claude",
      providerRun: {
        success: false,
        blocked: true,
        reason: "claude_settings_missing",
        exitCode: null,
        stderr: "Claude settings file not found: /repo/missing-settings.json",
      },
      attempt: 1,
      maxRetry: 3,
    });

    assert.equal(outcome.retryMessage, null);
    assert.deepEqual(outcome.result, {
      status: "blocked",
      reason: "claude_settings_missing",
    });
    assert.equal(outcome.transition.result.status, "BLOCKED");
    assert.equal(outcome.transition.result.reason, "claude_settings_missing");
    assert.equal(outcome.transition.prd_update.status, "blocked");
    assert.equal(outcome.transition.prd_update.phase, "provider_preflight");
    assert.equal(outcome.transition.prd_update.phaseDetail, "claude_settings_missing");
  });

  test("buildProviderFailureOutcome fails closed for provider timeout with attempt ledger", () => {
    const outcome = buildProviderFailureOutcome({
      taskId: "FIX-TIMEOUT",
      providerName: "codex",
      providerRun: {
        success: false,
        status: "timed_out",
        reason: "provider_timed_out",
        exitCode: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "[signal:SIGTERM]",
        timedOut: true,
      },
      attempt: 1,
      maxRetry: 0,
    });

    assert.equal(outcome.failReason, "codex 超时");
    assert.deepEqual(outcome.result, {
      status: "failed",
      reason: "codex 超时",
    });
    assert.equal(outcome.transition.result.status, "FAIL");
    assert.equal(outcome.transition.result.provider_status, "timed_out");
    assert.equal(outcome.transition.result.provider_reason, "provider_timed_out");
    assert.equal(outcome.transition.result.attempt_ledger[0].status, "timed_out");
    assert.equal(outcome.transition.result.attempt_ledger[0].task_id, "FIX-TIMEOUT");
    assert.equal(outcome.transition.result.attempt_ledger[0].attempt, 1);
  });

  test("buildProviderFailureOutcome fails closed for fake completion verification failures", () => {
    const outcome = buildProviderFailureOutcome({
      taskId: "FIX-FAKE",
      providerName: "codex",
      providerRun: {
        success: false,
        status: "verification_failed",
        reason: "codex_output_missing",
        exitCode: 0,
        signal: null,
        stdout: "looks done",
        stderr: "",
        timedOut: false,
        output_verification: {
          status: "failed",
          reason: "codex_output_missing",
        },
      },
      attempt: 2,
      maxRetry: 1,
    });

    assert.match(outcome.failReason, /codex 完成验证失败/);
    assert.equal(outcome.result.status, "failed");
    assert.equal(outcome.transition.result.provider_status, "verification_failed");
    assert.equal(outcome.transition.result.provider_reason, "codex_output_missing");
    assert.equal(outcome.transition.result.attempt_ledger[0].status, "verification_failed");
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
    assert.equal(outcome.transition.result.provider_status, "no_output");
    assert.equal(outcome.transition.result.attempt_ledger[0].status, "no_output");
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
    assert.equal(outcome.result.status, "failed");
    assert.equal(outcome.result.reason, "test-generation-validator blocked: new_test_file_forbidden");
    assert.deepEqual(outcome.result.remediation.items, [{ code: "new_test_file_forbidden" }]);
    assert.equal(outcome.result.remediation.blocks_execution, true);
    assert.equal(outcome.transition.result.status, "FAIL");
    assert.equal(outcome.transition.result.retries, 2);
    assert.deepEqual(outcome.transition.prd_update, {
      status: "blocked",
      phase: "test_generation",
      failReason: "test-generation-validator blocked: new_test_file_forbidden",
      testGenerationGate: gate,
    });
  });

  test("buildTestGenerationFailureOutcome exposes validator field, file, and count remediation details", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-test-generation-outcome-"));
    const changedFiles = [{ file: "src/app.ts", status: " M", isNew: false }];
    try {
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "tests", "count.test.js"), "assert.equal(actual, expected);\n", "utf8");

      const missingFieldGate = validateTestGeneration({
        verification_contract: {
          authenticity: { required: true, methods: [] },
        },
      }, { cwd: root, changedFiles });
      const missingFileGate = validateTestGeneration({
        verification_contract: {
          authenticity: {
            required: true,
            methods: [{
              type: "required_marker",
              files: ["tests/missing.test.js"],
              markers: [{ text: "assert.equal" }],
            }],
          },
        },
      }, { cwd: root, changedFiles });
      const countGate = validateTestGeneration({
        verification_contract: {
          authenticity: {
            required: true,
            methods: [{
              type: "assertion_count",
              files: ["tests/count.test.js"],
              minimum: 2,
              markers: [{ text: "assert.equal" }],
            }],
          },
        },
      }, { cwd: root, changedFiles });

      const failures = [
        missingFieldGate.failures.find((failure) => failure.code === "AUTHENTICITY_METHODS_MISSING"),
        missingFileGate.failures.find((failure) => failure.code === "AUTHENTICITY_FILE_MISSING"),
        countGate.failures.find((failure) => failure.code === "AUTHENTICITY_ASSERTION_COUNT_BELOW_MINIMUM"),
      ];
      assert.equal(failures[0]?.missing_field, "verification_contract.authenticity.methods");
      assert.equal(failures[1]?.file, "tests/missing.test.js");
      assert.deepEqual(
        { minimum: failures[2]?.minimum, found: failures[2]?.found },
        { minimum: 2, found: 1 },
      );

      const outcome = buildTestGenerationFailureOutcome({
        taskId: "FIX-AUTHENTICITY",
        testGenerationGate: {
          blocks_execution: true,
          failures,
        },
        attempt: 1,
      });

      assert.equal(outcome.result.status, "failed");
      assert.equal(outcome.result.remediation.source, "test-generation-validator");
      assert.equal(outcome.result.remediation.blocks_execution, true);
      assert.equal(outcome.result.remediation.issue_count, 3);
      assert.equal(
        outcome.result.remediation.items[0].missing_field,
        "verification_contract.authenticity.methods",
      );
      assert.equal(outcome.result.remediation.items[1].file, "tests/missing.test.js");
      assert.deepEqual(
        {
          minimum: outcome.result.remediation.items[2].minimum,
          found: outcome.result.remediation.items[2].found,
        },
        { minimum: 2, found: 1 },
      );
      assert.deepEqual(outcome.transition.result.remediation, outcome.result.remediation);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
