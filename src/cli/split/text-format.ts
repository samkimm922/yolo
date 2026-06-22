// Plain-text output formatters for CLI results.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

import { formatProjectSetupText } from "../../core/setup.js";
import { coverageCounts } from "./interview-helpers.js";

export function formatRunnerText(result) {
  const lines = [`[yolo] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  if (result.run_id) lines.push(`run_id: ${result.run_id}`);
  if (result.artifacts?.length) lines.push(`artifacts: ${result.artifacts.join(", ")}`);

  for (const key of ["completed", "failed", "skipped", "blocked"]) {
    if (Array.isArray(result[key]) && result[key].length > 0) {
      lines.push(`${key}: ${result[key].join(", ")}`);
    }
  }

  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }

  return lines.join("\n");
}

export function formatWorkflowPlanText(result = Object()) {
  const lines = [`[yolo ${result.workflow}] ${result.status}: ${result.summary}`];
  if (result.plan?.steps?.length) {
    lines.push(`steps: ${result.plan.steps.length}`);
    for (const step of result.plan.steps) {
      lines.push(`  - ${step.id} ${step.verification || "manual"}`);
    }
  }
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatDiscoveryRuntimeText(label, result = Object()) {
  const lines = [`[yolo ${label}] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  if (result.discovery?.id) lines.push(`discovery: ${result.discovery.id}`);
  if (result.plan?.id) lines.push(`plan: ${result.plan.id}`);
  if (result.prd?.id) lines.push(`prd: ${result.prd.id}`);
  if (result.artifacts?.length) lines.push(`artifacts: ${result.artifacts.join(", ")}`);
  if (Array.isArray(result.blockers) && result.blockers.length) {
    lines.push("blockers:");
    for (const blocker of result.blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.detail || ""}`.trimEnd());
  }
  if (Array.isArray(result.warnings) && result.warnings.length) {
    lines.push("warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning.code || "WARNING"} ${warning.message || warning.detail || ""}`.trimEnd());
  }
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatDemandRuntimeText(label, result = Object()) {
  const lines = [`[yolo ${label}] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  if (result.profile) lines.push(`profile: ${result.profile}`);
  if (result.mode) lines.push(`mode: ${result.mode}`);
  if (result.demand_id) lines.push(`demand: ${result.demand_id}`);
  if (result.demand_dir) lines.push(`demand_dir: ${result.demand_dir}`);
  if (result.prd?.id) lines.push(`prd: ${result.prd.id}`);
  if (result.draft_brief?.id) lines.push(`draft_brief: ${result.draft_brief.id}`);
  if (result.next_question?.text) lines.push(`next_question: ${result.next_question.text}`);
  if (result.readiness?.readiness_level) {
    lines.push(`readiness: ${result.readiness.readiness_level} score=${result.readiness.quality_score}`);
  }
  if (result.artifacts?.length) lines.push(`artifacts: ${result.artifacts.join(", ")}`);
  if (Array.isArray(result.blockers) && result.blockers.length) {
    lines.push("blockers:");
    for (const blocker of result.blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.detail || ""}`.trimEnd());
  }
  if (Array.isArray(result.warnings) && result.warnings.length) {
    lines.push("warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning.code || "WARNING"} ${warning.message || warning.detail || ""}`.trimEnd());
  }
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatDemandStatusText(result = Object()) {
  const state = result.state || {};
  const nextQuestion = result.next_question || state.next_question;
  const lines = [`[yolo demand status] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  if (state.stage) lines.push(`stage: ${state.stage}`);
  lines.push(`context_type: ${state.context_type || result.triage?.context_type || "unknown"}`);
  lines.push(`route: ${state.route || result.triage?.route || "fast"}`);
  lines.push(`evidence_policy: ${state.evidence_policy || result.triage?.evidence_policy || "none"}`);
  lines.push(`reason_codes: ${(state.reason_codes || result.triage?.reason_codes || []).join(", ") || "none"}`);
  lines.push(`prd_intake_ready: ${state.prd_intake_ready === true}`);
  lines.push(`executable_prd_ready: ${state.executable_prd_ready === true}`);
  let printedQuestion = false;
  if (nextQuestion) {
    const label = nextQuestion.slot || nextQuestion.id || nextQuestion.question_id || "next";
    const text = nextQuestion.text || nextQuestion.plain_language_prompt || nextQuestion.message || nextQuestion.question;
    if (text) {
      printedQuestion = true;
      lines.push(`next_question: ${label} ${text}`);
    }
  }
  if (printedQuestion && Array.isArray(state.missing_slots) && state.missing_slots.length) {
    lines.push(`remaining_slots: ${state.missing_slots.length}`);
  } else if (Array.isArray(state.missing_slots) && state.missing_slots.length) {
    lines.push(`missing_slots: ${state.missing_slots.join(", ")}`);
  }
  if (Array.isArray(state.assumptions) && state.assumptions.length) {
    lines.push("assumptions:");
    for (const assumption of state.assumptions) lines.push(`  - ${assumption}`);
  }
  if (!printedQuestion && Array.isArray(state.blockers) && state.blockers.length) {
    lines.push("blockers:");
    for (const blocker of state.blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.slot || ""}`.trimEnd());
  }
  if (!printedQuestion && Array.isArray(state.needed_evidence_agents) && state.needed_evidence_agents.length) {
    lines.push(`needed_evidence_agents: ${state.needed_evidence_agents.join(", ")}`);
  }
  if (state.evidence_requirement_summary?.total > 0) {
    lines.push(`evidence_requirements: pending=${state.evidence_requirement_summary.pending || 0} satisfied=${state.evidence_requirement_summary.satisfied || 0}`);
    for (const item of state.evidence_requirement_summary.pending_items || []) {
      lines.push(`  - ${item.id} ${item.kind}: ${item.topic}`);
    }
  }
  if (Array.isArray(state.next_actions) && state.next_actions.length > 0) {
    lines.push("next_actions:");
    for (const action of state.next_actions) lines.push(`  - ${action}`);
  }
  if (state.next_action) lines.push(`next_action: ${state.next_action}`);
  return lines.join("\n");
}

export function formatDemandDispatchText(result = Object()) {
  const lines = [`[yolo demand dispatch] ${result.status}: ${result.summary}`];
  lines.push(`mode: ${result.mode || "dry_run"}`);
  lines.push(`actions: ${(result.actions || []).map((action) => action.role).join(", ") || "none"}`);
  if (result.code) lines.push(`code: ${result.code}`);
  if (Array.isArray(result.agent_results) && result.agent_results.length) {
    lines.push("agent_results:");
    for (const item of result.agent_results) {
      lines.push(`  - ${item.role || "agent"} ${item.status || "unknown"} ${item.recommendation || ""}`.trimEnd());
    }
  }
  if (result.readiness) {
    lines.push(`prd_intake_ready: ${result.readiness.prd_intake_ready === true}`);
    lines.push(`executable_prd_ready: ${result.readiness.executable_prd_ready === true}`);
    if (Array.isArray(result.readiness.blockers) && result.readiness.blockers.length) {
      lines.push("blockers:");
      for (const blocker of result.readiness.blockers) {
        lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.slot || ""}`.trimEnd());
      }
    }
  }
  if (Array.isArray(result.artifacts) && result.artifacts.length) {
    lines.push(`artifacts: ${result.artifacts.join(", ")}`);
  }
  return lines.join("\n");
}

export function artifactList(artifacts) {
  if (Array.isArray(artifacts)) return artifacts.filter(Boolean);
  return Object.entries(artifacts || {})
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}: ${value}`);
}

export function formatPiRuntimeText(label, result = Object()) {
  const lines = [`[yolo ${label}] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  const artifacts = artifactList(result.artifacts);
  if (artifacts.length) lines.push(`artifacts: ${artifacts.join(", ")}`);
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatYoloNextText(result = Object()) {
  const lines = [`[yolo next] ${result.status}: ${result.summary}`];
  if (result.current_stage) lines.push(`current_stage: ${result.current_stage}`);
  if (result.recommended_command) lines.push(`recommended: ${result.recommended_command}`);
  if (result.reason) lines.push(`reason: ${result.reason}`);
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatInitText(result) {
  const lines = [`[yolo init] ${result.status}: ${result.summary}`, `root: ${result.project_root}`];
  for (const [label, values] of [
    ["created", result.created],
    ["overwritten", result.overwritten],
    ["skipped", result.skipped],
  ]) {
    if (values?.length) {
      lines.push(`${label}:`);
      for (const value of values) lines.push(`  - ${value}`);
    }
  }
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatSetupText(result = Object()) {
  return formatProjectSetupText(result);
}

export function formatInstallText(result = Object()) {
  const changed = (result.written?.length || 0) + (result.overwritten?.length || 0);
  const lines = [
    `[yolo install] ${result.status}: ${result.dry_run ? "planned YOLO agent bridge install" : "installed YOLO agent bridge"}`,
    `root: ${result.project_root}`,
    `targets: ${(result.targets || []).join(",") || "none"}`,
    `scopes: ${(result.scopes || []).join(",") || "none"}`,
    `changed: ${changed}`,
    `planned: ${result.planned?.length || 0}`,
    `skipped: ${result.skipped?.length || 0}`,
  ];
  if (result.total_file_count != null) lines.push(`total files: ${result.total_file_count}`);
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatMemoryText(result) {
  const lines = [`[yolo memory] ${result.status}: refreshed ${result.written?.length || 0} docs`, `memory: ${result.memory_dir}`];
  if (result.audit_summary) {
    lines.push(`audited: ${result.audit_summary.document_count} docs/jsonl`);
    lines.push(`delete candidates: ${result.audit_summary.deletion_candidate_count}`);
    lines.push(`stale mirrors: ${result.audit_summary.stale_mirror_count}`);
  }
  if (result.retention) {
    lines.push(`archived records: ${result.retention.archived_record_count}`);
    lines.push(`pruned generated snapshots: ${result.retention.pruned_generated_archives?.deleted_count || 0}`);
  }
  if (result.learning_migration) {
    lines.push(`learning records: ${result.learning_migration.total_count}`);
  }
  return lines.join("\n");
}

export function formatInterviewText(label, result = Object()) {
  const lines = [`[yolo interview ${label}] ${result.status}: ${result.summary}`];
  if (result.session_path) lines.push(`session: ${result.session_path}`);
  if (result.demand_dir) lines.push(`demand_dir: ${result.demand_dir}`);
  if (result.demand_path) lines.push(`demand_path: ${result.demand_path}`);
  if (result.next_question) lines.push(`next_question: ${result.next_question.id} ${result.next_question.text}`);
  else lines.push("next_question: none");
  if (result.coverage) {
    const counts = coverageCounts(result.coverage, result.interview);
    lines.push(`coverage: ${counts.answered}/${counts.total} (${counts.percent}%)`);
    const answerQualityScore = result.coverage.answer_quality_score
      ?? result.coverage.quality?.score
      ?? result.coverage_detail?.quality?.score
      ?? result.coverage_detail?.readiness?.answer_quality_score;
    if (answerQualityScore != null) {
      lines.push(`answer_quality: ${answerQualityScore}`);
    }
  }
  const followUps = result.coverage_detail?.follow_up_questions || result.coverage?.follow_up_questions || [];
  if (followUps.length) {
    lines.push("follow_up:");
    for (const followUp of followUps.slice(0, 3)) {
      lines.push(`  - ${followUp.slot || followUp.question_id}: ${followUp.plain_language_prompt || followUp.text || followUp.message}`);
    }
  }
  if (Array.isArray(result.blockers) && result.blockers.length) {
    lines.push("blockers:");
    for (const blocker of result.blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.slot || ""}`.trimEnd());
  }
  if (result.artifacts?.length) lines.push(`artifacts: ${result.artifacts.join(", ")}`);
  if (result.next_actions?.length) {
    lines.push("next_actions:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatReleaseCandidateText(result = Object()) {
  const lines = [`[yolo ${result.command || "release-candidate"}] ${result.status}: ${result.summary}`];
  lines.push(`mode: ${result.mode || "rc"}`);
  lines.push(`gate: ${result.gate_kind || "generic_rc_gate"} (not Trello replay)`);
  lines.push(`fail_closed: ${result.fail_closed === true}`);
  lines.push(`allow_untracked: ${result.allowances?.untracked === true}`);
  lines.push(`allow_unknown: ${result.allowances?.unknown === true}`);
  if (Array.isArray(result.gates) && result.gates.length) {
    lines.push("gates:");
    for (const gate of result.gates) lines.push(`  - ${gate.id} ${gate.status || "pending"}`);
  }
  if (Array.isArray(result.blockers) && result.blockers.length) {
    lines.push("blockers:");
    for (const blocker of result.blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || ""}`.trimEnd());
  }
  if (Array.isArray(result.issue_codes) && result.issue_codes.length) {
    lines.push(`issue_codes: ${result.issue_codes.join(", ")}`);
  }
  if (Array.isArray(result.next_actions) && result.next_actions.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}
