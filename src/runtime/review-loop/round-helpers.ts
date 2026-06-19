import { normalizeReviewFinding, normalizeReviewFindings } from "../../review/findings.js";
import { reviewFindingsToPrdTasks } from "../../review/findings-to-tasks.js";

function appendUnique(target, items = []) {
  const seen = new Set(target);
  for (const item of items) {
    if (!seen.has(item)) {
      target.push(item);
      seen.add(item);
    }
  }
}

export function isDryRunPrd(prd) {
  if (!prd) return false;
  if (prd.execution_mode === "dry_run") return true;
  if (prd.review_policy?.allow_prd_mutation === false) return true;
  if (String(prd.id || "").includes("DRY-RUN")) return true;
  const tasks = Array.isArray(prd.tasks) ? prd.tasks : [];
  return tasks.length > 0 && tasks.every((task) => task.task_kind === "dry_run_artifact");
}

export function shouldSkipReviewForPrd(prd) {
  return isDryRunPrd(prd) || prd?.review_policy?.mode === "report_only" || prd?.review_policy?.mode === "disabled";
}

export function reviewScopeFilesForPrd(prd, { normalizeRepoPath = (value) => value } = Object()) {
  if (prd?.review_policy?.scope === "full") return [];
  const files = [];
  for (const task of prd?.tasks || []) {
    for (const target of task.scope?.targets || []) {
      const file = normalizeRepoPath(target.file);
      if (/^src\/.*\.(?:[cm]?[jt]sx?)$/i.test(file)) files.push(file);
    }
  }
  return [...new Set(files)].sort();
}

export function fallbackClassifyFindings(findings = [], round) {
  const normalizedFindings = normalizeReviewFindings(findings, { source: "review-classifier" });
  const infoCount = normalizedFindings.filter((finding) => finding.fix_type === "INFO").length;
  const converted = reviewFindingsToPrdTasks(normalizedFindings, { round });
  const autoFixTasks = [];
  const claudeFixTasks = [];
  for (const task of converted.tasks) {
    if (task.fix_type === "AUTO_FIX") autoFixTasks.push(task);
    else claudeFixTasks.push(task);
  }
  return {
    autoFixTasks,
    claudeFixTasks,
    infoCount,
  };
}

export function contractReviewFindings(findings = []) {
  return findings
    .filter((finding) =>
      finding.finding_id || finding.must_fix_before_ship === true || Array.isArray(finding.evidence)
    )
    .map((finding, index) => normalizeReviewFinding(finding, { source: "review-contract", index }));
}

export function mergeClaudeReviewTasks({ claudeFixTasks = [], reviewToPrdTasks = [], escalatedFromAuto = [] }) {
  return [...claudeFixTasks, ...reviewToPrdTasks, ...escalatedFromAuto];
}

export function reviewClassifierMeta({ round, findings = [], autoFixTasks = [], claudeFixTasks = [], reviewToPrdTasks = [], infoCount = 0 }) {
  const allClaudeTasks = mergeClaudeReviewTasks({ claudeFixTasks, reviewToPrdTasks });
  return {
    round,
    total_findings: findings.length,
    auto_fix_tasks: autoFixTasks.length,
    claude_fix_tasks: allClaudeTasks.length,
    info_count: infoCount,
    auto_fix_ids: autoFixTasks.map((task) => task.id),
    claude_fix_ids: allClaudeTasks.map((task) => task.id),
  };
}

export function reviewIssueLogInput(finding = Object()) {
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

export function ensureReviewTaskShape(task) {
  if (!task.scope) task.scope = { targets: [] };
  if (!task.pre_conditions) task.pre_conditions = [];
  if (!task.post_conditions) task.post_conditions = [];
  if (!task.acceptance_criteria) task.acceptance_criteria = [];
  const sourceFindings = Array.isArray(task.source_findings)
    ? task.source_findings
    : Array.isArray(task.fix_findings)
      ? task.fix_findings
      : [];
  if (sourceFindings.length > 0 && (!Array.isArray(task.source_finding_ids) || task.source_finding_ids.length === 0)) {
    task.source_finding_ids = sourceFindings
      .map((finding) => finding?.finding_id || finding?.id || finding?.scanner_id || finding?.rule_id)
      .filter(Boolean);
  }
  if (task.task_kind === "review_fix" && task.post_conditions.length === 0) {
    const targets = Array.isArray(task.scope?.targets) ? task.scope.targets : [];
    task.post_conditions.push(
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
      const file = finding?.file || finding?.files?.[0] || targets[0]?.file || "";
      if (match && file) {
        task.post_conditions.push({
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
    task.post_conditions.push({
      id: `POST-${task.id || "REVIEW"}-TYPECHECK`,
      type: "no_new_type_errors",
      severity: "FAIL",
      params: { command: "npm run typecheck" },
      message: "project typecheck must pass after the review fix",
    });
  }
  return task;
}

export function buildReviewPreCompletedSet({ resumeCompleted = new Set(), completed = [], skipped = [] }) {
  return new Set([
    ...resumeCompleted,
    ...completed,
    ...skipped,
  ]);
}

export function mergeReviewResults({ taskResults, reviewResults }) {
  appendUnique(taskResults.completed, reviewResults.completed || []);
  appendUnique(taskResults.failed, reviewResults.failed || []);
  appendUnique(taskResults.skipped, reviewResults.skipped || []);
  if (!Array.isArray(taskResults.blocked)) taskResults.blocked = [];
  appendUnique(taskResults.blocked, reviewResults.blocked || []);
  return taskResults;
}

export function pendingReviewTasks(prd) {
  return (prd.tasks || []).filter(
    (task) => task.status === "pending" && task.id && (task.id.startsWith("FIX-R") || task.id.startsWith("AUTO-FIX-R")),
  );
}
