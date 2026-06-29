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
    generated_by: "yolo-demand",
    generated_at: "2026-05-24T00:00:00.000Z",
    base_commit: "abcdef0",
    source: "approved_demand",
    demand_contract_required: true,
    provider_capability: { opt_out: true },
    demand: {
      id: "DEMAND-PRE-EXEC",
      approval: { approved: true, effective_for_prd: true },
      project_facts: {
        target_files: [{ file: "src/a.js", status: "verified" }],
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
      text: "Keep gates strict",
      demand_trace: { evidence: ["EVID-1"] },
    }],
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
      post_conditions: [
        {
          id: "POST-FILE",
          type: "file_exists",
          severity: "FAIL",
          params: { file: "src/a.js" },
        },
        {
          id: "POST-TYPECHECK",
          type: "no_new_type_errors",
          severity: "FAIL",
          params: { command: "npm run typecheck" },
        },
      ],
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
        config: {},
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
        config: {},
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

  test("YB-001 blocks runner when the demand contract is missing", () => {
    const paths = makePaths();
    try {
      const result = inspectPreExecutionGates({
        prd: strictPrd({
          source: undefined,
          demand_contract_required: undefined,
          demand: undefined,
          execution_readiness: undefined,
          requirements: [{ id: "REQ-1", text: "Keep gates strict" }],
        }),
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
        config: {},
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.stage, "contract");
      assert.equal(result.exit_code, 1);
      assert.ok(result.contract.doctor.failures.some((failure) => failure.code === "DEMAND_CONTRACT_MISSING"));
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });

  test("YB-002 blocks investigate-first tasks before runner execution", () => {
    const paths = makePaths();
    try {
      const result = inspectPreExecutionGates({
        prd: strictPrd({
          tasks: [{
            id: "FIX-PRE-EXEC-002",
            title: "Investigate first task",
            priority: "P1",
            type: "bugfix",
            task_kind: "atomic_fix",
            status: "pending",
            requirement_ids: ["REQ-1"],
            design_ids: ["DES-1"],
            scope: { targets: [{ file: "src/a.js" }, { file: "src/b.js" }] },
            post_conditions: [
              { id: "POST-A", type: "target_file_modified", severity: "FAIL", params: { file: "src/a.js" } },
              { id: "POST-B", type: "target_file_modified", severity: "FAIL", params: { file: "src/b.js" } },
            ],
          }],
        }),
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
        config: {},
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.stage, "contract");
      assert.ok(result.contract.doctor.failures.some((failure) => failure.code === "ATOMICITY_INVESTIGATE_FIRST" && failure.human_needed === true));
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });

  test("YB-003 blocks tasks missing files and acceptance before runner execution", () => {
    const paths = makePaths();
    try {
      const result = inspectPreExecutionGates({
        prd: strictPrd({
          tasks: [{
            id: "FIX-PRE-EXEC-003",
            title: "Missing contract task",
            priority: "P1",
            type: "bugfix",
            task_kind: "atomic_fix",
            status: "pending",
            requirement_ids: ["REQ-1"],
            design_ids: ["DES-1"],
            scope: { targets: [] },
            acceptance_criteria: [],
            post_conditions: [],
          }],
        }),
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
        config: {},
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.stage, "contract");
      assert.ok(result.contract.doctor.failures.some((failure) => failure.code === "TASK_MISSING_FILES"));
      assert.ok(result.contract.doctor.failures.some((failure) => failure.code === "TASK_MISSING_ACCEPTANCE"));
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });

  test("blocks contract warnings instead of entering runner execution", () => {
    const paths = makePaths();
    try {
      const prd = strictPrd();
      prd.tasks[0].post_conditions.push({
        id: "POST-MANUAL",
        type: "acceptance_criteria",
        severity: "FAIL",
        params: { command: "manual review" },
      });

      const result = inspectPreExecutionGates({
        prd,
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
        config: {},
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.stage, "contract");
      assert.equal(result.code, "PRD_CONTRACT_WARNING_BLOCKED");
      assert.equal(result.exit_code, 2);
      assert.equal(result.contract.status, "warning");
      assert.ok(result.contract.doctor.warnings.some((warning) => warning.code === "MANUAL_FAIL_CONDITION"));
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
        config: {},
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
