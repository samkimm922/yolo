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

function isRecord(value: unknown): value is SpecRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

function traceRecord(task: unknown = Object()): SpecRecord {
  const trace = optionalField(task, "trace");
  return isRecord(trace) ? trace : {};
}

function findingRecordIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .flatMap((record) => normalizeRefs(record.finding_id, record.id, record.scanner_id, record.rule_id));
}

function reviewFindingRecordIds(task: unknown, prdRec: SpecRecord): Set<string> {
  const taskRec = isRecord(task) ? task : {};
  return new Set([taskRec.source_findings, taskRec.fix_findings, prdRec.review_findings, optionalField(prdRec.review, "findings"), optionalField(prdRec.review_report, "findings"), optionalField(prdRec.source_review, "findings")]
    .flatMap(findingRecordIds));
}

function reviewFindingIds(task: unknown): string[] {
  const taskRec = isRecord(task) ? task : {};
  const trace = traceRecord(task);
  return normalizeRefs(taskRec.source_finding_ids, trace.finding_id, trace.finding_ids, trace.source_finding_id, trace.source_finding_ids);
}

function reviewFindingReportPath(trace: SpecRecord, evidence: SpecRecord = Object()): string {
  return cleanString(evidence.report_path || evidence.reportPath || evidence.path || evidence.file || trace.review_report_path || trace.report_path);
}

function evidenceStringHasReportPath(value: string, findingId: string): boolean {
  const [pathPart] = value.split("#", 1);
  return value.includes(findingId) && value.includes("#") && cleanString(pathPart).length > 0;
}

function hasReviewFindingEvidence(trace: SpecRecord, findingId: string): boolean {
  const evidenceItems = [
    ...asArray<unknown>(trace.evidence),
    ...asArray<unknown>(trace.evidence_files),
  ];
  for (const item of evidenceItems) {
    if (typeof item === "string" && evidenceStringHasReportPath(item, findingId)) return true;
    if (!isRecord(item)) continue;
    const evidenceIds = normalizeRefs(item.finding_id, item.id, item.ref, item.key);
    if (evidenceIds.includes(findingId) && reviewFindingReportPath(trace, item)) return true;
  }
  return Boolean(cleanString(trace.review_report_path || trace.report_path));
}

function reviewFindingIssue(code: string, taskId: string | null, message: string): GovernanceIssue {
  return { code, task_id: taskId, message };
}

function reviewFindingTraceIssues(task: unknown, prdRec: SpecRecord, taskId: string | null): GovernanceIssue[] {
  const trace = traceRecord(task);
  if (cleanString(trace.source) !== "review_finding") return [];
  const issues: GovernanceIssue[] = [];
  const findingIds = reviewFindingIds(task);
  if (findingIds.length === 0) {
    issues.push(reviewFindingIssue("MISSING_REVIEW_FINDING_TRACE", taskId, "review_finding trace 缺少 source_finding_ids"));
    return issues;
  }

  const knownFindingIds = reviewFindingRecordIds(task, prdRec);
  const missing = findingIds.filter((id) => !knownFindingIds.has(id));
  if (missing.length > 0) {
    issues.push(reviewFindingIssue("INVALID_REVIEW_FINDING_TRACE", taskId, `review_finding trace references missing finding records: ${missing.join(", ")}`));
  }

  const missingEvidence = findingIds.filter((id) => !hasReviewFindingEvidence(trace, id));
  if (missingEvidence.length > 0) {
    issues.push(reviewFindingIssue("MISSING_REVIEW_FINDING_EVIDENCE", taskId, `review_finding trace 缺少 finding id + report path evidence: ${missingEvidence.join(", ")}`));
  }

  return issues;
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
  const prdRec = prd as SpecRecord;
  const prdTasks = Array.isArray(prdRec.tasks) ? prdRec.tasks.filter((task: unknown) => task && typeof task === "object") : [];
  const matrix = buildTraceabilityMatrix(prd);
  const blockers: GovernanceIssue[] = [];
  const warnings: GovernanceIssue[] = [];

  for (const [index, task] of matrix.tasks.entries()) {
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

    blockers.push(...reviewFindingTraceIssues(prdTasks[index], prdRec, task.task_id));
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
