import {
  buildDesignArtifact,
  buildRequirementArtifact,
  buildSpecLifecyclePackage,
  buildTaskArtifact,
  inspectSpecLifecyclePackage,
  specLifecycleToPrd,
} from "../spec/lifecycle.js";
import { asRecord, type UnknownRecord } from "./condition-catalog.js";

export const PRD_SPEC_COMPILER_SCHEMA_VERSION = "1.0";
export const PRD_SPEC_COMPILER_SCHEMA = "yolo.prd.spec_compiler.v1";

type SpecCompilerOptions = UnknownRecord & {
  designId?: string;
  designTitle?: string;
  generated_at?: string;
  id?: string;
  prdId?: string;
  prdTitle?: string;
  requirementId?: string;
  title?: string;
};

type SpecCompilerRefs = {
  requirement_ids?: string[];
  design_ids?: string[];
};

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function uniqueStrings(values: unknown): string[] {
  return [...new Set(asArray(values).map((value) => clean(value)).filter(Boolean))];
}

function normalizeTask(input: UnknownRecord = {}, index = 1, refs: SpecCompilerRefs = {}) {
  return buildTaskArtifact({
    id: input.id || `TASK-${String(index).padStart(3, "0")}`,
    title: input.title || input.name || `Task ${index}`,
    type: input.type || "feature",
    priority: input.priority || "P2",
    status: input.status || "pending",
    requirement_ids: input.requirement_ids || refs.requirement_ids,
    design_ids: input.design_ids || refs.design_ids,
    scope: input.scope || {
      targets: uniqueStrings(input.target_files || input.files).map((file) => ({ file })),
    },
    pre_conditions: input.pre_conditions || [],
    post_conditions: input.post_conditions || [],
    acceptance_criteria: input.acceptance_criteria || input.success_criteria || [],
    evidence_files: input.evidence_files || [],
  }, { index });
}

export function compileDiscoveryPlanToSpec(input: UnknownRecord = {}, options: SpecCompilerOptions = {}) {
  const discovery = asRecord(input.discovery || input.discoveryBrief || input.discovery_brief);
  const plan = asRecord(input.plan);
  const tasksInput = asArray(input.tasks || plan.tasks);
  const requirementText = clean(discovery.idea || discovery.requirement || input.requirement || plan.requirement);
  const blockers = [];

  if (!requirementText) {
    blockers.push({
      code: "SPEC_COMPILER_REQUIREMENT_MISSING",
      message: "discovery or plan must include a requirement or idea",
    });
  }
  if (tasksInput.length === 0) {
    blockers.push({
      code: "SPEC_COMPILER_TASKS_MISSING",
      message: "plan must include at least one executable task",
    });
  }

  const requirement = buildRequirementArtifact({
    id: discovery.requirement_id || options.requirementId || "REQ-001",
    title: discovery.title || plan.title || options.title || "Compiled requirement",
    text: requirementText,
    success_criteria: discovery.success_criteria || plan.success_criteria || input.success_criteria,
    constraints: discovery.constraints || input.constraints,
    non_goals: discovery.non_goals || input.non_goals,
    status: "approved",
  });

  const design = buildDesignArtifact({
    id: options.designId || "DES-001",
    title: plan.design_title || options.designTitle || "Implementation approach",
    requirement_ids: [requirement.id],
    approach: plan.approach || discovery.approach || input.approach || "Implementation approach will follow the approved plan.",
    alternatives: plan.alternatives || [],
    risks: plan.risks || discovery.risks || [],
    rollback: plan.rollback || input.rollback,
    status: "approved",
  });

  const tasks = tasksInput.map((task, index) =>
    normalizeTask(asRecord(task), index + 1, {
      requirement_ids: [requirement.id],
      design_ids: [design.id],
    })
  );

  const spec = buildSpecLifecyclePackage({
    id: options.id || "SPEC-COMPILED",
    title: options.title || plan.title || "Compiled PRD spec",
    requirements: [requirement],
    designs: [design],
    tasks,
    changes: input.changes || [],
  });
  const validation = inspectSpecLifecyclePackage(spec);
  const allBlockers = [...blockers, ...(validation.blockers || [])];
  const status = allBlockers.length > 0 ? "blocked" : "draft";
  const prd = allBlockers.length === 0
    ? specLifecycleToPrd(spec, {
        id: options.prdId || `PRD-${spec.id}`,
        title: options.prdTitle || spec.title,
        generated_at: options.generated_at || new Date().toISOString(),
      })
    : null;

  return {
    schema_version: PRD_SPEC_COMPILER_SCHEMA_VERSION,
    schema: PRD_SPEC_COMPILER_SCHEMA,
    status,
    executable: false,
    spec,
    prd,
    validation: {
      ...validation,
      blockers: allBlockers,
      blocks_execution: allBlockers.length > 0,
    },
    blockers: allBlockers,
    warnings: validation.warnings || [],
    guarantees: {
      writes_workspace: false,
      provider_execution: false,
      billable_provider_execution: false,
    },
    next_actions: allBlockers.length > 0
      ? ["Return to /yolo-discover or /yolo-plan until requirement, design, tasks, scope, and traceability are complete."]
      : ["Treat this as a draft; collect approved demand and pass runner preflight before implementation."],
  };
}
