#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeReviewFinding } from "./findings.js";
import type { NormalizedReviewFinding, ReviewFindingInput } from "./findings.js";
import { severityToPriority } from "../lib/severity-priority.js";

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

type ExistingTask = {
  id?: unknown;
};

type ReviewTaskCondition = {
  id: string;
  type: string;
  severity: "FAIL";
  params: Record<string, unknown>;
  message: string;
};

type ReviewTaskTarget = {
  file: string;
};

export type ReviewPrdTask = {
  id: string;
  title: string;
  type: string;
  priority: string;
  status: "pending";
  description: string;
  depends_on: string[];
  scope: {
    targets: ReviewTaskTarget[];
    max_files: number;
    max_lines_per_file: number;
  };
  pre_conditions: ReviewTaskCondition[];
  post_conditions: ReviewTaskCondition[];
  acceptance_criteria: string[];
  task_kind: "review_fix";
  fix_type: "AUTO_FIX" | "CLAUDE_FIX";
  fix_rule: string;
  fix_findings: NormalizedReviewFinding[];
  source_finding_ids: string[];
  source_findings: NormalizedReviewFinding[];
  dedupe_key: string;
  must_fix_before_ship: boolean;
  requirement_ids?: string[];
  design_ids?: string[];
};

export type ReviewFindingsToPrdTasksOptions = {
  [key: string]: unknown;
  round?: number;
  existingTasks?: ExistingTask[];
};

type ReviewConversionOmitted = Array<{
    finding_id: string;
    code: string;
    detail: string;
  }>;

export type ReviewFindingsToPrdTasksResult = {
  blocks_ship: boolean;
  tasks: ReviewPrdTask[];
  [key: string]: unknown;
};

function normalizePath(value: unknown): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/:\d+(?:-\d+)?$/, "");
}

function cleanId(value: unknown): string {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "REVIEW";
}

function findingId(finding: ReviewFindingInput, index: number): string {
  return String(
    finding?.finding_id ||
    finding?.id ||
    finding?.scanner_id ||
    finding?.rule_id ||
    `REVIEW-${index + 1}`,
  );
}

function findingFiles(finding: ReviewFindingInput): string[] {
  const files = [
    finding?.file,
    finding?.path,
    finding?.filename,
    finding?.location?.file,
    ...(Array.isArray(finding?.files) ? finding.files : []),
  ];
  return [...new Set(files.map(normalizePath).filter(Boolean))];
}

function findingDescription(finding: ReviewFindingInput): string {
  return String(
    finding?.description ||
    finding?.message ||
    finding?.title ||
    finding?.summary ||
    "Review finding must be fixed before ship",
  );
}

function truncateText(value: unknown, max = 160): string {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function taskIdForFinding(
  finding: ReviewFindingInput,
  round: number,
  index: number,
  existingIds: Set<unknown>,
): string {
  const base = `FIX-R${round}-${String(index + 1).padStart(3, "0")}`;
  if (!existingIds.has(base)) {
    existingIds.add(base);
    return base;
  }

  const suffix = cleanId(findingId(finding, index)).slice(0, 12);
  let candidate = `FIX-${suffix}-${String(index + 1).padStart(3, "0")}`;
  let attempt = 2;
  while (existingIds.has(candidate)) {
    candidate = `FIX-${suffix}-${String(index + 1).padStart(3, "0")}${String.fromCharCode(64 + attempt)}`;
    attempt += 1;
  }
  existingIds.add(candidate);
  return candidate;
}

function existingTaskIds(tasks: ExistingTask[] = []): Set<unknown> {
  return new Set(tasks.map((task) => task?.id).filter(Boolean));
}

function taskTypeForFinding(finding: ReviewFindingInput): string {
  const dimension = String(finding?.dimension || finding?.category || "").toLowerCase();
  const scannerId = String(finding?.scanner_id || finding?.rule_id || "").toLowerCase();
  if (dimension.includes("security") || scannerId.includes("security") || scannerId.includes("xss")) return "security";
  if (finding?.fix_type === "AUTO_FIX") return "cleanup";
  return "bugfix";
}

function targetConditions(taskId: string, files: string[]): ReviewTaskCondition[] {
  return files.map((file, index) => ({
    id: `POST-${taskId}-TARGET-${index + 1}`,
    type: "target_file_modified",
    severity: "FAIL",
    params: { file },
    message: `review finding target must be modified: ${file}`,
  }));
}

function typecheckCondition(taskId: string): ReviewTaskCondition {
  return {
    id: `POST-${taskId}-TYPECHECK`,
    type: "no_new_type_errors",
    severity: "FAIL",
    params: { command: "npm run typecheck" },
    message: "project typecheck must pass after the review fix",
  };
}

function absenceCondition(
  taskId: string,
  finding: ReviewFindingInput,
  files: string[],
  sourceFindingId: string,
): ReviewTaskCondition[] {
  const match = truncateText(finding?.match || finding?.evidence_text || finding?.pattern);
  if (!match || !files.length) return [];
  return files.slice(0, 3).map((file, index) => ({
    id: `POST-${taskId}-ABSENT-${index + 1}`,
    type: "code_not_contains",
    severity: "FAIL",
    params: {
      file,
      text: match,
      source_finding_id: sourceFindingId,
      scanner_id: finding?.scanner_id || finding?.rule_id || null,
    },
    message: "original review finding matched text must be removed or rewritten",
  }));
}

function preConditions(taskId: string, finding: ReviewFindingInput, files: string[]): ReviewTaskCondition[] {
  const match = truncateText(finding?.match || finding?.evidence_text);
  if (!match || !files.length) return [];
  return [{
    id: `PRE-${taskId}-MATCH`,
    type: "code_contains",
    severity: "FAIL",
    params: { file: files[0], text: match },
    message: "review finding still exists before fix",
  }];
}

export function reviewFindingsToPrdTasks(
  findings: ReviewFindingInput[] = [],
  options: ReviewFindingsToPrdTasksOptions = Object(),
): ReviewFindingsToPrdTasksResult {
  const round = typeof options.round === "number" && Number.isInteger(options.round) ? options.round : 1;
  const existingIds = existingTaskIds(options.existingTasks || []);
  const tasks: ReviewPrdTask[] = [];
  const skipped: ReviewConversionOmitted = [];
  let taskIndex = 0;

  for (const [index, rawFinding] of findings.entries()) {
    const finding = normalizeReviewFinding(rawFinding, { source: "review-to-prd", index });
    if (finding?.fix_type === "INFO") continue;

    const files = findingFiles(finding);
    if (!files.length) {
      skipped.push({
        finding_id: findingId(finding, index),
        code: "REVIEW_FINDING_MISSING_FILE",
        detail: "review finding cannot be converted without at least one target file",
      });
      continue;
    }

    const taskId = taskIdForFinding(finding, round, taskIndex, existingIds);
    taskIndex++;
    const description = findingDescription(finding);
    const sourceFindingId = findingId(finding, index);

    tasks.push({
      id: taskId,
      title: `[review] ${truncateText(description, 86)}`,
      type: taskTypeForFinding(finding),
      priority: String(severityToPriority(finding?.severity)),
      status: "pending",
      description: [
        description,
        finding?.recommendation ? `Recommendation: ${finding.recommendation}` : null,
        finding?.risk ? `Risk: ${finding.risk}` : null,
      ].filter(Boolean).join("\n"),
      depends_on: [],
      scope: {
        targets: files.map((file) => ({ file })),
        max_files: Math.max(files.length + 1, 2),
        max_lines_per_file: 220,
      },
      pre_conditions: preConditions(taskId, finding, files),
      post_conditions: [
        ...targetConditions(taskId, files),
        ...absenceCondition(taskId, finding, files, sourceFindingId),
        typecheckCondition(taskId),
      ],
      acceptance_criteria: [
        description,
        "Related review finding is fixed and does not reappear in the next review scan.",
      ],
      task_kind: "review_fix",
      fix_type: finding?.fix_type === "AUTO_FIX" ? "AUTO_FIX" : "CLAUDE_FIX",
      fix_rule: finding?.scanner_id || finding?.rule_id || finding?.code || sourceFindingId,
      fix_findings: [finding],
      source_finding_ids: [sourceFindingId],
      source_findings: [finding],
      dedupe_key: `review:${sourceFindingId}:${files.join(",")}`,
      must_fix_before_ship: finding?.must_fix_before_ship === true || ["CRITICAL", "HIGH"].includes(String(finding?.severity || "").toUpperCase()),
    });
  }

  return {
    blocks_ship: tasks.some((task) => task.must_fix_before_ship) || tasks.length > 0,
    tasks,
    skipped,
  };
}

function main() {
  console.error("review-to-prd is a library module. Import reviewFindingsToPrdTasks().");
  process.exit(2);
}

if (isMain) main();
