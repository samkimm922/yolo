const TERMINAL_STATUSES = new Set(["done", "completed", "failed", "blocked", "skipped"]);

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function refId(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return value.id || value.ref || value.key || value.name || null;
}

function normalizeRefs(...values) {
  const refs = [];
  for (const value of values) {
    for (const item of asArray(value)) {
      const id = refId(item);
      if (id) refs.push(String(id));
    }
  }
  return [...new Set(refs)];
}

function normalizeEvidenceRefs(...values) {
  return normalizeRefs(...values).filter((ref) => ref.length > 0);
}

function targetFiles(task = Object()) {
  return [...new Set((task.scope?.targets || [])
    .map((target) => target.file)
    .filter(Boolean)
    .map((file) => String(file).replace(/:\d+(?:-\d+)?$/, "")))];
}

function taskRequirementIds(task = Object()) {
  return normalizeRefs(
    task.requirement_id,
    task.requirement_ids,
    task.requirements,
    task.trace?.requirement_id,
    task.trace?.requirement_ids,
    task.trace?.requirements,
    task.traceability?.requirement_id,
    task.traceability?.requirement_ids,
    task.traceability?.requirements,
  );
}

function taskDesignIds(task = Object()) {
  return normalizeRefs(
    task.design_id,
    task.design_ids,
    task.designs,
    task.trace?.design_id,
    task.trace?.design_ids,
    task.trace?.designs,
    task.traceability?.design_id,
    task.traceability?.design_ids,
    task.traceability?.designs,
  );
}

function taskEvidenceRefs(task = Object()) {
  return normalizeEvidenceRefs(
    task.evidence_file,
    task.evidence_files,
    task.blocked_by,
    task.trace?.evidence,
    task.trace?.evidence_file,
    task.trace?.evidence_files,
    task.traceability?.evidence,
    task.traceability?.evidence_file,
    task.traceability?.evidence_files,
  );
}

export function buildTraceabilityMatrix(prd = Object()) {
  const requirements = normalizeRefs(prd.requirements, prd.spec?.requirements);
  const designs = normalizeRefs(prd.designs, prd.design, prd.spec?.designs, prd.spec?.design);
  const knownRequirements = new Set(requirements);
  const knownDesigns = new Set(designs);
  const prdTasks = Array.isArray(prd.tasks) ? prd.tasks : [];
  const tasks = prdTasks.map((task) => {
    const requirementIds = taskRequirementIds(task);
    const designIds = taskDesignIds(task);
    const evidenceFiles = taskEvidenceRefs(task);
    const isTerminal = TERMINAL_STATUSES.has(task.status);
    const danglingRequirements = requirementIds.filter((id) => !knownRequirements.has(id));
    const danglingDesign = designIds.filter((id) => !knownDesigns.has(id));
    return {
      task_id: task.id || null,
      status: task.status || null,
      requirement_ids: requirementIds,
      design_ids: designIds,
      evidence_files: evidenceFiles,
      target_files: targetFiles(task),
      missing: {
        requirements: requirementIds.length === 0,
        design: designIds.length === 0,
        evidence: isTerminal && evidenceFiles.length === 0,
        dangling_requirements: danglingRequirements,
        dangling_design: danglingDesign,
      },
    };
  });

  const summary = {
    task_count: tasks.length,
    tasks_with_requirements: tasks.filter((task) => !task.missing.requirements).length,
    tasks_with_design: tasks.filter((task) => !task.missing.design).length,
    terminal_tasks_with_evidence: tasks.filter((task) => TERMINAL_STATUSES.has(task.status) && !task.missing.evidence).length,
    missing_requirements: tasks.filter((task) => task.missing.requirements).map((task) => task.task_id),
    missing_design: tasks.filter((task) => task.missing.design).map((task) => task.task_id),
    missing_evidence: tasks.filter((task) => task.missing.evidence).map((task) => task.task_id),
    dangling_requirements: tasks
      .filter((task) => task.missing.dangling_requirements.length > 0)
      .map((task) => ({ task_id: task.task_id, requirement_ids: task.missing.dangling_requirements })),
    dangling_design: tasks
      .filter((task) => task.missing.dangling_design.length > 0)
      .map((task) => ({ task_id: task.task_id, design_ids: task.missing.dangling_design })),
  };

  return {
    prd_id: prd.id || null,
    generated_at: prd.generated_at || null,
    requirements,
    designs,
    tasks,
    summary,
  };
}

export function inspectSpecGovernance(prd = Object(), options = Object()) {
  const policy = {
    requireRequirements: options.requireRequirements === true,
    requireDesign: options.requireDesign === true,
    requireEvidenceForTerminal: options.requireEvidenceForTerminal === true,
  };
  const matrix = buildTraceabilityMatrix(prd);
  const blockers = [];
  const warnings = [];

  for (const task of matrix.tasks) {
    if (policy.requireRequirements && task.missing.requirements) {
      blockers.push({
        code: "MISSING_REQUIREMENT_TRACE",
        task_id: task.task_id,
        message: "task 缺少 requirement trace",
      });
    } else if (task.missing.requirements) {
      warnings.push({
        code: "MISSING_REQUIREMENT_TRACE",
        task_id: task.task_id,
        message: "task 缺少 requirement trace",
      });
    }
    if (task.missing.dangling_requirements.length > 0) {
      const target = policy.requireRequirements ? blockers : warnings;
      target.push({
        code: "DANGLING_REQUIREMENT_TRACE",
        task_id: task.task_id,
        requirement_ids: task.missing.dangling_requirements,
        message: `task requirement trace references missing requirement ids: ${task.missing.dangling_requirements.join(", ")}`,
      });
    }

    if (policy.requireDesign && task.missing.design) {
      blockers.push({
        code: "MISSING_DESIGN_TRACE",
        task_id: task.task_id,
        message: "task 缺少 design trace",
      });
    } else if (task.missing.design) {
      warnings.push({
        code: "MISSING_DESIGN_TRACE",
        task_id: task.task_id,
        message: "task 缺少 design trace",
      });
    }
    if (task.missing.dangling_design.length > 0) {
      const target = policy.requireDesign ? blockers : warnings;
      target.push({
        code: "DANGLING_DESIGN_TRACE",
        task_id: task.task_id,
        design_ids: task.missing.dangling_design,
        message: `task design trace references missing design ids: ${task.missing.dangling_design.join(", ")}`,
      });
    }

    if (policy.requireEvidenceForTerminal && task.missing.evidence) {
      blockers.push({
        code: "MISSING_TERMINAL_EVIDENCE",
        task_id: task.task_id,
        message: "terminal task 缺少 evidence trace",
      });
    } else if (task.missing.evidence) {
      warnings.push({
        code: "MISSING_TERMINAL_EVIDENCE",
        task_id: task.task_id,
        message: "terminal task 缺少 evidence trace",
      });
    }
  }

  return {
    status: blockers.length > 0 ? "blocked" : (warnings.length > 0 ? "warning" : "pass"),
    blocks_execution: blockers.length > 0,
    policy,
    blockers,
    warnings,
    matrix,
  };
}
