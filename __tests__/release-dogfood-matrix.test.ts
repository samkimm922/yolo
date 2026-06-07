import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDogfoodMatrixEvidence,
  buildDogfoodMatrixPlan,
  buildDogfoodMatrixReport,
  DOGFOOD_MATRIX_SCENARIO_IDS,
  DOGFOOD_MATRIX_SCHEMA_VERSION,
  listDogfoodMatrixScenarios,
} from "../src/release/dogfood-matrix.js";
import { runRealProjectDogfoodGate } from "../src/release/real-project-dogfood.js";

function modeEvidence(mode) {
  return {
    status: "pass",
    mode,
    artifact_path: `.yolo/state/reports/dogfood/${mode}.json`,
    writes_workspace: false,
    edits_code: false,
    provider_execution: false,
    billable_provider_execution: false,
    executed_by_sdk: false,
  };
}

function agentIntegrationPass() {
  return {
    status: "pass",
    blockers: [],
    guarantees: {
      provider_execution: false,
      billable_provider_execution: false,
      credential_access: false,
    },
  };
}

describe("generic dogfood matrix", () => {
  test("declares all required generic project shapes and acceptance contracts", () => {
    const scenarios = listDogfoodMatrixScenarios();

    assert.deepEqual(scenarios.map((scenario) => scenario.id), DOGFOOD_MATRIX_SCENARIO_IDS);
    assert.equal(scenarios.length, 7);

    for (const scenario of scenarios) {
      assert.ok(scenario.project_shape);
      assert.ok(scenario.required_lifecycle_commands.length >= 7);
      assert.ok(scenario.required_checks.length > 0);
      assert.ok(["pass", "fail_closed"].includes(scenario.expected.outcome));
      assert.ok(scenario.expected.pass_conditions.length > 0);
      assert.ok(scenario.expected.fail_conditions.length > 0);
      assert.ok(scenario.acceptance_evidence_paths.length >= 3);
      assert.ok(scenario.blocked_conditions.length > 0);
    }

    assert.equal(scenarios.find((scenario) => scenario.id === "dirty-tree")?.expected.outcome, "fail_closed");
    assert.equal(scenarios.find((scenario) => scenario.id === "failing-baseline")?.expected.outcome, "fail_closed");
  });

  test("fails closed for dirty-tree and failing-baseline instead of treating pass as acceptable", () => {
    const evidence = buildDogfoodMatrixEvidence({
      "dirty-tree": { status: "pass", blockers: [] },
      "failing-baseline": { status: "pass", blockers: [] },
    });
    const report = buildDogfoodMatrixReport({ evidenceByScenario: evidence });

    assert.equal(report.status, "blocked");
    assert.ok(report.blocked_reasons.some((reason) => reason.scenario === "dirty-tree" && reason.code === "DOGFOOD_MATRIX_FAIL_CLOSED_EXPECTED"));
    assert.ok(report.blocked_reasons.some((reason) => reason.scenario === "failing-baseline" && reason.code === "DOGFOOD_MATRIX_FAIL_CLOSED_EXPECTED"));
  });

  test("blocks missing acceptance evidence paths", () => {
    const evidence = buildDogfoodMatrixEvidence({
      "node-basic": { evidence_files: [], acceptance_evidence_paths: [] },
    });
    const report = buildDogfoodMatrixReport({ evidenceByScenario: evidence });

    assert.equal(report.status, "blocked");
    assert.ok(report.missing_evidence.some((item) => item.scenario === "node-basic"));
    assert.ok(report.blocked_reasons.some((reason) => reason.scenario === "node-basic" && reason.code === "DOGFOOD_MATRIX_ACCEPTANCE_EVIDENCE_MISSING"));
  });

  test("blocks empty or incomplete custom scenario plans", () => {
    const report = buildDogfoodMatrixReport({
      plan: { matrix: "generic", scenarios: [], command_plan: [] },
      evidenceByScenario: {},
    });

    assert.equal(report.status, "blocked");
    assert.equal(report.scenario_count, 0);
    assert.ok(report.blocked_reasons.some((reason) => reason.code === "DOGFOOD_MATRIX_SCENARIO_SET_INCOMPLETE"));
  });

  test("blocks scenario evidence that claims forbidden side effects", () => {
    const evidence = buildDogfoodMatrixEvidence({
      "node-basic": {
        provider_execution: true,
        billable_provider_execution: true,
        writes_workspace: true,
      },
    });
    const report = buildDogfoodMatrixReport({ evidenceByScenario: evidence });

    assert.equal(report.status, "blocked");
    assert.ok(report.blocked_reasons.some((reason) =>
      reason.scenario === "node-basic" && reason.code === "DOGFOOD_MATRIX_FORBIDDEN_SIDE_EFFECT"
    ));
  });

  test("passes when every scenario has evidence and negative scenarios fail closed", () => {
    const report = buildDogfoodMatrixReport({
      evidenceByScenario: buildDogfoodMatrixEvidence(),
    });

    assert.equal(report.schema_version, DOGFOOD_MATRIX_SCHEMA_VERSION);
    assert.equal(report.status, "pass", JSON.stringify(report.blocked_reasons, null, 2));
    assert.equal(report.scenario_count, 7);
    assert.equal(report.scenarios.find((scenario) => scenario.scenario === "dirty-tree")?.status, "fail_closed");
    assert.equal(report.scenarios.find((scenario) => scenario.scenario === "failing-baseline")?.status, "fail_closed");
  });

  test("command plan is generic and contains no Trello specialization", () => {
    const plan = buildDogfoodMatrixPlan({ yoloRoot: "/tmp/yolo", projectRoot: "/tmp/project" });
    const planText = JSON.stringify(plan).toLowerCase();

    assert.ok(plan.command_plan.length >= DOGFOOD_MATRIX_SCENARIO_IDS.length * 7);
    assert.equal(planText.includes("trello"), false);
    assert.ok(plan.command_plan.some((item) => item.command === "/yolo-demand"));
    assert.ok(plan.command_plan.some((item) => item.command.includes("python3 -m unittest")));
  });

  test("real-project dogfood gate blocks old single-project evidence when matrix evidence is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-dogfood-matrix-gate-"));
    try {
      const yoloRoot = join(root, "yolo");
      const projectRoot = join(root, "project");
      mkdirSync(yoloRoot, { recursive: true });
      mkdirSync(projectRoot, { recursive: true });

      const result = runRealProjectDogfoodGate({
        yoloRoot,
        projectRoot,
        agentIntegration: agentIntegrationPass(),
        planEvidence: modeEvidence("plan"),
        checkEvidence: modeEvidence("check"),
        reviewEvidence: modeEvidence("review"),
      });

      assert.equal(result.status, "blocked");
      assert.ok(result.blockers.some((blocker) => blocker.code === "REAL_PROJECT_DOGFOOD_GENERIC_MATRIX_PASS"));
      assert.equal(result.components.dogfood_matrix.status, "blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
