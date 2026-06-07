import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildAcceptanceReport, runYoloAcceptCli } from "../src/runtime/acceptance/report.js";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-acceptance-report-"));
}

function writeJson(file, payload) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
}

function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function prd(task = {}) {
  return {
    version: "2.0",
    id: "PRD-20260525-ACCEPT-001",
    title: "Acceptance fixture",
    project: { name: "test", language: "typescript" },
    generated_by: "yolo-review-agent",
    generated_at: "2026-05-25T00:00:00.000Z",
    base_commit: "abcdef0",
    requirements: [{ id: "REQ-1", text: "User can see inventory page." }],
    designs: [{ id: "DES-1", text: "Use UI evidence." }],
    tasks: [{
      id: "FEAT-ACCEPT-001",
      title: "Build inventory page",
      priority: "P1",
      type: "feature",
      status: "completed",
      requirement_ids: ["REQ-1"],
      design_ids: ["DES-1"],
      scope: { targets: [{ file: "src/pages/inventory.tsx" }] },
      acceptance_criteria: ["Inventory page renders."],
      post_conditions: [{
        id: "POST-PAGE",
        type: "target_file_modified",
        severity: "FAIL",
        params: { file: "src/pages/inventory.tsx" },
      }],
      ...task,
    }],
  };
}

function runReport() {
  return {
    status: "success",
    summary: { failed: 0, blocked: 0 },
  };
}

function lifecycleOptions(root) {
  return {
    projectRoot: root,
    stateRoot: join(root, ".yolo"),
    source: "unit",
    writeSessionMemory: false,
  };
}

describe("acceptance report", () => {
  test("blocks UI acceptance when adapter and evidence are missing", () => {
    const root = tempProject();
    try {
      const report = buildAcceptanceReport({
        prd: prd(),
        runReport: runReport(),
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
      });

      assert.equal(report.status, "blocked");
      assert.ok(report.issues.some((issue) => issue.code === "UI_EVIDENCE_MISSING"));
      assert.ok(report.issues.some((issue) => issue.code === "ACCEPTANCE_ADAPTER_MISSING"));
      assert.equal(report.issue_summary.p1 > 0, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies page crashes and layout blockers as P0 hard failures", () => {
    const root = tempProject();
    try {
      writeJson(join(root, ".yolo/adapters/local-browser.manifest.json"), {
        schema: "yolo.manifest.v1",
        id: "local-browser",
        kind: "acceptance_adapter",
        description: "Local browser adapter",
        inputs: ["url"],
        outputs: ["report"],
        commands: [{ command: "npm run accept" }],
        evidence: ["screenshot"],
        capabilities: ["page_reachable"],
      });

      const report = buildAcceptanceReport({
        prd: prd(),
        runReport: runReport(),
        uiEvidence: {
          page_reachable: false,
          content_overlap: true,
          screenshots: ["state/evidence/ui.png"],
        },
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
      });

      assert.equal(report.status, "blocked");
      assert.equal(report.issue_summary.p0, 2);
      assert.ok(report.issues.some((issue) => issue.code === "UI_PAGE_UNREACHABLE"));
      assert.ok(report.issues.some((issue) => issue.code === "UI_LAYOUT_BLOCKER"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("passes clean acceptance evidence and writes lifecycle report", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      writeJson(join(stateRoot, "adapters/local-browser.manifest.json"), {
        schema: "yolo.manifest.v1",
        id: "local-browser",
        kind: "acceptance_adapter",
        description: "Local browser adapter",
        inputs: ["url"],
        outputs: ["report"],
        commands: [{ command: "npm run accept" }],
        evidence: ["screenshot"],
        capabilities: ["page_reachable", "screenshot"],
      });
      const report = buildAcceptanceReport({
        prd: prd(),
        runReport: runReport(),
        reviewReport: { findings: [] },
        uiEvidence: {
          page_reachable: true,
          critical_path_passed: true,
          required_state_present: true,
          screenshots: ["state/evidence/ui.png"],
        },
        projectRoot: root,
        stateRoot,
        writeLifecycle: true,
      });

      assert.equal(report.status, "pass");
      assert.equal(report.issue_summary.total, 0);
      assert.equal(existsSync(join(stateRoot, "lifecycle/acceptance-report.json")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks release acceptance warnings without an approved artifact and returns nonzero", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    let stdout = "";
    let stderr = "";
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, prd());
      writeJson(join(stateRoot, "adapters/local-browser.manifest.json"), {
        schema: "yolo.manifest.v1",
        id: "local-browser",
        kind: "acceptance_adapter",
        description: "Local browser adapter",
        inputs: ["url"],
        outputs: ["report"],
        commands: [{ command: "npm run accept" }],
        evidence: ["screenshot"],
        capabilities: ["page_reachable", "screenshot"],
      });
      writeJson(join(stateRoot, "state/evidence/adapters/local-browser-latest.json"), {
        status: "pass",
        artifact_path: join(stateRoot, "state/evidence/adapters/local-browser-latest.json"),
        ui_evidence: {
          page_reachable: true,
          critical_path_passed: true,
          required_state_present: true,
          screenshots: ["state/evidence/ui.png"],
          polish_notes: ["Spacing should get a final human polish pass."],
        },
      });
      writeLifecycleStageReport("run", {
        status: "success",
        summary: "run passed",
        evidence: [{ path: "state/run/run-report.json" }],
      }, lifecycleOptions(root));
      writeLifecycleStageReport("review-fix", {
        status: "success",
        summary: "review passed",
        findings: [],
        evidence: [{ path: "state/review/review-report.json" }],
      }, lifecycleOptions(root));

      const exitCode = runYoloAcceptCli(["--cwd", root, "prd.json", "--release", "--json", "--no-write"], {
        cwd: root,
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const report = JSON.parse(stdout);

      assert.equal(exitCode, 1);
      assert.equal(stderr, "");
      assert.equal(report.status, "blocked");
      assert.equal(report.mode, "release");
      assert.equal(report.issue_summary.p2, 1);
      assert.ok(report.issues.some((issue) => issue.code === "ACCEPTANCE_WARNING_APPROVAL_MISSING"));
      assert.equal(report.warning_approval.approved, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks release warnings when the approval artifact is stale or unbound", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdPath = join(root, "prd.json");
      const approvalPath = join(stateRoot, "lifecycle/acceptance-approval.json");
      writeJson(prdPath, prd());
      writeJson(approvalPath, { status: "approved" });

      const report = buildAcceptanceReport({
        prdPath,
        prd: prd(),
        runReport: runReport(),
        reviewReport: { findings: [] },
        uiEvidence: {
          page_reachable: true,
          critical_path_passed: true,
          required_state_present: true,
          screenshots: ["state/evidence/ui.png"],
          polish_notes: ["Spacing should get a final human polish pass."],
        },
        resolver: { selected: { acceptance_adapter: { id: "local-browser" } }, blockers: [] },
        projectRoot: root,
        stateRoot,
        mode: "release",
        approvalArtifact: approvalPath,
      });

      assert.equal(report.status, "blocked");
      assert.equal(report.warning_approval.approved, false);
      assert.ok(report.issues.some((issue) => issue.code === "ACCEPTANCE_WARNING_APPROVAL_AUDIT_FIELDS_MISSING"));
      assert.ok(report.issues.some((issue) => issue.code === "ACCEPTANCE_WARNING_APPROVAL_PRD_MISMATCH"));
      assert.ok(report.issues.some((issue) => issue.code === "ACCEPTANCE_WARNING_APPROVAL_MISSING"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks malformed release approval artifacts as structured acceptance issues", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdPath = join(root, "prd.json");
      const approvalPath = join(stateRoot, "lifecycle/acceptance-approval.json");
      writeJson(prdPath, prd());
      writeText(approvalPath, "{not-json");

      const report = buildAcceptanceReport({
        prdPath,
        prd: prd(),
        runReport: runReport(),
        reviewReport: { findings: [] },
        uiEvidence: {
          page_reachable: true,
          critical_path_passed: true,
          required_state_present: true,
          screenshots: ["state/evidence/ui.png"],
          polish_notes: ["Spacing should get a final human polish pass."],
        },
        resolver: { selected: { acceptance_adapter: { id: "local-browser" } }, blockers: [] },
        projectRoot: root,
        stateRoot,
        mode: "release",
        approvalArtifact: approvalPath,
      });

      assert.equal(report.status, "blocked");
      assert.ok(report.issues.some((issue) => issue.code === "ACCEPTANCE_WARNING_APPROVAL_MALFORMED"));
      assert.ok(report.issues.some((issue) => issue.code === "ACCEPTANCE_WARNING_APPROVAL_MISSING"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts release warnings only with approval bound to the current PRD and warning set", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdPath = join(root, "prd.json");
      const approvalPath = join(stateRoot, "lifecycle/acceptance-approval.json");
      writeJson(prdPath, prd());
      writeJson(approvalPath, {
        approved: true,
        approver: "release-owner",
        approved_at: "2026-06-06T00:00:00.000Z",
        prd_path: prdPath,
        mode: "release",
        warning_count: 1,
      });

      const report = buildAcceptanceReport({
        prdPath,
        prd: prd(),
        runReport: runReport(),
        reviewReport: { findings: [] },
        uiEvidence: {
          page_reachable: true,
          critical_path_passed: true,
          required_state_present: true,
          screenshots: ["state/evidence/ui.png"],
          polish_notes: ["Spacing should get a final human polish pass."],
        },
        resolver: { selected: { acceptance_adapter: { id: "local-browser" } }, blockers: [] },
        projectRoot: root,
        stateRoot,
        mode: "release",
        approvalArtifact: approvalPath,
      });

      assert.equal(report.status, "warning");
      assert.equal(report.issue_summary.p1, 0);
      assert.equal(report.warning_approval.approved, true);
      assert.equal(report.warning_approval.expected.warning_count, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("can collect UI evidence through an authorized adapter bridge", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      writeJson(join(stateRoot, "adapters/local-browser.manifest.json"), {
        schema: "yolo.manifest.v1",
        id: "local-browser",
        kind: "acceptance_adapter",
        description: "Local browser adapter",
        inputs: ["url"],
        outputs: ["ui_evidence"],
        commands: [{
          command: "node tools/write-evidence.cjs",
          evidence_path: ".yolo/state/evidence/ui/latest.json",
        }],
        evidence: ["screenshot"],
        capabilities: ["page_reachable", "screenshot"],
      });
      writeText(join(root, "tools/write-evidence.cjs"), [
        "const fs = require('fs');",
        "fs.mkdirSync('.yolo/state/evidence/ui', { recursive: true });",
        "fs.writeFileSync('.yolo/state/evidence/ui/latest.json', JSON.stringify({",
        "  page_reachable: true,",
        "  critical_path_passed: true,",
        "  required_state_present: true,",
        "  screenshots: ['.yolo/state/evidence/ui/inventory.png']",
        "}));",
        "",
      ].join("\n"));

      const report = buildAcceptanceReport({
        prd: prd(),
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
      assert.ok(report.artifacts.some((artifact) => artifact.endsWith(".yolo/state/evidence/adapters/local-browser-latest.json")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks collected adapter evidence that does not cover the PRD platform", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      writeJson(join(stateRoot, "adapters/local-browser.manifest.json"), {
        schema: "yolo.manifest.v1",
        id: "local-browser",
        kind: "acceptance_adapter",
        description: "Local browser adapter",
        inputs: ["url"],
        outputs: ["ui_evidence"],
        commands: [{
          command: "node tools/write-evidence.cjs",
          evidence_path: ".yolo/state/evidence/ui/latest.json",
          platform: "weapp",
        }],
        evidence: ["screenshot"],
        capabilities: ["page_reachable", "screenshot"],
        applies_to: ["ui", "h5", "weapp"],
      });
      writeText(join(root, "tools/write-evidence.cjs"), [
        "const fs = require('fs');",
        "fs.mkdirSync('.yolo/state/evidence/ui', { recursive: true });",
        "fs.writeFileSync('.yolo/state/evidence/ui/latest.json', JSON.stringify({",
        "  platform: 'h5',",
        "  page_reachable: true,",
        "  critical_path_passed: true,",
        "  required_state_present: true,",
        "  screenshots: ['.yolo/state/evidence/ui/inventory.png']",
        "}));",
        "",
      ].join("\n"));

      const report = buildAcceptanceReport({
        prd: { ...prd(), platform: "weapp" },
        runReport: runReport(),
        reviewReport: { findings: [] },
        projectRoot: root,
        stateRoot,
        collectEvidence: true,
        executeAdapter: true,
        allowAdapterCommands: true,
      });

      assert.equal(report.status, "blocked");
      assert.equal(report.adapter_evidence.code, "ADAPTER_EVIDENCE_PLATFORM_MISMATCH");
      assert.ok(report.issues.some((issue) => issue.code === "ADAPTER_EVIDENCE_BLOCKED" && issue.required_platform === "weapp"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads default lifecycle run report and latest adapter evidence after run", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      writeJson(join(stateRoot, "adapters/progress-dashboard-ui.manifest.json"), {
        schema: "yolo.manifest.v1",
        id: "progress-dashboard-ui",
        kind: "acceptance_adapter",
        description: "Progress dashboard adapter",
        inputs: ["projectRoot"],
        outputs: ["ui_evidence"],
        commands: [{ command: "node tools/progress-ui-evidence.js" }],
        evidence: ["screenshot"],
        capabilities: ["page_reachable", "screenshot"],
      });
      writeJson(join(stateRoot, "lifecycle/run-report.json"), runReport());
      writeJson(join(stateRoot, "state/evidence/adapters/progress-dashboard-ui-latest.json"), {
        status: "pass",
        artifact_path: join(stateRoot, "state/evidence/adapters/progress-dashboard-ui-latest.json"),
        ui_evidence: {
          page_reachable: true,
          critical_path_passed: true,
          required_state_present: true,
          screenshots: [".yolo/state/evidence/progress-dashboard-ui/active.html"],
        },
      });

      const report = buildAcceptanceReport({
        prd: prd(),
        projectRoot: root,
        stateRoot,
      });

      assert.equal(report.status, "pass");
      assert.equal(report.adapter_evidence.status, "pass");
      assert.ok(report.artifacts.some((artifact) => artifact.endsWith(".yolo/lifecycle/run-report.json")));
      assert.ok(report.artifacts.some((artifact) => artifact.endsWith(".yolo/state/evidence/adapters/progress-dashboard-ui-latest.json")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads default lifecycle review report and blocks unresolved review findings", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      writeJson(join(stateRoot, "lifecycle/run-report.json"), runReport());
      writeJson(join(stateRoot, "lifecycle/review-report.json"), {
        findings: [{
          finding_id: "REV-HIGH-001",
          severity: "HIGH",
          must_fix_before_ship: true,
        }],
      });

      const report = buildAcceptanceReport({
        prd: prd({ scope: { targets: [{ file: "src/services/inventory.ts" }] } }),
        projectRoot: root,
        stateRoot,
      });

      assert.equal(report.status, "blocked");
      assert.ok(report.issues.some((issue) => issue.code === "REVIEW_BLOCKER_OPEN"));
      assert.ok(report.artifacts.some((artifact) => artifact.endsWith(".yolo/lifecycle/review-report.json")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks review issues embedded in the run report", () => {
    const root = tempProject();
    try {
      const report = buildAcceptanceReport({
        prd: prd({ scope: { targets: [{ file: "src/services/inventory.ts" }] } }),
        runReport: {
          ...runReport(),
          review: {
            issues: [{ finding_id: "REV-CRIT-001", severity: "CRITICAL" }],
          },
        },
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
      });

      assert.equal(report.status, "blocked");
      assert.ok(report.issues.some((issue) => issue.finding_id === "REV-CRIT-001"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("YB-007 blocks run reports that claim success with failing evidence", () => {
    const root = tempProject();
    try {
      const report = buildAcceptanceReport({
        prd: prd({ scope: { targets: [{ file: "src/services/inventory.ts" }] } }),
        runReport: {
          status: "success",
          summary: {
            completed: 1,
            failed: 0,
            blocked: 0,
            evidence_failures: 1,
            run_success_rate: 100,
          },
          gates: { failed_count: 1, failed_tasks: ["FIX-GATE"] },
          review: { issue_count: 0, error_count: 0 },
          fixtures: { fail_count: 0 },
        },
        uiEvidence: {
          page_reachable: true,
          critical_path_passed: true,
          required_state_present: true,
          screenshots: ["state/evidence/ui.png"],
        },
        resolver: { selected: { acceptance_adapter: { id: "local-browser" } }, blockers: [] },
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
      });

      assert.equal(report.status, "blocked");
      const issue = report.issues.find((item) => item.code === "RUN_REPORT_NOT_CLEAN");
      assert.equal(issue.gate_failures, 1);
      assert.equal(issue.evidence_failures, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("YB-009 runYoloAcceptCli --json writes pure JSON to stdout", () => {
    const root = tempProject();
    let stdout = "";
    let stderr = "";
    try {
      const exitCode = runYoloAcceptCli(["--cwd", root, "--json"], {
        cwd: root,
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });

      assert.equal(exitCode, 2);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.schema, "yolo.lifecycle.guard.v1");
      assert.equal(parsed.status, "blocked");
      assert.equal(stderr, "");
      assert.equal(stdout.trim().startsWith("{"), true);
      assert.equal(stdout.includes("[yolo accept]"), false);
      assert.equal(stdout.includes("issues:"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
