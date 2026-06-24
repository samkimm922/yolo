import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runPublicBetaHardeningDrill } from "./hardening-drill.js";
import { runOperatorReleaseRunbookGate } from "./operator-runbook.js";
import type { ReleaseCheck, ReleaseIssue, ReleaseRecord } from "./readiness.js";

export const POST_RELEASE_AUDIT_SCHEMA_VERSION = "1.0";

const DEFAULT_RELEASE_SCOPE = "public-beta";

export interface PackageJsonLike extends ReleaseRecord {
  name?: string;
  version?: string;
  private?: boolean;
}

export interface ComponentResult extends ReleaseRecord {
  status?: string;
  blockers?: ReleaseIssue[];
  guarantees?: ReleaseRecord;
  components?: {
    package_install?: ComponentResult;
  };
}

export interface PostReleaseChecks extends ReleaseRecord {
  dogfood_audit?: ReleaseRecord | null;
  package_install_smoke?: ComponentResult;
  packageInstallSmoke?: ComponentResult;
}

export interface PostReleaseAuditPlan extends ReleaseRecord {
  release_scope: string;
  writes_workspace: boolean;
  publishes: boolean;
  reads_credentials: boolean;
  spawns_provider: boolean;
  executes_billable_provider: boolean;
  publishes_dogfood_report: boolean;
  requires_manual_external_release_record: boolean;
  required_evidence: string[];
}

export interface PostReleaseAuditOptions extends ReleaseRecord {
  yoloRoot?: string;
  cwd?: string;
  packageJson?: PackageJsonLike;
  plan?: PostReleaseAuditPlan;
  releaseScope?: string;
  release_scope?: string;
  manualReleaseRecord?: ReleaseRecord | null;
  manual_release_record?: ReleaseRecord | null;
  operatorRunbook?: ComponentResult;
  operator_runbook?: ComponentResult;
  hardeningDrill?: ComponentResult;
  hardening_drill?: ComponentResult;
  postReleaseChecks?: PostReleaseChecks;
  post_release_checks?: PostReleaseChecks;
  dogfoodAudit?: ReleaseRecord | null;
  dogfood_audit?: ReleaseRecord | null;
  timeout_ms?: number;
  keepWorkspace?: boolean;
  commandExists?: (command: string) => boolean;
  now?: unknown;
  random?: unknown;
  providerConfigs?: unknown;
  runOperatorReleaseRunbookGate?: (options: ReleaseRecord) => ComponentResult;
  runPublicBetaHardeningDrill?: (options: ReleaseRecord) => ComponentResult;
}

function readJson(filePath: string): ReleaseRecord {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function check(code: string, passed: boolean, message: string, extra: ReleaseRecord = Object()): ReleaseCheck {
  return { code, passed, message, ...extra };
}

function isObject(value: unknown): value is ReleaseRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): boolean {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function evidencePresent(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  return Boolean(value.artifact_path)
    || Boolean(value.report_path)
    || Boolean(value.public_url)
    || (Array.isArray(value.evidence_files) && value.evidence_files.length > 0)
    || (Array.isArray(value.evidence) && value.evidence.length > 0);
}

function dogfoodAuditApproved(audit: unknown = Object()): boolean {
  const summary = isObject(audit) ? audit : {};
  return summary.status === "pass"
    && evidencePresent(summary)
    && summary.privacy_reviewed === true
    && summary.publication_approved === true
    && nonEmptyString(summary.approver);
}

function packageInstallStatus(postReleaseChecks: PostReleaseChecks = Object(), hardeningDrill: ComponentResult = Object()): unknown {
  return postReleaseChecks.package_install_smoke?.status
    || postReleaseChecks.packageInstallSmoke?.status
    || hardeningDrill.components?.package_install?.status
    || null;
}

function hardeningNoReleaseSideEffects(hardeningDrill: ComponentResult = Object()): boolean {
  return hardeningDrill.guarantees?.published === false
    && hardeningDrill.guarantees?.credential_access === false
    && hardeningDrill.guarantees?.billable_provider_execution === false;
}

function manualReleaseExternalOnly(record: ReleaseRecord = Object()): boolean {
  return record.executed_by_sdk !== true
    && record.published_by_sdk !== true
    && record.token_read_by_sdk !== true
    && record.billable_provider_executed_by_sdk !== true
    && record.dogfood_report_published_by_sdk !== true;
}

export function buildPostReleaseAuditPlan(options: PostReleaseAuditOptions = Object()): PostReleaseAuditPlan {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  return {
    schema_version: POST_RELEASE_AUDIT_SCHEMA_VERSION,
    schema: "yolo.release.post_release_audit_plan.v1",
    yolo_root: yoloRoot,
    release_scope: options.releaseScope || options.release_scope || DEFAULT_RELEASE_SCOPE,
    writes_workspace: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    publishes_dogfood_report: false,
    requires_manual_external_release_record: true,
    required_evidence: [
      "operator runbook gate ready before external execution",
      "manual release record with operator, timestamp, package name/version, registry URL, and external-only guarantees",
      "post-release hardening drill pass",
      "post-release package install smoke pass",
      "public dogfood audit pass with evidence, privacy review, and publication approval",
    ],
    stop_conditions: [
      "manual release record is missing or was executed by the SDK",
      "package is still private after claimed publish",
      "post-release hardening drill or package install smoke did not pass",
      "public dogfood report lacks evidence, privacy review, or human publication approval",
    ],
  };
}

export function runPostReleaseAuditGate(options: PostReleaseAuditOptions = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const packageJson: PackageJsonLike = options.packageJson || readJson(join(yoloRoot, "package.json"));
  const plan = options.plan || buildPostReleaseAuditPlan({
    yoloRoot,
    releaseScope: options.releaseScope || options.release_scope,
  });
  const manualReleaseRecord = options.manualReleaseRecord || options.manual_release_record || null;
  const operatorRunbook = options.operatorRunbook || options.operator_runbook || (options.runOperatorReleaseRunbookGate || runOperatorReleaseRunbookGate)({
    yoloRoot,
    timeout_ms: options.timeout_ms || 120000,
    commandExists: options.commandExists,
    now: options.now,
    random: options.random,
    providerConfigs: options.providerConfigs,
  });
  const hardeningDrill = options.hardeningDrill || options.hardening_drill || (options.runPublicBetaHardeningDrill || runPublicBetaHardeningDrill)({
    yoloRoot,
    timeout_ms: options.timeout_ms || 120000,
    keepWorkspace: options.keepWorkspace === true,
    commandExists: options.commandExists,
    now: options.now,
    random: options.random,
    providerConfigs: options.providerConfigs,
  });
  const postReleaseChecks = options.postReleaseChecks || options.post_release_checks || {};
  const dogfoodAudit = options.dogfoodAudit || options.dogfood_audit || postReleaseChecks.dogfood_audit || null;
  const packageInstallSmokeStatus = packageInstallStatus(postReleaseChecks, hardeningDrill);

  const checks = [
    check(
      "POST_RELEASE_AUDIT_NO_SIDE_EFFECTS",
      plan.writes_workspace === false
        && plan.publishes === false
        && plan.reads_credentials === false
        && plan.spawns_provider === false
        && plan.executes_billable_provider === false
        && plan.publishes_dogfood_report === false,
      "post-release audit gate must not publish, read credentials, execute providers, mutate workspace, or publish dogfood reports",
    ),
    check(
      "POST_RELEASE_AUDIT_RUNBOOK_READY",
      operatorRunbook.status === "ready",
      "operator runbook gate must be ready before trusting manual external release evidence",
      { runbook_status: operatorRunbook.status, runbook_blockers: (operatorRunbook.blockers || []).map((item) => item.code) },
    ),
    check(
      "POST_RELEASE_AUDIT_MANUAL_RECORD_PRESENT",
      isObject(manualReleaseRecord),
      "manual external release record is required",
    ),
    check(
      "POST_RELEASE_AUDIT_EXTERNAL_ONLY",
      isObject(manualReleaseRecord) && manualReleaseExternalOnly(manualReleaseRecord),
      "manual release record must prove publish/token/provider/report actions happened outside the SDK",
    ),
    check(
      "POST_RELEASE_AUDIT_PACKAGE_NAME_MATCH",
      manualReleaseRecord?.package_name === packageJson.name,
      "manual release package_name must match package.json",
      { expected: packageJson.name || null, actual: manualReleaseRecord?.package_name || null },
    ),
    check(
      "POST_RELEASE_AUDIT_PACKAGE_VERSION_MATCH",
      manualReleaseRecord?.package_version === packageJson.version,
      "manual release package_version must match package.json",
      { expected: packageJson.version || null, actual: manualReleaseRecord?.package_version || null },
    ),
    check(
      "POST_RELEASE_AUDIT_OPERATOR_PRESENT",
      nonEmptyString(manualReleaseRecord?.operator),
      "manual release record must name the human operator",
    ),
    check(
      "POST_RELEASE_AUDIT_TIMESTAMP_VALID",
      validTimestamp(manualReleaseRecord?.published_at),
      "manual release record must include a valid published_at timestamp",
    ),
    check(
      "POST_RELEASE_AUDIT_REGISTRY_URL_PRESENT",
      nonEmptyString(manualReleaseRecord?.registry_url || manualReleaseRecord?.npm_package_url),
      "manual release record must include a registry or npm package URL",
    ),
    check(
      "POST_RELEASE_AUDIT_PACKAGE_PUBLIC",
      packageJson.private !== true,
      "post-release audited package must no longer be private",
      { package_private: packageJson.private === true },
    ),
    check(
      "POST_RELEASE_AUDIT_HARDENING_PASS",
      hardeningDrill.status === "pass",
      "post-release hardening drill must pass",
      { hardening_status: hardeningDrill.status, hardening_blockers: (hardeningDrill.blockers || []).map((item) => item.code) },
    ),
    check(
      "POST_RELEASE_AUDIT_HARDENING_NO_RELEASE_SIDE_EFFECTS",
      hardeningNoReleaseSideEffects(hardeningDrill),
      "post-release hardening drill must still prove no SDK publish, credential access, or billable provider execution",
    ),
    check(
      "POST_RELEASE_AUDIT_PACKAGE_INSTALL_PASS",
      packageInstallSmokeStatus === "pass",
      "post-release package install smoke must pass",
      { package_install_status: packageInstallSmokeStatus },
    ),
    check(
      "POST_RELEASE_AUDIT_DOGFOOD_AUDIT_PASS",
      dogfoodAuditApproved(dogfoodAudit),
      "public dogfood audit must pass with evidence, privacy review, and publication approval",
      { dogfood_status: dogfoodAudit?.status || null },
    ),
  ];

  const blockers = checks.filter((item) => item.passed !== true);
  return {
    schema_version: POST_RELEASE_AUDIT_SCHEMA_VERSION,
    schema: "yolo.release.post_release_audit_result.v1",
    status: blockers.length > 0 ? "blocked" : "pass",
    release_scope: plan.release_scope,
    yolo_root: yoloRoot,
    package: {
      name: packageJson.name || null,
      version: packageJson.version || null,
      private: packageJson.private === true,
    },
    plan,
    checks,
    blockers,
    manual_release_record: manualReleaseRecord,
    components: {
      operator_runbook: operatorRunbook,
      hardening_drill: hardeningDrill,
      post_release_checks: postReleaseChecks,
      dogfood_audit: dogfoodAudit,
    },
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      publish_command_executed: false,
      dogfood_report_published: false,
      audited_manual_external_release_only: blockers.length === 0,
    },
    next_actions: blockers.length === 0
      ? [
          "Post-release audit passed. Preserve manual release evidence with the release notes.",
          "Run the stable graduation gate before treating the SDK API as stable.",
        ]
      : [
          "Resolve post-release audit blockers before declaring the external release complete.",
        ],
  };
}
