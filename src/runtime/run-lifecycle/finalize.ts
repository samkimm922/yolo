import {
  cpSync as defaultCpSync,
  existsSync as defaultExistsSync,
  mkdirSync as defaultMkdirSync,
  readdirSync as defaultReaddirSync,
  rmSync as defaultRmSync,
  unlinkSync as defaultUnlinkSync,
} from "node:fs";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { BASELINE_RUNTIME_FILES } from "../execution/baselines.js";
import { cleanupProgressServer } from "./shutdown.js";
import {
  RUN_LIFECYCLE_CLEAN_FINAL_OUTCOMES,
  RUN_LIFECYCLE_CLEAN_STATUSES,
} from "../../lib/status-vocab.js";

const PERSIST_RUNTIME_FILES = new Set([
  "learn-stats.json",
  "condition-stats.json",
  ...BASELINE_RUNTIME_FILES,
  "task-results.jsonl",
  "task-logs",
]);

const RAW_STATE_LOG_FILES = [
  "yolo-output.log",
  "review-log.jsonl",
];

function isSafeWorktreeRoot(worktreeRoot) {
  if (!worktreeRoot) return false;
  const normalized = resolve(worktreeRoot);
  return normalized.split(/[\\/]+/).includes(".yolo-worktrees");
}

export function cleanupWorktreeRoot({
  worktreeRoot,
  existsSync = defaultExistsSync,
  readdirSync = defaultReaddirSync,
  rmSync = defaultRmSync,
} = Object()) {
  if (!isSafeWorktreeRoot(worktreeRoot)) {
    return { skipped: true, reason: "unsafe_worktree_root", removed: [] };
  }
  if (!existsSync(worktreeRoot)) {
    return { skipped: true, reason: "missing_worktree_root", removed: [] };
  }
  let entries = [];
  try {
    entries = readdirSync(worktreeRoot).map((entry) => join(worktreeRoot, entry));
    rmSync(worktreeRoot, { recursive: true, force: true });
    return { skipped: false, removed: entries };
  } catch (error) {
    return { skipped: true, reason: "cleanup_failed", error, removed: entries };
  }
}

export function cleanDirByPattern({
  dir,
  pattern,
  keep = 10,
  exclude = new Set(),
  existsSync = defaultExistsSync,
  readdirSync = defaultReaddirSync,
  unlinkSync = defaultUnlinkSync,
} = Object()) {
  const removed = [];
  if (!existsSync(dir)) return removed;
  const files = readdirSync(dir).filter((file) => file.match(pattern)).sort().reverse();
  const removable = files.filter((file) => !exclude.has(resolve(dir, file)));
  for (const file of removable.slice(keep)) {
    try {
      unlinkSync(join(dir, file));
      removed.push(file);
    } catch (_) {}
  }
  return removed;
}

function archiveStamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function archiveRawRunEvidence({
  stateDir,
  runtimeDir,
  completionStatus = "unknown",
  now = new Date(),
  existsSync = defaultExistsSync,
  readdirSync = defaultReaddirSync,
  mkdirSync = defaultMkdirSync,
  cpSync = defaultCpSync,
} = Object()) {
  if (completionStatus !== "success") {
    return { archived: false, reason: "non_success_run", archived_count: 0 };
  }
  const archiveDir = join(stateDir, "archive", "raw-runtime", archiveStamp(now));
  let archivedCount = 0;
  const copy = (src, dst) => {
    if (!existsSync(src)) return;
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true });
    archivedCount++;
  };

  if (runtimeDir && existsSync(runtimeDir)) {
    for (const file of readdirSync(runtimeDir)) {
      copy(join(runtimeDir, file), join(archiveDir, "runtime", file));
    }
  }
  for (const file of RAW_STATE_LOG_FILES) {
    copy(join(stateDir, file), join(archiveDir, "state", file));
  }

  if (archivedCount === 0) {
    return { archived: false, reason: "no_raw_evidence", archived_count: 0, archive_dir: archiveDir };
  }
  return { archived: true, archived_count: archivedCount, archive_dir: archiveDir };
}

export function cleanupRunArtifacts({
  yoloRoot,
  toolsRoot = yoloRoot,
  projectRoot,
  worktreeRoot = projectRoot ? join(projectRoot, "..", ".yolo-worktrees") : null,
  stateDir,
  runtimeDir,
  prdPath,
  completionStatus = "unknown",
  normalizeRepoPath = (value) => value,
  existsSync = defaultExistsSync,
  readdirSync = defaultReaddirSync,
  mkdirSync = defaultMkdirSync,
  cpSync = defaultCpSync,
  rmSync = defaultRmSync,
  unlinkSync = defaultUnlinkSync,
  spawnSync = defaultSpawnSync,
  consoleLog = (...args) => console.log(...args),
  now = new Date(),
} = Object()) {
  consoleLog("\n[cleanup] 自动清理临时文件...");
  let cleanedCount = 0;
  const rawEvidenceArchive = archiveRawRunEvidence({
    stateDir,
    runtimeDir,
    completionStatus,
    now,
    existsSync,
    readdirSync,
    mkdirSync,
    cpSync,
  });
  if (rawEvidenceArchive.archived) {
    consoleLog(`[cleanup] 原始运行证据已归档: ${rawEvidenceArchive.archive_dir}`);
  }
  const removePath = (filePath) => {
    try {
      if (!existsSync(filePath)) return false;
      rmSync(filePath, { recursive: true, force: true });
      cleanedCount++;
      return true;
    } catch (_) {
      return false;
    }
  };

  try {
    for (const file of readdirSync(yoloRoot)) {
      if (file.startsWith("task-results.bak.")) removePath(join(yoloRoot, file));
    }
    const dataDir = join(yoloRoot, "data");
    if (existsSync(dataDir)) {
      for (const file of readdirSync(dataDir)) {
        if (file.startsWith("task-results.bak.")) removePath(join(dataDir, file));
      }
    }
  } catch (_) {}

  const preserveDebugRuntime = completionStatus !== "success";
  const runtimeKeep = preserveDebugRuntime ? PERSIST_RUNTIME_FILES : new Set();
  try {
    if (existsSync(runtimeDir)) {
      for (const file of readdirSync(runtimeDir)) {
        if (runtimeKeep.has(file)) continue;
        removePath(join(runtimeDir, file));
      }
    }
  } catch (_) {}

  removePath(join(stateDir, "expanded-tasks.json"));
  removePath(join(stateDir, "runner.pid"));
  removePath(join(stateDir, "yolo-output.log"));
  removePath(join(stateDir, "review-log.jsonl"));

  const worktreeCleanup = cleanupWorktreeRoot({ worktreeRoot, existsSync, readdirSync, rmSync });
  if (!worktreeCleanup.skipped) {
    cleanedCount += worktreeCleanup.removed.length;
  }
  consoleLog(`[cleanup] 已清理 ${cleanedCount} 个临时文件`);

  cleanDirByPattern({ dir: runtimeDir, pattern: /^gate-.*\.json$/, keep: 10, existsSync, readdirSync, unlinkSync });
  cleanDirByPattern({
    dir: join(yoloRoot, "data"),
    pattern: /^retry-round.*\.json$/,
    keep: 0,
    exclude: new Set([resolve(prdPath)]),
    existsSync,
    readdirSync,
    unlinkSync,
  });

  try {
    const cleanupScript = join(toolsRoot, "noise-cleanup.js");
    if (!existsSync(cleanupScript)) {
    return { cleanedCount, worktreeCleanup, rawEvidenceArchive };
    }
    const cleanup = spawnSync("node", [
      cleanupScript,
      "--apply",
      `--current-prd=${normalizeRepoPath(prdPath).replace(/^scripts\/yolo\//, "")}`,
    ], {
      cwd: toolsRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cleanupText = (cleanup.stdout || cleanup.stderr || "").trim();
    if (cleanupText) consoleLog(`[cleanup] noise-cleanup: ${cleanupText.split("\n")[0]}`);
    if (cleanup.status !== 0) consoleLog(`[cleanup] noise-cleanup 非阻断失败: ${cleanup.stderr || cleanup.status}`);
  } catch (error) {
    consoleLog(`[cleanup] noise-cleanup 非阻断异常: ${error.message}`);
  }

  return { cleanedCount, worktreeCleanup, rawEvidenceArchive };
}

const RUN_ERROR_STATUSES = new Set(["blocked", "error", "failed", "fail"]);
const STATUS_FIELDS = new Set(["status", "verdict", "outcome"]);

function cleanStatus(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === false) return [];
  return [value];
}

function uniqueValues(values = []) {
  return [...new Set(asArray(values).filter(Boolean))];
}

export function normalizeFinalTaskResults(taskResults = Object()) {
  const completed = uniqueValues(taskResults.completed);
  const mergedInto = uniqueValues(taskResults.merged_into || taskResults.mergedInto);
  const resolved = new Set([...completed, ...mergedInto]);
  const failed = uniqueValues(taskResults.failed).filter((id) => !resolved.has(id));
  const blocked = uniqueValues(taskResults.blocked).filter((id) => !resolved.has(id));
  const skipped = uniqueValues(taskResults.skipped).filter((id) => !resolved.has(id));
  const contractReview = uniqueValues(taskResults.contractReview || taskResults.contract_review).filter((id) => !resolved.has(id));
  return {
    ...taskResults,
    completed,
    failed,
    skipped,
    blocked,
    contractReview,
    contract_review: contractReview,
    merged_into: mergedInto,
  };
}

function countItems(value) {
  if (Array.isArray(value)) return value.filter(Boolean).length;
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : 0;
  if (typeof value === "string") return value.trim() ? 1 : 0;
  if (value instanceof Error) return 1;
  if (value && typeof value === "object") return Object.keys(value).length > 0 ? 1 : 0;
  return value === true ? 1 : 0;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function pushIssue(issues, code, detail, count = 1) {
  if (count <= 0) return;
  issues.push({ code, count, detail });
}

function collectStatusEntries(value, field = "", depth = 0, seen = new Set()) {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectStatusEntries(item, field ? `${field}.${index}` : String(index), depth + 1, seen),
    );
  }
  if (!value || typeof value !== "object" || depth > 20 || seen.has(value)) return [];
  seen.add(value);
  const entries = [];
  for (const [key, child] of Object.entries(value)) {
    const nextField = field ? `${field}.${key}` : key;
    if (nextField.includes("review.historical_issues") || nextField.includes("review.historicalIssues")) {
      continue;
    }
    if (STATUS_FIELDS.has(key)) {
      const status = cleanStatus(child);
      const wrapperStatus = key === "status" &&
        ["completed", "done"].includes(status) &&
        Boolean(value.report || value.result || value.run_report || value.runReport);
      if (status && !wrapperStatus) entries.push({ field: nextField, status });
    }
    if (child && typeof child === "object") {
      entries.push(...collectStatusEntries(child, nextField, depth + 1, seen));
    }
  }
  return entries;
}

function collectDryRunFlags(value, field = "", depth = 0, seen = new Set()) {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectDryRunFlags(item, field ? `${field}.${index}` : String(index), depth + 1, seen),
    );
  }
  if (!value || typeof value !== "object" || depth > 20 || seen.has(value)) return [];
  seen.add(value);
  const flags = [];
  for (const [key, child] of Object.entries(value)) {
    const nextField = field ? `${field}.${key}` : key;
    if ((key === "dry_run" || key === "dryRun") && child === true) flags.push({ field: nextField });
    if (child && typeof child === "object") {
      flags.push(...collectDryRunFlags(child, nextField, depth + 1, seen));
    }
  }
  return flags;
}

function reportStatusValues(report = Object()) {
  return collectStatusEntries(report).map((entry) => entry.status);
}

function reportHasNonCleanStatus(report = Object()) {
  return reportStatusValues(report).some((status) => !RUN_LIFECYCLE_CLEAN_STATUSES.has(status));
}

function pathCount(value) {
  return typeof value === "string" && value.trim() ? 1 : 0;
}

function collectTaskResultStatusIssues(result = Object()) {
  const issues = [];
  const statusEntries = collectStatusEntries(result);
  pushIssue(issues, "RUNNER_RESULT_STATUS_ERROR", "runner result status is not clean", statusEntries.filter((entry) => !RUN_LIFECYCLE_CLEAN_STATUSES.has(entry.status)).length);
  pushIssue(issues, "RUNNER_RESULT_DRY_RUN", "runner result contains dry-run evidence", collectDryRunFlags(result).length);
  pushIssue(issues, "RUNNER_RESULT_ERRORS", "runner result contains errors", countItems(result.error) + countItems(result.errors));
  const reviewOutcomeStatus = cleanStatus(result.review_outcome?.status);
  pushIssue(
    issues,
    "REVIEW_OUTCOME_BLOCKED",
    "review loop outcome blocks finalization",
    reviewOutcomeStatus && !RUN_LIFECYCLE_CLEAN_STATUSES.has(reviewOutcomeStatus) ? 1 : 0,
  );
  return issues;
}

function collectRunArtifactIssues(runReportResult = Object()) {
  const issues = [];
  pushIssue(issues, "RUN_REPORT_ARTIFACT_MISSING", "run report JSON artifact is missing", pathCount(runReportResult.json_path) ? 0 : 1);
  pushIssue(issues, "RUN_REPORT_MARKDOWN_MISSING", "run report markdown artifact is missing", pathCount(runReportResult.markdown_path) ? 0 : 1);
  pushIssue(issues, "FINAL_ANSWER_ARTIFACT_MISSING", "final answer JSON artifact is missing", pathCount(runReportResult.final_answer_json_path) ? 0 : 1);
  pushIssue(issues, "FINAL_ANSWER_MARKDOWN_MISSING", "final answer markdown artifact is missing", pathCount(runReportResult.final_answer_markdown_path) ? 0 : 1);
  return issues;
}

function collectRunReportIssues(runReportResult = Object(), { requireArtifacts = false } = Object()) {
  const issues = [];
  const report = runReportResult.report || runReportResult.run_report || runReportResult.runReport || null;
  const finalAnswer = runReportResult.final_answer || runReportResult.finalAnswer || null;

  pushIssue(issues, "RUN_REPORT_WRITE_ERROR", "run report writer returned an error", countItems(runReportResult.error));
  pushIssue(issues, "RUN_REPORT_WRITE_ERRORS", "run report writer returned errors", countItems(runReportResult.errors));
  if (requireArtifacts) {
    pushIssue(issues, "RUN_REPORT_MISSING", "run report writer did not return a report object", report ? 0 : 1);
    pushIssue(issues, "FINAL_ANSWER_MISSING", "run report writer did not return a final answer object", finalAnswer ? 0 : 1);
    issues.push(...collectRunArtifactIssues(runReportResult));
  }

  if (report) {
    const statusEntries = collectStatusEntries(report);
    pushIssue(issues, "RUN_REPORT_STATUS_ERROR", "run report status is not clean", statusEntries.filter((entry) => !RUN_LIFECYCLE_CLEAN_STATUSES.has(entry.status)).length);
    pushIssue(issues, "RUN_REPORT_DRY_RUN", "run report contains dry-run evidence", collectDryRunFlags(report).length);
    pushIssue(issues, "RUN_REPORT_ERRORS", "run report contains errors", countItems(report.errors) + countItems(report.error));
    pushIssue(issues, "EVIDENCE_FAILURES", "run report contains evidence failures", positiveNumber(report.summary?.evidence_failures ?? report.evidence_failure_count ?? report.evidence_failures));
    pushIssue(issues, "REVIEW_ISSUES", "run report contains review issues", positiveNumber(report.review?.issue_count));
    pushIssue(issues, "REVIEW_ERRORS", "run report contains review errors", positiveNumber(report.review?.error_count));
    pushIssue(issues, "GATE_FAILURES", "run report contains gate failures", positiveNumber(report.gates?.failed_count));
    pushIssue(issues, "FIXTURE_FAILURES", "run report contains fixture failures", positiveNumber(report.fixtures?.fail_count));
    pushIssue(issues, "SPEC_GOVERNANCE_BLOCKED", "run report contains spec governance blockers", positiveNumber(report.spec_governance?.blocked_count));
    pushIssue(issues, "HUMAN_REMEDIATION_REQUIRED", "run report requires human remediation", positiveNumber(report.remediation?.human_required_count));
    pushIssue(issues, "UNSAFE_REMEDIATION_STOP", "run report contains unsafe remediation stops", positiveNumber(report.remediation?.unsafe_stop_count));
    pushIssue(issues, "EVIDENCE_ERRORS", "run report evidence contains errors", countItems(report.evidence?.errors) + positiveNumber(report.evidence?.error_count));
    pushIssue(issues, "EVIDENCE_FAILURE_COUNT", "run report evidence contains failures", positiveNumber(report.evidence?.failure_count ?? report.evidence?.failed_count));
  }

  if (finalAnswer) {
    const status = cleanStatus(finalAnswer.status);
    const outcome = cleanStatus(finalAnswer.outcome);
    const finalAnswerStatusEntries = collectStatusEntries(finalAnswer);
    pushIssue(issues, "FINAL_ANSWER_STATUS_ERROR", "final answer status is not clean", status && !RUN_LIFECYCLE_CLEAN_STATUSES.has(status) ? 1 : 0);
    pushIssue(issues, "FINAL_ANSWER_NEEDS_ATTENTION", "final answer outcome needs attention", outcome && !RUN_LIFECYCLE_CLEAN_FINAL_OUTCOMES.has(outcome) ? 1 : 0);
    pushIssue(issues, "FINAL_ANSWER_NESTED_STATUS_ERROR", "final answer contains nested non-clean status", finalAnswerStatusEntries.filter((entry) => !RUN_LIFECYCLE_CLEAN_STATUSES.has(entry.status) && entry.field !== "outcome").length);
    pushIssue(issues, "FINAL_ANSWER_DRY_RUN", "final answer contains dry-run evidence", collectDryRunFlags(finalAnswer).length);
    pushIssue(issues, "FINAL_ANSWER_BLOCKERS", "final answer contains blockers", countItems(finalAnswer.blockers));
    pushIssue(
      issues,
      "FINAL_ANSWER_CHECK_FAILURES",
      "final answer contains non-pass checks",
      asArray(finalAnswer.checks).filter((check) => !RUN_LIFECYCLE_CLEAN_STATUSES.has(cleanStatus(check?.status))).length,
    );
  }

  return issues;
}

function collectSkippedIssues(result = Object()) {
  const skipped = asArray(result.skipped);
  const abnormal = skipped.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const status = cleanStatus(item.status || item.result?.status || item.skip_status);
    const skipKind = cleanStatus(item.skip_kind || item.skipKind || item.reason);
    return RUN_ERROR_STATUSES.has(status) ||
      item.error ||
      item.errors ||
      item.counts_as_completed === false ||
      skipKind.includes("blocked") ||
      skipKind.includes("invalid") ||
      skipKind.includes("error");
  });
  return abnormal.length +
    positiveNumber(result.skipped_error_count ?? result.skipped_errors_count) +
    countItems(result.skipped_errors ?? result.invalid_skipped);
}

function verdictSummary(issues = []) {
  return issues.map((issue) => `${issue.code}=${issue.count}`).join(", ");
}

export function buildRunFinalVerdict({
  taskResults = Object(),
  runReportResult = Object(),
  failOnSkippedIssues = false,
  requireRunArtifacts = false,
} = Object()) {
  taskResults = normalizeFinalTaskResults(taskResults);
  const issues = [];
  const failedCount = asArray(taskResults.failed).length;
  const blockedCount = asArray(taskResults.blocked).length;
  const contractReviewCount = asArray(taskResults.contractReview || taskResults.contract_review).length;

  issues.push(...collectTaskResultStatusIssues(taskResults));
  pushIssue(issues, "FAILED_TASKS", "runner has failed tasks", failedCount);
  pushIssue(issues, "BLOCKED_TASKS", "runner has blocked tasks", blockedCount);
  pushIssue(issues, "CONTRACT_REVIEW_TASKS", "runner has tasks pending contract review", contractReviewCount);
  if (failOnSkippedIssues) {
    pushIssue(issues, "SKIPPED_TASK_ERRORS", "runner has abnormal skipped tasks", collectSkippedIssues(taskResults));
  }
  issues.push(...collectRunReportIssues(runReportResult, { requireArtifacts: requireRunArtifacts && issues.length === 0 }));

  return {
    status: issues.length === 0 ? "success" : "error",
    exit_code: issues.length === 0 ? 0 : 1,
    summary: issues.length === 0 ? "runner completed" : `runner failed closed: ${verdictSummary(issues)}`,
    issues,
  };
}

export function buildRunReturnResult({
  runId,
  prdPath,
  taskResults,
  runReportResult,
  normalizeRepoPath = (value) => value,
} = Object()) {
  taskResults = normalizeFinalTaskResults(taskResults);
  const finalVerdict = buildRunFinalVerdict({ taskResults, runReportResult, requireRunArtifacts: true });
  const exitCode = finalVerdict.exit_code;
  const contractReview = taskResults.contractReview || taskResults.contract_review || [];
  return {
    status: finalVerdict.status,
    summary: finalVerdict.summary,
    exit_code: exitCode,
    run_id: runId,
    prd: prdPath,
    completed: taskResults.completed,
    failed: taskResults.failed,
    skipped: taskResults.skipped,
    blocked: taskResults.blocked || [],
    contract_review: contractReview,
    remediation: taskResults.remediation || [],
    immediate_remediation_queue: taskResults.immediateRemediationQueue || [],
    final_verdict: finalVerdict,
    report_file: normalizeRepoPath(runReportResult.json_path),
    report_markdown: normalizeRepoPath(runReportResult.markdown_path),
    ...(runReportResult.final_answer_json_path ? { final_answer_file: normalizeRepoPath(runReportResult.final_answer_json_path) } : {}),
    ...(runReportResult.final_answer_markdown_path ? { final_answer_markdown: normalizeRepoPath(runReportResult.final_answer_markdown_path) } : {}),
  };
}

export function printRunReportSummary({
  taskResults,
  progressTotal,
  elapsed,
  reportSummary = Object(),
  runReportResult,
  normalizeRepoPath = (value) => value,
  consoleLog = (...args) => console.log(...args),
} = Object()) {
  const totalTasks = taskResults.completed.length + taskResults.failed.length;
  const taskSuccessRate = reportSummary.task_success_rate == null ? "N/A" : `${reportSummary.task_success_rate.toFixed(1)}%`;
  const runSuccessRate = reportSummary.run_success_rate == null ? "N/A" : `${reportSummary.run_success_rate.toFixed(1)}%`;
  consoleLog(`task_success_rate: ${taskSuccessRate} (${taskResults.completed.length}/${totalTasks})`);
  consoleLog(`run_success_rate: ${runSuccessRate} (${taskResults.completed.length}/${progressTotal})`);
  consoleLog(`\n=== 最终报告 ===\n完成: ${taskResults.completed.length} | 失败: ${taskResults.failed.length} | 耗时: ${elapsed}s`);
  if (taskResults.completed.length) consoleLog(`ok ${taskResults.completed.join(", ")}`);
  if (taskResults.failed.length) consoleLog(`FAIL ${taskResults.failed.join(", ")}`);
  consoleLog(`report_json: ${normalizeRepoPath(runReportResult.json_path)}`);
  consoleLog(`report_markdown: ${normalizeRepoPath(runReportResult.markdown_path)}`);
  if (runReportResult.final_answer_markdown_path) {
    consoleLog(`final_answer_markdown: ${normalizeRepoPath(runReportResult.final_answer_markdown_path)}`);
  }
}

export async function finalizeRun({
  runId,
  prdPath,
  taskResults,
  progressTotal,
  startTimeMs,
  projectRoot,
  stateDir,
  runtimeDir,
  yoloRoot,
  toolsRoot = yoloRoot,
  exitOnComplete,
  writeRunReport,
  logRun,
  logProgress,
  writeStateSnapshot,
  archiveCurrentRun,
  normalizeRepoPath,
  progressServerProc = null,
  processExit = process.exit,
  processKill = process.kill,
  spawnSync = defaultSpawnSync,
  consoleLog = (...args) => console.log(...args),
  now = () => new Date(),
} = Object()) {
  const elapsed = ((Date.now() - startTimeMs) / 1000).toFixed(1);
  const finalTaskResults = normalizeFinalTaskResults(taskResults);
  logRun("run_end", {
    run_id: runId,
    prd: prdPath || "auto",
    passed: finalTaskResults.completed.length,
    failed: finalTaskResults.failed.length,
    duration_sec: elapsed,
  });
  const runReportResult = writeRunReport({
    stateDir,
    runId,
    prdPath,
    taskResults: finalTaskResults,
    progressTotal,
    startedAt: new Date(startTimeMs).toISOString(),
    finishedAt: now().toISOString(),
    durationSec: elapsed,
    taskLogsDir: join(runtimeDir, "task-logs"),
  });
  printRunReportSummary({
    taskResults: finalTaskResults,
    progressTotal,
    elapsed,
    reportSummary: runReportResult.report?.summary || {},
    runReportResult,
    normalizeRepoPath,
    consoleLog,
  });
  writeStateSnapshot("run_end", prdPath);
  archiveCurrentRun(runId, finalTaskResults);
  logProgress("RUN", runId, "archived");
  await cleanupProgressServer(progressServerProc, { processKill });
  const result = buildRunReturnResult({ runId, prdPath, taskResults: finalTaskResults, runReportResult, normalizeRepoPath });
  cleanupRunArtifacts({
    yoloRoot,
    toolsRoot,
    projectRoot,
    stateDir,
    runtimeDir,
    prdPath,
    completionStatus: result.status,
    normalizeRepoPath,
    spawnSync,
    consoleLog,
  });
  if (exitOnComplete) processExit(result.exit_code);
  return result;
}
