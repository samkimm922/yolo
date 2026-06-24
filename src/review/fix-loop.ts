import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeLifecycleStageReport } from "../lifecycle/progress.js";
import { inspectPrdContract } from "../runtime/gates/prd-contract-doctor.js";
import { inspectSpecGovernanceGate } from "../runtime/gates/spec-governance-gate.js";
import { buildReviewOutput, normalizeReviewFindings } from "./findings.js";
import type { ReviewFindingInput } from "./findings.js";
import { reviewFindingsToPrdTasks } from "./findings-to-tasks.js";
import type { ReviewPrdTask } from "./findings-to-tasks.js";

export const REVIEW_FIX_LOOP_SCHEMA_VERSION = "1.0";
export const REVIEW_FIX_LOOP_REPORT_SCHEMA = "yolo.review.fix_loop_report.v1";

type ReviewTraceItem = {
  id: string;
  text: string;
};

type BuildReviewFixPrdOptions = {
  [key: string]: unknown;
  round?: number;
  existingTasks?: Array<{ id?: unknown }>;
  now?: string;
  id?: string;
  title?: string;
  project?: unknown;
  projectName?: string;
  language?: string;
  baseCommit?: string;
  base_commit?: string;
};

type ReviewFixPrd = {
  version: "2.0";
  id: string;
  title: string;
  project: unknown;
  generated_by: "yolo-review-fix-loop";
  generated_at: string;
  base_commit: string;
  requirements: ReviewTraceItem[];
  designs: ReviewTraceItem[];
  tasks: ReviewPrdTask[];
  source_review: {
    finding_count: number;
    converted_count: number;
  } & Record<string, unknown>;
};

type ReviewFixLoopInput = {
  [key: string]: unknown;
  findings?: ReviewFindingInput[];
  reviewOutput?: { findings?: ReviewFindingInput[] };
  review_output?: { findings?: ReviewFindingInput[] };
  source?: unknown;
  output?: string;
  force?: boolean;
  writeLifecycle?: boolean;
  write_lifecycle?: boolean;
  projectRoot?: string;
  project_root?: string;
  stateRoot?: string;
  state_root?: string;
  learnFailures?: boolean;
};

type ReviewFixLoopOptions = BuildReviewFixPrdOptions & {
  output?: string;
  force?: boolean;
  source?: unknown;
  writeLifecycle?: boolean;
  write_lifecycle?: boolean;
  projectRoot?: string;
  project_root?: string;
  stateRoot?: string;
  state_root?: string;
  learnFailures?: boolean;
};

type GateFailure = {
  [key: string]: unknown;
  code?: string;
  task_id?: string | null;
  detail?: string;
  message?: string;
};

type ContractInspection = {
  [key: string]: unknown;
  blocks_execution?: boolean;
  failures: GateFailure[];
};

type SpecGovernanceInspection = {
  [key: string]: unknown;
  blocks_execution?: boolean;
  blockers: GateFailure[];
};

type ReviewFixLoopBlocker = {
  code: string;
  finding_id?: string;
  severity?: string;
  task_id?: string | null;
  message?: string;
  file?: string | null;
};

type LifecycleWriteResult = {
  [key: string]: unknown;
  artifact_path: string;
};

type ReviewFixLoopReport = {
  [key: string]: unknown;
  schema_version: typeof REVIEW_FIX_LOOP_SCHEMA_VERSION;
  schema: typeof REVIEW_FIX_LOOP_REPORT_SCHEMA;
  status: "blocked" | "pass";
  code: "REVIEW_FIX_REQUIRED" | "REVIEW_FIX_CLEAR";
  summary: string;
  generated_at: string;
  review: ReturnType<typeof buildReviewOutput>;
  fix_prd: ReviewFixPrd;
  contract: ContractInspection;
  spec_governance: SpecGovernanceInspection;
  blockers: ReviewFixLoopBlocker[];
  artifacts: string[];
  next_actions: string[];
  fix_prd_path?: string;
  lifecycle_write?: LifecycleWriteResult;
};

function nowIso() {
  return new Date().toISOString();
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function severityBlocksShip(severity: unknown): boolean {
  return ["CRITICAL", "HIGH"].includes(String(severity || "").toUpperCase());
}

function requirementForTask(task: ReviewPrdTask, index: number): ReviewTraceItem {
  const source = task.source_findings?.[0];
  return {
    id: `REQ-${task.id}`,
    text: source?.message || source?.description || task.title || `Fix review finding ${index + 1}`,
  };
}

function designForTask(task: ReviewPrdTask): ReviewTraceItem {
  const files = (task.scope?.targets || []).map((target) => target.file).filter(Boolean);
  return {
    id: `DES-${task.id}`,
    text: `Apply the smallest safe fix for ${task.id}${files.length ? ` in ${files.join(", ")}` : ""}, then rerun related gates.`,
  };
}

export function buildReviewFixPrd(
  findings: ReviewFindingInput[] = [],
  options: BuildReviewFixPrdOptions = Object(),
): ReviewFixPrd {
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

export function inspectReviewFixLoop(
  input: ReviewFixLoopInput = Object(),
  options: ReviewFixLoopOptions = Object(),
): ReviewFixLoopReport {
  const rawFindings = input.findings || input.reviewOutput?.findings || input.review_output?.findings || [];
  const review = buildReviewOutput(rawFindings, { source: input.source || options.source || "review-fix-loop" });
  const fixPrd = buildReviewFixPrd(review.findings, options);
  const contract: ContractInspection = inspectPrdContract(fixPrd);
  const spec: SpecGovernanceInspection = inspectSpecGovernanceGate({ prd: fixPrd }).result;
  const blockingFindings = review.findings.filter((finding) => severityBlocksShip(finding.severity) || finding.must_fix_before_ship === true);
  const blockers: ReviewFixLoopBlocker[] = [
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
  const report: ReviewFixLoopReport = Object.assign(Object(), {
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
  const outputTarget = input.output || options.output;
  if (outputTarget) {
    const output = resolve(outputTarget);
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
