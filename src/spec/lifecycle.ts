export const SPEC_LIFECYCLE_SCHEMA_VERSION = "1.0";

type SpecRecord = Record<string, unknown>;

type SpecLifecycleIssue = {
  code: string;
  message: string;
  refs?: string[];
  design_id?: unknown;
  task_id?: unknown;
  change_id?: unknown;
};

type SpecTaskScope = SpecRecord & {
  targets: SpecRecord[];
};

type SpecCondition = SpecRecord & {
  type?: string;
};

type RequirementArtifact = {
  schema_version: string;
  schema: string;
  artifact_type: string;
  id: string;
  title: string;
  text: string;
  success_criteria: string[];
  constraints: string[];
  non_goals: string[];
  status: string;
};

type DesignArtifact = {
  schema_version: string;
  schema: string;
  artifact_type: string;
  id: string;
  title: string;
  requirement_ids: string[];
  approach: string;
  alternatives: string[];
  risks: string[];
  rollback: string;
  status: string;
};

type TaskArtifact = {
  schema_version: string;
  schema: string;
  artifact_type: string;
  id: string;
  title: string;
  type: string;
  priority: string;
  status: string;
  requirement_ids: string[];
  design_ids: string[];
  scope: SpecTaskScope;
  pre_conditions: SpecCondition[];
  post_conditions: SpecCondition[];
  acceptance_criteria: string[];
  evidence_files: string[];
};

type ChangeArtifact = {
  schema_version: string;
  schema: string;
  artifact_type: string;
  id: string;
  title: string;
  reason: string;
  requirement_ids: string[];
  design_ids: string[];
  task_ids: string[];
  impact: string[];
  migration: string;
  rollback: string;
  status: string;
};

type DemandQualityReport = SpecRecord & {
  schema_version: string;
  schema: string;
  status: string;
  total_score: number;
  dimensions: unknown[];
};

type SpecLifecycleDemand = SpecRecord & {
  id: unknown;
  source: string;
  approval: SpecRecord & {
    approved: boolean;
    effective_for_prd: boolean;
    approval_source: string;
  };
  quality_report: DemandQualityReport;
};

type SpecLifecycleExecutionReadiness = SpecRecord & {
  level: string;
  afk_ready: boolean;
  source: string;
  atomic_tasks: boolean;
  quality_status: string;
  quality_report: DemandQualityReport;
};

type SpecLifecycleProject = SpecRecord & {
  name: string;
  language: string;
  framework?: string;
};

type SpecLifecyclePrdTask = {
  id: string;
  title: string;
  type: string;
  priority: string;
  status: string;
  requirement_ids: string[];
  design_ids: string[];
  scope: SpecTaskScope;
  pre_conditions: SpecCondition[];
  post_conditions: SpecCondition[];
  acceptance_criteria: string[];
  evidence_files: string[];
};

type SpecLifecyclePrd = SpecRecord & {
  version: string;
  id: string;
  title: string;
  project: SpecLifecycleProject;
  generated_by: string;
  generated_at: unknown;
  base_commit: string;
  source: string;
  execution_mode: string;
  demand_contract_required: boolean;
  demand: SpecLifecycleDemand;
  execution_readiness: SpecLifecycleExecutionReadiness;
  requirements: Array<{ id: string; text: unknown }>;
  designs: Array<{ id: string; text: unknown }>;
  tasks: SpecLifecyclePrdTask[];
};

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value: unknown, fallback = ""): string {
  return String(value ?? fallback).trim();
}

function uniqueStrings(values: unknown): string[] {
  return [...new Set(asArray<unknown>(values).map((value) => String(value).trim()).filter(Boolean))];
}

function artifactId(input: unknown, prefix: unknown, index: unknown = 1): string {
  const rec = input as SpecRecord;
  return cleanText(rec.id || rec.key || rec.ref || `${prefix}-${String(index).padStart(3, "0")}`);
}

export function buildRequirementArtifact(input: unknown = Object(), options: unknown = Object()): RequirementArtifact {
  const inputRec = input as SpecRecord;
  const optionsRec = options as SpecRecord;
  return {
    schema_version: SPEC_LIFECYCLE_SCHEMA_VERSION,
    schema: "yolo.spec.requirement.v1",
    artifact_type: "requirement",
    id: artifactId(inputRec, optionsRec.prefix || "REQ", optionsRec.index),
    title: cleanText(inputRec.title || inputRec.name || "Requirement"),
    text: cleanText(inputRec.text || inputRec.description),
    success_criteria: uniqueStrings(inputRec.success_criteria || inputRec.acceptance_criteria),
    constraints: uniqueStrings(inputRec.constraints),
    non_goals: uniqueStrings(inputRec.non_goals || inputRec.nonGoals),
    status: cleanText(inputRec.status || "draft"),
  };
}

export function buildDesignArtifact(input: unknown = Object(), options: unknown = Object()): DesignArtifact {
  const inputRec = input as SpecRecord;
  const optionsRec = options as SpecRecord;
  return {
    schema_version: SPEC_LIFECYCLE_SCHEMA_VERSION,
    schema: "yolo.spec.design.v1",
    artifact_type: "design",
    id: artifactId(inputRec, optionsRec.prefix || "DES", optionsRec.index),
    title: cleanText(inputRec.title || inputRec.name || "Design"),
    requirement_ids: uniqueStrings(inputRec.requirement_ids || inputRec.requirements || inputRec.requirement_id),
    approach: cleanText(inputRec.approach || inputRec.text || inputRec.description),
    alternatives: asArray<unknown>(inputRec.alternatives).map((item) => cleanText(item)).filter(Boolean),
    risks: asArray<unknown>(inputRec.risks).map((item) => cleanText(item)).filter(Boolean),
    rollback: cleanText(inputRec.rollback || inputRec.rollback_plan),
    status: cleanText(inputRec.status || "draft"),
  };
}

export function buildTaskArtifact(input: unknown = Object(), options: unknown = Object()): TaskArtifact {
  const inputRec = input as SpecRecord;
  const optionsRec = options as SpecRecord;
  return {
    schema_version: SPEC_LIFECYCLE_SCHEMA_VERSION,
    schema: "yolo.spec.task.v1",
    artifact_type: "task",
    id: artifactId(inputRec, optionsRec.prefix || "TASK", optionsRec.index),
    title: cleanText(inputRec.title || inputRec.name || "Task"),
    type: cleanText(inputRec.type || "feature"),
    priority: cleanText(inputRec.priority || "P2"),
    status: cleanText(inputRec.status || "pending"),
    requirement_ids: uniqueStrings(inputRec.requirement_ids || inputRec.requirements || inputRec.requirement_id),
    design_ids: uniqueStrings(inputRec.design_ids || inputRec.designs || inputRec.design_id),
    scope: (inputRec.scope || { targets: [] }) as SpecTaskScope,
    pre_conditions: asArray<unknown>(inputRec.pre_conditions) as SpecCondition[],
    post_conditions: asArray<unknown>(inputRec.post_conditions) as SpecCondition[],
    acceptance_criteria: uniqueStrings(inputRec.acceptance_criteria),
    evidence_files: uniqueStrings(inputRec.evidence_files || inputRec.evidence_file),
  };
}

export function buildChangeArtifact(input: unknown = Object(), options: unknown = Object()): ChangeArtifact {
  const inputRec = input as SpecRecord;
  const optionsRec = options as SpecRecord;
  return {
    schema_version: SPEC_LIFECYCLE_SCHEMA_VERSION,
    schema: "yolo.spec.change.v1",
    artifact_type: "change",
    id: artifactId(inputRec, optionsRec.prefix || "CHG", optionsRec.index),
    title: cleanText(inputRec.title || inputRec.name || "Change"),
    reason: cleanText(inputRec.reason || inputRec.text || inputRec.description),
    requirement_ids: uniqueStrings(inputRec.requirement_ids || inputRec.requirements || inputRec.requirement_id),
    design_ids: uniqueStrings(inputRec.design_ids || inputRec.designs || inputRec.design_id),
    task_ids: uniqueStrings(inputRec.task_ids || inputRec.tasks || inputRec.task_id),
    impact: uniqueStrings(inputRec.impact),
    migration: cleanText(inputRec.migration || inputRec.migration_plan),
    rollback: cleanText(inputRec.rollback || inputRec.rollback_plan),
    status: cleanText(inputRec.status || "proposed"),
  };
}

export function buildSpecLifecyclePackage(input: unknown = Object(), options: unknown = Object()) {
  const inputRec = input as SpecRecord;
  const optionsRec = options as SpecRecord;
  const requirements = asArray<unknown>(inputRec.requirements).map((item, index) =>
    buildRequirementArtifact(item, { index: index + 1 })
  );
  const designs = asArray<unknown>(inputRec.designs || inputRec.design).map((item, index) =>
    buildDesignArtifact(item, { index: index + 1 })
  );
  const tasks = asArray<unknown>(inputRec.tasks).map((item, index) =>
    buildTaskArtifact(item, { index: index + 1 })
  );
  const changes = asArray<unknown>(inputRec.changes).map((item, index) =>
    buildChangeArtifact(item, { index: index + 1 })
  );

  return {
    schema_version: SPEC_LIFECYCLE_SCHEMA_VERSION,
    schema: "yolo.spec.lifecycle.v1",
    artifact_type: "spec_lifecycle",
    id: cleanText(inputRec.id || optionsRec.id || "SPEC-LIFECYCLE"),
    title: cleanText(inputRec.title || optionsRec.title || "Spec lifecycle"),
    requirements,
    designs,
    tasks,
    changes,
  };
}

function missingRefs(refs: string[], validRefs: Set<unknown>): string[] {
  return refs.filter((ref) => !validRefs.has(ref));
}

export function inspectSpecLifecyclePackage(specPackage: unknown = Object()) {
  const specRec = specPackage as SpecRecord;
  const requirements = asArray<unknown>(specRec.requirements);
  const designs = asArray<unknown>(specRec.designs);
  const tasks = asArray<unknown>(specRec.tasks);
  const changes = asArray<unknown>(specRec.changes);
  const requirementIds = new Set(requirements.map((item) => (item as SpecRecord).id).filter(Boolean));
  const designIds = new Set(designs.map((item) => (item as SpecRecord).id).filter(Boolean));
  const taskIds = new Set(tasks.map((item) => (item as SpecRecord).id).filter(Boolean));
  const blockers: SpecLifecycleIssue[] = [];
  const warnings: SpecLifecycleIssue[] = [];

  if (requirements.length === 0) blockers.push({ code: "SPEC_REQUIREMENTS_EMPTY", message: "spec lifecycle requires at least one requirement" });
  if (designs.length === 0) blockers.push({ code: "SPEC_DESIGNS_EMPTY", message: "spec lifecycle requires at least one design" });
  if (tasks.length === 0) blockers.push({ code: "SPEC_TASKS_EMPTY", message: "spec lifecycle requires at least one task" });

  for (const design of designs) {
    const designRec = design as SpecRecord;
    const missing = missingRefs(uniqueStrings(designRec.requirement_ids), requirementIds);
    if (missing.length > 0) {
      blockers.push({
        code: "DESIGN_REQUIREMENT_REF_MISSING",
        design_id: designRec.id || null,
        refs: missing,
        message: "design references missing requirements",
      });
    }
  }

  for (const task of tasks) {
    const taskRec = task as SpecRecord;
    const missingRequirements = missingRefs(uniqueStrings(taskRec.requirement_ids), requirementIds);
    const missingDesigns = missingRefs(uniqueStrings(taskRec.design_ids), designIds);
    if (missingRequirements.length > 0 || uniqueStrings(taskRec.requirement_ids).length === 0) {
      blockers.push({
        code: "TASK_REQUIREMENT_REF_MISSING",
        task_id: taskRec.id || null,
        refs: missingRequirements,
        message: "task must reference existing requirements",
      });
    }
    if (missingDesigns.length > 0 || uniqueStrings(taskRec.design_ids).length === 0) {
      blockers.push({
        code: "TASK_DESIGN_REF_MISSING",
        task_id: taskRec.id || null,
        refs: missingDesigns,
        message: "task must reference existing designs",
      });
    }
    const scopeRec = taskRec.scope as SpecRecord;
    if (!taskRec.scope || asArray<unknown>(scopeRec.targets).length === 0) {
      warnings.push({
        code: "TASK_SCOPE_EMPTY",
        task_id: taskRec.id || null,
        message: "task has no scoped targets",
      });
    }
  }

  for (const change of changes) {
    const changeRec = change as SpecRecord;
    const missingTasks = missingRefs(uniqueStrings(changeRec.task_ids), taskIds);
    if (missingTasks.length > 0) {
      blockers.push({
        code: "CHANGE_TASK_REF_MISSING",
        change_id: changeRec.id || null,
        refs: missingTasks,
        message: "change references missing tasks",
      });
    }
  }

  return {
    status: blockers.length > 0 ? "blocked" : (warnings.length > 0 ? "warning" : "pass"),
    blocks_execution: blockers.length > 0,
    summary: {
      requirement_count: requirements.length,
      design_count: designs.length,
      task_count: tasks.length,
      change_count: changes.length,
      blocker_count: blockers.length,
      warning_count: warnings.length,
    },
    blockers,
    warnings,
  };
}

function draftDemandQualityReport(): DemandQualityReport {
  return {
    schema_version: "1.0",
    schema: "yolo.demand.quality.v1",
    status: "blocked",
    total_score: 0,
    dimensions: [],
  };
}

export function specLifecycleToPrd(specPackage: unknown = Object(), options: unknown = Object()): SpecLifecyclePrd {
  const specRec = specPackage as SpecRecord;
  const optionsRec = options as SpecRecord;
  const executable = optionsRec.executable === true;
  const draftQuality = draftDemandQualityReport();
  return {
    version: "2.0",
    id: cleanText(optionsRec.id || `PRD-${specRec.id || "SPEC-LIFECYCLE"}`),
    title: cleanText(optionsRec.title || specRec.title || "Spec lifecycle PRD"),
    project: (optionsRec.project || {
      name: cleanText(optionsRec.projectName || optionsRec.project_name || "project"),
      language: cleanText(optionsRec.language || "other"),
      framework: cleanText(optionsRec.framework || "generic"),
    }) as SpecLifecycleProject,
    generated_by: "other",
    generated_at: optionsRec.generated_at || "1970-01-01T00:00:00.000Z",
    base_commit: cleanText(optionsRec.base_commit || optionsRec.baseCommit || "0000000"),
    source: executable ? "approved_demand" : "spec_lifecycle_draft",
    execution_mode: executable ? "default" : "draft",
    demand_contract_required: true,
    demand: (executable ? optionsRec.demand : {
      id: specRec.id || "SPEC-LIFECYCLE",
      source: "spec_lifecycle",
      approval: {
        approved: false,
        effective_for_prd: false,
        approval_source: "pending_human_approval",
      },
      quality_report: draftQuality,
      execution_readiness: {
        quality_report: draftQuality,
      },
    }) as SpecLifecycleDemand,
    execution_readiness: (executable ? optionsRec.execution_readiness : {
      level: "draft",
      afk_ready: false,
      source: "spec_lifecycle_draft",
      atomic_tasks: false,
      quality_status: "blocked",
      quality_report: draftQuality,
    }) as SpecLifecycleExecutionReadiness,
    requirements: asArray<unknown>(specRec.requirements).map((requirement) => {
      const requirementRec = requirement as SpecRecord;
      return {
        id: requirementRec.id as string,
        text: requirementRec.text || requirementRec.title || "",
      };
    }),
    designs: asArray<unknown>(specRec.designs).map((design) => {
      const designRec = design as SpecRecord;
      return {
        id: designRec.id as string,
        text: designRec.approach || designRec.title || "",
      };
    }),
    tasks: asArray<unknown>(specRec.tasks).map((task) => {
      const taskRec = task as SpecRecord;
      return {
        id: taskRec.id as string,
        title: taskRec.title as string,
        type: taskRec.type as string,
        priority: taskRec.priority as string,
        status: (executable ? taskRec.status : "needs_contract_review") as string,
        requirement_ids: uniqueStrings(taskRec.requirement_ids),
        design_ids: uniqueStrings(taskRec.design_ids),
        scope: taskRec.scope as SpecTaskScope,
        pre_conditions: asArray<unknown>(taskRec.pre_conditions) as SpecCondition[],
        post_conditions: asArray<unknown>(taskRec.post_conditions) as SpecCondition[],
        acceptance_criteria: uniqueStrings(taskRec.acceptance_criteria),
        evidence_files: uniqueStrings(taskRec.evidence_files),
      };
    }),
  };
}
