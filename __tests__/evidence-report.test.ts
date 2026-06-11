import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunEvent, appendStateEvent } from "../src/runtime/evidence/ledger.js";
import {
  buildRunFinalAnswer,
  buildRunReport,
  formatRunFinalAnswerMarkdown,
  formatRunReportMarkdown,
  writeRunReport,
} from "../src/runtime/evidence/report.js";

function tempStateDir() {
  return mkdtempSync(join(tmpdir(), "yolo-report-state-"));
}

describe("evidence run report", () => {
  test("buildRunReport summarizes task results from evidence ledgers", () => {
    const stateDir = tempStateDir();
    try {
      appendRunEvent(stateDir, "run_start", {
        run_id: "RUN-1",
        prd: "data/prd.json",
        tasks: 3,
      }, { now: "2026-05-24T10:00:00.000Z" });
      appendStateEvent(stateDir, "gate.failed", {
        run_id: "RUN-1",
        task_id: "FIX-2",
        status: "fail",
      }, { now: "2026-05-24T10:01:00.000Z", source: "gate" });
      appendStateEvent(stateDir, "fixture.run", {
        run_id: "RUN-1",
        fixture_id: "node-basic",
        status: "pass",
        evidence_file: "state/evidence/FIX/run.json",
      }, { now: "2026-05-24T10:01:10.000Z", source: "fixture-harness" });
      appendStateEvent(stateDir, "spec.governance", {
        run_id: "RUN-1",
        status: "blocked",
        code: "PRD_SPEC_GOVERNANCE_BLOCKED",
        blocker_count: 2,
      }, { now: "2026-05-24T10:01:20.000Z", source: "preflight" });
      appendStateEvent(stateDir, "gate_remediation", {
        run_id: "RUN-1",
        task_id: "FIX-2",
        status: "remediation_required",
        action: "REROUTE_REVIEW_FIX",
        automation_can_continue: true,
        requires_human: false,
        unsafe_stop: false,
      }, { now: "2026-05-24T10:01:25.000Z", source: "runner-gate" });
      appendRunEvent(stateDir, "run_end", {
        run_id: "RUN-1",
        duration_sec: "12.5",
      }, { now: "2026-05-24T10:02:00.000Z" });
      const taskLogsDir = join(stateDir, "runtime", "task-logs");
      mkdirSync(taskLogsDir, { recursive: true });
      writeFileSync(join(taskLogsDir, "FIX-2.jsonl"), `${JSON.stringify({
        ts: "2026-05-24T10:01:30.000Z",
        run_id: "RUN-1",
        task_id: "FIX-2",
        type: "GATE",
        check: "post",
        result: "fail",
        errors: ["missing target"],
      })}\n`, "utf8");
      writeFileSync(join(taskLogsDir, "_review.jsonl"), [
        JSON.stringify({
          ts: "2026-05-24T10:01:40.000Z",
          run_id: "RUN-1",
          task_id: "_review",
          type: "REVIEW_ISSUE",
          severity: "critical",
          file: "src/a.js",
          line: 1,
          message: "must fix",
        }),
        JSON.stringify({
          ts: "2026-05-24T10:01:50.000Z",
          run_id: "RUN-1",
          task_id: "_review",
          type: "DONE",
          result: "round_done",
          issues_found: 1,
          issues_fixed: 0,
        }),
      ].join("\n") + "\n", "utf8");

      const report = buildRunReport({
        stateDir,
        runId: "RUN-1",
        taskResults: {
          completed: ["FIX-1", "FIX-3"],
          failed: ["FIX-2"],
          skipped: [],
          blocked: [],
          remediation: [{
            task_id: "FIX-2",
            status: "remediation_required",
            action: "REROUTE_REVIEW_FIX",
            automation_can_continue: true,
            requires_human: false,
            unsafe_stop: false,
            issue_count: 1,
          }],
        },
      });

      assert.equal(report.schema_version, "1.0");
      assert.equal(report.schema, "yolo.evidence.artifact.v1");
      assert.equal(report.artifact_type, "run.report");
      assert.equal(report.status, "error");
      assert.equal(report.summary.planned, 3);
      assert.equal(report.summary.completed, 2);
      assert.equal(report.summary.failed, 1);
      assert.equal(report.summary.task_success_rate, 66.7);
      assert.equal(report.summary.evidence_failures, 2);
      assert.equal(report.summary.run_success_rate, 40);
      assert.equal(report.ledger.run_events, 2);
      assert.equal(report.ledger.state_events, 4);
      assert.equal(report.ledger.task_log_events, 3);
      assert.equal(report.ledger.legacy_unscoped_task_log_events, 0);
      assert.equal(report.ledger.other_run_task_log_events, 0);
      assert.equal(report.gates.failed_count, 2);
      assert.deepEqual(report.gates.failed_tasks, ["FIX-2"]);
      assert.equal(report.remediation.item_count, 2);
      assert.equal(report.remediation.automation_continuable_count, 2);
      assert.equal(report.remediation.action_counts.REROUTE_REVIEW_FIX, 2);
      assert.equal(report.review.issue_count, 1);
      assert.equal(report.review.latest_result, "round_done");
      assert.equal(report.fixtures.run_count, 1);
      assert.equal(report.fixtures.pass_count, 1);
      assert.equal(report.spec_governance.blocked_count, 1);
      assert.equal(report.recent_events[0].event, "gate.failed");

      const finalAnswer = buildRunFinalAnswer(report, {
        reportJsonPath: "reports/RUN-1/run-report.json",
        reportMarkdownPath: "reports/RUN-1/run-report.md",
      });
      assert.equal(finalAnswer.schema, "yolo.evidence.final_answer.v1");
      assert.equal(finalAnswer.outcome, "needs_attention");
      assert.ok(finalAnswer.blockers.some((blocker) => blocker.includes("failed tasks: FIX-2")));
      assert.ok(finalAnswer.blockers.some((blocker) => blocker.includes("review issues: 1")));
      assert.ok(finalAnswer.checks.some((check) => check.name === "gates" && check.status === "fail"));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("writeRunReport writes report and final-answer artifacts plus a ledger event", () => {
    const stateDir = tempStateDir();
    try {
      appendRunEvent(stateDir, "run_start", {
        run_id: "RUN-2",
        prd: "data/prd.json",
        tasks: 1,
      }, { now: "2026-05-24T11:00:00.000Z" });

      const result = writeRunReport({
        stateDir,
        runId: "RUN-2",
        taskResults: {
          completed: ["FIX-1"],
          failed: [],
          skipped: [],
          blocked: [],
        },
        progressTotal: 1,
        durationSec: "3.0",
        finishedAt: "2026-05-24T11:00:03.000Z",
      });

      assert.equal(existsSync(result.json_path), true);
      assert.equal(existsSync(result.markdown_path), true);
      assert.equal(existsSync(result.final_answer_json_path), true);
      assert.equal(existsSync(result.final_answer_markdown_path), true);
      assert.equal(result.artifact_integrity.status, "pass");
      assert.equal(result.artifact_integrity.checked_count, 4);
      assert.equal(result.artifact_integrity.artifacts.every((artifact) => artifact.exists && artifact.sha256), true);
      const report = JSON.parse(readFileSync(result.json_path, "utf8"));
      assert.equal(report.status, "success");
      assert.equal(report.summary.run_success_rate, 100);
      const finalAnswer = JSON.parse(readFileSync(result.final_answer_json_path, "utf8"));
      assert.equal(finalAnswer.outcome, "success");
      assert.equal(finalAnswer.evidence.report_json, "reports/RUN-2/run-report.json");
      assert.match(readFileSync(result.markdown_path, "utf8"), /YOLO Run Report RUN-2/);
      assert.match(readFileSync(result.final_answer_markdown_path, "utf8"), /YOLO Final Answer RUN-2/);
      assert.match(readFileSync(join(stateDir, "events.jsonl"), "utf8"), /"event":"run.report"/);
      assert.match(readFileSync(join(stateDir, "events.jsonl"), "utf8"), /"final_answer_markdown"/);
      assert.match(readFileSync(join(stateDir, "events.jsonl"), "utf8"), /"artifact_integrity"/);
      assert.match(readFileSync(join(stateDir, "events.jsonl"), "utf8"), /"sha256"/);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("formatRunReportMarkdown renders empty sections deterministically", () => {
    const markdown = formatRunReportMarkdown({
      run_id: "RUN-3",
      status: "success",
      summary: {},
      tasks: {},
    });

    assert.match(markdown, /## Completed\n- none/);
    assert.match(markdown, /## Failed\n- none/);
  });

  test("formatRunFinalAnswerMarkdown renders blockers and evidence deterministically", () => {
    const markdown = formatRunFinalAnswerMarkdown({
      schema: "yolo.evidence.final_answer.v1",
      run_id: "RUN-5",
      status: "error",
      outcome: "needs_attention",
      summary: { completed: 1, failed: 1, skipped: 0, blocked: 0 },
      checks: [{ name: "tasks", status: "fail", detail: "completed=1 failed=1 skipped=0 blocked=0" }],
      blockers: ["failed tasks: FIX-1"],
      evidence: { report_json: "reports/RUN-5/run-report.json", report_markdown: "reports/RUN-5/run-report.md" },
      next_actions: ["Fix failed tasks."],
    });

    assert.match(markdown, /## Blockers\n- failed tasks: FIX-1/);
    assert.match(markdown, /Report JSON: reports\/RUN-5\/run-report\.json/);
  });

  test("buildRunReport treats blocked tasks as an error status", () => {
    const stateDir = tempStateDir();
    try {
      const report = buildRunReport({
        stateDir,
        runId: "RUN-4",
        taskResults: {
          completed: [],
          failed: [],
          skipped: [],
          blocked: ["FIX-BLOCKED"],
        },
      });

      assert.equal(report.status, "error");
      assert.deepEqual(report.tasks.blocked, ["FIX-BLOCKED"]);
      assert.equal(report.summary.planned, 1);
      assert.equal(report.summary.task_success_rate, 0);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("buildRunReport fails empty task evidence instead of reporting success", () => {
    const stateDir = tempStateDir();
    try {
      const report = buildRunReport({
        stateDir,
        runId: "RUN-EMPTY",
        taskResults: {
          completed: [],
          failed: [],
          skipped: [],
          blocked: [],
        },
        progressTotal: 0,
      });

      assert.equal(report.status, "error");
      assert.equal(report.summary.planned, 0);
      const finalAnswer = buildRunFinalAnswer(report);
      assert.equal(finalAnswer.outcome, "needs_attention");
      assert.ok(finalAnswer.blockers.some((blocker) => blocker.includes("no planned task evidence")));
      assert.ok(finalAnswer.blockers.some((blocker) => blocker.includes("no terminal task evidence")));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("buildRunReport ignores legacy unscoped state events for current run status", () => {
    const stateDir = tempStateDir();
    try {
      appendRunEvent(stateDir, "run_start", {
        run_id: "RUN-CURRENT",
        prd: "data/prd.json",
        tasks: 1,
      }, { now: "2026-06-05T10:00:00.000Z" });
      appendStateEvent(stateDir, "gate.failed", {
        task_id: "OLD-TASK",
        status: "fail",
        reason: "legacy failure without run id",
      }, { now: "2026-06-05T09:00:00.000Z", source: "legacy-gate" });
      appendStateEvent(stateDir, "fixture.run", {
        run_id: "RUN-CURRENT",
        fixture_id: "current",
        status: "pass",
      }, { now: "2026-06-05T10:01:00.000Z", source: "fixture" });

      const report = buildRunReport({
        stateDir,
        runId: "RUN-CURRENT",
        taskResults: {
          completed: ["FIX-1"],
          failed: [],
          skipped: [],
          blocked: [],
        },
        progressTotal: 1,
      });

      assert.equal(report.status, "success");
      assert.equal(report.gates.failed_count, 0);
      assert.equal(report.ledger.state_events, 1);
      assert.equal(report.ledger.legacy_unscoped_events, 1);
      assert.equal(report.ledger.legacy_unscoped_state_events, 1);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("buildRunReport ignores other-run and unscoped task logs for current run status", () => {
    const stateDir = tempStateDir();
    try {
      appendRunEvent(stateDir, "run_start", {
        run_id: "RUN-CURRENT",
        prd: "data/prd.json",
        tasks: 1,
      }, { now: "2026-06-05T10:00:00.000Z" });
      const taskLogsDir = join(stateDir, "runtime", "task-logs");
      mkdirSync(taskLogsDir, { recursive: true });
      writeFileSync(join(taskLogsDir, "FIX-1.jsonl"), [
        JSON.stringify({
          ts: "2026-06-05T09:00:00.000Z",
          run_id: "RUN-OLD",
          task_id: "FIX-OLD",
          type: "GATE",
          check: "post",
          result: "fail",
          errors: ["old failure"],
        }),
        JSON.stringify({
          ts: "2026-06-05T09:01:00.000Z",
          task_id: "FIX-LEGACY",
          type: "GATE",
          check: "post",
          result: "fail",
          errors: ["legacy failure"],
        }),
        JSON.stringify({
          ts: "2026-06-05T10:01:00.000Z",
          run_id: "RUN-CURRENT",
          task_id: "FIX-1",
          type: "GATE",
          check: "post",
          result: "pass",
        }),
      ].join("\n") + "\n", "utf8");
      writeFileSync(join(taskLogsDir, "_review.jsonl"), [
        JSON.stringify({
          ts: "2026-06-05T09:02:00.000Z",
          run_id: "RUN-OLD",
          task_id: "_review",
          type: "REVIEW_ISSUE",
          severity: "critical",
          file: "src/old.ts",
          line: 1,
          message: "old issue",
        }),
        JSON.stringify({
          ts: "2026-06-05T09:03:00.000Z",
          task_id: "_review",
          type: "ERROR",
          message: "legacy review error",
        }),
        JSON.stringify({
          ts: "2026-06-05T10:02:00.000Z",
          run_id: "RUN-CURRENT",
          task_id: "_review",
          type: "DONE",
          result: "round_done",
          issues_found: 0,
          issues_fixed: 0,
        }),
      ].join("\n") + "\n", "utf8");

      const report = buildRunReport({
        stateDir,
        runId: "RUN-CURRENT",
        taskResults: {
          completed: ["FIX-1"],
          failed: [],
          skipped: [],
          blocked: [],
        },
        progressTotal: 1,
      });

      assert.equal(report.status, "success");
      assert.equal(report.gates.failed_count, 0);
      assert.equal(report.review.issue_count, 0);
      assert.equal(report.review.error_count, 0);
      assert.equal(report.review.latest_result, "round_done");
      assert.equal(report.ledger.task_log_events, 2);
      assert.equal(report.ledger.legacy_unscoped_task_log_events, 2);
      assert.equal(report.ledger.other_run_task_log_events, 2);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("buildRunReport treats current-run gate failures as error status", () => {
    const stateDir = tempStateDir();
    try {
      appendRunEvent(stateDir, "run_start", {
        run_id: "RUN-GATE",
        prd: "data/prd.json",
        tasks: 1,
      }, { now: "2026-06-05T11:00:00.000Z" });
      appendStateEvent(stateDir, "gate.failed", {
        run_id: "RUN-GATE",
        task_id: "FIX-1",
        status: "fail",
        reason: "postcondition failed",
      }, { now: "2026-06-05T11:01:00.000Z", source: "gate" });

      const report = buildRunReport({
        stateDir,
        runId: "RUN-GATE",
        taskResults: {
          completed: ["FIX-1"],
          failed: [],
          skipped: [],
          blocked: [],
        },
        progressTotal: 1,
      });

      assert.equal(report.status, "error");
      assert.equal(report.summary.evidence_failures, 1);
      assert.equal(report.summary.run_success_rate, 50);
      assert.equal(report.gates.failed_count, 1);
      const finalAnswer = buildRunFinalAnswer(report);
      assert.equal(finalAnswer.outcome, "needs_attention");
      assert.ok(finalAnswer.blockers.some((blocker) => blocker.includes("failed gates: 1")));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("YB-007 buildRunReport folds review and fixture failures into run success rate", () => {
    const stateDir = tempStateDir();
    try {
      appendRunEvent(stateDir, "run_start", {
        run_id: "RUN-EVIDENCE",
        prd: "data/prd.json",
        tasks: 1,
      }, { now: "2026-06-05T12:00:00.000Z" });
      appendStateEvent(stateDir, "fixture.run", {
        run_id: "RUN-EVIDENCE",
        fixture_id: "browser-smoke",
        status: "fail",
      }, { now: "2026-06-05T12:01:00.000Z", source: "fixture" });
      const taskLogsDir = join(stateDir, "runtime", "task-logs");
      mkdirSync(taskLogsDir, { recursive: true });
      writeFileSync(join(taskLogsDir, "_review.jsonl"), `${JSON.stringify({
        ts: "2026-06-05T12:02:00.000Z",
        run_id: "RUN-EVIDENCE",
        task_id: "_review",
        type: "ERROR",
        message: "review task limit exhausted",
      })}\n`, "utf8");

      const report = buildRunReport({
        stateDir,
        runId: "RUN-EVIDENCE",
        taskResults: {
          completed: ["FIX-1"],
          failed: [],
          skipped: [],
          blocked: [],
        },
        progressTotal: 1,
      });

      assert.equal(report.status, "error");
      assert.equal(report.summary.completed, 1);
      assert.equal(report.summary.evidence_failures, 2);
      assert.equal(report.summary.run_success_rate, 33.3);
      const finalAnswer = buildRunFinalAnswer(report);
      assert.equal(finalAnswer.outcome, "needs_attention");
      assert.ok(finalAnswer.blockers.some((blocker) => blocker.includes("review errors: 1")));
      assert.ok(finalAnswer.blockers.some((blocker) => blocker.includes("fixture failures: 1")));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("buildRunReport fails evidence integrity when ledger hash chain is invalid", () => {
    const stateDir = tempStateDir();
    try {
      writeFileSync(join(stateDir, "events.jsonl"), `${JSON.stringify({
        schema_version: "1.0",
        schema: "yolo.ledger.event.v1",
        ts: "2026-06-05T12:10:00.000Z",
        ledger: "state",
        event: "gate_passed",
        source: "test",
      })}\n`, "utf8");

      const report = buildRunReport({
        stateDir,
        runId: "RUN-BROKEN-LEDGER",
        taskResults: {
          completed: ["FIX-1"],
          failed: [],
          skipped: [],
          blocked: [],
        },
        progressTotal: 1,
      });

      assert.equal(report.status, "error");
      assert.equal(report.ledger.integrity.status, "fail");
      assert.equal(report.ledger.integrity.error_count > 0, true);
      assert.equal(report.summary.evidence_failures > 0, true);
      const finalAnswer = buildRunFinalAnswer(report);
      assert.ok(finalAnswer.blockers.some((blocker) => blocker.includes("evidence ledger integrity errors")));
      assert.ok(finalAnswer.checks.some((check) => check.name === "evidence_integrity" && check.status === "fail"));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("buildRunReport fails active ledger segments whose external head is not archived", () => {
    const stateDir = tempStateDir();
    try {
      appendStateEvent(stateDir, "run.note", {
        run_id: "RUN-TRUNCATED",
        status: "pass",
      }, { now: "2026-06-05T12:20:00.000Z", source: "test" });
      appendStateEvent(stateDir, "run.note", {
        run_id: "RUN-TRUNCATED",
        status: "pass",
      }, { now: "2026-06-05T12:21:00.000Z", source: "test" });
      const eventsPath = join(stateDir, "events.jsonl");
      const lines = readFileSync(eventsPath, "utf8").trim().split("\n");
      writeFileSync(eventsPath, `${lines[1]}\n`, "utf8");

      const report = buildRunReport({
        stateDir,
        runId: "RUN-TRUNCATED",
        taskResults: {
          completed: ["FIX-1"],
          failed: [],
          skipped: [],
          blocked: [],
        },
        progressTotal: 1,
      });

      assert.equal(report.status, "error");
      assert.equal(report.ledger.integrity.status, "fail");
      assert.equal(report.ledger.integrity.state_chain.external_head_allowed, false);
      assert.equal(report.summary.evidence_failures > 0, true);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("buildRunReport allows retained ledger heads only when archive proves the previous hash", () => {
    const stateDir = tempStateDir();
    try {
      appendStateEvent(stateDir, "run.note", {
        run_id: "RUN-RETAINED",
        status: "pass",
      }, { now: "2026-06-05T12:30:00.000Z", source: "test" });
      appendStateEvent(stateDir, "run.note", {
        run_id: "RUN-RETAINED",
        status: "pass",
      }, { now: "2026-06-05T12:31:00.000Z", source: "test" });
      const eventsPath = join(stateDir, "events.jsonl");
      const lines = readFileSync(eventsPath, "utf8").trim().split("\n");
      const archiveDir = join(stateDir, "archive", "jsonl", "2026-06");
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, "events.jsonl"), `${lines[0]}\n`, "utf8");
      writeFileSync(eventsPath, `${lines[1]}\n`, "utf8");

      const report = buildRunReport({
        stateDir,
        runId: "RUN-RETAINED",
        taskResults: {
          completed: ["FIX-1"],
          failed: [],
          skipped: [],
          blocked: [],
        },
        progressTotal: 1,
      });

      assert.equal(report.ledger.integrity.status, "pass");
      assert.equal(report.ledger.integrity.state_chain.external_head_allowed, true);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("buildRunReport rejects state ledger heads proved only by run archives", () => {
    const stateDir = tempStateDir();
    try {
      appendRunEvent(stateDir, "run.note", {
        run_id: "RUN-CROSS-LEDGER",
        status: "pass",
      }, { now: "2026-06-05T12:40:00.000Z", source: "test" });
      const runsPath = join(stateDir, "runs.jsonl");
      const runLine = readFileSync(runsPath, "utf8").trim();
      const archivedRunHash = JSON.parse(runLine).record_hash;
      const archiveDir = join(stateDir, "archive", "jsonl", "2026-06");
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, "runs.jsonl"), `${runLine}\n`, "utf8");
      writeFileSync(runsPath, "", "utf8");
      appendStateEvent(stateDir, "run.note", {
        run_id: "RUN-CROSS-LEDGER",
        status: "pass",
      }, { now: "2026-06-05T12:41:00.000Z", source: "test", prevHash: archivedRunHash });

      const report = buildRunReport({
        stateDir,
        runId: "RUN-CROSS-LEDGER",
        taskResults: {
          completed: ["FIX-1"],
          failed: [],
          skipped: [],
          blocked: [],
        },
        progressTotal: 1,
      });

      assert.equal(report.ledger.integrity.status, "fail");
      assert.equal(report.ledger.integrity.state_chain.external_head_allowed, false);
      assert.equal(report.summary.evidence_failures > 0, true);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("buildRunReport rejects state records stored in archived run ledgers", () => {
    const stateDir = tempStateDir();
    try {
      appendStateEvent(stateDir, "run.note", {
        run_id: "RUN-ARCHIVE-MISMATCH",
        status: "pass",
      }, { now: "2026-06-05T12:50:00.000Z", source: "test" });
      appendStateEvent(stateDir, "run.note", {
        run_id: "RUN-ARCHIVE-MISMATCH",
        status: "pass",
      }, { now: "2026-06-05T12:51:00.000Z", source: "test" });
      const eventsPath = join(stateDir, "events.jsonl");
      const lines = readFileSync(eventsPath, "utf8").trim().split("\n");
      const archiveDir = join(stateDir, "archive", "jsonl", "2026-06");
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, "runs.jsonl"), `${lines[0]}\n`, "utf8");
      writeFileSync(eventsPath, `${lines[1]}\n`, "utf8");

      const report = buildRunReport({
        stateDir,
        runId: "RUN-ARCHIVE-MISMATCH",
        taskResults: {
          completed: ["FIX-1"],
          failed: [],
          skipped: [],
          blocked: [],
        },
        progressTotal: 1,
      });

      assert.equal(report.ledger.integrity.status, "fail");
      assert.equal(report.ledger.integrity.state_chain.external_head_allowed, false);
      assert.ok(report.ledger.integrity.archive_errors.some((issue) => issue.code === "ARCHIVE_LEDGER_MISMATCH"));
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test("buildRunFinalAnswer treats explicit not-run checks as needs attention", () => {
    const finalAnswer = buildRunFinalAnswer({
      run_id: "RUN-NOT-RUN",
      status: "success",
      summary: { planned: 1, completed: 1, failed: 0, skipped: 0, blocked: 0, evidence_failures: 0 },
      tasks: { completed: ["FIX-1"], failed: [], skipped: [], blocked: [] },
      fixtures: { status: "not_run", run_count: 0 },
    });

    assert.equal(finalAnswer.outcome, "needs_attention");
    assert.ok(finalAnswer.blockers.some((blocker) => blocker.includes("fixtures check is not_run")));
  });

});
