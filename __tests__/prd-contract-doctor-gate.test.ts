import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectPrdContractDoctorGate } from "../src/runtime/gates/prd-contract-doctor-gate.js";

function makePaths() {
  const projectRoot = mkdtempSync(join(tmpdir(), "yolo-prd-contract-gate-"));
  const yoloRoot = join(projectRoot, "scripts/yolo");
  return {
    projectRoot,
    yoloRoot,
    stateDir: join(yoloRoot, "state"),
    prdPath: join(yoloRoot, "data/prd.json"),
  };
}

function strictDemandFields(targetFile = "src/a.ts") {
  return {
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: "DEMAND-GATE",
      approval: { approved: true, effective_for_prd: true },
      project_facts: {
        target_files: [{ file: targetFile, status: "verified" }],
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
      id: "REQ-GATE-1",
      text: "Keep contract gate strict.",
      demand_trace: { evidence: ["EVID-1"] },
    }],
  };
}

describe("prd contract doctor gate", () => {
  test("blocks planning-only PRDs before writing evidence", () => {
    const paths = makePaths();
    try {
      const result = inspectPrdContractDoctorGate({
        prd: { id: "PRD-PLAN", execution_mode: "planning_only", tasks: [] },
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.code, "PLANNING_ONLY_PRD");
      assert.equal(result.evidence_file, null);
      assert.match(result.message, /planning_only PRD cannot be executed/);
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });

  test("blocks weak executable PRDs with migration advice and evidence", () => {
    const paths = makePaths();
    try {
      const prd = {
        version: "2.0",
        id: "PRD-BLOCKED",
        ...strictDemandFields("src/a.ts"),
        tasks: [{
          id: "FIX-GATE-001",
          title: "Weak gate task",
          priority: "P1",
          type: "bugfix",
          status: "pending",
          requirement_ids: ["REQ-GATE-1"],
          scope: { targets: [{ file: "src/a.ts" }] },
          post_conditions: [{
            id: "POST-TSC",
            type: "no_new_type_errors",
            severity: "FAIL",
            params: { command: "npm run typecheck" },
          }],
        }],
      };

      const result = inspectPrdContractDoctorGate({
        prd,
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.code, "PRD_CONTRACT_BLOCKED");
      assert.equal(result.migration.available, true);
      assert.equal(result.migration.would_fix_contract, true);
      assert.match(result.messages.join("\n"), /migration apply:/);
      assert.match(result.evidence_file, /^scripts\/yolo\/state\/evidence\/prd-contract-doctor\/PRD-BLOCKED-\d+\.json$/);
      assert.equal(existsSync(result.evidence_path), true);
      const evidence = JSON.parse(readFileSync(result.evidence_path, "utf8"));
      assert.equal(evidence.prd, "data/prd.json");
      assert.equal(evidence.blocks_execution, true);
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });

  test("blocks approved-demand PRDs when demand quality is blocked", () => {
    const paths = makePaths();
    try {
      const prd = {
        version: "2.0",
        id: "PRD-DEMAND-QUALITY-BLOCKED",
        source: "approved_demand",
        demand_contract_required: true,
        demand: {
          id: "DEMAND-QUALITY",
          approval: { approved: true },
          quality_report: {
            schema_version: "1.0",
            schema: "yolo.demand.quality.v1",
            status: "pass",
            total_score: 100,
            dimensions: [],
          },
          execution_readiness: {
            quality_report: {
              schema_version: "1.0",
              schema: "yolo.demand.quality.v1",
              status: "blocked",
              total_score: 40,
              dimensions: [],
            },
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
        tasks: [{
          id: "FIX-GATE-003",
          title: "Strict task",
          priority: "P1",
          type: "bugfix",
          status: "pending",
          scope: { targets: [{ file: "src/a.ts" }] },
          post_conditions: [{
            id: "POST-TARGET",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: "src/a.ts" },
          }],
        }],
      };

      const result = inspectPrdContractDoctorGate({
        prd,
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
      });

      assert.equal(result.status, "blocked");
      assert.ok(result.doctor.failures.some((finding) => finding.code === "DEMAND_QUALITY_BLOCKED"));
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });

  test("blocks runner/release PRDs when demand contract is missing", () => {
    const paths = makePaths();
    try {
      const result = inspectPrdContractDoctorGate({
        prd: {
          version: "2.0",
          id: "PRD-DEMAND-MISSING",
          requirements: [{ id: "REQ-GATE-1", text: "Keep contract gate strict." }],
          tasks: [{
            id: "FIX-GATE-004",
            title: "Strict task",
            priority: "P1",
            type: "bugfix",
            status: "pending",
            scope: { targets: [{ file: "src/a.ts" }] },
            post_conditions: [{
              id: "POST-FILE",
              type: "file_exists",
              severity: "FAIL",
              params: { file: "src/a.ts" },
            }],
          }],
        },
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
      });

      assert.equal(result.status, "blocked");
      assert.ok(result.doctor.failures.some((finding) => finding.code === "DEMAND_CONTRACT_MISSING" && finding.human_needed === true));
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });

  test("blocks investigate-first atomicity instead of returning a warning gate", () => {
    const paths = makePaths();
    try {
      const result = inspectPrdContractDoctorGate({
        prd: {
          version: "2.0",
          id: "PRD-INVESTIGATE-FIRST",
          ...strictDemandFields("src/a.ts"),
          tasks: [{
            id: "FIX-GATE-005",
            title: "Investigate first task",
            priority: "P1",
            type: "bugfix",
            status: "pending",
            requirement_ids: ["REQ-GATE-1"],
            scope: { targets: [{ file: "src/a.ts" }, { file: "src/b.ts" }] },
            post_conditions: [
              { id: "POST-A", type: "target_file_modified", severity: "FAIL", params: { file: "src/a.ts" } },
              { id: "POST-B", type: "target_file_modified", severity: "FAIL", params: { file: "src/b.ts" } },
            ],
          }],
        },
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.exit_code, 1);
      assert.ok(result.doctor.failures.some((finding) => finding.code === "ATOMICITY_INVESTIGATE_FIRST"));
      assert.equal(result.doctor.warnings.some((finding) => finding.code === "ATOMICITY_INVESTIGATE_FIRST"), false);
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });

  test("blocks runner/release tasks missing files and acceptance", () => {
    const paths = makePaths();
    try {
      const result = inspectPrdContractDoctorGate({
        prd: {
          version: "2.0",
          id: "PRD-TASK-CONTRACT-MISSING",
          ...strictDemandFields(),
          tasks: [{
            id: "FIX-GATE-006",
            title: "Missing task contract",
            priority: "P1",
            type: "bugfix",
            status: "pending",
            requirement_ids: ["REQ-GATE-1"],
            scope: { targets: [] },
            acceptance_criteria: [],
            post_conditions: [],
          }],
        },
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
      });

      assert.equal(result.status, "blocked");
      assert.ok(result.doctor.failures.some((finding) => finding.code === "TASK_MISSING_FILES"));
      assert.ok(result.doctor.failures.some((finding) => finding.code === "TASK_MISSING_ACCEPTANCE"));
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });

  test("passes strict PRDs and still records doctor evidence", () => {
    const paths = makePaths();
    try {
      const result = inspectPrdContractDoctorGate({
        prd: {
          version: "2.0",
          id: "PRD-PASS",
          ...strictDemandFields(),
          tasks: [{
            id: "FIX-GATE-002",
            title: "Strict task",
            priority: "P1",
            type: "bugfix",
            status: "pending",
            scope: { targets: [{ file: "src/a.ts" }] },
            post_conditions: [{
              id: "POST-FILE",
              type: "file_exists",
              severity: "FAIL",
              params: { file: "src/a.ts" },
            }],
          }],
        },
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
      });

      assert.equal(result.status, "pass");
      assert.equal(result.code, "PRD_CONTRACT_PASS");
      assert.equal(existsSync(result.evidence_path), true);
      const evidence = JSON.parse(readFileSync(result.evidence_path, "utf8"));
      assert.equal(evidence.blocks_execution, false);
      assert.equal(evidence.prd, "data/prd.json");
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });
});
