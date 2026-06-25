import type {
  PrdCondition,
  PrdDocument,
  PrdScope,
  PrdTask,
  UnknownRecord,
} from "../prd/condition-catalog.js";

export const DEMAND_GRAPH_SCHEMA_VERSION = "1.0";
export const DEMAND_GRAPH_SCHEMA = "yolo.demand.artifact_graph.v1";

export interface DemandArtifactNode {
  id: string;
  generates: string;
  description: string;
  requires: string[];
}

export interface DemandArtifactGraphNode extends DemandArtifactNode {
  status: "done" | "ready" | "blocked";
  missing_dependencies: string[];
}

export type DemandRecord = UnknownRecord;
export type DemandValue = unknown;
export type DemandTextInput = unknown;
export type DemandStringListInput = string | string[] | readonly string[] | null | undefined;
export type DemandMaybeArray<T> = T | T[] | readonly T[] | null | undefined;

export interface DemandArtifactGraph extends DemandRecord {
  schema_version?: string;
  schema?: string;
  build_order?: string[];
  completed?: string[];
  ready?: string[];
  blocked?: Record<string, string[]>;
  artifacts?: DemandArtifactGraphNode[];
}

export interface DemandProject extends DemandRecord {
  title?: DemandTextInput;
  target_users?: string[];
  target_files?: string[];
  candidate_target_files?: string[];
  target_file_facts?: DemandTargetFileFact[];
}

export interface DemandVision extends DemandRecord {
  statement?: DemandTextInput;
  idea?: DemandTextInput;
  problem?: DemandTextInput;
  target_users?: string[];
  status_quo?: DemandTextInput;
  success_criteria?: string[];
}

export interface DemandRequirement extends DemandRecord {
  id?: string;
  title?: DemandTextInput;
  text?: DemandTextInput;
  description?: DemandTextInput;
  goal?: DemandTextInput;
  user_story?: DemandTextInput;
  status?: string;
  source?: string;
  acceptance_criteria?: string[];
  acceptance_scenarios?: Array<DemandScenario | DemandRecord | string>;
  scenarios?: Array<DemandScenario | DemandRecord | string>;
}

export interface DemandRequirementsState extends DemandRecord {
  active?: DemandRequirement[];
  constraints?: string[];
  out_of_scope?: string[];
  scope_in?: string[];
}

export interface DemandScenarioSurface extends DemandRecord {
  id?: string;
  kind?: string;
  label?: string;
  user_visible?: boolean;
  target_files?: string[];
  readonly_files?: string[];
  allow_new_files?: boolean;
  visual_style?: DemandTextInput;
  visual_style_source?: string[];
  proof?: DemandTextInput;
  verification_hint?: DemandTextInput;
  session_budget?: DemandSessionBudget;
  grounding_source?: string;
}

export interface DemandSessionBudget extends DemandRecord {
  expected?: string;
  max_files?: number | string;
  max_lines_per_file?: number | string;
}

export interface DemandScenario extends DemandRecord {
  id?: string;
  requirement_id?: string;
  actor?: string;
  title?: DemandTextInput;
  text?: DemandTextInput;
  current_behavior?: DemandTextInput;
  desired_behavior?: DemandTextInput;
  proof?: DemandTextInput;
  acceptance?: DemandTextInput;
  then?: DemandTextInput;
  trigger?: DemandTextInput;
  touchpoint?: DemandTextInput;
  visual_style?: DemandTextInput;
  visual_style_source?: DemandStringListInput;
  out_of_scope?: string[];
  constraints?: string[];
  exceptions?: string[];
  surfaces?: DemandScenarioSurface[];
  question_trace?: string[];
  source_question_ids?: string[];
}

export interface DemandScenarioMatrix extends DemandRecord {
  scenarios?: DemandScenario[];
}

export interface DemandProjectFacts extends DemandRecord {
  schema?: string;
  target_files?: DemandTargetFileFact[];
  candidate_target_files?: string[];
  assumptions?: Array<DemandAssumptionFact | string>;
  grounding?: DemandRecord & { mode?: DemandTextInput; reason?: DemandTextInput };
  policy?: DemandRecord & {
    greenfield_new_files_are_execution_scope?: boolean;
    inferred_files_are_execution_scope?: boolean;
    unverified_project_facts_block_prd?: boolean;
    user_approval_cannot_override_fact_conflicts?: boolean;
  };
}

export interface DemandTargetFileFact extends DemandRecord {
  file?: string;
  path?: string;
  status?: string;
  source?: string;
  reason?: string;
  evidence?: string[];
  message?: string;
  new_file?: boolean;
  allow_new_files?: boolean;
  exists?: boolean;
  kind?: string;
}

export interface DemandAssumptionFact extends DemandRecord {
  id?: string;
  text?: DemandTextInput;
  summary?: DemandTextInput;
  claim?: DemandTextInput;
  status?: string;
  source?: string;
  verified_by?: string | string[];
}

export interface DemandInvestigation extends DemandRecord {
  evidence?: string[] | DemandEvidenceRecord[];
  evidence_results?: DemandEvidenceResult[];
  evidenceResults?: DemandEvidenceResult[];
  agent_results?: DemandEvidenceResult[];
  agentResults?: DemandEvidenceResult[];
  evidence_agents?: DemandEvidenceResult[];
  evidenceAgents?: DemandEvidenceResult[];
  assumptions?: DemandAssumptionFact[];
  risks?: string[];
  external_research_attempted?: boolean;
  externalResearchAttempted?: boolean;
}

export interface DemandDiscussion extends DemandRecord {
  rounds?: DemandRecord[];
  questions?: DemandRecord[];
  open_questions?: string[];
  decisions?: DemandDecision[];
  deferred?: string[];
  deferred_scope_confirmation?: DemandDeferredScopeConfirmation;
}

export interface DemandOpenQuestion extends DemandRecord {
  text?: DemandTextInput;
  question?: DemandTextInput;
  message?: DemandTextInput;
  blocking?: boolean;
}

export interface DemandDecision extends DemandRecord {
  text: string;
  slot?: string;
  question_id?: string;
  answer?: DemandTextInput;
}

export interface DemandInterviewCoverageSnapshot extends DemandRecord {
  answered_slots?: string[];
  quality?: DemandRecord & { low_quality_slots?: string[] };
  answer_quality?: DemandRecord[];
  follow_up_questions?: DemandBlockerLike[];
  follow_up_plan?: DemandRecord & { status?: string };
  warnings?: DemandBlockerLike[];
}

export interface DemandInterviewSnapshot extends DemandRecord {
  coverage?: DemandInterviewCoverageSnapshot;
}

export interface DemandDeferredScopeConfirmation extends DemandRecord {
  required?: boolean;
  confirmed?: boolean;
  items?: string[];
  status?: string;
}

export interface DemandApproval extends DemandRecord {
  approved?: boolean;
  approve?: boolean;
  approved_by?: string;
  approved_at?: string | null;
  reason?: DemandTextInput;
  answer?: DemandTextInput;
  answered_at?: string | null;
  effective_for_prd?: boolean;
  blocked_by?: DemandBlockerLike[];
}

export interface DemandBlockerLike extends DemandRecord {
  code?: string;
  id?: string;
  slot?: string;
  field?: string;
  role?: string;
  message?: string;
  text?: string;
  summary?: string;
  reason?: string;
  status?: string;
  cleared?: boolean;
  resolved?: boolean;
  evidence_requirement_id?: string;
  topic?: string;
  fact_grounding_issues?: DemandBlockerLike[];
}

export interface DemandCheckLike extends DemandBlockerLike {
  passed?: boolean;
  severity?: string;
  points?: number;
}

export interface DemandReadinessReport extends DemandRecord {
  status?: string;
  readiness_level?: string;
  executable_prd_ready?: boolean;
  prd_intake_ready?: boolean;
  blockers?: DemandBlockerLike[];
  warnings?: DemandBlockerLike[];
  evidence_requirements?: DemandEvidenceRequirementLike[];
  next_actions?: string[];
}

export interface DemandEvidenceRequirementLike {
  id?: string;
  kind?: string;
  status?: string;
}

export interface DemandQualityReport extends DemandRecord {
  status?: string;
  total_score?: number;
  dimensions?: DemandRecord[];
  blockers?: DemandBlockerLike[];
  warnings?: DemandBlockerLike[];
  next_actions?: string[];
}

export interface DemandTaskHandoff extends DemandRecord {
  type?: string;
  plain_language_goal?: string;
  current_behavior?: string;
  desired_behavior?: string;
  proof?: string;
  touchpoint?: string;
  trigger?: string;
  verification_hint?: string;
  source_question_ids?: string[];
  read_first?: string[];
  key_interfaces?: string[];
  acceptance_criteria?: string[];
  deferred_scope?: string[];
  deferred_scope_confirmation?: DemandDeferredScopeConfirmation;
  deferred_follow_up?: DemandDeferredFollowUp;
  surface?: DemandScenarioSurface;
  state_matrix?: DemandRecord[];
  evidence_plan?: DemandRecord[];
  evidence_chain?: DemandRecord & {
    demand_id?: string;
    scenario_id?: string;
    surface_id?: string;
  };
  session?: DemandTaskSessionPlan;
}

export interface DemandTaskSessionPlan extends DemandRecord {
  schema?: string;
  session_id?: string;
  task_id?: string;
  demand_id?: string;
  state_path?: string;
  handoff_path?: string;
  evidence_path?: string;
  memory_update_paths?: string[];
  progress_update_path?: string;
  resume_instructions?: string;
}

export interface DemandTask extends Omit<PrdTask, "handoff" | "scope"> {
  id?: string;
  title?: string;
  description?: string;
  type?: string;
  task_kind?: string;
  requirement_ids?: string[];
  handoff?: DemandTaskHandoff;
  scope?: PrdScope & { max_files?: number; targets?: Array<{ file?: string }> };
  proof?: string;
  verification_hint?: string;
  session_plan?: DemandTaskSessionPlan;
  source_question_ids?: string[];
  trace?: DemandRecord & { source_question_ids?: DemandStringListInput };
  session?: DemandTaskSessionPlan;
  depends_on?: string[];
  post_conditions?: PrdCondition[];
  state_matrix?: DemandRecord[];
  evidence_plan?: DemandRecord[];
}

export interface DemandEvidenceRecord extends DemandRecord {
  path?: string;
  file?: string;
  file_path?: string;
  filename?: string;
  url?: string;
  href?: string;
  link?: string;
  line?: string | number;
  scope?: string;
  evidence_scope?: string;
  source_scope?: string;
  source?: string;
  source_type?: string;
  category?: string;
  kind?: string;
  type?: string;
  summary?: DemandTextInput;
  text?: DemandTextInput;
  title?: DemandTextInput;
  claim?: DemandTextInput;
  why?: DemandTextInput;
  covers?: DemandStringListInput;
  covered_requirements?: DemandStringListInput;
  covered_requirement_ids?: DemandStringListInput;
  requirement_ids?: DemandStringListInput;
  requirement_id?: string;
}

export interface DemandEvidenceResult extends DemandRecord {
  schema_version?: string;
  schema?: string;
  role?: string;
  agent?: string;
  agent_role?: string;
  agentRole?: string;
  name?: string;
  status?: string;
  state?: string;
  completed_status?: string;
  completed?: boolean;
  complete?: boolean;
  success?: boolean;
  claim?: DemandTextInput;
  confidence?: string;
  evidence?: Array<DemandEvidenceRecord | string>;
  sources?: Array<DemandEvidenceRecord | string>;
  findings?: Array<DemandEvidenceRecord | string>;
  claims?: string[];
  assumptions?: string[];
  risks?: string[];
  missing?: string[];
  recommendation?: string;
  verdict?: string;
  result?: DemandEvidenceResultPayload;
  output?: DemandEvidenceResultPayload;
  error_code?: string;
}

export interface DemandEvidenceResultPayload extends DemandRecord {
  evidence?: Array<DemandEvidenceRecord | string>;
  sources?: Array<DemandEvidenceRecord | string>;
  findings?: Array<DemandEvidenceRecord | string>;
  missing?: string[];
  recommendation?: string;
  verdict?: string;
  error_code?: string;
}

export interface DemandSession extends DemandRecord {
  schema?: string;
  schema_version?: string;
  id?: string;
  demand_id?: string;
  demandId?: string;
  generated_at?: string;
  updated_at?: string;
  phase?: string;
  source?: string;
  title?: DemandTextInput;
  objective?: DemandTextInput;
  idea?: DemandTextInput;
  requirement?: DemandTextInput;
  text?: DemandTextInput;
  problem?: DemandTextInput;
  target_user?: DemandStringListInput;
  target_users?: DemandStringListInput;
  status_quo?: DemandTextInput;
  success_criteria?: DemandStringListInput;
  desired_outcome?: DemandStringListInput;
  proof?: DemandStringListInput;
  constraints?: DemandStringListInput;
  non_goals?: DemandStringListInput;
  scope_in?: DemandStringListInput;
  scope_out?: DemandStringListInput;
  out_of_scope?: DemandStringListInput;
  risks?: DemandStringListInput;
  assumptions?: DemandStringListInput;
  acceptance_criteria?: DemandStringListInput;
  open_questions?: string[];
  target_files?: DemandStringListInput;
  targetFiles?: DemandStringListInput;
  evidence?: DemandStringListInput | DemandEvidenceRecord[];
  evidence_results?: DemandEvidenceResult[];
  evidenceResults?: DemandEvidenceResult[];
  evidence_agent_results?: DemandEvidenceResult[];
  evidenceAgentResults?: DemandEvidenceResult[];
  evidence_requirements?: DemandRecord[];
  evidence_requirement_summary?: DemandRecord & { total?: number; pending?: number; satisfied?: number };
  external_research_attempted?: boolean;
  externalResearchAttempted?: boolean;
  context_type?: string;
  contextType?: string;
  projectRoot?: string;
  project_root?: string;
  stateRoot?: string;
  state_root?: string;
  cwd?: string;
  project?: DemandProject;
  vision?: DemandVision;
  grounding?: DemandRecord & { mode?: DemandTextInput; reason?: DemandTextInput };
  prd_intake?: DemandRecord & {
    question_ids?: string[];
    success_proof?: string[];
    desired_outcomes?: string[];
  };
  requirements?: DemandRequirementsState;
  scenario_matrix?: DemandScenarioMatrix;
  scenarios?: DemandScenario[];
  project_facts?: DemandProjectFacts;
  investigation?: DemandInvestigation;
  discussion?: DemandDiscussion;
  reflection?: DemandRecord & {
    assumptions?: DemandStringListInput;
    assumption_records?: DemandAssumptionFact[];
    risks?: DemandStringListInput;
    alternatives?: DemandStringListInput;
    summary?: DemandTextInput;
  };
  context?: DemandRecord & {
    summary?: DemandTextInput;
    visual_style_source?: string[];
  };
  roadmap?: DemandRecord & {
    mvp?: DemandStringListInput;
    phases?: DemandStringListInput;
  } | DemandStringListInput;
  decisions?: DemandStringListInput;
  question_trace?: Array<DemandRecord | string>;
  questions?: Array<DemandRecord | string>;
  answers?: Array<DemandRecord | string>;
  followups?: string[];
  deferred_scope?: string[];
  deferred_scope_confirmation?: DemandDeferredScopeConfirmation;
  approval?: DemandApproval;
  approve?: boolean;
  approved?: boolean;
  approved_by?: string;
  approved_at?: string | null;
  approval_note?: DemandTextInput;
  playback?: (DemandRecord & { confirmed?: boolean; confirmed_by?: string }) | null;
  graph?: DemandArtifactGraph;
  readiness?: DemandReadinessReport;
  quality_report?: DemandQualityReport;
  tasks?: DemandTask[];
  interview?: DemandInterviewSnapshot;
  ledgers?: DemandRecord;
  nontechnical_intake?: DemandRecord & { technical_terms_required_from_user?: boolean };
  guarantees?: DemandRuntimeGuarantees;
}

export interface DemandRuntimeGuarantees extends DemandRecord {
  writes_business_code: boolean;
  prd_execution: boolean;
  provider_execution: boolean;
  source?: unknown;
  writes_project_state?: boolean;
}

export interface DemandRuntimeInput extends DemandSession {
  writeArtifacts?: boolean;
  write_artifacts?: boolean;
  writeLifecycle?: boolean;
  write_lifecycle?: boolean;
  outputDir?: string;
  output_dir?: string;
  demandPath?: string;
  demand_path?: string;
  sessionPath?: string;
  session_path?: string;
  demand?: string | DemandSession;
  executeAgents?: boolean;
  execute_agents?: boolean;
  execute?: boolean;
  allowAgentDispatch?: boolean;
  allow_agent_dispatch?: boolean;
  writeArtifact?: boolean;
  write_artifact?: boolean;
}

export interface DemandRuntimeOptions extends DemandRecord {
  projectRoot?: string;
  project_root?: string;
  stateRoot?: string;
  state_root?: string;
  cwd?: string;
  outputDir?: string;
  output_dir?: string;
  phase?: string;
  source?: string;
  now?: string;
  stateDir?: string;
  state_dir?: string;
  writeArtifacts?: boolean;
  write_artifacts?: boolean;
  writeLifecycle?: boolean;
  write_lifecycle?: boolean;
  storyAtomicity?: DemandRecord;
  story_atomicity?: DemandRecord;
  atomicity?: DemandRecord;
  tasks?: DemandTask[];
  requireTasks?: boolean;
  passScore?: number | string;
  blockScore?: number | string;
}

export interface DemandPrdDocument extends PrdDocument {
  base_commit?: string;
  demand?: DemandPrdDemandReport;
  tasks?: DemandTask[];
  requirements?: DemandRequirement[];
  scenario_matrix?: DemandScenarioMatrix;
  scenarios?: DemandScenario[];
  execution_readiness?: DemandPrdExecutionReadiness;
}

export interface DemandPrdProjectFacts extends DemandRecord {
  target_files: DemandTargetFileFact[];
  assumptions: DemandAssumptionFact[];
}

export interface DemandPrdSessionHandoff extends DemandRecord {
  planned?: boolean;
  task_count?: number;
  session_count?: number;
  tasks_with_session_plan?: number;
  state_paths?: string[];
  handoff_paths?: string[];
  evidence_paths?: string[];
  memory_update_paths?: string[];
  progress_update_paths?: string[];
}

export interface DemandPrdExecutionReadiness extends DemandRecord {
  level?: string;
  afk_ready?: boolean;
  source?: string;
  atomic_tasks?: boolean;
  expected_task_session?: string;
  demand_id?: string;
  readiness_score?: number;
  quality_score?: number;
  quality_status?: string;
  quality_report?: DemandQualityReport;
  atomicity_status?: string;
  session_handoff?: DemandPrdSessionHandoff;
}

export interface DemandPrdAtomicityContract extends DemandRecord {
  rule?: unknown;
  session_budget_required?: boolean;
  max_files_per_surface?: number;
  generated_task_count?: number;
  doctor_status?: string;
  session_handoff?: DemandPrdSessionHandoff;
}

export interface DemandPrdDemandReport extends DemandRecord {
  id?: string;
  approval?: DemandApproval;
  approval_reason?: DemandTextInput;
  deferred_scope?: string[];
  deferred_scope_confirmation?: DemandDeferredScopeConfirmation;
  deferred_follow_up?: DemandDeferredFollowUp;
  out_of_scope?: unknown[];
  prd_intake?: DemandRecord | null;
  interview?: DemandInterviewSnapshot | null;
  question_trace?: Array<(DemandRecord & { id?: string }) | string>;
  grounding?: DemandRecord | null;
  readiness_level?: string;
  readiness_score?: number;
  quality_score?: number;
  quality_report?: DemandQualityReport;
  project_facts?: DemandPrdProjectFacts;
  scenario_matrix?: DemandRecord & { scenarios?: unknown[] };
  atomicity_contract?: DemandPrdAtomicityContract;
  execution_readiness?: DemandPrdExecutionReadiness;
  evidence_requirements?: DemandRecord[];
}

export interface DemandDeferredFollowUp extends DemandRecord {
  required?: boolean;
  next_session_prompt?: string;
}

export interface DemandRuntimeResult extends DemandRecord {
  status: string;
  code: string;
  summary: string;
  demand_id?: string;
  demand_dir?: string;
  demand_path?: string;
  session?: DemandSession;
  readiness?: DemandReadinessReport;
  quality_report?: DemandQualityReport;
  graph?: DemandRecord;
  blockers?: DemandBlockerLike[];
  warnings?: DemandBlockerLike[] | string[];
  artifacts: string[];
  outputs?: Array<{ path: string; type: string; stage?: string }>;
  next_action?: string;
  next_actions?: string[];
  prd?: DemandPrdDocument | null;
  compiled?: DemandRecord & { prd?: DemandPrdDocument | null };
  tasks?: DemandTask[];
  guarantees?: DemandRuntimeGuarantees;
}

export interface DemandReadResult extends DemandRecord {
  ok: boolean;
  path: string;
  dir?: string;
  session?: DemandSession;
  error?: string;
}

export type DemandPrdRuntimeResult = DemandRuntimeResult & {
  prd?: DemandPrdDocument | null;
  prd_path?: string;
  output_path?: string;
};


export const DEMAND_ARTIFACTS: DemandArtifactNode[] = [
  {
    id: "vision",
    generates: "VISION.md",
    description: "Initial product vision, target user, problem, status quo, and opportunity hypothesis.",
    requires: [],
  },
  {
    id: "reflection",
    generates: "REFLECTION.md",
    description: "Premise challenge, assumptions, alternatives, and why this should continue.",
    requires: ["vision"],
  },
  {
    id: "investigation",
    generates: "INVESTIGATION.md",
    description: "Evidence, codebase scout, existing behavior, risks, and validation gaps.",
    requires: ["reflection"],
  },
  {
    id: "questioning_rounds",
    generates: "DISCUSSION-LOG.md",
    description: "Questioning rounds, answers, decisions, unresolved questions, and deferred ideas.",
    requires: ["investigation"],
  },
  {
    id: "depth_verification",
    generates: "READINESS.json",
    description: "Demand quality gate, depth verification, and readiness level.",
    requires: ["questioning_rounds"],
  },
  {
    id: "requirements_confirmation",
    generates: "REQUIREMENTS.md",
    description: "Confirmed requirements, acceptance scenarios, constraints, and out-of-scope boundaries.",
    requires: ["depth_verification"],
  },
  {
    id: "context",
    generates: "CONTEXT.md",
    description: "Domain language, project context, current state, constraints, and durable decisions.",
    requires: ["requirements_confirmation"],
  },
  {
    id: "roadmap",
    generates: "ROADMAP.md",
    description: "MVP, sequencing, later phases, dependencies, and risk-driven ordering.",
    requires: ["requirements_confirmation"],
  },
  {
    id: "approval",
    generates: "APPROVAL.json",
    description: "Explicit human approval for PRD compilation and execution readiness.",
    requires: ["requirements_confirmation", "context", "roadmap"],
  },
];

function artifactMap(artifacts: DemandArtifactNode[] = DEMAND_ARTIFACTS): Map<string, DemandArtifactNode> {
  return new Map(artifacts.map((artifact) => [artifact.id, artifact]));
}

export function demandBuildOrder(artifacts: DemandArtifactNode[] = DEMAND_ARTIFACTS): string[] {
  const byId = artifactMap(artifacts);
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const artifact of artifacts) {
    inDegree.set(artifact.id, artifact.requires.length);
    dependents.set(artifact.id, []);
  }
  for (const artifact of artifacts) {
    for (const required of artifact.requires) {
      if (!byId.has(required)) continue;
      dependents.get(required).push(artifact.id);
    }
  }

  const queue = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();
  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    order.push(current);
    for (const dependent of dependents.get(current) || []) {
      const degree = inDegree.get(dependent) - 1;
      inDegree.set(dependent, degree);
      if (degree === 0) queue.push(dependent);
    }
    queue.sort();
  }
  return order;
}

export function demandReadyArtifacts(completed: string[] | Set<string> = [], artifacts: DemandArtifactNode[] = DEMAND_ARTIFACTS): string[] {
  const done = completed instanceof Set ? completed : new Set(completed);
  return artifacts
    .filter((artifact) => !done.has(artifact.id) && artifact.requires.every((id) => done.has(id)))
    .map((artifact) => artifact.id)
    .sort();
}

export function demandBlockedArtifacts(completed: string[] | Set<string> = [], artifacts: DemandArtifactNode[] = DEMAND_ARTIFACTS): Record<string, string[]> {
  const done = completed instanceof Set ? completed : new Set(completed);
  const blocked: Record<string, string[]> = Object();
  for (const artifact of artifacts) {
    if (done.has(artifact.id)) continue;
    const missing = artifact.requires.filter((id) => !done.has(id));
    if (missing.length > 0) blocked[artifact.id] = missing.sort();
  }
  return blocked;
}

export function buildDemandArtifactGraph(completed: string[] | Set<string> = []) {
  const done = completed instanceof Set ? completed : new Set(completed);
  const artifacts: DemandArtifactGraphNode[] = DEMAND_ARTIFACTS.map((artifact) => {
    const missing = artifact.requires.filter((id) => !done.has(id));
    return {
      ...artifact,
      status: done.has(artifact.id) ? "done" : missing.length === 0 ? "ready" : "blocked",
      missing_dependencies: missing,
    };
  });
  return {
    schema_version: DEMAND_GRAPH_SCHEMA_VERSION,
    schema: DEMAND_GRAPH_SCHEMA,
    build_order: demandBuildOrder(),
    completed: [...done].sort(),
    ready: demandReadyArtifacts(Array.from(done)),
    blocked: demandBlockedArtifacts(Array.from(done)),
    artifacts,
  };
}
