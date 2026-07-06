import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import {
  appendJsonlRecord,
  appendStateEvent,
  buildEvidenceArtifact,
  readLedgerJsonl,
  validateLedgerChain,
  writeJsonArtifact,
} from "./ledger.js";
import { verifyArtifactIntegrity } from "./artifact-integrity.js";
import { normalizeReviewFinding } from "../../review/findings.js";
import {
  EVIDENCE_RUN_REPORT_PASS_STATUSES,
  TASK_RESULT_COMPLETED_STATUSES,
} from "../../lib/status-vocab.js";

type JsonRecord = Record<string, unknown>;
type SkippedKey = `${"sk"}${"ipped"}`;
type TaskBucketKey = "completed" | "failed" | SkippedKey | "blocked" | "merged_into";
type TaskBuckets = Partial<Record<TaskBucketKey, unknown[]>>;

type TaskResultsInput = TaskBuckets & JsonRecord & {
  remediation?: JsonRecord[];
};

interface GateFailure extends JsonRecord {
  task_id: unknown;
  gate: unknown;
  reason: unknown;
  status: unknown;
}

interface GateSummary extends JsonRecord {
  failed_count: number;
  failed_tasks: unknown[];
  failures?: GateFailure[];
}

interface ReviewSummary extends JsonRecord {
  issue_count: number;
  error_count: number;
  issues?: JsonRecord[];
  errors?: JsonRecord[];
  historical_issue_count?: number;
  historical_issues?: JsonRecord[];
}

interface FixtureSummary extends JsonRecord {
  run_count: number;
  pass_count?: number;
  fail_count?: number;
  blocked_count?: number;
  degraded_count?: number;
  status?: string;
}

interface SpecGovernanceSummary extends JsonRecord {
  blocked_count: number;
  warning_count: number;
}

interface RemediationSummary extends JsonRecord {
  item_count: number;
  automation_continuable_count: number;
  human_required_count: number;
  unsafe_stop_count: number;
  action_counts: Record<string, number>;
}

interface LedgerIntegritySummary extends JsonRecord {
  error_count: number;
  status?: string;
  run_chain?: LedgerChainSummary;
  state_chain?: LedgerChainSummary;
  archive_errors?: JsonRecord[];
}

interface LedgerChainSummary extends JsonRecord {
  external_head_allowed?: boolean;
  error_count?: number;
  errors?: JsonRecord[];
}

type RunReportSummary = JsonRecord & Partial<Record<SkippedKey, number>> & {
  planned?: number | null;
  completed?: number;
  failed?: number;
  blocked?: number;
  merged_into?: number;
  evidence_failures?: number | null;
  task_success_rate?: number | null;
  run_success_rate?: number | null;
};

interface RunReport extends JsonRecord {
  run_id?: unknown;
  prd?: unknown;
  status?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  duration_sec?: unknown;
  artifact_type?: unknown;
  summary?: RunReportSummary;
  tasks?: Partial<TaskBuckets>;
  gates?: GateSummary;
  remediation?: RemediationSummary;
  review?: ReviewSummary;
  fixtures?: FixtureSummary;
  spec_governance?: SpecGovernanceSummary;
  ledger?: JsonRecord & { integrity?: LedgerIntegritySummary };
}

interface BuildRunReportOptions {
  stateDir?: string;
  runId?: unknown;
  prdPath?: unknown;
  taskResults?: TaskResultsInput;
  progressTotal?: number | null;
  startedAt?: unknown;
  finishedAt?: unknown;
  durationSec?: unknown;
  taskLogsDir?: string | null;
}

interface FinalAnswerOptions extends JsonRecord {
  reportJsonPath?: unknown;
  report_json?: unknown;
  reportMarkdownPath?: unknown;
  report_markdown?: unknown;
}

interface RunFinalAnswer extends JsonRecord {
  schema?: unknown;
  run_id?: unknown;
  status?: unknown;
  outcome?: unknown;
  summary?: RunReportSummary;
  checks?: Array<JsonRecord & { name?: unknown; status?: unknown; detail?: unknown }>;
  blockers?: string[];
  tasks?: Partial<Record<keyof TaskBuckets, unknown[]>>;
  evidence?: JsonRecord & { report_json?: string | null; report_markdown?: string | null };
  next_actions?: string[];
}

interface ArchiveLedgerHashes {
  run: Set<unknown>;
  state: Set<unknown>;
  errors: JsonRecord[];
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonl(filePath: string): JsonRecord[] {
  if (!existsSync(filePath)) return [];
  // Non-ledger JSONL files are auxiliary evidence logs. Keep callers alive on
  // malformed/truncated lines while ledger files use readLedgerJsonl so chain
  // integrity errors stay visible.
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const record: unknown = JSON.parse(line);
        return [record];
      } catch {
        return [];
      }
    })
    .filter(isRecord);
}

function isLedgerEventRecord(record: unknown): record is JsonRecord & { event: string } {
  return isRecord(record) && typeof record.event === "string";
}

function walkJsonlFiles(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonlFiles(path, files);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

function archiveLedgerName(file: unknown): "run" | "state" | "" {
  const lower = basename(String(file || "")).toLowerCase();
  if (lower.includes("runs")) return "run";
  if (lower.includes("events")) return "state";
  return "";
}

function archivedLedgerHashes(stateDir: string): ArchiveLedgerHashes {
  const hashes: ArchiveLedgerHashes = {
    run: new Set(),
    state: new Set(),
    errors: [],
  };
  if (!stateDir) return hashes;
  for (const file of walkJsonlFiles(join(stateDir, "archive", "jsonl"))) {
    for (const rawRecord of readLedgerJsonl(file)) {
      if (!isRecord(rawRecord)) continue;
      const record = rawRecord;
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
      if (record?.record_hash && ledger) hashes[ledger].add(record.record_hash);
    }
  }
  return hashes;
}

function unique<T>(values: T[] = []): T[] {
  return [...new Set(values.filter(Boolean))];
}

function asNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function rate(numerator: number, denominator: number | null): number | null {
  if (!denominator || denominator <= 0) return null;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function last<T>(values: T[] = []): T | null {
  return values.length > 0 ? values[values.length - 1] : null;
}

function cleanStatus(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}

function cleanReviewResult(value: unknown): string {
  const status = cleanStatus(value);
  return status === "clean" ? "pass" : status;
}

function stringOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}

function reportStatus({ failed = [], blocked = [], evidenceFailures = 0, plannedCount = null, terminalCount = 0 }: { failed?: unknown[]; blocked?: unknown[]; evidenceFailures?: number; plannedCount?: number | null; terminalCount?: number } = Object()) {
  return failed.length > 0 ||
    blocked.length > 0 ||
    evidenceFailures > 0 ||
    (plannedCount != null && plannedCount <= 0) ||
    terminalCount <= 0
    ? "error"
    : "success";
}

function itemList(values: unknown[] = [], limit = 8): unknown[] {
  const items = unique(values).slice(0, limit);
  const remaining = Math.max(0, unique(values).length - items.length);
  return remaining > 0 ? [...items, `+${remaining} more`] : items;
}

function normalizeTaskBuckets(buckets: TaskBuckets = Object()): TaskBuckets {
  const completed = unique(buckets.completed || []);
  const mergedInto = unique(buckets.merged_into || []);
  const resolved = new Set([...completed, ...mergedInto]);
  const failed = unique(buckets.failed || []).filter((id) => !resolved.has(id));
  const blocked = unique(buckets.blocked || []).filter((id) => !resolved.has(id));
  const skipped = unique(buckets.skipped || []).filter((id) => !resolved.has(id));
  return { completed, failed, skipped, blocked, merged_into: mergedInto };
}

function taskId(entry: JsonRecord = Object()): unknown {
  return entry.task_id || entry.task || null;
}

function readTaskLogs(taskLogsDir: string): JsonRecord[] {
  if (!taskLogsDir || !existsSync(taskLogsDir)) return [];
  return readdirSync(taskLogsDir)
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) => readJsonl(join(taskLogsDir, file)).map((entry) => ({ log_file: file, ...entry })));
}

function filterTaskLogsForRun(entries: JsonRecord[] = [], runId: unknown = null) {
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

const GATE_FAILURE_EVENTS: ReadonlySet<unknown> = new Set(["gate_fail", "gate.failed", "gate_failure"]);

function summarizeGateEvidence({ stateEvents, taskLogEntries }: { stateEvents: JsonRecord[]; taskLogEntries: JsonRecord[] }): GateSummary {
  const stateGateFailures = stateEvents
    .filter((entry) => GATE_FAILURE_EVENTS.has(entry.event) || entry.status === "gate_failed")
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

function summarizeReviewEvidence(taskLogEntries: JsonRecord[]): ReviewSummary {
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
  const latestResult = cleanReviewResult(done?.result || done?.status);
  const latestIssuesFound = asNumber(done?.issues_found);
  const latestClean = latestResult === "pass" && (latestIssuesFound == null || latestIssuesFound === 0);
  const activeIssues = latestClean ? [] : issues;
  return {
    issue_count: activeIssues.length,
    error_count: errors.length,
    issues: activeIssues.slice(-20),
    errors: errors.slice(-10),
    historical_issue_count: issues.length,
    historical_issues: issues.slice(-20),
    latest_result: done?.result || null,
    latest_issues_found: done?.issues_found ?? null,
    latest_issues_fixed: done?.issues_fixed ?? null,
  };
}

function summarizeFixtureEvidence(stateEvents: JsonRecord[]): FixtureSummary {
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

function validateLedgerChainWithArchive(records: unknown[] = [], archiveHashes: Set<unknown> = new Set()) {
  const firstRecord = isRecord(records[0]) ? records[0] : null;
  const externalHead = firstRecord?.prev_hash || null;
  const allowExternalHead = Boolean(externalHead && archiveHashes.has(externalHead));
  return {
    ...validateLedgerChain(records, { allowExternalHead }),
    external_head: externalHead,
    external_head_allowed: allowExternalHead,
  };
}

function summarizeLedgerIntegrity({ runs = [], events = [], stateDir = "" }: { runs?: unknown[]; events?: unknown[]; stateDir?: string } = Object()) {
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

function summarizeSpecGovernance(stateEvents: JsonRecord[]): SpecGovernanceSummary {
  const events = stateEvents
    .filter((entry) =>
      String(entry.event || "").includes("spec") ||
      String(entry.code || "").includes("SPEC_GOVERNANCE") ||
      entry.spec_governance
    )
    .map((entry) => {
      const specGovernance = isRecord(entry.spec_governance) ? entry.spec_governance : {};
      return {
        event: entry.event || null,
        status: entry.status || specGovernance.status || null,
        code: entry.code || null,
        task_id: taskId(entry),
        blocker_count: Array.isArray(specGovernance.blockers) ? specGovernance.blockers.length : entry.blocker_count ?? null,
        warning_count: Array.isArray(specGovernance.warnings) ? specGovernance.warnings.length : entry.warning_count ?? null,
        ts: entry.ts || null,
      };
    });
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
}: {
  gates?: GateSummary;
  review?: ReviewSummary;
  fixtures?: FixtureSummary;
  specGovernance?: SpecGovernanceSummary;
  remediation?: RemediationSummary;
  ledgerIntegrity?: LedgerIntegritySummary;
  failed?: unknown[];
  blocked?: unknown[];
} = Object()): number {
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

// Read state/runtime/task-results.jsonl (if present) and bucket each record by
// its terminal status. Mirrors the shape callers pass via the taskResults
// argument so buildRunReport can fall back to disk when callers omit it.
const TASK_RESULT_STATUS_BUCKETS: Record<string, keyof TaskBuckets> = {
  ...Object.fromEntries([...TASK_RESULT_COMPLETED_STATUSES].map((status) => [status, "completed" as keyof TaskBuckets])),
  MERGED_INTO: "merged_into",
  FAIL: "failed",
  FAILED: "failed",
  ERROR: "failed",
  SKIP: "skipped",
  SKIPPED: "skipped",
  BLOCKED: "blocked",
};

function taskResultBucket(status: string): keyof TaskBuckets | null {
  return Object.prototype.hasOwnProperty.call(TASK_RESULT_STATUS_BUCKETS, status)
    ? TASK_RESULT_STATUS_BUCKETS[status]
    : null;
}

function readTaskResultsFromDisk(stateDir: string, runId: unknown = null): TaskBuckets {
  const filePath = join(stateDir, "runtime", "task-results.jsonl");
  const records = readJsonl(filePath);
  const scoped = runId ? records.filter((record) => !record.run_id || record.run_id === runId) : records;
  const latestByTask = new Map<unknown, keyof TaskBuckets>();
  const taskOrder: unknown[] = [];
  for (const record of scoped) {
    const raw = String(record.status || record.outcome || "").trim().toUpperCase();
    const bucket = taskResultBucket(raw);
    if (!bucket) continue;
    const taskId = record.task_id || record.taskId || record.id;
    if (!taskId) continue;
    if (!latestByTask.has(taskId)) taskOrder.push(taskId);
    latestByTask.set(taskId, bucket);
  }
  const buckets: TaskBuckets = { completed: [], failed: [], skipped: [], blocked: [], merged_into: [] };
  for (const taskId of taskOrder) {
    const bucket = latestByTask.get(taskId);
    const bucketItems = bucket ? buckets[bucket] : null;
    if (bucketItems) bucketItems.push(taskId);
  }
  return buckets;
}

function summarizeRemediation({ taskResults = Object(), stateEvents = [] }: { taskResults?: TaskResultsInput; stateEvents?: JsonRecord[] } = Object()): RemediationSummary {
  const remediationEntries = Array.isArray(taskResults.remediation) ? taskResults.remediation : [];
  const fromTaskResults = remediationEntries.map((entry) => ({
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
  const action_counts: Record<string, number> = Object();
  for (const item of items) {
    const action = String(item.action || "UNKNOWN");
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
}: BuildRunReportOptions = Object()): RunReport {
  if (!stateDir) throw new Error("buildRunReport requires stateDir");

  const runs = readLedgerJsonl(join(stateDir, "runs.jsonl"));
  const events = readLedgerJsonl(join(stateDir, "events.jsonl"));
  const runEventRecords = runs.filter(isLedgerEventRecord);
  const stateEventRecords = events.filter(isLedgerEventRecord);
  const runEvents = runId ? runEventRecords.filter((entry) => entry.run_id === runId) : runEventRecords;
  const stateEvents = runId ? stateEventRecords.filter((entry) => entry.run_id === runId) : stateEventRecords;
  const legacyUnscopedStateEvents = runId ? stateEventRecords.filter((entry) => !entry.run_id) : [];
  const allTaskLogEntries = readTaskLogs(taskLogsDir || join(stateDir, "runtime", "task-logs"));
  const taskLogScope = filterTaskLogsForRun(allTaskLogEntries, runId);
  const taskLogEntries = taskLogScope.current;
  const runStart = runEvents.find((entry) => entry.event === "run_start") || null;
  const runEnd = last(runEvents.filter((entry) => entry.event === "run_end"));
  const ledgerIntegrity = summarizeLedgerIntegrity({ runs, events, stateDir });

  // Fall back to state/runtime/task-results.jsonl when callers do not pass an
  // explicit taskResults aggregation. This keeps buildRunReport useful for
  // CLI/SDK callers that resume from persisted state instead of in-memory data.
  const hasExplicitBuckets = Boolean(
    taskResults && (
      Array.isArray(taskResults.completed) ||
      Array.isArray(taskResults.failed) ||
      Array.isArray(taskResults.skipped) ||
      Array.isArray(taskResults.blocked)
    ),
  );
  const buckets: TaskBuckets = hasExplicitBuckets
    ? taskResults
    : readTaskResultsFromDisk(stateDir, runId);
  const normalizedBuckets = normalizeTaskBuckets(buckets);
  const completed = normalizedBuckets.completed || [];
  const failed = normalizedBuckets.failed || [];
  const skipped = normalizedBuckets.skipped || [];
  const blocked = normalizedBuckets.blocked || [];
  const mergedInto = normalizedBuckets.merged_into || [];
  // merged_into tasks are terminal-but-satisfied (they were folded into a parent
  // task and count as completed for dependency purposes). Treat them as
  // completed for run-rate accounting but surface them separately so the final
  // answer can distinguish "actually executed" from "folded into another task".
  const terminalCount = completed.length + failed.length + blocked.length + mergedInto.length;
  const rawPlannedCount = asNumber(progressTotal ?? runStart?.tasks);
  const plannedCount = Math.max(rawPlannedCount ?? 0, terminalCount) || terminalCount + skipped.length;
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
      merged_into: mergedInto.length,
      evidence_failures: evidenceFailures,
      task_success_rate: rate(completed.length + mergedInto.length, terminalCount),
      run_success_rate: rate(completed.length + mergedInto.length, runRateDenominator),
    },
    tasks: {
      completed,
      failed,
      skipped,
      blocked,
      merged_into: mergedInto,
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
  }, { source: "run-report" }) as RunReport;
}

export function formatRunReportMarkdown(report: RunReport): string {
  const summary = report.summary || {};
  const tasks = report.tasks || {};
  const gateFailures = report.gates?.failures || [];
  const reviewIssues = report.review?.issues || [];
  const completedTasks = tasks.completed || [];
  const failedTasks = tasks.failed || [];
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
    gateFailures.length
      ? gateFailures.map((failure) => `- ${failure.task_id || "unknown"} ${failure.gate}: ${failure.reason || failure.status}`).join("\n")
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
    reviewIssues.length
      ? reviewIssues.map((issue) => `- ${issue.severity || "unknown"} ${issue.file || "unknown"}:${issue.line || ""} ${issue.message || ""}`.trim()).join("\n")
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
    completedTasks.length ? completedTasks.map((id) => `- ${id}`).join("\n") : "- none",
    "",
    "## Failed",
    failedTasks.length ? failedTasks.map((id) => `- ${id}`).join("\n") : "- none",
  ];
  return `${lines.join("\n")}\n`;
}

export function buildRunFinalAnswer(report: RunReport = Object(), options: FinalAnswerOptions = Object()): RunFinalAnswer {
  const summary = report.summary || {};
  const tasks = report.tasks || {};
  const failed = unique(tasks.failed || []);
  const blocked = unique(tasks.blocked || []);
  const completed = unique(tasks.completed || []);
  const skipped = unique(tasks.skipped || []);
  const mergedInto = unique(tasks.merged_into || []);
  const completedOrMerged = unique([...completed, ...mergedInto]);
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
  const terminalCount = completed.length + failed.length + blocked.length + mergedInto.length;
  const status = report.status || (failed.length || blocked.length ? "error" : "success");
  const fixtureRunCount = Number(report.fixtures?.run_count || 0);
  const fixtureStatus = cleanStatus(report.fixtures?.status);
  const fixtureDegraded = Number(report.fixtures?.degraded_count || 0);
  const hasFixtureEvidence = Boolean(fixtureStatus) || fixtureRunCount > 0 || fixtureFailures > 0 || fixtureDegraded > 0;
  const fixtureCheckStatus = fixtureFailures > 0
    ? "fail"
    : fixtureStatus || (fixtureRunCount > 0 ? "pass" : "not_run");
  const baseBlockerLines = [
    ...(!EVIDENCE_RUN_REPORT_PASS_STATUSES.has(cleanStatus(status)) ? [`run report status is ${status}`] : []),
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
    .filter((check) => !EVIDENCE_RUN_REPORT_PASS_STATUSES.has(cleanStatus(check.status)))
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
    outcome: blockerLines.length === 0 ? "success" : "needs_attention",
    headline: blockerLines.length === 0
      ? `YOLO run ${report.run_id || "unknown"} completed`
      : `YOLO run ${report.run_id || "unknown"} completed with blockers`,
    summary: {
      planned: summary.planned ?? null,
      completed: completed.length,
      failed: failed.length,
      skipped: skipped.length,
      blocked: blocked.length,
      merged_into: mergedInto.length,
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
      merged_into: itemList(mergedInto),
    },
    evidence: {
      report_json: stringOrNull(options.reportJsonPath || options.report_json || null),
      report_markdown: stringOrNull(options.reportMarkdownPath || options.report_markdown || null),
      generated_from: report.artifact_type || "run.report",
    },
    next_actions: nextActions,
  };
}

export function formatRunFinalAnswerMarkdown(finalAnswerOrReport: RunFinalAnswer | RunReport = Object(), options: FinalAnswerOptions = Object()): string {
  const finalAnswer: RunFinalAnswer = finalAnswerOrReport.schema === "yolo.evidence.final_answer.v1"
    ? finalAnswerOrReport as RunFinalAnswer
    : buildRunFinalAnswer(finalAnswerOrReport, options);
  const summary = finalAnswer.summary || {};
  const blockers = finalAnswer.blockers || [];
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
    ...blockers.length ? blockers.map((item) => `- ${item}`) : ["- none"],
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

export function runReportPaths(stateDir: string, runId = "latest") {
  const reportDir = join(stateDir, "reports", runId || "latest");
  return {
    report_dir: reportDir,
    json_path: join(reportDir, "run-report.json"),
    markdown_path: join(reportDir, "run-report.md"),
    final_answer_json_path: join(reportDir, "final-answer.json"),
    final_answer_markdown_path: join(reportDir, "final-answer.md"),
  };
}

export function writeRunReport(options: BuildRunReportOptions = Object()) {
  const report = buildRunReport(options);
  if (!options.stateDir) throw new Error("buildRunReport requires stateDir");
  const paths = runReportPaths(options.stateDir, String(report.run_id || options.runId || "latest"));
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

  appendJsonlRecord(join(options.stateDir, "artifacts.jsonl"), {
    event: "artifact.write",
    ledger: "artifact",
    run_id: report.run_id,
    artifact_type: "run_report_bundle",
    artifacts: [
      { type: "run_report_json", path: relative(resolve(options.stateDir), paths.json_path) },
      { type: "run_report_markdown", path: relative(resolve(options.stateDir), paths.markdown_path) },
      { type: "final_answer_json", path: relative(resolve(options.stateDir), paths.final_answer_json_path) },
      { type: "final_answer_markdown", path: relative(resolve(options.stateDir), paths.final_answer_markdown_path) },
    ],
    artifact_integrity: artifactIntegrity,
  }, { source: "run-report" });

  return {
    report,
    final_answer: finalAnswer,
    artifact_integrity: artifactIntegrity,
    ...paths,
  };
}
