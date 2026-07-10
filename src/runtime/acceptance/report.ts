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
import { readRegisteredArtifactDigests, verifyArtifactIntegrity } from "../evidence/artifact-integrity.js";
import type { ArtifactIntegrityRecord } from "../evidence/artifact-integrity.js";
import { computeSourceFingerprint } from "../evidence/source-fingerprint.js";
import { ACCEPTANCE_RUN_PASS_STATUSES } from "../../lib/status-vocab.js";
import { isWithin } from "../../lib/security/path-guard.js";
import { verifyApprovalSignature, approvalSignablePayload } from "../../lib/security/approval-signing.js";
import { resolveManualAcceptancePublicKey } from "../../lifecycle/manual-acceptance-keys.js";
import { withRuntimeInvariantCode } from "../invariants.js";

export const ACCEPTANCE_REPORT_SCHEMA_VERSION = "1.0";
export const ACCEPTANCE_REPORT_SCHEMA = "yolo.acceptance.report.v1";

// ── Types ──────────────────────────────────────────────────────────────────
// Acceptance data is loose JSON read from disk; record bases are
// Record<string, unknown> and structured records carry the fields actually
// consumed below. Inputs are typed as unknown and narrowed, never widened to
// `any`.
export type AcceptanceRecord = Record<string, unknown>;

export interface AcceptanceIssue extends AcceptanceRecord {
  level: string;
  code: string;
  message: string;
  // Structured extra fields attached to specific issue codes (see pushIssue
  // call sites); typed so consumers can inspect them without narrowing `unknown`.
  task_id?: unknown;
  finding_id?: unknown;
  run_id?: unknown;
  reasons?: string[];
  status?: string;
  status_entries?: StatusEntry[];
  non_pass_statuses?: StatusEntry[];
  dry_run_flags?: FlagEntry[];
  failed?: number;
  blocked?: number;
  evidence_failures?: number;
  gate_failures?: number;
  review_issues?: number;
  review_errors?: number;
  fixture_failures?: number;
  fixture_blocked?: number;
  fixture_status?: string | null;
  spec_blocked?: number;
  ledger_integrity_errors?: number;
  artifact_path?: string;
  expected_sha256?: string | null;
  actual_sha256?: string | null;
}

export interface IssueSummary {
  p0: number;
  p1: number;
  p2: number;
  human_review: number;
  total: number;
}

export interface ManualCriterion extends AcceptanceRecord {
  task_id: unknown;
  condition_id: unknown;
  text: string;
}

export interface JsonParseErrorReport extends AcceptanceRecord {
  schema: "yolo.invalid_json.v1";
  status: "error";
  parse_error: {
    code: "JSON_PARSE_FAILED";
    path: string;
    message: string;
  };
}

export interface RunReport extends AcceptanceRecord {
  report?: RunReport;
  summary?: AcceptanceRecord;
  run_id?: unknown;
  runId?: unknown;
  prd?: unknown;
  prd_path?: unknown;
  status?: unknown;
  schema?: unknown;
  stage?: unknown;
  failed?: unknown;
  blocked?: unknown;
  gates?: AcceptanceRecord;
  review?: AcceptanceRecord;
  fixtures?: AcceptanceRecord;
  spec_governance?: AcceptanceRecord;
  ledger?: AcceptanceRecord;
  evidence_integrity?: AcceptanceRecord;
  parse_error?: { code?: string; path?: string; message?: string };
}

export interface ReviewReport extends AcceptanceRecord {
  report?: ReviewReport;
  findings?: unknown;
  review?: AcceptanceRecord;
  review_output?: AcceptanceRecord;
  reviewOutput?: AcceptanceRecord;
  prd_path?: unknown;
  prd?: unknown;
}

export interface ReviewFinding extends AcceptanceRecord {
  severity?: unknown;
  must_fix_before_ship?: unknown;
  finding_id?: unknown;
  id?: unknown;
  source_finding_id?: unknown;
  status?: unknown;
  state?: unknown;
  resolution?: unknown;
}

export interface ReviewFixTask extends AcceptanceRecord {
  id?: unknown;
  task_kind?: unknown;
  source_finding_ids?: unknown;
  source_findings?: unknown;
  fix_findings?: unknown;
}

export interface PrdTask extends AcceptanceRecord {
  id?: unknown;
  acceptance_criteria?: unknown;
  post_conditions?: unknown;
  task_kind?: unknown;
  scope?: AcceptanceRecord;
  files?: unknown;
}

export interface Prd extends AcceptanceRecord {
  tasks?: unknown;
}

export interface PostCondition extends AcceptanceRecord {
  type?: unknown;
  id?: unknown;
  text?: unknown;
  detail?: unknown;
  verify_command?: unknown;
  params?: AcceptanceRecord;
}

export interface AdapterEvidence extends AcceptanceRecord {
  status?: unknown;
  code?: unknown;
  adapter?: AcceptanceRecord;
  required_platform?: unknown;
  platform_coverage?: AcceptanceRecord;
  ui_evidence?: UiEvidence;
  collected_evidence?: unknown;
  artifact_path?: unknown;
}

export interface UiEvidence extends AcceptanceRecord {
  page_reachable?: unknown;
  critical_path_passed?: unknown;
  required_state_present?: unknown;
  content_overlap?: unknown;
  text_overflow?: unknown;
  runtime_errors?: unknown;
  screenshots?: unknown;
  polish_notes?: unknown;
  human_review_notes?: unknown;
  visual_artifacts?: string[];
}

export interface ResolverResult extends AcceptanceRecord {
  selected?: AcceptanceRecord;
  blockers?: unknown;
}

export interface ApprovalArtifact extends AcceptanceRecord {
  approved?: unknown;
  status?: unknown;
  approved_at?: unknown;
  approvedAt?: unknown;
  executed_at?: unknown;
  executedAt?: unknown;
  approver?: unknown;
  approved_by?: unknown;
  approvedBy?: unknown;
  reviewer?: unknown;
  warning_digest?: unknown;
  warnings_digest?: unknown;
  issue_digest?: unknown;
  issues_digest?: unknown;
  warning_count?: unknown;
  warnings_count?: unknown;
  issue_count?: unknown;
  issues_count?: unknown;
  prd_path?: unknown;
  prdPath?: unknown;
  mode?: unknown;
  acceptance_mode?: unknown;
  acceptanceMode?: unknown;
  signature?: unknown;
}

export interface ApprovalWarningExpectation extends AcceptanceRecord {
  prd_path?: unknown;
  mode?: unknown;
  warning_count?: number;
  warning_digest?: unknown;
}

export interface ApprovalReadResult {
  artifact_path: string;
  artifact: unknown;
  error: ApprovalInvalidReason | null;
}

export interface ApprovalInvalidReason extends AcceptanceRecord {
  code: string;
  message: string;
}

export interface ApprovalResult {
  artifact_path: string;
  artifact: unknown;
  approved: boolean;
  invalid_reasons: ApprovalInvalidReason[];
  expected: ApprovalWarningExpectation;
}

export interface StatusEntry {
  field: string;
  status: string;
}

export interface FlagEntry {
  field: string;
  value: true;
}

export interface RunEvidencePayload {
  run_id: string;
  summary: AcceptanceRecord | null;
  prd: string;
}

export interface AcceptanceInput extends AcceptanceRecord {
  prd?: Prd;
  prdPath?: unknown;
  prd_path?: unknown;
  mode?: unknown;
  acceptanceMode?: unknown;
  acceptance_mode?: unknown;
  projectRoot?: unknown;
  project_root?: unknown;
  stateRoot?: unknown;
  state_root?: unknown;
  runReportPath?: unknown;
  run_report_path?: unknown;
  reviewReportPath?: unknown;
  review_report_path?: unknown;
  uiEvidencePath?: unknown;
  ui_evidence_path?: unknown;
  adapterEvidencePath?: unknown;
  adapter_evidence_path?: unknown;
  runReport?: unknown;
  run_report?: unknown;
  reviewReport?: unknown;
  review_report?: unknown;
  uiEvidence?: unknown;
  ui_evidence?: unknown;
  adapterEvidence?: unknown;
  adapter_evidence?: unknown;
  resolver?: ResolverResult;
  approvalArtifact?: unknown;
  approval_artifact?: unknown;
  acceptanceApprovalArtifact?: unknown;
  acceptance_approval_artifact?: unknown;
  collectEvidence?: unknown;
  collect_evidence?: unknown;
  requiredPlatform?: unknown;
  required_platform?: unknown;
  platform?: unknown;
  executeAdapter?: unknown;
  execute_adapter?: unknown;
  allowAdapterCommands?: unknown;
  allow_adapter_commands?: unknown;
  artifactDigests?: unknown;
  artifact_digests?: unknown;
  expectedArtifactDigests?: unknown;
  expected_artifact_digests?: unknown;
  writeLifecycle?: unknown;
  write_lifecycle?: unknown;
  learnFailures?: unknown;
}

export interface AcceptanceOptions extends AcceptanceRecord {
  prdPath?: unknown;
  prd_path?: unknown;
  mode?: unknown;
  acceptanceMode?: unknown;
  acceptance_mode?: unknown;
  projectRoot?: unknown;
  project_root?: unknown;
  stateRoot?: unknown;
  state_root?: unknown;
  runReportPath?: unknown;
  run_report_path?: unknown;
  reviewReportPath?: unknown;
  review_report_path?: unknown;
  uiEvidencePath?: unknown;
  ui_evidence_path?: unknown;
  adapterEvidencePath?: unknown;
  adapter_evidence_path?: unknown;
  approvalArtifact?: unknown;
  approval_artifact?: unknown;
  acceptanceApprovalArtifact?: unknown;
  acceptance_approval_artifact?: unknown;
  collectEvidence?: unknown;
  collect_evidence?: unknown;
  requiredPlatform?: unknown;
  required_platform?: unknown;
  platform?: unknown;
  executeAdapter?: unknown;
  execute_adapter?: unknown;
  allowAdapterCommands?: unknown;
  allow_adapter_commands?: unknown;
  artifactDigests?: unknown;
  artifact_digests?: unknown;
  expectedArtifactDigests?: unknown;
  expected_artifact_digests?: unknown;
  writeLifecycle?: unknown;
  write_lifecycle?: unknown;
  learnFailures?: unknown;
}

export interface AcceptanceCliIo {
  stdout?: { write: (data: string) => unknown } & AcceptanceRecord;
  stderr?: { write: (data: string) => unknown } & AcceptanceRecord;
  cwd?: string;
}

export interface WarningApproval extends AcceptanceRecord {
  required?: boolean;
  approved?: boolean;
  artifact_path?: string;
  expected?: ApprovalWarningExpectation;
  invalid_reasons?: ApprovalInvalidReason[];
}

export interface AcceptanceReport extends AcceptanceRecord {
  schema_version: string;
  schema: string;
  status: string;
  code: string;
  summary: string;
  generated_at: string;
  project_root: string;
  state_root: string;
  prd_path: string;
  mode: string;
  manual_criteria: ManualCriterion[];
  issue_summary: IssueSummary;
  issues: AcceptanceIssue[];
  warning_approval: WarningApproval;
  resolver: ResolverResult;
  adapter_evidence: AdapterEvidence | null;
  ui: { ui_task_count: number };
  artifact_integrity: ArtifactIntegrityResult;
  artifacts: string[];
  // CR5 part (b): freeze digest of the project's tracked source files. The ship
  // gate recomputes this over the current source and blocks on any mutation.
  source_fingerprint: AcceptanceRecord;
  next_actions: string[];
  lifecycle_write?: AcceptanceRecord;
}
// ── /Types ─────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
const RELEASE_ACCEPTANCE_MODES = new Set(["ship", "release"]);

function nowIso(): string {
  return new Date().toISOString();
}

function readJsonMaybe(path: unknown): AcceptanceRecord | JsonParseErrorReport | null {
  if (!path) return null;
  const resolved = resolve(String(path));
  if (!existsSync(resolved)) return null;
  try {
    return JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    return {
      schema: "yolo.invalid_json.v1",
      status: "error",
      parse_error: {
        code: "JSON_PARSE_FAILED",
        path: resolved,
        message: error instanceof Error ? error.message : String(error ?? "JSON parse failed."),
      },
    };
  }
}

function isLifecycleStageReport(report: unknown): report is AcceptanceRecord {
  return Boolean(report && typeof report === "object" &&
    ((report as AcceptanceRecord).schema === "yolo.lifecycle.stage_report.v1" || ((report as AcceptanceRecord).lifecycle_schema && (report as AcceptanceRecord).report)));
}

function latestStateRunReportPath(stateRoot: string): string {
  const reportsRoot = join(stateRoot, "state", "reports");
  if (!existsSync(reportsRoot)) return "";
  try {
    const candidates = readdirSync(reportsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("run-"))
      .map((entry): { path: string; mtime: number } | null => {
        const reportPath = join(reportsRoot, entry.name, "run-report.json");
        if (!existsSync(reportPath)) return null;
        const stat = statSync(reportPath);
        return { path: reportPath, mtime: stat.mtimeMs };
      })
      .filter((entry): entry is { path: string; mtime: number } => entry !== null)
      .sort((a, b) => (b.mtime - a.mtime) || b.path.localeCompare(a.path));
    return candidates[0]?.path || "";
  } catch {
    return "";
  }
}

function defaultRunReportPath(stateRoot: string): string {
  const lifecyclePath = join(stateRoot, "lifecycle", "run-report.json");
  let lifecycleReport: AcceptanceRecord | JsonParseErrorReport | null = null;
  try {
    lifecycleReport = readJsonMaybe(lifecyclePath);
  } catch {
    return lifecyclePath;
  }
  if (lifecycleReport && !isLifecycleStageReport(lifecycleReport)) return lifecyclePath;
  return latestStateRunReportPath(stateRoot) || lifecyclePath;
}

function defaultAdapterEvidencePath({ stateRoot, resolver }: { stateRoot: string; resolver?: ResolverResult }): string {
  const adapterId = asRecord(resolver?.selected?.acceptance_adapter)?.id;
  if (!adapterId || adapterId === "unknown/custom") return "";
  return join(stateRoot, "state", "evidence", "adapters", `${adapterId}-latest.json`);
}

function loadPrd(input: AcceptanceInput = Object()): Prd | AcceptanceRecord | JsonParseErrorReport | null {
  if (input.prd) return input.prd;
  return readJsonMaybe(input.prdPath || input.prd_path);
}

function acceptanceMode(input: AcceptanceInput = Object(), options: AcceptanceOptions = Object()): string {
  return clean(input.mode || input.acceptanceMode || input.acceptance_mode || options.mode || options.acceptanceMode || options.acceptance_mode || "accept").toLowerCase();
}

function approvalArtifactPath({ input = Object(), options = Object(), stateRoot }: { input: AcceptanceInput; options: AcceptanceOptions; stateRoot: string }): string {
  return String(input.approvalArtifact ||
    input.approval_artifact ||
    input.acceptanceApprovalArtifact ||
    input.acceptance_approval_artifact ||
    options.approvalArtifact ||
    options.approval_artifact ||
    options.acceptanceApprovalArtifact ||
    options.acceptance_approval_artifact ||
    join(stateRoot, "lifecycle", "acceptance-approval.json"));
}

function readApprovalArtifact(path: unknown, boundaryRoot: string): ApprovalReadResult {
  if (!path) {
    return { artifact_path: "", artifact: null, error: null };
  }
  const resolved = resolve(String(path));
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
        message: error instanceof Error ? error.message : String(error ?? "Approval artifact is not valid JSON."),
      },
    };
  }
}

function warningApprovalDigest({ prdPath, mode, warnings = [] }: { prdPath: string; mode: string; warnings?: AcceptanceIssue[] } = Object()): string {
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

function approvalValueMatches(value: unknown, expected: unknown): boolean {
  // M5: previously `if (!expected) return true` — a missing expected value
  // auto-matched any artifact value, including for key fields (prd_path, mode).
  // For key fields a missing expected must NOT auto-match: if the artifact
  // carries a value the caller didn't expect (or expect is unset), treat it as
  // a mismatch so the approval is flagged for review rather than silently pass.
  const expectedStr = clean(expected);
  const valueStr = clean(value);
  if (!expectedStr) return !valueStr;
  return valueStr === expectedStr;
}

function hasApprovalAuditFields(approval: ApprovalArtifact = Object()): boolean {
  return Boolean(clean(approval.approved_at || approval.approvedAt || approval.executed_at || approval.executedAt)) &&
    Boolean(clean(approval.approver || approval.approved_by || approval.approvedBy || approval.reviewer));
}

function approvalWarningsMatch(approval: ApprovalArtifact = Object(), expected: ApprovalWarningExpectation = Object()): boolean {
  const expectedCount = expected.warning_count || 0;
  const digest = approval.warning_digest || approval.warnings_digest || approval.issue_digest || approval.issues_digest;
  if (digest) return clean(digest) === clean(expected.warning_digest);
  const count = approval.warning_count ?? approval.warnings_count ?? approval.issue_count ?? approval.issues_count;
  if (count != null) return Number(count) === expectedCount;
  return expectedCount === 0;
}

function asRecord(value: unknown): AcceptanceRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AcceptanceRecord : null;
}

// Generic, behaviorally-faithful counterpart to the (untyped) `asArray` helper
// imported from readiness-policy. Same normalization — arrays are filtered for
// truthy entries and scalars are wrapped into a single-element array — but
// carries an element type so downstream member access is statically safe.
function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value.filter(Boolean) as T[];
  if (value == null || value === "") return [];
  return [value] as T[];
}

export function approvalFromArtifact(path: unknown, expected: ApprovalWarningExpectation = Object(), boundaryRoot: string): ApprovalResult {
  const read = readApprovalArtifact(path, boundaryRoot);
  const artifact = asRecord(read.artifact);
  const payload = (artifact && asRecord(artifact.report)) || artifact;
  const approval: ApprovalArtifact | null = (payload && (asRecord(payload.approval) || asRecord(payload.acceptance_approval))) || payload;
  const approved = approval?.approved === true || clean(approval?.status).toLowerCase() === "approved";
  const reasons: ApprovalInvalidReason[] = [];
  if (read.error) reasons.push(read.error);
  if (artifact && !approved) {
    reasons.push({ code: "ACCEPTANCE_WARNING_APPROVAL_NOT_APPROVED", message: "Approval artifact is present but not approved." });
  }
  if (artifact && approved && approval) {
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
    // CR2/P12.I4: ed25519 signature verification for release approvals.
    // Enforcement model: fail-closed against the project-rooted committed public
    // key (unified with manual-acceptance evidence — CR1). The verifier key lives
    // at <stateRoot>/keys/manual-acceptance.pub and is NOT gated on an optional
    // env var. When a signature IS present it MUST verify against that key; a
    // missing key means we cannot prove the signature valid → block. When the
    // committed key exists but the artifact carries no signature, that is also
    // rejected (the pipeline has committed to signed approvals).
    const publicKey = resolveManualAcceptancePublicKey(boundaryRoot);
    const signature = clean(approval?.signature);
    if (signature) {
      if (!publicKey) {
        // Signature present but the project-rooted verification key is unavailable
        // — we cannot prove the signature valid, so fail-closed (never advisory).
        reasons.push({ code: "ACCEPTANCE_WARNING_APPROVAL_SIGNATURE_INVALID", message: "Approval signature present but the project-rooted verification key is unavailable; cannot verify." });
      } else {
        const signablePayload = approvalSignablePayload(approval);
        const sigResult = verifyApprovalSignature(signablePayload, signature, publicKey);
        if (!sigResult.verified) {
          reasons.push({ code: "ACCEPTANCE_WARNING_APPROVAL_SIGNATURE_INVALID", message: `Approval signature verification failed: ${sigResult.detail}` });
        }
      }
    } else if (publicKey) {
      // Committed key configured but no signature on the approval — fail-closed.
      // The pipeline has committed to signed approvals; unsigned is rejected.
      reasons.push({ code: "ACCEPTANCE_WARNING_APPROVAL_SIGNATURE_MISSING", message: "A project-rooted approval public key is configured but the approval artifact has no signature. Sign the approval with the matching private key." });
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

function readArgValue(argv: string[], index: number): { value: string | undefined; consumed: number } {
  const arg = argv[index];
  if (arg.includes("=")) return { value: arg.split("=").slice(1).join("="), consumed: 0 };
  return { value: argv[index + 1], consumed: 1 };
}

function pushIssue(issues: AcceptanceIssue[], level: string, code: string, message: string, extra: AcceptanceRecord = Object()): void {
  issues.push({
    level,
    code,
    message,
    ...extra,
  });
}

function summarizeIssues(issues: AcceptanceIssue[] = []): IssueSummary {
  return {
    p0: issues.filter((issue) => issue.level === "P0").length,
    p1: issues.filter((issue) => issue.level === "P1").length,
    p2: issues.filter((issue) => issue.level === "P2").length,
    human_review: issues.filter((issue) => issue.level === "human_review").length,
    total: issues.length,
  };
}

const STATUS_FIELDS = new Set(["status", "verdict", "outcome"]);

function isRecoveredAutomationRemediation(record: AcceptanceRecord, field: string, key: string, status: string): boolean {
  if (key !== "status" || status !== "remediation_required") return false;
  if (!/^remediation\.items\.\d+\.status$/.test(field)) return false;
  return record.automation_can_continue === true
    && record.requires_human !== true
    && record.unsafe_stop !== true;
}

function collectReportStatuses(report: unknown, depth = 0, field = "", seen: Set<unknown> = new Set()): StatusEntry[] {
  if (Array.isArray(report)) {
    return report.flatMap((item, index) =>
      collectReportStatuses(item, depth + 1, field ? `${field}.${index}` : String(index), seen),
    );
  }
  if (!report || typeof report !== "object" || depth > 20 || seen.has(report)) return [];
  seen.add(report);
  const record = report as AcceptanceRecord;
  const statuses: StatusEntry[] = [];
  for (const [key, value] of Object.entries(record)) {
    const nextField = field ? `${field}.${key}` : key;
    if (nextField.includes("recent_events") || nextField.includes("recentEvents")) continue;
    if (STATUS_FIELDS.has(key)) {
      const status = clean(value).toLowerCase();
      const wrapperStatus = key === "status" &&
        ["completed", "done"].includes(status) &&
        Boolean(record.report || record.result || record.run_report || record.runReport);
      if (status && !wrapperStatus && !isRecoveredAutomationRemediation(record, nextField, key, status)) {
        statuses.push({ field: nextField, status });
      }
    }
    if (value && typeof value === "object") {
      statuses.push(...collectReportStatuses(value, depth + 1, nextField, seen));
    }
  }
  return statuses;
}

function collectReportFlags(report: unknown, flagNames: string[] = [], depth = 0, field = "", seen: Set<unknown> = new Set()): FlagEntry[] {
  if (Array.isArray(report)) {
    return report.flatMap((item, index) =>
      collectReportFlags(item, flagNames, depth + 1, field ? `${field}.${index}` : String(index), seen),
    );
  }
  if (!report || typeof report !== "object" || depth > 20 || seen.has(report)) return [];
  seen.add(report);
  const record = report as AcceptanceRecord;
  const flags: FlagEntry[] = [];
  for (const [key, value] of Object.entries(record)) {
    const nextField = field ? `${field}.${key}` : key;
    if (flagNames.includes(key) && value === true) flags.push({ field: nextField, value: true });
    if (value && typeof value === "object") {
      flags.push(...collectReportFlags(value, flagNames, depth + 1, nextField, seen));
    }
  }
  return flags;
}

function acceptanceCriteriaIssues(prd: Prd | null, issues: AcceptanceIssue[]): void {
  const tasks: PrdTask[] = asArray(prd?.tasks);
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

function hasVerifyCommand(condition: PostCondition): boolean {
  return Boolean(clean(condition.verify_command) || clean(condition.params?.verify_command));
}

function collectManualCriteria(prd: Prd | null): ManualCriterion[] {
  const manualCriteria: ManualCriterion[] = [];
  const tasks: PrdTask[] = asArray(prd?.tasks);
  for (const task of tasks) {
    const conditions: PostCondition[] = asArray(task.post_conditions);
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

function isStructuredSummary(summary: unknown): summary is AcceptanceRecord {
  return Boolean(summary) && typeof summary === "object" && !Array.isArray(summary)
    && RUN_SUMMARY_FIELDS.some((field) => Number.isFinite(Number((summary as AcceptanceRecord)[field])));
}

function runEvidencePayload(runReport: unknown): RunEvidencePayload {
  const empty: RunEvidencePayload = { run_id: "", summary: null, prd: "" };
  if (!runReport || typeof runReport !== "object") return empty;
  const report = runReport as RunReport;
  const nested = report.report && typeof report.report === "object" ? report.report : null;
  const topLevelSummary = (report.summary && typeof report.summary === "object" && !Array.isArray(report.summary))
    ? report.summary
    : null;
  const nestedSummary = (nested && nested.summary && typeof nested.summary === "object" && !Array.isArray(nested.summary))
    ? nested.summary
    : null;
  // A stage wrapper may carry a stage-level summary ({failed, blocked}) at the top
  // level; the verifiable structured run summary lives inside the nested .report.
  // Prefer the summary that actually carries structured run-report fields.
  const summarySource: AcceptanceRecord | null = (topLevelSummary && isStructuredSummary(topLevelSummary))
    ? topLevelSummary
    : (nestedSummary && isStructuredSummary(nestedSummary)
      ? nestedSummary
      : (topLevelSummary || nestedSummary));
  return {
    run_id: clean(report.run_id || report.runId || (nested && (nested.run_id || nested.runId)) || ""),
    summary: summarySource,
    prd: clean(report.prd || report.prd_path || (nested && (nested.prd || nested.prd_path)) || ""),
  };
}

function runReportSufficiencyIssues(runReport: unknown, issues: AcceptanceIssue[], { prdPath = "" }: { prdPath?: string } = Object()): void {
  if (!runReport) return;
  const report = runReport as RunReport;
  const payload = runEvidencePayload(report);
  const reasons: string[] = [];
  if (!payload.run_id) reasons.push("missing run_id");
  const hasStructuredSummary = isStructuredSummary(payload.summary);
  if (!hasStructuredSummary) reasons.push("missing structured summary (planned/completed/failed/blocked)");
  if (prdPath && !payload.prd) reasons.push("missing PRD lineage binding");
  if (reasons.length > 0) {
    const extra = isLifecycleStageReport(report)
      ? withRuntimeInvariantCode({}, "acceptance_run_report_wrapper")
      : {};
    pushIssue(issues, "P1", "RUN_REPORT_INSUFFICIENT",
      "Run report must carry a verifiable run_id, a structured task summary, and PRD lineage — a minimal lifecycle stage wrapper is not valid run evidence.",
      {
        ...extra,
        run_id: payload.run_id || null,
        reasons,
        schema: clean(report.schema) || null,
        stage: clean(report.stage) || null,
      });
  }
}

function runtimeEvidenceIssues(runReport: unknown, issues: AcceptanceIssue[], { releaseMode = false, prdPath = "" }: { releaseMode?: boolean; prdPath?: string } = Object()): void {
  if (!runReport) {
    pushIssue(issues, "P1", "RUN_REPORT_MISSING", "Acceptance requires run evidence or an explicit degraded/manual record.");
    return;
  }
  const report = runReport as RunReport;
  if (report.parse_error?.code === "JSON_PARSE_FAILED") {
    pushIssue(issues, "P1", "RUN_REPORT_JSON_INVALID", "Run report JSON could not be parsed.", {
      path: report.parse_error.path || null,
      error: report.parse_error.message || "JSON parse failed.",
    });
    return;
  }
  runReportSufficiencyIssues(report, issues, { prdPath });
  const status = clean(report.status).toLowerCase();
  const statusEntries = collectReportStatuses(report);
  const nonPassStatuses = statusEntries.filter((entry) => !ACCEPTANCE_RUN_PASS_STATUSES.has(entry.status));
  const dryRunFlags = collectReportFlags(report, ["dry_run", "dryRun"]);
  const failed = Number(report.summary?.failed || asArray(report.failed).length || 0);
  const blocked = Number(report.summary?.blocked || asArray(report.blocked).length || 0);
  const evidenceFailures = Number(report.summary?.evidence_failures || 0);
  const gateFailures = Number(report.gates?.failed_count || 0);
  const reviewIssues = Number(report.review?.issue_count || 0);
  const reviewErrors = Number(report.review?.error_count || 0);
  const fixtureFailures = Number(report.fixtures?.fail_count || 0);
  const fixtureBlocked = Number(report.fixtures?.blocked_count || 0);
  const fixtureDegraded = Number(report.fixtures?.degraded_count || 0);
  const fixtureStatus = clean(report.fixtures?.status).toLowerCase();
  const specBlocked = Number(report.spec_governance?.blocked_count || 0);
  const ledgerIntegrityErrors = Number(asRecord(report.ledger?.integrity)?.error_count || report.evidence_integrity?.error_count || 0);
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
    (fixtureStatus && !ACCEPTANCE_RUN_PASS_STATUSES.has(fixtureStatus)) ||
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

function adapterEvidenceIssues(adapterEvidence: AdapterEvidence | null, issues: AcceptanceIssue[]): void {
  if (!adapterEvidence) return;
  const status = clean(adapterEvidence.status).toLowerCase();
  if (!ACCEPTANCE_RUN_PASS_STATUSES.has(status)) {
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

function reviewFindingsFromReports(...reports: unknown[]): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const report of reports) {
    const record = asRecord(report) as ReviewReport | null;
    const review = (record && asRecord(record.review)) || null;
    const reviewOutput = (record && asRecord(record.review_output)) || null;
    const nested = (record && asRecord(record.report)) as ReviewReport | null;
    const nestedReview = (nested && asRecord(nested.review)) || null;
    const nestedReviewOutput = (nested && asRecord(nested.review_output)) || null;
    findings.push(
      ...toArray<ReviewFinding>(record?.findings),
      ...toArray<ReviewFinding>(review?.findings),
      ...toArray<ReviewFinding>(review?.issues),
      ...toArray<ReviewFinding>(reviewOutput?.findings),
      ...toArray<ReviewFinding>(record?.reviewOutput),
      ...toArray<ReviewFinding>(nested?.findings),
      ...toArray<ReviewFinding>(nestedReview?.findings),
      ...toArray<ReviewFinding>(nestedReview?.issues),
      ...toArray<ReviewFinding>(nestedReviewOutput?.findings),
      ...toArray<ReviewFinding>(nested?.reviewOutput),
    );
  }
  return findings;
}

function reviewIssues(reviewReport: unknown, runReport: unknown, issues: AcceptanceIssue[]): void {
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

function reviewFixTasks(prd: Prd | null): ReviewFixTask[] {
  return toArray<ReviewFixTask>(prd?.tasks).filter((task) => task?.task_kind === "review_fix");
}

function taskSourceFindingIds(task: ReviewFixTask = Object()): string[] {
  return [
    ...toArray<string>(task.source_finding_ids),
    ...toArray<ReviewFinding>(task.source_findings).map((finding) => finding?.finding_id || finding?.id),
    ...toArray<ReviewFinding>(task.fix_findings).map((finding) => finding?.finding_id || finding?.id),
  ].map((value) => clean(value)).filter(Boolean);
}

function findingIdCandidates(finding: ReviewFinding = Object()): string[] {
  return [
    finding.finding_id,
    finding.id,
    finding.source_finding_id,
  ].map((value) => clean(value)).filter(Boolean);
}

function findingIsClosed(finding: ReviewFinding = Object()): boolean {
  const status = clean(finding.status || finding.state || finding.resolution).toLowerCase();
  return ["closed", "resolved", "fixed", "pass", "passed"].includes(status);
}

function reviewFixClosureIssues(prd: Prd | null, reviewReport: unknown, runReport: unknown, issues: AcceptanceIssue[]): void {
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

function normalizePathForCompare(value: unknown): string {
  return value ? resolve(String(value)) : "";
}

function explicitOption(input: AcceptanceInput = Object(), options: AcceptanceOptions = Object(), ...keys: string[]): boolean {
  return keys.some((key) => input[key] !== undefined || options[key] !== undefined);
}

function expectedArtifactDigests(input: AcceptanceInput = Object(), options: AcceptanceOptions = Object()): AcceptanceRecord {
  return (input.artifactDigests ||
    input.artifact_digests ||
    input.expectedArtifactDigests ||
    input.expected_artifact_digests ||
    options.artifactDigests ||
    options.artifact_digests ||
    options.expectedArtifactDigests ||
    options.expected_artifact_digests ||
    {}) as AcceptanceRecord;
}

interface ArtifactIntegrityResult {
  status?: string;
  checked_count?: number;
  artifacts: ArtifactIntegrityRecord[];
  missing?: ArtifactIntegrityRecord[];
  digest_mismatches?: ArtifactIntegrityRecord[];
  unverified?: ArtifactIntegrityRecord[];
}

function pushArtifactIntegrityIssues(issues: AcceptanceIssue[], integrity: ArtifactIntegrityResult): void {
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
  for (const artifact of integrity.unverified || []) {
    pushIssue(issues, "P1", "ACCEPTANCE_ARTIFACT_UNVERIFIED", "Acceptance evidence artifact has no declared expected sha256.", {
      artifact_path: artifact.absolute_path,
    });
  }
}

function evidenceLineageIssues({ prdPath, runReport, reviewReport }: { prdPath: string; runReport: unknown; reviewReport: unknown }, issues: AcceptanceIssue[]): void {
  const expectedPrd = normalizePathForCompare(prdPath);
  if (!expectedPrd) return;
  const run = asRecord(runReport) as RunReport | null;
  const review = asRecord(reviewReport) as ReviewReport | null;
  const runPrd = normalizePathForCompare(run?.report?.prd || run?.prd || run?.prd_path);
  const reviewPrd = normalizePathForCompare(review?.report?.prd_path || review?.prd_path || review?.prd);
  if (run && runPrd && runPrd !== expectedPrd) {
    pushIssue(issues, "P1", "RUN_REPORT_PRD_MISMATCH", "Run evidence belongs to a different PRD.", {
      expected_prd: expectedPrd,
      actual_prd: runPrd,
    });
  }
  if (review && reviewPrd && reviewPrd !== expectedPrd) {
    pushIssue(issues, "P1", "REVIEW_REPORT_PRD_MISMATCH", "Review evidence belongs to a different PRD.", {
      expected_prd: expectedPrd,
      actual_prd: reviewPrd,
    });
  }
}

function uiEvidenceIssues({ prd, uiEvidence, resolver }: { prd: Prd | null; uiEvidence: UiEvidence | null; resolver?: ResolverResult }, issues: AcceptanceIssue[]): { ui_task_count: number } {
  const tasks = uiTasks(prd, { resolver });
  if (tasks.length === 0) return { ui_task_count: 0 };
  if (!uiEvidence) {
    pushIssue(issues, "P1", "UI_EVIDENCE_MISSING", "UI tasks require screenshot/log/runtime evidence.");
    return { ui_task_count: tasks.length };
  }
  if (asRecord(resolver?.selected?.acceptance_adapter)?.id === "unknown/custom") {
    pushIssue(issues, "P1", "UI_ACCEPTANCE_ADAPTER_MISSING", "UI acceptance requires an acceptance adapter manifest.");
  }
  if (uiEvidence.page_reachable === false) pushIssue(issues, "P0", "UI_PAGE_UNREACHABLE", "Target page or surface is unreachable.");
  if (uiEvidence.critical_path_passed === false) pushIssue(issues, "P0", "UI_CRITICAL_PATH_FAILED", "Critical UI path failed.");
  if (uiEvidence.required_state_present === false) pushIssue(issues, "P0", "UI_REQUIRED_STATE_MISSING", "Required UI state is missing.");
  if (uiEvidence.content_overlap === true || uiEvidence.text_overflow === true) pushIssue(issues, "P0", "UI_LAYOUT_BLOCKER", "Main content overlaps or overflows.");
  const runtimeErrors = asArray(uiEvidence.runtime_errors);
  if (runtimeErrors.length > 0) {
    pushIssue(issues, "P0", "UI_RUNTIME_ERRORS", "Runtime errors were reported by UI evidence.", { count: runtimeErrors.length });
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

// CR5 part (b): collect the delivered source-file paths declared by the PRD —
// scope.targets[].file plus target_file_modified post-condition params.file.
// These are the files whose integrity the source fingerprint freezes; scoping
// to them (rather than the whole git tree) keeps the freeze stable across a
// single-stage run while still catching tampering of delivered files.
function prdTargetFiles(prd: unknown): string[] {
  if (!prd || typeof prd !== "object") return [];
  const record = prd as Record<string, unknown>;
  const tasks = Array.isArray(record.tasks) ? record.tasks : [];
  const files = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    const taskRecord = task as Record<string, unknown>;
    const scope = taskRecord.scope as Record<string, unknown> | undefined;
    const targets = Array.isArray(scope?.targets) ? scope.targets : [];
    for (const target of targets) {
      if (target && typeof target === "object") {
        const file = (target as Record<string, unknown>).file;
        if (typeof file === "string" && file.trim()) files.add(file.trim());
      }
    }
    const postConditions = Array.isArray(taskRecord.post_conditions) ? taskRecord.post_conditions : [];
    for (const condition of postConditions) {
      if (!condition || typeof condition !== "object") continue;
      const conditionRecord = condition as Record<string, unknown>;
      if (conditionRecord.type !== "target_file_modified") continue;
      const file = (conditionRecord.params as Record<string, unknown> | undefined)?.file;
      if (typeof file === "string" && file.trim()) files.add(file.trim());
    }
  }
  return [...files];
}

export function buildAcceptanceReport(input: AcceptanceInput = Object(), options: AcceptanceOptions = Object()): AcceptanceReport {
  const prdPath = String(input.prdPath || input.prd_path || options.prdPath || options.prd_path || "");
  const prd = loadPrd({ ...options, ...input });
  const projectRoot = resolve(String(input.projectRoot || input.project_root || options.projectRoot || options.project_root || (prdPath ? dirname(resolve(prdPath)) : process.cwd())));
  const stateRoot = resolve(String(input.stateRoot || input.state_root || options.stateRoot || options.state_root || `${projectRoot}/.yolo`));
  const mode = acceptanceMode(input, options);
  const resolver: ResolverResult = (input.resolver || resolveProjectContext({
    projectRoot,
    stateRoot,
    requiresAcceptanceAdapter: uiTasks(prd).length > 0,
  })) as ResolverResult;
  const runReportPath = String(input.runReportPath || input.run_report_path || options.runReportPath || options.run_report_path || defaultRunReportPath(stateRoot));
  const reviewReportPath = String(input.reviewReportPath || input.review_report_path || options.reviewReportPath || options.review_report_path || join(stateRoot, "lifecycle", "review-report.json"));
  const uiEvidencePath = String(input.uiEvidencePath || input.ui_evidence_path || options.uiEvidencePath || options.ui_evidence_path || "");
  const adapterEvidencePath = String(input.adapterEvidencePath || input.adapter_evidence_path || options.adapterEvidencePath || options.adapter_evidence_path || defaultAdapterEvidencePath({ stateRoot, resolver }));
  const runReportFromInput = Boolean(input.runReport || input.run_report);
  const reviewReportFromInput = Boolean(input.reviewReport || input.review_report);
  const uiEvidenceFromInput = Boolean(input.uiEvidence || input.ui_evidence);
  const adapterEvidenceFromInput = Boolean(input.adapterEvidence || input.adapter_evidence);
  const runReportPathExplicit = explicitOption(input, options, "runReportPath", "run_report_path");
  const reviewReportPathExplicit = explicitOption(input, options, "reviewReportPath", "review_report_path");
  const uiEvidencePathExplicit = explicitOption(input, options, "uiEvidencePath", "ui_evidence_path");
  const adapterEvidencePathExplicit = explicitOption(input, options, "adapterEvidencePath", "adapter_evidence_path");
  const runReport: unknown = input.runReport || input.run_report || readJsonMaybe(runReportPath);
  const reviewReport: unknown = input.reviewReport || input.review_report || readJsonMaybe(reviewReportPath);
  const releaseMode = RELEASE_ACCEPTANCE_MODES.has(mode);
  let uiEvidence: UiEvidence | null = (input.uiEvidence || input.ui_evidence || readJsonMaybe(uiEvidencePath)) as UiEvidence | null;
  const adapterEvidence: AdapterEvidence | null = (input.adapterEvidence || input.adapter_evidence || (
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
  )) as AdapterEvidence | null;
  if (!uiEvidence && adapterEvidence?.ui_evidence) {
    uiEvidence = adapterEvidence.ui_evidence as UiEvidence | null;
  }
  if (!uiEvidence && Array.isArray(adapterEvidence?.collected_evidence)) {
    uiEvidence = (adapterEvidence!.collected_evidence as AcceptanceRecord[]).find((record) => record?.ui_evidence)?.ui_evidence as UiEvidence | null || null;
  }
  const issues: AcceptanceIssue[] = [];
  const artifactPaths = [
    prdPath ? resolve(prdPath) : "",
    runReport && (!runReportFromInput || runReportPathExplicit) ? resolve(runReportPath) : "",
    reviewReport && (!reviewReportFromInput || reviewReportPathExplicit) ? resolve(reviewReportPath) : "",
    uiEvidence && uiEvidencePath && (!uiEvidenceFromInput || uiEvidencePathExplicit) ? resolve(uiEvidencePath) : "",
    adapterEvidence?.artifact_path || (adapterEvidence && adapterEvidencePath && (!adapterEvidenceFromInput || adapterEvidencePathExplicit) ? resolve(adapterEvidencePath) : ""),
  ].filter(Boolean) as string[];
  const registeredArtifactDigests = readRegisteredArtifactDigests(artifactPaths, {
    rootDir: projectRoot,
    stateRoot,
  });
  const artifactIntegrity = verifyArtifactIntegrity(artifactPaths, {
    rootDir: projectRoot,
    expectedSha256ByPath: {
      ...expectedArtifactDigests(input, options),
      ...registeredArtifactDigests.expected_sha256_by_path,
    },
  }) as ArtifactIntegrityResult;
  pushArtifactIntegrityIssues(issues, artifactIntegrity);
  const sourceFingerprint = computeSourceFingerprint(projectRoot, prdTargetFiles(prd));
  if (sourceFingerprint.status !== "verified") {
    pushIssue(issues, "P1", "ACCEPTANCE_SOURCE_FINGERPRINT_UNVERIFIABLE", "Acceptance source fingerprint could not verify every declared source file.", {
      reason: sourceFingerprint.reason,
      paths: sourceFingerprint.unverifiable_paths,
    });
  }
  if (!prd) {
    pushIssue(issues, "P1", "PRD_MISSING", "Acceptance requires a PRD.");
  } else {
    acceptanceCriteriaIssues(prd as Prd, issues);
  }
  runtimeEvidenceIssues(runReport, issues, { releaseMode, prdPath });
  adapterEvidenceIssues(adapterEvidence, issues);
  evidenceLineageIssues({ prdPath, runReport, reviewReport }, issues);
  reviewIssues(reviewReport, runReport, issues);
  if (prd) reviewFixClosureIssues(prd as Prd, reviewReport, runReport, issues);
  const ui = prd ? uiEvidenceIssues({ prd: prd as Prd, uiEvidence, resolver }, issues) : { ui_task_count: 0 };
  for (const blocker of toArray<AcceptanceRecord>(resolver.blockers)) {
    pushIssue(issues, "P1", clean(blocker.code) || "RESOLVER_BLOCKED", clean(blocker.message) || "Resolver blocked acceptance.");
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
  } else if (!releaseMode && summary.p1 === 0 && summary.p0 === 0 && releaseWarnings.length > 0 && !warningApproval.approved) {
    // M7: accept mode previously skipped warning-approval entirely. A warning
    // surface should not be silently ignored even in the intermediate accept
    // step — surface it as a P2 (human_review) so it is visible and tracked,
    // without hard-blocking the non-release accept flow (release/ship still
    // hard-blocks via the branch above).
    pushIssue(issues, "human_review", "ACCEPTANCE_WARNING_APPROVAL_ADVISORY", "Acceptance warnings are present and unapproved; review before release/ship (release mode will hard-block until approved).", {
      approval_artifact: warningApproval.artifact_path || resolve(approvalPath),
      warning_count: releaseWarnings.length,
      warning_digest: warningApproval.expected.warning_digest,
      mode,
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
    manual_criteria: prd ? collectManualCriteria(prd as Prd) : [],
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
    // CR5 part (b): fingerprint the DELIVERED source targets (the contract), not
    // the whole git-tracked tree. Scoping to the PRD's scope.targets +
    // target_file_modified post-condition files keeps the freeze stable across
    // a single-stage run (where the broader workspace evolves between accept
    // and ship) while still catching tampering of the files actually under
    // delivery. Falls back to the full git-tracked set only when no PRD targets
    // are declared.
    source_fingerprint: sourceFingerprint as unknown as AcceptanceRecord,
    next_actions: status === "blocked"
      ? ["Fix P0/P1 acceptance blockers, then rerun /yolo-accept.", "Do not ship until acceptance report is pass or approved with documented human review."]
      : status === "warning"
        ? ["Review P2/human review notes before delivery."]
        : ["Continue to /yolo-ship."],
  }) as AcceptanceReport;
  if (input.writeLifecycle || input.write_lifecycle || options.writeLifecycle || options.write_lifecycle) {
    report.lifecycle_write = writeLifecycleStageReport("acceptance", report, {
      projectRoot,
      stateRoot,
      source: "acceptance-report",
      learnFailures: options.learnFailures === true || input.learnFailures === true,
      skipSequenceCheck: true,
    });
    report.artifacts.push(String(report.lifecycle_write.artifact_path));
  }
  return report;
}

export const inspectAcceptanceReport = buildAcceptanceReport;

export function formatAcceptanceReportText(report: AcceptanceRecord = Object()): string {
  const lines = [`[yolo accept] ${report.status}: ${report.summary}`];
  const issueSummary = report.issue_summary as IssueSummary | undefined;
  if (issueSummary) {
    lines.push(`issues: P0=${issueSummary.p0} P1=${issueSummary.p1} P2=${issueSummary.p2} human=${issueSummary.human_review}`);
  }
  for (const issue of toArray<AcceptanceIssue>(report.issues).slice(0, 12)) {
    lines.push(`- ${issue.level}:${issue.code}${issue.task_id ? ` task=${issue.task_id}` : ""} ${issue.message}`.trim());
  }
  const nextActions = report.next_actions as string[] | undefined;
  if (nextActions?.length) {
    lines.push("next:");
    for (const action of nextActions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function runYoloAcceptCli(argv: string[] = process.argv.slice(2), io: AcceptanceCliIo = Object()): number {
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
