import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { preflightPrdDocument } from "../src/prd/preflight.js";

// PRD with acceptance_criteria post_condition (FAIL severity) → always produces MANUAL_FAIL_CONDITION warning
// in contract doctor. In non-strict mode (mode="dev") this becomes an advisory warning, triggering ack gate.
function prdWithManualFailCondition() {
  return {
    version: "2.0",
    id: "PRD-001-WARN-ACK-TEST",
    title: "Warning ack test",
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

// Non-strict mode: warnings become advisory (not blocking by default)
const NON_STRICT_OPTS = { mode: "dev", strictExecution: false };

describe("preflight warning soft-block (fingerprint ack)", () => {
  test("advisory warnings without ack must return WARNING_ACK_REQUIRED blocked", () => {
    const result = preflightPrdDocument(prdWithManualFailCondition(), NON_STRICT_OPTS);
    assert.equal(result.advisory_warning_count, 1, "PRD must produce exactly 1 advisory warning");
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "WARNING_ACK_REQUIRED");
    assert.match(result.ack_required, /^[0-9a-f]{8}$/);
    assert.ok(result.message.includes(result.ack_required));
  });

  test("advisory warnings with correct ack fingerprint allows warning status through", () => {
    const first = preflightPrdDocument(prdWithManualFailCondition(), NON_STRICT_OPTS);
    assert.equal(first.code, "WARNING_ACK_REQUIRED");
    const ack = first.ack_required;

    const result = preflightPrdDocument(prdWithManualFailCondition(), { ...NON_STRICT_OPTS, ackWarnings: ack });
    assert.equal(result.status, "warning", "with correct ack, advisory warnings should produce warning status (not blocked)");
    assert.ok(result.advisory_warning_count > 0);
  });

  test("wrong ack fingerprint still blocks", () => {
    const result = preflightPrdDocument(prdWithManualFailCondition(), { ...NON_STRICT_OPTS, ackWarnings: "deadbeef" });
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "WARNING_ACK_REQUIRED");
  });

  test("strict mode warnings become hard-blocked (unchanged behavior)", () => {
    // In strict mode, acceptance_criteria FAIL condition goes to unsupported-type failures
    // or is still a warning — either way, ack must not be required
    const result = preflightPrdDocument(prdWithManualFailCondition(), { mode: "verify", strictExecution: true });
    assert.notEqual(result.code, "WARNING_ACK_REQUIRED", "strict mode must not produce ack-required");
  });

  test("PRD with no warnings passes without ack", () => {
    const prd = {
      ...prdWithManualFailCondition(),
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
        post_conditions: [{
          id: "POST-001",
          type: "target_file_modified",
          severity: "FAIL",
          params: { file: "src/foo.ts" },
        }],
      }],
    };
    const result = preflightPrdDocument(prd, NON_STRICT_OPTS);
    assert.notEqual(result.code, "WARNING_ACK_REQUIRED");
    assert.equal(result.status, "pass");
  });
});
