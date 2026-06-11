#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeReviewFinding } from "./findings.js";

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

function severityToPriority(severity) {
  switch (String(severity || "").toUpperCase()) {
    case "CRITICAL": return "P0";
    case "HIGH": return "P1";
    case "MEDIUM": return "P2";
    default: return "P3";
  }
}

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/:\d+(?:-\d+)?$/, "");
}

function cleanId(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "REVIEW";
}

function findingId(finding, index) {
  return String(
    finding?.finding_id ||
    finding?.id ||
    finding?.scanner_id ||
    finding?.rule_id ||
    `REVIEW-${index + 1}`,
  );
}

function findingFiles(finding) {
  const files = [
    finding?.file,
    finding?.path,
    finding?.filename,
    finding?.location?.file,
    ...(Array.isArray(finding?.files) ? finding.files : []),
  ];
  return [...new Set(files.map(normalizePath).filter(Boolean))];
}

function findingDescription(finding) {
  return String(
    finding?.description ||
    finding?.message ||
    finding?.title ||
    finding?.summary ||
    "Review finding must be fixed before ship",
  );
}

function truncateText(value, max = 160) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function taskIdForFinding(finding, round, index, existingIds) {
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

function existingTaskIds(tasks = []) {
  return new Set(tasks.map((task) => task?.id).filter(Boolean));
}

function taskTypeForFinding(finding) {
  const dimension = String(finding?.dimension || finding?.category || "").toLowerCase();
  const scannerId = String(finding?.scanner_id || finding?.rule_id || "").toLowerCase();
  if (dimension.includes("security") || scannerId.includes("security") || scannerId.includes("xss")) return "security";
  if (finding?.fix_type === "AUTO_FIX") return "cleanup";
  return "bugfix";
}

function targetConditions(taskId, files) {
  return files.map((file, index) => ({
    id: `POST-${taskId}-TARGET-${index + 1}`,
    type: "target_file_modified",
    severity: "FAIL",
    params: { file },
    message: `review finding target must be modified: ${file}`,
  }));
}

function absenceCondition(taskId, finding, files) {
  const match = truncateText(finding?.match || finding?.evidence_text || finding?.pattern);
  if (!match || !files.length) return [];
  return files.slice(0, 3).map((file, index) => ({
    id: `POST-${taskId}-ABSENT-${index + 1}`,
    type: "code_not_contains",
    severity: "FAIL",
    params: { file, text: match },
    message: "review finding matched text must be removed or rewritten",
  }));
}

function preConditions(taskId, finding, files) {
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

export function reviewFindingsToPrdTasks(findings = [], options = Object()) {
  const round = Number.isInteger(options.round) ? options.round : 1;
  const existingIds = existingTaskIds(options.existingTasks || []);
  const tasks = [];
  const skipped = [];

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

    const taskId = taskIdForFinding(finding, round, index, existingIds);
    const description = findingDescription(finding);
    const sourceFindingId = findingId(finding, index);

    tasks.push({
      id: taskId,
      title: `[review] ${truncateText(description, 86)}`,
      type: taskTypeForFinding(finding),
      priority: severityToPriority(finding?.severity),
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
        ...absenceCondition(taskId, finding, files),
      ],
      acceptance_criteria: [
        description,
        "Related review finding is fixed and does not reappear in the next review scan.",
      ],
      task_kind: "review_fix",
      fix_type: finding?.fix_type === "AUTO_FIX" ? "AUTO_FIX" : "CLAUDE_FIX",
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
