import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { inspectYoloCheck } from "../src/runtime/gates/check-report.js";

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
    generated_by: "yolo-review-agent",
    generated_at: "2026-05-25T00:00:00.000Z",
    base_commit: "abcdef0",
    requirements: [{ id: "REQ-1", text: "For operators, keep inventory counts clear; success criteria: changed target is tracked." }],
    designs: [{ id: "DES-1", text: "Use target-file evidence." }],
    tasks: [{
      id: "FIX-CHECK-001",
      title: "Fix inventory service",
      priority: "P1",
      type: "bugfix",
      task_kind: "atomic_fix",
      status: "pending",
      requirement_ids: ["REQ-1"],
      design_ids: ["DES-1"],
      scope: { targets: [{ file: "src/inventory.js" }] },
      acceptance_criteria: ["Inventory service target is modified."],
      post_conditions: [{
        id: "POST-TARGET",
        type: "target_file_modified",
        severity: "FAIL",
        params: { file: "src/inventory.js" },
      }],
      ...taskOverrides,
    }],
    ...prdOverrides,
  };
}

describe("yolo check report", () => {
  test("passes a strict non-UI PRD while warning when no adapter is configured", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd());

      const report = inspectYoloCheck({ prdPath, projectRoot: root });

      assert.equal(report.status, "warning");
      assert.equal(report.checks.find((check) => check.name === "prd_preflight").status, "pass");
      assert.equal(report.checks.find((check) => check.name === "adapter_readiness").status, "warning");
      assert.equal(report.checks.find((check) => check.name === "resolver_readiness").status, "pass");
      assert.ok(report.checks.find((check) => check.name === "resolver_readiness").advisories.length > 0);
      assert.equal(report.resolver.selected.acceptance_adapter.id, "unknown/custom");
      assert.equal(report.blockers.length, 0);
      assert.equal(report.execution_policy.gate_strength, "strict");
      assert.equal(report.remediation_plan.action, "PASS");
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
