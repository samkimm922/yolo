import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrecheckValidSkipOutcome,
  precheckErrorMessage,
  precheckInvalidSkipMessage,
  precheckRequestedSkip,
} from "../src/runtime/execution/precheck-outcome.js";

describe("precheck outcome helpers", () => {
  test("precheckRequestedSkip detects PRE-CHECK SKIP stdout", () => {
    assert.equal(precheckRequestedSkip({ stdout: "PRE-CHECK SKIP\nalready fixed" }), true);
    assert.equal(precheckRequestedSkip({ stdout: "run failed" }), false);
    assert.equal(precheckRequestedSkip({}), false);
  });

  test("buildPrecheckValidSkipOutcome creates valid-skip transition and result", () => {
    const outcome = buildPrecheckValidSkipOutcome({
      task: {
        id: "FIX-1",
        scope: { targets: [{ file: "src/a.ts" }] },
      },
    });

    assert.equal(outcome.logMessage, "precheck: 已修复，post_conditions 已满足，跳过");
    assert.deepEqual(outcome.result, {
      status: "skipped",
      skip_kind: "valid_skip_already_satisfied",
      counts_as_completed: true,
      reason: "precheck",
    });
    assert.equal(outcome.transition.result.status, "SKIP");
    assert.equal(outcome.transition.result.reason, "precheck: 目标模式已不存在且 post_conditions 已满足");
    assert.equal(outcome.transition.result.postcondition_verified, true);
    assert.deepEqual(outcome.transition.prd_update, {
      status: "skipped",
      scope: {
        targets: [{ file: "src/a.ts" }],
        expected_zero_business_code: true,
      },
      skip_kind: "valid_skip_already_satisfied",
      counts_as_completed: true,
      phase: "done",
      phaseDetail: "precheck: 目标模式已不存在且 post_conditions 已满足",
    });
  });

  test("precheckInvalidSkipMessage lists failed postconditions", () => {
    assert.equal(
      precheckInvalidSkipMessage({ failed: ["code_contains: missing", "tests_pass: failed"] }),
      "precheck 想跳过，但 post_conditions 未满足: code_contains: missing; tests_pass: failed，继续执行修复",
    );
  });

  test("precheckErrorMessage reports stderr, stdout, or unknown for failed precheck", () => {
    assert.equal(precheckErrorMessage({ ok: true }), null);
    assert.equal(precheckErrorMessage({ ok: false, stderr: "boom" }), "precheck 错误: boom，继续执行");
    assert.equal(precheckErrorMessage({ ok: false, stdout: "x".repeat(120) }), `precheck 错误: ${"x".repeat(100)}，继续执行`);
    assert.equal(precheckErrorMessage({ ok: false }), "precheck 错误: unknown，继续执行");
  });
});
