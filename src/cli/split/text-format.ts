// Plain-text output formatters for CLI results.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

import { formatProjectSetupText } from "../../core/setup.js";
import { coverageCounts } from "./interview-helpers.js";

// Formatters receive heterogeneous runtime result objects. Only string-typed
// fields are surfaced in text output; everything else passes through. Reads are
// narrowed inline (Array.isArray / typeof) where array/iteration is needed.
type TextResult = Record<string, unknown>;

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function assumptionList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const record = item as { message?: unknown; text?: unknown; answer?: unknown };
        return typeof record.message === "string"
          ? record.message
          : typeof record.text === "string"
            ? record.text
            : typeof record.answer === "string"
              ? record.answer
              : "";
      }
      return "";
    })
    .filter(Boolean);
}

function joinList(value: unknown, sep = ", "): string {
  return stringList(value).join(sep);
}

export function formatRunnerText(result: TextResult) {
  const lines = [`[yolo] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  if (result.run_id) lines.push(`run_id: ${result.run_id}`);
  const artifacts = joinList(result.artifacts);
  if (artifacts) lines.push(`artifacts: ${artifacts}`);

  for (const key of ["completed", "failed", "skipped", "blocked"]) {
    const joined = joinList(result[key]);
    if (joined) lines.push(`${key}: ${joined}`);
  }

  const nextActions = stringList(result.next_actions);
  if (nextActions.length) {
    lines.push("next:");
    for (const action of nextActions) lines.push(`  - ${action}`);
  }

  return lines.join("\n");
}

export function formatWorkflowPlanText(result: TextResult = {}) {
  const lines = [`[yolo ${result.workflow}] ${result.status}: ${result.summary}`];
  const plan = result.plan as { steps?: Array<{ id?: string; verification?: string }> } | undefined;
  if (plan?.steps?.length) {
    lines.push(`steps: ${plan.steps.length}`);
    for (const step of plan.steps) {
      lines.push(`  - ${step.id} ${step.verification || "manual"}`);
    }
  }
  const nextActions = stringList(result.next_actions);
  if (nextActions.length) {
    lines.push("next:");
    for (const action of nextActions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatDiscoveryRuntimeText(label: string, result: TextResult = {}) {
  const lines = [`[yolo ${label}] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  const discovery = result.discovery as { id?: string } | undefined;
  if (discovery?.id) lines.push(`discovery: ${discovery.id}`);
  const plan = result.plan as { id?: string } | undefined;
  if (plan?.id) lines.push(`plan: ${plan.id}`);
  const prd = result.prd as { id?: string } | undefined;
  if (prd?.id) lines.push(`prd: ${prd.id}`);
  const artifacts = joinList(result.artifacts);
  if (artifacts) lines.push(`artifacts: ${artifacts}`);
  const blockers = result.blockers as Array<{ code?: string; message?: string; detail?: string }> | undefined;
  if (Array.isArray(blockers) && blockers.length) {
    lines.push("blockers:");
    for (const blocker of blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.detail || ""}`.trimEnd());
  }
  const warnings = result.warnings as Array<{ code?: string; message?: string; detail?: string }> | undefined;
  if (Array.isArray(warnings) && warnings.length) {
    lines.push("warnings:");
    for (const warning of warnings) lines.push(`  - ${warning.code || "WARNING"} ${warning.message || warning.detail || ""}`.trimEnd());
  }
  const nextActions = stringList(result.next_actions);
  if (nextActions.length) {
    lines.push("next:");
    for (const action of nextActions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatDemandRuntimeText(label: string, result: TextResult = {}) {
  const lines = [`[yolo ${label}] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  if (result.profile) lines.push(`profile: ${result.profile}`);
  if (result.mode) lines.push(`mode: ${result.mode}`);
  if (result.demand_id) lines.push(`demand: ${result.demand_id}`);
  if (result.demand_dir) lines.push(`demand_dir: ${result.demand_dir}`);
  const prd = result.prd as { id?: string } | undefined;
  if (prd?.id) lines.push(`prd: ${prd.id}`);
  const draftBrief = result.draft_brief as { id?: string } | undefined;
  if (draftBrief?.id) lines.push(`draft_brief: ${draftBrief.id}`);
  const nextQuestion = result.next_question as { text?: string } | undefined;
  if (nextQuestion?.text) lines.push(`next_question: ${nextQuestion.text}`);
  const readiness = result.readiness as { readiness_level?: string; quality_score?: number } | undefined;
  if (readiness?.readiness_level) {
    lines.push(`readiness: ${readiness.readiness_level} score=${readiness.quality_score}`);
  }
  const artifacts = joinList(result.artifacts);
  if (artifacts) lines.push(`artifacts: ${artifacts}`);
  const blockers = result.blockers as Array<{ code?: string; message?: string; detail?: string }> | undefined;
  if (Array.isArray(blockers) && blockers.length) {
    lines.push("blockers:");
    for (const blocker of blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.detail || ""}`.trimEnd());
  }
  const warnings = result.warnings as Array<{ code?: string; message?: string; detail?: string }> | undefined;
  if (Array.isArray(warnings) && warnings.length) {
    lines.push("warnings:");
    for (const warning of warnings) lines.push(`  - ${warning.code || "WARNING"} ${warning.message || warning.detail || ""}`.trimEnd());
  }
  const nextActions = stringList(result.next_actions);
  if (nextActions.length) {
    lines.push("next:");
    for (const action of nextActions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatDemandStatusText(result: TextResult = {}) {
  const state = (result.state || {}) as Record<string, unknown>;
  const nextQuestion = (result.next_question || state.next_question) as {
    slot?: string; id?: string; question_id?: string;
    text?: string; plain_language_prompt?: string; message?: string; question?: string;
  } | undefined;
  const lines = [`[yolo demand status] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  if (state.stage) lines.push(`stage: ${state.stage}`);
  const triage = result.triage as Record<string, unknown> | undefined;
  lines.push(`context_type: ${state.context_type || triage?.context_type || "unknown"}`);
  lines.push(`route: ${state.route || triage?.route || "fast"}`);
  lines.push(`evidence_policy: ${state.evidence_policy || triage?.evidence_policy || "none"}`);
  lines.push(`reason_codes: ${joinList(state.reason_codes || triage?.reason_codes) || "none"}`);
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
  const missingSlots = stringList(state.missing_slots);
  if (printedQuestion && missingSlots.length) {
    lines.push(`remaining_slots: ${missingSlots.length}`);
  } else if (missingSlots.length) {
    lines.push(`missing_slots: ${missingSlots.join(", ")}`);
  }
  const assumptions = stringList(state.assumptions);
  if (assumptions.length) {
    lines.push("assumptions:");
    for (const assumption of assumptions) lines.push(`  - ${assumption}`);
  }
  const blockers = state.blockers as Array<{ code?: string; message?: string; slot?: string }> | undefined;
  if (!printedQuestion && Array.isArray(blockers) && blockers.length) {
    lines.push("blockers:");
    for (const blocker of blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.slot || ""}`.trimEnd());
  }
  const neededEvidenceAgents = stringList(state.needed_evidence_agents);
  if (!printedQuestion && neededEvidenceAgents.length) {
    lines.push(`needed_evidence_agents: ${neededEvidenceAgents.join(", ")}`);
  }
  const evidenceSummary = state.evidence_requirement_summary as {
    total?: number; pending?: number; satisfied?: number;
    pending_items?: Array<{ id?: string; kind?: string; topic?: string }>;
  } | undefined;
  if (evidenceSummary?.total && evidenceSummary.total > 0) {
    lines.push(`evidence_requirements: pending=${evidenceSummary.pending || 0} satisfied=${evidenceSummary.satisfied || 0}`);
    for (const item of evidenceSummary.pending_items || []) {
      lines.push(`  - ${item.id} ${item.kind}: ${item.topic}`);
    }
  }
  const stateNextActions = stringList(state.next_actions);
  if (stateNextActions.length > 0) {
    lines.push("next_actions:");
    for (const action of stateNextActions) lines.push(`  - ${action}`);
  }
  if (state.next_action) lines.push(`next_action: ${state.next_action}`);
  return lines.join("\n");
}

export function formatDemandDispatchText(result: TextResult = {}) {
  const lines = [`[yolo demand dispatch] ${result.status}: ${result.summary}`];
  lines.push(`mode: ${result.mode || "dry_run"}`);
  const actions = (result.actions as Array<{ role?: string }> | undefined) || [];
  lines.push(`actions: ${actions.map((action) => action.role).join(", ") || "none"}`);
  if (result.code) lines.push(`code: ${result.code}`);
  const agentResults = result.agent_results as Array<{ role?: string; status?: string; recommendation?: string }> | undefined;
  if (Array.isArray(agentResults) && agentResults.length) {
    lines.push("agent_results:");
    for (const item of agentResults) {
      lines.push(`  - ${item.role || "agent"} ${item.status || "unknown"} ${item.recommendation || ""}`.trimEnd());
    }
  }
  const readiness = result.readiness as {
    prd_intake_ready?: boolean; executable_prd_ready?: boolean;
    blockers?: Array<{ code?: string; message?: string; slot?: string }>;
  } | undefined;
  if (readiness) {
    lines.push(`prd_intake_ready: ${readiness.prd_intake_ready === true}`);
    lines.push(`executable_prd_ready: ${readiness.executable_prd_ready === true}`);
    if (Array.isArray(readiness.blockers) && readiness.blockers.length) {
      lines.push("blockers:");
      for (const blocker of readiness.blockers) {
        lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.slot || ""}`.trimEnd());
      }
    }
  }
  const artifacts = joinList(result.artifacts);
  if (artifacts) {
    lines.push(`artifacts: ${artifacts}`);
  }
  return lines.join("\n");
}

export function artifactList(artifacts: unknown): string[] {
  if (Array.isArray(artifacts)) return artifacts.filter((v): v is string => typeof v === "string" && Boolean(v));
  const entries = artifacts as Record<string, unknown> | null | undefined;
  return Object.entries(entries || {})
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}: ${value}`);
}

export function formatPiRuntimeText(label: string, result: TextResult = {}) {
  const lines = [`[yolo ${label}] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  const artifacts = artifactList(result.artifacts);
  if (artifacts.length) lines.push(`artifacts: ${artifacts.join(", ")}`);
  const nextActions = stringList(result.next_actions);
  if (nextActions.length) {
    lines.push("next:");
    for (const action of nextActions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatYoloNextText(result: TextResult = {}) {
  const lines = [`[yolo next] ${result.status}: ${result.summary}`];
  if (result.current_stage) lines.push(`current_stage: ${result.current_stage}`);
  if (result.recommended_command) lines.push(`recommended: ${result.recommended_command}`);
  if (result.reason) lines.push(`reason: ${result.reason}`);
  const nextActions = stringList(result.next_actions);
  if (nextActions.length) {
    lines.push("next:");
    for (const action of nextActions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatInitText(result: TextResult) {
  const lines = [`[yolo init] ${result.status}: ${result.summary}`, `root: ${result.project_root}`];
  for (const [label, values] of [
    ["created", result.created],
    ["overwritten", result.overwritten],
    ["skipped", result.skipped],
  ] as Array<[string, unknown]>) {
    const list = stringList(values);
    if (list.length) {
      lines.push(`${label}:`);
      for (const value of list) lines.push(`  - ${value}`);
    }
  }
  const nextActions = stringList(result.next_actions);
  if (nextActions.length) {
    lines.push("next:");
    for (const action of nextActions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatSetupText(result: TextResult = {}) {
  return formatProjectSetupText(result);
}

export function formatInstallText(result: TextResult = {}) {
  const written = stringList(result.written);
  const overwritten = stringList(result.overwritten);
  const changed = written.length + overwritten.length;
  const lines = [
    `[yolo install] ${result.status}: ${result.dry_run ? "planned YOLO agent bridge install" : "installed YOLO agent bridge"}`,
    `root: ${result.project_root}`,
    `targets: ${stringList(result.targets).join(",") || "none"}`,
    `scopes: ${stringList(result.scopes).join(",") || "none"}`,
    `changed: ${changed}`,
    `planned: ${stringList(result.planned).length}`,
    `skipped: ${stringList(result.skipped).length}`,
  ];
  if (result.total_file_count != null) lines.push(`total files: ${result.total_file_count}`);
  const nextActions = stringList(result.next_actions);
  if (nextActions.length) {
    lines.push("next:");
    for (const action of nextActions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatMemoryText(result: TextResult) {
  const written = stringList(result.written);
  const lines = [`[yolo memory] ${result.status}: refreshed ${written.length} docs`, `memory: ${result.memory_dir}`];
  const auditSummary = result.audit_summary as { document_count?: number; deletion_candidate_count?: number; stale_mirror_count?: number } | undefined;
  if (auditSummary) {
    lines.push(`audited: ${auditSummary.document_count} docs/jsonl`);
    lines.push(`delete candidates: ${auditSummary.deletion_candidate_count}`);
    lines.push(`stale mirrors: ${auditSummary.stale_mirror_count}`);
  }
  const retention = result.retention as { archived_record_count?: number; pruned_generated_archives?: { deleted_count?: number } } | undefined;
  if (retention) {
    lines.push(`archived records: ${retention.archived_record_count}`);
    lines.push(`pruned generated snapshots: ${retention.pruned_generated_archives?.deleted_count || 0}`);
  }
  const learningMigration = result.learning_migration as { total_count?: number } | undefined;
  if (learningMigration) {
    lines.push(`learning records: ${learningMigration.total_count}`);
  }
  return lines.join("\n");
}

export function formatInterviewText(label: string, result: TextResult = {}) {
  const lines = [`[yolo interview ${label}] ${result.status}: ${result.summary}`];
  if (result.session_path) lines.push(`session: ${result.session_path}`);
  if (result.demand_dir) lines.push(`demand_dir: ${result.demand_dir}`);
  if (result.demand_path) lines.push(`demand_path: ${result.demand_path}`);
  const nextQuestion = result.next_question as { id?: string; text?: string } | undefined;
  if (nextQuestion) lines.push(`next_question: ${nextQuestion.id} ${nextQuestion.text}`);
  else lines.push("next_question: none");
  const coverage = result.coverage as Record<string, unknown> | undefined;
  if (coverage) {
    const counts = coverageCounts(coverage, result.interview as Record<string, unknown>);
    lines.push(`coverage: ${counts.answered}/${counts.total} (${counts.percent}%)`);
    const coverageQuality = coverage.quality as { score?: number } | undefined;
    const coverageDetail = result.coverage_detail as {
      quality?: { score?: number };
      readiness?: { answer_quality_score?: number };
      follow_up_questions?: Array<{ slot?: string; question_id?: string; plain_language_prompt?: string; text?: string; message?: string }>;
    } | undefined;
    const answerQualityScore = coverage.answer_quality_score
      ?? coverageQuality?.score
      ?? coverageDetail?.quality?.score
      ?? coverageDetail?.readiness?.answer_quality_score;
    if (answerQualityScore != null) {
      lines.push(`answer_quality: ${answerQualityScore}`);
    }
  }
  const coverageDetail2 = result.coverage_detail as {
    follow_up_questions?: Array<{ slot?: string; question_id?: string; plain_language_prompt?: string; text?: string; message?: string }>;
    assumptions?: unknown[];
  } | undefined;
  const followUps = coverageDetail2?.follow_up_questions || (coverage?.follow_up_questions as Array<{ slot?: string; question_id?: string; plain_language_prompt?: string; text?: string; message?: string }> | undefined) || [];
  if (followUps.length) {
    lines.push("follow_up:");
    for (const followUp of followUps.slice(0, 3)) {
      lines.push(`  - ${followUp.slot || followUp.question_id}: ${followUp.plain_language_prompt || followUp.text || followUp.message}`);
    }
  }
  const interview = result.interview as { accepted_assumptions?: unknown[]; assumptions?: unknown[] } | undefined;
  const assumptions = assumptionList(coverageDetail2?.assumptions)
    .concat(assumptionList(interview?.accepted_assumptions))
    .concat(assumptionList(interview?.assumptions));
  const uniqueAssumptions = [...new Set(assumptions)];
  if (uniqueAssumptions.length) {
    lines.push("assumptions:");
    for (const assumption of uniqueAssumptions.slice(0, 3)) lines.push(`  - ${assumption}`);
  }
  const blockers = result.blockers as Array<{ code?: string; message?: string; slot?: string }> | undefined;
  if (Array.isArray(blockers) && blockers.length) {
    lines.push("blockers:");
    for (const blocker of blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.slot || ""}`.trimEnd());
  }
  const artifacts = joinList(result.artifacts);
  if (artifacts) lines.push(`artifacts: ${artifacts}`);
  const nextActions = stringList(result.next_actions);
  if (nextActions.length) {
    lines.push("next_actions:");
    for (const action of nextActions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatReleaseCandidateText(result: TextResult = {}) {
  const lines = [`[yolo ${result.command || "release-candidate"}] ${result.status}: ${result.summary}`];
  lines.push(`mode: ${result.mode || "rc"}`);
  lines.push(`gate: ${result.gate_kind || "generic_rc_gate"} (not Trello replay)`);
  lines.push(`fail_closed: ${result.fail_closed === true}`);
  const allowances = result.allowances as { untracked?: boolean; unknown?: boolean } | undefined;
  lines.push(`allow_untracked: ${allowances?.untracked === true}`);
  lines.push(`allow_unknown: ${allowances?.unknown === true}`);
  const gates = result.gates as Array<{ id?: string; status?: string }> | undefined;
  if (Array.isArray(gates) && gates.length) {
    lines.push("gates:");
    for (const gate of gates) lines.push(`  - ${gate.id} ${gate.status || "pending"}`);
  }
  const blockers = result.blockers as Array<{ code?: string; message?: string }> | undefined;
  if (Array.isArray(blockers) && blockers.length) {
    lines.push("blockers:");
    for (const blocker of blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || ""}`.trimEnd());
  }
  const issueCodes = joinList(result.issue_codes);
  if (issueCodes) {
    lines.push(`issue_codes: ${issueCodes}`);
  }
  const nextActions = stringList(result.next_actions);
  if (nextActions.length) {
    lines.push("next:");
    for (const action of nextActions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}
