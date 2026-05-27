import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectPreExecutionGates } from "../src/runtime/gates/pre-execution-gates.js";

function makePaths() {
  const projectRoot = mkdtempSync(join(tmpdir(), "yolo-pre-exec-gates-"));
  const yoloRoot = join(projectRoot, "scripts/yolo");
  return {
    projectRoot,
    yoloRoot,
    stateDir: join(yoloRoot, "state"),
    prdPath: join(yoloRoot, "data/prd.json"),
  };
}

function strictPrd(overrides = {}) {
  return {
    version: "2.0",
    id: "PRD-PRE-EXEC",
    title: "Pre execution gate fixture",
    project: { name: "test", language: "javascript" },
    generated_by: "test",
    generated_at: "2026-05-24T00:00:00.000Z",
    base_commit: "abcdef0",
    requirements: [{ id: "REQ-1", text: "Keep gates strict" }],
    designs: [{ id: "DES-1", text: "Use file-exists smoke target" }],
    tasks: [{
      id: "FIX-PRE-EXEC-001",
      title: "Strict task",
      priority: "P1",
      type: "bugfix",
      task_kind: "atomic_fix",
      status: "pending",
      requirement_ids: ["REQ-1"],
      design_ids: ["DES-1"],
      scope: { targets: [{ file: "src/a.js" }] },
      post_conditions: [{
        id: "POST-FILE",
        type: "file_exists",
        severity: "FAIL",
        params: { file: "src/a.js" },
      }],
    }],
    ...overrides,
  };
}

describe("pre-execution gates", () => {
  test("blocks planning-only PRDs at contract stage before spec gate", () => {
    const paths = makePaths();
    try {
      const result = inspectPreExecutionGates({
        prd: { id: "PRD-PLAN", execution_mode: "planning_only", tasks: [] },
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.stage, "contract");
      assert.equal(result.code, "PLANNING_ONLY_PRD");
      assert.equal(result.spec, null);
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });

  test("blocks weak spec after contract gate passes", () => {
    const paths = makePaths();
    try {
      const prd = strictPrd({
        requirements: [],
        designs: [],
      });
      delete prd.tasks[0].requirement_ids;
      delete prd.tasks[0].design_ids;

      const result = inspectPreExecutionGates({
        prd,
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.stage, "spec");
      assert.equal(result.code, "PRD_SPEC_GOVERNANCE_BLOCKED");
      assert.equal(result.contract.status, "pass");
      assert.equal(result.spec.result.blocks_execution, true);
      assert.match(result.messages.join("\n"), /MISSING_REQUIREMENT_TRACE/);
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });

  test("passes when contract and spec gates both pass", () => {
    const paths = makePaths();
    try {
      const result = inspectPreExecutionGates({
        prd: strictPrd(),
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
      });

      assert.equal(result.status, "pass");
      assert.equal(result.stage, "ready");
      assert.equal(result.contract.status, "pass");
      assert.equal(result.spec.status, "pass");
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });
});
