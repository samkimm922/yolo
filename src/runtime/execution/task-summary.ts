import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const TASK_SUMMARY_SCHEMA = "yolo.task_summary.v1";

type ScopeTarget = string | { file?: unknown } | null | undefined;

type PostConditionRecord = {
  type?: unknown;
  severity?: unknown;
  params?: {
    file?: unknown;
    max?: unknown;
  };
};

type SummaryTask = {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  post_conditions?: readonly PostConditionRecord[];
  scope?: {
    targets?: readonly ScopeTarget[];
    readonly_files?: readonly unknown[];
  };
};

type SummaryOutcome = {
  status?: unknown;
  reason?: unknown;
};

type EvidenceFinding = {
  type?: unknown;
  code?: unknown;
  message?: unknown;
  summary?: unknown;
  finding?: {
    code?: unknown;
    message?: unknown;
  };
};

// Rough token estimation: English ~4 chars/token, CJK ~1.5 chars/token, mixed ~3 chars/token
export function estimateTokens(text: unknown = "") {
  if (text == null || text === "") return 0;
  const str = String(text);
  if (!str.trim()) return 0;
  const cjkChars = (str.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  const otherChars = str.length - cjkChars;
  return Math.ceil(cjkChars / 1.5 + otherChars / 4);
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function readEvidenceDir(taskRoot: string): EvidenceFinding[] {
  const findings: EvidenceFinding[] = [];
  if (!taskRoot || !existsSync(taskRoot)) return findings;
  try {
    const entries = readdirSync(taskRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(taskRoot, entry.name);
      if (entry.name.endsWith(".jsonl")) {
        try {
          const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
          for (const line of lines) {
            try { findings.push(JSON.parse(line)); } catch { /* skip malformed */ }
          }
        } catch { /* skip unreadable */ }
      } else if (entry.name.endsWith(".json")) {
        try { findings.push(JSON.parse(readFileSync(path, "utf8"))); } catch { /* skip */ }
      }
    }
  } catch { /* directory not readable */ }
  return findings;
}

function extractFragilityPoints(task: SummaryTask = Object(), outcome: SummaryOutcome = Object()) {
  const points: string[] = [];
  const postConditions = task.post_conditions || [];

  // Fragility from structural post-conditions that were verified
  for (const cond of postConditions) {
    if (cond.type === "file_lines_max" && cond.params?.max) {
      const file = cond.params.file || "unknown file";
      points.push(`文件 ${file} 超过 ${cond.params.max} 行限制，需要后续拆分`);
    }
    if (cond.type === "no_new_type_errors" && (cond.severity || "FAIL") !== "FAIL") {
      points.push("新增类型错误存在，类型系统可能不稳定");
    }
  }

  // Fragility from outcome
  if (outcome.status === "failed" || outcome.status === "blocked") {
    points.push(`任务以 ${outcome.status} 结束: ${clean(outcome.reason).slice(0, 120)}`);
  }

  // Fragility from cross-file changes
  const files = (task.scope?.targets || []).map((target: ScopeTarget) => clean((target as { file?: unknown })?.file ?? target));
  if (files.length > 2) {
    points.push(`跨 ${files.length} 个文件修改，耦合度高，改动回滚风险上升`);
  }

  return [...new Set(points)].slice(0, 5);
}

function extractAssumptionChanges(task: SummaryTask = Object(), outcome: SummaryOutcome = Object(), evidenceFindings: EvidenceFinding[] = []) {
  const changes: string[] = [];

  // Assumption changes from evidence findings
  for (const finding of evidenceFindings) {
    if (finding.type === "assumption_change" || finding.code === "ASSUMPTION_CHANGED") {
      changes.push(String(finding.message || finding.summary || JSON.stringify(finding).slice(0, 200)));
    }
    if (finding.finding?.code === "ASSUMPTION_INVALIDATED") {
      changes.push(`假设失效: ${finding.finding.message || ""}`.slice(0, 200));
    }
  }

  // Assumption change if task touched unexpected files
  const targets = (task.scope?.targets || []).map((target: ScopeTarget) => clean((target as { file?: unknown })?.file ?? target));
  const readonly = (task.scope?.readonly_files || []).map(clean).filter(Boolean);
  if (readonly.length > 5) {
    changes.push(`任务引用了 ${readonly.length} 个只读文件，假设范围可能偏大`);
  }

  // Outcome-based assumption validation
  if (outcome.status === "completed") {
    const postConditions = task.post_conditions || [];
    const failConditions = postConditions.filter((cond: PostConditionRecord) => (cond.severity || "FAIL") === "FAIL");
    if (failConditions.length <= 2 && targets.length === 1) {
      changes.push("单一文件最小修改验证通过: 假设范围准确");
    }
  }

  return [...new Set(changes)].slice(0, 5);
}

export function buildTaskSummary({ task = Object(), outcome = Object(), evidenceDir = "", projectRoot = "" }: {
  task?: SummaryTask;
  outcome?: SummaryOutcome;
  evidenceDir?: string;
  projectRoot?: string;
} = Object()) {
  const taskId = clean(task.id);
  const title = clean(task.title || task.description || taskId);
  const status = clean(outcome.status || "unknown");
  const files = (task.scope?.targets || []).map((target: ScopeTarget) => clean((target as { file?: unknown })?.file ?? target));
  const readonly = (task.scope?.readonly_files || []).map(clean).filter(Boolean);

  const taskRoot = evidenceDir || resolve(projectRoot, "state/evidence", taskId);
  const evidenceFindings = readEvidenceDir(taskRoot);

  const fragilityPoints = extractFragilityPoints(task, outcome);
  const assumptionChanges = extractAssumptionChanges(task, outcome, evidenceFindings);

  const summary = status === "completed"
    ? `完成 ${title}: 修改 ${files.length} 个文件`
    : `${status}: ${title} — ${clean(outcome.reason).slice(0, 100)}`;

  const forwardIntelligence = {
    fragility_points: fragilityPoints,
    assumption_changes: assumptionChanges,
  };

  const fullSummary = {
    schema: TASK_SUMMARY_SCHEMA,
    task_id: taskId,
    title,
    status,
    summary,
    files_touched: files,
    readonly_files_used: readonly.length,
    forward_intelligence: forwardIntelligence,
    generated_at: new Date().toISOString(),
  };

  return {
    ...fullSummary,
    token_estimate: estimateTokens(JSON.stringify(fullSummary)),
  };
}

type FormattableSummary = {
  task_id?: unknown;
  status?: unknown;
  summary?: unknown;
  forward_intelligence?: {
    fragility_points?: readonly unknown[];
    assumption_changes?: readonly unknown[];
  };
};

export function formatSummaryBlock(summary: FormattableSummary) {
  const fi = summary.forward_intelligence || {};
  const parts = [
    `[${summary.task_id}] ${summary.status}: ${summary.summary}`,
  ];
  if (fi.fragility_points?.length) {
    parts.push(`脆弱点: ${fi.fragility_points.join("; ")}`);
  }
  if (fi.assumption_changes?.length) {
    parts.push(`假设变化: ${fi.assumption_changes.join("; ")}`);
  }
  return parts.join("\n");
}
