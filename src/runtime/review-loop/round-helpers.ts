import { normalizeReviewFinding, normalizeReviewFindings } from "../../review/findings.js";
import type { NormalizedReviewFinding, ReviewFindingInput } from "../../review/findings.js";
import { reviewFindingsToPrdTasks } from "../../review/findings-to-tasks.js";
import type { ReviewPrdTask } from "../../review/findings-to-tasks.js";
import { loadProjectToolchainConfig, resolveBuildCommand } from "../../lib/toolchain.js";

type Prd = Record<string, unknown>;
type Task = Record<string, unknown>;

function appendUnique(target: unknown[], items: unknown[] = []) {
  const seen = new Set(target);
  for (const item of items) {
    if (!seen.has(item)) {
      target.push(item);
      seen.add(item);
    }
  }
}

export function isDryRunPrd(prd: Prd | null | undefined): boolean {
  if (!prd) return false;
  if (prd.execution_mode === "dry_run") return true;
  const reviewPolicy = prd.review_policy as Record<string, unknown> | undefined | null;
  if (reviewPolicy?.allow_prd_mutation === false) return true;
  if (String(prd.id || "").includes("DRY-RUN")) return true;
  const tasks = Array.isArray(prd.tasks) ? (prd.tasks as Task[]) : [];
  return tasks.length > 0 && tasks.every((task) => task.task_kind === "dry_run_artifact");
}

export function shouldSkipReviewForPrd(prd: Prd | null | undefined): boolean {
  if (isDryRunPrd(prd)) return true;
  const reviewPolicy = prd?.review_policy as Record<string, unknown> | undefined | null;
  return reviewPolicy?.mode === "report_only" || reviewPolicy?.mode === "disabled";
}

export function reviewScopeFilesForPrd(
  prd: Prd | null | undefined,
  { normalizeRepoPath = (value: unknown) => value as string }: {
    normalizeRepoPath?: (value: unknown) => string;
  } = Object(),
): string[] {
  const reviewPolicy = prd?.review_policy as Record<string, unknown> | undefined | null;
  if (reviewPolicy?.scope === "full") return [];
  const files: string[] = [];
  const tasks = Array.isArray(prd?.tasks) ? (prd?.tasks as Task[]) : [];
  for (const task of tasks) {
    const scope = task.scope as Record<string, unknown> | undefined | null;
    const targets = Array.isArray(scope?.targets) ? (scope?.targets as Array<Record<string, unknown>>) : [];
    for (const target of targets) {
      const file = normalizeRepoPath(target.file);
      if (/^src\/.*\.(?:[cm]?[jt]sx?)$/i.test(file)) files.push(file);
    }
  }
  return [...new Set(files)].sort();
}

export type FallbackClassifierResult = {
  executorTasks: ReviewPrdTask[];
  infoCount: number;
};

export function fallbackClassifyFindings(
  findings: ReviewFindingInput[] = [],
  round?: number,
  options: Record<string, unknown> = Object(),
): FallbackClassifierResult {
  const normalizedFindings = normalizeReviewFindings(findings, { source: "review-classifier" });
  const infoCount = normalizedFindings.filter((finding) => finding.fix_type === "INFO").length;
  const converted = reviewFindingsToPrdTasks(normalizedFindings, { ...options, round });
  return {
    executorTasks: converted.tasks,
    infoCount,
  };
}

export function contractReviewFindings(findings: ReviewFindingInput[] = []): NormalizedReviewFinding[] {
  return findings
    .filter((finding) =>
      finding.finding_id || finding.must_fix_before_ship === true || Array.isArray(finding.evidence)
    )
    .map((finding, index) => normalizeReviewFinding(finding, { source: "review-contract", index }));
}

export function reviewClassifierMeta({
  round,
  findings = [],
  executorTasks = [],
  infoCount = 0,
}: {
  round?: number;
  findings?: unknown[];
  executorTasks?: Array<{ id?: unknown }>;
  infoCount?: number;
}) {
  return {
    round,
    total_findings: findings.length,
    executor_tasks: executorTasks.length,
    info_count: infoCount,
    executor_task_ids: executorTasks.map((task) => task.id),
  };
}

export function reviewIssueLogInput(finding: ReviewFindingInput = Object()) {
  const normalized = normalizeReviewFinding(finding, { source: "review-log" });
  return {
    schema_version: normalized.schema_version,
    schema: normalized.schema,
    severity: normalized.severity,
    file: normalized.file,
    line: normalized.line,
    message: normalized.message,
    code: normalized.code,
    source: normalized.source,
    fix_type: normalized.fix_type,
    finding_id: normalized.finding_id,
    rule_id: normalized.rule_id,
    scanner_id: normalized.scanner_id,
    suggested_fix: normalized.suggested_fix,
  };
}

export function ensureReviewTaskShape(task: Task, context: { config?: Record<string, unknown>; projectRoot?: string } = Object()): Task {
  if (!task.scope) task.scope = { targets: [] };
  if (!task.pre_conditions) task.pre_conditions = [];
  if (!task.post_conditions) task.post_conditions = [];
  if (!task.acceptance_criteria) task.acceptance_criteria = [];
  const rawSource = Array.isArray(task.source_findings)
    ? (task.source_findings as Array<Record<string, unknown>>)
    : Array.isArray(task.fix_findings)
      ? (task.fix_findings as Array<Record<string, unknown>>)
      : [];
  const sourceFindings = rawSource;
  const currentIds = task.source_finding_ids;
  if (sourceFindings.length > 0 && (!Array.isArray(currentIds) || (currentIds as unknown[]).length === 0)) {
    task.source_finding_ids = sourceFindings
      .map((finding) => finding?.finding_id || finding?.id || finding?.scanner_id || finding?.rule_id)
      .filter(Boolean);
  }
  if (task.task_kind === "review_fix") {
    const postConditions = task.post_conditions as unknown[];
    if (Array.isArray(postConditions) && postConditions.length === 0) {
      const scope = task.scope as Record<string, unknown> | undefined;
      const targets = Array.isArray(scope?.targets) ? (scope?.targets as Array<Record<string, unknown>>) : [];
      postConditions.push(
        ...targets.map((target, index) => ({
          id: `POST-${task.id || "REVIEW"}-TARGET-${index + 1}`,
          type: "target_file_modified",
          severity: "FAIL",
          params: { file: target.file },
          message: `review fix must modify target file: ${target.file}`,
        })),
      );
      for (const [index, finding] of sourceFindings.entries()) {
        const match = String(finding?.match || finding?.evidence_text || "").trim();
        const files = finding?.files as unknown[] | undefined;
        const fallbackFile = (Array.isArray(files) ? files[0] : undefined) ?? targets[0]?.file ?? "";
        const file = finding?.file || fallbackFile;
        if (match && file) {
          postConditions.push({
            id: `POST-${task.id || "REVIEW"}-ABSENT-${index + 1}`,
            type: "code_not_contains",
            severity: "FAIL",
            params: {
              file: String(file).replace(/:\d+(?:-\d+)?$/, ""),
              text: match.slice(0, 160),
              source_finding_id: finding?.finding_id || finding?.id || finding?.scanner_id || finding?.rule_id || null,
              scanner_id: finding?.scanner_id || finding?.rule_id || null,
            },
            message: "review finding matched text must be removed or rewritten",
          });
        }
      }
      const projectRoot = context.projectRoot || process.cwd();
      const buildConfig = context.config || loadProjectToolchainConfig(projectRoot);
      postConditions.push({
        id: `POST-${task.id || "REVIEW"}-TYPECHECK`,
        type: "no_new_type_errors",
        severity: "FAIL",
        params: { command: resolveBuildCommand("type_check", buildConfig, projectRoot) },
        message: "project typecheck must pass after the review fix",
      });
    }
  }
  return task;
}

export function buildReviewPreCompletedSet(input: {
  resumeCompleted?: Set<unknown> | Iterable<unknown>;
  completed?: unknown[];
  skipped?: unknown[];
} = Object()): Set<unknown> {
  const r = input.resumeCompleted ?? new Set<unknown>();
  const c = input.completed ?? [];
  const s = input.skipped ?? [];
  return new Set<unknown>([
    ...r,
    ...c,
    ...s,
  ]);
}

export function mergeReviewResults({ taskResults, reviewResults }: {
  taskResults: Record<string, unknown>;
  reviewResults: Record<string, unknown>;
}): Record<string, unknown> {
  appendUnique(taskResults.completed as unknown[], (reviewResults.completed as unknown[]) || []);
  appendUnique(taskResults.failed as unknown[], (reviewResults.failed as unknown[]) || []);
  appendUnique(taskResults.skipped as unknown[], (reviewResults.skipped as unknown[]) || []);
  if (!Array.isArray(taskResults.blocked)) taskResults.blocked = [];
  appendUnique(taskResults.blocked as unknown[], (reviewResults.blocked as unknown[]) || []);
  return taskResults;
}

export function pendingReviewTasks(prd: Prd): Task[] {
  const tasks = Array.isArray(prd.tasks) ? (prd.tasks as Task[]) : [];
  return tasks.filter((task) => {
    if (task.status !== "pending") return false;
    if (typeof task.id !== "string" || task.id === "") return false;
    return task.id.startsWith("FIX-R") || task.id.startsWith("AUTO-FIX-R");
  });
}
