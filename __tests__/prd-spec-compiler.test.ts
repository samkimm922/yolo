import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { compileDiscoveryPlanToSpec } from "../src/prd/spec-compiler.js";

describe("PRD spec compiler", () => {
  test("compiles discovery and plan into traceable spec lifecycle and PRD", () => {
    const result = compileDiscoveryPlanToSpec({
      discovery: {
        idea: "For store managers, add inventory alerts so low stock is visible before checkout.",
        success_criteria: ["alert appears when stock is below threshold"],
        constraints: ["do not change checkout behavior"],
      },
      plan: {
        title: "Inventory alerts",
        approach: "Add a small alert service and expose it through the existing inventory API.",
        tasks: [
          {
            id: "TASK-001",
            title: "Add alert service",
            scope: { targets: [{ file: "src/inventory/alerts.js" }] },
            post_conditions: [
              {
                id: "POST-FILE",
                type: "file_exists",
                severity: "FAIL",
                params: { file: "src/inventory/alerts.js" },
              },
            ],
          },
        ],
      },
    }, {
      generated_at: "2026-05-25T00:00:00.000Z",
    });

    assert.equal(result.status, "draft");
    assert.equal(result.executable, false);
    assert.equal(result.validation.blocks_execution, false);
    assert.equal(result.spec.requirements[0].id, "REQ-001");
    assert.equal(result.prd.tasks[0].requirement_ids[0], "REQ-001");
    assert.equal(result.prd.tasks[0].status, "needs_contract_review");
    assert.equal(result.prd.demand.approval.approved, false);
    assert.equal(result.prd.execution_readiness.afk_ready, false);
    assert.equal(result.guarantees.provider_execution, false);
  });

  test("blocks missing tasks instead of generating a weak PRD", () => {
    const result = compileDiscoveryPlanToSpec({
      discovery: { idea: "Add inventory alerts" },
      plan: { title: "Inventory alerts" },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.prd, null);
    assert.ok(result.blockers.some((blocker) => blocker.code === "SPEC_COMPILER_TASKS_MISSING"));
  });
});
