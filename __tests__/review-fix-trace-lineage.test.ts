import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { reviewFindingsToPrdTasks } from "../src/review/findings-to-tasks.js";
import { appendReviewTasksToPrd } from "../src/runtime/review-loop/task-application.js";
import { inspectSpecGovernanceGate } from "../src/runtime/gates/spec-governance-gate.js";
import { inspectYoloCheck } from "../src/runtime/gates/check-report.js";

type Fixture = { review_report_path: string; finding: Record<string, unknown>; prd: Record<string, unknown> };

function loadFixture(): Fixture {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/dogfood-gitweekly-loop12-review-fix-lineage.json"), "utf8")) as Fixture;
}

function generatedLoop12Prd(): Record<string, unknown> {
  const fixture = loadFixture();
  const prd = structuredClone(fixture.prd);
  const converted = reviewFindingsToPrdTasks([fixture.finding], { round: 1, reviewReportPath: fixture.review_report_path });
  appendReviewTasksToPrd({ prd, tasks: converted.tasks, ensureTaskShape: (task) => task });
  return prd;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function strictExecutablePrd(prd: Record<string, unknown>): Record<string, unknown> {
  const tasks = prd.tasks as Array<Record<string, unknown>>;
  const quality_report = { schema_version: "1.0", schema: "yolo.demand.quality.v1", status: "pass", total_score: 100, dimensions: [] };
  Object.assign(tasks.find((task) => task.id === "DEMAND-REQ-001-0010101") as Record<string, unknown>, {
    title: "Implement git weekly CLI",
    priority: "P1",
    type: "feature",
    acceptance_criteria: ["CLI target can be updated safely."],
    post_conditions: [{ id: "POST-DEMAND-TARGET", type: "target_file_modified", severity: "FAIL", params: { file: "src/git-weekly-cli.ts" } }],
  });
  (tasks.find((task) => task.id === "FIX-R1-001") as Record<string, unknown>).status = "done";
  return {
    version: "2.0",
    title: "Loop12 review fix lineage",
    project: { name: "git-weekly", language: "typescript" },
    generated_by: "yolo-demand",
    base_commit: "012cd70",
    source: "approved_demand",
    demand_contract_required: true,
    demand: { id: "DEMAND-LOOP12-GIT-WEEKLY", approval: { approved: true, effective_for_prd: true }, project_facts: { target_files: [{ file: "src/git-weekly-cli.ts", status: "verified" }], assumptions: [] }, quality_report },
    execution_readiness: { level: "L3", afk_ready: true, quality_status: "pass", quality_report },
    ...prd,
  };
}

function blockerCodes(prd: Record<string, unknown>): string[] {
  return inspectSpecGovernanceGate({ prd }).result.blockers.map((blocker) => blocker.code);
}

describe("review fix trace lineage", () => {
  test("loop12 review findings generate fix tasks with inherited spec trace and review finding evidence", () => {
    const prd = generatedLoop12Prd();
    const fixTask = (prd.tasks as Array<Record<string, unknown>>).find((task) => task.id === "FIX-R1-001") as Record<string, unknown>;
    fixTask.status = "done";

    assert.deepEqual(fixTask.requirement_ids, ["REQ-001"]);
    assert.deepEqual(fixTask.design_ids, ["DES-REQ-001"]);
    assert.deepEqual(fixTask.evidence_files, [".yolo/lifecycle/review-report.json#REV-R6-AS-ANY-96D07E271F"]);

    const trace = fixTask.trace as Record<string, unknown>;
    assert.equal(trace.source, "review_finding");
    assert.deepEqual(trace.requirement_ids, ["REQ-001"]);
    assert.deepEqual(trace.design_ids, ["DES-REQ-001"]);
    assert.deepEqual(trace.source_finding_ids, ["REV-R6-AS-ANY-96D07E271F"]);
    assert.deepEqual(trace.inherited_from_task_ids, ["DEMAND-REQ-001-0010101"]);
    assert.deepEqual((trace.evidence as Array<Record<string, unknown>>)[0], {
      type: "review_finding", id: "REV-R6-AS-ANY-96D07E271F", finding_id: "REV-R6-AS-ANY-96D07E271F",
      report_path: ".yolo/lifecycle/review-report.json", round: 1, scanner_id: "R6-as-any", rule_id: "R6-as-any",
      file: "src/git-weekly-cli.ts", line: 92,
    });
    assert.equal(inspectSpecGovernanceGate({ prd }).status, "pass");
  });

  test("generated loop12 review fix PRD passes full yolo check", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-loop12-review-lineage-"));
    try {
      const prdPath = join(root, ".yolo/demand/DEMAND-LOOP12-GIT-WEEKLY/prd.json");
      writeJson(prdPath, strictExecutablePrd(generatedLoop12Prd()));
      const report = inspectYoloCheck({ prdPath, projectRoot: root });
      assert.equal(report.status, "pass");
      assert.equal(report.blockers.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ordinary terminal tasks without trace are still blocked", () => {
    const prd = { requirements: [{ id: "REQ-001", text: "Known requirement." }], designs: [{ id: "DES-REQ-001", text: "Known design." }], tasks: [{ id: "TASK-NO-TRACE", status: "done", task_kind: "implementation", scope: { targets: [{ file: "src/git-weekly-cli.ts" }] } }] };
    assert.deepEqual(blockerCodes(prd), ["MISSING_REQUIREMENT_TRACE", "MISSING_DESIGN_TRACE", "MISSING_TERMINAL_EVIDENCE"]);
  });

  test("review_finding source is blocked when the declared finding record is not traceable", () => {
    const prd = { requirements: [{ id: "REQ-001", text: "Known requirement." }], designs: [{ id: "DES-REQ-001", text: "Known design." }], tasks: [{
      id: "FIX-R1-FORGED", status: "done", task_kind: "review_fix", requirement_ids: ["REQ-001"], design_ids: ["DES-REQ-001"],
      evidence_files: [".yolo/lifecycle/review-report.json#REV-MISSING"],
      trace: { source: "review_finding", requirement_ids: ["REQ-001"], design_ids: ["DES-REQ-001"], source_finding_ids: ["REV-MISSING"], evidence: [{ type: "review_finding", finding_id: "REV-MISSING", report_path: ".yolo/lifecycle/review-report.json" }] },
    }] };
    assert.ok(blockerCodes(prd).includes("INVALID_REVIEW_FINDING_TRACE"));
  });
});
