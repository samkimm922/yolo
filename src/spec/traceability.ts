const TERMINAL_STATUSES = new Set(["done", "completed", "failed", "blocked", "skipped"]);

type SpecRecord = Record<string, unknown>;

type TraceabilityTask = {
  task_id: string | null;
  status: string | null;
  requirement_ids: string[];
  design_ids: string[];
  evidence_files: string[];
  target_files: string[];
  missing: {
    requirements: boolean;
    design: boolean;
    evidence: boolean;
    dangling_requirements: string[];
    dangling_design: string[];
  };
};

type GovernanceIssue = {
  code: string;
  task_id: string | null;
  message: string;
  requirement_ids?: string[];
  design_ids?: string[];
};

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function optionalField(value: unknown, key: string): unknown {
  if (value == null) return undefined;
  return (value as SpecRecord)[key];
}

function isTerminalStatus(status: unknown): boolean {
  return typeof status === "string" && TERMINAL_STATUSES.has(status);
}

function refId(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const rec = value as SpecRecord;
  return rec.id || rec.ref || rec.key || rec.name || null;
}

function normalizeRefs(...values: unknown[]): string[] {
  const refs: string[] = [];
  for (const value of values) {
    for (const item of asArray<unknown>(value)) {
      const id = refId(item);
      if (id) refs.push(String(id));
    }
  }
  return [...new Set(refs)];
}

function normalizeEvidenceRefs(...values: unknown[]): string[] {
  return normalizeRefs(...values).filter((ref) => ref.length > 0);
}

function targetFiles(task: unknown = Object()): string[] {
  const taskRec = task as SpecRecord;
  const targetsValue = optionalField(taskRec.scope, "targets");
  const targets = Array.isArray(targetsValue) ? targetsValue : [];
  return [...new Set(targets
    .map((target) => optionalField(target, "file"))
    .filter(Boolean)
    .map((file) => String(file).replace(/:\d+(?:-\d+)?$/, "")))];
}

function taskRequirementIds(task: unknown = Object()): string[] {
  const taskRec = task as SpecRecord;
  return normalizeRefs(
    taskRec.requirement_id,
    taskRec.requirement_ids,
    taskRec.requirements,
    optionalField(taskRec.trace, "requirement_id"),
    optionalField(taskRec.trace, "requirement_ids"),
    optionalField(taskRec.trace, "requirements"),
    optionalField(taskRec.traceability, "requirement_id"),
    optionalField(taskRec.traceability, "requirement_ids"),
    optionalField(taskRec.traceability, "requirements"),
  );
}

function taskDesignIds(task: unknown = Object()): string[] {
  const taskRec = task as SpecRecord;
  return normalizeRefs(
    taskRec.design_id,
    taskRec.design_ids,
    taskRec.designs,
    optionalField(taskRec.trace, "design_id"),
    optionalField(taskRec.trace, "design_ids"),
    optionalField(taskRec.trace, "designs"),
    optionalField(taskRec.traceability, "design_id"),
    optionalField(taskRec.traceability, "design_ids"),
    optionalField(taskRec.traceability, "designs"),
  );
}

function taskEvidenceRefs(task: unknown = Object()): string[] {
  const taskRec = task as SpecRecord;
  return normalizeEvidenceRefs(
    taskRec.evidence_file,
    taskRec.evidence_files,
    taskRec.blocked_by,
    optionalField(taskRec.trace, "evidence"),
    optionalField(taskRec.trace, "evidence_file"),
    optionalField(taskRec.trace, "evidence_files"),
    optionalField(taskRec.traceability, "evidence"),
    optionalField(taskRec.traceability, "evidence_file"),
    optionalField(taskRec.traceability, "evidence_files"),
  );
}

export function buildTraceabilityMatrix(prd: unknown = Object()) {
  const prdRec = prd as SpecRecord;
  const specRec = prdRec.spec;
  const requirements = normalizeRefs(prdRec.requirements, optionalField(specRec, "requirements"));
  const designs = normalizeRefs(prdRec.designs, prdRec.design, optionalField(specRec, "designs"), optionalField(specRec, "design"));
  const knownRequirements = new Set(requirements);
  const knownDesigns = new Set(designs);
  const prdTasks = Array.isArray(prdRec.tasks) ? prdRec.tasks.filter((task: unknown) => task && typeof task === "object") : [];
  const tasks = prdTasks.map((task) => {
    const taskRec = task as SpecRecord;
    const requirementIds = taskRequirementIds(task);
    const designIds = taskDesignIds(task);
    const evidenceFiles = taskEvidenceRefs(task);
    const isTerminal = isTerminalStatus(taskRec.status);
    const danglingRequirements = requirementIds.filter((id) => !knownRequirements.has(id));
    const danglingDesign = designIds.filter((id) => !knownDesigns.has(id));
    return {
      task_id: (taskRec.id || null) as string | null,
      status: (taskRec.status || null) as string | null,
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
    terminal_tasks_with_evidence: tasks.filter((task) => isTerminalStatus(task.status) && !task.missing.evidence).length,
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
    prd_id: prdRec.id || null,
    generated_at: prdRec.generated_at || null,
    requirements,
    designs,
    tasks,
    summary,
  };
}

export function inspectSpecGovernance(prd: unknown = Object(), options: unknown = Object()) {
  const optionsRec = options as SpecRecord;
  const policy = {
    requireRequirements: optionsRec.requireRequirements === true,
    requireDesign: optionsRec.requireDesign === true,
    requireEvidenceForTerminal: optionsRec.requireEvidenceForTerminal === true,
  };
  const matrix = buildTraceabilityMatrix(prd);
  const blockers: GovernanceIssue[] = [];
  const warnings: GovernanceIssue[] = [];

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
