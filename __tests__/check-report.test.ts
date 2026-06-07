import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { inspectYoloCheck, runYoloCheckCli } from "../src/runtime/gates/check-report.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-check-report-"));
}

function writeJson(file, payload) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
}

function acceptanceAdapter(id = "local-browser") {
  return {
    schema: "yolo.manifest.v1",
    id,
    kind: "acceptance_adapter",
    description: "Local browser acceptance adapter",
    inputs: ["url", "prd"],
    outputs: ["acceptance_report"],
    commands: [{ command: "npm run accept" }],
    evidence: ["screenshot", "runtime_log"],
    capabilities: ["page_reachable", "screenshot", "runtime_errors"],
    applies_to: ["ui", "browser"],
  };
}

function strictPrd(taskOverrides = {}, prdOverrides = {}) {
  return {
    version: "2.0",
    id: "PRD-20260525-CHECK-001",
    title: "Check report fixture",
    project: { name: "test", language: "javascript" },
    generated_by: "yolo-demand",
    generated_at: "2026-05-25T00:00:00.000Z",
    base_commit: "abcdef0",
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: "DEMAND-CHECK",
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
      text: "For operators, keep a small module update tracked.",
      demand_trace: { evidence: ["EVID-1"] },
    }],
    designs: [{ id: "DES-1", text: "Use target-file evidence." }],
    tasks: [{
      id: "FIX-CHECK-001",
      title: "Fix small module",
      priority: "P1",
      type: "bugfix",
      task_kind: "atomic_fix",
      status: "pending",
      requirement_ids: ["REQ-1"],
      design_ids: ["DES-1"],
      scope: { targets: [{ file: "src/a.js" }] },
      acceptance_criteria: ["Small module target is modified."],
      post_conditions: [{
        id: "POST-TARGET",
        type: "target_file_modified",
        severity: "FAIL",
        params: { file: "src/a.js" },
      }],
      ...taskOverrides,
    }],
    ...prdOverrides,
  };
}

describe("yolo check report", () => {
  test("passes a strict non-UI PRD while keeping missing adapter advisory", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd());

      const report = inspectYoloCheck({ prdPath, projectRoot: root });

      assert.equal(report.status, "pass");
      assert.equal(report.checks.find((check) => check.name === "prd_preflight").status, "pass");
      assert.equal(report.checks.find((check) => check.name === "adapter_readiness").status, "pass");
      assert.equal(report.checks.find((check) => check.name === "resolver_readiness").status, "pass");
      assert.ok(report.checks.find((check) => check.name === "resolver_readiness").advisories.length > 0);
      assert.ok(report.advisory_warnings.some((warning) => warning.code === "ADAPTER_MANIFEST_MISSING"));
      assert.equal(report.resolver.selected.acceptance_adapter.id, "unknown/custom");
      assert.equal(report.blockers.length, 0);
      assert.equal(report.execution_policy.gate_strength, "strict");
      assert.equal(report.remediation_plan.action, "PASS");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("strict runner policy blocks unknown execution warnings and returns nonzero", () => {
    const root = tempProject();
    let stdout = "";
    let stderr = "";
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        post_conditions: [
          {
            id: "POST-TARGET",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: "src/a.js" },
          },
          {
            id: "POST-MANUAL",
            type: "acceptance_criteria",
            severity: "FAIL",
            params: { text: "Human verifies the copy still feels right." },
          },
        ],
      }));

      const exitCode = runYoloCheckCli([prdPath, "--strict", "--json", "--no-write"], {
        cwd: root,
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const report = JSON.parse(stdout);

      assert.equal(exitCode, 1);
      assert.equal(stderr, "");
      assert.equal(report.status, "blocked");
      assert.equal(report.warning_policy.fail_closed, true);
      assert.ok(report.blockers.some((blocker) => blocker.code === "MANUAL_FAIL_CONDITION" && blocker.warning_policy === "execution_blocking"));
      assert.equal(report.warnings.some((warning) => warning.code === "MANUAL_FAIL_CONDITION"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo check returns structured JSON for malformed PRDs", () => {
    const root = tempProject();
    let stdout = "";
    let stderr = "";
    try {
      const prdPath = join(root, "bad-prd.json");
      writeFileSync(prdPath, "{not-json", "utf8");

      const exitCode = runYoloCheckCli([prdPath, "--json", "--no-write"], {
        cwd: root,
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const report = JSON.parse(stdout);

      assert.equal(exitCode, 1);
      assert.equal(stderr, "");
      assert.equal(report.status, "error");
      assert.equal(report.code, "PRD_JSON_INVALID");
      assert.ok(report.blockers.some((blocker) => blocker.code === "PRD_JSON_INVALID"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("YB-001 blocks runner check when the demand contract is missing", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({}, {
        source: undefined,
        demand_contract_required: undefined,
        demand: undefined,
        execution_readiness: undefined,
        requirements: [{
          id: "REQ-1",
          text: "For operators, keep inventory counts clear.",
        }],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });
      const demandContract = report.checks.find((check) => check.name === "demand_contract");

      assert.equal(report.status, "blocked");
      assert.equal(report.code, "YOLO_CHECK_BLOCKED");
      assert.equal(demandContract.status, "blocked");
      assert.equal(report.execution_policy.automation_can_continue, false);
      assert.ok(report.blockers.some((blocker) => blocker.code === "DEMAND_CONTRACT_MISSING" && blocker.human_needed === true));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("YB-002 blocks investigate-first atomicity in runner check instead of warning", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        scope: { targets: [{ file: "src/a.js" }, { file: "src/b.js" }] },
        post_conditions: [
          { id: "POST-A", type: "target_file_modified", severity: "FAIL", params: { file: "src/a.js" } },
          { id: "POST-B", type: "target_file_modified", severity: "FAIL", params: { file: "src/b.js" } },
        ],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });
      const atomicity = report.checks.find((check) => check.name === "atomicity");

      assert.equal(report.status, "blocked");
      assert.equal(atomicity.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.code === "ATOMICITY_INVESTIGATE_FIRST" && blocker.human_needed === true));
      assert.equal(report.warnings.some((warning) => warning.code === "ATOMICITY_INVESTIGATE_FIRST"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("YB-003 blocks runner check when task files and acceptance are missing", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        scope: { targets: [] },
        acceptance_criteria: [],
        post_conditions: [],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });

      assert.equal(report.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.code === "TASK_MISSING_FILES"));
      assert.ok(report.blockers.some((blocker) => blocker.code === "TASK_MISSING_ACCEPTANCE"));
      assert.equal(report.execution_policy.automation_can_continue, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks approved-demand PRDs with blocked quality reports", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({}, {
        generated_by: "yolo-demand",
        source: "approved_demand",
        demand_contract_required: true,
        demand: {
          id: "DEMAND-CHECK",
          approval: { approved: true },
          quality_report: {
            schema_version: "1.0",
            schema: "yolo.demand.quality.v1",
            status: "blocked",
            total_score: 40,
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
          text: "For operators, keep inventory counts clear.",
          demand_trace: { evidence: ["EVID-1"] },
        }],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root });
      const demandContract = report.checks.find((check) => check.name === "demand_contract");

      assert.equal(report.status, "blocked");
      assert.equal(demandContract.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.code === "DEMAND_QUALITY_BLOCKED"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks approved-demand PRDs with project facts outside the project root", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({}, {
        generated_by: "yolo-demand",
        source: "approved_demand",
        demand_contract_required: true,
        demand: {
          id: "DEMAND-CHECK",
          approval: { approved: true, effective_for_prd: false },
          project_facts: {
            target_files: [{ file: "/tmp/outside-project.js", status: "verified" }],
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
          text: "For operators, keep inventory counts clear.",
          demand_trace: { evidence: ["EVID-1"] },
        }],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root });
      const demandContract = report.checks.find((check) => check.name === "demand_contract");

      assert.equal(report.status, "blocked");
      assert.equal(demandContract.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.code === "DEMAND_PROJECT_TARGET_FACTS_UNRESOLVED"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks UI tasks without state matrix and evidence plan", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        title: "Build inventory page",
        type: "feature",
        scope: { targets: [{ file: "src/pages/inventory.tsx" }] },
        post_conditions: [{
          id: "POST-PAGE",
          type: "target_file_modified",
          severity: "FAIL",
          params: { file: "src/pages/inventory.tsx" },
        }],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root });

      assert.equal(report.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.code === "UI_STATE_MATRIX_MISSING"));
      assert.ok(report.blockers.some((blocker) => blocker.code === "UI_EVIDENCE_PLAN_MISSING"));
      assert.ok(report.blockers.some((blocker) => blocker.code === "ADAPTER_UI_ACCEPTANCE_MISSING"));
      assert.ok(report.blockers.some((blocker) => blocker.code === "ACCEPTANCE_ADAPTER_MISSING"));
      assert.equal(report.remediation_plan.gate_strength, "strict");
      assert.equal(report.remediation_plan.blocks_ship, true);
      assert.equal(report.remediation_plan.action, "ASK_HUMAN");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks PRD slices that mix independent user stories", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        title: "Edit and move Trello cards",
        description: "编辑卡片标题，并移动卡片到另一个列表。",
        acceptance_criteria: ["编辑后的卡片标题可见；卡片移动到目标列表。"],
      }, {
        requirements: [{
          id: "REQ-1",
          text: "Trello 用户可以编辑卡片标题，并移动卡片到另一个列表。",
        }],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root });
      const storyAtomicity = report.checks.find((check) => check.name === "story_atomicity");

      assert.equal(report.status, "blocked");
      assert.equal(storyAtomicity.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.gate === "story_atomicity" && blocker.code === "STORY_ATOMICITY_MULTI_STORY"));
      assert.ok(report.blockers.some((blocker) => blocker.gate === "story_atomicity" && blocker.task_id === "FIX-CHECK-001"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes check report into lifecycle when requested", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd());

      const report = inspectYoloCheck({
        prdPath,
        projectRoot: root,
        stateRoot,
        writeLifecycle: true,
      });

      assert.equal(report.lifecycle_write.stage, "check");
      assert.equal(existsSync(join(stateRoot, "lifecycle/check-report.json")), true);
      const artifact = JSON.parse(readFileSync(join(stateRoot, "lifecycle/check-report.json"), "utf8"));
      assert.equal(artifact.report.schema, "yolo.check.report.v1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses resolver-selected acceptance adapter for UI readiness", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdPath = join(root, "prd.json");
      writeJson(join(stateRoot, "adapters/local-browser.manifest.json"), acceptanceAdapter());
      writeJson(prdPath, strictPrd({
        title: "Build inventory page",
        type: "feature",
        scope: { targets: [{ file: "src/pages/inventory.tsx" }] },
        state_matrix: [{ state: "loaded" }],
        evidence_plan: [{ type: "screenshot" }],
        post_conditions: [{
          id: "POST-PAGE",
          type: "screenshot_exists",
          severity: "FAIL",
          params: { file: ".yolo/state/evidence/ui/inventory.png" },
        }],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, stateRoot });
      const adapter = report.checks.find((check) => check.name === "adapter_readiness");

      assert.equal(adapter.status, "pass");
      assert.equal(adapter.adapter_id, "local-browser");
      assert.equal(report.resolver.selected.acceptance_adapter.id, "local-browser");
      assert.equal(report.task_surface_summary.ui_task_count, 1);
      assert.equal(report.blockers.some((blocker) => blocker.code === "ADAPTER_UI_ACCEPTANCE_MISSING"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
