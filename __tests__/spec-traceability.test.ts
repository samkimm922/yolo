import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTraceabilityMatrix,
  inspectSpecGovernance,
} from "../src/spec/traceability.js";

describe("spec traceability", () => {
  test("buildTraceabilityMatrix links requirements, designs, tasks, evidence, and targets", () => {
    const matrix = buildTraceabilityMatrix({
      id: "PRD-20260524-SPEC",
      generated_at: "2026-05-24T00:00:00.000Z",
      requirements: [{ id: "REQ-1" }],
      designs: ["DES-1"],
      tasks: [{
        id: "FIX-SPEC-001",
        status: "completed",
        requirement_ids: ["REQ-1"],
        trace: { designs: [{ id: "DES-1" }] },
        evidence_files: ["state/evidence/FIX-SPEC-001/result.json"],
        scope: { targets: [{ file: "src/spec/traceability.js:10-20" }] },
      }],
    });

    assert.equal(matrix.prd_id, "PRD-20260524-SPEC");
    assert.deepEqual(matrix.requirements, ["REQ-1"]);
    assert.deepEqual(matrix.designs, ["DES-1"]);
    assert.deepEqual(matrix.tasks[0], {
      task_id: "FIX-SPEC-001",
      status: "completed",
      requirement_ids: ["REQ-1"],
      design_ids: ["DES-1"],
      evidence_files: ["state/evidence/FIX-SPEC-001/result.json"],
      target_files: ["src/spec/traceability.js"],
      missing: {
        requirements: false,
        design: false,
        evidence: false,
        dangling_requirements: [],
        dangling_design: [],
      },
    });
    assert.equal(matrix.summary.task_count, 1);
    assert.deepEqual(matrix.summary.missing_requirements, []);
  });

  test("inspectSpecGovernance can block weak spec traces when policy requires them", () => {
    const result = inspectSpecGovernance({
      tasks: [{
        id: "FIX-SPEC-002",
        status: "done",
        scope: { targets: [{ file: "src/a.ts" }] },
      }],
    }, {
      requireRequirements: true,
      requireDesign: true,
      requireEvidenceForTerminal: true,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blocks_execution, true);
    assert.deepEqual(result.blockers.map((blocker) => blocker.code), [
      "MISSING_REQUIREMENT_TRACE",
      "MISSING_DESIGN_TRACE",
      "MISSING_TERMINAL_EVIDENCE",
    ]);
  });

  test("inspectSpecGovernance reports warnings without blocking when policy is advisory", () => {
    const result = inspectSpecGovernance({
      tasks: [{ id: "FIX-SPEC-003", status: "pending" }],
    });

    assert.equal(result.status, "warning");
    assert.equal(result.blocks_execution, false);
    assert.deepEqual(result.warnings.map((warning) => warning.code), [
      "MISSING_REQUIREMENT_TRACE",
      "MISSING_DESIGN_TRACE",
    ]);
  });

  test("negative: dangling requirement and design traces are blocked when policy requires real refs", () => {
    const result = inspectSpecGovernance({
      requirements: [{ id: "REQ-1", text: "Known requirement." }],
      designs: [{ id: "DES-1", text: "Known design." }],
      tasks: [{
        id: "FIX-SPEC-DANGLING",
        status: "pending",
        requirement_ids: ["REQ-MISSING"],
        design_ids: ["DES-MISSING"],
      }],
    }, {
      requireRequirements: true,
      requireDesign: true,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blocks_execution, true);
    assert.deepEqual(result.blockers.map((blocker) => blocker.code), [
      "DANGLING_REQUIREMENT_TRACE",
      "DANGLING_DESIGN_TRACE",
    ]);
    assert.deepEqual(result.matrix.summary.dangling_requirements, [{
      task_id: "FIX-SPEC-DANGLING",
      requirement_ids: ["REQ-MISSING"],
    }]);
  });
});
