import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildAcceptanceReport, runYoloAcceptCli } from "../src/runtime/acceptance/report.js";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";
import { initLifecycleState } from "../src/lifecycle/state.js";
import { inspectLifecycleGuard } from "../src/lifecycle/guard.js";
import { runYoloCli } from "../src/cli/yolo.js";
import { generateApprovalKeyPair, signApproval } from "../src/lib/security/approval-signing.js";
import { manualAcceptanceSignable } from "../src/lifecycle/manual-acceptance-keys.js";
import { registerGeneratedArtifactIntegrity } from "../src/runtime/evidence/artifact-integrity.js";

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "yolo-acceptance-report-"));
  writeText(join(root, ".yolo", "keys", "ledger.hmac"), "acceptance-report-test-ledger-key");
  writeText(join(root, "src/pages/inventory.tsx"), "export const Inventory = () => null;\n");
  return root;
}

function writeJson(file, payload) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  let projectRoot = dirname(file);
  while (dirname(projectRoot) !== projectRoot && !existsSync(join(projectRoot, ".yolo/keys/ledger.hmac"))) {
    projectRoot = dirname(projectRoot);
  }
  if (existsSync(join(projectRoot, ".yolo/keys/ledger.hmac"))) {
    registerGeneratedArtifactIntegrity([file], {
      rootDir: projectRoot,
      stateRoot: join(projectRoot, ".yolo"),
      source: "acceptance-internal-fixture",
    });
  }
}

function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

// Install a freshly-generated project-rooted manual-acceptance public key into
// a test state root and return the matching private key (PEM). CR1 made
// manual-acceptance verification real (ed25519 over the canonical payload), so
// tests that exercise the "legit signed evidence -> unblocked" path must sign
// against an installed key rather than using a placeholder signature.
function installManualAcceptanceKey(stateRoot) {
  const { privateKeyPem, publicKeyPem } = generateApprovalKeyPair();
  writeText(join(stateRoot, "keys", "manual-acceptance.pub"), publicKeyPem);
  return privateKeyPem;
}

function signManualEntry(privateKeyPem, entry) {
  const payload = manualAcceptanceSignable(entry);
  if (!payload) throw new Error("test entry missing canonical manual-acceptance fields");
  return signApproval(payload, privateKeyPem);
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

function runReport(prdPath = null) {
  return {
    status: "success",
    run_id: "run-test-001",
    prd: prdPath || null,
    summary: { planned: 1, completed: 1, failed: 0, blocked: 0, skipped: 0, evidence_failures: 0 },
  };
}

function lifecycleOptions(root) {
  return {
    projectRoot: root,
    stateRoot: join(root, ".yolo"),
    source: "unit",
    writeSessionMemory: false,
    skipSequenceCheck: true,
  };
}

function lifecycleWriteOptions(root) {
  return {
    projectRoot: root,
    stateRoot: join(root, ".yolo"),
    source: "unit",
    writeSessionMemory: false,
    skipSequenceCheck: true,
  };
}

function writeRunPass(root) {
  return writeLifecycleStageReport("run", {
    status: "success",
    summary: "run passed",
    evidence: [{ path: "state/reports/run/run-report.json" }],
  }, lifecycleWriteOptions(root));
}

function writeReviewPass(root, report = {}) {
  return writeLifecycleStageReport("review-fix", {
    status: "success",
    summary: "review passed",
    findings: [],
    evidence: [{ path: "state/review/review-report.json" }],
    ...report,
  }, lifecycleWriteOptions(root));
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

  test("blocks malformed default run report JSON instead of throwing", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, prd());
      writeText(join(stateRoot, "lifecycle", "run-report.json"), '{"schema":"bad"');

      const report = buildAcceptanceReport({
        prdPath,
        projectRoot: root,
        stateRoot,
      });

      assert.equal(report.status, "blocked");
      assert.ok(report.issues.some((issue) => issue.code === "RUN_REPORT_JSON_INVALID"));
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

  test("loads expected digests registered by earlier internal lifecycle stages", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdPath = join(root, "prd.json");
      const runReportPath = join(stateRoot, "state/reports/run-test-001/run-report.json");
      const fixturePrd = prd();
      writeJson(prdPath, fixturePrd);
      writeJson(runReportPath, runReport(prdPath));
      writeText(join(root, "src/pages/inventory.tsx"), "export const Inventory = () => null;\n");
      registerGeneratedArtifactIntegrity([prdPath, runReportPath], {
        rootDir: root,
        stateRoot,
        source: "acceptance-test-lifecycle",
      });

      const report = buildAcceptanceReport({
        prdPath,
        runReportPath,
        reviewReport: { findings: [] },
        uiEvidence: {
          page_reachable: true,
          critical_path_passed: true,
          required_state_present: true,
          screenshots: ["state/evidence/ui.png"],
        },
        resolver: { selected: { acceptance_adapter: { id: "local-browser" } }, blockers: [] },
        projectRoot: root,
        stateRoot,
      });

      assert.equal(report.status, "pass", JSON.stringify(report.issues, null, 2));
      assert.equal(report.issues.some((issue) => issue.code === "ACCEPTANCE_ARTIFACT_UNVERIFIED"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks review_fix acceptance when the source finding is still open in review report", () => {
    const root = tempProject();
    try {
      const report = buildAcceptanceReport({
        prd: prd({
          id: "FIX-REVIEW-001",
          title: "Fix service typing",
          type: "bugfix",
          task_kind: "review_fix",
          scope: { targets: [{ file: "src/services/auth.ts" }] },
          acceptance_criteria: ["Service typing is safe."],
          source_finding_ids: ["REV-TYPE-001"],
          post_conditions: [
            {
              id: "POST-FINDING-CLOSED",
              type: "code_not_contains",
              severity: "FAIL",
              params: { file: "src/services/auth.ts", text: "as any", source_finding_id: "REV-TYPE-001" },
            },
            {
              id: "POST-TYPECHECK",
              type: "no_new_type_errors",
              severity: "FAIL",
              params: { command: "npm run typecheck" },
            },
          ],
        }),
        runReport: runReport(),
        reviewReport: {
          status: "pass",
          findings: [{
            finding_id: "REV-TYPE-001",
            severity: "MEDIUM",
            file: "src/services/auth.ts",
            message: "Avoid as any",
          }],
        },
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
      });

      assert.equal(report.status, "blocked");
      assert.ok(report.issues.some((issue) =>
        issue.code === "REVIEW_FIX_FINDING_STILL_OPEN" &&
        issue.task_id === "FIX-REVIEW-001" &&
        issue.finding_id === "REV-TYPE-001"
      ));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("passes review_fix acceptance when source finding is absent from latest review report", () => {
    const root = tempProject();
    try {
      writeText(join(root, "src/services/auth.ts"), "export const authenticate = () => true;\n");
      const report = buildAcceptanceReport({
        prd: prd({
          id: "FIX-REVIEW-001",
          title: "Fix service typing",
          type: "bugfix",
          task_kind: "review_fix",
          scope: { targets: [{ file: "src/services/auth.ts" }] },
          acceptance_criteria: ["Service typing is safe."],
          source_finding_ids: ["REV-TYPE-001"],
          post_conditions: [{
            id: "POST-FINDING-CLOSED",
            type: "code_not_contains",
            severity: "FAIL",
            params: { file: "src/services/auth.ts", text: "as any", source_finding_id: "REV-TYPE-001" },
          }],
        }),
        runReport: runReport(),
        reviewReport: { status: "pass", findings: [] },
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
      });

      assert.equal(report.status, "pass", JSON.stringify(report.issues, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("negative: acceptance blocks success-shaped run reports whose artifact path is missing", () => {
    const root = tempProject();
    try {
      const report = buildAcceptanceReport({
        prd: prd({
          scope: { targets: [{ file: "src/services/inventory.ts" }] },
          post_conditions: [{
            id: "POST-SERVICE",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: "src/services/inventory.ts" },
          }],
        }),
        runReport: runReport(),
        runReportPath: join(root, ".yolo", "lifecycle", "missing-run-report.json"),
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
      });

      assert.equal(report.status, "blocked");
      assert.ok(report.issues.some((issue) => issue.code === "ACCEPTANCE_ARTIFACT_MISSING"));
      assert.equal(report.artifact_integrity.status, "fail");
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
        run_id: "run-test-001",
        prd: prdPath,
        summary: { planned: 1, completed: 1, failed: 0, blocked: 0, skipped: 0, evidence_failures: 0 },
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
        runReport: runReport(prdPath),
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
        runReport: runReport(prdPath),
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
        runReport: runReport(prdPath),
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

  test("runYoloAcceptCli exits 2 for approved acceptance warnings", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    let stdout = "";
    let stderr = "";
    try {
      const prdPath = join(root, "prd.json");
      const approvalPath = join(stateRoot, "lifecycle/acceptance-approval.json");
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
      writeJson(approvalPath, {
        approved: true,
        approver: "release-owner",
        approved_at: "2026-06-06T00:00:00.000Z",
        prd_path: prdPath,
        mode: "release",
        warning_count: 1,
      });
      writeLifecycleStageReport("run", {
        status: "success",
        run_id: "run-test-001",
        prd: prdPath,
        summary: { planned: 1, completed: 1, failed: 0, blocked: 0, skipped: 0, evidence_failures: 0 },
        evidence: [{ path: "state/run/run-report.json" }],
      }, lifecycleOptions(root));
      writeLifecycleStageReport("review-fix", {
        status: "success",
        summary: "review passed",
        findings: [],
        evidence: [{ path: "state/review/review-report.json" }],
      }, lifecycleOptions(root));

      const exitCode = runYoloAcceptCli(["--cwd", root, "prd.json", "--release", "--approval", approvalPath, "--json", "--no-write"], {
        cwd: root,
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const report = JSON.parse(stdout);

      assert.equal(exitCode, 2);
      assert.equal(stderr, "");
      assert.equal(report.status, "warning");
      assert.equal(report.code, "ACCEPTANCE_WARNING");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("root yolo accept and yolo release accept exit 2 for approved acceptance warnings", async () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdPath = join(root, "prd.json");
      const approvalPath = join(stateRoot, "lifecycle/acceptance-approval.json");
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
      writeJson(approvalPath, {
        approved: true,
        approver: "release-owner",
        approved_at: "2026-06-06T00:00:00.000Z",
        prd_path: prdPath,
        mode: "release",
        warning_count: 1,
      });
      writeLifecycleStageReport("run", {
        status: "success",
        run_id: "run-test-001",
        prd: prdPath,
        summary: { planned: 1, completed: 1, failed: 0, blocked: 0, skipped: 0, evidence_failures: 0 },
        evidence: [{ path: "state/run/run-report.json" }],
      }, lifecycleOptions(root));
      writeLifecycleStageReport("review-fix", {
        status: "success",
        summary: "review passed",
        findings: [],
        evidence: [{ path: "state/review/review-report.json" }],
      }, lifecycleOptions(root));

      for (const argv of [
        ["release", "accept", "prd.json", "--release", "--approval", approvalPath, "--cwd", root, "--json", "--no-write"],
      ]) {
        let stdout = "";
        let stderr = "";
        const exitCode = await runYoloCli(argv, {
          cwd: root,
          stdout: { write: (chunk) => { stdout += chunk; } },
          stderr: { write: (chunk) => { stderr += chunk; } },
        });
        const report = JSON.parse(stdout);

        assert.equal(exitCode, 2, argv.join(" "));
        assert.equal(stderr, "");
        assert.equal(report.status, "warning");
        assert.equal(report.code, "ACCEPTANCE_WARNING");
      }
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

  test("accepts recovered automation remediation as clean run history", () => {
    const root = tempProject();
    try {
      writeText(join(root, "src/services/inventory.ts"), "export const inventory = new Map();\n");
      const autoRemediation = {
        source: "state",
        task_id: "DEMAND-AUTOMATED-ACCEPTANCE-TEST-001",
        action: "REROUTE_REVIEW_FIX",
        status: "remediation_required",
        automation_can_continue: true,
        requires_human: false,
        unsafe_stop: false,
      };
      const report = buildAcceptanceReport({
        prd: prd({
          scope: { targets: [{ file: "src/services/inventory.ts" }] },
          post_conditions: [{
            id: "POST-SERVICE",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: "src/services/inventory.ts" },
          }],
        }),
        runReport: {
          run_id: "run-recovered-remediation",
          status: "success",
          summary: { planned: 1, completed: 1, failed: 0, blocked: 0, skipped: 0, evidence_failures: 0 },
          gates: { failed_count: 0, failures: [] },
          review: { issue_count: 0, error_count: 0 },
          remediation: {
            item_count: 1,
            automation_continuable_count: 1,
            human_required_count: 0,
            unsafe_stop_count: 0,
            items: [autoRemediation],
          },
          recent_events: [{ event: "gate_remediation", status: "remediation_required" }],
        },
        reviewReport: { status: "completed", findings: [] },
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

      assert.equal(report.status, "pass", JSON.stringify(report.issues, null, 2));
      assert.equal(report.issues.some((item) => item.code === "RUN_REPORT_NOT_CLEAN"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("still blocks run reports with unresolved human remediation", () => {
    const root = tempProject();
    try {
      const report = buildAcceptanceReport({
        prd: prd({ scope: { targets: [{ file: "src/services/inventory.ts" }] } }),
        runReport: {
          status: "success",
          summary: { completed: 1, failed: 0, blocked: 0, evidence_failures: 0 },
          remediation: {
            item_count: 1,
            automation_continuable_count: 0,
            human_required_count: 1,
            unsafe_stop_count: 0,
            items: [{
              task_id: "T-HUMAN",
              action: "ASK_HUMAN",
              status: "remediation_required",
              automation_can_continue: false,
              requires_human: true,
              unsafe_stop: false,
            }],
          },
        },
        reviewReport: { findings: [] },
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
      });

      assert.equal(report.status, "blocked");
      const issue = report.issues.find((item) => item.code === "RUN_REPORT_NOT_CLEAN");
      assert.ok(issue, JSON.stringify(report.issues, null, 2));
      assert.equal(issue.non_pass_statuses.some((entry) => entry.field === "remediation.items.0.status"), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks warning dry-run and nested non-pass run reports", () => {
    const root = tempProject();
    try {
      for (const runReportFixture of [
        { status: "warning", summary: { completed: 1, failed: 0, blocked: 0, evidence_failures: 0 } },
        { status: "dry_run", summary: { completed: 1, failed: 0, blocked: 0, evidence_failures: 0 } },
        { status: "success", dry_run: true, summary: { completed: 1, failed: 0, blocked: 0, evidence_failures: 0 } },
        { status: "success", summary: { completed: 1, failed: 0, blocked: 0, evidence_failures: 0 }, report: { status: "warning" } },
        { status: "success", summary: { completed: 1, failed: 0, blocked: 0, evidence_failures: 0 }, task_results: [{ task_id: "FIX-1", status: "failed" }] },
        { status: "success", summary: { completed: 1, failed: 0, blocked: 0, evidence_failures: 0 }, results: [{ report: { result: { run_report: { items: [{ status: "failed" }] } } } }] },
        { status: "success", summary: { completed: 1, failed: 0, blocked: 0, evidence_failures: 0 }, custom_groups: [{ metadata: { dryRun: true } }] },
        { status: "success", summary: { completed: 1, failed: 0, blocked: 0, evidence_failures: 0 }, fixtures: { status: "not_run", run_count: 0 } },
      ]) {
        const report = buildAcceptanceReport({
          prd: prd({ scope: { targets: [{ file: "src/services/inventory.ts" }] } }),
          runReport: runReportFixture,
          reviewReport: { findings: [] },
          projectRoot: root,
          stateRoot: join(root, ".yolo"),
        });

        assert.equal(report.status, "blocked");
        const issue = report.issues.find((item) => item.code === "RUN_REPORT_NOT_CLEAN");
        assert.ok(issue, JSON.stringify(report.issues, null, 2));
        assert.equal(issue.non_pass_statuses.length > 0 || issue.dry_run_flags.length > 0, true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks adapter evidence that is not pass or success", () => {
    const root = tempProject();
    try {
      for (const status of ["warning", "dry_run", "not_run", "ready", "fail", "failed", undefined]) {
        const report = buildAcceptanceReport({
          prd: prd({ scope: { targets: [{ file: "src/pages/inventory.tsx" }] } }),
          runReport: {
            status: "success",
            summary: { completed: 1, failed: 0, blocked: 0, evidence_failures: 0 },
          },
          reviewReport: { findings: [] },
          adapterEvidence: {
            status,
            adapter: { id: "local-browser" },
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

        assert.equal(report.status, "blocked", String(status));
        const expectedCode = ["failed", "fail"].includes(String(status)) ? "ADAPTER_EVIDENCE_BLOCKED" : "ADAPTER_EVIDENCE_NOT_CLEAN";
        assert.ok(report.issues.some((issue) => issue.code === expectedCode), JSON.stringify(report.issues, null, 2));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks run reports with broken evidence ledger integrity", () => {
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
            evidence_failures: 0,
          },
          ledger: {
            integrity: {
              status: "fail",
              error_count: 1,
            },
          },
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
      assert.equal(issue.ledger_integrity_errors, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks release acceptance when only degraded fixture evidence is present", () => {
    const root = tempProject();
    try {
      const report = buildAcceptanceReport({
        prd: prd({ scope: { targets: [{ file: "src/services/inventory.ts" }] } }),
        runReport: {
          status: "success",
          summary: { completed: 1, failed: 0, blocked: 0, evidence_failures: 0 },
          fixtures: { fail_count: 0, degraded_count: 1 },
        },
        reviewReport: { findings: [] },
        uiEvidence: {
          page_reachable: true,
          critical_path_passed: true,
          required_state_present: true,
          screenshots: ["state/evidence/ui.png"],
        },
        resolver: { selected: { acceptance_adapter: { id: "local-browser" } }, blockers: [] },
        mode: "release",
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
      });

      assert.equal(report.status, "blocked");
      assert.ok(report.issues.some((issue) => issue.code === "DEGRADED_FIXTURE_RELEASE_BLOCKED"));
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

  test("R3 propagation chain: manual acceptance criteria flow from PRD through acceptance report to ship blocker", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      // Build a PRD with acceptance_criteria post-condition lacking verify_command
      const prdWithManual = prd({
        post_conditions: [{
          id: "POST-ACCEPT-MANUAL",
          type: "acceptance_criteria",
          severity: "FAIL",
          params: { text: "Product owner confirms inventory UX matches brand guidelines." },
        }],
      });

      // Part 1: acceptance report collects manual_criteria from PRD
      const report = buildAcceptanceReport({
        prd: prdWithManual,
        runReport: {
          status: "success",
          summary: { completed: 1, failed: 0, blocked: 0, evidence_failures: 0 },
          fixtures: { fail_count: 0 },
        },
        reviewReport: { findings: [] },
        uiEvidence: {
          page_reachable: true,
          critical_path_passed: true,
          required_state_present: true,
          screenshots: ["state/evidence/ui.png"],
        },
        resolver: { selected: { acceptance_adapter: { id: "local-browser" } }, blockers: [] },
        projectRoot: root,
        stateRoot,
      });

      assert.equal(report.manual_criteria.length, 1);
      assert.equal(report.manual_criteria[0].task_id, "FEAT-ACCEPT-001");
      assert.equal(report.manual_criteria[0].condition_id, "POST-ACCEPT-MANUAL");
      assert.ok(report.manual_criteria[0].text.includes("Product owner"));

      // Part 2: write lifecycle and verify deliveryHardGateBlockers triggers
      initLifecycleState({ projectRoot: root });
      writeRunPass(root);
      writeReviewPass(root);
      writeLifecycleStageReport("acceptance", {
        status: "pass",
        summary: "acceptance passed but has manual criteria",
        evidence: [{ path: "state/acceptance/evidence.json" }],
        manual_criteria: report.manual_criteria,
      }, lifecycleWriteOptions(root));

      const guard = inspectLifecycleGuard({ command: "yolo-ship", projectRoot: root, stateRoot });
      assert.equal(guard.status, "blocked");
      assert.ok(
        guard.blockers.some((blocker) => blocker.code === "ACCEPTANCE_MANUAL_CRITERIA_UNRESOLVED"),
        `expected ACCEPTANCE_MANUAL_CRITERIA_UNRESOLVED in blockers: ${JSON.stringify(guard.blockers)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("S1 manual acceptance: all manual criteria covered by matching evidence → unblocked", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdWithManual = prd({
        post_conditions: [{
          id: "POST-ACCEPT-MANUAL",
          type: "acceptance_criteria",
          severity: "FAIL",
          params: { text: "Product owner confirms inventory UX matches brand guidelines." },
        }],
      });

      const report = buildAcceptanceReport({
        prd: prdWithManual,
        runReport: {
          status: "success",
          summary: { completed: 1, failed: 0, blocked: 0, evidence_failures: 0 },
          fixtures: { fail_count: 0 },
        },
        reviewReport: { findings: [] },
        uiEvidence: {
          page_reachable: true,
          critical_path_passed: true,
          required_state_present: true,
          screenshots: ["state/evidence/ui.png"],
        },
        resolver: { selected: { acceptance_adapter: { id: "local-browser" } }, blockers: [] },
        projectRoot: root,
        stateRoot,
      });

      assert.equal(report.manual_criteria.length, 1);

      initLifecycleState({ projectRoot: root });
      writeRunPass(root);
      writeReviewPass(root);
      // CR1: manual-acceptance evidence must carry a real ed25519 signature
      // verifiable against the project-rooted public key. Install a keypair and
      // sign the canonical payload so this "legit -> unblocked" path is real.
      const maPrivateKey = installManualAcceptanceKey(stateRoot);
      const acceptedAt = new Date().toISOString();
      const manualEntry = {
        type: "manual_acceptance",
        task_id: "FEAT-ACCEPT-001",
        condition_id: "POST-ACCEPT-MANUAL",
        accepted_by: "user",
        note: "UX matches brand guidelines per review",
        accepted_at: acceptedAt,
        status: "accepted",
      };
      const signature = signManualEntry(maPrivateKey, manualEntry);
      writeLifecycleStageReport("acceptance", {
        status: "pass",
        summary: "acceptance passed with manual criteria resolved",
        evidence: [
          { path: "state/acceptance/evidence.json" },
          { ...manualEntry, signature, digest: "sha256:test" },
        ],
        manual_criteria: report.manual_criteria,
      }, lifecycleWriteOptions(root));

      const guard = inspectLifecycleGuard({ command: "yolo-ship", projectRoot: root, stateRoot });
      assert.equal(
        guard.blockers.some((blocker) => blocker.code === "ACCEPTANCE_MANUAL_CRITERIA_UNRESOLVED"),
        false,
        `ACCEPTANCE_MANUAL_CRITERIA_UNRESOLVED should NOT be present when all criteria are covered`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("S1 manual acceptance: partial coverage → still blocked", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdWithTwoManual = prd({
        post_conditions: [
          {
            id: "POST-ACCEPT-MANUAL-1",
            type: "acceptance_criteria",
            severity: "FAIL",
            params: { text: "Product owner confirms inventory UX matches brand guidelines." },
          },
          {
            id: "POST-ACCEPT-MANUAL-2",
            type: "acceptance_criteria",
            severity: "FAIL",
            params: { text: "QA lead signs off on performance benchmarks." },
          },
        ],
      });

      const report = buildAcceptanceReport({
        prd: prdWithTwoManual,
        runReport: {
          status: "success",
          summary: { completed: 1, failed: 0, blocked: 0, evidence_failures: 0 },
          fixtures: { fail_count: 0 },
        },
        reviewReport: { findings: [] },
        uiEvidence: {
          page_reachable: true,
          critical_path_passed: true,
          required_state_present: true,
          screenshots: ["state/evidence/ui.png"],
        },
        resolver: { selected: { acceptance_adapter: { id: "local-browser" } }, blockers: [] },
        projectRoot: root,
        stateRoot,
      });

      assert.equal(report.manual_criteria.length, 2);

      initLifecycleState({ projectRoot: root });
      writeRunPass(root);
      writeReviewPass(root);
      // CR1: sign the one resolved criterion for real so the "partial coverage"
      // semantics stay exact (only POST-ACCEPT-MANUAL-2 is unresolved). With a
      // placeholder signature the entry would be rejected and BOTH would count
      // as unresolved, masking the partial-coverage intent.
      const maPrivateKey = installManualAcceptanceKey(stateRoot);
      const partialEntry = {
        type: "manual_acceptance",
        task_id: "FEAT-ACCEPT-001",
        condition_id: "POST-ACCEPT-MANUAL-1",
        accepted_by: "user",
        note: "UX matches brand guidelines",
        accepted_at: new Date().toISOString(),
        status: "accepted",
      };
      const signature = signManualEntry(maPrivateKey, partialEntry);
      writeLifecycleStageReport("acceptance", {
        status: "pass",
        summary: "acceptance passed but only one manual criterion resolved",
        evidence: [
          { path: "state/acceptance/evidence.json" },
          { ...partialEntry, signature, digest: "sha256:test" },
        ],
        manual_criteria: report.manual_criteria,
      }, lifecycleWriteOptions(root));

      const guard = inspectLifecycleGuard({ command: "yolo-ship", projectRoot: root, stateRoot });
      assert.equal(guard.status, "blocked");
      assert.ok(
        guard.blockers.some((blocker) => blocker.code === "ACCEPTANCE_MANUAL_CRITERIA_UNRESOLVED"),
        `expected ACCEPTANCE_MANUAL_CRITERIA_UNRESOLVED when only partially covered: ${JSON.stringify(guard.blockers)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("S1 manual acceptance: corrupted manual_criteria with null/non-object entries does not crash delivery gate", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      initLifecycleState({ projectRoot: root });
      writeRunPass(root);
      writeReviewPass(root);
      // acceptance-report.json is an external artifact; a partial flush, hand
      // edit, or git merge can produce valid JSON with a null/number/string
      // entry inside manual_criteria. The delivery gate must fail closed
      // (ACCEPTANCE_MANUAL_CRITERIA_UNRESOLVED) rather than crashing the
      // entire inspectLifecycleGuard call with TypeError.
      writeLifecycleStageReport("acceptance", {
        status: "pass",
        summary: "acceptance with corrupted manual_criteria entries",
        evidence: [{ path: "state/acceptance/evidence.json" }],
        manual_criteria: [
          null,
          42,
          "string",
          { task_id: "FEAT-ACCEPT-001", condition_id: "POST-ACCEPT-MANUAL" },
        ],
      }, lifecycleWriteOptions(root));

      const guard = inspectLifecycleGuard({ command: "yolo-ship", projectRoot: root, stateRoot });
      assert.equal(guard.status, "blocked");
      assert.ok(
        guard.blockers.some((blocker) => blocker.code === "ACCEPTANCE_MANUAL_CRITERIA_UNRESOLVED"),
        `expected fail-closed ACCEPTANCE_MANUAL_CRITERIA_UNRESOLVED for corrupted manual_criteria: ${JSON.stringify(guard.blockers)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("P8.H1: a minimal lifecycle run-stage wrapper is rejected as run evidence", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      // GPT#1 reproduce: bare stage wrapper with no run_id and a string summary.
      writeLifecycleStageReport("run", {
        status: "success",
        summary: "run passed",
      }, lifecycleOptions(root));

      const report = buildAcceptanceReport({
        prd: prd(),
        projectRoot: root,
        stateRoot,
      });

      assert.notEqual(report.status, "pass");
      assert.ok(
        report.issues.some((issue) => issue.code === "RUN_REPORT_INSUFFICIENT"),
        `expected RUN_REPORT_INSUFFICIENT for minimal wrapper: ${JSON.stringify(report.issues.map((issue) => issue.code))}`,
      );
      const insufficient = report.issues.find((issue) => issue.code === "RUN_REPORT_INSUFFICIENT");
      assert.equal(insufficient.invariant_code, "RUNTIME_INVARIANT_VIOLATED:acceptance_run_report_wrapper");
      assert.ok(insufficient.reasons.includes("missing run_id"));
      assert.ok(insufficient.reasons.some((reason) => reason.startsWith("missing structured summary")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("P8.H1: default acceptance prefers latest state run report over lifecycle stage wrapper", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      writeText(join(root, "src/services/inventory.ts"), "export const inventory = new Map();\n");
      const servicePrd = prd({
        title: "Build inventory service",
        scope: { targets: [{ file: "src/services/inventory.ts" }] },
        acceptance_criteria: ["Inventory service stores item counts."],
        post_conditions: [{
          id: "POST-SERVICE",
          type: "target_file_modified",
          severity: "FAIL",
          params: { file: "src/services/inventory.ts" },
        }],
      });
      const prdPath = join(root, "prd.json");
      const stateRunReportPath = join(stateRoot, "state/reports/run-test-001/run-report.json");
      writeJson(prdPath, servicePrd);
      writeLifecycleStageReport("run", {
        status: "success",
        summary: "run passed",
      }, lifecycleOptions(root));
      writeJson(stateRunReportPath, runReport(prdPath));

      const report = buildAcceptanceReport({
        prdPath,
        projectRoot: root,
        reviewReport: { findings: [] },
        stateRoot,
      });

      assert.equal(report.status, "pass");
      assert.equal(
        report.issues.some((issue) => issue.code === "RUN_REPORT_INSUFFICIENT"),
        false,
      );
      assert.ok(report.artifacts.some((artifact) => artifact.endsWith(".yolo/state/reports/run-test-001/run-report.json")));
      assert.equal(report.artifacts.some((artifact) => artifact.endsWith(".yolo/lifecycle/run-report.json")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("P8.H1: a real run report with run_id, structured summary and PRD lineage passes", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, prd());
      writeJson(join(stateRoot, "lifecycle/run-report.json"), runReport(prdPath));
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
        prdPath,
        prd: prd(),
        reviewReport: { findings: [] },
        uiEvidence: {
          page_reachable: true,
          critical_path_passed: true,
          required_state_present: true,
          screenshots: ["state/evidence/ui.png"],
        },
        projectRoot: root,
        stateRoot,
      });

      assert.equal(report.status, "pass");
      assert.equal(
        report.issues.some((issue) => issue.code === "RUN_REPORT_INSUFFICIENT"),
        false,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("P8.H2: acceptance_criteria with params.verify_command is machine-verifiable, not manual", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdWithMachineAcceptance = prd({
        post_conditions: [
          {
            id: "POST-MACHINE-CMD",
            type: "acceptance_criteria",
            severity: "FAIL",
            params: {
              text: "Inventory service returns 200 from health endpoint.",
              verify_command: "curl -sf http://localhost:3000/health",
            },
          },
          {
            id: "POST-MANUAL-ONLY",
            type: "acceptance_criteria",
            severity: "WARN",
            params: { text: "Product owner signs off on UX." },
          },
        ],
      });

      const report = buildAcceptanceReport({
        prd: prdWithMachineAcceptance,
        runReport: runReport(),
        reviewReport: { findings: [] },
        projectRoot: root,
        stateRoot,
      });

      // The machine-verifiable criterion must NOT be classified as manual.
      assert.equal(
        report.manual_criteria.some((c) => c.condition_id === "POST-MACHINE-CMD"),
        false,
        `expected POST-MACHINE-CMD to be machine-verifiable, got manual_criteria: ${JSON.stringify(report.manual_criteria)}`,
      );
      // The genuinely manual criterion stays manual.
      assert.equal(report.manual_criteria.length, 1);
      assert.equal(report.manual_criteria[0].condition_id, "POST-MANUAL-ONLY");

      // Top-level verify_command (legacy shape) is also recognized as machine.
      const legacyMachine = prd({
        post_conditions: [
          {
            id: "POST-LEGACY-CMD",
            type: "acceptance_criteria",
            severity: "FAIL",
            verify_command: "npm run healthcheck",
            params: { text: "Healthcheck script exits 0." },
          },
        ],
      });
      const legacyReport = buildAcceptanceReport({
        prd: legacyMachine,
        runReport: runReport(),
        reviewReport: { findings: [] },
        projectRoot: root,
        stateRoot,
      });
      assert.equal(
        legacyReport.manual_criteria.some((c) => c.condition_id === "POST-LEGACY-CMD"),
        false,
        `expected POST-LEGACY-CMD (top-level verify_command) to be machine-verifiable`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
