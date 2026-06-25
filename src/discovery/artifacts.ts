import { execSync } from "node:child_process";
import { inspectDiscoveryReadiness } from "./gate.js";
import type {
  DiscoveryBrief,
  DiscoveryCheck,
  DiscoveryOptions,
  DiscoveryReadiness,
} from "./gate.js";
import { detectExternalResearchSignal } from "../lib/research-signal.js";

export const DISCOVERY_ARTIFACT_SCHEMA = "yolo.discovery.artifact.v1";
export const DISCOVERY_PROJECT_SCHEMA = "yolo.discovery.project.v1";
export const DISCOVERY_REQUIREMENTS_SCHEMA = "yolo.discovery.requirements.v1";
export const DISCOVERY_RESEARCH_DECISION_SCHEMA = "yolo.discovery.research_decision.v1";
export const DISCOVERY_PLAN_SCHEMA = "yolo.discovery.plan.v1";
export const DISCOVERY_PRD_SCHEMA = "yolo.discovery.prd_compiler.v1";

type DiscoveryRecord = Record<string, unknown>;
type ProjectShape = "simple" | "complex";
type ResearchDecision = string;
type PlanStatus = string;

interface DiscoveryMilestone extends DiscoveryRecord {
  id: string;
  title: string;
  outcome: string;
  requirement_ids: string[];
}

export interface DiscoveryProjectContext extends DiscoveryRecord {
  schema: string;
  id: unknown;
  title: string;
  vision: string;
  problem: string;
  target_users: string[];
  core_value: string;
  anti_goals: string[];
  constraints: string[];
  target_files: string[];
  project_shape: ProjectShape;
  milestone_sequence: DiscoveryMilestone[];
}

export interface DiscoveryRequirementRecord extends DiscoveryRecord {
  id: string;
  title: string;
  text: string;
  status: string;
  source: string;
  owner_milestone: string;
  evidence: unknown[];
}

interface DiscoveryDeferredRequirement extends DiscoveryRecord {
  id: string;
  text: string;
  reason: string;
}

interface RequirementStatusCounts {
  active: number;
  validated: number;
  deferred: number;
  out_of_scope: number;
}

interface DiscoveryRequirementsContractBase {
  schema: string;
  active: DiscoveryRequirementRecord[];
  validated: DiscoveryRequirementRecord[];
  deferred: DiscoveryDeferredRequirement[];
  out_of_scope: DiscoveryDeferredRequirement[];
}

export interface DiscoveryRequirementsContract extends DiscoveryRequirementsContractBase, DiscoveryRecord {
  status_counts: RequirementStatusCounts;
}

interface DiscoveryResearchDecision extends DiscoveryRecord {
  schema: string;
  decision: ResearchDecision;
  decided_at: string;
  rationale: string;
  scouts: string[];
}

interface DiscoveryTraceability extends DiscoveryRecord {
  project_id: unknown;
  milestone_ids: string[];
  requirement_to_milestone: Array<{
    requirement_id: string;
    milestone_id: string;
    source: string;
  }>;
  target_files: string[];
}

export interface DiscoveryArtifact extends DiscoveryRecord {
  schema: string;
  schema_version: string;
  id: unknown;
  generated_at: string;
  source: unknown;
  status: DiscoveryReadiness["status"];
  ready_for_plan: boolean;
  ready_for_prd: boolean;
  brief: DiscoveryBrief;
  project: DiscoveryProjectContext;
  requirements: DiscoveryRequirementsContract;
  research_decision: DiscoveryResearchDecision;
  readiness: DiscoveryReadiness;
  open_questions: string[];
  traceability: DiscoveryTraceability;
  gates: {
    discovery: DiscoveryReadiness["status"];
    plan: "pass" | "blocked";
    prd: string;
  };
}

interface DiscoveryPlanStep extends DiscoveryRecord {
  id: string;
  sequence: number;
  title: string;
  requirement_id: string;
  milestone_id: string;
  target_files: string[];
  verification: string;
}

export interface DiscoveryPlan extends DiscoveryRecord {
  schema: string;
  schema_version: string;
  id: unknown;
  generated_at: string;
  status: PlanStatus;
  discovery_id: unknown;
  objective: string;
  project?: DiscoveryProjectContext;
  requirements: DiscoveryRequirementRecord[];
  steps: DiscoveryPlanStep[];
  blockers: DiscoveryCheck[];
  warnings: DiscoveryCheck[];
  open_questions: string[];
  traceability?: DiscoveryTraceability;
  next_actions: string[];
}

export interface DiscoveryPostCondition extends DiscoveryRecord {
  id: string;
  type: string;
  severity: string;
  params: DiscoveryRecord;
  message: string;
}

export interface DiscoveryPrdTask extends DiscoveryRecord {
  id: string;
  title: string;
  description: string;
  status: string;
  source_finding_ids: string[];
  depends_on: string[];
  pre_conditions: DiscoveryPostCondition[];
  post_conditions: DiscoveryPostCondition[];
}

export type DiscoverySimpleBlocker = {
  code: string;
  message: string;
};

export interface BlockedDiscoveryPrdCompileResult extends DiscoveryRecord {
  schema: string;
  schema_version: string;
  status: "blocked";
  summary: string;
  blockers: Array<DiscoveryCheck | DiscoverySimpleBlocker>;
  next_actions: string[];
  prd?: undefined;
  executable?: false;
}

export interface DiscoveryDraftApproval extends DiscoveryRecord {
  approved: boolean;
  effective_for_prd: boolean;
  approval_source: string;
}

export interface DiscoveryDraftDemand extends DiscoveryRecord {
  id: unknown;
  source: string;
  approval: DiscoveryDraftApproval;
}

export interface DiscoveryDraftPrd extends DiscoveryRecord {
  id: unknown;
  title: string;
  demand: DiscoveryDraftDemand;
  tasks: DiscoveryPrdTask[];
}

export interface DraftDiscoveryPrdCompileResult extends DiscoveryRecord {
  schema: string;
  schema_version: string;
  status: "draft";
  executable: false;
  draft_reason: string;
  prd: DiscoveryDraftPrd;
  discovery_id: unknown;
  traceability: DiscoveryRecord;
  warnings: DiscoveryCheck[];
  next_actions: string[];
}

export interface ReadyDiscoveryPrdCompileResult extends DiscoveryRecord {
  schema: string;
  schema_version: string;
  status: "success";
  executable: true;
  prd: DiscoveryRecord;
  blockers?: Array<DiscoveryCheck | DiscoverySimpleBlocker>;
  warnings?: DiscoveryCheck[];
  next_actions?: string[];
}

export type DiscoveryPrdCompileResult =
  | BlockedDiscoveryPrdCompileResult
  | DraftDiscoveryPrdCompileResult
  | ReadyDiscoveryPrdCompileResult;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function arrayOfStrings(value: unknown | unknown[] | null | undefined): string[] {
  if (value == null) return [];
  const input = Array.isArray(value) ? value : [value];
  return input
    .flatMap((item) => String(item ?? "").split(/\r?\n/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStrings(values: unknown | unknown[] | null | undefined = []): string[] {
  return [...new Set(arrayOfStrings(values))];
}

function slug(value: unknown, fallback = "DISCOVERY"): string {
  const normalized = clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return normalized || fallback;
}

function nowIso(options: DiscoveryOptions = Object()): string {
  return clean(options.now) || new Date().toISOString();
}

function idDate(now: unknown): string {
  return clean(now).slice(0, 10).replace(/-/g, "") || "00000000";
}

function requirementId(index: number): string {
  return `R${String(index + 1).padStart(3, "0")}`;
}

function projectId(brief: Partial<DiscoveryBrief>, now: unknown): string {
  return `DISC-${idDate(now)}-${slug(brief.idea || brief.problem || "PROJECT")}`;
}

function detectProjectShape(brief: Partial<DiscoveryBrief> = Object()): ProjectShape {
  const signals = [
    ...arrayOfStrings(brief.constraints),
    ...arrayOfStrings(brief.success_criteria),
    ...arrayOfStrings(brief.risks),
  ].join(" ").toLowerCase();
  const heavySignals = [
    "auth",
    "security",
    "privacy",
    "payment",
    "billing",
    "database",
    "migration",
    "compliance",
    "pii",
    "integration",
    "distributed",
    "multi-agent",
    "multi agent",
  ];
  if (arrayOfStrings(brief.target_files).length > 5) return "complex";
  if (arrayOfStrings(brief.success_criteria).length > 5) return "complex";
  if (heavySignals.some((signal) => signals.includes(signal))) return "complex";
  return "simple";
}

function requirementTitle(text: unknown, index: number): string {
  const title = clean(text).replace(/\s+/g, " ").slice(0, 72);
  return title || `Requirement ${requirementId(index)}`;
}

function openQuestionForCheck(check: Partial<DiscoveryCheck> = Object()): unknown {
  const code = clean(check.code);
  const prompts: Record<string, string> = {
    DISCOVERY_IDEA_SPECIFIC: "What concrete outcome should this work deliver?",
    DISCOVERY_PROBLEM_PRESENT: "What user or project problem does this solve?",
    DISCOVERY_TARGET_USER_PRESENT: "Who is the specific target user or operator for this demand?",
    DISCOVERY_SUCCESS_CRITERIA_PRESENT: "What observable success criteria prove this is done?",
    DISCOVERY_SCOPE_SIGNAL_PRESENT: "Which files, modules, or bounded area are in scope?",
    DISCOVERY_CONSTRAINTS_CAPTURED: "What constraints, non-goals, risks, or existing behavior must be preserved?",
    DISCOVERY_REQUIREMENTS_ACTIVE: "Which confirmed requirement should become the first active requirement?",
  };
  return prompts[code] || check.message || check.summary || "";
}

function requirementStatusCounts(contract: DiscoveryRequirementsContractBase): RequirementStatusCounts {
  return {
    active: contract.active.length,
    validated: contract.validated.length,
    deferred: contract.deferred.length,
    out_of_scope: contract.out_of_scope.length,
  };
}

function buildRequirementRecord(text: string, index: number, source = "success_criteria"): DiscoveryRequirementRecord {
  const id = requirementId(index);
  return {
    id,
    title: requirementTitle(text, index),
    text: clean(text),
    status: "active",
    source,
    owner_milestone: "M001",
    evidence: [],
  };
}

function normalizeResearchDecision(input: DiscoveryRecord = Object(), readiness: Partial<DiscoveryReadiness> = Object()): ResearchDecision {
  const raw = input.research_decision ?? input.researchDecision ?? input.research;
  if (raw === true) return "research";
  const value = clean(raw).toLowerCase();
  if (["research", "run", "yes", "true", "needed"].includes(value)) return "research";
  // Derive from content: URLs or external-reference intent in the demand/brief
  // text mean external research is required. Shares one signal definition with
  // demand evidence dispatch (src/lib/research-signal.ts).
  //
  // NOTE: we do NOT short-circuit on readiness.status === "blocked". The
  // research decision answers "does this brief need external research?" — a
  // question about content, not about whether the PRD gate is currently
  // passable. BUG-B blocks the PRD gate when external evidence is missing,
  // and that block is exactly when the research decision must read "research"
  // so the user knows what to do next. Empty/short content already produces
  // no signal and falls through to "skip" naturally.
  const brief: Partial<DiscoveryBrief> = readiness.brief || {};
  const signal = detectExternalResearchSignal(
    (input.idea || brief.idea) as string,
    (input.problem || brief.problem) as string,
    input.objective as string,
    arrayOfStrings(brief.success_criteria).join(" "),
    arrayOfStrings(brief.constraints).join(" "),
    arrayOfStrings(input.success_criteria).join(" "),
    arrayOfStrings(input.constraints).join(" "),
  );
  return signal.requires_external ? "research" : "skip";
}

function readBaseCommit(options: DiscoveryOptions = Object()): string {
  try {
    const cwd = (options.projectRoot || options.project_root || process.cwd()) as string;
    return execSync("git rev-parse HEAD", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return "0000000";
  }
}

function taskTitle(requirement: DiscoveryRequirementRecord): string {
  return clean(requirement.title).slice(0, 96) || `Implement ${requirement.id}`;
}

function targetFilesForPrd(discovery: Partial<DiscoveryArtifact> = Object()): string[] {
  const briefTargets = arrayOfStrings(discovery.brief?.target_files);
  const projectTargets = arrayOfStrings(discovery.project?.target_files);
  return uniqueStrings([...briefTargets, ...projectTargets]);
}

function acceptanceCondition(taskId: string, index: number, text: unknown): DiscoveryPostCondition {
  return {
    id: `POST-${taskId}-ACCEPT-${index + 1}`,
    type: "acceptance_criteria",
    severity: "WARN",
    params: { text: clean(text) },
    message: clean(text),
  };
}

function modifiedFileCondition(taskId: string, index: number, file: string): DiscoveryPostCondition {
  return {
    id: `POST-${taskId}-TARGET-${index + 1}`,
    type: "target_file_modified",
    severity: "FAIL",
    params: { file },
    message: `Target file must be modified: ${file}`,
  };
}

function draftDemandQualityReport(): DiscoveryRecord {
  return {
    schema_version: "1.0",
    schema: "yolo.demand.quality.v1",
    status: "blocked",
    total_score: 0,
    dimensions: [],
  };
}

export function buildProjectContext(
  brief: Partial<DiscoveryBrief> = Object(),
  input: DiscoveryRecord = Object(),
  options: DiscoveryOptions = Object(),
): DiscoveryProjectContext {
  const now = nowIso(options);
  const idea = clean(brief.idea || input.idea || input.objective || input.requirement);
  const problem = clean(brief.problem || input.problem);
  const targetUsers = uniqueStrings(brief.target_users || input.target_users || input.targetUsers);
  const targetFiles = uniqueStrings(brief.target_files || input.target_files || input.targetFiles);

  return {
    schema: DISCOVERY_PROJECT_SCHEMA,
    id: input.project_id || input.projectId || projectId({ ...brief, idea, problem }, now),
    title: clean(input.title || input.project_title || idea || problem) || "Discovered project",
    vision: idea,
    problem,
    target_users: targetUsers,
    core_value: problem || idea,
    anti_goals: uniqueStrings(brief.non_goals || input.non_goals || input.nonGoals),
    constraints: uniqueStrings(brief.constraints || input.constraints),
    target_files: targetFiles,
    project_shape: detectProjectShape({ ...brief, target_files: targetFiles }),
    milestone_sequence: [
      {
        id: "M001",
        title: clean(input.milestone || input.title || "Deliver discovered capability"),
        outcome: idea || problem || "Implement the active discovery requirements.",
        requirement_ids: uniqueStrings(brief.success_criteria).map((_, index) => requirementId(index)),
      },
    ],
  };
}

export function buildRequirementsContract(
  brief: Partial<DiscoveryBrief> = Object(),
  input: DiscoveryRecord = Object(),
): DiscoveryRequirementsContract {
  const successCriteria = uniqueStrings(brief.success_criteria || input.success_criteria || input.successCriteria);
  const contract: DiscoveryRequirementsContractBase = {
    schema: DISCOVERY_REQUIREMENTS_SCHEMA,
    active: successCriteria.map((text, index) => buildRequirementRecord(text, index)),
    validated: [],
    deferred: uniqueStrings(brief.risks || input.risks).map((text, index) => ({
      id: `D${String(index + 1).padStart(3, "0")}`,
      text,
      reason: "risk_or_followup",
    })),
    out_of_scope: uniqueStrings(brief.non_goals || input.non_goals || input.nonGoals).map((text, index) => ({
      id: `O${String(index + 1).padStart(3, "0")}`,
      text,
      reason: "explicit_non_goal",
    })),
  };
  return {
    ...contract,
    status_counts: requirementStatusCounts(contract),
  };
}

export function buildResearchDecision(
  input: DiscoveryRecord = Object(),
  readiness: Partial<DiscoveryReadiness> = Object(),
  options: DiscoveryOptions = Object(),
): DiscoveryResearchDecision {
  const decision = normalizeResearchDecision(input, readiness);
  return {
    schema: DISCOVERY_RESEARCH_DECISION_SCHEMA,
    decision,
    decided_at: nowIso(options),
    rationale: clean(input.research_rationale || input.researchRationale)
      || (decision === "research"
        ? "Additional external/project research was explicitly requested."
        : "Current discovery can proceed without external research."),
    scouts: decision === "research" ? ["stack", "features", "architecture", "pitfalls"] : [],
  };
}

export function buildOpenQuestions(readiness: Partial<DiscoveryReadiness> = Object()): string[] {
  const brief: Partial<DiscoveryBrief> = readiness.brief || {};
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers : [];
  const warnings = Array.isArray(readiness.warnings) ? readiness.warnings : [];
  const generated = [
    ...blockers,
    ...warnings,
  ].map(openQuestionForCheck);
  return uniqueStrings([
    ...arrayOfStrings(brief.open_questions),
    ...generated,
  ]);
}

export function buildTraceability(
  project: Partial<DiscoveryProjectContext> = Object(),
  requirements: Partial<DiscoveryRequirementsContract> = Object(),
): DiscoveryTraceability {
  return {
    project_id: project.id,
    milestone_ids: arrayOfStrings(project.milestone_sequence?.map((item) => item.id)),
    requirement_to_milestone: (requirements.active || []).map((requirement) => ({
      requirement_id: requirement.id,
      milestone_id: requirement.owner_milestone || "M001",
      source: requirement.source,
    })),
    target_files: uniqueStrings(project.target_files),
  };
}

export function buildDiscoveryArtifact(input: DiscoveryRecord = Object(), options: DiscoveryOptions = Object()): DiscoveryArtifact {
  const now = nowIso(options);
  const readiness = inspectDiscoveryReadiness(input, options);
  const brief = readiness.brief;
  const project = buildProjectContext(brief, input, { ...options, now });
  const requirements = buildRequirementsContract(brief, input);
  const researchDecision = buildResearchDecision(input, readiness, { ...options, now });
  const openQuestions = buildOpenQuestions(readiness);

  return {
    schema: DISCOVERY_ARTIFACT_SCHEMA,
    schema_version: "1.0",
    id: input.id || project.id,
    generated_at: now,
    source: input.source || "yolo-discover",
    status: readiness.status,
    ready_for_plan: readiness.ready_for_plan,
    ready_for_prd: readiness.ready_for_prd,
    brief,
    project,
    requirements,
    research_decision: researchDecision,
    readiness,
    open_questions: openQuestions,
    traceability: buildTraceability(project, requirements),
    gates: {
      discovery: readiness.status,
      plan: readiness.ready_for_plan ? "pass" : "blocked",
      prd: readiness.ready_for_prd ? "pass" : readiness.ready_for_plan ? "warning" : "blocked",
    },
  };
}

export function buildDiscoveryPlan(
  discovery: Partial<DiscoveryArtifact> = Object(),
  input: DiscoveryRecord = Object(),
  options: DiscoveryOptions = Object(),
): DiscoveryPlan {
  const requirements = discovery.requirements?.active || [];
  const blocked = discovery.ready_for_plan !== true;
  const steps: DiscoveryPlanStep[] = blocked
    ? []
    : requirements.map((requirement, index) => ({
        id: `PLAN-${requirement.id}`,
        sequence: index + 1,
        title: requirement.title,
        requirement_id: requirement.id,
        milestone_id: requirement.owner_milestone || "M001",
        target_files: targetFilesForPrd(discovery),
        verification: "prd_preflight + runner post_conditions + acceptance",
      }));

  return {
    schema: DISCOVERY_PLAN_SCHEMA,
    schema_version: "1.0",
    id: input.id || `PLAN-${idDate(options.now || discovery.generated_at || new Date().toISOString())}-${slug(discovery.project?.title || discovery.id)}`,
    generated_at: nowIso(options),
    status: blocked ? "blocked" : discovery.status === "warning" ? "warning" : "success",
    discovery_id: discovery.id,
    objective: clean(input.objective || discovery.brief?.idea || discovery.project?.vision),
    project: discovery.project,
    requirements,
    steps,
    blockers: blocked ? discovery.readiness?.blockers || [] : [],
    warnings: discovery.readiness?.warnings || [],
    open_questions: discovery.open_questions || [],
    traceability: discovery.traceability,
    next_actions: blocked
      ? ["Answer discovery open questions before generating a PRD."]
      : ["Review this plan, then generate a PRD from the same discovery artifact."],
  };
}

export function buildPrdFromDiscovery(
  discovery: object = Object(),
  input: object = Object(),
  options: object = Object(),
): DiscoveryPrdCompileResult {
  const discoveryRecord = discovery as Partial<DiscoveryArtifact>;
  const inputRecord = input as DiscoveryRecord;
  const optionsRecord = options as DiscoveryOptions;
  const requirements = discoveryRecord.requirements?.active || [];
  const targetFiles = targetFilesForPrd(discoveryRecord);
  const now = nowIso(optionsRecord);
  const blocked = discoveryRecord.ready_for_plan !== true || requirements.length === 0 || targetFiles.length === 0;
  if (blocked) {
    const blockers = [
      ...(discoveryRecord.readiness?.blockers || []),
      requirements.length === 0 ? { code: "DISCOVERY_REQUIREMENTS_EMPTY", message: "No active requirements are available." } : null,
      targetFiles.length === 0 ? { code: "DISCOVERY_TARGET_FILES_EMPTY", message: "No target files are available." } : null,
    ].filter((item): item is DiscoveryCheck | DiscoverySimpleBlocker => Boolean(item));
    return {
      schema: DISCOVERY_PRD_SCHEMA,
      schema_version: "1.0",
      status: "blocked",
      summary: "Discovery is not ready for PRD compilation.",
      blockers,
      next_actions: ["Complete discovery with active requirements and target files before compiling a PRD."],
    };
  }

  const title = clean(inputRecord.title || discoveryRecord.project?.title || discoveryRecord.brief?.idea || "Discovery PRD").slice(0, 120);
  const prdId = inputRecord.prd_id || inputRecord.prdId || `PRD-${idDate(now)}-${slug(title)}`;
  const draftQuality = draftDemandQualityReport();
  const tasks: DiscoveryPrdTask[] = requirements.map((requirement, index) => {
    const taskId = `DISC-${requirement.id}-${String(index + 1).padStart(3, "0")}`;
    return {
      id: taskId,
      title: taskTitle(requirement),
      description: requirement.text,
      priority: inputRecord.priority || "P1",
      type: inputRecord.task_type || inputRecord.taskType || "feature",
      status: "needs_contract_review",
      task_kind: "discovery_requirement",
      source_finding_ids: [requirement.id],
      depends_on: [],
      scope: {
        targets: targetFiles.map((file) => ({ file, description: requirement.text })),
        allow_new_files: true,
        allow_delete_files: false,
        max_files: Math.max(1, targetFiles.length),
        max_lines_per_file: Number(inputRecord.max_lines_per_file || inputRecord.maxLinesPerFile || 200),
      },
      pre_conditions: [],
      post_conditions: [
        ...targetFiles.map((file, fileIndex) => modifiedFileCondition(taskId, fileIndex, file)),
        acceptanceCondition(taskId, 0, requirement.text),
      ],
      test_generation: {
        mode: "reuse_existing",
        reason: "Discovery PRD requires evidence from existing project tests unless a later PRD narrows test scope.",
      },
      must_fix_before_ship: true,
    };
  });

  return {
    schema: DISCOVERY_PRD_SCHEMA,
    schema_version: "1.0",
    status: "draft",
    executable: false,
    draft_reason: discoveryRecord.ready_for_prd === true
      ? "Discovery PRDs require approved demand and runner preflight before execution."
      : "Discovery readiness is not a clean PRD pass; this artifact is a non-executable draft.",
    prd: {
      $schema: "https://yolo.dev/schemas/prd-v2.schema.json",
      version: "2.0",
      id: prdId,
      title,
      description: clean(inputRecord.description || `Compiled from discovery artifact ${discoveryRecord.id}.`),
      project: {
        name: clean(inputRecord.project_name || inputRecord.projectName || discoveryRecord.project?.title || "project"),
        language: clean(inputRecord.language || "other"),
        framework: clean(inputRecord.framework || "generic"),
        package_manager: clean(inputRecord.package_manager || inputRecord.packageManager || "other"),
        test_framework: clean(inputRecord.test_framework || inputRecord.testFramework || "unknown"),
        lint_tool: clean(inputRecord.lint_tool || inputRecord.lintTool || "unknown"),
        type_checker: clean(inputRecord.type_checker || inputRecord.typeChecker || "unknown"),
      },
      generated_by: "yolo-review-agent",
      generated_at: now,
      base_commit: readBaseCommit(optionsRecord),
      source: "discovery_draft",
      execution_mode: "draft",
      demand_contract_required: true,
      demand: {
        id: discoveryRecord.id,
        source: "discovery",
        approval: {
          approved: false,
          effective_for_prd: false,
          approval_source: "pending_human_approval",
        },
        quality_report: draftQuality,
        execution_readiness: {
          quality_report: draftQuality,
        },
      },
      execution_readiness: {
        level: "draft",
        afk_ready: false,
        source: "discovery_draft",
        atomic_tasks: false,
        quality_status: "blocked",
        quality_report: draftQuality,
      },
      requirements: requirements.map((requirement) => ({
        id: requirement.id,
        text: requirement.text,
      })),
      designs: requirements.map((requirement) => ({
        id: `DES-${requirement.id}`,
        text: `Implement ${requirement.id} within the discovered scope and post-condition contract.`,
      })),
      tasks,
      conflict_policy: {
        on_overlap: "sequential",
        overlap_detection: "file_only",
      },
    },
    discovery_id: discoveryRecord.id,
    traceability: {
      discovery_id: discoveryRecord.id,
      requirement_ids: requirements.map((requirement) => requirement.id),
      task_ids: tasks.map((task) => task.id),
      target_files: targetFiles,
    },
    warnings: discoveryRecord.readiness?.warnings || [],
    next_actions: [
      "Convert this draft through approved demand before execution.",
      "Run runner preflight only after demand approval and demand contract are present.",
    ],
  };
}
