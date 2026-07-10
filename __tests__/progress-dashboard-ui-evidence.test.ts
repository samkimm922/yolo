import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { buildAcceptanceReport } from "../src/runtime/acceptance/report.js";
import { buildProgressDashboardUiEvidence } from "../src/runtime/progress/ui-evidence.js";
import { runRunnerRuntime } from "../src/runtime/runner-runtime.js";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";
import { inspectYoloCheck } from "../src/runtime/gates/check-report.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "yolo-progress-ui-evidence-"));
  mkdirSync(join(root, ".yolo", "keys"), { recursive: true });
  writeFileSync(join(root, ".yolo", "keys", "ledger.hmac"), "progress-ui-test-ledger-key", "utf8");
  return root;
}

function writeJson(file, payload) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function approvedDemandFields(targetFiles = []) {
  const quality = {
    schema_version: "1.0",
    schema: "yolo.demand.quality.v1",
    status: "pass",
    total_score: 100,
    dimensions: [],
  };
  return {
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: "DEMAND-PROGRESS-UI-TEST",
      approval: { approved: true, effective_for_prd: true },
      project_facts: {
        target_files: targetFiles.map((file) => ({ file, status: "verified" })),
        assumptions: [],
      },
      quality_report: quality,
    },
    execution_readiness: {
      level: "L3",
      afk_ready: true,
      quality_status: "pass",
      quality_report: quality,
    },
  };
}

function tracedRequirement(id, text) {
  return {
    id,
    text,
    demand_trace: { evidence: [`EVID-${id}`] },
  };
}

function prepareRunLifecycle(projectRoot, stateRoot, prdPath) {
  writeLifecycleStageReport("discovery", { status: "success" }, {
    projectRoot,
    stateRoot,
    writeSessionMemory: false,
    skipSequenceCheck: true,
  });
  writeLifecycleStageReport("roadmap", { status: "success" }, {
    projectRoot,
    stateRoot,
    writeSessionMemory: false,
    skipSequenceCheck: true,
  });
  writeLifecycleStageReport("prd", { status: "success", prd_path: prdPath, artifacts: [prdPath] }, {
    projectRoot,
    stateRoot,
    writeSessionMemory: false,
    skipSequenceCheck: true,
  });
  return inspectYoloCheck({ prdPath, projectRoot, stateRoot, writeLifecycle: true });
}

function progressUiPrd() {
  return {
    version: "2.0", id: "PRD-20260526-PROGRESS-UI", title: "Progress dashboard UI evidence",
    project: { name: "progress-ui", language: "javascript" },
    generated_by: "yolo-review-agent", generated_at: "2026-05-26T00:00:00.000Z", base_commit: "abcdef0",
    ...approvedDemandFields(["src/runtime/progress/server.ts"]),
    requirements: [tracedRequirement("REQ-UI-1", "Progress dashboard must provide usable UI evidence.")],
    designs: [{ id: "DES-UI-1", text: "Use a DESIGN.md/UI-SPEC style UI contract." }],
    state_matrix: { loading: "SSE connected.", empty: "Idle lifecycle visible.", success: "Active run progress visible.", mobile: "Responsive below 640px.", desktop: "Desktop from 640px." },
    evidence_plan: { ui: ["progress dashboard HTML snapshot", "runtime error evidence", "responsive evidence"] },
    tasks: [{
      id: "UI-PROGRESS-001", title: "Validate progress dashboard UI", priority: "P1", type: "feature", status: "pending", ui: true, surface: "progress-dashboard",
      requirement_ids: ["REQ-UI-1"], design_ids: ["DES-UI-1"],
      scope: { targets: [{ file: "src/runtime/progress/server.ts" }], allow_new_files: true },
      acceptance_criteria: ["Progress dashboard exposes active and idle state UI evidence.", "Task and gate data are escaped before entering HTML."],
      post_conditions: [
        { id: "POST-SERVER", type: "target_file_modified", severity: "FAIL", params: { file: "src/runtime/progress/server.ts" } },
        { id: "POST-TYPECHECK", type: "no_new_type_errors", severity: "FAIL", params: { command: "npm run typecheck" } },
      ],
    }],
  };
}

function runReport() {
  return {
    run_id: "run-progress-ui-001",
    status: "success",
    summary: { planned: 1, completed: 1, failed: 0, blocked: 0, skipped: 0 },
  };
}

function adapterManifest() {
  return {
    schema: "yolo.manifest.v1", id: "progress-dashboard-ui", kind: "acceptance_adapter",
    description: "Progress dashboard UI evidence adapter",
    inputs: ["projectRoot", "stateRoot"], outputs: ["ui_evidence"],
    commands: [{ command: "node tools/progress-ui-evidence.js", evidence_path: ".yolo/state/evidence/progress-dashboard-ui/ui-evidence.json" }],
    evidence: ["screenshot", "runtime_log", "ui_contract"],
    capabilities: ["ui", "browser", "page_reachable", "critical_path_passed", "screenshot"],
    applies_to: ["ui", "progress-dashboard"],
  };
}

function writeProgressEvidenceTool(root) {
  writeText(join(root, "tools/progress-ui-evidence.js"), [
    `import { buildProgressDashboardUiEvidence } from ${JSON.stringify(pathToFileURL(join(YOLO_DIR, "dist/src/runtime/progress/ui-evidence.js")).href)};`,
    "buildProgressDashboardUiEvidence({",
    "  projectRoot: process.cwd(),",
    "  stateRoot: `${process.cwd()}/.yolo`,",
    "  outputPath: '.yolo/state/evidence/progress-dashboard-ui/ui-evidence.json',",
    "  browserSmoke: false,",
    "});",
    "",
  ].join("\n"));
}

describe("progress dashboard UI evidence", () => {
  test("writes UI evidence snapshots and escapes task data", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const report = buildProgressDashboardUiEvidence({ projectRoot: root, stateRoot, browserSmoke: false });
      const activeHtml = readFileSync(join(stateRoot, "state/evidence/progress-dashboard-ui/active.html"), "utf8");

      assert.equal(report.status, "pass");
      assert.ok(activeHtml.includes('id="uiEvidencePanel"'));
      assert.ok(activeHtml.includes("color-scheme: light dark"));
      assert.ok(activeHtml.includes("prefers-color-scheme: dark"));
      assert.ok(activeHtml.includes("status-id-done"));
      assert.ok(activeHtml.includes("review-status-box"));
      assert.equal(activeHtml.includes("<img src=x onerror=alert(1)>"), false);
      assert.equal(activeHtml.includes("TASK-&lt;img src=x onerror=alert(1)&gt;"), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("feeds progress UI evidence through adapter bridge into acceptance", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      writeJson(join(stateRoot, "adapters/progress-dashboard-ui.manifest.json"), adapterManifest());
      writeProgressEvidenceTool(root);

      const report = buildAcceptanceReport({
        prd: progressUiPrd(),
        runReport: runReport(),
        reviewReport: { findings: [] },
        projectRoot: root,
        stateRoot,
        collectEvidence: true,
        executeAdapter: true,
        allowAdapterCommands: true,
      });

      assert.equal(report.status, "pass");
      assert.equal(report.adapter_evidence.status, "pass");
      assert.equal(report.ui.ui_task_count, 1);
      assert.ok(report.adapter_evidence.ui_evidence.visual_artifacts.some((item) => item.endsWith("active.html")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo run dry-run can execute UI evidence collection when explicitly authorized", async () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    const prdPath = join(root, ".yolo/data/prd/current/progress-ui.json");
    try {
      writeJson(join(stateRoot, "adapters/progress-dashboard-ui.manifest.json"), adapterManifest());
      writeJson(prdPath, progressUiPrd());
      writeProgressEvidenceTool(root);
      const check = prepareRunLifecycle(root, stateRoot, prdPath);
      assert.notEqual(check.status, "blocked", JSON.stringify(check.blockers, null, 2));

      const result = await runRunnerRuntime({
        prdPath,
        projectRoot: root,
        stateRoot,
        dryRun: true,
        collectEvidence: true,
        executeAdapter: true,
        allowAdapterCommands: true,
        writeLifecycle: false,
      });

      assert.equal(result.status, "dry_run");
      assert.equal(result.code, "RUNNER_DRY_RUN_READY");
      assert.equal(result.exit_code, 2);
      assert.equal(result.adapter_evidence.status, "pass");
      assert.equal(result.adapter_evidence.ui_evidence.required_state_present, true);
      assert.equal(existsSync(join(stateRoot, "state/events.jsonl")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
