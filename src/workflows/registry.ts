export const WORKFLOW_SKILL_DESCRIPTOR_SCHEMA_VERSION = "1.0";
export const WORKFLOW_SKILL_DESCRIPTOR_SCHEMA = "yolo.workflow.skill_descriptor.v1";

const WORKFLOWS = {
  demand: {
    id: "demand",
    label: "Demand router workflow",
    purpose: "Route early demand work through fast/careful triage, PRD readiness, evidence policy, and explicit evidence-agent dispatch before brainstorm, interview, discuss, plan, or PRD.",
    preset: "planner",
    triggers: ["idea.received", "demand.status.requested", "cli.yolo-demand-status"],
    inputs: ["idea?", "demandSession?", "projectFacts?", "acceptanceCriteria?", "approval?"],
    outputs: ["demand status", "dispatch plan", "agent evidence results", "context_type", "route", "evidence_policy", "missing_slots", "blockers", "needed_evidence_agents", "next_action"],
    sdk_namespaces: ["demand", "evidence", "spec"],
    phases: ["intake", "clarify", "evidence", "discuss", "requirements", "roadmap", "approval", "prd_ready"],
    verification: ["fast_by_default", "factual_evidence_policy", "risky_cross_check", "assumptions_not_facts", "status_read_only", "dispatch_explicitly_authorized"],
    entrypoints: {
      sdk: "sdk.demand.status({ objective }) / sdk.demand.dispatchEvidence({ objective, executeAgents, allowAgentDispatch })",
      cli: "yolo demand status / yolo demand dispatch",
      skill: "yolo.demand",
    },
  },
  brainstorm: {
    id: "brainstorm",
    label: "Demand brainstorm workflow",
    purpose: "Explore a new product idea before discovery by challenging demand reality, target user, status quo, assumptions, and alternatives.",
    preset: "planner",
    triggers: ["idea.received", "new_project.started", "cli.yolo-brainstorm"],
    inputs: ["idea", "targetUsers?", "statusQuo?", "evidence?", "assumptions?", "alternatives?"],
    outputs: ["VISION.md", "REFLECTION.md", "INVESTIGATION.md", "REQUIREMENTS.md", "CONTEXT.md", "ROADMAP.md", "READINESS.json"],
    sdk_namespaces: ["demand", "discovery", "evidence"],
    phases: ["vision", "reflection", "investigation", "initial_requirements", "readiness_verdict"],
    verification: ["target_user.present", "status_quo.present", "evidence_or_assumption.present", "no_code_change", "demand.artifact_graph"],
    entrypoints: {
      sdk: "sdk.workflows.createWorkflowPlan({ workflow: 'brainstorm' })",
      cli: "yolo brainstorm",
      skill: "yolo.brainstorm",
    },
  },
  interview: {
    id: "interview",
    label: "Demand interview workflow",
    purpose: "Collect non-technical requirements one question at a time before demand discussion, planning, or executable PRD generation.",
    preset: "planner",
    triggers: ["idea.received", "nontechnical_user.needs_interview", "cli.yolo-interview", "cli.yolo-interview-answer"],
    inputs: ["idea", "interviewSession?", "questionId?", "answer?", "approval?"],
    outputs: ["interview.json", "answers.jsonl", "coverage report", "demand session?", "question handoff state"],
    sdk_namespaces: ["demand", "discovery", "evidence"],
    phases: ["start", "ask_next_question", "record_answer", "coverage_check", "to_demand"],
    verification: ["one_question_at_a_time", "answers.preserved", "coverage.reported", "handoff_state.present", "no_code_change"],
    entrypoints: {
      sdk: "sdk.workflows.createWorkflowPlan({ workflow: 'interview' })",
      cli: "yolo interview",
      skill: "yolo.interview",
    },
  },
  discover: {
    id: "discover",
    label: "Discovery workflow",
    purpose: "Clarify vague ideas into a durable discovery artifact before planning, PRD generation, or code changes.",
    preset: "planner",
    triggers: ["idea.received", "requirement.unclear", "cli.yolo-discover"],
    inputs: ["idea", "problem?", "targetUsers?", "successCriteria", "constraints?", "targetFiles"],
    outputs: ["discovery.json", "project context", "requirements contract", "research decision", "traceability map", "readiness verdict"],
    sdk_namespaces: ["discovery", "project", "spec", "evidence"],
    phases: ["intake", "project_context", "requirements_contract", "research_decision", "traceability", "readiness_verdict"],
    verification: ["discovery.runtime", "success_criteria.present", "scope.present", "constraints.recorded", "unknowns.listed", "no_code_change", "evidence.append"],
    entrypoints: {
      sdk: "sdk.workflows.createWorkflowPlan({ workflow: 'discover' })",
      cli: "yolo discover",
      skill: "yolo.discover",
    },
  },
  discuss: {
    id: "discuss",
    label: "Demand discussion workflow",
    purpose: "Close the front-end demand loop through vision, reflection, investigation, questioning rounds, depth verification, and requirements confirmation.",
    preset: "planner",
    triggers: ["demand.needs_discussion", "requirement.gray_area", "cli.yolo-discuss"],
    inputs: ["idea", "evidence?", "decisions?", "targetFiles?", "approval?"],
    outputs: ["VISION.md", "REFLECTION.md", "INVESTIGATION.md", "DISCUSSION-LOG.md", "REQUIREMENTS.md", "CONTEXT.md", "ROADMAP.md", "APPROVAL.json", "READINESS.json"],
    sdk_namespaces: ["demand", "discovery", "spec", "evidence"],
    phases: ["vision", "reflection", "investigation", "questioning_rounds", "depth_verification", "requirements_confirmation", "approval_gate"],
    verification: ["vision.present", "questioning_rounds.complete", "depth_verification.pass", "requirements.confirmed", "human.approval", "no_code_change"],
    entrypoints: {
      sdk: "sdk.workflows.createWorkflowPlan({ workflow: 'discuss' })",
      cli: "yolo discuss",
      skill: "yolo.discuss",
    },
  },
  plan: {
    id: "plan",
    label: "Plan workflow",
    purpose: "Turn an approved discovery artifact into a sequenced implementation plan without changing code.",
    preset: "planner",
    triggers: ["discovery.ready", "plan.requested", "cli.yolo-plan"],
    inputs: ["discovery.json"],
    outputs: ["plan.json", "ordered requirement steps", "risk list", "traceability map"],
    sdk_namespaces: ["discovery", "project", "spec", "evidence"],
    phases: ["load_discovery", "readiness_gate", "task_breakdown", "risk_review", "gate_plan"],
    verification: ["discovery.ready_for_plan", "scope.clear", "tasks.atomic", "dependencies.listed", "risks.listed", "no_code_change"],
    entrypoints: {
      sdk: "sdk.workflows.createWorkflowPlan({ workflow: 'plan' })",
      cli: "yolo plan",
      skill: "yolo.plan",
    },
  },
  prd: {
    id: "prd",
    label: "PRD workflow",
    purpose: "Compile approved discovery and plan artifacts into executable PRD/spec contracts.",
    preset: "planner",
    triggers: ["plan.approved", "prd.requested", "cli.yolo-prd"],
    inputs: ["discovery.json", "plan.json?"],
    outputs: ["prd.json", "spec lifecycle package", "traceability map"],
    sdk_namespaces: ["discovery", "spec", "prd", "contract", "evidence"],
    phases: ["load_discovery", "compile_tasks", "contract_checks", "traceability", "human_approval_gate"],
    verification: ["discovery.ready_for_plan", "prd.schema_gate", "contract.inspect", "spec.traceability", "tasks.atomic", "human.approval"],
    entrypoints: {
      sdk: "sdk.workflows.createWorkflowPlan({ workflow: 'prd' })",
      cli: "yolo prd",
      skill: "yolo.prd",
    },
  },
  check: {
    id: "check",
    label: "Check workflow",
    purpose: "Validate PRD, product readiness, adapter readiness, tests, and execution gates before edits.",
    preset: "gatekeeper",
    triggers: ["prd.ready", "check.requested", "cli.yolo-check"],
    inputs: ["prdPath?", "planPath?", "projectRoot?"],
    outputs: ["readiness report", "blocking issues", "next safe action"],
    sdk_namespaces: ["spec", "prd", "contract", "runtime", "evidence"],
    phases: ["schema_gate", "product_readiness", "adapter_readiness", "test_readiness", "verdict"],
    verification: ["prd.preflight", "pm.readiness", "adapter.doctor", "test.plan", "fail_closed.verdict"],
    entrypoints: {
      sdk: "sdk.workflows.createWorkflowPlan({ workflow: 'check' })",
      cli: "yolo check",
      skill: "yolo.check",
    },
  },
  pi: {
    id: "pi",
    label: "Product implementation workflow",
    purpose: "Move from requirement or PRD through implementation, review, acceptance, delivery, and learning.",
    preset: "pi",
    triggers: ["requirement.received", "prd.ready", "cli.yolo-pi"],
    inputs: ["requirement?", "requirementFile?", "findingsPath?", "prdPath?"],
    outputs: ["discovery.json?", "findings.json?", "prd.json", "state/pi/<run>.json", "review report", "acceptance report", "delivery report", "learning record"],
    sdk_namespaces: ["discovery", "spec", "prd", "contract", "runtime", "review", "evidence"],
    phases: ["intake", "discovery", "findings", "prd", "preflight", "implementation", "review", "final_gate", "acceptance", "delivery", "learn"],
    verification: ["intake.source", "discovery.runtime", "discovery.readiness", "prd.generate", "prd.preflight", "runner.gates", "review.scan", "prd.schema_gate", "acceptance.verdict", "ship.verdict", "learning.record"],
    entrypoints: {
      sdk: "sdk.agents.createPiPlan",
      cli: "yolo-pi",
      skill: "yolo.pi",
    },
  },
  review: {
    id: "review",
    label: "Review workflow",
    purpose: "Scan scoped code, classify findings, and produce fix tasks without owning implementation.",
    preset: "reviewer",
    triggers: ["implementation.done", "review.requested"],
    inputs: ["projectRoot", "files?", "prdPath?"],
    outputs: ["findings", "review issues", "review fix tasks?"],
    sdk_namespaces: ["spec", "contract", "review", "evidence"],
    phases: ["scope", "scan", "classify", "report"],
    verification: ["review.scan", "contract.inspect", "evidence.append"],
    entrypoints: {
      sdk: "sdk.workflows.createWorkflowPlan({ workflow: 'review' })",
      cli: "yolo review",
      skill: "yolo.review",
    },
  },
  fix: {
    id: "fix",
    label: "Fix workflow",
    purpose: "Execute scoped PRD tasks with gates, retries, and evidence.",
    preset: "implementer",
    triggers: ["task.pending", "review.fix.pending"],
    inputs: ["prdPath", "taskId?"],
    outputs: ["task result", "gate evidence", "updated PRD"],
    sdk_namespaces: ["task", "contract", "runtime", "evidence"],
    phases: ["load_task", "pre_gate", "execute", "post_gate", "record"],
    verification: ["contract.pre_conditions", "contract.post_conditions", "diff.quality", "evidence.append"],
    entrypoints: {
      sdk: "sdk.runtime.runRunner",
      cli: "yolo --prd <prd>",
      skill: "yolo.fix",
    },
  },
  ship: {
    id: "ship",
    label: "Ship workflow",
    purpose: "Fail closed before release on weak spec, broken gates, missing evidence, or review findings.",
    preset: "gatekeeper",
    triggers: ["release.requested", "final_gate.requested"],
    inputs: ["prdPath", "runId?", "stateDir?"],
    outputs: ["ship verdict", "run report", "blocking issues"],
    sdk_namespaces: ["spec", "contract", "review", "evidence"],
    phases: ["spec_gate", "contract_gate", "review_gate", "evidence_gate", "verdict"],
    verification: ["spec.governance", "prd.preflight", "review.scan", "evidence.report"],
    entrypoints: {
      sdk: "sdk.workflows.createWorkflowPlan({ workflow: 'ship' })",
      cli: "yolo ship",
      skill: "yolo.ship",
    },
  },
  accept: {
    id: "accept",
    label: "Acceptance workflow",
    purpose: "Collect product, runtime, UI, accessibility, visual, and evidence-based acceptance results.",
    preset: "gatekeeper",
    triggers: ["implementation.reviewed", "acceptance.requested", "cli.yolo-accept", "cli.yolo-ui-review"],
    inputs: ["prdPath", "runReport?", "acceptanceManifest?"],
    outputs: ["acceptance report", "UI evidence?", "blocking issues"],
    sdk_namespaces: ["spec", "contract", "review", "evidence"],
    phases: ["criteria", "runtime_evidence", "ui_evidence", "blocker_review", "acceptance_verdict"],
    verification: ["acceptance.criteria", "runtime.evidence", "ui.readiness", "review.blockers", "fail_closed.verdict"],
    entrypoints: {
      sdk: "sdk.workflows.createWorkflowPlan({ workflow: 'accept' })",
      cli: "yolo accept",
      skill: "yolo.accept",
    },
  },
  eval: {
    id: "eval",
    label: "Eval workflow",
    purpose: "Score discovery, PRD, UI acceptance, agent command, evidence, and dogfood quality against fixed benchmark fixtures.",
    preset: "gatekeeper",
    triggers: ["benchmark.requested", "public_readiness.requested", "cli.yolo-eval"],
    inputs: ["benchmarkResults?", "baselineReport?", "projectRoot?"],
    outputs: ["benchmark report", "rubric scores", "regression verdict", "public readiness blocker list"],
    sdk_namespaces: ["eval", "evidence", "release"],
    phases: ["load_fixtures", "score_rubric", "compare_baseline", "write_evidence", "readiness_verdict"],
    verification: ["fixtures.coverage", "rubric.threshold", "regression.threshold", "evidence.append", "fail_closed.verdict"],
    entrypoints: {
      sdk: "sdk.eval.runBenchmark",
      cli: "yolo eval",
      skill: "yolo.eval",
    },
  },
  learn: {
    id: "learn",
    label: "Learning workflow",
    purpose: "Promote reusable lessons, pitfalls, and recovery patterns into bounded model-agnostic memory.",
    preset: "reviewer",
    triggers: ["run.finished", "lesson.recorded", "cli.yolo-learn"],
    inputs: ["runReport?", "reviewReport?", "lesson?"],
    outputs: ["learning record", "promotion verdict", "future prompt hint"],
    sdk_namespaces: ["evidence", "runtime", "review"],
    phases: ["collect", "deduplicate", "classify", "bound_context", "promote"],
    verification: ["lesson.relevant", "lesson.deduplicated", "context.bounded", "non_blocking", "evidence.append"],
    entrypoints: {
      sdk: "sdk.workflows.createWorkflowPlan({ workflow: 'learn' })",
      cli: "yolo learn",
      skill: "yolo.learn",
    },
  },
  doctor: {
    id: "doctor",
    label: "Doctor workflow",
    purpose: "Inspect YOLO project state, lifecycle files, command registry, and agent integration readiness without side effects.",
    preset: "gatekeeper",
    triggers: ["doctor.requested", "setup.check", "cli.yolo-doctor", "cli.yolo-init", "cli.yolo-install"],
    inputs: ["projectRoot?", "installScope?", "agentTarget?"],
    outputs: ["doctor report", "missing artifacts", "next safe action"],
    sdk_namespaces: ["project", "runtime", "evidence"],
    phases: ["project_state", "lifecycle_state", "command_registry", "agent_bridge", "verdict"],
    verification: ["no_side_effects", "lifecycle.status", "commands.present", "bridge.plan", "plain_language.next_action"],
    entrypoints: {
      sdk: "sdk.workflows.createWorkflowPlan({ workflow: 'doctor' })",
      cli: "yolo doctor",
      skill: "yolo.doctor",
    },
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function listWorkflows() {
  return Object.values(WORKFLOWS).map(clone);
}

export function getWorkflow(id = "pi") {
  const workflow = WORKFLOWS[id];
  if (!workflow) {
    throw new Error(`Unknown YOLO workflow "${id}". Available workflows: ${Object.keys(WORKFLOWS).join(", ")}`);
  }
  return clone(workflow);
}

export function createWorkflowPlan(input = {}) {
  const workflow = getWorkflow(input.workflow || input.id || "pi");
  const objective = input.objective || "";
  return {
    workflow: workflow.id,
    label: workflow.label,
    objective,
    preset: workflow.preset,
    sdk_namespaces: workflow.sdk_namespaces,
    entrypoints: workflow.entrypoints,
    steps: workflow.phases.map((phase, index) => ({
      id: `${workflow.id}.${index + 1}.${phase}`,
      phase,
      status: "pending",
      verification: workflow.verification[index] || null,
    })),
  };
}

export function workflowToSkillDescriptor(workflowInput, options = {}) {
  const workflow = typeof workflowInput === "string" ? getWorkflow(workflowInput) : getWorkflow(workflowInput.id);
  const agent = options.agent || "generic";
  return {
    schema_version: WORKFLOW_SKILL_DESCRIPTOR_SCHEMA_VERSION,
    schema: WORKFLOW_SKILL_DESCRIPTOR_SCHEMA,
    id: workflow.entrypoints.skill,
    name: workflow.label,
    workflow: workflow.id,
    agent,
    purpose: workflow.purpose,
    trigger: workflow.triggers,
    inputs: workflow.inputs,
    outputs: workflow.outputs,
    sdk_namespaces: workflow.sdk_namespaces,
    phases: workflow.phases,
    verification: workflow.verification,
    entrypoints: workflow.entrypoints,
  };
}

export function listWorkflowSkillDescriptors(options = {}) {
  return listWorkflows().map((workflow) => workflowToSkillDescriptor(workflow, options));
}
