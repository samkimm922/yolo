import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { appendStateEvent } from "../runtime/evidence/ledger.js";
import { appendSessionMemory } from "../runtime/evidence/session-memory.js";
import { appendLearningRecord } from "../runtime/learning/center.js";
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

function statusForReport(report = {}) {
  const status = clean(report.status || report.verdict || report.outcome).toLowerCase();
  if (["pass", "passed", "success", "succeeded", "ready", "completed", "done"].includes(status)) return "completed";
  if (["warning", "warn"].includes(status)) return "warning";
  if (["blocked", "error", "failed", "fail"].includes(status)) return "blocked";
  return "active";
}

function reportBlockers(report = {}) {
  const raw = [
    ...(Array.isArray(report.blockers) ? report.blockers : []),
    ...(Array.isArray(report.blocked_reasons) ? report.blocked_reasons : []),
    ...(Array.isArray(report.issues) ? report.issues.filter((issue) => issue.status === "blocked") : []),
    ...(Array.isArray(report.checks) ? report.checks.filter((check) => check.status === "blocked") : []),
  ];
  return raw.map((item) => {
    if (typeof item === "string") return { code: "BLOCKER", message: item };
    return {
      code: item.code || item.id || item.name || "BLOCKER",
      message: item.message || item.detail || item.summary || item.reason || "",
      source: item.source || item.gate || item.stage || null,
      task_id: item.task_id || item.taskId || null,
    };
  });
}

function reportEvidence(report = {}) {
  return [
    ...(Array.isArray(report.evidence) ? report.evidence : []),
    ...(Array.isArray(report.artifacts) ? report.artifacts.map((path) => ({ path })) : []),
    report.report_json ? { path: report.report_json, type: "report_json" } : null,
    report.report_markdown ? { path: report.report_markdown, type: "report_markdown" } : null,
  ].filter(Boolean);
}

function stateDirFor(options = {}) {
  if (options.stateDir || options.state_dir) return resolve(options.stateDir || options.state_dir);
  return join(resolveLifecycleStateRoot(options), "state");
}

function nextStageId(stageId) {
  const index = LIFECYCLE_STAGES.findIndex((stage) => stage.id === stageId);
  if (index < 0) return stageId;
  return LIFECYCLE_STAGES[index + 1]?.id || stageId;
}

function loadOrCreateStatus(stageId, options = {}) {
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

function updateStatusForStage(stageId, stageStatus, options = {}) {
  const now = clean(options.now) || new Date().toISOString();
  const status = loadOrCreateStatus(stageId, { ...options, now });
  const activeStage = stageStatus === "completed" ? nextStageId(stageId) : stageId;

  status.current_stage = activeStage;
  status.updated_at = now;
  status.stages = LIFECYCLE_STAGES.map((stage) => {
    const existing = (status.stages || []).find((item) => item.id === stage.id) || {};
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

export function buildLifecycleStageReport(stageId, report = {}, options = {}) {
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

export function writeLifecycleStageReport(stageId, report = {}, options = {}) {
  const stateRoot = resolveLifecycleStateRoot(options);
  const now = clean(options.now) || new Date().toISOString();
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
    session_memory,
    learning,
    report: stageReport,
  };
}
