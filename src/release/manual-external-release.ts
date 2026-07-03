import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  OPERATOR_RELEASE_OPERATIONS,
  runOperatorReleaseRunbookGate,
} from "./operator-runbook.js";
import { runPostReleaseAuditGate } from "./post-release-audit.js";
import { runStableGraduationGate } from "./stable-graduation.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS } from "../lib/toolchain.js";
import type { ReleaseCheck, ReleaseIssue, ReleaseRecord } from "./readiness.js";

export const MANUAL_EXTERNAL_RELEASE_SCHEMA_VERSION = "1.0";

const DEFAULT_RELEASE_SCOPE = "public-stable";
const DEFAULT_REQUESTED_OPERATIONS = [
  "publish_public_beta",
  "access_credentials",
  "billable_provider_execution",
  "public_dogfood_report",
];

export interface PackageJsonLike extends ReleaseRecord {
  name?: string;
  version?: string;
  private?: boolean;
}

export interface ManualCommand extends ReleaseRecord {
  execute?: boolean;
  requires_human?: boolean;
}

export interface ReleaseComponentResult extends ReleaseRecord {
  status?: string;
  blockers?: ReleaseIssue[];
  guarantees?: ReleaseRecord;
  manual_commands?: ManualCommand[];
}

export interface ManualExternalReleasePlan extends ReleaseRecord {
  yolo_root: string;
  release_scope: string;
  requested_operations: string[];
  writes_workspace: boolean;
  publishes: boolean;
  reads_credentials: boolean;
  spawns_provider: boolean;
  executes_billable_provider: boolean;
  publishes_dogfood_report: boolean;
  requires_human_operator: boolean;
  required_evidence: string[];
}

export interface ManualExternalReleaseOptions extends ReleaseRecord {
  yoloRoot?: string;
  cwd?: string;
  packageJson?: PackageJsonLike;
  plan?: ManualExternalReleasePlan;
  releaseScope?: string;
  release_scope?: string;
  requestedOperations?: unknown;
  requested_operations?: unknown;
  manualReleaseRecord?: ReleaseRecord | null;
  manual_release_record?: ReleaseRecord | null;
  credentialEvidence?: ReleaseRecord | null;
  credential_evidence?: ReleaseRecord | null;
  billableProviderEvidence?: ReleaseRecord | null;
  billable_provider_evidence?: ReleaseRecord | null;
  dogfoodPublicationEvidence?: ReleaseRecord | null;
  dogfood_publication_evidence?: ReleaseRecord | null;
  dogfoodAudit?: ReleaseRecord | null;
  dogfood_audit?: ReleaseRecord | null;
  externalRemediationEvidence?: ReleaseRecord | null;
  external_remediation_evidence?: ReleaseRecord | null;
  claudePRemediation?: ReleaseRecord | null;
  claude_p_remediation?: ReleaseRecord | null;
  operatorRunbook?: ReleaseComponentResult;
  operator_runbook?: ReleaseComponentResult;
  postReleaseAudit?: ReleaseComponentResult;
  post_release_audit?: ReleaseComponentResult;
  stableGraduation?: ReleaseComponentResult;
  stable_graduation?: ReleaseComponentResult;
  providerCommand?: string;
  provider_command?: string;
  timeout_ms?: number;
  commandExists?: (command: string) => boolean;
  now?: unknown;
  random?: unknown;
  providerConfigs?: unknown;
  hardeningDrill?: ReleaseComponentResult;
  hardening_drill?: ReleaseComponentResult;
  postReleaseChecks?: ReleaseComponentResult;
  post_release_checks?: ReleaseComponentResult;
  readiness?: ReleaseComponentResult;
  publicBetaReadiness?: ReleaseComponentResult;
  public_beta_readiness?: ReleaseComponentResult;
  stabilityReview?: ReleaseRecord;
  stability_review?: ReleaseRecord;
  runnerRuntimeApiFrozen?: boolean;
  runner_runtime_api_frozen?: boolean;
  rootEntrypointCount?: number;
  root_entrypoint_count?: number;
  maxRootEntrypoints?: number;
  max_root_entrypoints?: number;
  runOperatorReleaseRunbookGate?: (options: ReleaseRecord) => ReleaseComponentResult;
  runPostReleaseAuditGate?: (options: ReleaseRecord) => ReleaseComponentResult;
  runStableGraduationGate?: (options: ReleaseRecord) => ReleaseComponentResult;
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

function normalizeRequestedOperations(input: unknown): string[] {
  const source = Array.isArray(input) && input.length > 0 ? input : DEFAULT_REQUESTED_OPERATIONS;
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
}

function operationRequested(operations: string[], operation: string): boolean {
  return operations.includes(operation);
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

function externalOnly(record: unknown = Object()): boolean {
  const summary = isObject(record) ? record : {};
  return summary.executed_by_sdk !== true
    && summary.published_by_sdk !== true
    && summary.token_read_by_sdk !== true
    && summary.billable_provider_executed_by_sdk !== true
    && summary.dogfood_report_published_by_sdk !== true;
}

function manualCommandsOnly(runbook: ReleaseComponentResult = Object()): boolean {
  const commands = Array.isArray(runbook.manual_commands) ? runbook.manual_commands : [];
  return commands.length > 0
    && commands.every((command) => command.execute === false && command.requires_human === true);
}

function credentialEvidenceApproved(evidence: unknown = Object()): boolean {
  const summary = isObject(evidence) ? evidence : {};
  return summary.status === "pass"
    && nonEmptyString(summary.operator)
    && validTimestamp(summary.executed_at)
    && externalOnly(summary)
    && (summary.token_value_redacted === true || summary.credentials_not_recorded === true)
    && summary.secret_material_recorded !== true
    && !nonEmptyString(summary.token_value)
    && !nonEmptyString(summary.raw_token);
}

function billableProviderEvidenceApproved(evidence: unknown = Object()): boolean {
  const summary = isObject(evidence) ? evidence : {};
  return summary.status === "pass"
    && nonEmptyString(summary.operator)
    && validTimestamp(summary.executed_at)
    && nonEmptyString(summary.provider)
    && nonEmptyString(summary.command)
    && evidencePresent(summary)
    && summary.cost_acknowledged === true
    && externalOnly(summary);
}

function dogfoodPublicationApproved(evidence: unknown = Object()): boolean {
  const summary = isObject(evidence) ? evidence : {};
  return summary.status === "pass"
    && evidencePresent(summary)
    && summary.privacy_reviewed === true
    && summary.publication_approved === true
    && nonEmptyString(summary.approver)
    && nonEmptyString(summary.public_url || summary.report_path || summary.artifact_path)
    && externalOnly(summary);
}

function externalRemediationEvidenceApproved(evidence: unknown = Object()): boolean {
  const summary = isObject(evidence) ? evidence : {};
  return summary.status === "pass"
    && nonEmptyString(summary.operator)
    && validTimestamp(summary.executed_at)
    && evidencePresent(summary)
    && externalOnly(summary)
    && summary.executed_by_yolo_runner !== true
    && summary.yolo_runner_evidence !== true
    && !isObject(summary.runner_evidence)
    && !nonEmptyString(summary.runner_run_id)
    && !nonEmptyString(summary.yolo_run_id);
}

function manualReleaseRecordApproved(record: unknown = Object(), packageJson: PackageJsonLike = Object()): boolean {
  const summary = isObject(record) ? record : {};
  return nonEmptyString(summary.operator)
    && validTimestamp(summary.published_at || summary.executed_at)
    && summary.package_name === packageJson.name
    && summary.package_version === packageJson.version
    && nonEmptyString(summary.registry_url || summary.npm_package_url)
    && externalOnly(summary);
}

function noReleaseSideEffects(result: ReleaseComponentResult = Object()): boolean {
  return result.guarantees?.published === false
    && result.guarantees?.credential_access === false
    && result.guarantees?.provider_execution === false
    && result.guarantees?.billable_provider_execution === false
    && result.guarantees?.publish_command_executed === false
    && result.guarantees?.dogfood_report_published === false;
}

export function buildManualExternalReleasePlan(options: ManualExternalReleaseOptions = Object()): ManualExternalReleasePlan {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const requestedOperations = normalizeRequestedOperations(options.requestedOperations || options.requested_operations);
  return {
    schema_version: MANUAL_EXTERNAL_RELEASE_SCHEMA_VERSION,
    schema: "yolo.release.manual_external_release_plan.v1",
    yolo_root: yoloRoot,
    release_scope: options.releaseScope || options.release_scope || DEFAULT_RELEASE_SCOPE,
    requested_operations: requestedOperations,
    writes_workspace: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    publishes_dogfood_report: false,
    requires_human_operator: true,
    required_evidence: [
      "operator runbook gate ready before external execution",
      "manual external release record matching package name/version and registry URL",
      "credential access evidence is external-only and redacted when credential access is requested",
      "billable provider evidence is external-only, cost acknowledged, and linked when billable execution is requested",
      "public dogfood publication evidence is privacy reviewed, approved, external-only, and linked",
      "post-release audit gate pass",
      "stable graduation gate pass before stable SDK claims",
    ],
    stop_conditions: [
      "any manual command is marked execute=true",
      "publish, credential access, billable provider, or dogfood publication evidence claims SDK execution",
      "credential evidence contains raw token material",
      "post-release audit or stable graduation is blocked",
    ],
  };
}

export function runManualExternalReleaseGate(options: ManualExternalReleaseOptions = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const packageJson: PackageJsonLike = options.packageJson || readJson(join(yoloRoot, "package.json"));
  const plan = options.plan || buildManualExternalReleasePlan({
    yoloRoot,
    releaseScope: options.releaseScope || options.release_scope,
    requestedOperations: options.requestedOperations || options.requested_operations,
  });
  const requestedOperations = normalizeRequestedOperations(plan.requested_operations);
  const knownOperations = new Set(OPERATOR_RELEASE_OPERATIONS);
  const unknownOperations = requestedOperations.filter((operation) => !knownOperations.has(operation));
  const manualReleaseRecord = options.manualReleaseRecord || options.manual_release_record || null;
  const credentialEvidence = options.credentialEvidence || options.credential_evidence || null;
  const billableProviderEvidence = options.billableProviderEvidence || options.billable_provider_evidence || null;
  const dogfoodPublicationEvidence = options.dogfoodPublicationEvidence
    || options.dogfood_publication_evidence
    || options.dogfoodAudit
    || options.dogfood_audit
    || null;
  const externalRemediationEvidence = options.externalRemediationEvidence
    || options.external_remediation_evidence
    || options.claudePRemediation
    || options.claude_p_remediation
    || null;
  const operatorRunbook = (options.operatorRunbook || options.operator_runbook || (options.runOperatorReleaseRunbookGate || runOperatorReleaseRunbookGate)({
    yoloRoot,
    requestedOperations,
    dogfoodReport: dogfoodPublicationEvidence,
    providerCommand: options.providerCommand || options.provider_command,
    timeout_ms: options.timeout_ms || DEFAULT_EXECUTOR_TIMEOUT_MS,
    commandExists: options.commandExists,
    now: options.now,
    random: options.random,
    providerConfigs: options.providerConfigs,
  })) as ReleaseComponentResult;
  const postReleaseAudit = (options.postReleaseAudit || options.post_release_audit || (options.runPostReleaseAuditGate || runPostReleaseAuditGate)({
    yoloRoot,
    packageJson,
    operatorRunbook,
    manualReleaseRecord,
    dogfoodAudit: dogfoodPublicationEvidence,
    hardeningDrill: options.hardeningDrill || options.hardening_drill,
    postReleaseChecks: options.postReleaseChecks || options.post_release_checks,
    timeout_ms: options.timeout_ms || DEFAULT_EXECUTOR_TIMEOUT_MS,
    commandExists: options.commandExists,
    now: options.now,
    random: options.random,
    providerConfigs: options.providerConfigs,
  })) as ReleaseComponentResult;
  const stableGraduation = options.stableGraduation || options.stable_graduation || (options.runStableGraduationGate || runStableGraduationGate)({
    yoloRoot,
    packageJson,
    postReleaseAudit,
    readiness: options.readiness || options.publicBetaReadiness || options.public_beta_readiness,
    stabilityReview: options.stabilityReview || options.stability_review,
    runnerRuntimeApiFrozen: options.runnerRuntimeApiFrozen || options.runner_runtime_api_frozen,
    rootEntrypointCount: options.rootEntrypointCount ?? options.root_entrypoint_count,
    maxRootEntrypoints: options.maxRootEntrypoints || options.max_root_entrypoints,
    timeout_ms: options.timeout_ms || DEFAULT_EXECUTOR_TIMEOUT_MS,
    commandExists: options.commandExists,
    now: options.now,
    random: options.random,
    providerConfigs: options.providerConfigs,
  });

  const publishRequested = operationRequested(requestedOperations, "publish_public_beta");
  const credentialRequested = operationRequested(requestedOperations, "access_credentials");
  const billableRequested = operationRequested(requestedOperations, "billable_provider_execution");
  const dogfoodRequested = operationRequested(requestedOperations, "public_dogfood_report");

  const checks = [
    check(
      "MANUAL_EXTERNAL_RELEASE_NO_SIDE_EFFECTS",
      plan.writes_workspace === false
        && plan.publishes === false
        && plan.reads_credentials === false
        && plan.spawns_provider === false
        && plan.executes_billable_provider === false
        && plan.publishes_dogfood_report === false,
      "manual external release gate must not publish, mutate workspace, read credentials, execute providers, or publish dogfood reports",
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_OPERATIONS_KNOWN",
      unknownOperations.length === 0,
      "requested manual external release operations must be known",
      { unknown_operations: unknownOperations, known_operations: OPERATOR_RELEASE_OPERATIONS },
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_RUNBOOK_READY",
      operatorRunbook.status === "ready",
      "operator runbook must be ready before accepting external execution evidence",
      { runbook_status: operatorRunbook.status, runbook_blockers: (operatorRunbook.blockers || []).map((item) => item.code) },
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_COMMANDS_MANUAL_ONLY",
      manualCommandsOnly(operatorRunbook),
      "operator runbook commands must be manual-only and must not execute inside the SDK",
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_RECORD_PRESENT",
      !publishRequested || isObject(manualReleaseRecord),
      "publish evidence requires a manual external release record",
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_RECORD_APPROVED",
      !publishRequested || manualReleaseRecordApproved(manualReleaseRecord, packageJson),
      "manual release record must match package name/version, include operator/timestamp/registry URL, and prove external-only execution",
      {
        expected_name: packageJson.name || null,
        expected_version: packageJson.version || null,
        actual_name: manualReleaseRecord?.package_name || null,
        actual_version: manualReleaseRecord?.package_version || null,
      },
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_CREDENTIAL_EVIDENCE_PRESENT",
      !credentialRequested || isObject(credentialEvidence),
      "credential access requires external credential evidence",
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_CREDENTIAL_REDACTED",
      !credentialRequested || credentialEvidenceApproved(credentialEvidence),
      "credential evidence must be external-only, timestamped, operator-owned, and redacted with no raw token material",
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_BILLABLE_EVIDENCE_PRESENT",
      !billableRequested || isObject(billableProviderEvidence),
      "billable provider execution requires external billable provider evidence",
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_BILLABLE_APPROVED",
      !billableRequested || billableProviderEvidenceApproved(billableProviderEvidence),
      "billable provider evidence must pass, be external-only, cost acknowledged, and linked to evidence",
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_DOGFOOD_EVIDENCE_PRESENT",
      !dogfoodRequested || isObject(dogfoodPublicationEvidence),
      "public dogfood publication requires dogfood evidence",
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_DOGFOOD_APPROVED",
      !dogfoodRequested || dogfoodPublicationApproved(dogfoodPublicationEvidence),
      "dogfood publication evidence must pass, be privacy reviewed, approved, linked, and external-only",
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_EXTERNAL_REMEDIATION_SEPARATE",
      !externalRemediationEvidence || externalRemediationEvidenceApproved(externalRemediationEvidence),
      "external remediation evidence must be external-only and must not be mixed with YOLO runner evidence",
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_POST_RELEASE_AUDIT_PASS",
      postReleaseAudit.status === "pass",
      "post-release audit must pass after manual external execution",
      { post_release_status: postReleaseAudit.status, post_release_blockers: (postReleaseAudit.blockers || []).map((item) => item.code) },
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_POST_RELEASE_NO_SIDE_EFFECTS",
      noReleaseSideEffects(postReleaseAudit),
      "post-release audit must prove the SDK did not publish, read credentials, execute providers, or publish reports",
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_STABLE_GRADUATION_PASS",
      stableGraduation.status === "pass",
      "stable graduation must pass before treating the external release as a stable SDK release",
      { stable_status: stableGraduation.status, stable_blockers: (stableGraduation.blockers || []).map((item) => item.code) },
    ),
    check(
      "MANUAL_EXTERNAL_RELEASE_STABLE_NO_SIDE_EFFECTS",
      noReleaseSideEffects(stableGraduation),
      "stable graduation must prove the SDK did not publish, read credentials, execute providers, or publish reports",
    ),
  ];

  const blockers = checks.filter((item) => item.passed !== true);
  const externalEvidence = {
    manual_release_record: manualReleaseRecord,
    credential_evidence: credentialEvidence,
    billable_provider_evidence: billableProviderEvidence,
    dogfood_publication_evidence: dogfoodPublicationEvidence,
    external_remediation_evidence: externalRemediationEvidence,
  };
  const runnerEvidence = {
    operator_runbook: operatorRunbook,
    post_release_audit: postReleaseAudit,
    stable_graduation: stableGraduation,
  };
  return {
    schema_version: MANUAL_EXTERNAL_RELEASE_SCHEMA_VERSION,
    schema: "yolo.release.manual_external_release_result.v1",
    status: blockers.length > 0 ? "blocked" : "pass",
    release_scope: plan.release_scope,
    yolo_root: yoloRoot,
    package: {
      name: packageJson.name || null,
      version: packageJson.version || null,
      private: packageJson.private === true,
    },
    requested_operations: requestedOperations,
    plan,
    checks,
    blockers,
    evidence: externalEvidence,
    external_evidence: externalEvidence,
    runner_evidence: runnerEvidence,
    components: {
      operator_runbook: operatorRunbook,
      post_release_audit: postReleaseAudit,
      stable_graduation: stableGraduation,
    },
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      publish_command_executed: false,
      dogfood_report_published: false,
      audited_manual_external_release_only: blockers.length === 0,
      stable_release_verified: blockers.length === 0,
    },
    next_actions: blockers.length === 0
      ? [
          "Manual external release evidence is complete. Preserve the P11 evidence bundle with release notes.",
          "Keep publish, credential, billable provider, and public report actions outside SDK automation.",
        ]
      : [
          "Resolve manual external release evidence blockers before declaring the public release complete.",
        ],
  };
}
