import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  formatSpecGovernanceBlockers,
  inspectSpecGovernanceGate,
  specGovernancePolicy,
} from "../src/runtime/gates/spec-governance-gate.js";

describe("spec governance gate", () => {
  test("defaults to fail-closed trace requirements", () => {
    assert.deepEqual(specGovernancePolicy(), {
      requireRequirements: true,
      requireDesign: true,
      requireEvidenceForTerminal: true,
    });
  });

  test("returns a blocked gate for tasks without required spec traces", () => {
    const gate = inspectSpecGovernanceGate({
      prd: {
        tasks: [{
          id: "FIX-SPEC-GATE-001",
          status: "pending",
        }],
      },
    });

    assert.equal(gate.status, "blocked");
    assert.equal(gate.code, "PRD_SPEC_GOVERNANCE_BLOCKED");
    assert.equal(gate.exit_code, 1);
    assert.equal(gate.result.blocks_execution, true);
    assert.deepEqual(gate.result.blockers.map((blocker) => blocker.code), [
      "MISSING_REQUIREMENT_TRACE",
      "MISSING_DESIGN_TRACE",
    ]);
    assert.match(gate.summary, /MISSING_REQUIREMENT_TRACE task=FIX-SPEC-GATE-001/);
  });

  test("passes when pending tasks link requirement and design traces", () => {
    const gate = inspectSpecGovernanceGate({
      prd: {
        requirements: [{ id: "REQ-1", text: "Known requirement." }],
        designs: [{ id: "DES-1", text: "Known design." }],
        tasks: [{
          id: "FIX-SPEC-GATE-002",
          status: "pending",
          requirement_ids: ["REQ-1"],
          design_ids: ["DES-1"],
        }],
      },
    });

    assert.equal(gate.status, "pass");
    assert.equal(gate.code, "PRD_SPEC_GOVERNANCE_PASS");
    assert.equal(gate.exit_code, 0);
    assert.equal(gate.result.blocks_execution, false);
    assert.equal(gate.summary, "");
  });

  test("negative: dangling requirement/design refs block execution", () => {
    const gate = inspectSpecGovernanceGate({
      prd: {
        requirements: [{ id: "REQ-1", text: "Known requirement." }],
        designs: [{ id: "DES-1", text: "Known design." }],
        tasks: [{
          id: "FIX-SPEC-GATE-DANGLING",
          status: "pending",
          requirement_ids: ["REQ-MISSING"],
          design_ids: ["DES-MISSING"],
        }],
      },
    });

    assert.equal(gate.status, "blocked");
    assert.deepEqual(gate.result.blockers.map((blocker) => blocker.code), [
      "DANGLING_REQUIREMENT_TRACE",
      "DANGLING_DESIGN_TRACE",
    ]);
    assert.match(gate.summary, /DANGLING_REQUIREMENT_TRACE task=FIX-SPEC-GATE-DANGLING/);
  });

  test("formats blocker summaries with a hard display limit", () => {
    const blockers = Array.from({ length: 10 }, (_, index) => ({
      code: `BLOCK_${index}`,
      task_id: `FIX-${index}`,
      message: `message ${index}`,
    }));

    const summary = formatSpecGovernanceBlockers(blockers, 3);

    assert.equal(summary.split("\n").length, 3);
    assert.match(summary, /BLOCK_0 task=FIX-0: message 0/);
    assert.doesNotMatch(summary, /BLOCK_3/);
  });

  test("PR-R1 removes yolo-owned acceptance generation and demand scaffold entrypoints", () => {
    assert.equal(existsSync("src/demand/acceptance-test-generator.ts"), false);

    const runtimeSource = readFileSync("src/demand/runtime.ts", "utf8");
    assert.doesNotMatch(runtimeSource, /acceptance-test-generator/);
    assert.doesNotMatch(runtimeSource, /generateAcceptanceTestFile|buildGeneratedAcceptanceTestRecord/);
    assert.doesNotMatch(runtimeSource, /buildGreenfieldScaffoldTask|addScaffoldDependency/);
  });
});
