export const TEAM_AGENT_CONTRACT_SCHEMA_VERSION = "1.0";
export const TEAM_AGENT_CONTRACT_SCHEMA = "yolo.team.agent_contract.v1";
export const TEAM_DISPATCH_PLAN_SCHEMA = "yolo.team.dispatch_plan.v1";

export const TEAM_AGENT_CONTRACTS = [
  {
    id: "pi-agent",
    label: "PI Orchestrator",
    purpose: "Own lifecycle routing, stop conditions, and evidence handoff across the full idea-to-learn flow.",
    lifecycle_stages: ["idea", "discovery", "roadmap", "prd", "check", "run", "review-fix", "acceptance", "delivery", "learn"],
    may_edit_code: false,
    owns: ["lifecycle_state", "team_dispatch", "stop_conditions"],
    inputs: ["user_intent", "project_context", "existing_artifacts?"],
    outputs: ["dispatch_plan", "next_safe_action", "handoff_summary"],
    stop_conditions: ["missing_input", "needs_discovery", "weak_prd", "gate_failure", "provider_authorization_required"],
  },
  {
    id: "discovery-agent",
    label: "Discovery Agent",
    purpose: "Clarify vague ideas before planning, PRD generation, or implementation.",
    lifecycle_stages: ["idea", "discovery"],
    may_edit_code: false,
    owns: ["discovery_brief", "open_questions", "readiness_verdict"],
    inputs: ["idea", "project_context?"],
    outputs: ["discovery_brief", "ready_for_plan"],
    stop_conditions: ["problem_unclear", "success_criteria_missing", "scope_unknown"],
  },
  {
    id: "planner-agent",
    label: "Planner Agent",
    purpose: "Turn clarified requirements into sequenced implementation plans and task graphs.",
    lifecycle_stages: ["roadmap", "task-graph"],
    may_edit_code: false,
    owns: ["implementation_plan", "task_graph", "risk_review"],
    inputs: ["discovery_brief", "project_context"],
    outputs: ["plan", "task_graph", "risk_register"],
    stop_conditions: ["discovery_not_ready", "dependencies_unknown", "task_too_large"],
  },
  {
    id: "spec-agent",
    label: "Spec Agent",
    purpose: "Compile approved discovery and plan artifacts into executable PRD/spec contracts.",
    lifecycle_stages: ["prd", "check"],
    may_edit_code: false,
    owns: ["prd", "spec_lifecycle", "traceability", "contract_gate"],
    inputs: ["approved_plan", "discovery_brief"],
    outputs: ["prd_json", "traceability_map", "preflight_report"],
    stop_conditions: ["approval_missing", "target_coverage_missing", "postconditions_weak"],
  },
  {
    id: "implementer-agent",
    label: "Implementer Agent",
    purpose: "Execute only approved PRD tasks inside scoped worktrees with gates and evidence.",
    lifecycle_stages: ["run", "review-fix"],
    may_edit_code: true,
    owns: ["scoped_diff", "task_evidence", "gate_results"],
    inputs: ["checked_prd", "task_scope", "provider_contract"],
    outputs: ["implementation_result", "changed_files", "gate_evidence"],
    stop_conditions: ["scope_violation", "test_failure", "provider_failure", "gate_failure"],
  },
  {
    id: "reviewer-agent",
    label: "Reviewer Agent",
    purpose: "Review implementation quality and convert findings into scoped fix tasks.",
    lifecycle_stages: ["review-fix"],
    may_edit_code: false,
    owns: ["review_findings", "fix_tasks", "quality_risk"],
    inputs: ["prd", "changed_files", "run_report"],
    outputs: ["review_report", "fix_prd?", "blocking_findings"],
    stop_conditions: ["critical_findings", "missing_evidence", "scope_unclear"],
  },
  {
    id: "qa-agent",
    label: "QA Agent",
    purpose: "Collect acceptance, runtime, UI, accessibility, and visual evidence before delivery.",
    lifecycle_stages: ["acceptance"],
    may_edit_code: false,
    owns: ["acceptance_report", "ui_evidence", "runtime_evidence"],
    inputs: ["prd", "run_report", "review_report"],
    outputs: ["acceptance_verdict", "evidence_refs", "remaining_blockers"],
    stop_conditions: ["acceptance_missing", "ui_evidence_missing", "runtime_error"],
  },
  {
    id: "release-agent",
    label: "Release Agent",
    purpose: "Prepare delivery evidence, rollback notes, and release readiness without publishing by default.",
    lifecycle_stages: ["delivery"],
    may_edit_code: false,
    owns: ["ship_verdict", "rollback_notes", "handoff"],
    inputs: ["acceptance_report", "release_policy"],
    outputs: ["delivery_report", "ship_verdict", "operator_actions"],
    stop_conditions: ["release_blocker", "operator_approval_required", "rollback_missing"],
  },
  {
    id: "learning-agent",
    label: "Learning Agent",
    purpose: "Promote reusable lessons into bounded, model-agnostic memory without blocking future work by default.",
    lifecycle_stages: ["learn"],
    may_edit_code: false,
    owns: ["learning_record", "retrospective", "experience_pack"],
    inputs: ["run_report", "failure_report?", "human_note?"],
    outputs: ["learning_record", "promotion_verdict", "future_hint"],
    stop_conditions: ["lesson_unrelated", "lesson_duplicate", "not_machine_verifiable"],
  },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null || value === "") return [];
  return [value];
}

function runtimeBindings(options = {}) {
  const raw = options.runtimeBindings || options.runtime_bindings || {};
  if (Array.isArray(raw)) {
    return Object.fromEntries(raw
      .filter((binding) => binding?.agent_id || binding?.agentId || binding?.id)
      .map((binding) => [clean(binding.agent_id || binding.agentId || binding.id), binding]));
  }
  return raw && typeof raw === "object" ? raw : {};
}

function evidenceOnlyRoles(options = {}, selected = []) {
  const explicit = asArray(options.evidenceOnlyRoles || options.evidence_only_roles).map(clean);
  if (explicit.length > 0) return new Set(explicit);
  const executable = options.executable === true || clean(options.mode || options.executionMode || options.execution_mode) === "execute";
  return executable ? new Set() : new Set(selected.map((agent) => agent.id));
}

function normalizeRuntimeBinding(agent, bindings = {}) {
  const binding = bindings[agent.id] || bindings[agent.label] || null;
  if (!binding) return null;
  if (typeof binding === "string") {
    return {
      runtime: binding,
      provider: null,
      evidence_output: null,
    };
  }
  return {
    runtime: clean(binding.runtime || binding.adapter || binding.command || binding.provider || "external"),
    provider: clean(binding.provider || ""),
    evidence_output: clean(binding.evidence_output || binding.evidenceOutput || ""),
  };
}

export function listTeamAgentContracts() {
  return TEAM_AGENT_CONTRACTS.map(clone);
}

export function getTeamAgentContract(id = "pi-agent") {
  const normalized = clean(id);
  const contract = TEAM_AGENT_CONTRACTS.find((item) => item.id === normalized);
  if (!contract) {
    throw new Error(`Unknown YOLO team agent "${id}". Available agents: ${TEAM_AGENT_CONTRACTS.map((item) => item.id).join(", ")}`);
  }
  return clone(contract);
}

export function validateTeamAgentContract(contract = {}) {
  const errors = [];
  for (const field of ["id", "label", "purpose"]) {
    if (!clean(contract[field])) errors.push({ code: "TEAM_AGENT_FIELD_MISSING", field, message: `${field} is required` });
  }
  for (const field of ["lifecycle_stages", "owns", "inputs", "outputs", "stop_conditions"]) {
    if (!Array.isArray(contract[field]) || contract[field].length === 0) {
      errors.push({ code: "TEAM_AGENT_ARRAY_EMPTY", field, message: `${field} must be a non-empty array` });
    }
  }
  if (typeof contract.may_edit_code !== "boolean") {
    errors.push({ code: "TEAM_AGENT_EDIT_POLICY_MISSING", field: "may_edit_code", message: "may_edit_code must be explicit" });
  }
  return {
    status: errors.length > 0 ? "invalid" : "pass",
    valid: errors.length === 0,
    contract_id: contract.id || null,
    errors,
  };
}

export function agentsForLifecycleStage(stageId = "idea") {
  const stage = clean(stageId);
  return TEAM_AGENT_CONTRACTS
    .filter((contract) => contract.lifecycle_stages.includes(stage))
    .map(clone);
}

export function buildTeamDispatchPlan(options = {}) {
  const currentStage = clean(options.currentStage || options.current_stage || "idea");
  const objective = clean(options.objective);
  const agents = agentsForLifecycleStage(currentStage);
  const pi = getTeamAgentContract("pi-agent");
  const selected = agents.some((agent) => agent.id === pi.id) ? agents : [pi, ...agents];
  const executableRequested = options.executable === true || clean(options.mode || options.executionMode || options.execution_mode) === "execute";
  const bindings = runtimeBindings(options);
  const evidenceOnly = evidenceOnlyRoles(options, selected);
  const resolvedAgents = selected.map((agent) => {
    const runtimeBinding = normalizeRuntimeBinding(agent, bindings);
    const isEvidenceOnly = evidenceOnly.has(agent.id);
    return {
      id: agent.id,
      label: agent.label,
      may_edit_code: agent.may_edit_code,
      owns: agent.owns,
      stop_conditions: agent.stop_conditions,
      runtime_binding: runtimeBinding,
      evidence_only: isEvidenceOnly,
      binding_status: runtimeBinding ? "bound" : isEvidenceOnly ? "evidence_only" : "unresolved",
      executable: executableRequested && Boolean(runtimeBinding) && !isEvidenceOnly,
    };
  });
  const unresolved = resolvedAgents.filter((agent) => agent.binding_status === "unresolved");
  const executableAgents = resolvedAgents.filter((agent) => agent.executable);
  return {
    schema_version: TEAM_AGENT_CONTRACT_SCHEMA_VERSION,
    schema: TEAM_DISPATCH_PLAN_SCHEMA,
    status: unresolved.length > 0 ? "blocked" : executableRequested ? "pass" : "evidence_only",
    executable: executableRequested && unresolved.length === 0,
    objective,
    current_stage: currentStage,
    agents: resolvedAgents,
    executable_agents: executableAgents.map((agent) => agent.id),
    unresolved_roles: unresolved.map((agent) => ({
      agent_id: agent.id,
      label: agent.label,
      reason: "runtime_binding_or_explicit_evidence_only_required",
    })),
    blockers: unresolved.map((agent) => ({
      code: "TEAM_AGENT_RUNTIME_BINDING_REQUIRED",
      agent_id: agent.id,
      message: "Executable team dispatch requires each role to have a runtime binding or explicit evidence_only status.",
    })),
    handoffs: selected.map((agent, index) => ({
      order: index + 1,
      agent_id: agent.id,
      requires: agent.inputs,
      produces: agent.outputs,
    })),
    edit_authority: {
      code_writing_agents: executableAgents.filter((agent) => agent.may_edit_code).map((agent) => agent.id),
      potential_code_writing_agents: selected.filter((agent) => agent.may_edit_code).map((agent) => agent.id),
      requires_explicit_user_confirmation: executableAgents.some((agent) => agent.may_edit_code),
    },
  };
}
