import { resolve } from "node:path";
import { inspectRuntimeBoundaryCandidate } from "./runtime-boundary-candidate.js";
import type { ReleaseCheck, ReleaseIssue, ReleaseRecord } from "./readiness.js";

export const RUNTIME_BOUNDARY_DECISION_SCHEMA_VERSION = "1.0";

export interface RuntimeBoundaryDecisionPlan extends ReleaseRecord {
  yolo_root: string;
  target_export: string;
  writes_workspace: boolean;
  publishes: boolean;
  reads_credentials: boolean;
  spawns_provider: boolean;
  executes_billable_provider: boolean;
  applies_boundary_change: boolean;
}

export interface RuntimeBoundaryCandidateSummary extends ReleaseRecord {
  export?: string;
  current_tier?: string;
  proposed_tier?: string;
}

export interface RuntimeBoundaryCandidateResult extends ReleaseRecord {
  status: string;
  candidate?: RuntimeBoundaryCandidateSummary;
  blockers?: ReleaseIssue[];
  suggested_changes?: unknown[];
}

export interface RuntimeBoundaryDecisionRecord extends ReleaseRecord {
  approved?: boolean;
  approver?: string;
  operator?: string;
  approved_at?: string;
  executed_at?: string;
  target_export?: string;
  current_tier?: string;
  proposed_tier?: string;
  stability_reviewed?: boolean;
  rollback_plan_approved?: boolean;
  rollback_plan?: string;
  rollback_plan_path?: string;
}

export interface RuntimeBoundaryDecisionOptions extends ReleaseRecord {
  yoloRoot?: string;
  cwd?: string;
  targetExport?: string;
  target_export?: string;
  expectedTarget?: string;
  expected_target?: string;
  packageJson?: ReleaseRecord;
  apiBoundary?: ReleaseRecord;
  api_boundary?: ReleaseRecord;
  runtimeApiFreeze?: ReleaseRecord;
  runtime_api_freeze?: ReleaseRecord;
  inspectRunnerRuntimeApiFreeze?: (options: ReleaseRecord) => ReleaseRecord;
  maxRunnerCoreLines?: number;
  max_runner_core_lines?: number;
  plan?: RuntimeBoundaryDecisionPlan;
  candidate?: ReleaseRecord;
  runtimeBoundaryCandidate?: ReleaseRecord;
  runtime_boundary_candidate?: ReleaseRecord;
  decisionRecord?: RuntimeBoundaryDecisionRecord | null;
  decision_record?: RuntimeBoundaryDecisionRecord | null;
}

function check(code: string, passed: boolean, message: string, extra: ReleaseRecord = Object()): ReleaseCheck {
  return { code, passed, message, ...extra };
}

function isObject(value: unknown): value is ReleaseRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): boolean {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function decisionApproved(record: unknown = Object(), candidate: RuntimeBoundaryCandidateSummary = Object()): boolean {
  const summary: RuntimeBoundaryDecisionRecord = isObject(record) ? record : {};
  return summary.approved === true
    && nonEmptyString(summary.approver || summary.operator)
    && validTimestamp(summary.approved_at || summary.executed_at)
    && (summary.target_export || candidate.export) === candidate.export
    && (summary.current_tier || candidate.current_tier) === "experimental"
    && (summary.proposed_tier || candidate.proposed_tier) === "stable"
    && summary.stability_reviewed === true
    && summary.rollback_plan_approved === true
    && nonEmptyString(summary.rollback_plan || summary.rollback_plan_path);
}

const RUNTIME_BOUNDARY_DECISION_RECORD_ATTACH_OPTIONS = Object.freeze(["decisionRecord", "decision_record"]);

function buildRuntimeBoundaryDecisionRecordTemplate(targetExport: string): ReleaseRecord {
  return {
    description: "Copy this record, fill in approver/timestamps, and attach it via the decisionRecord / decision_record option to satisfy the approval gate.",
    attach_via: RUNTIME_BOUNDARY_DECISION_RECORD_ATTACH_OPTIONS[0],
    attach_options: [...RUNTIME_BOUNDARY_DECISION_RECORD_ATTACH_OPTIONS],
    required_fields: {
      approved: "true",
      approver: "non-empty string (operator also accepted)",
      approved_at: "ISO-8601 timestamp (executed_at also accepted)",
      target_export: targetExport,
      current_tier: "experimental",
      proposed_tier: "stable",
      stability_reviewed: "true",
      rollback_plan_approved: "true",
      rollback_plan: "non-empty string describing how to revert (rollback_plan_path also accepted)",
    },
    entry_template: {
      approved: true,
      approver: "<release-owner>",
      approved_at: "<ISO-8601 timestamp>",
      target_export: targetExport,
      current_tier: "experimental",
      proposed_tier: "stable",
      stability_reviewed: true,
      rollback_plan_approved: true,
      rollback_plan: "revert docs/public-sdk-api-boundary.json ./runtime tier to experimental",
    },
  };
}

export function buildRuntimeBoundaryDecisionPlan(options: RuntimeBoundaryDecisionOptions = Object()): RuntimeBoundaryDecisionPlan {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const targetExport = options.targetExport || options.target_export || "./runtime";
  return {
    schema_version: RUNTIME_BOUNDARY_DECISION_SCHEMA_VERSION,
    schema: "yolo.release.runtime_boundary_decision_plan.v1",
    yolo_root: yoloRoot,
    target_export: targetExport,
    current_tier_expected: "experimental",
    proposed_tier: "stable",
    writes_workspace: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    applies_boundary_change: false,
    requires_human_approval: true,
    required_evidence: [
      "runtime boundary candidate is ready_for_decision",
      "human approval record names the target export and stable tier",
      "stability review is complete",
      "rollback plan is approved and linked",
    ],
    stop_conditions: [
      "runtime boundary candidate has implementation or API boundary blockers",
      "approval record is missing, malformed, or does not target ./runtime",
      "stable tier is applied before this decision record exists",
      "rollback plan is missing",
    ],
  };
}

export function runRuntimeBoundaryDecisionGate(options: RuntimeBoundaryDecisionOptions = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const plan = options.plan || buildRuntimeBoundaryDecisionPlan({
    yoloRoot,
    targetExport: options.targetExport || options.target_export,
  });
  const candidate = (options.candidate || options.runtimeBoundaryCandidate || options.runtime_boundary_candidate || inspectRuntimeBoundaryCandidate({
    yoloRoot,
    targetExport: plan.target_export,
    expectedTarget: options.expectedTarget || options.expected_target,
    packageJson: options.packageJson,
    apiBoundary: options.apiBoundary || options.api_boundary,
    runtimeApiFreeze: options.runtimeApiFreeze || options.runtime_api_freeze,
    inspectRunnerRuntimeApiFreeze: options.inspectRunnerRuntimeApiFreeze,
    maxRunnerCoreLines: options.maxRunnerCoreLines || options.max_runner_core_lines,
  })) as RuntimeBoundaryCandidateResult;
  const decisionRecord = options.decisionRecord || options.decision_record || null;
  const candidateSummary: RuntimeBoundaryCandidateSummary = candidate.candidate || {};
  const approved = decisionApproved(decisionRecord, candidateSummary);

  const checks = [
    check(
      "RUNTIME_BOUNDARY_DECISION_NO_SIDE_EFFECTS",
      plan.writes_workspace === false
        && plan.publishes === false
        && plan.reads_credentials === false
        && plan.spawns_provider === false
        && plan.executes_billable_provider === false
        && plan.applies_boundary_change === false,
      "runtime boundary decision gate must not mutate public API docs, publish, read credentials, or execute providers",
    ),
    check(
      "RUNTIME_BOUNDARY_DECISION_CANDIDATE_READY",
      candidate.status === "ready_for_decision",
      "runtime boundary candidate must be ready before a stable-boundary approval can be accepted",
      { candidate_status: candidate.status, candidate_blockers: (candidate.blockers || []).map((item) => item.code) },
    ),
    check(
      "RUNTIME_BOUNDARY_DECISION_RECORD_PRESENT",
      isObject(decisionRecord),
      "stable runtime promotion requires an explicit human decision record",
    ),
    check(
      "RUNTIME_BOUNDARY_DECISION_APPROVED",
      approved,
      "human decision record must approve ./runtime experimental -> stable promotion and include a rollback plan",
      { decision_record: decisionRecord || null },
    ),
  ];
  const blockers = checks.filter((item) => item.passed !== true);

  return {
    schema_version: RUNTIME_BOUNDARY_DECISION_SCHEMA_VERSION,
    schema: "yolo.release.runtime_boundary_decision_result.v1",
    status: blockers.length === 0 ? "ready_to_apply" : "blocked",
    yolo_root: yoloRoot,
    candidate: candidateSummary,
    decision: {
      required: true,
      approved,
      record: decisionRecord,
    },
    checks,
    blockers,
    components: {
      runtime_boundary_candidate: candidate,
    },
    plan,
    suggested_changes: blockers.length === 0 ? candidate.suggested_changes || [] : [],
    guarantees: {
      writes_workspace: false,
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      boundary_changed: false,
      stable_runtime_declared: false,
    },
    next_actions: blockers.length === 0
      ? ["Apply the approved boundary/doc changes in a separate reviewed patch; this gate intentionally does not edit them."]
      : ["Resolve candidate blockers or attach an explicit human runtime stable-boundary approval record."],
    ...(blockers.length > 0 ? { decision_record_template: buildRuntimeBoundaryDecisionRecordTemplate(plan.target_export) } : {}),
  };
}
