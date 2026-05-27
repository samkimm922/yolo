import { resolve } from "node:path";
import { inspectRuntimeBoundaryCandidate } from "./runtime-boundary-candidate.js";

export const RUNTIME_BOUNDARY_DECISION_SCHEMA_VERSION = "1.0";

function check(code, passed, message, extra = {}) {
  return { code, passed, message, ...extra };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function decisionApproved(record = {}, candidate = {}) {
  const summary = isObject(record) ? record : {};
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

export function buildRuntimeBoundaryDecisionPlan(options = {}) {
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

export function runRuntimeBoundaryDecisionGate(options = {}) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const plan = options.plan || buildRuntimeBoundaryDecisionPlan({
    yoloRoot,
    targetExport: options.targetExport || options.target_export,
  });
  const candidate = options.candidate || options.runtimeBoundaryCandidate || options.runtime_boundary_candidate || inspectRuntimeBoundaryCandidate({
    yoloRoot,
    targetExport: plan.target_export,
    expectedTarget: options.expectedTarget || options.expected_target,
    packageJson: options.packageJson,
    apiBoundary: options.apiBoundary || options.api_boundary,
    runtimeApiFreeze: options.runtimeApiFreeze || options.runtime_api_freeze,
    inspectRunnerRuntimeApiFreeze: options.inspectRunnerRuntimeApiFreeze,
    maxRunnerCoreLines: options.maxRunnerCoreLines || options.max_runner_core_lines,
  });
  const decisionRecord = options.decisionRecord || options.decision_record || null;
  const candidateSummary = candidate.candidate || {};
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
  };
}
