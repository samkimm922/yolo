import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { preflightPrdDocument } from "../src/prd/preflight.js";

// PRD with acceptance_criteria post_condition (FAIL severity) → produces MANUAL_FAIL_CONDITION warning
// in contract doctor. Warnings are now hard-blocked — no ack bypass exists.
function prdWithManualFailCondition() {
  return {
    version: "2.0",
    id: "PRD-001-WARN-BLOCK-TEST",
    title: "Warning block test",
    project: { name: "test", language: "typescript" },
    generated_by: "yolo-demand",
    generated_at: "2026-06-09T00:00:00.000Z",
    base_commit: "abc1234",
    requirements: [{ id: "REQ-001", text: "Basic requirement." }],
    designs: [{ id: "DES-001", text: "Basic design." }],
    tasks: [{
      id: "IMPL-FEAT-001",
      title: "Implement feature",
      priority: "P2",
      type: "feature",
      task_kind: "atomic_implementation",
      status: "pending",
      requirement_ids: ["REQ-001"],
      design_ids: ["DES-001"],
      scope: { targets: [{ file: "src/foo.ts" }] },
      post_conditions: [
        {
          id: "POST-001",
          type: "target_file_modified",
          severity: "FAIL",
          params: { file: "src/foo.ts" },
        },
        {
          // acceptance_criteria + FAIL severity → MANUAL_FAIL_CONDITION warning
          id: "POST-002",
          type: "acceptance_criteria",
          severity: "FAIL",
          params: { criteria: "Manual check: feature works end-to-end" },
        },
      ],
    }],
  };
}

describe("preflight warning hard-block (no ack bypass)", () => {
  test("warnings block preflight regardless of mode", () => {
    const result = preflightPrdDocument(prdWithManualFailCondition(), { mode: "dev" });
    assert.equal(result.status, "blocked", "warnings must block in dev mode");
    assert.equal(result.blocking_warning_count > 0, true, "warnings must be treated as blocking");
    assert.equal(result.advisory_warning_count, 0, "no advisory warnings — all are blocking");
  });

  test("ackWarnings option is ignored — cannot bypass warning block", () => {
    const result = preflightPrdDocument(prdWithManualFailCondition(), {
      mode: "dev",
      ackWarnings: "deadbeef",
    });
    assert.equal(result.status, "blocked", "ack fingerprint must not bypass the block");
    if ("code" in result) assert.equal(result.code, undefined, "no WARNING_ACK_REQUIRED code — ack mechanism removed");
  });

  test("result never has ack_required field — ack mechanism is deleted", () => {
    const result = preflightPrdDocument(prdWithManualFailCondition(), { mode: "dev" });
    if ("ack_required" in result) assert.equal(result.ack_required, undefined, "ack_required must not appear in result");
    if ("code" in result) assert.equal(result.code, undefined, "no WARNING_ACK_REQUIRED code");
  });

  test("advisory_warnings is always empty — all warnings are blocking", () => {
    const result = preflightPrdDocument(prdWithManualFailCondition(), { mode: "dev" });
    assert.deepEqual(result.advisory_warnings, []);
    assert.equal(result.advisory_warning_count, 0);
  });
});
