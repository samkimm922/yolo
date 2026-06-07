import { normalizeReviewFinding, normalizeReviewFindings } from "../../review/findings.js";

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

export function reviewScopeFilesForPrd(prd, { normalizeRepoPath = (value) => value } = {}) {
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
  const claudeFindings = normalizedFindings.filter((finding) => finding.fix_type !== "INFO");
  const infoCount = normalizedFindings.filter((finding) => finding.fix_type === "INFO").length;
  return {
    autoFixTasks: [],
    claudeFixTasks: claudeFindings.length > 0 ? [{
      id: `FIX-R${round}-001`,
      title: `[code] ${claudeFindings.length} 个代码问题`,
      type: "bugfix",
      priority: "P2",
      status: "pending",
      depends_on: [],
      scope: {
        targets: [...new Set(claudeFindings.flatMap((finding) =>
          (finding.files || []).map((file) => ({ file: file.replace(/:\d+$/, "") })),
        ))],
      },
      pre_conditions: [],
      post_conditions: [],
      acceptance_criteria: claudeFindings.map((finding) => finding.description).slice(0, 20),
      description: claudeFindings.map((finding) => `- [${finding.severity || "MEDIUM"}] ${finding.description}`).join("\n"),
      source_findings: claudeFindings,
    }] : [],
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

export function reviewIssueLogInput(finding = {}) {
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
