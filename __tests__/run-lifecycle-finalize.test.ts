import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRunReturnResult,
  buildRunFinalVerdict,
  cleanDirByPattern,
  cleanupRunArtifacts,
  cleanupWorktreeRoot,
  finalizeRun,
} from "../src/runtime/run-lifecycle/finalize.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "yolo-run-finalize-"));
}

function touch(filePath, content = "") {
  writeFileSync(filePath, content, "utf8");
}

const RUN_FINALIZE_CHILD_TIMEOUT_MS = 20_000;

function runNodeScript(source: string, timeoutMs = RUN_FINALIZE_CHILD_TIMEOUT_MS): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      source,
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveResult({ code: null, signal: "SIGKILL", stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal, stdout, stderr, timedOut: false });
    });
  });
}

function finalizeScript({ exitOnComplete, startEmbeddedServer = false, keepAlive = false }: {
  exitOnComplete: boolean;
  startEmbeddedServer?: boolean;
  keepAlive?: boolean;
}) {
  return `
    import { mkdtempSync, mkdirSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { finalizeRun } from "./src/runtime/run-lifecycle/finalize.js";
    import { startEmbeddedProgressServer } from "./src/runtime/progress/embedded-server.js";

    const root = mkdtempSync(join(tmpdir(), "yolo-runner-exit-"));
    const stateDir = join(root, "state");
    const runtimeDir = join(stateDir, "runtime");
    mkdirSync(runtimeDir, { recursive: true });
    ${keepAlive ? "setInterval(() => {}, 1000);" : ""}
    const progressServerProc = ${startEmbeddedServer ? "startEmbeddedProgressServer(0, { log: () => {}, error: (message) => process.stderr.write(String(message) + '\\n') })" : "null"};
    await finalizeRun({
      runId: "run-exit",
      prdPath: join(root, "data", "prd.json"),
      taskResults: { completed: ["A"], failed: [], skipped: [], blocked: [], contractReview: [] },
      progressTotal: 1,
      startTimeMs: Date.now(),
      projectRoot: root,
      stateDir,
      runtimeDir,
      yoloRoot: root,
      exitOnComplete: ${exitOnComplete ? "true" : "false"},
      progressServerProc,
      writeRunReport: () => ({
        json_path: join(stateDir, "report.json"),
        markdown_path: join(stateDir, "report.md"),
        final_answer_json_path: join(stateDir, "final-answer.json"),
        final_answer_markdown_path: join(stateDir, "final-answer.md"),
        report: { status: "success", summary: { task_success_rate: 100, run_success_rate: 100 } },
        final_answer: { status: "success", outcome: "success", checks: [], blockers: [] },
      }),
      logRun: () => {},
      logProgress: () => {},
      writeStateSnapshot: () => {},
      archiveCurrentRun: () => {},
      normalizeRepoPath: (value) => value,
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      consoleLog: () => {},
    });
  `;
}

describe("run lifecycle finalization helpers", () => {
  test("cleanDirByPattern keeps newest files and honors excludes", () => {
    const dir = tempDir();
    try {
      touch(join(dir, "gate-a.json"));
      touch(join(dir, "gate-b.json"));
      touch(join(dir, "gate-c.json"));
      const removed = cleanDirByPattern({
        dir,
        pattern: /^gate-.*\.json$/,
        keep: 1,
        exclude: new Set([join(dir, "gate-b.json")]),
      });

      assert.deepEqual(removed, ["gate-a.json"]);
      assert.equal(existsSync(join(dir, "gate-a.json")), false);
      assert.equal(existsSync(join(dir, "gate-b.json")), true);
      assert.equal(existsSync(join(dir, "gate-c.json")), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleanupRunArtifacts removes transient files and keeps runtime persistent files", () => {
    const root = tempDir();
    try {
      const stateDir = join(root, "state");
      const runtimeDir = join(stateDir, "runtime");
      const dataDir = join(root, "data");
      mkdirSync(runtimeDir, { recursive: true });
      mkdirSync(dataDir, { recursive: true });
      touch(join(root, "task-results.bak.old"));
      touch(join(dataDir, "task-results.bak.old"));
      touch(join(runtimeDir, "gate-a.json"));
      touch(join(runtimeDir, "tmp.txt"));
      touch(join(runtimeDir, "learn-stats.json"), "{}");
      touch(join(stateDir, "expanded-tasks.json"));
      touch(join(stateDir, "runner.pid"));
      touch(join(stateDir, "yolo-output.log"));
      touch(join(stateDir, "review-log.jsonl"));
      touch(join(root, "noise-cleanup.js"));
      touch(join(dataDir, "retry-round-old.json"));
      const currentPrd = join(dataDir, "retry-round-current.json");
      touch(currentPrd);

      const logs = [];
      const result = cleanupRunArtifacts({
        yoloRoot: root,
        stateDir,
        runtimeDir,
        prdPath: currentPrd,
        normalizeRepoPath: (value) => value,
        spawnSync: () => ({ status: 0, stdout: "noise ok\n", stderr: "" }),
        consoleLog: (...entry) => logs.push(entry),
      });

      assert.equal(result.cleanedCount, 8);
      assert.equal(existsSync(join(root, "task-results.bak.old")), false);
      assert.equal(existsSync(join(dataDir, "task-results.bak.old")), false);
      assert.equal(existsSync(join(runtimeDir, "tmp.txt")), false);
      assert.equal(existsSync(join(runtimeDir, "learn-stats.json")), true);
      assert.equal(existsSync(join(dataDir, "retry-round-old.json")), false);
      assert.equal(existsSync(currentPrd), true);
      assert.match(logs.at(-1)[0], /noise-cleanup/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cleanupRunArtifacts removes success-only runtime noise and worktree roots", () => {
    const root = tempDir();
    try {
      const projectRoot = join(root, "project");
      const stateDir = join(projectRoot, ".yolo", "state");
      const runtimeDir = join(stateDir, "runtime");
      const worktreeRoot = join(root, ".yolo-worktrees");
      mkdirSync(join(runtimeDir, "task-logs"), { recursive: true });
      mkdirSync(join(stateDir, "progress-snapshots"), { recursive: true });
      mkdirSync(join(worktreeRoot, "FEAT-1"), { recursive: true });
      touch(join(runtimeDir, "codex-output-1.txt"));
      touch(join(runtimeDir, "context-pack-FEAT-1-1.json"));
      touch(join(runtimeDir, "gate-FEAT-1-1.json"));
      touch(join(runtimeDir, "task-results.jsonl"));
      touch(join(runtimeDir, "task-logs", "FEAT-1.jsonl"));
      touch(join(runtimeDir, "tsc-baseline.json"));
      touch(join(stateDir, "yolo-output.log"));
      touch(join(stateDir, "runner.pid"));
      touch(join(stateDir, "progress-snapshots", "latest.json"));
      const prdPath = join(projectRoot, ".yolo", "data", "prd.json");
      mkdirSync(join(projectRoot, ".yolo", "data"), { recursive: true });
      touch(prdPath);

      const result = cleanupRunArtifacts({
        yoloRoot: join(projectRoot, ".yolo"),
        projectRoot,
        stateDir,
        runtimeDir,
        prdPath,
        completionStatus: "success",
        consoleLog: () => {},
        now: new Date("2026-05-24T00:00:00.000Z"),
      });

      const archiveDir = join(stateDir, "archive", "raw-runtime", "20260524T000000Z");
      assert.equal(result.rawEvidenceArchive.archived, true);
      assert.equal(existsSync(join(archiveDir, "runtime", "codex-output-1.txt")), true);
      assert.equal(existsSync(join(archiveDir, "runtime", "task-logs", "FEAT-1.jsonl")), true);
      assert.equal(existsSync(join(archiveDir, "runtime", "gate-FEAT-1-1.json")), true);
      assert.equal(existsSync(join(archiveDir, "state", "yolo-output.log")), true);
      assert.equal(existsSync(join(runtimeDir, "codex-output-1.txt")), false);
      assert.equal(existsSync(join(runtimeDir, "task-results.jsonl")), false);
      assert.equal(existsSync(join(runtimeDir, "task-logs")), false);
      assert.equal(existsSync(join(runtimeDir, "tsc-baseline.json")), false);
      assert.equal(existsSync(join(stateDir, "yolo-output.log")), false);
      assert.equal(existsSync(join(stateDir, "runner.pid")), false);
      assert.equal(existsSync(join(stateDir, "progress-snapshots", "latest.json")), true);
      assert.equal(existsSync(worktreeRoot), false);
      assert.equal(result.worktreeCleanup.skipped, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cleanupWorktreeRoot refuses unsafe paths", () => {
    assert.deepEqual(cleanupWorktreeRoot({ worktreeRoot: "/tmp/not-yolo-worktrees" }), {
      skipped: true,
      reason: "unsafe_worktree_root",
      removed: [],
    });
  });

  test("cleanupRunArtifacts keeps state cleanup separate from package tools root", () => {
    const root = tempDir();
    const toolsRoot = tempDir();
    try {
      const stateDir = join(root, "state");
      const runtimeDir = join(stateDir, "runtime");
      const dataDir = join(root, "data");
      mkdirSync(runtimeDir, { recursive: true });
      mkdirSync(dataDir, { recursive: true });
      touch(join(toolsRoot, "noise-cleanup.js"));
      touch(join(stateDir, "yolo-output.log"));
      touch(join(stateDir, "review-log.jsonl"));
      touch(join(dataDir, "retry-round-old.json"));
      const currentPrd = join(dataDir, "prd.json");
      touch(currentPrd);

      const spawnCalls = [];
      cleanupRunArtifacts({
        yoloRoot: root,
        toolsRoot,
        stateDir,
        runtimeDir,
        prdPath: currentPrd,
        normalizeRepoPath: (value) => value,
        spawnSync: (...args) => {
          spawnCalls.push(args);
          return { status: 0, stdout: "", stderr: "" };
        },
        consoleLog: () => {},
      });

      assert.equal(existsSync(join(stateDir, "yolo-output.log")), false);
      assert.equal(existsSync(join(stateDir, "review-log.jsonl")), false);
      assert.equal(existsSync(join(dataDir, "retry-round-old.json")), false);
      assert.equal(spawnCalls[0][1][0], join(toolsRoot, "noise-cleanup.js"));
      assert.equal(spawnCalls[0][2].cwd, toolsRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(toolsRoot, { recursive: true, force: true });
    }
  });

  test("buildRunReturnResult maps failed task count to status and report paths", () => {
    const result = buildRunReturnResult({
      runId: "run-1",
      prdPath: "/repo/prd.json",
      taskResults: { completed: ["A"], failed: ["B"], skipped: ["C"], blocked: ["D"], contractReview: [] },
      runReportResult: {
        json_path: "/repo/state/report.json",
        markdown_path: "/repo/state/report.md",
        final_answer_json_path: "/repo/state/final-answer.json",
        final_answer_markdown_path: "/repo/state/final-answer.md",
      },
      normalizeRepoPath: (value) => value.replace("/repo/", ""),
    });

    assert.deepEqual(result, {
      status: "error",
      summary: "runner failed closed: FAILED_TASKS=1, BLOCKED_TASKS=1",
      exit_code: 1,
      run_id: "run-1",
      prd: "/repo/prd.json",
      completed: ["A"],
      failed: ["B"],
      skipped: ["C"],
      blocked: ["D"],
      contract_review: [],
      remediation: [],
      immediate_remediation_queue: [],
      final_verdict: {
        status: "error",
        exit_code: 1,
        summary: "runner failed closed: FAILED_TASKS=1, BLOCKED_TASKS=1",
        issues: [
          { code: "FAILED_TASKS", count: 1, detail: "runner has failed tasks" },
          { code: "BLOCKED_TASKS", count: 1, detail: "runner has blocked tasks" },
        ],
      },
      report_file: "state/report.json",
      report_markdown: "state/report.md",
      final_answer_file: "state/final-answer.json",
      final_answer_markdown: "state/final-answer.md",
    });
  });

  test("buildRunReturnResult fails closed for blocked-only runs", () => {
    const result = buildRunReturnResult({
      runId: "run-blocked",
      prdPath: "/repo/prd.json",
      taskResults: { completed: ["A"], failed: [], skipped: [], blocked: ["B"], contractReview: [] },
      runReportResult: {
        json_path: "/repo/state/report.json",
        markdown_path: "/repo/state/report.md",
        report: { status: "success", summary: { failed: 0, blocked: 0, evidence_failures: 0 } },
      },
      normalizeRepoPath: (value) => value.replace("/repo/", ""),
    });

    assert.equal(result.status, "error");
    assert.equal(result.exit_code, 1);
    assert.deepEqual(result.final_verdict.issues.map((issue) => issue.code), ["BLOCKED_TASKS"]);
  });

  test("buildRunReturnResult ignores stale blocked buckets for completed tasks", () => {
    const result = buildRunReturnResult({
      runId: "run-recovered",
      prdPath: "/repo/prd.json",
      taskResults: {
        completed: ["A", "B"],
        failed: ["A"],
        skipped: ["A"],
        blocked: ["B"],
        contractReview: ["B"],
      },
      runReportResult: {
        json_path: "/repo/state/report.json",
        markdown_path: "/repo/state/report.md",
        final_answer_json_path: "/repo/state/final-answer.json",
        final_answer_markdown_path: "/repo/state/final-answer.md",
        report: {
          status: "success",
          summary: { failed: 0, blocked: 0, evidence_failures: 0 },
          review: {
            issue_count: 0,
            error_count: 0,
            historical_issues: [{ finding_id: "OLD", status: "found" }],
          },
        },
        final_answer: { status: "success", outcome: "success", checks: [{ name: "tasks", status: "pass" }], blockers: [] },
      },
      normalizeRepoPath: (value) => value.replace("/repo/", ""),
    });

    assert.equal(result.status, "success");
    assert.equal(result.exit_code, 0);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.blocked, []);
    assert.deepEqual(result.contract_review, []);
  });

  test("buildRunReturnResult fails closed for blocked review outcomes even without task arrays", () => {
    const result = buildRunReturnResult({
      runId: "run-review-outcome",
      prdPath: "/repo/prd.json",
      taskResults: {
        completed: ["A"],
        failed: [],
        skipped: [],
        blocked: [],
        contractReview: [],
        review_outcome: {
          status: "blocked",
          reason: "review_findings_persisted",
        },
      },
      runReportResult: {
        json_path: "/repo/state/report.json",
        markdown_path: "/repo/state/report.md",
        report: { status: "success", summary: { failed: 0, blocked: 0, evidence_failures: 0 } },
      },
      normalizeRepoPath: (value) => value.replace("/repo/", ""),
    });

    assert.equal(result.status, "error");
    assert.equal(result.exit_code, 1);
    assert.ok(result.final_verdict.issues.some((issue) => issue.code === "REVIEW_OUTCOME_BLOCKED"));
  });

  test("buildRunReturnResult fails closed for contract-review-only runs", () => {
    const result = buildRunReturnResult({
      runId: "run-contract",
      prdPath: "/repo/prd.json",
      taskResults: { completed: ["A"], failed: [], skipped: [], blocked: [], contractReview: ["C"] },
      runReportResult: {
        json_path: "/repo/state/report.json",
        markdown_path: "/repo/state/report.md",
        report: { status: "success", summary: { failed: 0, blocked: 0, evidence_failures: 0 } },
      },
      normalizeRepoPath: (value) => value.replace("/repo/", ""),
    });

    assert.equal(result.status, "error");
    assert.equal(result.exit_code, 1);
    assert.deepEqual(result.contract_review, ["C"]);
    assert.deepEqual(result.final_verdict.issues.map((issue) => issue.code), ["CONTRACT_REVIEW_TASKS"]);
  });

  test("buildRunReturnResult fails closed when the run report has errors", () => {
    const result = buildRunReturnResult({
      runId: "run-report-error",
      prdPath: "/repo/prd.json",
      taskResults: { completed: ["A"], failed: [], skipped: [], blocked: [], contractReview: [] },
      runReportResult: {
        json_path: "/repo/state/report.json",
        markdown_path: "/repo/state/report.md",
        report: {
          status: "error",
          summary: { failed: 0, blocked: 0, evidence_failures: 1 },
          review: { error_count: 1 },
        },
      },
      normalizeRepoPath: (value) => value.replace("/repo/", ""),
    });

    assert.equal(result.status, "error");
    assert.equal(result.exit_code, 1);
    assert.ok(result.final_verdict.issues.some((issue) => issue.code === "RUN_REPORT_STATUS_ERROR"));
    assert.ok(result.final_verdict.issues.some((issue) => issue.code === "EVIDENCE_FAILURES"));
    assert.ok(result.final_verdict.issues.some((issue) => issue.code === "REVIEW_ERRORS"));
  });

  test("buildRunFinalVerdict fails closed for warning dry-run not-run and ready statuses", () => {
    for (const status of ["warning", "dry_run", "not_run", "indeterminate", "draft", "ready"]) {
      const resultIssue = buildRunFinalVerdict({
        taskResults: { status, completed: ["A"], failed: [], skipped: [], blocked: [], contractReview: [] },
        runReportResult: {
          report: { status: "success", summary: { failed: 0, blocked: 0, evidence_failures: 0 } },
          final_answer: { status: "success", outcome: "success", checks: [{ name: "tasks", status: "pass" }], blockers: [] },
        },
      });
      assert.equal(resultIssue.status, "error", status);
      assert.ok(resultIssue.issues.some((issue) => issue.code === "RUNNER_RESULT_STATUS_ERROR"), status);

      const reportIssue = buildRunFinalVerdict({
        taskResults: { completed: ["A"], failed: [], skipped: [], blocked: [], contractReview: [] },
        runReportResult: {
          report: { status, summary: { failed: 0, blocked: 0, evidence_failures: 0 } },
          final_answer: { status: "success", outcome: "success", checks: [{ name: "tasks", status: "pass" }], blockers: [] },
        },
      });
      assert.equal(reportIssue.status, "error", status);
      assert.ok(reportIssue.issues.some((issue) => issue.code === "RUN_REPORT_STATUS_ERROR"), status);

      const finalAnswerIssue = buildRunFinalVerdict({
        taskResults: { completed: ["A"], failed: [], skipped: [], blocked: [], contractReview: [] },
        runReportResult: {
          report: { status: "success", summary: { failed: 0, blocked: 0, evidence_failures: 0 } },
          final_answer: { status: "success", outcome: "success", checks: [{ name: "tasks", status }], blockers: [] },
        },
      });
      assert.equal(finalAnswerIssue.status, "error", status);
      assert.ok(finalAnswerIssue.issues.some((issue) => issue.code === "FINAL_ANSWER_CHECK_FAILURES"), status);
    }
  });

  test("buildRunFinalVerdict treats completed and done final outcomes as non-clean", () => {
    for (const outcome of ["completed", "done"]) {
      const result = buildRunFinalVerdict({
        taskResults: { status: "success", completed: ["A"], failed: [], skipped: [], blocked: [], contractReview: [] },
        runReportResult: {
          report: { status: "success", summary: { failed: 0, blocked: 0, evidence_failures: 0 } },
          final_answer: { status: "success", outcome, checks: [{ name: "tasks", status: "pass" }], blockers: [] },
        },
      });

      assert.equal(result.status, "error", outcome);
      assert.ok(result.issues.some((issue) => issue.code === "FINAL_ANSWER_NEEDS_ATTENTION"), outcome);
    }
  });

  test("buildRunFinalVerdict scans nested run report statuses and dry-run flags", () => {
    const nestedStatus = buildRunFinalVerdict({
      taskResults: { status: "success", completed: ["A"], failed: [], skipped: [], blocked: [], contractReview: [] },
      runReportResult: {
        report: {
          status: "success",
          summary: { failed: 0, blocked: 0, evidence_failures: 0 },
          task_results: [{ task_id: "A", status: "failed" }],
        },
        final_answer: { status: "success", outcome: "success", checks: [{ name: "tasks", status: "pass" }], blockers: [] },
      },
    });
    assert.equal(nestedStatus.status, "error");
    assert.ok(nestedStatus.issues.some((issue) => issue.code === "RUN_REPORT_STATUS_ERROR"));

    const nestedDryRun = buildRunFinalVerdict({
      taskResults: { status: "success", completed: ["A"], failed: [], skipped: [], blocked: [], contractReview: [] },
      runReportResult: {
        report: {
          status: "success",
          summary: { failed: 0, blocked: 0, evidence_failures: 0 },
          result: { runReport: { checks: [{ name: "deep", status: "pass", dryRun: true }] } },
        },
        final_answer: { status: "success", outcome: "success", checks: [{ name: "tasks", status: "pass" }], blockers: [] },
      },
    });
    assert.equal(nestedDryRun.status, "error");
    assert.ok(nestedDryRun.issues.some((issue) => issue.code === "RUN_REPORT_DRY_RUN"));
  });

  test("buildRunFinalVerdict treats recovered auto remediation as clean history", () => {
    const autoRemediation = {
      task_id: "T-acceptance",
      action: "REROUTE_REVIEW_FIX",
      status: "remediation_required",
      automation_can_continue: true,
      requires_human: false,
      unsafe_stop: false,
    };
    const result = buildRunFinalVerdict({
      taskResults: {
        status: "success",
        completed: ["T-acceptance"],
        failed: [],
        skipped: [],
        blocked: [],
        contractReview: [],
        remediation: [autoRemediation],
        immediateRemediationQueue: [],
      },
      runReportResult: {
        report: {
          status: "success",
          summary: { failed: 0, blocked: 0, evidence_failures: 0 },
          gates: { failed_count: 0 },
          review: { issue_count: 0, error_count: 0 },
          fixtures: { fail_count: 0 },
          spec_governance: { blocked_count: 0 },
          remediation: {
            item_count: 1,
            automation_continuable_count: 1,
            human_required_count: 0,
            unsafe_stop_count: 0,
            items: [autoRemediation],
          },
          recent_events: [{ event: "gate_remediation", status: "remediation_required" }],
        },
        final_answer: {
          status: "success",
          outcome: "success",
          checks: [
            { name: "tasks", status: "pass" },
            { name: "remediation", status: "pass" },
          ],
          blockers: [],
        },
      },
    });

    assert.equal(result.status, "success");
    assert.deepEqual(result.issues, []);
  });

  test("buildRunFinalVerdict still blocks human remediation", () => {
    const result = buildRunFinalVerdict({
      taskResults: {
        status: "success",
        completed: ["T-acceptance"],
        failed: [],
        skipped: [],
        blocked: [],
        contractReview: [],
        remediation: [{
          task_id: "T-acceptance",
          action: "ASK_HUMAN",
          status: "remediation_required",
          automation_can_continue: false,
          requires_human: true,
          unsafe_stop: false,
        }],
      },
      runReportResult: {
        report: { status: "success", summary: { failed: 0, blocked: 0, evidence_failures: 0 } },
        final_answer: { status: "success", outcome: "success", checks: [{ name: "tasks", status: "pass" }], blockers: [] },
      },
    });

    assert.equal(result.status, "error");
    assert.ok(result.issues.some((issue) => issue.code === "HUMAN_REMEDIATION_REQUIRED"));
  });

  test("buildRunReturnResult fails closed when successful runs lack report artifacts", () => {
    const result = buildRunReturnResult({
      runId: "run-missing-report",
      prdPath: "/repo/prd.json",
      taskResults: { completed: ["A"], failed: [], skipped: [], blocked: [], contractReview: [] },
      runReportResult: {},
      normalizeRepoPath: (value) => value,
    });

    assert.equal(result.status, "error");
    assert.equal(result.exit_code, 1);
    assert.deepEqual(result.final_verdict.issues.map((issue) => issue.code), [
      "RUN_REPORT_MISSING",
      "FINAL_ANSWER_MISSING",
      "RUN_REPORT_ARTIFACT_MISSING",
      "RUN_REPORT_MARKDOWN_MISSING",
      "FINAL_ANSWER_ARTIFACT_MISSING",
      "FINAL_ANSWER_MARKDOWN_MISSING",
    ]);
  });

  test("finalizeRun writes report, archives current run, kills progress server, and returns result", async () => {
    const root = tempDir();
    try {
      const stateDir = join(root, "state");
      const runtimeDir = join(stateDir, "runtime");
      mkdirSync(runtimeDir, { recursive: true });
      touch(join(stateDir, "current-run.json"), JSON.stringify({ run_id: "run-1", started_at: "start" }));
      const calls = { logRun: [], snapshots: [], archives: [], killed: [] };
      const result = await finalizeRun({
        runId: "run-1",
        prdPath: join(root, "data", "prd.json"),
        taskResults: { completed: ["A"], failed: [], skipped: [], blocked: [] },
        progressTotal: 1,
        startTimeMs: Date.now(),
        stateDir,
        runtimeDir,
        yoloRoot: root,
        exitOnComplete: false,
        writeRunReport: () => ({
          json_path: join(stateDir, "report.json"),
          markdown_path: join(stateDir, "report.md"),
          final_answer_json_path: join(stateDir, "final-answer.json"),
          final_answer_markdown_path: join(stateDir, "final-answer.md"),
          report: { status: "success", summary: { task_success_rate: 100, run_success_rate: 100 } },
          final_answer: { status: "success", outcome: "success", checks: [], blockers: [] },
        }),
        logRun: (...entry) => calls.logRun.push(entry),
        logProgress: (...entry) => calls.archives.push(entry),
        writeStateSnapshot: (...entry) => calls.snapshots.push(entry),
        archiveCurrentRun: (...entry) => calls.archives.push(entry),
        normalizeRepoPath: (value) => value.replace(`${root}/`, ""),
        progressServerProc: { pid: 123 },
        processKill: (...entry) => calls.killed.push(entry),
        spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
        consoleLog: () => {},
        now: () => new Date("2026-05-24T00:00:00.000Z"),
      });

      assert.equal(result.status, "success");
      assert.equal(result.exit_code, 0);
      assert.equal(result.report_file, "state/report.json");
      assert.deepEqual(calls.logRun[0][0], "run_end");
      assert.deepEqual(calls.snapshots[0], ["run_end", join(root, "data", "prd.json")]);
      assert.deepEqual(calls.killed[0], [123, "SIGTERM"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("finalizeRun prefers closing an embedded progress server handle before returning", async () => {
    const root = tempDir();
    try {
      const stateDir = join(root, "state");
      const runtimeDir = join(stateDir, "runtime");
      mkdirSync(runtimeDir, { recursive: true });
      const calls = [];
      const result = await finalizeRun({
        runId: "run-close",
        prdPath: join(root, "data", "prd.json"),
        taskResults: { completed: ["A"], failed: [], skipped: [], blocked: [] },
        progressTotal: 1,
        startTimeMs: Date.now(),
        stateDir,
        runtimeDir,
        yoloRoot: root,
        exitOnComplete: false,
        writeRunReport: () => ({
          json_path: join(stateDir, "report.json"),
          markdown_path: join(stateDir, "report.md"),
          final_answer_json_path: join(stateDir, "final-answer.json"),
          final_answer_markdown_path: join(stateDir, "final-answer.md"),
          report: { status: "success", summary: { task_success_rate: 100, run_success_rate: 100 } },
          final_answer: { status: "success", outcome: "success", checks: [], blockers: [] },
        }),
        logRun: () => {},
        logProgress: () => {},
        writeStateSnapshot: () => {},
        archiveCurrentRun: () => {},
        normalizeRepoPath: (value) => value.replace(`${root}/`, ""),
        progressServerProc: {
          close: async () => calls.push("close"),
          kill: () => calls.push("kill"),
          pid: 123,
        },
        processKill: () => calls.push("processKill"),
        spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
        consoleLog: () => {},
      });

      assert.equal(result.exit_code, 0);
      assert.deepEqual(calls, ["close"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exitOnComplete=true exits 0 within the timeout even with a live event-loop handle", async () => {
    const result = await runNodeScript(finalizeScript({ exitOnComplete: true, keepAlive: true }));

    assert.equal(result.timedOut, false, result.stderr || result.stdout);
    assert.equal(result.code, 0, result.stderr || result.stdout);
  });

  test("exitOnComplete=false does not call process.exit, but closes the embedded progress server so the child drains", async () => {
    const result = await runNodeScript(finalizeScript({ exitOnComplete: false, startEmbeddedServer: true }));

    assert.equal(result.timedOut, false, result.stderr || result.stdout);
    assert.equal(result.code, 0, result.stderr || result.stdout);
  });
});
