import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  appendStateEvent,
  buildEvidenceArtifact,
  writeJsonArtifact,
} from "./ledger.js";
import { normalizeReviewFinding } from "../../review/findings.js";

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rate(numerator, denominator) {
  if (!denominator || denominator <= 0) return null;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function last(values = []) {
  return values.length > 0 ? values[values.length - 1] : null;
}

function reportStatus(taskResults = {}) {
  return (taskResults.failed || []).length > 0 ||
    (taskResults.blocked || []).length > 0 ||
    (taskResults.evidence_failure_count || 0) > 0
    ? "error"
    : "success";
}

function itemList(values = [], limit = 8) {
  const items = unique(values).slice(0, limit);
  const remaining = Math.max(0, unique(values).length - items.length);
  return remaining > 0 ? [...items, `+${remaining} more`] : items;
}

function taskId(entry = {}) {
  return entry.task_id || entry.task || null;
}

function readTaskLogs(taskLogsDir) {
  if (!taskLogsDir || !existsSync(taskLogsDir)) return [];
  return readdirSync(taskLogsDir)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) => readJsonl(join(taskLogsDir, file)).map((entry) => ({ log_file: file, ...entry })));
}

function filterTaskLogsForRun(entries = [], runId = null) {
  if (!runId) {
    return {
      current: entries,
      legacyUnscoped: [],
      otherRun: [],
    };
  }
  return {
    current: entries.filter((entry) => entry.run_id === runId),
    legacyUnscoped: entries.filter((entry) => !entry.run_id),
    otherRun: entries.filter((entry) => entry.run_id && entry.run_id !== runId),
  };
}

function summarizeGateEvidence({ stateEvents, taskLogEntries }) {
  const stateGateFailures = stateEvents
    .filter((entry) => ["gate_fail", "gate.failed", "gate_failure"].includes(entry.event) || entry.status === "gate_failed")
    .map((entry) => ({
      source: "state",
      task_id: taskId(entry),
      gate: entry.gate || entry.check || "gate",
      status: entry.status || "fail",
      exit_code: entry.exitCode ?? entry.exit_code ?? null,
      reason: entry.reason || entry.message || null,
      ts: entry.ts || null,
    }));

  const taskLogGateFailures = taskLogEntries
    .filter((entry) => entry.type === "GATE" && entry.result === "fail")
    .map((entry) => ({
      source: "task-log",
      task_id: taskId(entry),
      gate: entry.check || "gate",
      status: "fail",
      exit_code: entry.exitCode ?? entry.exit_code ?? null,
      reason: Array.isArray(entry.errors) ? entry.errors.join("\n") : entry.errors || null,
      ts: entry.ts || null,
    }));

  const failures = [...stateGateFailures, ...taskLogGateFailures];
  return {
    failed_count: failures.length,
    failed_tasks: unique(failures.map((entry) => entry.task_id)),
    failures: failures.slice(-20),
  };
}

function summarizeReviewEvidence(taskLogEntries) {
  const reviewEntries = taskLogEntries.filter((entry) => entry.task_id === "_review" || entry.log_file === "_review.jsonl");
  const issues = reviewEntries
    .filter((entry) => entry.type === "REVIEW_ISSUE")
    .map((entry, index) => ({
      ...normalizeReviewFinding(entry, { source: entry.source || "task-log", index }),
      ts: entry.ts || null,
    }));
  const errors = reviewEntries
    .filter((entry) => entry.type === "ERROR")
    .map((entry) => ({
      message: entry.message || null,
      detail: entry.detail || null,
      ts: entry.ts || null,
    }));
  const done = last(reviewEntries.filter((entry) => entry.type === "DONE"));
  return {
    issue_count: issues.length,
    error_count: errors.length,
    issues: issues.slice(-20),
    errors: errors.slice(-10),
    latest_result: done?.result || null,
    latest_issues_found: done?.issues_found ?? null,
    latest_issues_fixed: done?.issues_fixed ?? null,
  };
}

function summarizeFixtureEvidence(stateEvents) {
  const runs = stateEvents
    .filter((entry) => entry.event === "fixture.run")
    .map((entry) => ({
      fixture_id: entry.fixture_id || null,
      status: entry.status || null,
      evidence_file: entry.evidence_file || null,
      ts: entry.ts || null,
    }));
  return {
    run_count: runs.length,
    pass_count: runs.filter((entry) => entry.status === "pass").length,
    fail_count: runs.filter((entry) => entry.status === "fail").length,
    runs: runs.slice(-20),
  };
}

function summarizeSpecGovernance(stateEvents) {
  const events = stateEvents
    .filter((entry) =>
      String(entry.event || "").includes("spec") ||
      String(entry.code || "").includes("SPEC_GOVERNANCE") ||
      entry.spec_governance
    )
    .map((entry) => ({
      event: entry.event || null,
      status: entry.status || entry.spec_governance?.status || null,
      code: entry.code || null,
      task_id: taskId(entry),
      blocker_count: entry.spec_governance?.blockers?.length ?? entry.blocker_count ?? null,
      warning_count: entry.spec_governance?.warnings?.length ?? entry.warning_count ?? null,
      ts: entry.ts || null,
    }));
  return {
    event_count: events.length,
    blocked_count: events.filter((entry) => entry.status === "blocked" || String(entry.code || "").includes("BLOCKED")).length,
    warning_count: events.filter((entry) => entry.status === "warning").length,
    events: events.slice(-20),
  };
}

function evidenceFailureCount({
  gates = {},
  review = {},
  fixtures = {},
  specGovernance = {},
  remediation = {},
  failed = [],
  blocked = [],
} = {}) {
  const representedTaskFailures = new Set([...failed, ...blocked]);
  const gateTasks = unique(gates.failed_tasks || []);
  const unrepresentedGateTasks = gateTasks.filter((id) => !representedTaskFailures.has(id)).length;
  const unassignedGateFailures = (gates.failures || []).filter((failure) => !failure.task_id).length;
  return unrepresentedGateTasks +
    unassignedGateFailures +
    (review.issue_count || 0) +
    (review.error_count || 0) +
    (fixtures.fail_count || 0) +
    (specGovernance.blocked_count || 0) +
    (remediation.human_required_count || 0) +
    (remediation.unsafe_stop_count || 0);
}

function summarizeRemediation({ taskResults = {}, stateEvents = [] } = {}) {
  const fromTaskResults = (taskResults.remediation || []).map((entry) => ({
    source: "task-results",
    task_id: entry.task_id || null,
    action: entry.action || null,
    status: entry.status || null,
    automation_can_continue: entry.automation_can_continue ?? null,
    requires_human: entry.requires_human ?? null,
    unsafe_stop: entry.unsafe_stop ?? null,
    issue_count: entry.issue_count ?? null,
  }));
  const fromEvents = stateEvents
    .filter((entry) => entry.event === "gate_remediation")
    .map((entry) => ({
      source: "state",
      task_id: taskId(entry),
      action: entry.action || null,
      status: entry.status || null,
      automation_can_continue: entry.automation_can_continue ?? null,
      requires_human: entry.requires_human ?? null,
      unsafe_stop: entry.unsafe_stop ?? null,
      ts: entry.ts || null,
    }));
  const items = [...fromTaskResults, ...fromEvents];
  const action_counts = {};
  for (const item of items) {
    const action = item.action || "UNKNOWN";
    action_counts[action] = (action_counts[action] || 0) + 1;
  }
  return {
    item_count: items.length,
    automation_continuable_count: items.filter((item) => item.automation_can_continue === true).length,
    human_required_count: items.filter((item) => item.requires_human === true).length,
    unsafe_stop_count: items.filter((item) => item.unsafe_stop === true).length,
    action_counts,
    tasks: unique(items.map((item) => item.task_id)),
    items: items.slice(-20),
  };
}

export function buildRunReport({
  stateDir,
  runId,
  prdPath = null,
  taskResults = {},
  progressTotal = null,
  startedAt = null,
  finishedAt = new Date().toISOString(),
  durationSec = null,
  taskLogsDir = null,
} = {}) {
  if (!stateDir) throw new Error("buildRunReport requires stateDir");

  const runs = readJsonl(join(stateDir, "runs.jsonl"));
  const events = readJsonl(join(stateDir, "events.jsonl"));
  const runEvents = runId ? runs.filter((entry) => entry.run_id === runId) : runs;
  const stateEvents = runId ? events.filter((entry) => entry.run_id === runId) : events;
  const legacyUnscopedStateEvents = runId ? events.filter((entry) => !entry.run_id) : [];
  const allTaskLogEntries = readTaskLogs(taskLogsDir || join(stateDir, "runtime", "task-logs"));
  const taskLogScope = filterTaskLogsForRun(allTaskLogEntries, runId);
  const taskLogEntries = taskLogScope.current;
  const runStart = runEvents.find((entry) => entry.event === "run_start") || null;
  const runEnd = last(runEvents.filter((entry) => entry.event === "run_end"));

  const completed = unique(taskResults.completed || []);
  const failed = unique(taskResults.failed || []);
  const skipped = unique(taskResults.skipped || []);
  const blocked = unique(taskResults.blocked || []);
  const terminalCount = completed.length + failed.length + blocked.length;
  const plannedCount = progressTotal ?? runStart?.tasks ?? terminalCount + skipped.length;
  const duration = asNumber(durationSec ?? runEnd?.duration_sec);
  const gates = summarizeGateEvidence({ stateEvents, taskLogEntries });
  const remediation = summarizeRemediation({ taskResults, stateEvents });
  const review = summarizeReviewEvidence(taskLogEntries);
  const fixtures = summarizeFixtureEvidence(stateEvents);
  const specGovernance = summarizeSpecGovernance(stateEvents);
  const evidenceFailures = evidenceFailureCount({
    gates,
    review,
    fixtures,
    specGovernance,
    remediation,
    failed,
    blocked,
  });
  const runRateDenominator = plannedCount == null ? plannedCount : plannedCount + evidenceFailures;

  return buildEvidenceArtifact("run.report", {
    run_id: runId || runStart?.run_id || runEnd?.run_id || null,
    prd: prdPath || runStart?.prd || runEnd?.prd || null,
    status: reportStatus({ failed, blocked, evidence_failure_count: evidenceFailures }),
    started_at: startedAt || runStart?.ts || null,
    finished_at: finishedAt || runEnd?.ts || null,
    duration_sec: duration,
    summary: {
      planned: plannedCount,
      completed: completed.length,
      failed: failed.length,
      skipped: skipped.length,
      blocked: blocked.length,
      evidence_failures: evidenceFailures,
      task_success_rate: rate(completed.length, terminalCount),
      run_success_rate: rate(completed.length, runRateDenominator),
    },
    tasks: {
      completed,
      failed,
      skipped,
      blocked,
    },
    ledger: {
      run_events: runEvents.length,
      state_events: stateEvents.length,
      legacy_unscoped_events: legacyUnscopedStateEvents.length,
      legacy_unscoped_state_events: legacyUnscopedStateEvents.length,
      task_log_events: taskLogEntries.length,
      legacy_unscoped_task_log_events: taskLogScope.legacyUnscoped.length,
      other_run_task_log_events: taskLogScope.otherRun.length,
      latest_run_event: runEnd?.event || last(runEvents)?.event || null,
      latest_state_event: last(stateEvents)?.event || null,
    },
    gates,
    remediation,
    review,
    fixtures,
    spec_governance: specGovernance,
    recent_events: stateEvents.slice(-20).map((entry) => ({
      ts: entry.ts,
      event: entry.event,
      source: entry.source || null,
      task_id: entry.task_id || null,
      status: entry.status || null,
    })),
  }, { source: "run-report" });
}

export function formatRunReportMarkdown(report) {
  const summary = report.summary || {};
  const tasks = report.tasks || {};
  const lines = [
    `# YOLO Run Report ${report.run_id || ""}`.trim(),
    "",
    `- Status: ${report.status}`,
    `- PRD: ${report.prd || "unknown"}`,
    `- Started: ${report.started_at || "unknown"}`,
    `- Finished: ${report.finished_at || "unknown"}`,
    `- Duration: ${report.duration_sec ?? "unknown"}s`,
    `- Planned: ${summary.planned ?? "unknown"}`,
    `- Completed: ${summary.completed || 0}`,
    `- Failed: ${summary.failed || 0}`,
    `- Skipped: ${summary.skipped || 0}`,
    `- Blocked: ${summary.blocked || 0}`,
    `- Evidence failures: ${summary.evidence_failures || 0}`,
    `- Task success rate: ${summary.task_success_rate == null ? "N/A" : `${summary.task_success_rate}%`}`,
    `- Run success rate: ${summary.run_success_rate == null ? "N/A" : `${summary.run_success_rate}%`}`,
    "",
    "## Gates",
    `- Failed gates: ${report.gates?.failed_count || 0}`,
    (report.gates?.failures || []).length
      ? report.gates.failures.map((failure) => `- ${failure.task_id || "unknown"} ${failure.gate}: ${failure.reason || failure.status}`).join("\n")
      : "- none",
    "",
    "## Remediation",
    `- Items: ${report.remediation?.item_count || 0}`,
    `- Automation can continue: ${report.remediation?.automation_continuable_count || 0}`,
    `- Human required: ${report.remediation?.human_required_count || 0}`,
    "",
    "## Review",
    `- Issues: ${report.review?.issue_count || 0}`,
    `- Errors: ${report.review?.error_count || 0}`,
    (report.review?.issues || []).length
      ? report.review.issues.map((issue) => `- ${issue.severity || "unknown"} ${issue.file || "unknown"}:${issue.line || ""} ${issue.message || ""}`.trim()).join("\n")
      : "- none",
    "",
    "## Fixtures",
    `- Runs: ${report.fixtures?.run_count || 0}`,
    `- Pass: ${report.fixtures?.pass_count || 0}`,
    `- Fail: ${report.fixtures?.fail_count || 0}`,
    "",
    "## Spec Governance",
    `- Events: ${report.spec_governance?.event_count || 0}`,
    `- Blocked: ${report.spec_governance?.blocked_count || 0}`,
    `- Warnings: ${report.spec_governance?.warning_count || 0}`,
    "",
    "## Completed",
    (tasks.completed || []).length ? tasks.completed.map((id) => `- ${id}`).join("\n") : "- none",
    "",
    "## Failed",
    (tasks.failed || []).length ? tasks.failed.map((id) => `- ${id}`).join("\n") : "- none",
  ];
  return `${lines.join("\n")}\n`;
}

export function buildRunFinalAnswer(report = {}, options = {}) {
  const summary = report.summary || {};
  const tasks = report.tasks || {};
  const failed = unique(tasks.failed || []);
  const blocked = unique(tasks.blocked || []);
  const completed = unique(tasks.completed || []);
  const skipped = unique(tasks.skipped || []);
  const gateFailures = report.gates?.failed_count || 0;
  const reviewIssues = report.review?.issue_count || 0;
  const reviewErrors = report.review?.error_count || 0;
  const specBlocked = report.spec_governance?.blocked_count || 0;
  const fixtureFailures = report.fixtures?.fail_count || 0;
  const remediationItems = report.remediation?.item_count || 0;
  const remediationHuman = report.remediation?.human_required_count || 0;
  const remediationUnsafe = report.remediation?.unsafe_stop_count || 0;
  const status = report.status || (failed.length || blocked.length ? "error" : "success");
  const blockerLines = [
    ...(failed.length ? [`failed tasks: ${itemList(failed).join(", ")}`] : []),
    ...(blocked.length ? [`blocked tasks: ${itemList(blocked).join(", ")}`] : []),
    ...(gateFailures ? [`failed gates: ${gateFailures}`] : []),
    ...(reviewIssues ? [`review issues: ${reviewIssues}`] : []),
    ...(reviewErrors ? [`review errors: ${reviewErrors}`] : []),
    ...(specBlocked ? [`spec governance blocked events: ${specBlocked}`] : []),
    ...(fixtureFailures ? [`fixture failures: ${fixtureFailures}`] : []),
    ...(remediationHuman ? [`human remediation required: ${remediationHuman}`] : []),
    ...(remediationUnsafe ? [`unsafe remediation stop: ${remediationUnsafe}`] : []),
  ];

  const checks = [
    {
      name: "tasks",
      status: failed.length || blocked.length ? "fail" : "pass",
      detail: `completed=${completed.length} failed=${failed.length} skipped=${skipped.length} blocked=${blocked.length}`,
    },
    {
      name: "gates",
      status: gateFailures > 0 ? "fail" : "pass",
      detail: `failed=${gateFailures}`,
    },
    {
      name: "remediation",
      status: remediationUnsafe || remediationHuman ? "fail" : (remediationItems > 0 ? "warning" : "pass"),
      detail: `items=${remediationItems} auto_continuable=${report.remediation?.automation_continuable_count || 0} human=${remediationHuman} unsafe=${remediationUnsafe}`,
    },
    {
      name: "review",
      status: reviewErrors > 0 || reviewIssues > 0 ? "fail" : "pass",
      detail: `issues=${reviewIssues} errors=${reviewErrors}`,
    },
    {
      name: "fixtures",
      status: fixtureFailures > 0 ? "fail" : ((report.fixtures?.run_count || 0) > 0 ? "pass" : "not_run"),
      detail: `runs=${report.fixtures?.run_count || 0} fail=${fixtureFailures}`,
    },
    {
      name: "spec_governance",
      status: specBlocked > 0 ? "fail" : ((report.spec_governance?.warning_count || 0) > 0 ? "warning" : "pass"),
      detail: `blocked=${specBlocked} warnings=${report.spec_governance?.warning_count || 0}`,
    },
  ];

  const nextActions = blockerLines.length
    ? [
        "Open the run report JSON/Markdown for exact blockers.",
        "Use the remediation section to see whether YOLO can auto-fix, reroute to review/fix, or must ask a human.",
        "Fix failed or blocked tasks before treating this run as complete.",
      ]
    : [
        "Use the run report as completion evidence.",
        "Keep the report artifact with the task or release notes.",
      ];

  return {
    schema_version: "1.0",
    schema: "yolo.evidence.final_answer.v1",
    source: "run-report",
    run_id: report.run_id || null,
    status,
    outcome: status === "success" && blockerLines.length === 0 ? "completed" : "needs_attention",
    headline: status === "success" && blockerLines.length === 0
      ? `YOLO run ${report.run_id || "unknown"} completed`
      : `YOLO run ${report.run_id || "unknown"} completed with blockers`,
    summary: {
      planned: summary.planned ?? null,
      completed: completed.length,
      failed: failed.length,
      skipped: skipped.length,
      blocked: blocked.length,
      evidence_failures: summary.evidence_failures ?? null,
      task_success_rate: summary.task_success_rate ?? null,
      run_success_rate: summary.run_success_rate ?? null,
    },
    checks,
    blockers: blockerLines,
    tasks: {
      completed: itemList(completed),
      failed: itemList(failed),
      skipped: itemList(skipped),
      blocked: itemList(blocked),
    },
    evidence: {
      report_json: options.reportJsonPath || options.report_json || null,
      report_markdown: options.reportMarkdownPath || options.report_markdown || null,
      generated_from: report.artifact_type || "run.report",
    },
    next_actions: nextActions,
  };
}

export function formatRunFinalAnswerMarkdown(finalAnswerOrReport = {}, options = {}) {
  const finalAnswer = finalAnswerOrReport.schema === "yolo.evidence.final_answer.v1"
    ? finalAnswerOrReport
    : buildRunFinalAnswer(finalAnswerOrReport, options);
  const summary = finalAnswer.summary || {};
  const lines = [
    `# YOLO Final Answer ${finalAnswer.run_id || ""}`.trim(),
    "",
    `- Status: ${finalAnswer.status}`,
    `- Outcome: ${finalAnswer.outcome}`,
    `- Completed: ${summary.completed || 0}`,
    `- Failed: ${summary.failed || 0}`,
    `- Skipped: ${summary.skipped || 0}`,
    `- Blocked: ${summary.blocked || 0}`,
    `- Evidence failures: ${summary.evidence_failures || 0}`,
    `- Task success rate: ${summary.task_success_rate == null ? "N/A" : `${summary.task_success_rate}%`}`,
    `- Run success rate: ${summary.run_success_rate == null ? "N/A" : `${summary.run_success_rate}%`}`,
    "",
    "## Checks",
    ...(finalAnswer.checks || []).map((check) => `- ${check.name}: ${check.status} (${check.detail})`),
    "",
    "## Blockers",
    ...(finalAnswer.blockers || []).length ? finalAnswer.blockers.map((item) => `- ${item}`) : ["- none"],
    "",
    "## Evidence",
    `- Report JSON: ${finalAnswer.evidence?.report_json || "unknown"}`,
    `- Report Markdown: ${finalAnswer.evidence?.report_markdown || "unknown"}`,
    "",
    "## Next Actions",
    ...(finalAnswer.next_actions || []).map((item) => `- ${item}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export function runReportPaths(stateDir, runId = "latest") {
  const reportDir = join(stateDir, "reports", runId || "latest");
  return {
    report_dir: reportDir,
    json_path: join(reportDir, "run-report.json"),
    markdown_path: join(reportDir, "run-report.md"),
    final_answer_json_path: join(reportDir, "final-answer.json"),
    final_answer_markdown_path: join(reportDir, "final-answer.md"),
  };
}

export function writeRunReport(options = {}) {
  const report = buildRunReport(options);
  const paths = runReportPaths(options.stateDir, report.run_id || options.runId || "latest");
  writeJsonArtifact(paths.json_path, report);
  writeFileSync(paths.markdown_path, formatRunReportMarkdown(report), "utf8");
  const finalAnswer = buildRunFinalAnswer(report, {
    reportJsonPath: relative(resolve(options.stateDir), paths.json_path),
    reportMarkdownPath: relative(resolve(options.stateDir), paths.markdown_path),
  });
  writeJsonArtifact(paths.final_answer_json_path, finalAnswer);
  writeFileSync(paths.final_answer_markdown_path, formatRunFinalAnswerMarkdown(finalAnswer), "utf8");

  appendStateEvent(options.stateDir, "run.report", {
    run_id: report.run_id,
    status: report.status,
    artifact_type: report.artifact_type,
    report_json: relative(resolve(options.stateDir), paths.json_path),
    report_markdown: relative(resolve(options.stateDir), paths.markdown_path),
    final_answer_json: relative(resolve(options.stateDir), paths.final_answer_json_path),
    final_answer_markdown: relative(resolve(options.stateDir), paths.final_answer_markdown_path),
  }, { source: "run-report" });

  return {
    report,
    final_answer: finalAnswer,
    ...paths,
  };
}
