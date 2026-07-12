import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGateRemediationPlan,
  classifyGateRemediationIssue,
  GATE_REMEDIATION_ACTIONS,
} from "../src/runtime/gates/remediation-plan.js";

describe("gate remediation plan", () => {
  test("routes retryable gate failures to retry with context while keeping ship blocked", () => {
    const plan = buildGateRemediationPlan({
      source: "runner-gate",
      task: { id: "FIX-1" },
      gateExitCode: 1,
      attempt: 1,
      maxRetry: 3,
      decisionAction: "retry",
      failures: [{ type: "eslint", detail: "no-unused-vars", rules: ["eslint"] }],
    });

    assert.equal(plan.schema, "yolo.gate.remediation_plan.v1");
    assert.equal(plan.gate_strength, "strict");
    assert.equal(plan.action, GATE_REMEDIATION_ACTIONS.RETRY_WITH_CONTEXT);
    assert.equal(plan.automation_can_continue, true);
    assert.equal(plan.blocks_ship, true);
    assert.equal(plan.items[0].task_id, "FIX-1");
  });

  test("routes an undeclared toolchain failure by non-zero gate status", () => {
    const plan = buildGateRemediationPlan({
      source: "runner-gate",
      gateExitCode: 2,
      failures: [{ type: "cargo", detail: "unresolved import" }],
    });

    assert.equal(plan.action, GATE_REMEDIATION_ACTIONS.RETRY_WITH_CONTEXT);
    assert.equal(plan.automation_can_continue, true);
  });

  test("routes exhausted retries to review fix instead of weakening the gate", () => {
    const plan = buildGateRemediationPlan({
      source: "runner-gate",
      taskId: "FIX-2",
      decisionAction: "max_retry",
      failures: [{ type: "vitest", detail: "test failed" }],
    });

    assert.equal(plan.action, GATE_REMEDIATION_ACTIONS.REROUTE_REVIEW_FIX);
    assert.equal(plan.automation_can_continue, true);
    assert.equal(plan.requires_human, false);
    assert.match(plan.next_actions[0], /review\/fix task/);
  });

  test("keeps unsafe or human-required work as hard stops", () => {
    const unsafe = classifyGateRemediationIssue({
      code: "SECRET_DETECTED",
      message: "api_key leaked",
    });
    const human = classifyGateRemediationIssue({
      code: "PM_REQUIREMENTS_MISSING",
      message: "requirements missing",
    });

    assert.equal(unsafe.action, GATE_REMEDIATION_ACTIONS.STOP_UNSAFE);
    assert.equal(unsafe.automation_can_continue, false);
    assert.equal(human.action, GATE_REMEDIATION_ACTIONS.ASK_HUMAN);
    assert.equal(human.requires_human, true);
  });

  test("does not misclassify demand-contract blockers as STOP_UNSAFE due to bare 'release' substring", () => {
    // RED: the isUnsafeIssue regex matched the bare word "release", so any
    // message mentioning "runner/release execution" was misclassified as
    // STOP_UNSAFE — e.g. "Runner/release execution requires an approved demand
    // contract." The only next_action for STOP_UNSAFE is "get explicit approval"
    // which cannot create the missing demand contract, session, facts, or
    // quality report.
    const demandMissing = classifyGateRemediationIssue({
      code: "DEMAND_CONTRACT_MISSING",
      message: "Runner/release execution requires an approved demand contract.",
    });
    assert.notEqual(demandMissing.action, GATE_REMEDIATION_ACTIONS.STOP_UNSAFE,
      "demand contract blocker must not be classified as STOP_UNSAFE");
  });

  test("routes structural PRD gaps to bounded auto remediation", () => {
    const plan = buildGateRemediationPlan({
      source: "yolo-check",
      blockers: [
        { code: "UI_EVIDENCE_PLAN_MISSING", gate: "ui_readiness", task_id: "UI-1", message: "missing evidence plan" },
        { code: "EVIDENCE_POST_CONDITIONS_MISSING", gate: "evidence_plan", task_id: "UI-1", message: "missing post conditions" },
      ],
    });

    assert.equal(plan.action, GATE_REMEDIATION_ACTIONS.AUTO_REMEDIATE);
    assert.equal(plan.automation_can_continue, true);
    assert.equal(plan.items.every((item) => item.blocks_ship), true);
  });

  test("keeps contract-derived structural gaps schedulable when a migration can fix them", () => {
    const plan = buildGateRemediationPlan({
      source: "runner-preflight",
      blockers: [{
        source: "contract",
        code: "TASK_TARGETS_MISSING_EXECUTABLE_COVERAGE",
        task_id: "FIX-1",
        detail: "target coverage missing",
      }],
    });

    assert.equal(plan.action, GATE_REMEDIATION_ACTIONS.AUTO_REMEDIATE);
    assert.equal(plan.automation_can_continue, true);
    assert.equal(plan.requires_human, false);
  });

  test("warning-only plans fail closed instead of reporting automation can continue", () => {
    const plan = buildGateRemediationPlan({
      source: "yolo-check",
      warnings: [{ code: "DEMAND_CONTRACT_MISSING", message: "Demand contract missing in advisory mode." }],
    });

    assert.equal(plan.action, GATE_REMEDIATION_ACTIONS.ASK_HUMAN);
    assert.equal(plan.automation_can_continue, false);
    assert.equal(plan.requires_human, true);
    assert.equal(plan.blocks_ship, true);
    assert.match(plan.summary, /automation is blocked/);
  });
});
