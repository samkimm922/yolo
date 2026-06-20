#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeLifecycleStageReport } from "../../lifecycle/progress.js";
import { formatLifecycleGuardText, inspectLifecycleGuard } from "../../lifecycle/guard.js";
import { resolveProjectContext } from "../../packs/resolver.js";
import {
  asArray,
  clean,
  uiTasks,
} from "../gates/readiness-policy.js";
import { runAdapterEvidenceCollector } from "../adapters/evidence-collector.js";
import { verifyArtifactIntegrity } from "../evidence/artifact-integrity.js";
import { isWithin } from "../../lib/security/path-guard.js";
import { verifyApprovalSignature, approvalSignablePayload } from "../../lib/security/approval-signing.js";

export const ACCEPTANCE_REPORT_SCHEMA_VERSION = "1.0";
export const ACCEPTANCE_REPORT_SCHEMA = "yolo.acceptance.report.v1";

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
const RELEASE_ACCEPTANCE_MODES = new Set(["ship", "release"]);

function nowIso() {
  return new Date().toISOString();
}

function readJsonMaybe(path) {
  if (!path) return null;
  const resolved = resolve(path);
  if (!existsSync(resolved)) return null;
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function isLifecycleStageReport(report) {
  return Boolean(report && typeof report === "object" &&
    (report.schema === "yolo.lifecycle.stage_report.v1" || (report.lifecycle_schema && report.report)));
}

function latestStateRunReportPath(stateRoot) {
  const reportsRoot = join(stateRoot, "state", "reports");
  if (!existsSync(reportsRoot)) return "";
  try {
    const candidates = readdirSync(reportsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
      .map((entry) => {
        const reportPath = join(reportsRoot, entry.name, "run-report.json");
        if (!existsSync(reportPath)) return null;
        const stat = statSync(reportPath);
        return { path: reportPath, mtime: stat.mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => (b.mtime - a.mtime) || b.path.localeCompare(a.path));
    return candidates[0]?.path || "";
  } catch {
    return "";
  }
}

function defaultRunReportPath(stateRoot) {
  const lifecyclePath = join(stateRoot, "lifecycle", "run-report.json");
  let lifecycleReport = null;
  try {
    lifecycleReport = readJsonMaybe(lifecyclePath);
  } catch {
    return lifecyclePath;
  }
  if (lifecycleReport && !isLifecycleStageReport(lifecycleReport)) return lifecyclePath;
  return latestStateRunReportPath(stateRoot) || lifecyclePath;
}

function defaultAdapterEvidencePath({ stateRoot, resolver }) {
  const adapterId = resolver?.selected?.acceptance_adapter?.id;
  if (!adapterId || adapterId === "unknown/custom") return "";
  return join(stateRoot, "state", "evidence", "adapters", `${adapterId}-latest.json`);
}

function loadPrd(input = Object()) {
  if (input.prd) return input.prd;
  return readJsonMaybe(input.prdPath || input.prd_path);
}

function acceptanceMode(input = Object(), options = Object()) {
  return clean(input.mode || input.acceptanceMode || input.acceptance_mode || options.mode || options.acceptanceMode || options.acceptance_mode || "accept").toLowerCase();
}

function approvalArtifactPath({ input = Object(), options = Object(), stateRoot }) {
  return input.approvalArtifact ||
    input.approval_artifact ||
    input.acceptanceApprovalArtifact ||
    input.acceptance_approval_artifact ||
    options.approvalArtifact ||
    options.approval_artifact ||
    options.acceptanceApprovalArtifact ||
    options.acceptance_approval_artifact ||
    join(stateRoot, "lifecycle", "acceptance-approval.json");
}

function readApprovalArtifact(path, boundaryRoot) {
  if (!path) {
    return { artifact_path: "", artifact: null, error: null };
  }
  const resolved = resolve(path);
  if (boundaryRoot && !isWithin(resolved, boundaryRoot)) {
    return {
      artifact_path: "",
      artifact: null,
      error: {
        code: "ACCEPTANCE_WARNING_APPROVAL_PATH_OUTSIDE_ROOT",
        message: `Approval artifact path escapes project/state root: ${path}`,
      },
    };
  }
  if (!existsSync(resolved)) {
    return { artifact_path: "", artifact: null, error: null };
  }
  try {
    return { artifact_path: resolved, artifact: JSON.parse(readFileSync(resolved, "utf8")), error: null };
  } catch (error) {
    return {
      artifact_path: resolved,
      artifact: null,
      error: {
        code: "ACCEPTANCE_WARNING_APPROVAL_MALFORMED",
        message: error?.message || "Approval artifact is not valid JSON.",
      },
    };
  }
}

function warningApprovalDigest({ prdPath, mode, warnings = [] } = Object()) {
  const normalized = {
    prd_path: prdPath ? resolve(prdPath) : "",
    mode,
    warnings: warnings.map((issue) => ({
      level: issue.level,
      code: issue.code,
      task_id: issue.task_id || null,
      finding_id: issue.finding_id || issue.id || null,
      message: issue.message || "",
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function approvalValueMatches(value, expected) {
  if (!expected) return true;
  return clean(value) === clean(expected);
}

function hasApprovalAuditFields(approval = Object()) {
  return Boolean(clean(approval.approved_at || approval.approvedAt || approval.executed_at || approval.executedAt)) &&
    Boolean(clean(approval.approver || approval.approved_by || approval.approvedBy || approval.reviewer));
}

function approvalWarningsMatch(approval = Object(), expected = Object()) {
  const expectedCount = expected.warning_count || 0;
  const digest = approval.warning_digest || approval.warnings_digest || approval.issue_digest || approval.issues_digest;
  if (digest) return clean(digest) === clean(expected.warning_digest);
  const count = approval.warning_count ?? approval.warnings_count ?? approval.issue_count ?? approval.issues_count;
  if (count != null) return Number(count) === expectedCount;
  return expectedCount === 0;
}

function approvalFromArtifact(path, expected = Object(), boundaryRoot) {
  const read = readApprovalArtifact(path, boundaryRoot);
  const artifact = read.artifact;
  const payload = artifact?.report || artifact;
  const approval = payload?.approval || payload?.acceptance_approval || payload;
  const approved = approval?.approved === true || clean(approval?.status).toLowerCase() === "approved";
  const reasons = [];
  if (read.error) reasons.push(read.error);
  if (artifact && !approved) {
    reasons.push({ code: "ACCEPTANCE_WARNING_APPROVAL_NOT_APPROVED", message: "Approval artifact is present but not approved." });
  }
  if (artifact && approved) {
    if (!hasApprovalAuditFields(approval)) {
      reasons.push({ code: "ACCEPTANCE_WARNING_APPROVAL_AUDIT_FIELDS_MISSING", message: "Approval artifact must include approver and approved_at fields." });
    }
    if (!approvalValueMatches(approval?.prd_path || approval?.prdPath, expected.prd_path)) {
      reasons.push({ code: "ACCEPTANCE_WARNING_APPROVAL_PRD_MISMATCH", message: "Approval artifact does not match the current PRD." });
    }
    if (!approvalValueMatches(approval?.mode || approval?.acceptance_mode || approval?.acceptanceMode, expected.mode)) {
      reasons.push({ code: "ACCEPTANCE_WARNING_APPROVAL_MODE_MISMATCH", message: "Approval artifact does not match the current acceptance mode." });
    }
    if (!approvalWarningsMatch(approval, expected)) {
      reasons.push({ code: "ACCEPTANCE_WARNING_APPROVAL_WARNING_MISMATCH", message: "Approval artifact does not match the current warning set." });
    }
    // P12.I4: ed25519 signature verification for release approvals.
    // Enforcement model: fail-closed ONLY when YOLO_APPROVAL_PUBLIC_KEY is configured
    // (i.e., the CI/release pipeline has committed to signed approvals). Without the
    // env var, signature verification is advisory — existing dev/test flows that don't
    // sign are not blocked. When a signature IS present, it must always verify.
    const publicKey = clean(process.env.YOLO_APPROVAL_PUBLIC_KEY);
    const signature = clean(approval?.signature);
    if (signature) {
      if (!publicKey) {
        // Signature present but no public key configured — advisory, don't block.
      } else {
        const signablePayload = approvalSignablePayload(approval);
        const sigResult = verifyApprovalSignature(signablePayload, signature, publicKey);
        if (!sigResult.verified) {
          reasons.push({ code: "ACCEPTANCE_WARNING_APPROVAL_SIGNATURE_INVALID", message: `Approval signature verification failed: ${sigResult.detail}` });
        }
      }
    } else if (publicKey) {
      // Public key configured but no signature on the approval — fail-closed.
      // The pipeline has committed to signed approvals; unsigned is rejected.
      reasons.push({ code: "ACCEPTANCE_WARNING_APPROVAL_SIGNATURE_MISSING", message: "YOLO_APPROVAL_PUBLIC_KEY is set but approval artifact has no signature. Sign the approval with the CI private key." });
    }
  }
  return {
    artifact_path: read.artifact_path,
    artifact: artifact || null,
    approved: approved && reasons.length === 0,
    invalid_reasons: reasons,
    expected,
  };
}

function readArgValue(argv, index) {
  const arg = argv[index];
  if (arg.includes("=")) return { value: arg.split("=").slice(1).join("="), consumed: 0 };
  return { value: argv[index + 1], consumed: 1 };
}

function pushIssue(issues, level, code, message, extra = Object()) {
  issues.push({
    level,
    code,
    message,
    ...extra,
  });
}

function summarizeIssues(issues = []) {
  return {
    p0: issues.filter((issue) => issue.level === "P0").length,
    p1: issues.filter((issue) => issue.level === "P1").length,
    p2: issues.filter((issue) => issue.level === "P2").length,
    human_review: issues.filter((issue) => issue.level === "human_review").length,
    total: issues.length,
  };
}

const RUN_REPORT_PASS_STATUSES = new Set(["pass", "success"]);
const STATUS_FIELDS = new Set(["status", "verdict", "outcome"]);

function collectReportStatuses(report, depth = 0, field = "", seen = new Set()) {
  if (Array.isArray(report)) {
    return report.flatMap((item, index) =>
      collectReportStatuses(item, depth + 1, field ? `${field}.${index}` : String(index), seen),
    );
  }
  if (!report || typeof report !== "object" || depth > 20 || seen.has(report)) return [];
  seen.add(report);
  const statuses = [];
  for (const [key, value] of Object.entries(report)) {
    const nextField = field ? `${field}.${key}` : key;
    if (STATUS_FIELDS.has(key)) {
      const status = clean(value).toLowerCase();
      const wrapperStatus = key === "status" &&
        ["completed", "done"].includes(status) &&
        Boolean(report.report || report.result || report.run_report || report.runReport);
      if (status && !wrapperStatus) statuses.push({ field: nextField, status });
    }
    if (value && typeof value === "object") {
      statuses.push(...collectReportStatuses(value, depth + 1, nextField, seen));
    }
  }
  return statuses;
}

function collectReportFlags(report, flagNames = [], depth = 0, field = "", seen = new Set()) {
  if (Array.isArray(report)) {
    return report.flatMap((item, index) =>
      collectReportFlags(item, flagNames, depth + 1, field ? `${field}.${index}` : String(index), seen),
    );
  }
  if (!report || typeof report !== "object" || depth > 20 || seen.has(report)) return [];
  seen.add(report);
  const flags = [];
  for (const [key, value] of Object.entries(report)) {
    const nextField = field ? `${field}.${key}` : key;
    if (flagNames.includes(key) && value === true) flags.push({ field: nextField, value: true });
    if (value && typeof value === "object") {
      flags.push(...collectReportFlags(value, flagNames, depth + 1, nextField, seen));
    }
  }
  return flags;
}

function acceptanceCriteriaIssues(prd, issues) {
  const tasks = asArray(prd?.tasks);
  if (tasks.length === 0) {
    pushIssue(issues, "P1", "ACCEPTANCE_TASKS_MISSING", "Acceptance requires PRD tasks.");
  }
  for (const task of tasks) {
    const criteria = asArray(task.acceptance_criteria);
    const post = asArray(task.post_conditions);
    if (criteria.length === 0 && post.length === 0) {
      pushIssue(issues, "P1", "ACCEPTANCE_CRITERIA_MISSING", "Task is missing acceptance criteria and post conditions.", { task_id: task.id || null });
    }
  }
}

function hasVerifyCommand(condition) {
  return Boolean(clean(condition.verify_command) || clean(condition.params?.verify_command));
}

function collectManualCriteria(prd) {
  const manualCriteria = [];
  const tasks = asArray(prd?.tasks);
  for (const task of tasks) {
    const conditions = asArray(task.post_conditions);
    for (const condition of conditions) {
      if (condition.type === "acceptance_criteria" && !hasVerifyCommand(condition)) {
        manualCriteria.push({
          task_id: task.id || null,
          condition_id: condition.id || null,
          text: clean(condition.text || condition.params?.text || condition.detail || "验收标准（需人工复核）"),
        });
      }
    }
  }
  return manualCriteria;
}

// Extract verifiable run evidence from a real run report or from the inner
// `report` payload of a lifecycle stage wrapper. A stage wrapper that wraps a
// real run report is valid evidence; a minimal wrapper with no run_id/summary
// is not.
const RUN_SUMMARY_FIELDS = ["planned", "completed", "failed", "blocked", "skipped"];

function isStructuredSummary(summary) {
  return Boolean(summary) && typeof summary === "object" && !Array.isArray(summary)
    && RUN_SUMMARY_FIELDS.some((field) => Number.isFinite(Number(summary[field])));
}

function runEvidencePayload(runReport) {
  const empty = { run_id: "", summary: null, prd: "" };
  if (!runReport || typeof runReport !== "object") return empty;
  const nested = runReport.report && typeof runReport.report === "object" ? runReport.report : null;
  const topLevelSummary = (runReport.summary && typeof runReport.summary === "object" && !Array.isArray(runReport.summary))
    ? runReport.summary
    : null;
  const nestedSummary = (nested && nested.summary && typeof nested.summary === "object" && !Array.isArray(nested.summary))
    ? nested.summary
    : null;
  // A stage wrapper may carry a stage-level summary ({failed, blocked}) at the top
  // level; the verifiable structured run summary lives inside the nested .report.
  // Prefer the summary that actually carries structured run-report fields.
  const summarySource = (topLevelSummary && isStructuredSummary(topLevelSummary))
    ? topLevelSummary
    : (nestedSummary && isStructuredSummary(nestedSummary)
      ? nestedSummary
      : (topLevelSummary || nestedSummary));
  return {
    run_id: clean(runReport.run_id || runReport.runId || (nested && (nested.run_id || nested.runId)) || ""),
    summary: summarySource,
    prd: clean(runReport.prd || runReport.prd_path || (nested && (nested.prd || nested.prd_path)) || ""),
  };
}

function runReportSufficiencyIssues(runReport, issues, { prdPath = "" } = Object()) {
  if (!runReport) return;
  const payload = runEvidencePayload(runReport);
  const reasons = [];
  if (!payload.run_id) reasons.push("missing run_id");
  const hasStructuredSummary = isStructuredSummary(payload.summary);
  if (!hasStructuredSummary) reasons.push("missing structured summary (planned/completed/failed/blocked)");
  if (prdPath && !payload.prd) reasons.push("missing PRD lineage binding");
  if (reasons.length > 0) {
    pushIssue(issues, "P1", "RUN_REPORT_INSUFFICIENT",
      "Run report must carry a verifiable run_id, a structured task summary, and PRD lineage — a minimal lifecycle stage wrapper is not valid run evidence.",
      {
        run_id: payload.run_id || null,
        reasons,
        schema: clean(runReport.schema) || null,
        stage: clean(runReport.stage) || null,
      });
  }
}

function runtimeEvidenceIssues(runReport, issues, { releaseMode = false, prdPath = "" } = Object()) {
  if (!runReport) {
    pushIssue(issues, "P1", "RUN_REPORT_MISSING", "Acceptance requires run evidence or an explicit degraded/manual record.");
    return;
  }
  runReportSufficiencyIssues(runReport, issues, { prdPath });
  const status = clean(runReport.status).toLowerCase();
  const statusEntries = collectReportStatuses(runReport);
  const nonPassStatuses = statusEntries.filter((entry) => !RUN_REPORT_PASS_STATUSES.has(entry.status));
  const dryRunFlags = collectReportFlags(runReport, ["dry_run", "dryRun"]);
  const failed = Number(runReport.summary?.failed || asArray(runReport.failed).length || 0);
  const blocked = Number(runReport.summary?.blocked || asArray(runReport.blocked).length || 0);
  const evidenceFailures = Number(runReport.summary?.evidence_failures || 0);
  const gateFailures = Number(runReport.gates?.failed_count || 0);
  const reviewIssues = Number(runReport.review?.issue_count || 0);
  const reviewErrors = Number(runReport.review?.error_count || 0);
  const fixtureFailures = Number(runReport.fixtures?.fail_count || 0);
  const fixtureBlocked = Number(runReport.fixtures?.blocked_count || 0);
  const fixtureDegraded = Number(runReport.fixtures?.degraded_count || 0);
  const fixtureStatus = clean(runReport.fixtures?.status).toLowerCase();
  const specBlocked = Number(runReport.spec_governance?.blocked_count || 0);
  const ledgerIntegrityErrors = Number(runReport.ledger?.integrity?.error_count || runReport.evidence_integrity?.error_count || 0);
  if (
    statusEntries.length === 0 ||
    nonPassStatuses.length > 0 ||
    dryRunFlags.length > 0 ||
    failed > 0 ||
    blocked > 0 ||
    evidenceFailures > 0 ||
    gateFailures > 0 ||
    reviewIssues > 0 ||
    reviewErrors > 0 ||
    fixtureFailures > 0 ||
    fixtureBlocked > 0 ||
    (fixtureStatus && !RUN_REPORT_PASS_STATUSES.has(fixtureStatus)) ||
    specBlocked > 0 ||
    ledgerIntegrityErrors > 0
  ) {
    pushIssue(issues, "P1", "RUN_REPORT_NOT_CLEAN", "Run report must be pass/success and contain no failed, blocked, or failing evidence.", {
      status,
      status_entries: statusEntries,
      non_pass_statuses: nonPassStatuses,
      dry_run_flags: dryRunFlags,
      failed,
      blocked,
      evidence_failures: evidenceFailures,
      gate_failures: gateFailures,
      review_issues: reviewIssues,
      review_errors: reviewErrors,
      fixture_failures: fixtureFailures,
      fixture_blocked: fixtureBlocked,
      fixture_status: fixtureStatus || null,
      spec_blocked: specBlocked,
      ledger_integrity_errors: ledgerIntegrityErrors,
    });
  }
  if (releaseMode && fixtureDegraded > 0) {
    pushIssue(issues, "P1", "DEGRADED_FIXTURE_RELEASE_BLOCKED", "Release acceptance cannot use degraded fixture evidence as a pass.", {
      fixture_degraded: fixtureDegraded,
    });
  }
}

function adapterEvidenceIssues(adapterEvidence, issues) {
  if (!adapterEvidence) return;
  const status = clean(adapterEvidence.status).toLowerCase();
  if (!RUN_REPORT_PASS_STATUSES.has(status)) {
    const issueCode = ["blocked", "failed", "fail", "error"].includes(status) ? "ADAPTER_EVIDENCE_BLOCKED" : "ADAPTER_EVIDENCE_NOT_CLEAN";
    pushIssue(issues, "P1", issueCode, "Adapter evidence must be pass/success before acceptance can pass.", {
      adapter_status: status || null,
      adapter_code: adapterEvidence.code || null,
      adapter_id: adapterEvidence.adapter?.id || null,
      required_platform: adapterEvidence.required_platform || null,
      missing_adapter_platforms: asArray(adapterEvidence.platform_coverage?.missing_adapter_platforms),
      missing_evidence_platforms: asArray(adapterEvidence.platform_coverage?.missing_evidence_platforms),
    });
  }
}

function reviewFindingsFromReports(...reports) {
  return reports.flatMap((report) => [
    ...asArray(report?.findings),
    ...asArray(report?.review?.findings),
    ...asArray(report?.review?.issues),
    ...asArray(report?.review_output?.findings),
    ...asArray(report?.reviewOutput?.findings),
    ...asArray(report?.report?.findings),
    ...asArray(report?.report?.review?.findings),
    ...asArray(report?.report?.review?.issues),
    ...asArray(report?.report?.review_output?.findings),
    ...asArray(report?.report?.reviewOutput?.findings),
  ]);
}

function reviewIssues(reviewReport, runReport, issues) {
  const findings = reviewFindingsFromReports(reviewReport, runReport);
  for (const finding of findings) {
    if (["CRITICAL", "HIGH"].includes(clean(finding.severity).toUpperCase()) || finding.must_fix_before_ship === true) {
      pushIssue(issues, "P1", "REVIEW_BLOCKER_OPEN", "Blocking review finding remains open.", {
        finding_id: finding.finding_id || finding.id || null,
        severity: finding.severity || null,
      });
    }
  }
}

function reviewFixTasks(prd) {
  return asArray(prd?.tasks).filter((task) => task?.task_kind === "review_fix");
}

function taskSourceFindingIds(task = Object()) {
  return [
    ...asArray(task.source_finding_ids),
    ...asArray(task.source_findings).map((finding) => finding?.finding_id || finding?.id),
    ...asArray(task.fix_findings).map((finding) => finding?.finding_id || finding?.id),
  ].map((value) => clean(value)).filter(Boolean);
}

function findingIdCandidates(finding = Object()) {
  return [
    finding.finding_id,
    finding.id,
    finding.source_finding_id,
  ].map((value) => clean(value)).filter(Boolean);
}

function findingIsClosed(finding = Object()) {
  const status = clean(finding.status || finding.state || finding.resolution).toLowerCase();
  return ["closed", "resolved", "fixed", "pass", "passed"].includes(status);
}

function reviewFixClosureIssues(prd, reviewReport, runReport, issues) {
  const tasks = reviewFixTasks(prd);
  if (tasks.length === 0) return;
  if (!reviewReport) {
    pushIssue(issues, "P1", "REVIEW_FIX_REPORT_MISSING", "Review fix tasks require a review report that proves source findings are closed.", {
      review_fix_task_count: tasks.length,
    });
    return;
  }

  const openFindings = reviewFindingsFromReports(reviewReport, runReport)
    .filter((finding) => !findingIsClosed(finding));
  const openFindingIds = new Set(openFindings.flatMap(findingIdCandidates));

  for (const task of tasks) {
    const sourceFindingIds = taskSourceFindingIds(task);
    if (sourceFindingIds.length === 0) {
      pushIssue(issues, "P1", "REVIEW_FIX_SOURCE_FINDINGS_MISSING", "Review fix task must bind to source_finding_ids for machine acceptance.", {
        task_id: task.id || null,
      });
      continue;
    }
    for (const findingId of sourceFindingIds) {
      if (openFindingIds.has(findingId)) {
        pushIssue(issues, "P1", "REVIEW_FIX_FINDING_STILL_OPEN", "Review fix task source finding is still present in the latest review report.", {
          task_id: task.id || null,
          finding_id: findingId,
        });
      }
    }
  }
}

function normalizePathForCompare(value) {
  return value ? resolve(String(value)) : "";
}

function explicitOption(input = Object(), options = Object(), ...keys) {
  return keys.some((key) => input[key] !== undefined || options[key] !== undefined);
}

function expectedArtifactDigests(input = Object(), options = Object()) {
  return input.artifactDigests ||
    input.artifact_digests ||
    input.expectedArtifactDigests ||
    input.expected_artifact_digests ||
    options.artifactDigests ||
    options.artifact_digests ||
    options.expectedArtifactDigests ||
    options.expected_artifact_digests ||
    {};
}

function pushArtifactIntegrityIssues(issues, integrity) {
  for (const artifact of integrity.missing || []) {
    pushIssue(issues, "P1", "ACCEPTANCE_ARTIFACT_MISSING", "Acceptance evidence artifact path does not exist on disk.", {
      artifact_path: artifact.absolute_path,
    });
  }
  for (const artifact of integrity.digest_mismatches || []) {
    pushIssue(issues, "P1", "ACCEPTANCE_ARTIFACT_DIGEST_MISMATCH", "Acceptance evidence artifact digest does not match the expected sha256.", {
      artifact_path: artifact.absolute_path,
      expected_sha256: artifact.expected_sha256,
      actual_sha256: artifact.sha256,
    });
  }
}

function evidenceLineageIssues({ prdPath, runReport, reviewReport }, issues) {
  const expectedPrd = normalizePathForCompare(prdPath);
  if (!expectedPrd) return;
  const runPrd = normalizePathForCompare(runReport?.report?.prd || runReport?.prd || runReport?.prd_path);
  const reviewPrd = normalizePathForCompare(reviewReport?.report?.prd_path || reviewReport?.prd_path || reviewReport?.prd);
  if (runReport && runPrd && runPrd !== expectedPrd) {
    pushIssue(issues, "P1", "RUN_REPORT_PRD_MISMATCH", "Run evidence belongs to a different PRD.", {
      expected_prd: expectedPrd,
      actual_prd: runPrd,
    });
  }
  if (reviewReport && reviewPrd && reviewPrd !== expectedPrd) {
    pushIssue(issues, "P1", "REVIEW_REPORT_PRD_MISMATCH", "Review evidence belongs to a different PRD.", {
      expected_prd: expectedPrd,
      actual_prd: reviewPrd,
    });
  }
}

function uiEvidenceIssues({ prd, uiEvidence, resolver }, issues) {
  const tasks = uiTasks(prd, { resolver });
  if (tasks.length === 0) return { ui_task_count: 0 };
  if (!uiEvidence) {
    pushIssue(issues, "P1", "UI_EVIDENCE_MISSING", "UI tasks require screenshot/log/runtime evidence.");
    return { ui_task_count: tasks.length };
  }
  if (resolver?.selected?.acceptance_adapter?.id === "unknown/custom") {
    pushIssue(issues, "P1", "UI_ACCEPTANCE_ADAPTER_MISSING", "UI acceptance requires an acceptance adapter manifest.");
  }
  if (uiEvidence.page_reachable === false) pushIssue(issues, "P0", "UI_PAGE_UNREACHABLE", "Target page or surface is unreachable.");
  if (uiEvidence.critical_path_passed === false) pushIssue(issues, "P0", "UI_CRITICAL_PATH_FAILED", "Critical UI path failed.");
  if (uiEvidence.required_state_present === false) pushIssue(issues, "P0", "UI_REQUIRED_STATE_MISSING", "Required UI state is missing.");
  if (uiEvidence.content_overlap === true || uiEvidence.text_overflow === true) pushIssue(issues, "P0", "UI_LAYOUT_BLOCKER", "Main content overlaps or overflows.");
  if (asArray(uiEvidence.runtime_errors).length > 0) {
    pushIssue(issues, "P0", "UI_RUNTIME_ERRORS", "Runtime errors were reported by UI evidence.", { count: uiEvidence.runtime_errors.length });
  }
  if (asArray(uiEvidence.screenshots).length === 0) pushIssue(issues, "P1", "UI_SCREENSHOT_MISSING", "UI acceptance requires at least one screenshot or equivalent visual artifact.");
  for (const note of asArray(uiEvidence.polish_notes)) {
    pushIssue(issues, "P2", "UI_POLISH_NOTE", clean(note) || "Visual polish note requires human judgment.");
  }
  for (const note of asArray(uiEvidence.human_review_notes)) {
    pushIssue(issues, "human_review", "UI_HUMAN_REVIEW_NOTE", clean(note) || "Human review note.");
  }
  return { ui_task_count: tasks.length };
}

export function buildAcceptanceReport(input = Object(), options = Object()) {
  const prdPath = input.prdPath || input.prd_path || options.prdPath || options.prd_path || "";
  const prd = loadPrd({ ...options, ...input });
  const projectRoot = resolve(input.projectRoot || input.project_root || options.projectRoot || options.project_root || (prdPath ? dirname(resolve(prdPath)) : process.cwd()));
  const stateRoot = resolve(input.stateRoot || input.state_root || options.stateRoot || options.state_root || `${projectRoot}/.yolo`);
  const mode = acceptanceMode(input, options);
  const resolver = input.resolver || resolveProjectContext({
    projectRoot,
    stateRoot,
    requiresAcceptanceAdapter: uiTasks(prd).length > 0,
  });
  const runReportPath = input.runReportPath || input.run_report_path || options.runReportPath || options.run_report_path || defaultRunReportPath(stateRoot);
  const reviewReportPath = input.reviewReportPath || input.review_report_path || options.reviewReportPath || options.review_report_path || join(stateRoot, "lifecycle", "review-report.json");
  const uiEvidencePath = input.uiEvidencePath || input.ui_evidence_path || options.uiEvidencePath || options.ui_evidence_path || "";
  const adapterEvidencePath = input.adapterEvidencePath || input.adapter_evidence_path || options.adapterEvidencePath || options.adapter_evidence_path || defaultAdapterEvidencePath({ stateRoot, resolver });
  const runReportFromInput = Boolean(input.runReport || input.run_report);
  const reviewReportFromInput = Boolean(input.reviewReport || input.review_report);
  const uiEvidenceFromInput = Boolean(input.uiEvidence || input.ui_evidence);
  const adapterEvidenceFromInput = Boolean(input.adapterEvidence || input.adapter_evidence);
  const runReportPathExplicit = explicitOption(input, options, "runReportPath", "run_report_path");
  const reviewReportPathExplicit = explicitOption(input, options, "reviewReportPath", "review_report_path");
  const uiEvidencePathExplicit = explicitOption(input, options, "uiEvidencePath", "ui_evidence_path");
  const adapterEvidencePathExplicit = explicitOption(input, options, "adapterEvidencePath", "adapter_evidence_path");
  const runReport = input.runReport || input.run_report || readJsonMaybe(runReportPath);
  const reviewReport = input.reviewReport || input.review_report || readJsonMaybe(reviewReportPath);
  const releaseMode = RELEASE_ACCEPTANCE_MODES.has(mode);
  let uiEvidence = input.uiEvidence || input.ui_evidence || readJsonMaybe(uiEvidencePath);
  const adapterEvidence = input.adapterEvidence || input.adapter_evidence || (
    (input.collectEvidence || input.collect_evidence || options.collectEvidence || options.collect_evidence)
      ? runAdapterEvidenceCollector({
        projectRoot,
        stateRoot,
        resolver,
        prd,
        requiredPlatform: input.requiredPlatform || input.required_platform || options.requiredPlatform || options.required_platform,
        platform: input.platform || options.platform,
        execute: input.executeAdapter === true || input.execute_adapter === true || options.executeAdapter === true || options.execute_adapter === true,
        allowAdapterCommands: input.allowAdapterCommands === true || input.allow_adapter_commands === true || options.allowAdapterCommands === true || options.allow_adapter_commands === true,
      })
      : readJsonMaybe(adapterEvidencePath)
  );
  if (!uiEvidence && adapterEvidence?.ui_evidence) {
    uiEvidence = adapterEvidence.ui_evidence;
  }
  if (!uiEvidence && Array.isArray(adapterEvidence?.collected_evidence)) {
    uiEvidence = adapterEvidence.collected_evidence.find((record) => record?.ui_evidence)?.ui_evidence || null;
  }
  const issues = [];
  const artifactPaths = [
    prdPath ? resolve(prdPath) : "",
    runReport && (!runReportFromInput || runReportPathExplicit) ? resolve(runReportPath) : "",
    reviewReport && (!reviewReportFromInput || reviewReportPathExplicit) ? resolve(reviewReportPath) : "",
    uiEvidence && uiEvidencePath && (!uiEvidenceFromInput || uiEvidencePathExplicit) ? resolve(uiEvidencePath) : "",
    adapterEvidence?.artifact_path || (adapterEvidence && adapterEvidencePath && (!adapterEvidenceFromInput || adapterEvidencePathExplicit) ? resolve(adapterEvidencePath) : ""),
  ].filter(Boolean);
  const artifactIntegrity = verifyArtifactIntegrity(artifactPaths, {
    rootDir: projectRoot,
    expectedSha256ByPath: expectedArtifactDigests(input, options),
  });
  pushArtifactIntegrityIssues(issues, artifactIntegrity);
  if (!prd) {
    pushIssue(issues, "P1", "PRD_MISSING", "Acceptance requires a PRD.");
  } else {
    acceptanceCriteriaIssues(prd, issues);
  }
  runtimeEvidenceIssues(runReport, issues, { releaseMode, prdPath });
  adapterEvidenceIssues(adapterEvidence, issues);
  evidenceLineageIssues({ prdPath, runReport, reviewReport }, issues);
  reviewIssues(reviewReport, runReport, issues);
  if (prd) reviewFixClosureIssues(prd, reviewReport, runReport, issues);
  const ui = prd ? uiEvidenceIssues({ prd, uiEvidence, resolver }, issues) : { ui_task_count: 0 };
  for (const blocker of asArray(resolver.blockers)) {
    pushIssue(issues, "P1", blocker.code || "RESOLVER_BLOCKED", blocker.message || "Resolver blocked acceptance.");
  }

  let summary = summarizeIssues(issues);
  const approvalPath = approvalArtifactPath({ input, options, stateRoot });
  const releaseWarnings = issues.filter((issue) => issue.level === "P2" || issue.level === "human_review");
  const warningApproval = approvalFromArtifact(approvalPath, {
    prd_path: prdPath ? resolve(prdPath) : "",
    mode,
    warning_count: releaseWarnings.length,
    warning_digest: warningApprovalDigest({ prdPath, mode, warnings: releaseWarnings }),
  }, stateRoot);
  // P10.S4: unconditionally flag path-escape attempts regardless of release mode
  const pathEscapeError = (warningApproval.invalid_reasons || []).find(
    (r) => r.code === "ACCEPTANCE_WARNING_APPROVAL_PATH_OUTSIDE_ROOT",
  );
  if (pathEscapeError) {
    pushIssue(issues, "P1", "ACCEPTANCE_WARNING_APPROVAL_PATH_OUTSIDE_ROOT", pathEscapeError.message, {
      approval_artifact: approvalPath,
    });
    summary = summarizeIssues(issues);
  }
  if (releaseMode && summary.p1 === 0 && summary.p0 === 0 && releaseWarnings.length > 0 && !warningApproval.approved) {
    const invalidReasons = warningApproval.invalid_reasons || [];
    for (const reason of invalidReasons) {
      pushIssue(issues, "P1", reason.code || "ACCEPTANCE_WARNING_APPROVAL_INVALID", reason.message || "Ship/release approval artifact is invalid.", {
        approval_artifact: warningApproval.artifact_path || resolve(approvalPath),
        mode,
        human_needed: true,
      });
    }
    pushIssue(issues, "P1", "ACCEPTANCE_WARNING_APPROVAL_MISSING", "Ship/release acceptance warnings require an approved human-review artifact.", {
      approval_artifact: warningApproval.artifact_path || resolve(approvalPath),
      warning_count: releaseWarnings.length,
      warning_digest: warningApproval.expected.warning_digest,
      mode,
      human_needed: true,
    });
    summary = summarizeIssues(issues);
  }
  const status = summary.p0 > 0 || summary.p1 > 0 ? "blocked" : summary.p2 > 0 || summary.human_review > 0 ? "warning" : "pass";
  const report = Object.assign(Object(), {
    schema_version: ACCEPTANCE_REPORT_SCHEMA_VERSION,
    schema: ACCEPTANCE_REPORT_SCHEMA,
    status,
    code: status === "blocked" ? "ACCEPTANCE_BLOCKED" : status === "warning" ? "ACCEPTANCE_WARNING" : "ACCEPTANCE_PASS",
    summary: status === "pass" ? "Acceptance passed." : status === "warning" ? "Acceptance has warnings or human review notes." : "Acceptance blocked by missing or failing evidence.",
    generated_at: nowIso(),
    project_root: projectRoot,
    state_root: stateRoot,
    prd_path: prdPath ? resolve(prdPath) : "",
    mode,
    manual_criteria: prd ? collectManualCriteria(prd) : [],
    issue_summary: summary,
    issues,
    warning_approval: {
      required: releaseMode && releaseWarnings.length > 0,
      approved: warningApproval.approved,
      artifact_path: warningApproval.artifact_path || (releaseMode ? resolve(approvalPath) : ""),
      expected: warningApproval.expected,
      invalid_reasons: warningApproval.invalid_reasons || [],
    },
    resolver,
    adapter_evidence: adapterEvidence,
    ui,
    artifact_integrity: artifactIntegrity,
    artifacts: artifactIntegrity.artifacts.filter((artifact) => artifact.exists).map((artifact) => artifact.absolute_path),
    next_actions: status === "blocked"
      ? ["Fix P0/P1 acceptance blockers, then rerun /yolo-accept.", "Do not ship until acceptance report is pass or approved with documented human review."]
      : status === "warning"
        ? ["Review P2/human review notes before delivery."]
        : ["Continue to /yolo-ship."],
  });
  if (input.writeLifecycle || input.write_lifecycle || options.writeLifecycle || options.write_lifecycle) {
    report.lifecycle_write = writeLifecycleStageReport("acceptance", report, {
      projectRoot,
      stateRoot,
      source: "acceptance-report",
      learnFailures: options.learnFailures === true || input.learnFailures === true,
      skipSequenceCheck: true,
    });
    report.artifacts.push(report.lifecycle_write.artifact_path);
  }
  return report;
}

export const inspectAcceptanceReport = buildAcceptanceReport;

export function formatAcceptanceReportText(report = Object()) {
  const lines = [`[yolo accept] ${report.status}: ${report.summary}`];
  if (report.issue_summary) {
    lines.push(`issues: P0=${report.issue_summary.p0} P1=${report.issue_summary.p1} P2=${report.issue_summary.p2} human=${report.issue_summary.human_review}`);
  }
  for (const issue of asArray(report.issues).slice(0, 12)) {
    lines.push(`- ${issue.level}:${issue.code}${issue.task_id ? ` task=${issue.task_id}` : ""} ${issue.message}`.trim());
  }
  if (report.next_actions?.length) {
    lines.push("next:");
    for (const action of report.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function runYoloAcceptCli(argv = process.argv.slice(2), io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const json = argv.includes("--json");
  const noWrite = argv.includes("--no-write");
  const mode = argv.includes("--ship") ? "ship" : argv.includes("--release") ? "release" : "accept";
  const approvalIndex = argv.findIndex((arg) => arg === "--approval-artifact" || arg === "--approval" || arg.startsWith("--approval-artifact=") || arg.startsWith("--approval="));
  const approvalArg = approvalIndex >= 0 ? readArgValue(argv, approvalIndex).value : undefined;
  const runReportIndex = argv.findIndex((arg) => arg === "--run-report" || arg === "--run-report-path" || arg.startsWith("--run-report=") || arg.startsWith("--run-report-path="));
  const runReportArg = runReportIndex >= 0 ? readArgValue(argv, runReportIndex).value : undefined;
  const reviewReportIndex = argv.findIndex((arg) => arg === "--review-report" || arg === "--review-report-path" || arg.startsWith("--review-report=") || arg.startsWith("--review-report-path="));
  const reviewReportArg = reviewReportIndex >= 0 ? readArgValue(argv, reviewReportIndex).value : undefined;
  const cwdArg = argv.find((arg) => arg.startsWith("--cwd="));
  const cwdIndex = argv.indexOf("--cwd");
  const projectRoot = resolve(
    cwdArg ? cwdArg.split("=").slice(1).join("=") : cwdIndex >= 0 && argv[cwdIndex + 1] ? argv[cwdIndex + 1] : io.cwd || process.cwd(),
  );
  const valueFlags = new Set(["--cwd", "--approval", "--approval-artifact", "--run-report", "--run-report-path", "--review-report", "--review-report-path"]);
  const prdPath = argv.find((arg, index) => !arg.startsWith("--") && !valueFlags.has(argv[index - 1]));
  const resolvedPrdPath = prdPath ? resolve(projectRoot, prdPath) : prdPath;
  const guard = inspectLifecycleGuard({
    command: "yolo-accept",
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
    prdPath: resolvedPrdPath,
  });
  if (guard.status !== "pass") {
    if (json) stdout.write(`${JSON.stringify(guard, null, 2)}\n`);
    else stderr.write(`${formatLifecycleGuardText(guard)}\n`);
    return 2;
  }
  const report = buildAcceptanceReport({
    prdPath: resolvedPrdPath,
    projectRoot,
    mode,
    approvalArtifact: approvalArg,
    runReportPath: runReportArg,
    reviewReportPath: reviewReportArg,
    writeLifecycle: !noWrite,
  }, { learnFailures: true });
  if (json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else stdout.write(`${formatAcceptanceReportText(report)}\n`);
  return report.status === "pass" ? 0 : report.status === "warning" ? 2 : 1;
}

if (isMain) {
  process.exit(runYoloAcceptCli());
}
