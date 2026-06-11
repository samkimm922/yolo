import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  appendStateEvent,
  buildEvidenceArtifact,
  validateLedgerChain,
  writeJsonArtifact,
} from "./ledger.js";
import { verifyArtifactIntegrity } from "./artifact-integrity.js";
import { normalizeReviewFinding } from "../../review/findings.js";

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function walkJsonlFiles(dir, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonlFiles(path, files);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

function archiveLedgerName(file) {
  const lower = basename(String(file || "")).toLowerCase();
  if (lower.includes("runs")) return "run";
  if (lower.includes("events")) return "state";
  return "";
}

function archivedLedgerHashes(stateDir) {
  const hashes = {
    run: new Set(),
    state: new Set(),
    errors: [],
  };
  if (!stateDir) return hashes;
  for (const file of walkJsonlFiles(join(stateDir, "archive", "jsonl"))) {
    for (const record of readJsonl(file)) {
      const ledger = archiveLedgerName(file);
      const recordLedger = record?.ledger;
      if (ledger && (recordLedger === "run" || recordLedger === "state") && recordLedger !== ledger) {
        hashes.errors.push({
          code: "ARCHIVE_LEDGER_MISMATCH",
          file: relative(resolve(stateDir), file),
          file_ledger: ledger,
          record_ledger: recordLedger,
          record_hash: record?.record_hash || null,
        });
        continue;
      }
      if (record?.record_hash && hashes[ledger]) hashes[ledger].add(record.record_hash);
    }
  }
  return hashes;
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

const RUN_REPORT_PASS_STATUSES = new Set(["pass", "success"]);

function cleanStatus(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}

function reportStatus({ failed = [], blocked = [], evidenceFailures = 0, plannedCount = null, terminalCount = 0 } = Object()) {
  return failed.length > 0 ||
    blocked.length > 0 ||
    evidenceFailures > 0 ||
    (plannedCount != null && plannedCount <= 0) ||
    terminalCount <= 0
    ? "error"
    : "success";
}

function itemList(values = [], limit = 8) {
  const items = unique(values).slice(0, limit);
  const remaining = Math.max(0, unique(values).length - items.length);
  return remaining > 0 ? [...items, `+${remaining} more`] : items;
}

function taskId(entry = Object()) {
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
    blocked_count: runs.filter((entry) => entry.status === "blocked").length,
    degraded_count: runs.filter((entry) => entry.status === "degraded").length,
    runs: runs.slice(-20),
  };
}

function validateLedgerChainWithArchive(records = [], archiveHashes = new Set()) {
  const externalHead = records[0]?.prev_hash || null;
  const allowExternalHead = Boolean(externalHead && archiveHashes.has(externalHead));
  return {
    ...validateLedgerChain(records, { allowExternalHead }),
    external_head: externalHead,
    external_head_allowed: allowExternalHead,
  };
}

function summarizeLedgerIntegrity({ runs = [], events = [], stateDir = "" } = Object()) {
  const archiveHashes = archivedLedgerHashes(stateDir);
  const runChain = validateLedgerChainWithArchive(runs, archiveHashes.run);
  const stateChain = validateLedgerChainWithArchive(events, archiveHashes.state);
  const archiveErrors = archiveHashes.errors || [];
  const errorCount = runChain.errors.length + stateChain.errors.length + archiveErrors.length;
  return {
    status: errorCount === 0 ? "pass" : "fail",
    error_count: errorCount,
    archive_errors: archiveErrors.slice(0, 10),
    run_chain: {
      status: runChain.status,
      checked_count: runChain.checked_count,
      head_hash: runChain.head_hash,
      external_head: runChain.external_head,
      external_head_allowed: runChain.external_head_allowed,
      error_count: runChain.errors.length,
      errors: runChain.errors.slice(0, 10),
    },
    state_chain: {
      status: stateChain.status,
      checked_count: stateChain.checked_count,
      head_hash: stateChain.head_hash,
      external_head: stateChain.external_head,
      external_head_allowed: stateChain.external_head_allowed,
      error_count: stateChain.errors.length,
      errors: stateChain.errors.slice(0, 10),
    },
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
  gates = Object(),
  review = Object(),
  fixtures = Object(),
  specGovernance = Object(),
  remediation = Object(),
  ledgerIntegrity = Object(),
  failed = [],
  blocked = [],
} = Object()) {
  const representedTaskFailures = new Set([...failed, ...blocked]);
  const gateTasks = unique(gates.failed_tasks || []);
  const unrepresentedGateTasks = gateTasks.filter((id) => !representedTaskFailures.has(id)).length;
  const unassignedGateFailures = (gates.failures || []).filter((failure) => !failure.task_id).length;
  return unrepresentedGateTasks +
    unassignedGateFailures +
    (review.issue_count || 0) +
    (review.error_count || 0) +
    (fixtures.fail_count || 0) +
    (fixtures.blocked_count || 0) +
    (specGovernance.blocked_count || 0) +
    (remediation.human_required_count || 0) +
    (remediation.unsafe_stop_count || 0) +
    (ledgerIntegrity.error_count || 0);
}

function summarizeRemediation({ taskResults = Object(), stateEvents = [] } = Object()) {
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
  const action_counts = Object();
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
  taskResults = Object(),
  progressTotal = null,
  startedAt = null,
  finishedAt = new Date().toISOString(),
  durationSec = null,
  taskLogsDir = null,
} = Object()) {
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
  const ledgerIntegrity = summarizeLedgerIntegrity({ runs, events, stateDir });

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
    ledgerIntegrity,
    failed,
    blocked,
  });
  const runRateDenominator = plannedCount == null ? plannedCount : plannedCount + evidenceFailures;

  return buildEvidenceArtifact("run.report", {
    run_id: runId || runStart?.run_id || runEnd?.run_id || null,
    prd: prdPath || runStart?.prd || runEnd?.prd || null,
    status: reportStatus({ failed, blocked, evidenceFailures, plannedCount, terminalCount }),
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
      integrity: ledgerIntegrity,
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
    `- Blocked: ${report.fixtures?.blocked_count || 0}`,
    `- Degraded: ${report.fixtures?.degraded_count || 0}`,
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

export function buildRunFinalAnswer(report = Object(), options = Object()) {
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
  const fixtureFailures = (report.fixtures?.fail_count || 0) + (report.fixtures?.blocked_count || 0);
  const remediationItems = report.remediation?.item_count || 0;
  const remediationHuman = report.remediation?.human_required_count || 0;
  const remediationUnsafe = report.remediation?.unsafe_stop_count || 0;
  const ledgerIntegrityErrors = report.ledger?.integrity?.error_count || 0;
  const planned = summary.planned == null ? null : Number(summary.planned);
  const terminalCount = completed.length + failed.length + blocked.length;
  const status = report.status || (failed.length || blocked.length ? "error" : "success");
  const fixtureRunCount = Number(report.fixtures?.run_count || 0);
  const fixtureStatus = cleanStatus(report.fixtures?.status);
  const fixtureDegraded = Number(report.fixtures?.degraded_count || 0);
  const hasFixtureEvidence = Boolean(fixtureStatus) || fixtureRunCount > 0 || fixtureFailures > 0 || fixtureDegraded > 0;
  const fixtureCheckStatus = fixtureFailures > 0
    ? "fail"
    : fixtureStatus || (fixtureRunCount > 0 ? "pass" : "not_run");
  const baseBlockerLines = [
    ...(!RUN_REPORT_PASS_STATUSES.has(cleanStatus(status)) ? [`run report status is ${status}`] : []),
    ...(planned != null && planned <= 0 ? ["no planned task evidence"] : []),
    ...(planned != null && terminalCount <= 0 ? ["no terminal task evidence"] : []),
    ...(failed.length ? [`failed tasks: ${itemList(failed).join(", ")}`] : []),
    ...(blocked.length ? [`blocked tasks: ${itemList(blocked).join(", ")}`] : []),
    ...(gateFailures ? [`failed gates: ${gateFailures}`] : []),
    ...(reviewIssues ? [`review issues: ${reviewIssues}`] : []),
    ...(reviewErrors ? [`review errors: ${reviewErrors}`] : []),
    ...(specBlocked ? [`spec governance blocked events: ${specBlocked}`] : []),
    ...(report.spec_governance?.warning_count ? [`spec governance warnings: ${report.spec_governance.warning_count}`] : []),
    ...(fixtureFailures ? [`fixture failures: ${fixtureFailures}`] : []),
    ...(ledgerIntegrityErrors ? [`evidence ledger integrity errors: ${ledgerIntegrityErrors}`] : []),
    ...(remediationHuman ? [`human remediation required: ${remediationHuman}`] : []),
    ...(remediationUnsafe ? [`unsafe remediation stop: ${remediationUnsafe}`] : []),
  ];

  const checks = [
    {
      name: "tasks",
      status: failed.length || blocked.length ? "fail" : planned != null && (planned <= 0 || terminalCount <= 0) ? "not_run" : "pass",
      detail: `planned=${planned == null ? "unknown" : planned} completed=${completed.length} failed=${failed.length} skipped=${skipped.length} blocked=${blocked.length}`,
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
    ...(hasFixtureEvidence ? [
    {
      name: "fixtures",
      status: fixtureCheckStatus,
      detail: `runs=${report.fixtures?.run_count || 0} fail=${report.fixtures?.fail_count || 0} blocked=${report.fixtures?.blocked_count || 0} degraded=${report.fixtures?.degraded_count || 0}`,
    },
    ] : []),
    {
      name: "evidence_integrity",
      status: ledgerIntegrityErrors > 0 ? "fail" : "pass",
      detail: `ledger_errors=${ledgerIntegrityErrors}`,
    },
    {
      name: "spec_governance",
      status: specBlocked > 0 ? "fail" : ((report.spec_governance?.warning_count || 0) > 0 ? "warning" : "pass"),
      detail: `blocked=${specBlocked} warnings=${report.spec_governance?.warning_count || 0}`,
    },
  ];
  const checkBlockers = checks
    .filter((check) => !RUN_REPORT_PASS_STATUSES.has(cleanStatus(check.status)))
    .map((check) => `${check.name} check is ${check.status}: ${check.detail}`);
  const blockerLines = unique([...baseBlockerLines, ...checkBlockers]);

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
    outcome: status === "success" && blockerLines.length === 0 ? "success" : "needs_attention",
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

export function formatRunFinalAnswerMarkdown(finalAnswerOrReport = Object(), options = Object()) {
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

export function writeRunReport(options = Object()) {
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
  const artifactIntegrity = verifyArtifactIntegrity([
    paths.json_path,
    paths.markdown_path,
    paths.final_answer_json_path,
    paths.final_answer_markdown_path,
  ], { rootDir: options.stateDir });

  appendStateEvent(options.stateDir, "run.report", {
    run_id: report.run_id,
    status: report.status,
    artifact_type: report.artifact_type,
    report_json: relative(resolve(options.stateDir), paths.json_path),
    report_markdown: relative(resolve(options.stateDir), paths.markdown_path),
    final_answer_json: relative(resolve(options.stateDir), paths.final_answer_json_path),
    final_answer_markdown: relative(resolve(options.stateDir), paths.final_answer_markdown_path),
    artifact_integrity: artifactIntegrity,
  }, { source: "run-report" });

  return {
    report,
    final_answer: finalAnswer,
    artifact_integrity: artifactIntegrity,
    ...paths,
  };
}
