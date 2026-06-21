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
} from "./schema.js";
import {
  lifecycleArtifactPath,
  lifecycleStatusPath,
  resolveLifecycleStateRoot,
} from "./state.js";
import { writeSourceSnapshot } from "./source-snapshot.js";

export const LIFECYCLE_PROGRESS_SCHEMA_VERSION = "1.0";
export const LIFECYCLE_STAGE_REPORT_SCHEMA = "yolo.lifecycle.stage_report.v1";

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function clean(value) {
  return String(value ?? "").trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizedReportStatus(report = Object()) {
  return clean(report.status || report.verdict || report.outcome).toLowerCase().replace(/[\s-]+/g, "_");
}

function statusForReport(report = Object()) {
  const status = normalizedReportStatus(report);
  if (["pass", "passed", "success", "succeeded", "completed", "done"].includes(status)) return "completed";
  if (["warning", "warn"].includes(status)) return "warning";
  if (["blocked", "error", "failed", "fail", "skipped", "not_run", "indeterminate"].includes(status)) return "blocked";
  return "active";
}

function shouldRefreshSourceSnapshot(stageId, stageStatus) {
  const stage = getLifecycleStage(stageId);
  return stage.writes_code === true && stageStatus === "completed";
}

function meaningfulEvidenceEntry(entry) {
  if (!entry) return false;
  if (typeof entry === "string") return Boolean(clean(entry));
  if (typeof entry !== "object") return true;
  return Object.keys(entry).length > 0;
}

function reportEvidenceEntries(report = Object()) {
  return [
    ...(Array.isArray(report.evidence) ? report.evidence : []),
    ...(Array.isArray(report.report?.evidence) ? report.report.evidence : []),
  ].filter(meaningfulEvidenceEntry);
}

function unresolvedManualCriteria(report = Object()) {
  const manualCriteria = [
    ...(Array.isArray(report.manual_criteria) ? report.manual_criteria : []),
    ...(Array.isArray(report.report?.manual_criteria) ? report.report.manual_criteria : []),
  ];
  if (manualCriteria.length === 0) return [];

  const manualEvidence = reportEvidenceEntries(report).filter(
    (entry) => entry && entry.type === "manual_acceptance" && entry.task_id && entry.condition_id,
  );
  return manualCriteria.filter((criterion) => {
    const taskId = criterion?.task_id;
    const conditionId = criterion?.condition_id;
    if (!taskId || !conditionId) return true;
    return !manualEvidence.some((record) => record.task_id === taskId && record.condition_id === conditionId);
  });
}

function assertDeliveryManualAcceptanceResolved(stageId, { stateRoot } = Object()) {
  if (stageId !== "delivery") return;
  const acceptancePath = lifecycleArtifactPath("acceptance", { stateRoot });
  if (!existsSync(acceptancePath)) return;
  let acceptanceReport = null;
  try {
    acceptanceReport = JSON.parse(readFileSync(acceptancePath, "utf8"));
  } catch {
    return;
  }
  const unresolved = unresolvedManualCriteria(acceptanceReport);
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
function isBlockingCheck(check) {
  if (!check || typeof check !== "object") return false;
  return check.status === "blocked";
}

function reportBlockers(report = Object()) {
  const raw = [
    ...(Array.isArray(report.blockers) ? report.blockers : []),
    ...(Array.isArray(report.blocked_reasons) ? report.blocked_reasons : []),
    ...(Array.isArray(report.issues) ? report.issues.filter((issue) => isBlockingIssue(issue)) : []),
    ...(Array.isArray(report.checks) ? report.checks.filter((check) => isBlockingCheck(check)) : []),
  ];
  return raw
    .map((item) => {
      if (typeof item === "string") return { code: "BLOCKER", message: item };
      if (!item || typeof item !== "object") return null;
      return {
        code: item.code || item.id || item.name || "BLOCKER",
        message: item.message || item.detail || item.summary || item.reason || "",
        source: item.source || item.gate || item.stage || null,
        task_id: item.task_id || item.taskId || null,
      };
    })
    .filter(Boolean);
}

// Acceptance reports classify issues by priority level rather than status.
// P0 (hard failures) and P1 (release-blocking gaps) must surface as stage
// blockers; P2/human_review stay as advisory issues and do not block the stage.
function isBlockingIssue(issue) {
  if (!issue || typeof issue !== "object") return false;
  if (issue.status === "blocked") return true;
  const level = clean(issue.level).toUpperCase();
  return level === "P0" || level === "P1";
}

function reportEvidence(report = Object()) {
  return [
    ...(Array.isArray(report.evidence) ? report.evidence : []),
    ...(Array.isArray(report.artifacts) ? report.artifacts.map((path) => ({ path })) : []),
    report.report_json ? { path: report.report_json, type: "report_json" } : null,
    report.report_markdown ? { path: report.report_markdown, type: "report_markdown" } : null,
  ].filter(Boolean);
}

function stateDirFor(options = Object()) {
  if (options.stateDir || options.state_dir) return resolve(options.stateDir || options.state_dir);
  return join(resolveLifecycleStateRoot(options), "state");
}

function nextStageId(stageId) {
  const index = LIFECYCLE_STAGES.findIndex((stage) => stage.id === stageId);
  if (index < 0) return stageId;
  return LIFECYCLE_STAGES[index + 1]?.id || stageId;
}

function loadOrCreateStatus(stageId, options = Object()) {
  const projectName = clean(options.projectName || options.project_name) || "project";
  const statusPath = lifecycleStatusPath(options);
  if (existsSync(statusPath)) {
    try {
      return JSON.parse(readFileSync(statusPath, "utf8"));
    } catch {
      return createLifecycleStateSnapshot({ projectName, currentStage: stageId, now: options.now });
    }
  }
  return createLifecycleStateSnapshot({ projectName, currentStage: stageId, now: options.now });
}

function updateStatusForStage(stageId, stageStatus, options = Object()) {
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
    ) || {};
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
  writeFileSync(path, stableJson(status), "utf8");
  return { path, state: status, validation };
}

export function buildLifecycleStageReport(stageId, report = Object(), options = Object()) {
  const now = clean(options.now) || new Date().toISOString();
  const stage = getLifecycleStage(stageId);
  const stageStatus = options.stageStatus || options.stage_status || statusForReport(report);
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
    inputs: Array.isArray(report.inputs) ? report.inputs : [],
    outputs: Array.isArray(report.outputs) ? report.outputs : [],
    decisions: Array.isArray(report.decisions) ? report.decisions : [],
    evidence: reportEvidence(report),
    blockers: reportBlockers(report),
    next_actions: Array.isArray(report.next_actions) ? report.next_actions : [],
    report: clone(report),
  };
}

export function writeLifecycleStageReport(stageId, report = Object(), options = Object()) {
  const stateRoot = resolveLifecycleStateRoot(options);
  const now = clean(options.now) || new Date().toISOString();

  // Sequence validation: reject writes when prior stages have not completed
  if (options.skipSequenceCheck !== true && options.skip_sequence_check !== true) {
    const targetStage = getLifecycleStage(stageId);
    const status = loadOrCreateStatus(stageId, { ...options, stateRoot, now });
    // Same null-entry guard as updateStatusForStage: status.stages may contain
    // null/non-object entries from a corrupted status.json. `.map((s) => [s.id,
    // s.status])` crashes on null; use optional chaining and drop undefined ids.
    const stageStatusMap = new Map(
      (Array.isArray(status.stages) ? status.stages : [])
        .map((s) => [s?.id, s?.status])
        .filter(([id]) => id),
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

  assertDeliveryManualAcceptanceResolved(stageId, { stateRoot });

  const stageReport = buildLifecycleStageReport(stageId, report, { ...options, stateRoot, now });
  const stageStatus = stageReport.status;
  const artifactPath = lifecycleArtifactPath(stageId, { ...options, stateRoot });
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, stableJson(stageReport), "utf8");
  const status = updateStatusForStage(stageId, stageStatus, { ...options, stateRoot, now });
  const stateDir = stateDirFor({ ...options, stateRoot });
  mkdirSync(stateDir, { recursive: true });
  const event = appendStateEvent(stateDir, `lifecycle.${stageId}.report`, {
    stage: stageId,
    status: report.status || stageStatus,
    artifact: artifactPath,
    blocker_count: stageReport.blockers.length,
  }, { source: options.source || "lifecycle-progress", now });

  let source_snapshot = null;
  if (shouldRefreshSourceSnapshot(stageId, stageStatus)) {
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
        `--summary=${stageId}:${report.status || stageStatus}:${report.summary || report.code || ""}`,
        `--refs=${[artifactPath, ...(Array.isArray(report.artifacts) ? report.artifacts : [])].filter(Boolean).join(",")}`,
        `--state-dir=${stateDir}`,
      ],
      now: new Date(now),
    });
  }

  let learning = null;
  if (
    options.learnFailures === true &&
    stageReport.blockers.length > 0 &&
    ["blocked", "error", "failed", "fail"].includes(clean(report.status).toLowerCase())
  ) {
    learning = appendLearningRecord({
      type: "failure",
      source: options.source || "lifecycle-progress",
      gate: stageId,
      lesson: report.summary || stageReport.blockers[0]?.message || `${stageId} blocked`,
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
