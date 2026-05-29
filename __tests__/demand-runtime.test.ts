import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readDemandSession,
  runDemandBrainstormRuntime,
  runDemandDiscussRuntime,
  runDemandPrdRuntime,
} from "../src/demand/runtime.js";
import { inspectYoloCheck } from "../src/runtime/gates/check-report.js";

describe("demand runtime", () => {
  test("brainstorm writes gsd-style demand artifact pack without business code", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-brainstorm-"));
    try {
      const result = runDemandBrainstormRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Build inventory stockout prevention for store managers.",
        target_users: ["store manager"],
        status_quo: ["Managers discover stockouts after customers complain."],
        assumptions: ["Thresholds are configurable per SKU."],
        success_criteria: ["Managers can see a low-stock alert before stockout."],
        non_goals: ["Do not change order import."],
        writeArtifacts: true,
      });

      assert.equal(result.demand_id.startsWith("DEMAND-"), true);
      assert.equal(existsSync(join(result.demand_dir, "VISION.md")), true);
      assert.equal(existsSync(join(result.demand_dir, "REQUIREMENTS.md")), true);
      assert.equal(existsSync(join(result.demand_dir, "CONTEXT.md")), true);
      assert.equal(existsSync(join(result.demand_dir, "ROADMAP.md")), true);
      assert.equal(existsSync(join(result.demand_dir, "SCENARIO_MATRIX.md")), true);
      assert.equal(result.session.nontechnical_intake.technical_terms_required_from_user, false);
      assert.equal(result.session.scenario_matrix.nontechnical_user_safe, true);
      assert.equal(result.guarantees.writes_business_code, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discuss requires approval and compiles approved demand to L3 PRD", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-discuss-"));
    try {
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Build inventory stockout prevention for store managers.",
        target_users: ["store manager"],
        status_quo: ["Managers discover stockouts after customers complain."],
        evidence: ["Support tickets mention stockout surprises weekly."],
        assumptions: ["Thresholds are configurable per SKU."],
        success_criteria: ["Managers can see a low-stock alert before stockout."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/services/inventory-alerts.ts"],
        decisions: ["Start with one configurable threshold per SKU."],
        roadmap: ["MVP alert generation before stockout."],
        approve: true,
        writeArtifacts: true,
      });

      assert.equal(discuss.status, "success");
      assert.equal(discuss.readiness.readiness_level, "L3");
      const read = readDemandSession(join(discuss.demand_dir, "session.json"));
      assert.equal(read.ok, true);
      assert.equal(read.session.approval.approved, true);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: true,
      });

      assert.equal(prd.status, "success");
      assert.equal(prd.prd.demand_contract_required, true);
      assert.equal(prd.prd.execution_readiness.level, "L3");
      assert.equal(prd.prd.execution_readiness.atomic_tasks, true);
      assert.equal(prd.prd.tasks[0].handoff.type, "agent_brief");
      assert.equal(prd.prd.tasks[0].handoff.plain_language_goal.length > 0, true);

      const check = inspectYoloCheck({ prdPath: prd.artifacts[0], projectRoot: root, writeLifecycle: false });
      assert.notEqual(check.checks.find((item) => item.name === "demand_contract").status, "blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand PRD compilation blocks before requirements confirmation", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-blocked-"));
    try {
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Build alerts",
        target_users: ["operator"],
        approve: true,
        writeArtifacts: true,
      });
      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: true,
      });

      assert.equal(prd.status, "blocked");
      assert.ok(prd.blockers.some((blocker) => blocker.code === "REQUIREMENTS_PRESENT"));
      assert.equal(prd.artifacts.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved demand compiles scenario surfaces into session-sized atomic tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-atomic-"));
    try {
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts in a spreadsheet-like list."],
        evidence: ["Weekly support tickets mention surprise stockouts."],
        assumptions: ["Existing inventory service already returns quantity."],
        success_criteria: ["Inventory service marks low-stock SKUs.", "Inventory list displays a visible low-stock badge."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/services/inventory-alerts.ts", "src/pages/inventory-list.tsx", "src/services/inventory-alerts.test.ts"],
        decisions: ["Start with one threshold rule and one list badge."],
        roadmap: ["MVP service rule and list badge."],
        approve: true,
        writeArtifacts: true,
      });

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "success");
      assert.equal(prd.prd.tasks.length >= 3, true);
      assert.equal(prd.prd.tasks.every((task) => task.task_kind === "demand_atomic_task"), true);
      assert.equal(prd.prd.tasks.every((task) => task.scope.max_files <= 2), true);
      assert.equal(prd.prd.tasks.every((task) => Boolean(task.handoff.proof)), true);
      assert.equal(prd.prd.tasks.some((task) => task.handoff.surface.kind === "ui"), true);
      assert.equal(prd.prd.tasks.some((task) => task.handoff.surface.kind === "service"), true);
      assert.equal(prd.prd.tasks.some((task) => task.handoff.surface.kind === "test"), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
