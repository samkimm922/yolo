import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeLifecycleStageReport } from "../lifecycle/progress.js";
import { inspectPrdContract } from "../runtime/gates/prd-contract-doctor.js";
import { inspectSpecGovernanceGate } from "../runtime/gates/spec-governance-gate.js";
import { buildReviewOutput, normalizeReviewFindings } from "./findings.js";
import { reviewFindingsToPrdTasks } from "./findings-to-tasks.js";

export const REVIEW_FIX_LOOP_SCHEMA_VERSION = "1.0";
export const REVIEW_FIX_LOOP_REPORT_SCHEMA = "yolo.review.fix_loop_report.v1";

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value ?? "").trim();
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function severityBlocksShip(severity) {
  return ["CRITICAL", "HIGH"].includes(String(severity || "").toUpperCase());
}

function requirementForTask(task, index) {
  const source = task.source_findings?.[0] || {};
  return {
    id: `REQ-${task.id}`,
    text: source.message || source.description || task.title || `Fix review finding ${index + 1}`,
  };
}

function designForTask(task) {
  const files = (task.scope?.targets || []).map((target) => target.file).filter(Boolean);
  return {
    id: `DES-${task.id}`,
    text: `Apply the smallest safe fix for ${task.id}${files.length ? ` in ${files.join(", ")}` : ""}, then rerun related gates.`,
  };
}

export function buildReviewFixPrd(findings = [], options = Object()) {
  const converted = reviewFindingsToPrdTasks(findings, {
    round: options.round,
    existingTasks: options.existingTasks,
  });
  const requirements = converted.tasks.map(requirementForTask);
  const designs = converted.tasks.map(designForTask);
  const tasks = converted.tasks.map((task) => ({
    ...task,
    requirement_ids: task.requirement_ids?.length ? task.requirement_ids : [`REQ-${task.id}`],
    design_ids: task.design_ids?.length ? task.design_ids : [`DES-${task.id}`],
  }));
  const now = clean(options.now) || nowIso();
  return {
    version: "2.0",
    id: options.id || `PRD-REVIEW-FIX-${now.replace(/[-:.TZ]/g, "").slice(0, 14)}`,
    title: options.title || "Review fix PRD",
    project: options.project || { name: options.projectName || "project", language: options.language || "unknown" },
    generated_by: "yolo-review-fix-loop",
    generated_at: now,
    base_commit: options.baseCommit || options.base_commit || "unknown",
    requirements,
    designs,
    tasks,
    source_review: {
      finding_count: normalizeReviewFindings(findings).length,
      converted_count: converted.tasks.length,
      skipped: converted.skipped,
    },
  };
}

export function inspectReviewFixLoop(input = Object(), options = Object()) {
  const rawFindings = input.findings || input.reviewOutput?.findings || input.review_output?.findings || [];
  const review = buildReviewOutput(rawFindings, { source: input.source || options.source || "review-fix-loop" });
  const fixPrd = buildReviewFixPrd(review.findings, options);
  const contract = inspectPrdContract(fixPrd);
  const spec = inspectSpecGovernanceGate({ prd: fixPrd }).result;
  const blockingFindings = review.findings.filter((finding) => severityBlocksShip(finding.severity) || finding.must_fix_before_ship === true);
  const blockers = [
    ...blockingFindings.map((finding) => ({
      code: "REVIEW_FINDING_BLOCKS_SHIP",
      finding_id: finding.finding_id,
      severity: finding.severity,
      message: finding.message,
      file: finding.file,
    })),
    ...(contract.blocks_execution ? contract.failures.map((failure) => ({
      code: failure.code || "FIX_PRD_CONTRACT_BLOCKED",
      task_id: failure.task_id || null,
      message: failure.detail || "Fix PRD contract blocked execution.",
    })) : []),
    ...(spec.blocks_execution ? spec.blockers.map((blocker) => ({
      code: blocker.code || "FIX_PRD_SPEC_BLOCKED",
      task_id: blocker.task_id || null,
      message: blocker.message,
    })) : []),
  ];
  const status = blockers.length > 0 ? "blocked" : "pass";
  const report = Object.assign(Object(), {
    schema_version: REVIEW_FIX_LOOP_SCHEMA_VERSION,
    schema: REVIEW_FIX_LOOP_REPORT_SCHEMA,
    status,
    code: status === "blocked" ? "REVIEW_FIX_REQUIRED" : "REVIEW_FIX_CLEAR",
    summary: status === "blocked"
      ? "Review findings require scoped fix PRD before ship."
      : "No blocking review fix work remains.",
    generated_at: nowIso(),
    review,
    fix_prd: fixPrd,
    contract,
    spec_governance: spec,
    blockers,
    artifacts: [],
    next_actions: blockers.length > 0
      ? ["Approve the generated fix PRD scope, run /yolo-check, then run /yolo-fix.", "Rerun review after fixes complete."]
      : ["Continue to /yolo-accept or /yolo-ship."],
  });
  if (input.output || options.output) {
    const output = resolve(input.output || options.output);
    mkdirSync(dirname(output), { recursive: true });
    if (!existsSync(output) || options.force === true || input.force === true) {
      writeFileSync(output, stableJson(fixPrd), "utf8");
    }
    report.fix_prd_path = output;
    report.artifacts.push(output);
  }
  if (input.writeLifecycle || input.write_lifecycle || options.writeLifecycle || options.write_lifecycle) {
    report.lifecycle_write = writeLifecycleStageReport("review-fix", report, {
      projectRoot: input.projectRoot || input.project_root || options.projectRoot || options.project_root,
      stateRoot: input.stateRoot || input.state_root || options.stateRoot || options.state_root,
      source: "review-fix-loop",
      learnFailures: options.learnFailures === true || input.learnFailures === true,
      skipSequenceCheck: true,
    });
    report.artifacts.push(report.lifecycle_write.artifact_path);
  }
  return report;
}
