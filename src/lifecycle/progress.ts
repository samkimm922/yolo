import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { appendStateEvent } from "../runtime/evidence/ledger.js";
import { appendSessionMemory } from "../runtime/evidence/session-memory.js";
import { appendLearningRecord } from "../runtime/learning/center.js";
import { RuntimeInvariantViolation } from "../runtime/invariants.js";
import {
  createLifecycleArtifact,
  createLifecycleStateSnapshot,
  getLifecycleStage,
  LIFECYCLE_STAGES,
  validateLifecycleState,
  type LifecycleStateSnapshot,
} from "./schema.js";
import {
  lifecycleArtifactPath,
  lifecycleStatusPath,
  resolveLifecycleStateRoot,
} from "./state.js";
import { writeSourceSnapshot } from "./source-snapshot.js";
import { redactDeep } from "../lib/security/redact.js";
import { isStructuredManualAcceptanceEvidence } from "./manual-acceptance.js";
import { registerGeneratedArtifactIntegrity } from "../runtime/evidence/artifact-integrity.js";

export const LIFECYCLE_PROGRESS_SCHEMA_VERSION = "1.0";
export const LIFECYCLE_STAGE_REPORT_SCHEMA = "yolo.lifecycle.stage_report.v1";

export type ProgressRecord = Record<string, unknown>;

export interface ProgressOptions extends ProgressRecord {
  projectName?: unknown;
  project_name?: unknown;
  now?: unknown;
  stateRoot?: unknown;
  state_root?: unknown;
  stateDir?: unknown;
  state_dir?: unknown;
  stageStatus?: unknown;
  stage_status?: unknown;
  source?: unknown;
  skipSequenceCheck?: unknown;
  skip_sequence_check?: unknown;
  writeSessionMemory?: unknown;
  write_session_memory?: unknown;
  learnFailures?: unknown;
  input?: ProgressRecord;
}

export interface StageReportEntry extends ProgressRecord {
  status?: string;
  verdict?: string;
  outcome?: string;
  report?: ProgressRecord;
  blockers?: unknown[];
  blocked_reasons?: unknown[];
  issues?: unknown[];
  checks?: unknown[];
  evidence?: unknown[];
  artifacts?: unknown[];
  manual_criteria?: unknown[];
  inputs?: unknown[];
  outputs?: unknown[];
  decisions?: unknown[];
  next_actions?: unknown[];
  report_json?: unknown;
  report_markdown?: unknown;
  summary?: unknown;
  code?: unknown;
}

export interface ManualCriterion extends ProgressRecord {
  task_id?: unknown;
  task_code?: unknown;
  taskId?: unknown;
  condition_id?: unknown;
  conditionId?: unknown;
  level?: unknown;
  status?: unknown;
}

export interface ReportBlocker {
  code: string;
  message: string;
  source: string | null;
  task_id: string | null;
}

export interface StatusStageEntry extends ProgressRecord {
  id?: string;
  status?: string;
  sequence?: unknown;
  label?: unknown;
  artifact?: unknown;
  writes_code?: unknown;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function normalizedReportStatus(report: StageReportEntry = Object()): string {
  return clean(report.status || report.verdict || report.outcome).toLowerCase().replace(/[\s-]+/g, "_");
}

function statusForReport(report: StageReportEntry = Object()): string {
  const status = normalizedReportStatus(report);
  if (["pass", "passed", "success", "succeeded", "completed", "done"].includes(status)) return "completed";
  if (["warning", "warn"].includes(status)) return "warning";
  if (["blocked", "error", "failed", "fail", "skipped", "not_run", "indeterminate"].includes(status)) return "blocked";
  return "active";
}

function shouldRefreshWriteStageSourceSnapshot(stageId: string, stageStatus: string): boolean {
  const stage = getLifecycleStage(stageId);
  return stage.writes_code === true && stageStatus === "completed";
}

function shouldRefreshRunnerBaselineSourceSnapshot(stageId: string, stageStatus: string, options: ProgressOptions): boolean {
  const runnerBaselineCommit = clean(options.runnerBaselineCommit || options.runner_baseline_commit);
  return stageId === "check"
    && stageStatus === "completed"
    && clean(options.source) === "runner-baseline"
    && Boolean(runnerBaselineCommit);
}

function shouldRefreshSourceSnapshot(stageId: string, stageStatus: string, options: ProgressOptions = Object()): boolean {
  return shouldRefreshWriteStageSourceSnapshot(stageId, stageStatus)
    || shouldRefreshRunnerBaselineSourceSnapshot(stageId, stageStatus, options);
}

function meaningfulEvidenceEntry(entry: unknown): boolean {
  if (!entry) return false;
  if (typeof entry === "string") return Boolean(clean(entry));
  if (typeof entry !== "object") return true;
  return Object.keys(entry as object).length > 0;
}

function reportEvidenceEntries(report: StageReportEntry = Object()): ProgressRecord[] {
  return [
    ...(Array.isArray(report.evidence) ? report.evidence : []),
    ...(Array.isArray(report.report?.evidence) ? report.report.evidence : []),
  ].filter(meaningfulEvidenceEntry) as ProgressRecord[];
}

function unresolvedManualCriteria(report: StageReportEntry = Object(), projectRoot?: string, stateRoot?: string): ManualCriterion[] {
  const manualCriteria: unknown[] = [
    ...(Array.isArray(report.manual_criteria) ? report.manual_criteria : []),
    ...(Array.isArray(report.report?.manual_criteria) ? report.report.manual_criteria : []),
  ];
  if (manualCriteria.length === 0) return [];

  const manualEvidence = reportEvidenceEntries(report).filter(
    (entry) => isStructuredManualAcceptanceEvidence(entry, { projectRoot, stateRoot }),
  );
  return manualCriteria.filter((criterion) => {
    if (!criterion || typeof criterion !== "object") return true;
    const record = criterion as ManualCriterion;
    const taskId = record.task_id;
    const conditionId = record.condition_id;
    if (!taskId || !conditionId) return true;
    return !manualEvidence.some(
      (evidence) => (evidence as ManualCriterion).task_id === taskId
        && (evidence as ManualCriterion).condition_id === conditionId,
    );
  }) as ManualCriterion[];
}

function assertDeliveryManualAcceptanceResolved(stageId: string, { stateRoot, projectRoot } = Object()): void {
  if (stageId !== "delivery") return;
  const acceptancePath = lifecycleArtifactPath("acceptance", { stateRoot });
  if (!existsSync(acceptancePath)) return;
  let parsed: StageReportEntry;
  try {
    // JSON.parse returns `any`; downstream accesses tolerate malformed shapes
    // (see StageReportEntry optionals). Preserve the original trust-the-parse
    // behavior rather than adding a new narrowing branch.
    parsed = JSON.parse(readFileSync(acceptancePath, "utf8"));
  } catch {
    return;
  }
  const unresolved = unresolvedManualCriteria(parsed, projectRoot, stateRoot);
  if (unresolved.length === 0) return;
  throw new RuntimeInvariantViolation(
    "delivery_manual_acceptance_unresolved",
    "Delivery cannot be recorded while manual acceptance criteria remain unresolved.",
    {
      stage: "delivery",
      source_stage: "acceptance",
      acceptance_report_path: acceptancePath,
      unresolved_manual_criteria: unresolved.map((criterion) => ({
        task_id: criterion?.task_id || null,
        condition_id: criterion?.condition_id || null,
      })),
    },
  );
}

// `checks` entries from upstream reports may be null/number/string when an
// external producer writes malformed-but-valid JSON. `.filter((c) => c.status
// === "blocked")` would then crash on `null.status`. Reject non-object entries
// before reading `.status`, mirroring the asConditions/isBlockingIssue pattern.
// `checks` entries from upstream reports may be null/number/string when an
// external producer writes malformed-but-valid JSON. `.filter((c) => c.status
// === "blocked")` would then crash on `null.status`. Reject non-object entries
// before reading `.status`, mirroring the asConditions/isBlockingIssue pattern.
function isBlockingCheck(check: unknown): boolean {
  if (!check || typeof check !== "object") return false;
  return (check as ManualCriterion).status === "blocked";
}

export interface ReportBlockerRecord extends ProgressRecord {
  code?: unknown;
  id?: unknown;
  name?: unknown;
  message?: unknown;
  detail?: unknown;
  summary?: unknown;
  reason?: unknown;
  source?: unknown;
  gate?: unknown;
  stage?: unknown;
  task_id?: unknown;
  taskId?: unknown;
}

function reportBlockers(report: StageReportEntry = Object()): ReportBlocker[] {
  const raw: unknown[] = [
    ...(Array.isArray(report.blockers) ? report.blockers : []),
    ...(Array.isArray(report.blocked_reasons) ? report.blocked_reasons : []),
    ...(Array.isArray(report.issues) ? report.issues.filter((issue) => isBlockingIssue(issue)) : []),
    ...(Array.isArray(report.checks) ? report.checks.filter((check) => isBlockingCheck(check)) : []),
  ];
  return raw
    .map((item): ReportBlocker | null => {
      if (typeof item === "string") return { code: "BLOCKER", message: item, source: null, task_id: null };
      if (!item || typeof item !== "object") return null;
      const record = item as ReportBlockerRecord;
      return {
        code: String(record.code || record.id || record.name || "BLOCKER"),
        message: String(record.message || record.detail || record.summary || record.reason || ""),
        source: record.source != null ? String(record.source) : (record.gate != null ? String(record.gate) : (record.stage != null ? String(record.stage) : null)),
        task_id: record.task_id != null ? String(record.task_id) : (record.taskId != null ? String(record.taskId) : null),
      };
    })
    .filter((item): item is ReportBlocker => item !== null);
}

// Acceptance reports classify issues by priority level rather than status.
// P0 (hard failures) and P1 (release-blocking gaps) must surface as stage
// blockers; P2/human_review stay as advisory issues and do not block the stage.
function isBlockingIssue(issue: unknown): boolean {
  if (!issue || typeof issue !== "object") return false;
  const record = issue as ManualCriterion;
  if (record.status === "blocked") return true;
  const level = clean(record.level).toUpperCase();
  return level === "P0" || level === "P1";
}

function reportEvidence(report: StageReportEntry = Object()): ProgressRecord[] {
  return [
    ...(Array.isArray(report.evidence) ? report.evidence : []),
    ...(Array.isArray(report.artifacts) ? report.artifacts.map((path) => ({ path })) : []),
    report.report_json ? { path: report.report_json, type: "report_json" } : null,
    report.report_markdown ? { path: report.report_markdown, type: "report_markdown" } : null,
  ].filter(Boolean) as ProgressRecord[];
}

function stateDirFor(options: ProgressOptions = Object()): string {
  if (options.stateDir || options.state_dir) return resolve(String(options.stateDir || options.state_dir));
  return join(resolveLifecycleStateRoot(options), "state");
}

function nextStageId(stageId: string): string {
  const index = LIFECYCLE_STAGES.findIndex((stage) => stage.id === stageId);
  if (index < 0) return stageId;
  return LIFECYCLE_STAGES[index + 1]?.id || stageId;
}

function loadOrCreateStatus(stageId: string, options: ProgressOptions = Object()) {
  const projectName = clean(options.projectName || options.project_name) || "project";
  const statusPath = lifecycleStatusPath(options);
  if (existsSync(statusPath)) {
    try {
      return JSON.parse(readFileSync(statusPath, "utf8")) as LifecycleStateSnapshot;
    } catch {
      return createLifecycleStateSnapshot({ projectName, currentStage: stageId, now: options.now });
    }
  }
  return createLifecycleStateSnapshot({ projectName, currentStage: stageId, now: options.now });
}

function updateStatusForStage(stageId: string, stageStatus: string, options: ProgressOptions = Object()) {
  const now = clean(options.now) || new Date().toISOString();
  const status = loadOrCreateStatus(stageId, { ...options, now });
  const activeStage = stageStatus === "completed" ? nextStageId(stageId) : stageId;

  status.current_stage = activeStage;
  status.updated_at = now;
  status.stages = LIFECYCLE_STAGES.map((stage) => {
    // status.stages may contain null/non-object entries when status.json is
    // valid JSON but botched by an external write, partial flush, or git merge.
    // `.find((item) => item.id === ...)` crashes on null; mirror the optional-
    // chaining pattern used in validateLifecycleState (schema.ts).
    const existing = (Array.isArray(status.stages) ? status.stages : []).find(
      (item) => item?.id === stage.id,
    ) || { status: "" as string };
    let nextStatus = existing.status || "pending";
    if (stage.id === stageId) nextStatus = stageStatus;
    else if (stage.id === activeStage) nextStatus = "active";
    else if (nextStatus === "active") nextStatus = "pending";
    return {
      id: stage.id,
      sequence: stage.sequence,
      label: stage.label,
      status: nextStatus,
      artifact: stage.default_artifact,
      writes_code: stage.writes_code,
    };
  });

  const validation = validateLifecycleState(status);
  const path = lifecycleStatusPath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableJson(redactDeep(status)), "utf8");
  return { path, state: status, validation };
}

export function buildLifecycleStageReport(stageId: string, report: StageReportEntry | object = Object(), options: ProgressOptions = Object()) {
  const stageReport = report as StageReportEntry;
  const now = clean(options.now) || new Date().toISOString();
  const stage = getLifecycleStage(stageId);
  const stageStatus = clean(options.stageStatus || options.stage_status) || statusForReport(stageReport);
  const artifact = createLifecycleArtifact(stage, {
    projectName: options.projectName || options.project_name,
    now,
    status: stageStatus,
  });
  return {
    ...artifact,
    schema: LIFECYCLE_STAGE_REPORT_SCHEMA,
    lifecycle_schema: artifact.schema,
    updated_at: now,
    inputs: Array.isArray(stageReport.inputs) ? stageReport.inputs : [],
    outputs: Array.isArray(stageReport.outputs) ? stageReport.outputs : [],
    decisions: Array.isArray(stageReport.decisions) ? stageReport.decisions : [],
    evidence: reportEvidence(stageReport),
    blockers: reportBlockers(stageReport),
    next_actions: Array.isArray(stageReport.next_actions) ? stageReport.next_actions : [],
    report: clone(stageReport),
  };
}

export function writeLifecycleStageReport(stageId: string, report: StageReportEntry | object = Object(), options: ProgressOptions = Object()) {
  const inputReport = report as StageReportEntry;
  const stateRoot = resolveLifecycleStateRoot(options);
  const now = clean(options.now) || new Date().toISOString();

  // Sequence validation: reject writes when prior stages have not completed
  if (options.skipSequenceCheck !== true && options.skip_sequence_check !== true) {
    const targetStage = getLifecycleStage(stageId);
    const status = loadOrCreateStatus(stageId, { ...options, stateRoot, now });
    // Same null-entry guard as updateStatusForStage: status.stages may contain
    // null/non-object entries from a corrupted status.json. `.map((s) => [s.id,
    // s.status])` crashes on null; use optional chaining and drop undefined ids.
    const stageStatusMap = new Map<string, string>(
      (Array.isArray(status.stages) ? status.stages : [])
        .map((s): [string | undefined, string | undefined] => [s?.id, s?.status])
        .filter((entry): entry is [string, string] => Boolean(entry[0])),
    );
    const incomplete = LIFECYCLE_STAGES.filter(
      (s) => s.sequence >= 5 && s.sequence < targetStage.sequence && stageStatusMap.get(s.id) !== "completed",
    );
    if (incomplete.length > 0) {
      throw new Error(
        `Cannot write ${stageId} report: prior stages not completed: ${incomplete.map((s) => s.id).join(", ")}`,
      );
    }
  }

  assertDeliveryManualAcceptanceResolved(stageId, { stateRoot, projectRoot: options.projectRoot || options.project_root });

  const stageReport = buildLifecycleStageReport(stageId, report, { ...options, stateRoot, now });
  const stageStatus = stageReport.status;
  const artifactPath = lifecycleArtifactPath(stageId, { ...options, stateRoot });
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, stableJson(redactDeep(stageReport)), "utf8");
  registerGeneratedArtifactIntegrity([artifactPath], {
    rootDir: options.projectRoot || options.project_root || process.cwd(),
    stateRoot,
    source: options.source || "lifecycle-progress",
    allowUnsignedDevelopment: options.allowUnsignedDevelopment === true || options.allow_unsigned_development === true,
  });
  const status = updateStatusForStage(stageId, stageStatus, { ...options, stateRoot, now });
  const stateDir = stateDirFor({ ...options, stateRoot });
  mkdirSync(stateDir, { recursive: true });
  const event = appendStateEvent(stateDir, `lifecycle.${stageId}.report`, {
    stage: stageId,
    status: inputReport.status || stageStatus,
    artifact: artifactPath,
    blocker_count: stageReport.blockers.length,
  }, { source: options.source || "lifecycle-progress", now });

  let source_snapshot = null;
  if (shouldRefreshSourceSnapshot(stageId, stageStatus, options)) {
    try {
      source_snapshot = writeSourceSnapshot({
        ...options,
        stateRoot,
        now,
      });
    } catch {
      source_snapshot = null;
    }
  }

  let session_memory = null;
  if (options.writeSessionMemory !== false && options.write_session_memory !== false) {
    session_memory = appendSessionMemory({
      argv: [
        "--type=lifecycle",
        `--source=${options.source || "lifecycle-progress"}`,
        `--summary=${stageId}:${inputReport.status || stageStatus}:${inputReport.summary || inputReport.code || ""}`,
        `--refs=${[artifactPath, ...(Array.isArray(inputReport.artifacts) ? inputReport.artifacts : [])].filter(Boolean).join(",")}`,
        `--state-dir=${stateDir}`,
      ],
      now: new Date(now),
    });
  }

  let learning = null;
  if (
    options.learnFailures === true &&
    stageReport.blockers.length > 0 &&
    ["blocked", "error", "failed", "fail"].includes(clean(inputReport.status).toLowerCase())
  ) {
    learning = appendLearningRecord({
      type: "failure",
      source: options.source || "lifecycle-progress",
      source_outcome: "failure",
      gate: stageId,
      lesson: inputReport.summary || stageReport.blockers[0]?.message || `${stageId} blocked`,
      prevention: stageReport.next_actions[0] || "Fix the blocker before advancing the lifecycle.",
      evidence_refs: [artifactPath],
      tags: ["lifecycle", stageId],
    }, {
      projectRoot: options.projectRoot || options.project_root || process.cwd(),
      stateRoot,
      now,
    });
  }

  return {
    status: "ok",
    schema_version: LIFECYCLE_PROGRESS_SCHEMA_VERSION,
    stage: stageId,
    stage_status: stageStatus,
    artifact_path: artifactPath,
    status_path: status.path,
    validation: status.validation,
    event,
    source_snapshot,
    session_memory,
    learning,
    report: stageReport,
  };
}
