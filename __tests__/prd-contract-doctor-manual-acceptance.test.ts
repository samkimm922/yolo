import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inspectPrdContract } from "../src/runtime/gates/prd-contract-doctor.js";

function strictPrd(postConditions = []) {
  return {
    version: "2.0",
    id: "PRD-MANUAL-ACCEPTANCE",
    title: "Manual acceptance contract fixture",
    project: { name: "manual-acceptance", language: "typescript" },
    generated_by: "yolo-demand",
    generated_at: "2026-07-03T00:00:00.000Z",
    base_commit: "abcdef0",
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: "DEMAND-MANUAL-ACCEPTANCE",
      approval: { approved: true, effective_for_prd: true },
      project_facts: {
        target_files: [{ file: "src/a.ts", status: "verified" }],
        assumptions: [],
      },
      quality_report: {
        schema_version: "1.0",
        schema: "yolo.demand.quality.v1",
        status: "pass",
        total_score: 100,
        dimensions: [],
      },
    },
    execution_readiness: {
      level: "L3",
      afk_ready: true,
      quality_status: "pass",
      quality_report: {
        schema_version: "1.0",
        schema: "yolo.demand.quality.v1",
        status: "pass",
        total_score: 100,
        dimensions: [],
      },
    },
    requirements: [{
      id: "REQ-1",
      text: "Keep contract gate strict.",
      demand_trace: { evidence: ["EVID-1"] },
    }],
    designs: [{ id: "DES-1", text: "Use executable gates and explicit manual evidence when needed." }],
    tasks: [{
      id: "TASK-MANUAL-001",
      title: "Manual acceptance fixture task",
      priority: "P1",
      type: "feature",
      task_kind: "atomic_fix",
      status: "pending",
      requirement_ids: ["REQ-1"],
      design_ids: ["DES-1"],
      scope: { targets: [{ file: "src/a.ts" }] },
      post_conditions: [
        {
          id: "POST-TARGET",
          type: "target_file_modified",
          severity: "FAIL",
          params: { file: "src/a.ts" },
        },
        {
          id: "POST-TESTS",
          type: "tests_pass",
          severity: "FAIL",
          params: { command: "npm test" },
        },
        ...postConditions,
      ],
    }],
  };
}

describe("prd contract doctor manual acceptance policy", () => {
  test("blocks prose acceptance_criteria FAIL gates without executable verification", () => {
    const result = inspectPrdContract(strictPrd([
      {
        id: "POST-MANUAL",
        type: "acceptance_criteria",
        severity: "FAIL",
        params: { text: "A human confirms the generated report reads correctly." },
      },
    ]), { mode: "runner", strictExecution: true, requireDemandContract: true });

    assert.equal(result.status, "fail");
    assert.equal(result.blocks_execution, true);
    assert.ok(result.failures.some((failure) => failure.code === "MANUAL_FAIL_CONDITION"));
    assert.equal(result.warnings.some((warning) => warning.code === "MANUAL_FAIL_CONDITION"), false);
  });

  test("allows explicitly declared manual_acceptance criteria to use the signed evidence path", () => {
    const result = inspectPrdContract(strictPrd([
      {
        id: "POST-MANUAL-DECLARED",
        type: "acceptance_criteria",
        severity: "FAIL",
        params: { text: "Product owner signs the launch copy." },
        manual_acceptance: {
          required: true,
          evidence_type: "manual_acceptance",
          signed_evidence_required: true,
        },
      },
    ]), { mode: "runner", strictExecution: true, requireDemandContract: true });

    assert.equal(result.status, "pass", JSON.stringify({ failures: result.failures, warnings: result.warnings }, null, 2));
    assert.equal(result.blocks_execution, false, JSON.stringify(result.failures, null, 2));
    assert.equal(result.failures.some((failure) => failure.code === "MANUAL_FAIL_CONDITION"), false);
    assert.equal(result.warnings.some((warning) => warning.code === "MANUAL_FAIL_CONDITION"), false);
  });
});
