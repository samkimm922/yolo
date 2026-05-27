export const SPEC_LIFECYCLE_SCHEMA_VERSION = "1.0";

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map((value) => String(value).trim()).filter(Boolean))];
}

function artifactId(input, prefix, index = 1) {
  return cleanText(input.id || input.key || input.ref || `${prefix}-${String(index).padStart(3, "0")}`);
}

export function buildRequirementArtifact(input = {}, options = {}) {
  return {
    schema_version: SPEC_LIFECYCLE_SCHEMA_VERSION,
    schema: "yolo.spec.requirement.v1",
    artifact_type: "requirement",
    id: artifactId(input, options.prefix || "REQ", options.index),
    title: cleanText(input.title || input.name || "Requirement"),
    text: cleanText(input.text || input.description),
    success_criteria: uniqueStrings(input.success_criteria || input.acceptance_criteria),
    constraints: uniqueStrings(input.constraints),
    non_goals: uniqueStrings(input.non_goals || input.nonGoals),
    status: cleanText(input.status || "draft"),
  };
}

export function buildDesignArtifact(input = {}, options = {}) {
  return {
    schema_version: SPEC_LIFECYCLE_SCHEMA_VERSION,
    schema: "yolo.spec.design.v1",
    artifact_type: "design",
    id: artifactId(input, options.prefix || "DES", options.index),
    title: cleanText(input.title || input.name || "Design"),
    requirement_ids: uniqueStrings(input.requirement_ids || input.requirements || input.requirement_id),
    approach: cleanText(input.approach || input.text || input.description),
    alternatives: asArray(input.alternatives).map((item) => cleanText(item)).filter(Boolean),
    risks: asArray(input.risks).map((item) => cleanText(item)).filter(Boolean),
    rollback: cleanText(input.rollback || input.rollback_plan),
    status: cleanText(input.status || "draft"),
  };
}

export function buildTaskArtifact(input = {}, options = {}) {
  return {
    schema_version: SPEC_LIFECYCLE_SCHEMA_VERSION,
    schema: "yolo.spec.task.v1",
    artifact_type: "task",
    id: artifactId(input, options.prefix || "TASK", options.index),
    title: cleanText(input.title || input.name || "Task"),
    type: cleanText(input.type || "feature"),
    priority: cleanText(input.priority || "P2"),
    status: cleanText(input.status || "pending"),
    requirement_ids: uniqueStrings(input.requirement_ids || input.requirements || input.requirement_id),
    design_ids: uniqueStrings(input.design_ids || input.designs || input.design_id),
    scope: input.scope || { targets: [] },
    pre_conditions: asArray(input.pre_conditions),
    post_conditions: asArray(input.post_conditions),
    acceptance_criteria: uniqueStrings(input.acceptance_criteria),
    evidence_files: uniqueStrings(input.evidence_files || input.evidence_file),
  };
}

export function buildChangeArtifact(input = {}, options = {}) {
  return {
    schema_version: SPEC_LIFECYCLE_SCHEMA_VERSION,
    schema: "yolo.spec.change.v1",
    artifact_type: "change",
    id: artifactId(input, options.prefix || "CHG", options.index),
    title: cleanText(input.title || input.name || "Change"),
    reason: cleanText(input.reason || input.text || input.description),
    requirement_ids: uniqueStrings(input.requirement_ids || input.requirements || input.requirement_id),
    design_ids: uniqueStrings(input.design_ids || input.designs || input.design_id),
    task_ids: uniqueStrings(input.task_ids || input.tasks || input.task_id),
    impact: uniqueStrings(input.impact),
    migration: cleanText(input.migration || input.migration_plan),
    rollback: cleanText(input.rollback || input.rollback_plan),
    status: cleanText(input.status || "proposed"),
  };
}

export function buildSpecLifecyclePackage(input = {}, options = {}) {
  const requirements = asArray(input.requirements).map((item, index) =>
    buildRequirementArtifact(item, { index: index + 1 })
  );
  const designs = asArray(input.designs || input.design).map((item, index) =>
    buildDesignArtifact(item, { index: index + 1 })
  );
  const tasks = asArray(input.tasks).map((item, index) =>
    buildTaskArtifact(item, { index: index + 1 })
  );
  const changes = asArray(input.changes).map((item, index) =>
    buildChangeArtifact(item, { index: index + 1 })
  );

  return {
    schema_version: SPEC_LIFECYCLE_SCHEMA_VERSION,
    schema: "yolo.spec.lifecycle.v1",
    artifact_type: "spec_lifecycle",
    id: cleanText(input.id || options.id || "SPEC-LIFECYCLE"),
    title: cleanText(input.title || options.title || "Spec lifecycle"),
    requirements,
    designs,
    tasks,
    changes,
  };
}

function missingRefs(refs, validRefs) {
  return refs.filter((ref) => !validRefs.has(ref));
}

export function inspectSpecLifecyclePackage(specPackage = {}) {
  const requirements = asArray(specPackage.requirements);
  const designs = asArray(specPackage.designs);
  const tasks = asArray(specPackage.tasks);
  const changes = asArray(specPackage.changes);
  const requirementIds = new Set(requirements.map((item) => item.id).filter(Boolean));
  const designIds = new Set(designs.map((item) => item.id).filter(Boolean));
  const taskIds = new Set(tasks.map((item) => item.id).filter(Boolean));
  const blockers = [];
  const warnings = [];

  if (requirements.length === 0) blockers.push({ code: "SPEC_REQUIREMENTS_EMPTY", message: "spec lifecycle requires at least one requirement" });
  if (designs.length === 0) blockers.push({ code: "SPEC_DESIGNS_EMPTY", message: "spec lifecycle requires at least one design" });
  if (tasks.length === 0) blockers.push({ code: "SPEC_TASKS_EMPTY", message: "spec lifecycle requires at least one task" });

  for (const design of designs) {
    const missing = missingRefs(uniqueStrings(design.requirement_ids), requirementIds);
    if (missing.length > 0) {
      blockers.push({
        code: "DESIGN_REQUIREMENT_REF_MISSING",
        design_id: design.id || null,
        refs: missing,
        message: "design references missing requirements",
      });
    }
  }

  for (const task of tasks) {
    const missingRequirements = missingRefs(uniqueStrings(task.requirement_ids), requirementIds);
    const missingDesigns = missingRefs(uniqueStrings(task.design_ids), designIds);
    if (missingRequirements.length > 0 || uniqueStrings(task.requirement_ids).length === 0) {
      blockers.push({
        code: "TASK_REQUIREMENT_REF_MISSING",
        task_id: task.id || null,
        refs: missingRequirements,
        message: "task must reference existing requirements",
      });
    }
    if (missingDesigns.length > 0 || uniqueStrings(task.design_ids).length === 0) {
      blockers.push({
        code: "TASK_DESIGN_REF_MISSING",
        task_id: task.id || null,
        refs: missingDesigns,
        message: "task must reference existing designs",
      });
    }
    if (!task.scope || asArray(task.scope.targets).length === 0) {
      warnings.push({
        code: "TASK_SCOPE_EMPTY",
        task_id: task.id || null,
        message: "task has no scoped targets",
      });
    }
  }

  for (const change of changes) {
    const missingTasks = missingRefs(uniqueStrings(change.task_ids), taskIds);
    if (missingTasks.length > 0) {
      blockers.push({
        code: "CHANGE_TASK_REF_MISSING",
        change_id: change.id || null,
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

export function specLifecycleToPrd(specPackage = {}, options = {}) {
  return {
    version: "2.0",
    id: cleanText(options.id || `PRD-${specPackage.id || "SPEC-LIFECYCLE"}`),
    title: cleanText(options.title || specPackage.title || "Spec lifecycle PRD"),
    generated_by: "yolo.spec.lifecycle",
    generated_at: options.generated_at || "1970-01-01T00:00:00.000Z",
    requirements: asArray(specPackage.requirements).map((requirement) => ({
      id: requirement.id,
      text: requirement.text || requirement.title || "",
    })),
    designs: asArray(specPackage.designs).map((design) => ({
      id: design.id,
      text: design.approach || design.title || "",
    })),
    tasks: asArray(specPackage.tasks).map((task) => ({
      id: task.id,
      title: task.title,
      type: task.type,
      priority: task.priority,
      status: task.status,
      requirement_ids: uniqueStrings(task.requirement_ids),
      design_ids: uniqueStrings(task.design_ids),
      scope: task.scope,
      pre_conditions: asArray(task.pre_conditions),
      post_conditions: asArray(task.post_conditions),
      acceptance_criteria: uniqueStrings(task.acceptance_criteria),
      evidence_files: uniqueStrings(task.evidence_files),
    })),
  };
}
