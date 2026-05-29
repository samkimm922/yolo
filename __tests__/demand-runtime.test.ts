import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  readDemandSession,
  runDemandBrainstormRuntime,
  runDemandDiscussRuntime,
  runDemandPrdRuntime,
} from "../src/demand/runtime.js";
import { inspectDemandQuality } from "../src/demand/gate.js";
import { inspectYoloCheck } from "../src/runtime/gates/check-report.js";

function assertTaskSessionPlan(task, demandId) {
  const session = task.handoff?.session;
  assert.ok(session, `missing session plan for ${task.id}`);
  const taskRoot = `.yolo/demand/${demandId}/tasks/${task.id}`;
  assert.equal(session.schema, "yolo.demand.task_session_plan.v1");
  assert.equal(session.session_id, `${task.id}-session`);
  assert.equal(session.task_id, task.id);
  assert.equal(session.demand_id, demandId);
  assert.equal(session.state_path, `${taskRoot}/session.json`);
  assert.equal(session.handoff_path, `${taskRoot}/handoff.md`);
  assert.equal(session.evidence_path, `${taskRoot}/evidence.jsonl`);
  assert.equal(session.memory_update_paths.includes(".yolo/memory/CURRENT_HANDOFF.md"), true);
  assert.equal(session.memory_update_paths.includes(".yolo/memory/PROGRESS.md"), true);
  assert.equal(session.memory_update_paths.includes(".yolo/state/session-memory.jsonl"), true);
  assert.equal(session.progress_update_path, ".yolo/memory/PROGRESS.md");
  assert.equal(session.resume_instructions.includes(task.id), true);
  return session;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function acceptanceAdapterManifest() {
  return {
    schema: "yolo.manifest.v1",
    id: "local-browser",
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
        base_commit: "abcdef0",
        writeArtifacts: true,
      });

      assert.equal(prd.status, "success");
      assert.equal(prd.prd.base_commit, "abcdef0");
      assert.equal(prd.prd.demand_contract_required, true);
      assert.equal(prd.prd.execution_readiness.level, "L3");
      assert.equal(prd.prd.execution_readiness.atomic_tasks, true);
      assert.equal(prd.prd.demand.quality_report.status, "pass");
      assert.equal(prd.prd.demand.quality_report.dimensions.length, 5);
      assert.equal(prd.prd.execution_readiness.quality_report.total_score, prd.prd.demand.quality_report.total_score);
      assert.equal(prd.prd.tasks[0].handoff.type, "agent_brief");
      assert.equal(prd.prd.tasks[0].handoff.plain_language_goal.length > 0, true);
      const firstSession = assertTaskSessionPlan(prd.prd.tasks[0], prd.prd.demand.id);
      assert.equal(existsSync(join(root, firstSession.state_path)), false);
      assert.equal(existsSync(join(root, firstSession.handoff_path)), false);
      assert.equal(existsSync(join(root, firstSession.evidence_path)), false);
      assert.equal(prd.prd.execution_readiness.session_handoff.planned, true);
      assert.equal(prd.prd.execution_readiness.session_handoff.task_count, prd.prd.tasks.length);
      assert.equal(prd.prd.demand.atomicity_contract.session_handoff.session_count, prd.prd.tasks.length);

      const check = inspectYoloCheck({ prdPath: prd.artifacts[0], projectRoot: root, writeLifecycle: false });
      assert.notEqual(check.checks.find((item) => item.name === "demand_contract").status, "blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand PRD quality gate blocks vague proof despite readiness passing", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-quality-proof-"));
    try {
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory counts are already available."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["ok"],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Start with a list badge before adding supplier ordering."],
        roadmap: ["MVP badge in inventory list."],
        approve: true,
        writeArtifacts: true,
      });
      assert.equal(discuss.status, "success");
      assert.equal(discuss.readiness.executable_prd_ready, true);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      assert.equal(prd.code, "DEMAND_QUALITY_BLOCKED");
      assert.equal(prd.prd, null);
      assert.ok(prd.quality_report.blockers.some((blocker) => blocker.code === "QUALITY_SCENARIO_PROOF_CONCRETE"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inspectDemandQuality flags missing proof handoff and atomicity gaps", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-quality-pure-"));
    try {
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory counts are already available."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["A store manager can point to the low-stock badge on an affected SKU."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Start with a list badge before adding supplier ordering."],
        roadmap: ["MVP badge in inventory list."],
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

      const clone = (value) => JSON.parse(JSON.stringify(value));
      const passAtomicity = { status: "pass", blockers: [], warnings: [] };

      const proofless = clone(discuss.session);
      proofless.scenario_matrix.scenarios[0].proof = "";
      proofless.scenario_matrix.scenarios[0].surfaces[0].proof = "";
      const proofQuality = inspectDemandQuality(proofless, {
        phase: "prd",
        tasks: prd.prd.tasks,
        atomicity: passAtomicity,
        requireTasks: true,
      });
      assert.equal(proofQuality.status, "blocked");
      assert.ok(proofQuality.blockers.some((blocker) => blocker.code === "QUALITY_SCENARIO_PROOF_CONCRETE"));

      const missingHandoffTasks = clone(prd.prd.tasks);
      delete missingHandoffTasks[0].handoff;
      const handoffQuality = inspectDemandQuality(discuss.session, {
        phase: "prd",
        tasks: missingHandoffTasks,
        atomicity: passAtomicity,
        requireTasks: true,
      });
      assert.equal(handoffQuality.status, "blocked");
      assert.ok(handoffQuality.blockers.some((blocker) => blocker.code === "QUALITY_TASK_HANDOFF_COMPLETE"));

      const missingSessionPlanTasks = clone(prd.prd.tasks);
      delete missingSessionPlanTasks[0].handoff.session;
      const sessionPlanQuality = inspectDemandQuality(discuss.session, {
        phase: "prd",
        tasks: missingSessionPlanTasks,
        atomicity: passAtomicity,
        requireTasks: true,
      });
      assert.equal(sessionPlanQuality.status, "blocked");
      assert.ok(sessionPlanQuality.blockers.some((blocker) => blocker.code === "QUALITY_TASK_SESSION_PLAN_COMPLETE"));

      const atomicityQuality = inspectDemandQuality(discuss.session, {
        phase: "prd",
        tasks: prd.prd.tasks,
        atomicity: {
          status: "blocked",
          blockers: [{ code: "ATOMIC_TASK_TOO_COARSE", task_id: prd.prd.tasks[0].id }],
          warnings: [],
        },
        requireTasks: true,
      });
      assert.equal(atomicityQuality.status, "blocked");
      assert.ok(atomicityQuality.blockers.some((blocker) => blocker.code === "QUALITY_ATOMIC_DOCTOR_PASSED"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("interview trace is preserved into approved-demand PRD tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-interview-"));
    try {
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory counts are already available."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["A store manager can point to the badge on a low-stock SKU."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        roadmap: ["MVP badge in inventory list."],
        interview: {
          question_trace: [
            {
              id: "Q-STOCKOUT-PROOF",
              question: "How will the manager know the change worked?",
              answer: "They can point to a low-stock badge before the item sells out.",
            },
          ],
          prd_intake: {
            desired_outcomes: ["Managers see the warning in the inventory list."],
            success_proof: ["Visible badge on low-stock SKU."],
          },
          approval_reason: "Business owner confirmed this is enough for MVP.",
        },
        approve: true,
        writeArtifacts: true,
      });

      assert.equal(discuss.status, "success");
      assert.equal(discuss.session.question_trace[0].id, "Q-STOCKOUT-PROOF");
      assert.equal(discuss.session.prd_intake.question_ids.includes("Q-STOCKOUT-PROOF"), true);
      assert.equal(discuss.session.approval_reason, "Business owner confirmed this is enough for MVP.");
      assert.equal(discuss.session.scenario_matrix.scenarios[0].source_question_ids.includes("Q-STOCKOUT-PROOF"), true);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        base_commit: "abcdef0",
        writeArtifacts: false,
      });

      assert.equal(prd.status, "success");
      assert.equal(prd.prd.base_commit, "abcdef0");
      assert.equal(prd.prd.demand.question_trace[0].id, "Q-STOCKOUT-PROOF");
      assert.equal(prd.prd.tasks[0].source_question_ids.includes("Q-STOCKOUT-PROOF"), true);
      assert.equal(prd.prd.tasks[0].handoff.source_question_ids.includes("Q-STOCKOUT-PROOF"), true);
      assert.equal(typeof prd.prd.tasks[0].verification_hint, "string");
      assert.equal(prd.prd.tasks[0].verification_hint.length > 0, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand UI PRDs include UI readiness fields and pass yolo check with an adapter", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-ui-check-"));
    try {
      writeJson(join(root, ".yolo", "adapters", "local-browser.manifest.json"), acceptanceAdapterManifest());
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts in the inventory list."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory counts are already available."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["A store manager can point to the low-stock badge on an affected SKU."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Start with a list badge before adding supplier ordering."],
        roadmap: ["MVP badge in inventory list."],
        approve: true,
        writeArtifacts: true,
      });
      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        base_commit: "abcdef0",
        writeArtifacts: true,
      });

      assert.equal(prd.status, "success");
      const uiTask = prd.prd.tasks.find((task) => task.handoff?.surface?.kind === "ui");
      assert.ok(uiTask);
      assert.ok(Array.isArray(uiTask.state_matrix) && uiTask.state_matrix.length > 0);
      assert.ok(Array.isArray(uiTask.evidence_plan) && uiTask.evidence_plan.length > 0);
      assert.equal(Array.isArray(uiTask.handoff.state_matrix), true);
      assert.equal(Array.isArray(uiTask.handoff.evidence_plan), true);

      const check = inspectYoloCheck({
        prdPath: prd.artifacts[0],
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        writeLifecycle: false,
      });

      assert.equal(check.status, "pass", JSON.stringify(check.blockers, null, 2));
      assert.equal(check.checks.find((item) => item.name === "ui_readiness").status, "pass");
      assert.equal(check.blockers.some((blocker) => blocker.code === "UI_STATE_MATRIX_MISSING"), false);
      assert.equal(check.blockers.some((blocker) => blocker.code === "UI_EVIDENCE_PLAN_MISSING"), false);
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

  test("approved-demand PRD blocks surfaces with oversized session budget", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-budget-"));
    try {
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory counts are already available."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx", "src/services/inventory-alerts.ts"],
        decisions: ["Start with one threshold rule and one list badge."],
        roadmap: ["MVP service rule and list badge."],
        approve: true,
        writeArtifacts: true,
      });
      assert.equal(discuss.status, "success");

      discuss.session.scenario_matrix.scenarios[0].surfaces[0].session_budget.max_files = 3;
      writeFileSync(join(discuss.demand_dir, "session.json"), `${JSON.stringify(discuss.session, null, 2)}\n`, "utf8");

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      assert.ok(prd.blockers.some((blocker) => blocker.code === "SURFACE_SESSION_BUDGET_EXECUTABLE"));
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
      for (const task of prd.prd.tasks) {
        assertTaskSessionPlan(task, prd.prd.demand.id);
      }
      const handoffStats = prd.prd.execution_readiness.session_handoff;
      assert.equal(handoffStats.planned, true);
      assert.equal(handoffStats.task_count, prd.prd.tasks.length);
      assert.equal(handoffStats.session_count, prd.prd.tasks.length);
      assert.equal(handoffStats.tasks_with_session_plan, prd.prd.tasks.length);
      assert.equal(handoffStats.state_paths.length, prd.prd.tasks.length);
      assert.equal(handoffStats.handoff_paths.length, prd.prd.tasks.length);
      assert.equal(handoffStats.evidence_paths.length, prd.prd.tasks.length);
      assert.equal(handoffStats.memory_update_paths.includes(".yolo/memory/CURRENT_HANDOFF.md"), true);
      assert.equal(handoffStats.memory_update_paths.includes(".yolo/state/session-memory.jsonl"), true);
      assert.equal(handoffStats.progress_update_paths.includes(".yolo/memory/PROGRESS.md"), true);
      assert.deepEqual(prd.prd.demand.atomicity_contract.session_handoff, handoffStats);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("task session handoff paths preserve non-ASCII demand ids", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-cjk-"));
    try {
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demand_id: "DEMAND-20260529-库存预警",
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory counts are already available."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["A store manager can point to the low-stock badge on an affected SKU."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Start with a list badge before adding supplier ordering."],
        roadmap: ["MVP badge in inventory list."],
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
      assert.match(prd.prd.id, /^[A-Z]+-[0-9]+-[A-Z0-9-]+$/);
      assert.equal(prd.prd.tasks[0].handoff.session.state_path, ".yolo/demand/DEMAND-20260529-库存预警/tasks/DEMAND-REQ-001-0010101/session.json");
      assert.ok(prd.prd.execution_readiness.session_handoff.state_paths[0].includes("库存预警"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
