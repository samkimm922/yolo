type AppendUniqueFn = (target: unknown[], items?: unknown[]) => void;

type ReviewTaskShape = Record<string, unknown>;

function isFn(value: unknown): value is AppendUniqueFn {
  return typeof value === "function";
}

function asArrayField(target: Record<string, unknown>, key: string): unknown[] {
  const existing = target[key];
  if (Array.isArray(existing)) return existing as unknown[];
  const fresh: unknown[] = [];
  target[key] = fresh;
  return fresh;
}

export function shouldBlockReviewTaskLimit(taskCount: number, maxTasks: number): boolean {
  return taskCount > maxTasks;
}

function appendUniqueFallback(target: unknown[], items: unknown[] = []) {
  for (const item of items) {
    if (!target.includes(item)) target.push(item);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function normalizeFile(value: unknown): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/:\d+(?:-\d+)?$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return "";
  return String(value.id || value.ref || value.key || value.name || "").trim();
}

function refArray(...values: unknown[]): string[] {
  const refs: string[] = [];
  for (const value of values) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const ref = refString(item);
      if (ref) refs.push(ref);
    }
  }
  return [...new Set(refs)];
}

function uniqueStrings(values: string[] = []): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function scopeTargetFiles(task: ReviewTaskShape = Object()): string[] {
  const scope = task.scope as Record<string, unknown> | undefined;
  const targets = Array.isArray(scope?.targets) ? scope.targets as Array<Record<string, unknown>> : [];
  const scoped = targets.map((target) => normalizeFile(target.file)).filter(Boolean);
  return [...new Set([...scoped, ...stringArray(task.target_files).map(normalizeFile).filter(Boolean)])];
}

function sourceFindingIds(task: ReviewTaskShape = Object()): string[] {
  const direct = stringArray(task.source_finding_ids);
  const sourceFindings = Array.isArray(task.source_findings)
    ? task.source_findings as Array<Record<string, unknown>>
    : Array.isArray(task.fix_findings)
      ? task.fix_findings as Array<Record<string, unknown>>
      : [];
  const fromFindings = sourceFindings
    .map((finding) => finding?.finding_id || finding?.id || finding?.scanner_id || finding?.rule_id)
    .map((id) => String(id || "").trim())
    .filter(Boolean);
  return [...new Set([...direct, ...fromFindings])];
}

function taskTrace(task: ReviewTaskShape = Object()): Record<string, unknown> {
  if (!isRecord(task.trace)) task.trace = {};
  return task.trace as Record<string, unknown>;
}

function traceRecord(task: ReviewTaskShape = Object()): Record<string, unknown> {
  return isRecord(task.trace) ? task.trace as Record<string, unknown> : {};
}

function taskSpecRefs(task: ReviewTaskShape, keys: string[]): string[] {
  const trace = traceRecord(task);
  const traceability = isRecord(task.traceability) ? task.traceability as Record<string, unknown> : {};
  return refArray(...keys.flatMap((key) => [task[key], trace[key], traceability[key]]));
}

function taskRequirementIds(task: ReviewTaskShape = Object()): string[] {
  return taskSpecRefs(task, ["requirement_id", "requirement_ids", "requirements"]);
}

function taskDesignIds(task: ReviewTaskShape = Object()): string[] {
  return taskSpecRefs(task, ["design_id", "design_ids", "designs"]);
}

function reviewReportPathFromTrace(trace: Record<string, unknown> = Object()): string {
  const direct = String(trace.review_report_path || trace.report_path || "").trim();
  if (direct) return direct;
  const item = (Array.isArray(trace.evidence) ? trace.evidence : []).find(isRecord) as Record<string, unknown> | undefined;
  return item ? String(item.report_path || item.reportPath || item.path || item.file || "").trim() : "";
}

function evidenceRef(reportPath: string, findingId: string): string {
  return reportPath ? `${reportPath}#${findingId}` : findingId;
}

function taskEvidenceRefs(task: ReviewTaskShape = Object()): string[] {
  const trace = traceRecord(task);
  const existing = refArray(
    task.evidence_file,
    task.evidence_files,
    trace.evidence_file,
    trace.evidence_files,
  );
  const reportPath = reviewReportPathFromTrace(trace);
  const fromEvidence = (Array.isArray(trace.evidence) ? trace.evidence as unknown[] : [])
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (!isRecord(item)) return "";
      const findingId = String(item.finding_id || item.id || item.ref || "").trim();
      const path = String(item.report_path || item.reportPath || item.path || item.file || "").trim();
      return findingId ? evidenceRef(path || reportPath, findingId) : refString(item);
    })
    .filter(Boolean);
  const fromFindingIds = sourceFindingIds(task).map((id) => evidenceRef(reportPath, id));
  return uniqueStrings([...existing, ...fromEvidence, ...fromFindingIds]);
}

function mergeStringField(record: Record<string, unknown>, key: string, items: string[] = []) {
  const merged = uniqueStrings([...refArray(record[key]), ...items]);
  if (merged.length > 0) record[key] = merged;
}

function inheritReviewTaskTrace(task: ReviewTaskShape, existingTasks: ReviewTaskShape[] = []) {
  if (task.task_kind !== "review_fix") return;
  const files = new Set(scopeTargetFiles(task));
  const related = existingTasks.filter((candidate) => {
    if (candidate === task || candidate.task_kind === "review_fix") return false;
    const candidateFiles = scopeTargetFiles(candidate);
    return candidateFiles.some((file) => files.has(file));
  });
  const requirementIds = uniqueStrings(related.flatMap((candidate) => taskRequirementIds(candidate)));
  const designIds = uniqueStrings(related.flatMap((candidate) => taskDesignIds(candidate)));
  const relatedTaskIds = uniqueStrings(related.map((candidate) => String(candidate.id || "")));
  const evidenceFiles = taskEvidenceRefs(task);
  const sourceIds = sourceFindingIds(task);
  const trace = taskTrace(task);
  const reportPath = reviewReportPathFromTrace(trace);

  if (!Array.isArray(task.requirement_ids) || task.requirement_ids.length === 0) {
    task.requirement_ids = requirementIds;
  }
  if (!Array.isArray(task.design_ids) || task.design_ids.length === 0) {
    task.design_ids = designIds;
  }
  if (!Array.isArray(task.evidence_files) || task.evidence_files.length === 0) {
    task.evidence_files = evidenceFiles;
  }
  trace.source = "review_finding";
  if (reportPath && !trace.review_report_path) trace.review_report_path = reportPath;
  mergeStringField(trace, "requirement_ids", refArray(task.requirement_ids, requirementIds));
  mergeStringField(trace, "design_ids", refArray(task.design_ids, designIds));
  mergeStringField(trace, "source_finding_ids", sourceIds);
  mergeStringField(trace, "inherited_from_task_ids", relatedTaskIds);
  if (!Array.isArray(trace.evidence) || trace.evidence.length === 0) {
    trace.evidence = sourceIds.map((id) => ({ type: "review_finding", id, finding_id: id, ...(reportPath ? { report_path: reportPath } : {}) }));
  }
}

export type ReviewTaskLimitBlock = {
  blockerId: string;
  message: string;
  errorTitle: string;
  errorDetail: string;
  status: string;
  reason: string;
  human_needed: boolean;
  recovery_action: string;
  meta: {
    round: number;
    phase: string;
    generated_tasks: number;
    max_allowed: number;
    blocked_task_ids: string[];
    human_needed: boolean;
    recoverable: boolean;
    queue_strategy: string;
  };
};

export function buildReviewTaskLimitBlock({ round, taskCount, maxTasks, taskIds = [] }: {
  round: number;
  taskCount: number;
  maxTasks: number;
  taskIds?: string[];
}): ReviewTaskLimitBlock {
  const blockerId = `REVIEW-TASK-LIMIT-R${round}`;
  return {
    blockerId,
    message: `本轮将生成 ${taskCount} 个 executor 修复任务，超过上限 ${maxTasks}，拒绝写入 PRD`,
    errorTitle: "REVIEW_TASK_LIMIT_BLOCKED",
    errorDetail: `generated=${taskCount}, max=${maxTasks}`,
    status: "blocked",
    reason: "review_task_limit",
    human_needed: true,
    recovery_action: "split_review_findings_or_raise_review_task_limit",
    meta: {
      round,
      phase: "REVIEW_TASK_LIMIT_BLOCKED",
      generated_tasks: taskCount,
      max_allowed: maxTasks,
      blocked_task_ids: taskIds.slice(0, 50),
      human_needed: true,
      recoverable: true,
      queue_strategy: "human_needed",
    },
  };
}

export function markReviewTaskLimitBlocked({ taskResults, taskLimitBlock, appendUnique }: {
  taskResults: Record<string, unknown> | null | undefined;
  taskLimitBlock: ReviewTaskLimitBlock | null | undefined;
  appendUnique?: unknown;
}): Record<string, unknown> | null | undefined {
  if (!taskResults || !taskLimitBlock) return taskResults;
  const blocked = asArrayField(taskResults, "blocked");
  const append = isFn(appendUnique) ? appendUnique : appendUniqueFallback;
  append(blocked, [taskLimitBlock.blockerId]);
  taskResults.review_blocker = {
    id: taskLimitBlock.blockerId,
    status: taskLimitBlock.status,
    reason: taskLimitBlock.reason,
    human_needed: taskLimitBlock.human_needed,
    recovery_action: taskLimitBlock.recovery_action,
    meta: taskLimitBlock.meta,
  };
  return taskResults;
}

export function markReviewOutcome({
  taskResults,
  appendUnique,
  id,
  status = "failed",
  reason,
  message,
  humanNeeded = false,
  meta = Object(),
}: {
  taskResults?: Record<string, unknown> | null;
  appendUnique?: unknown;
  id?: string | null;
  status?: string;
  reason?: string;
  message?: string;
  humanNeeded?: boolean;
  meta?: Record<string, unknown>;
} = Object()): Record<string, unknown> | null | undefined {
  if (!taskResults || !id) return taskResults;
  const failed = asArrayField(taskResults, "failed");
  const blocked = asArrayField(taskResults, "blocked");
  const append = isFn(appendUnique) ? appendUnique : appendUniqueFallback;
  append(failed, [id]);
  if (status === "blocked") append(blocked, [id]);
  taskResults.review_outcome = {
    id,
    status,
    reason,
    message,
    human_needed: humanNeeded,
    meta,
  };
  return taskResults;
}

export function appendReviewTasksToPrd({
  prd,
  progress,
  tasks = [],
  ensureTaskShape = (task: ReviewTaskShape) => task,
}: {
  prd: Record<string, unknown>;
  progress?: { total: number } | null;
  tasks?: ReviewTaskShape[];
  ensureTaskShape?: (task: ReviewTaskShape) => ReviewTaskShape;
}): Array<{ id: unknown; priority: unknown; title: unknown }> {
  const added: Array<{ id: unknown; priority: unknown; title: unknown }> = [];
  const prdTasks = Array.isArray(prd.tasks) ? (prd.tasks as ReviewTaskShape[]) : ((prd.tasks = []) as ReviewTaskShape[]);
  for (const task of tasks) {
    ensureTaskShape(task);
    inheritReviewTaskTrace(task, prdTasks);
    prdTasks.push(task);
    if (progress) progress.total++;
    added.push({
      id: task.id,
      priority: task.priority,
      title: task.title,
    });
  }
  return added;
}

export function reviewTaskIdSet(tasks: ReviewTaskShape[] = []): Set<string> {
  return new Set(tasks.map((task) => task.id).filter(Boolean) as string[]);
}

export function hasReviewFixFailures(reviewResults: Record<string, unknown> = Object()): boolean {
  const failed = Array.isArray(reviewResults.failed) ? reviewResults.failed : [];
  const blocked = Array.isArray(reviewResults.blocked) ? reviewResults.blocked : [];
  return failed.length > 0 || blocked.length > 0;
}

export function reviewFixFailureDetail(reviewResults: Record<string, unknown> = Object()): string {
  const failed = Array.isArray(reviewResults.failed) ? reviewResults.failed : [];
  const blocked = Array.isArray(reviewResults.blocked) ? reviewResults.blocked : [];
  return `failed=${failed.length}, blocked=${blocked.length}`;
}

export type PendingReviewDecision = {
  action: "continue" | "break" | "next-round";
  nextPendingCount: number;
  message: string | null;
};

export function pendingReviewDecision({ pendingReviewTasks = [], prevPendingCount, round }: {
  pendingReviewTasks?: ReviewTaskShape[];
  prevPendingCount?: number;
  round: number;
}): PendingReviewDecision {
  if (pendingReviewTasks.length === 0) {
    return {
      action: "continue",
      nextPendingCount: 0,
      message: "本轮 review 任务已处理，继续下一轮扫描",
    };
  }
  if (round > 1 && pendingReviewTasks.length === prevPendingCount) {
    return {
      action: "break",
      nextPendingCount: pendingReviewTasks.length,
      message: "连续两轮无进展，退出 review",
    };
  }
  return {
    action: "next-round",
    nextPendingCount: pendingReviewTasks.length,
    message: null,
  };
}
