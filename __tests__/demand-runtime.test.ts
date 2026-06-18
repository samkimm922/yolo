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
import { inspectDemandQuality, inspectDemandReadiness } from "../src/demand/gate.js";
import { inspectYoloCheck } from "../src/runtime/gates/check-report.js";
import { inspectLifecycleGuard } from "../src/lifecycle/guard.js";
import { demandSessionSchemaError } from "../src/demand/router.js";
import { parseFindingsJsonOutput, validateFindings } from "../src/demand/findings-generator.js";

interface PrdResult {
  [key: string]: unknown;
  status: string;
  code: string;
  prd: Record<string, unknown>;
  tasks: Record<string, unknown>[];
  compiled?: { prd: Record<string, unknown> };
  artifacts: string[];
  blockers: Record<string, unknown>[];
  quality_report?: Record<string, unknown>;
}

function requirePrd(result: ReturnType<typeof runDemandPrdRuntime>): asserts result is ReturnType<typeof runDemandPrdRuntime> & { prd: NonNullable<ReturnType<typeof runDemandPrdRuntime>["prd"]> } {
  if (!("prd" in result) || result.prd === null || result.prd === undefined) {
    throw new Error(`expected prd to exist, got status=${result.status}`);
  }
}

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

function defaultDemandTargetFileContent(file) {
  if (file.endsWith("inventory-list.tsx")) {
    return [
      "export function InventoryList({ items }) {",
      "  return <ul>{items.map((item) => <li key={item.sku}>{item.sku}{item.quantity <= item.lowStockThreshold ? <span>Low stock</span> : null}</li>)}</ul>;",
      "}",
      "",
    ].join("\n");
  }
  if (file.endsWith("inventory-alerts.ts")) {
    return "export function isLowStock(item) { return item.quantity <= item.lowStockThreshold; }\n";
  }
  if (file.endsWith("inventory-alerts.test.ts")) {
    return "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isLowStock } from './inventory-alerts';\ntest('low stock threshold', () => assert.equal(isLowStock({ quantity: 1, lowStockThreshold: 2 }), true));\n";
  }
  return "export const yoloDemandTarget = true;\n";
}

function writeProjectFile(root, file, content = defaultDemandTargetFileContent(file)) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function seedDemandTargetFiles(root, files) {
  for (const file of files) writeProjectFile(root, file);
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

describe("demand findings generator output parsing", () => {
  test("parses fenced explanatory output with deeply nested findings JSON", () => {
    const output = [
      "Here is the generated JSON:",
      "```json",
      JSON.stringify({
        findings: [{
          id: "DEV-001",
          title: "Add nested task",
          severity: "HIGH",
          description: "Implement nested scope and condition parsing.",
          files: ["src/pages/nested.tsx"],
          scope: {
            targets: [{
              file: "src/pages/nested.tsx",
              metadata: {
                owner: "demand",
                checks: [{ name: "target", params: { required: true } }],
              },
            }],
          },
          post_conditions: [{
            id: "POST-NESTED",
            type: "code_contains",
            severity: "FAIL",
            params: {
              file: "src/pages/nested.tsx",
              matcher: {
                any: [{ text: "nested", options: { case_sensitive: false } }],
              },
            },
          }],
        }],
      }, null, 2),
      "```",
      "This object is ready for audit-to-prd.",
    ].join("\n");

    const parsed = parseFindingsJsonOutput(output);

    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.data.findings[0].scope.targets[0].metadata.checks[0].params.required, true);
    assert.equal(parsed.data.findings[0].post_conditions[0].params.matcher.any[0].options.case_sensitive, false);
    assert.equal(validateFindings(parsed.data).ok, true);
  });
});

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

  test("brainstorm persists content-derived evidence requirements in session state", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-evidence-requirements-"));
    try {
      const result = runDemandBrainstormRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Create onboarding checklist copy modeled on https://example.com/checklist-guide.",
        target_users: ["freelance designer"],
        status_quo: ["Designers copy checklist items from old notes."],
        success_criteria: ["Designer sees checklist copy aligned to the external guide."],
        non_goals: ["No calendar sync."],
        writeArtifacts: true,
      });

      const read = readDemandSession(join(result.demand_dir, "session.json"));
      assert.equal(read.ok, true);
      assert.equal(read.session.evidence_requirements.length > 0, true);
      assert.equal(read.session.evidence_requirements[0].kind, "external");
      assert.equal(read.session.evidence_requirements[0].status, "pending");
      assert.equal(read.session.evidence_requirement_summary.pending > 0, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discuss requires approval and compiles approved demand to L3 PRD", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-discuss-"));
    try {
      seedDemandTargetFiles(root, ["src/services/label-summary.ts"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Build a label summary helper for support operators.",
        target_users: ["support operator"],
        status_quo: ["Operators manually trim and normalize labels before writing summaries."],
        evidence: ["Support notes show repeated label cleanup before handoff.", "The existing helper file is src/services/label-summary.ts."],
        assumptions: ["Labels arrive as short plain strings from the support form."],
        success_criteria: ["Operators get a trimmed label summary from one helper call."],
        constraints: ["Do not change ticket routing behavior."],
        non_goals: ["Do not build a label editor."],
        target_files: ["src/services/label-summary.ts"],
        decisions: ["Start with trimming whitespace and returning the normalized label text."],
        roadmap: ["MVP label summary helper."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      assert.equal(discuss.status, "success");
      assert.equal(discuss.readiness.readiness_level, "L3");
      const read = readDemandSession(join(discuss.demand_dir, "session.json"));
      assert.equal(read.ok, true);
      assert.equal(read.session.approval.approved, true);
      assert.equal(read.session.approval.effective_for_prd, true);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        base_commit: "abcdef0",
        writeArtifacts: true,
      });

      assert.equal(prd.status, "success");
      requirePrd(prd);
      assert.equal(prd.prd.base_commit, "abcdef0");
      assert.equal(prd.prd.demand.approval.effective_for_prd, true);
      assert.equal(prd.prd.execution_readiness.level, "L3");
      assert.equal(prd.prd.execution_readiness.atomic_tasks, true);
      assert.equal(prd.prd.demand.quality_report.status, "pass");
      assert.equal(prd.prd.demand.project_facts.target_files.every((fact) => fact.status === "verified"), true);
      assert.equal(prd.prd.demand.project_facts.assumptions.every((fact) => fact.status !== "needs_verification" && fact.status !== "contradicted"), true);
      assert.equal(prd.prd.demand.quality_report.dimensions.length, 6);
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

      const check = inspectYoloCheck({
        prdPath: prd.artifacts[0],
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        writeLifecycle: true,
      });
      assert.notEqual(check.checks.find((item) => item.name === "demand_contract").status, "blocked");
      const guard = inspectLifecycleGuard({
        command: "yolo-run",
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        prdPath: prd.artifacts[0],
      });
      assert.equal(guard.status, "pass", JSON.stringify(guard.blockers, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PRD compilation stamps approval effective_for_prd from verified readiness", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-prd-effective-"));
    try {
      seedDemandTargetFiles(root, ["src/services/label-summary.ts"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Build a label summary helper for support operators.",
        target_users: ["support operator"],
        status_quo: ["Operators manually trim and normalize labels before writing summaries."],
        evidence: ["Support notes show repeated label cleanup before handoff.", "The existing helper file is src/services/label-summary.ts."],
        assumptions: ["Labels arrive as short plain strings from the support form."],
        success_criteria: ["Operators get a trimmed label summary from one helper call."],
        constraints: ["Do not change ticket routing behavior."],
        non_goals: ["Do not build a label editor."],
        target_files: ["src/services/label-summary.ts"],
        decisions: ["Start with trimming whitespace and returning the normalized label text."],
        roadmap: ["MVP label summary helper."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });
      assert.equal(discuss.status, "success");
      assert.equal(discuss.readiness.executable_prd_ready, true);

      const read = readDemandSession(join(discuss.demand_dir, "session.json"));
      assert.equal(read.ok, true);
      delete read.session.approval.effective_for_prd;
      writeJson(join(discuss.demand_dir, "session.json"), read.session);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        base_commit: "abcdef0",
        writeArtifacts: true,
      });

      assert.equal(prd.status, "success", JSON.stringify(prd.blockers, null, 2));
      requirePrd(prd);
      assert.equal(prd.prd.demand.approval.approved, true);
      assert.equal(prd.prd.demand.approval.effective_for_prd, true);

      const check = inspectYoloCheck({
        prdPath: prd.artifacts[0],
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        writeLifecycle: false,
      });

      assert.equal(check.blockers.some((blocker) => blocker.code === "DEMAND_APPROVAL_NOT_EFFECTIVE_FOR_PRD"), false);
      assert.notEqual(check.checks.find((item) => item.name === "demand_contract").status, "blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand PRD quality gate blocks vague proof despite readiness passing", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-quality-proof-"));
    try {
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["ok"],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Start with an inline badge labelled 'Low stock' after the SKU when item.quantity <= item.lowStockThreshold."],
        roadmap: ["MVP badge in inventory list."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
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
      if ("prd" in prd) assert.equal(prd.prd, null);
      if ("quality_report" in prd && prd.quality_report) {
        assert.ok(prd.quality_report.blockers.some((blocker: { code: string }) => blocker.code === "QUALITY_SCENARIO_PROOF_CONCRETE"));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand PRD blocks unverified project field assumptions", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-field-grounding-"));
    try {
      mkdirSync(join(root, "src/pages"), { recursive: true });
      writeFileSync(join(root, "src/pages/inventory-list.tsx"), "export function InventoryList({ items }) { return items.map((item) => item.quantity).join(','); }\n", "utf8");
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory list already receives quantity and threshold fields."],
        success_criteria: ["Inventory list displays a visible low-stock badge on affected SKUs."],
        proof: ["A store manager can point to the low-stock badge on an affected SKU."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Start with an inline badge labelled 'Low stock' after the SKU."],
        roadmap: ["MVP badge in inventory list."],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      assert.equal(discuss.readiness.status, "blocked");
      assert.equal(discuss.session.approval.approved, true);
      assert.equal(discuss.session.approval.effective_for_prd, false);
      assert.ok(discuss.session.approval.blocked_by.some((blocker) => blocker.code === "PROJECT_FACTS_GROUNDED"));
      assert.ok(discuss.readiness.blockers.some((blocker) => blocker.code === "PROJECT_FACTS_GROUNDED"));
      assert.ok(discuss.readiness.blockers.some((blocker) => (
        blocker.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_CONTRADICTED_ASSUMPTION_BLOCKED")
        || blocker.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_FIELD_ASSUMPTION_VERIFIED")
      )));

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      assert.ok(prd.blockers.some((blocker) => (
        blocker.code === "PROJECT_FACTS_GROUNDED"
        || blocker.code === "QUALITY_FIELD_ASSUMPTION_VERIFIED"
        || blocker.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_FIELD_ASSUMPTION_VERIFIED")
        || blocker.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_CONTRADICTED_ASSUMPTION_BLOCKED")
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand PRD blocks unresolved conditional UI style source", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-conditional-style-"));
    try {
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Agent read src/pages/inventory-list.tsx and confirmed inventory rows expose item.quantity and item.lowStockThreshold."],
        assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory list displays an inline 'Low stock' badge after the SKU when item.quantity <= item.lowStockThreshold."],
        proof: ["A screenshot or component test shows an inline 'Low stock' badge after the SKU when item.quantity <= item.lowStockThreshold."],
        visual_style: ["Use an existing project badge component if one is present; otherwise use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Show an inline badge labelled 'Low stock' after the SKU when item.quantity <= item.lowStockThreshold."],
        roadmap: ["MVP badge in inventory list."],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      const grounding = discuss.readiness.blockers.find((blocker) => blocker.code === "PROJECT_FACTS_GROUNDED");
      assert.equal(discuss.readiness.status, "blocked");
      assert.equal(discuss.session.approval.effective_for_prd, false);
      assert.ok(grounding?.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_UI_STYLE_SOURCE_RESOLVED"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("auto-scouted files stay candidates until user or evidence verifies scope", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-candidate-scope-"));
    try {
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        success_criteria: ["Inventory list displays a visible low-stock badge on affected SKUs."],
        proof: ["A store manager can point to the low-stock badge on an affected SKU."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        decisions: ["Start with an inline badge labelled 'Low stock' after the SKU when item.quantity <= item.lowStockThreshold."],
        roadmap: ["MVP badge in inventory list."],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      assert.deepEqual(discuss.session.project.target_files, []);
      assert.ok(discuss.session.project.candidate_target_files.includes("src/pages/inventory-list.tsx"));
      assert.equal(discuss.readiness.executable_prd_ready, false);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      assert.ok(prd.blockers.some((blocker) => blocker.code === "EXECUTION_SCOPE_PRESENT"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand blocks target files outside the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-target-boundary-"));
    const outsideFile = `${root}-outside.js`;
    try {
      writeFileSync(outsideFile, "export const lowStockThreshold = 3;\n", "utf8");
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers a low-stock signal.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: [`Agent read ${outsideFile} and claims it is the target file.`],
        assumptions: [
          "The implementation file must remain inside the target project root.",
          "The selected implementation file exposes lowStockThreshold.",
        ],
        success_criteria: ["Inventory list displays a visible low-stock signal."],
        proof: ["A test verifies the low-stock signal is visible."],
        visual_style: ["Use current project styling."],
        constraints: ["Do not read or modify files outside this project."],
        non_goals: ["Do not change order import behavior."],
        target_files: [outsideFile],
        decisions: ["Keep execution scope confined to the project root."],
        roadmap: ["MVP low-stock signal."],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      const targetFact = discuss.session.project_facts.target_files.find((fact) => fact.file === outsideFile);
      assert.equal(discuss.status, "blocked");
      assert.deepEqual(discuss.session.project.target_files, []);
      assert.equal(targetFact.status, "invalid_scope");
      const outsideAssumption = discuss.session.project_facts.assumptions.find((fact) => /lowStockThreshold/.test(fact.text));
      assert.notEqual(outsideAssumption.status, "verified");
      assert.equal(outsideAssumption.verified_by?.includes("project_read"), false);
      assert.equal(discuss.readiness.blockers.some((blocker) => (
        blocker.code === "PROJECT_FACTS_GROUNDED"
        && blocker.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_TARGET_FILE_WITHIN_PROJECT")
      )), true);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });
      assert.equal(prd.status, "blocked");
      assert.equal(prd.blockers.some((blocker) => (
        blocker.code === "PROJECT_FACTS_GROUNDED"
        || blocker.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_TARGET_FILE_WITHIN_PROJECT")
      )), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outsideFile, { force: true });
    }
  });

  test("legacy demand readiness blocks raw target files outside the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-legacy-target-boundary-"));
    const outsideFile = `${root}-outside.js`;
    try {
      writeFileSync(outsideFile, "export const outsideProject = true;\n", "utf8");
      const readiness = inspectDemandReadiness({
        phase: "prd",
        vision: {
          statement: "Show store managers a clear low-stock signal.",
          target_users: ["store manager"],
          status_quo: ["Managers only see raw counts."],
        },
        reflection: {
          assumptions: ["Scope must stay inside the project root."],
        },
        investigation: {
          evidence: ["Existing project files were reviewed."],
        },
        requirements: {
          active: [{
            id: "REQ-1",
            text: "Inventory list displays a visible low-stock signal.",
            acceptance_scenarios: [{ then: "The low-stock signal is visible." }],
          }],
          out_of_scope: ["No backend changes."],
        },
        scenario_matrix: {
          scenarios: [{
            id: "SCN-1",
            proof: "A test verifies the low-stock signal.",
            surfaces: [{
              id: "SFC-1",
              target_files: [outsideFile],
              session_budget: { max_files: 1 },
            }],
          }],
        },
        approval: { approved: true },
        project: { target_files: [outsideFile] },
        roadmap: { mvp: ["MVP low-stock signal."] },
      }, { phase: "prd", projectRoot: root });

      assert.equal(readiness.status, "blocked");
      assert.equal(readiness.blockers.some((blocker) => (
        blocker.code === "PROJECT_FACTS_GROUNDED"
        && blocker.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_TARGET_FILE_WITHIN_PROJECT")
      )), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outsideFile, { force: true });
    }
  });

  test("inspectDemandQuality flags missing proof handoff and atomicity gaps", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-quality-pure-"));
    try {
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["A store manager can point to the low-stock badge on an affected SKU."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Start with an inline badge labelled 'Low stock' after the SKU when item.quantity <= item.lowStockThreshold."],
        roadmap: ["MVP badge in inventory list."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });
      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });
      assert.equal(prd.status, "success");
      requirePrd(prd);

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
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["A store manager can point to the badge on a low-stock SKU."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        exceptions: ["What if the inventory system is down?"],
        decisions: ["Show an inline badge labelled 'Low stock' after the SKU when item.quantity <= item.lowStockThreshold."],
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
        playback: { confirmed: true, confirmed_by: "user" },
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
      requirePrd(prd);
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
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts in the inventory list."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["A store manager can point to the low-stock badge on an affected SKU."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Start with an inline badge labelled 'Low stock' after the SKU when item.quantity <= item.lowStockThreshold."],
        roadmap: ["MVP badge in inventory list."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
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
      requirePrd(prd);
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

      assert.notEqual(check.status, "blocked", JSON.stringify(check.blockers, null, 2));
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
        playback: { confirmed: true, confirmed_by: "user" },
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
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx", "src/services/inventory-alerts.ts"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx", "src/services/inventory-alerts.ts"],
        decisions: ["Start with one threshold rule item.quantity <= item.lowStockThreshold and one inline badge labelled 'Low stock'."],
        roadmap: ["MVP service rule and list badge."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
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

  test("approved demand compiles scenario surfaces but blocks investigate-first tasks before executable write", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-atomic-"));
    try {
      seedDemandTargetFiles(root, ["src/services/inventory-alerts.ts", "src/pages/inventory-list.tsx", "src/services/inventory-alerts.test.ts"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts in a spreadsheet-like list."],
        evidence: ["Weekly support tickets mention surprise stockouts."],
        assumptions: ["Existing inventory service already returns item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory service marks low-stock SKUs.", "Inventory list displays a visible low-stock badge."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/services/inventory-alerts.ts", "src/pages/inventory-list.tsx", "src/services/inventory-alerts.test.ts"],
        decisions: ["Start with one threshold rule item.quantity <= item.lowStockThreshold and one inline badge labelled 'Low stock'."],
        deferred: ["Forecasting and supplier ordering remain later demands."],
        deferred_scope_confirmed: true,
        roadmap: ["MVP service rule and list badge."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      assert.equal(prd.code, "DEMAND_PRD_PREFLIGHT_BLOCKED");
      if ("prd" in prd) assert.equal(prd.prd, null);
      assert.deepEqual(prd.artifacts, []);
      assert.ok(prd.blockers.some((blocker) => blocker.code === "ATOMICITY_INVESTIGATE_FIRST"));
      if (!("compiled" in prd) || !prd.compiled) throw new Error("expected compiled");
      const compiledPrd = prd.compiled.prd;
      assert.equal(compiledPrd.tasks.length >= 3, true);
      assert.equal(compiledPrd.tasks.every((task) => task.task_kind === "demand_atomic_task"), true);
      assert.equal(compiledPrd.tasks.every((task) => task.scope.max_files <= 2), true);
      assert.equal(compiledPrd.tasks.every((task) => Boolean(task.handoff.proof)), true);
      assert.equal(compiledPrd.demand.approval.approved_at !== null, true);
      assert.ok(compiledPrd.demand.deferred_scope.includes("Forecasting and supplier ordering remain later demands."));
      assert.equal(compiledPrd.demand.deferred_scope_confirmation.confirmed, true);
      assert.equal(compiledPrd.demand.deferred_follow_up.required, true);
      assert.ok(compiledPrd.demand.deferred_follow_up.next_session_prompt.includes("Forecasting and supplier ordering"));
      assert.ok(compiledPrd.tasks.every((task) => task.handoff.deferred_scope.includes("Forecasting and supplier ordering remain later demands.")));
      assert.ok(compiledPrd.tasks.every((task) => task.handoff.deferred_scope_confirmation.confirmed === true));
      assert.ok(compiledPrd.tasks.every((task) => task.handoff.deferred_follow_up.required === true));
      assert.equal(compiledPrd.tasks.some((task) => task.handoff.surface.kind === "ui"), true);
      assert.equal(compiledPrd.tasks.some((task) => task.handoff.surface.kind === "service"), true);
      assert.equal(compiledPrd.tasks.some((task) => task.handoff.surface.kind === "test"), true);
      const serviceTask = compiledPrd.tasks.find((task) => task.handoff.surface.kind === "service");
      const testTask = compiledPrd.tasks.find((task) => task.handoff.surface.kind === "test");
      assert.ok(testTask.depends_on.includes(serviceTask.id));
      assert.ok(testTask.handoff.read_first.includes("src/services/inventory-alerts.ts"));
      assert.ok(testTask.post_conditions.some((condition) => condition.type === "tests_pass" && condition.severity === "FAIL"));
      assert.equal(compiledPrd.tasks.every((task) => task.post_conditions.some((condition) => condition.severity === "FAIL" && condition.type !== "acceptance_criteria")), true);
      for (const task of compiledPrd.tasks) {
        assertTaskSessionPlan(task, compiledPrd.demand.id);
      }
      const handoffStats = compiledPrd.execution_readiness.session_handoff;
      assert.equal(handoffStats.planned, true);
      assert.equal(handoffStats.task_count, compiledPrd.tasks.length);
      assert.equal(handoffStats.session_count, compiledPrd.tasks.length);
      assert.equal(handoffStats.tasks_with_session_plan, compiledPrd.tasks.length);
      assert.equal(handoffStats.state_paths.length, compiledPrd.tasks.length);
      assert.equal(handoffStats.handoff_paths.length, compiledPrd.tasks.length);
      assert.equal(handoffStats.evidence_paths.length, compiledPrd.tasks.length);
      assert.equal(handoffStats.memory_update_paths.includes(".yolo/memory/CURRENT_HANDOFF.md"), true);
      assert.equal(handoffStats.memory_update_paths.includes(".yolo/state/session-memory.jsonl"), true);
      assert.equal(handoffStats.progress_update_paths.includes(".yolo/memory/PROGRESS.md"), true);
      assert.deepEqual(compiledPrd.demand.atomicity_contract.session_handoff, handoffStats);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved demand splits compound Trello-style user stories before task generation", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-story-split-"));
    try {
      seedDemandTargetFiles(root, ["package.json", "index.html", "src/styles.css", "tests/board.e2e.cjs"]);
      writeProjectFile(root, "src/app.js", [
        "const STORAGE_KEY = 'yolo-board-state';",
        "export function loadBoard() { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }",
        "export function saveBoard(board) { localStorage.setItem(STORAGE_KEY, JSON.stringify(board)); }",
        "",
      ].join("\n"));
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Build a local Trello-style board MVP.",
        target_users: ["small team lead"],
        status_quo: ["Tasks are tracked in notes and chat messages."],
        evidence: [
          "Agent read src/app.js and verified it already uses localStorage through loadBoard and saveBoard.",
          "Agent read src/styles.css and tests/board.e2e.cjs as the board layout and Playwright coverage entry points.",
        ],
        assumptions: ["The local MVP can stay single-user and does not need collaboration, auth, comments, or labels."],
        success_criteria: [
          "当用户输入 Review 并提交时, 新列表 Review 出现在看板末尾, 当用户在 Todo 输入 Prepare demo 并提交时, 卡片显示在 Todo 列表。",
          "当用户把 Prepare demo 编辑为 Prepare customer demo 并移动到 Doing 时, Todo 列表不再显示该卡片, Doing 列表显示 Prepare customer demo。",
          "当用户归档 Prepare customer demo 并刷新页面时, 普通列表不显示该归档卡片, 未归档列表和卡片仍从 localStorage 恢复。",
        ],
        proof: [
          "Playwright verifies Review appears as the final board list after submitting the list form.",
          "Playwright verifies Prepare demo appears inside the Todo list after submitting the card form.",
          "Playwright verifies Prepare demo changes to Prepare customer demo after editing the card title.",
          "Playwright verifies Prepare customer demo appears in Doing and no longer appears in Todo after moving it.",
          "Playwright verifies the archived Prepare customer demo card is hidden from normal lists.",
          "Playwright reloads the page and verifies unarchived lists and cards restore from localStorage.",
        ],
        visual_style: ["Use the existing compact board layout from src/styles.css without introducing a new visual system."],
        constraints: ["Local single-page MVP only."],
        non_goals: ["No Trello API or login."],
        target_files: ["package.json", "index.html", "src/app.js", "src/styles.css", "tests/board.e2e.cjs"],
        decisions: ["Keep every task to one visible board behavior."],
        roadmap: ["MVP board behavior slices."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      assert.equal(discuss.status, "success");
      const scenarios = discuss.session.scenario_matrix.scenarios;
      assert.equal(scenarios.length, 6);
      assert.equal(scenarios.some((scenario) => scenario.requirement_id === "REQ-001-S01"), true);
      assert.equal(scenarios.some((scenario) => scenario.requirement_id === "REQ-002-S02"), true);
      assert.equal(scenarios.every((scenario) => !(/新增列表/.test(scenario.desired_behavior) && /新增卡片|卡片显示/.test(scenario.desired_behavior))), true);
      assert.equal(scenarios.every((scenario) => !(/编辑/.test(scenario.desired_behavior) && /移动/.test(scenario.desired_behavior))), true);
      assert.equal(scenarios.every((scenario) => !(/(?<!未)归档/u.test(scenario.desired_behavior) && /刷新|重新加载|恢复/.test(scenario.desired_behavior))), true);
      assert.match(discuss.session.scenario_matrix.atomic_task_rule, /one user-visible story/);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      assert.equal(prd.code, "DEMAND_PRD_PREFLIGHT_BLOCKED");
      if ("prd" in prd) assert.equal(prd.prd, null);
      assert.ok(prd.blockers.some((blocker) => blocker.code === "ATOMICITY_INVESTIGATE_FIRST"));
      if (!("compiled" in prd) || !prd.compiled) throw new Error("expected compiled");
      const compiledPrd = prd.compiled.prd;
      assert.equal(compiledPrd.tasks.some((task) => task.requirement_ids.includes("REQ-003-S02")), true);
      assert.equal(compiledPrd.tasks.every((task) => !(/编辑/.test(task.description) && /移动/.test(task.description))), true);
      assert.match(compiledPrd.demand.atomicity_contract.rule, /one user-visible story/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand PRD blocks deferred scope without explicit confirmation", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-deferred-confirm-"));
    try {
      seedDemandTargetFiles(root, ["src/api/orders.ts", "src/api/orders.test.ts"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Reject negative order line quantities for operations admins.",
        target_users: ["operations admin"],
        status_quo: ["Order validation checks customer but not invalid line quantities."],
        evidence: ["src/api/orders.ts reads input.lines as the order line payload and declares ORDER_LINE_QUANTITY_FIELD = 'quantity'."],
        assumptions: ["Order line quantities are present as input.lines[].quantity."],
        success_criteria: ["validateOrder returns ok:false with error code NEGATIVE_QUANTITY when any input.lines[].quantity < 0."],
        proof: ["A regression test calls validateOrder with input.lines[].quantity < 0 and observes ok:false plus error code NEGATIVE_QUANTITY."],
        constraints: ["Do not change fulfillment integration."],
        non_goals: ["Do not redesign order creation UI."],
        target_files: ["src/api/orders.ts", "src/api/orders.test.ts"],
        decisions: ["Add negative quantity validation only."],
        deferred: ["Zero quantity validation is deferred.", "Inventory availability checks are deferred."],
        roadmap: ["MVP negative quantity validation."],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      assert.equal(discuss.session.discussion.deferred_scope_confirmation.required, true);
      assert.equal(discuss.session.discussion.deferred_scope_confirmation.confirmed, false);
      assert.equal(discuss.session.approval.approved, true);
      assert.equal(discuss.session.approval.effective_for_prd, false);
      assert.ok(discuss.readiness.blockers.some((blocker) => blocker.code === "DEFERRED_SCOPE_CONFIRMED"));

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      assert.ok(prd.blockers.some((blocker) => blocker.code === "DEFERRED_SCOPE_CONFIRMED"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("task session handoff paths preserve non-ASCII demand ids", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-cjk-"));
    try {
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demand_id: "DEMAND-20260529-库存预警",
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["A store manager can point to the low-stock badge on an affected SKU."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Start with an inline badge labelled 'Low stock' after the SKU when item.quantity <= item.lowStockThreshold."],
        roadmap: ["MVP badge in inventory list."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "success");
      requirePrd(prd);
      assert.match(prd.prd.id, /^[A-Z]+-[0-9]+-[A-Z0-9-]+$/);
      assert.equal(prd.prd.tasks[0].handoff.session.state_path, ".yolo/demand/DEMAND-20260529-库存预警/tasks/DEMAND-REQ-001-0010101/session.json");
      assert.ok(prd.prd.execution_readiness.session_handoff.state_paths[0].includes("库存预警"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("P8.L7: readDemandSession rejects sessions with wrong/missing schema_version", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-schema-"));
    try {
      const validSession = {
        schema_version: "1.0",
        schema: "yolo.demand.session.v1",
        id: "DEMAND-VALID-001",
        objective: "valid session",
      };
      const validPath = join(root, "valid", "session.json");
      mkdirSync(dirname(validPath), { recursive: true });
      writeFileSync(validPath, JSON.stringify(validSession), "utf8");
      assert.equal(readDemandSession(join(root, "valid")).ok, true);

      const futureVersion = { ...validSession, schema_version: "2.0" };
      const futurePath = join(root, "future", "session.json");
      mkdirSync(dirname(futurePath), { recursive: true });
      writeFileSync(futurePath, JSON.stringify(futureVersion), "utf8");
      const futureRead = readDemandSession(join(root, "future"));
      assert.equal(futureRead.ok, false);
      assert.match(futureRead.error, /unsupported schema_version "2\.0"/);

      const wrongSchema = { ...validSession, schema: "yolo.demand.session.v2" };
      const wrongPath = join(root, "wrong-schema", "session.json");
      mkdirSync(dirname(wrongPath), { recursive: true });
      writeFileSync(wrongPath, JSON.stringify(wrongSchema), "utf8");
      const wrongRead = readDemandSession(join(root, "wrong-schema"));
      assert.equal(wrongRead.ok, false);
      assert.match(wrongRead.error, /unsupported schema "yolo\.demand\.session\.v2"/);

      const missingFields = { id: "no-schema-fields" };
      const missingPath = join(root, "missing", "session.json");
      mkdirSync(dirname(missingPath), { recursive: true });
      writeFileSync(missingPath, JSON.stringify(missingFields), "utf8");
      const missingRead = readDemandSession(join(root, "missing"));
      assert.equal(missingRead.ok, false);
      assert.match(missingRead.error, /unsupported schema_version "undefined"/);

      // Helper returns null for the valid shape and a string otherwise.
      assert.equal(demandSessionSchemaError(validSession), null);
      assert.ok(typeof demandSessionSchemaError(futureVersion) === "string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
