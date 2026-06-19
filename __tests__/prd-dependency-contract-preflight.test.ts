import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPrdContract, preflightPrd } from "../sdk.js";

function dependencyPrd(taskOverrides = {}) {
  return {
    version: "2.0",
    id: "PRD-DEPENDENCY-GATE",
    title: "Dependency gate",
    project: { name: "test", language: "typescript" },
    generated_by: "yolo-review-agent",
    generated_at: "2026-06-05T00:00:00.000Z",
    base_commit: "abcdef0",
    requirements: [{ id: "REQ-DEP-001", text: "Block missing task dependencies." }],
    designs: [{ id: "DES-DEP-001", text: "Treat dangling depends_on entries as contract blockers." }],
    tasks: [{
      id: "FIX-DEP-001",
      title: "Wire dependency gate",
      priority: "P2",
      type: "bugfix",
      task_kind: "atomic_fix",
      status: "pending",
      requirement_ids: ["REQ-DEP-001"],
      design_ids: ["DES-DEP-001"],
      depends_on: ["MISSING"],
      scope: { targets: [{ file: "src/runtime/gates/prd-contract-doctor.ts" }] },
      post_conditions: [{
        id: "POST-TARGET",
        type: "target_file_modified",
        severity: "FAIL",
        params: { file: "src/runtime/gates/prd-contract-doctor.ts" },
      }],
      ...taskOverrides,
    }],
  };
}

describe("PRD dependency contract preflight", () => {
  test("inspectPrdContract blocks tasks with missing depends_on references", () => {
    const result = inspectPrdContract(dependencyPrd());
    const dependencyFailure = result.failures.find((failure) => failure.code === "TASK_DEPENDENCY_MISSING");

    assert.equal(result.blocks_execution, true);
    assert.equal(dependencyFailure?.task_id, "FIX-DEP-001");
    assert.equal(dependencyFailure?.dependency_id, "MISSING");
    assert.match(dependencyFailure?.detail || "", /MISSING/);
  });

  test("inspectPrdContract checks dependencies alias when depends_on is absent", () => {
    const result = inspectPrdContract(dependencyPrd({
      depends_on: undefined,
      dependencies: ["MISSING_ALIAS"],
    }));
    const dependencyFailure = result.failures.find((failure) => failure.code === "TASK_DEPENDENCY_MISSING");

    assert.equal(result.blocks_execution, true);
    assert.equal(dependencyFailure?.dependency_id, "MISSING_ALIAS");
  });

  test("inspectPrdContract merges dependencies alias when depends_on is empty", () => {
    const result = inspectPrdContract(dependencyPrd({
      depends_on: [],
      dependencies: ["MISSING_ALIAS"],
    }));
    const dependencyFailure = result.failures.find((failure) => failure.code === "TASK_DEPENDENCY_MISSING");

    assert.equal(result.blocks_execution, true);
    assert.equal(dependencyFailure?.dependency_id, "MISSING_ALIAS");
  });

  test("preflightPrd reports missing task dependencies as blocked reasons", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-prd-dependency-preflight-"));
    try {
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, `${JSON.stringify(dependencyPrd(), null, 2)}\n`, "utf8");

      const report = preflightPrd(prdPath);
      const reason = report.blocked_reasons.find((item) => item.code === "TASK_DEPENDENCY_MISSING");

      assert.equal(report.status, "blocked");
      assert.equal(report.contract.blocks_execution, true);
      assert.equal(report.spec_governance.blocks_execution, false);
      assert.equal(report.runner_readiness.can_execute, false);
      assert.equal(reason?.source, "contract");
      assert.equal(reason?.task_id, "FIX-DEP-001");
      assert.match(reason?.detail || "", /MISSING/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preflightPrd blocks fully connected dependency graphs with no executable root", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-prd-dependency-cycle-"));
    try {
      const prdPath = join(root, "prd.json");
      const task = (id, depends_on, file) => ({
        ...dependencyPrd({ id, depends_on, scope: { targets: [{ file }] } }).tasks[0],
        post_conditions: [{
          id: `POST-${id}`,
          type: "target_file_modified",
          severity: "FAIL",
          params: { file },
        }],
      });
      const prd = dependencyPrd({ depends_on: [] });
      prd.tasks = [
        task("A", ["B", "C"], "src/a.ts"),
        task("B", ["A", "C"], "src/b.ts"),
        task("C", ["A", "B"], "src/c.ts"),
      ];
      writeFileSync(prdPath, `${JSON.stringify(prd, null, 2)}\n`, "utf8");

      const report = preflightPrd(prdPath);

      assert.equal(report.status, "blocked");
      assert.equal(report.contract.blocks_execution, true);
      assert.ok(report.blocked_reasons.some((item) => item.code === "TASK_DEPENDENCY_NO_ROOT"));
      assert.ok(report.blocked_reasons.some((item) => item.code === "TASK_DEPENDENCY_CYCLE"));
      assert.equal(report.runner_readiness.can_execute, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
