import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DOGFOOD_MATRIX_SCENARIO_IDS, listDogfoodMatrixScenarios } from "./dogfood-matrix.js";
import { runPublicBetaHardeningDrill } from "./hardening-drill.js";
import { verifyArtifactIntegrity } from "../runtime/evidence/artifact-integrity.js";

export const CONTROLLED_BETA_RELEASE_DECISION_SCHEMA_VERSION = "1.0";

export const CONTROLLED_BETA_RELEASE_ACTIONS = Object.freeze([
  "remove_private",
  "publish_public_beta",
  "access_credentials",
  "billable_provider_execution",
]);

export const RELEASE_CANDIDATE_GATE_SCHEMA_VERSION = "1.0";

export const RELEASE_CANDIDATE_REQUIRED_REPORTS = Object.freeze([
  "verify",
  "prdPreflight",
  "review",
  "acceptance",
  "delivery",
  "cleanEnvironment",
  "dogfoodMatrix",
  "changeManifest",
]);

const RELEASE_CANDIDATE_REPORT_ALIASES = Object.freeze({
  verify: ["verify", "verifyResult", "verify_result"],
  prdPreflight: ["prdPreflight", "prd_preflight", "prdPreflightResult", "prd_preflight_result"],
  review: ["review", "reviewReport", "review_report", "reviewResult", "review_result"],
  acceptance: ["acceptance", "acceptanceReport", "acceptance_report", "acceptanceResult", "acceptance_result"],
  delivery: ["delivery", "deliveryReport", "delivery_report", "deliveryResult", "delivery_result"],
  cleanEnvironment: ["cleanEnvironment", "clean_environment", "cleanEnvironmentResult", "clean_environment_result"],
  dogfoodMatrix: ["dogfoodMatrix", "dogfood_matrix", "dogfoodMatrixResult", "dogfood_matrix_result"],
  changeManifest: ["changeManifest", "change_manifest", "changeManifestResult", "change_manifest_result"],
});

const RELEASE_CANDIDATE_PASS_STATUSES = new Set(["pass", "passed", "ok", "success"]);
const RELEASE_CANDIDATE_BLOCK_STATUSES = new Set(["block", "blocked", "fail", "failed", "error"]);
const RELEASE_CANDIDATE_KNOWN_PROVENANCE = new Set([
  "release",
  "ci",
  "local",
  "verify",
  "prd-preflight",
  "review",
  "review-fix",
  "acceptance",
  "delivery",
  "clean-environment",
  "dogfood-matrix",
  "change-manifest",
  "human-review",
  "external",
]);
const CLEAN_ENVIRONMENT_REQUIRED_STEPS = [
  "prepare_clean_source",
  "install_dependencies",
  "verify",
  "pack",
  "install_tarball",
  "public_entrypoint_bin_smoke",
];
const DOGFOOD_EXPECTED_OUTCOME_BY_ID = new Map(
  listDogfoodMatrixScenarios().map((scenario) => [scenario.id, scenario.expected?.outcome || "pass"])
);

const DEFAULT_RELEASE_SCOPE = "public-beta";
const DEFAULT_REQUESTED_ACTIONS = ["remove_private", "publish_public_beta"];
const PRIVATE_RELEASE_BLOCKER = "PACKAGE_PRIVATE_RELEASE_BLOCK";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function check(code, passed, message, extra = Object()) {
  return { code, passed, message, ...extra };
}

function normalizeRequestedActions(input) {
  const source = Array.isArray(input) && input.length > 0 ? input : DEFAULT_REQUESTED_ACTIONS;
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanIssueCode(value, fallback) {
  return String(value || fallback || "")
    .trim()
    .replace(/[^A-Z0-9_.:-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function issue(code, report, message, extra = Object()) {
  return { code, report, message, ...extra };
}

function normalizeReleaseCandidateMode(value) {
  return value === "publish" ? "publish" : "rc";
}

function getAliasedReport(source, reportName) {
  for (const key of RELEASE_CANDIDATE_REPORT_ALIASES[reportName] || [reportName]) {
    if (Object.hasOwn(source, key)) {
      return source[key];
    }
  }
  return undefined;
}

function normalizeReportStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (RELEASE_CANDIDATE_PASS_STATUSES.has(value)) return "pass";
  if (RELEASE_CANDIDATE_BLOCK_STATUSES.has(value)) return "block";
  return null;
}

function provenanceSource(report) {
  const provenance = report?.provenance;
  if (typeof provenance === "string") return provenance.trim().toLowerCase();
  if (!isObject(provenance)) return "";
  return String(provenance.source || provenance.kind || provenance.system || provenance.tool || "").trim().toLowerCase();
}

function provenanceId(report) {
  const provenance = report?.provenance;
  if (isObject(provenance)) {
    return String(provenance.id || provenance.run_id || provenance.runId || provenance.artifact_id || "").trim();
  }
  return String(report?.run_id || report?.runId || report?.artifact_id || "").trim();
}

function reportArtifactPaths(report = Object()) {
  const provenance = report.provenance;
  return [
    report.artifact_path,
    report.artifactPath,
    report.report_path,
    report.reportPath,
    report.evidence_file,
    ...(Array.isArray(report.artifacts) ? report.artifacts : []),
    ...(isObject(provenance) ? [
      provenance.artifact_path,
      provenance.artifactPath,
      provenance.report_path,
      provenance.reportPath,
      provenance.evidence_file,
    ] : []),
  ].map((item) => String(item || "").trim()).filter(Boolean);
}

function reportExpectedDigests(report = Object()) {
  const expected = {
    ...(isObject(report.artifact_digests) ? report.artifact_digests : {}),
    ...(isObject(report.artifactDigests) ? report.artifactDigests : {}),
    ...(isObject(report.expected_artifact_digests) ? report.expected_artifact_digests : {}),
    ...(isObject(report.expectedArtifactDigests) ? report.expectedArtifactDigests : {}),
  };
  const path = report.artifact_path || report.artifactPath || report.report_path || report.reportPath;
  const digest = report.artifact_sha256 || report.artifactSha256 || report.sha256;
  if (path && digest) expected[path] = digest;
  return expected;
}

function provenanceKnown(report) {
  const provenance = report?.provenance;
  if (!isObject(report) || provenance === "unknown" || provenance === null || provenance === undefined) {
    return false;
  }
  if (isObject(provenance) && provenance.trusted === false) {
    return false;
  }
  const source = provenanceSource(report);
  return RELEASE_CANDIDATE_KNOWN_PROVENANCE.has(source);
}

function approvalIssueCodes(approval = Object()) {
  const source = Array.isArray(approval.issue_codes)
    ? approval.issue_codes
    : Array.isArray(approval.issueCodes)
      ? approval.issueCodes
      : Array.isArray(approval.codes)
        ? approval.codes
        : [];
  return source.map((code) => cleanIssueCode(code, "")).filter(Boolean);
}

function approvalId(approval = Object()) {
  return String(approval.id || approval.approval_id || "").trim();
}

function approvalApprovedAt(approval = Object()) {
  return approval.approved_at || approval.approvedAt || null;
}

function approvalExpiresAt(approval = Object()) {
  return approval.expires_at || approval.expiresAt || approval.valid_until || approval.validUntil || null;
}

function approvalHasValidExpiry(approval = Object()) {
  return validTimestamp(approvalExpiresAt(approval));
}

function approvalExpired(approval, now) {
  const expiresAt = approvalExpiresAt(approval);
  return validTimestamp(expiresAt) && Date.parse(expiresAt) <= now.getTime();
}

function approvalValidForIssue(approval, issueCode, now) {
  return isObject(approval)
    && nonEmptyString(approvalId(approval))
    && nonEmptyString(approval.approved_by || approval.approvedBy)
    && validTimestamp(approvalApprovedAt(approval))
    && approvalHasValidExpiry(approval)
    && approvalIssueCodes(approval).includes(issueCode)
    && !approvalExpired(approval, now);
}

function warningIssueCode(warning, reportName, index) {
  return cleanIssueCode(
    isObject(warning) ? warning.code || warning.issue_code || warning.issueCode : warning,
    `${reportName}_WARNING_${index + 1}`,
  );
}

function warningHasApproval(warning, approvals, issueCode, now) {
  if (isObject(warning) && isObject(warning.approval) && approvalValidForIssue(warning.approval, issueCode, now)) {
    return true;
  }
  const requestedApprovalId = isObject(warning) ? warning.approval_id || warning.approvalId : null;
  return approvals.some((approval) =>
    approvalValidForIssue(approval, issueCode, now)
    && (!requestedApprovalId || approvalId(approval) === requestedApprovalId)
  );
}

function collectReportBlockerIssues(reportName, report) {
  return asArray(report.blockers).map((blocker, index) => issue(
    "RC_GATE_REPORT_BLOCKER",
    reportName,
    isObject(blocker) && blocker.message ? blocker.message : "release candidate input report contains a blocker",
    {
      issue_code: cleanIssueCode(isObject(blocker) ? blocker.code || blocker.issue_code : blocker, `${reportName}_BLOCKER_${index + 1}`),
    },
  ));
}

function reportClaimsDryRun(report = Object()) {
  return report.dry_run === true
    || report.dryRun === true
    || report.plan_only === true
    || (isObject(report.dry_run) && report.dry_run.dry_run === true)
    || (isObject(report.dryRun) && report.dryRun.dry_run === true);
}

function commandPassed(record) {
  if (!isObject(record)) return false;
  const status = normalizeReportStatus(record.status);
  return status === "pass" || record.exit_code === 0 || record.exitCode === 0;
}

function collectCommandEvidence(report = Object()) {
  const commands = [];
  for (const record of asArray(report.commands || report.command_results || report.commandResults)) {
    if (isObject(record)) commands.push(record);
  }
  if (isObject(report.command)) commands.push(report.command);
  if (nonEmptyString(report.command) && (report.exit_code !== undefined || report.exitCode !== undefined || report.status)) {
    commands.push({ command: report.command, exit_code: report.exit_code ?? report.exitCode, status: report.status });
  }
  for (const stepRecord of asArray(report.steps)) {
    if (isObject(stepRecord?.command)) commands.push(stepRecord.command);
  }
  return commands;
}

function hasPassingCommandEvidence(report = Object()) {
  const commands = collectCommandEvidence(report);
  return commands.length > 0 && commands.every(commandPassed);
}

function stepPassed(stepRecord) {
  if (!isObject(stepRecord)) return false;
  const status = normalizeReportStatus(stepRecord.status);
  return status === "pass" || commandPassed(stepRecord.command);
}

function cleanEnvironmentEvidencePasses(report = Object()) {
  const steps = asArray(report.steps);
  const byId = new Map(steps.map((stepRecord) => [stepRecord?.id, stepRecord]));
  return report.dry_run === false
    && nonEmptyString(report.tarball || report.package_tarball || report.packageTarball)
    && CLEAN_ENVIRONMENT_REQUIRED_STEPS.every((stepId) => stepPassed(byId.get(stepId)));
}

function scenarioId(scenario, index) {
  return scenario?.id || scenario?.scenario || scenario?.name || `scenario-${index + 1}`;
}

function scenarioExpectedOutcome(scenario) {
  if (scenario?.expected_outcome) return scenario.expected_outcome;
  if (typeof scenario?.expected === "string") return scenario.expected;
  if (isObject(scenario?.expected) && scenario.expected.outcome) return scenario.expected.outcome;
  return DOGFOOD_EXPECTED_OUTCOME_BY_ID.get(scenarioId(scenario, 0)) || "pass";
}

function failClosedStatus(value) {
  return ["blocked", "block", "fail", "failed", "fail_closed"].includes(String(value || "").trim().toLowerCase());
}

function dogfoodMatrixCompletenessIssues(report) {
  const scenarios = asArray(report.scenarios || report.results || report.entries);
  const ids = scenarios.map((scenario, index) => scenarioId(scenario, index));
  const uniqueIds = new Set(ids);
  const missing = DOGFOOD_MATRIX_SCENARIO_IDS.filter((id) => !uniqueIds.has(id));
  const unexpected = ids.filter((id) => !DOGFOOD_MATRIX_SCENARIO_IDS.includes(id));
  const countMismatch = report.scenario_count !== undefined && Number(report.scenario_count) !== DOGFOOD_MATRIX_SCENARIO_IDS.length;
  if (missing.length === 0 && unexpected.length === 0 && !countMismatch && uniqueIds.size === DOGFOOD_MATRIX_SCENARIO_IDS.length) {
    return [];
  }
  return [issue(
    "RC_GATE_DOGFOOD_MATRIX_INCOMPLETE",
    "dogfoodMatrix",
    "dogfood matrix must include every generic scenario exactly once",
    {
      required_scenarios: DOGFOOD_MATRIX_SCENARIO_IDS,
      present_scenarios: ids,
      missing_scenarios: missing,
      unexpected_scenarios: unexpected,
      scenario_count: report.scenario_count ?? scenarios.length,
    },
  )];
}

function dogfoodFailureIssues(report) {
  const scenarios = asArray(report.scenarios || report.results || report.entries);
  return scenarios
    .map((scenario, index) => ({
      scenario,
      index,
      status: normalizeReportStatus(scenario?.status),
      id: scenarioId(scenario, index),
      expected_fail_closed: scenarioExpectedOutcome(scenario) === "fail_closed",
    }))
    .filter(({ scenario, status, expected_fail_closed: expectedFailClosed, id }) =>
      status !== "pass"
      && !(expectedFailClosed && DOGFOOD_EXPECTED_OUTCOME_BY_ID.get(id) === "fail_closed" && failClosedStatus(scenario?.status))
    )
    .map(({ scenario, index, id }) => issue(
      "RC_GATE_DOGFOOD_FAILURE",
      "dogfoodMatrix",
      "dogfood matrix scenarios must all pass",
      {
        scenario_id: id || `scenario-${index + 1}`,
        scenario_status: scenario?.status || null,
      },
    ));
}

function changeManifestEvidencePasses(report = Object()) {
  const manifest = report.manifest || report.change_manifest || report.changeManifest;
  return isObject(manifest)
    && manifest.schema === "yolo.release_change_provenance.v1"
    && normalizeReportStatus(manifest.status) === "pass"
    && Array.isArray(manifest.blockers)
    && manifest.blockers.length === 0
    && isObject(manifest.generated_from);
}

function releaseCandidateEvidenceIssues(reportName, report) {
  const evidenceIssues = [];
  if (reportClaimsDryRun(report)) {
    evidenceIssues.push(issue(
      "RC_GATE_REPORT_DRY_RUN",
      reportName,
      "release candidate gate reports must be executed evidence, not dry-run plans",
    ));
  }
  if (!nonEmptyString(provenanceId(report))) {
    evidenceIssues.push(issue(
      "RC_GATE_PROVENANCE_ID_MISSING",
      reportName,
      "release candidate gate report provenance must include a run, artifact, or evidence id",
    ));
  }

  if (reportName === "verify" || reportName === "prdPreflight") {
    if (!hasPassingCommandEvidence(report)) {
      evidenceIssues.push(issue(
        "RC_GATE_REPORT_EXECUTION_EVIDENCE_MISSING",
        reportName,
        "verify and PRD preflight reports must include passing command evidence",
      ));
    }
  }
  if (reportName === "cleanEnvironment" && !cleanEnvironmentEvidencePasses(report)) {
    evidenceIssues.push(issue(
      "RC_GATE_CLEAN_ENVIRONMENT_EVIDENCE_MISSING",
      reportName,
      "clean environment verification must include all required passing steps and a tarball",
    ));
  }
  if (reportName === "dogfoodMatrix") {
    evidenceIssues.push(...dogfoodMatrixCompletenessIssues(report));
  }
  if (reportName === "changeManifest" && !changeManifestEvidencePasses(report)) {
    evidenceIssues.push(issue(
      "RC_GATE_CHANGE_MANIFEST_EVIDENCE_MISSING",
      reportName,
      "change manifest report must include a passing release change provenance manifest",
    ));
  }
  return evidenceIssues;
}

function releaseCandidateArtifactIssues(reportName, report, options = Object()) {
  const paths = reportArtifactPaths(report);
  if (paths.length === 0) {
    return {
      integrity: {
        status: "fail",
        checked_count: 0,
        artifacts: [],
        missing: [],
        digest_mismatches: [],
      },
      issues: [issue(
        "RC_GATE_ARTIFACT_MISSING",
        reportName,
        "release candidate gate reports must include a real artifact path for existence and digest verification",
      )],
    };
  }
  const integrity = verifyArtifactIntegrity(paths, {
    rootDir: options.artifactRoot || options.artifact_root || options.cwd || process.cwd(),
    expectedSha256ByPath: reportExpectedDigests(report),
  });
  const issues = [
    ...integrity.missing.map((artifact) => issue(
      "RC_GATE_ARTIFACT_MISSING",
      reportName,
      "release candidate gate report artifact path does not exist on disk",
      { artifact_path: artifact.absolute_path },
    )),
    ...integrity.digest_mismatches.map((artifact) => issue(
      "RC_GATE_ARTIFACT_DIGEST_MISMATCH",
      reportName,
      "release candidate gate report artifact digest does not match the expected sha256",
      {
        artifact_path: artifact.absolute_path,
        expected_sha256: artifact.expected_sha256,
        actual_sha256: artifact.sha256,
      },
    )),
  ];
  return { integrity, issues };
}

function validateApprovals(reportName, approvals, now) {
  const approvalIssues = [];
  for (const approval of approvals) {
    if (!isObject(approval)
      || !nonEmptyString(approvalId(approval))
      || !nonEmptyString(approval.approved_by || approval.approvedBy)
      || !validTimestamp(approvalApprovedAt(approval))
      || approvalIssueCodes(approval).length === 0) {
      approvalIssues.push(issue(
        "RC_GATE_APPROVAL_UNBOUND",
        reportName,
        "approval records must bind to one or more machine-readable issue codes",
        { approval_id: isObject(approval) ? approvalId(approval) || null : null },
      ));
      continue;
    }
    if (approvalExpired(approval, now)) {
      approvalIssues.push(issue(
        "RC_GATE_APPROVAL_EXPIRED",
        reportName,
        "approval record is expired",
        { approval_id: approvalId(approval), expires_at: approvalExpiresAt(approval) },
      ));
    }
    if (!approvalHasValidExpiry(approval)) {
      approvalIssues.push(issue(
        "RC_GATE_APPROVAL_EXPIRY_REQUIRED",
        reportName,
        "approval records must include a valid future expires_at or valid_until timestamp",
        { approval_id: approvalId(approval) },
      ));
    }
  }
  return approvalIssues;
}

function actionApproved(decision, action) {
  const approvals = isObject(decision?.approvals) ? decision.approvals : {};
  const approvedActions = Array.isArray(decision?.approved_actions)
    ? decision.approved_actions
    : Array.isArray(decision?.actions)
      ? decision.actions
      : [];
  return approvals[action] === true || approvedActions.includes(action);
}

function riskAccepted(decision) {
  return decision?.risk_acceptance === true
    || (Array.isArray(decision?.risk_acceptance) && decision.risk_acceptance.length > 0);
}

function hardeningReleaseBlockerCodes(hardeningDrill = Object()) {
  return (hardeningDrill.release_blockers || []).map((blocker) => blocker.code).filter(Boolean);
}

function sanitizeDecision(decision) {
  if (!isObject(decision)) {
    return null;
  }
  return {
    approved: decision.approved === true,
    approver: decision.approver || null,
    approved_at: decision.approved_at || null,
    scope: decision.scope || decision.release_scope || null,
    package_version: decision.package_version || decision.version || null,
    approved_actions: Array.isArray(decision.approved_actions)
      ? decision.approved_actions
      : Array.isArray(decision.actions)
        ? decision.actions
        : [],
    risk_acceptance: decision.risk_acceptance === true
      ? true
      : Array.isArray(decision.risk_acceptance)
        ? decision.risk_acceptance
        : null,
    hardening_drill_reviewed: decision.hardening_drill_reviewed === true,
    private_blocker_acknowledged: decision.private_blocker_acknowledged === true,
  };
}

export function buildControlledBetaReleaseDecisionPlan(options = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const releaseScope = options.releaseScope || options.release_scope || DEFAULT_RELEASE_SCOPE;
  const requestedActions = normalizeRequestedActions(options.requestedActions || options.requested_actions);
  return {
    schema_version: CONTROLLED_BETA_RELEASE_DECISION_SCHEMA_VERSION,
    schema: "yolo.release.controlled_beta_release_decision_gate.v1",
    yolo_root: yoloRoot,
    release_scope: releaseScope,
    requested_actions: requestedActions,
    writes_workspace: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    required_decision_fields: [
      "approved",
      "approver",
      "approved_at",
      "scope",
      "package_version",
      "approved_actions",
      "risk_acceptance",
      "hardening_drill_reviewed",
      "private_blocker_acknowledged",
    ],
    required_checks: [
      "P5 hardening drill must pass.",
      "`private:true` may only be removed after a human decision record acknowledges the private release blocker.",
      "Every requested release action must be explicitly approved in `approved_actions` or `approvals`.",
      "This gate never publishes, edits package.json, reads credentials, or executes model providers.",
    ],
    stop_conditions: [
      "hardening drill failed",
      "release blockers other than PACKAGE_PRIVATE_RELEASE_BLOCK are present",
      "human decision record is missing, stale, unsigned, or action-incomplete",
      "credential or billable provider actions are requested without explicit approval",
    ],
  };
}

export function runControlledBetaReleaseDecisionGate(options = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const packageJsonPath = join(yoloRoot, "package.json");
  const packageBefore = readJson(packageJsonPath);
  const plan = options.plan || buildControlledBetaReleaseDecisionPlan({
    yoloRoot,
    releaseScope: options.releaseScope || options.release_scope,
    requestedActions: options.requestedActions || options.requested_actions,
  });
  const requestedActions = normalizeRequestedActions(plan.requested_actions);
  const knownActions = new Set(CONTROLLED_BETA_RELEASE_ACTIONS);
  const unknownActions = requestedActions.filter((action) => !knownActions.has(action));
  const decision = options.decision || null;
  const releaseScope = plan.release_scope || DEFAULT_RELEASE_SCOPE;
  const hardeningDrill = options.hardeningDrill || (options.runPublicBetaHardeningDrill || runPublicBetaHardeningDrill)({
    yoloRoot,
    timeout_ms: options.timeout_ms || 120000,
    keepWorkspace: options.keepWorkspace === true,
    commandExists: options.commandExists,
    now: options.now,
    random: options.random,
    providerConfigs: options.providerConfigs,
  });
  const packageAfter = readJson(packageJsonPath);
  const releaseBlockerCodes = hardeningReleaseBlockerCodes(hardeningDrill);
  const nonPrivateReleaseBlockers = releaseBlockerCodes.filter((code) => code !== PRIVATE_RELEASE_BLOCKER);
  const hasPrivateReleaseBlocker = releaseBlockerCodes.includes(PRIVATE_RELEASE_BLOCKER);
  const packageVersion = packageBefore.version || null;
  const decisionScope = decision?.scope || decision?.release_scope || null;
  const decisionVersion = decision?.package_version || decision?.version || null;
  const requestedCredentials = requestedActions.includes("access_credentials");
  const requestedBillable = requestedActions.includes("billable_provider_execution");
  const allRequestedActionsApproved = unknownActions.length === 0
    && requestedActions.every((action) => actionApproved(decision, action));

  const checks = [
    check(
      "DECISION_GATE_NO_SIDE_EFFECTS",
      plan.publishes === false && plan.writes_workspace === false && plan.reads_credentials === false && plan.spawns_provider === false,
      "controlled beta release decision gate must be a no-publish/no-credential/no-provider decision record",
    ),
    check(
      "DECISION_GATE_PRIVATE_FIELD_UNCHANGED",
      packageBefore.private === packageAfter.private,
      "decision gate must not mutate package.json private field",
      { before: packageBefore.private === true, after: packageAfter.private === true },
    ),
    check(
      "DECISION_GATE_REQUESTED_ACTIONS_KNOWN",
      unknownActions.length === 0,
      "requested release actions must be known controlled-beta actions",
      { unknown_actions: unknownActions, known_actions: CONTROLLED_BETA_RELEASE_ACTIONS },
    ),
    check(
      "DECISION_GATE_HARDENING_DRILL_PASS",
      hardeningDrill.status === "pass",
      "P5 public beta hardening drill must pass before any release decision can be ready",
      { hardening_status: hardeningDrill.status, hardening_blockers: (hardeningDrill.blockers || []).map((item) => item.code) },
    ),
    check(
      "DECISION_GATE_RELEASE_BLOCKERS_PRIVATE_ONLY",
      nonPrivateReleaseBlockers.length === 0,
      "release readiness may only be blocked by PACKAGE_PRIVATE_RELEASE_BLOCK at this decision point",
      { release_blockers: releaseBlockerCodes },
    ),
    check(
      "DECISION_GATE_HUMAN_DECISION_PRESENT",
      isObject(decision),
      "a human release decision record is required before controlled beta release actions are authorized",
    ),
    check(
      "DECISION_GATE_HUMAN_APPROVED",
      decision?.approved === true,
      "human release decision must set approved=true",
    ),
    check(
      "DECISION_GATE_APPROVER_PRESENT",
      nonEmptyString(decision?.approver),
      "human release decision must name the approver",
    ),
    check(
      "DECISION_GATE_TIMESTAMP_VALID",
      validTimestamp(decision?.approved_at),
      "human release decision must include a valid approved_at timestamp",
    ),
    check(
      "DECISION_GATE_SCOPE_MATCH",
      decisionScope === releaseScope,
      "human release decision scope must match the requested release scope",
      { expected_scope: releaseScope, decision_scope: decisionScope },
    ),
    check(
      "DECISION_GATE_VERSION_MATCH",
      decisionVersion === packageVersion,
      "human release decision package_version must match package.json version",
      { expected_version: packageVersion, decision_version: decisionVersion },
    ),
    check(
      "DECISION_GATE_HARDENING_REVIEWED",
      decision?.hardening_drill_reviewed === true,
      "human release decision must acknowledge reviewing the passing hardening drill",
    ),
    check(
      "DECISION_GATE_RISK_ACCEPTED",
      riskAccepted(decision),
      "human release decision must explicitly accept public beta residual risk",
    ),
    check(
      "DECISION_GATE_PRIVATE_BLOCKER_ACKNOWLEDGED",
      !hasPrivateReleaseBlocker || decision?.private_blocker_acknowledged === true,
      "human release decision must acknowledge that private=true is the intentional remaining release blocker",
      { private_release_blocker_present: hasPrivateReleaseBlocker },
    ),
    check(
      "DECISION_GATE_ACTIONS_APPROVED",
      allRequestedActionsApproved,
      "every requested controlled beta release action must be explicitly approved",
      { requested_actions: requestedActions },
    ),
    check(
      "DECISION_GATE_CREDENTIAL_ACTION_EXPLICIT",
      !requestedCredentials || actionApproved(decision, "access_credentials"),
      "credential access cannot be requested without explicit human approval",
    ),
    check(
      "DECISION_GATE_BILLABLE_ACTION_EXPLICIT",
      !requestedBillable || actionApproved(decision, "billable_provider_execution"),
      "billable provider execution cannot be requested without explicit human approval",
    ),
  ];

  const blockers = checks.filter((item) => item.passed !== true);
  const ready = blockers.length === 0;
  return {
    schema_version: CONTROLLED_BETA_RELEASE_DECISION_SCHEMA_VERSION,
    schema: "yolo.release.controlled_beta_release_decision_gate_result.v1",
    status: ready ? "ready" : "blocked",
    release_scope: releaseScope,
    yolo_root: yoloRoot,
    requested_actions: requestedActions,
    approved_actions: ready ? requestedActions : [],
    action_authorization: Object.fromEntries(
      CONTROLLED_BETA_RELEASE_ACTIONS.map((action) => [action, ready && requestedActions.includes(action)])
    ),
    plan,
    checks,
    blockers,
    decision: sanitizeDecision(decision),
    release_blockers: hardeningDrill.release_blockers || [],
    components: {
      hardening_drill: hardeningDrill,
    },
    guarantees: {
      published: false,
      package_private_unchanged: packageBefore.private === packageAfter.private,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
    },
    next_actions: ready
      ? [
          "Gate is ready for a human operator to make the approved package/private/publish changes outside this SDK function.",
          "Run the hardening drill and full test suite again after any release-state mutation.",
        ]
      : [
          "Resolve decision gate blockers before changing private=true, publishing, touching credentials, or running billable providers.",
        ],
  };
}

export function runReleaseCandidateGate(options = Object()) {
  const mode = normalizeReleaseCandidateMode(options.mode || options.releaseMode || options.release_mode);
  const now = options.now ? new Date(options.now) : new Date();
  const reportSource = isObject(options.reports) ? options.reports : options;
  const blockers = [];
  const warnings = [];
  const normalizedReports = Object();

  if (!["rc", "publish"].includes(String(options.mode || options.releaseMode || options.release_mode || "rc"))) {
    blockers.push(issue(
      "RC_GATE_MODE_INVALID",
      "releaseCandidateGate",
      "release candidate gate mode must be rc or publish",
      { mode: options.mode || options.releaseMode || options.release_mode },
    ));
  }

  for (const reportName of RELEASE_CANDIDATE_REQUIRED_REPORTS) {
    const report = getAliasedReport(reportSource, reportName);
    if (report === undefined || report === null) {
      blockers.push(issue(
        "RC_GATE_REPORT_MISSING",
        reportName,
        "required release candidate gate report is missing",
      ));
      continue;
    }

    if (!isObject(report)) {
      blockers.push(issue(
        "RC_GATE_REPORT_MALFORMED",
        reportName,
        "required release candidate gate report must be an object",
      ));
      continue;
    }

    const status = normalizeReportStatus(report.status);
    const reportMalformed = [];
    if (!status) {
      reportMalformed.push("status must be one of pass, block, blocked, fail, failed, or error");
    }
    for (const field of ["blockers", "warnings", "approvals", "findings", "scenarios", "results", "entries"]) {
      if (report[field] !== undefined && !Array.isArray(report[field])) {
        reportMalformed.push(`${field} must be an array when present`);
      }
    }
    if (reportMalformed.length > 0) {
      blockers.push(issue(
        "RC_GATE_REPORT_MALFORMED",
        reportName,
        "release candidate gate report is malformed",
        { errors: reportMalformed },
      ));
    }

    if (!provenanceKnown(report)) {
      blockers.push(issue(
        "RC_GATE_UNKNOWN_PROVENANCE",
        reportName,
        "release candidate gate report provenance is missing, unknown, or untrusted",
        { provenance: report.provenance || null },
      ));
    }
    blockers.push(...releaseCandidateEvidenceIssues(reportName, report));
    const artifactIntegrity = releaseCandidateArtifactIssues(reportName, report, options);
    blockers.push(...artifactIntegrity.issues);

    const reportBlockers = Array.isArray(report.blockers) ? report.blockers : [];
    const reportWarnings = Array.isArray(report.warnings) ? report.warnings : [];
    const reportApprovals = Array.isArray(report.approvals) ? report.approvals : [];
    const normalizedWarnings = reportWarnings.map((warning, index) => {
      const issueCode = warningIssueCode(warning, reportName, index);
      return {
        report: reportName,
        issue_code: issueCode,
        code: isObject(warning) ? warning.code || warning.issue_code || warning.issueCode || issueCode : issueCode,
        message: isObject(warning) && warning.message ? warning.message : "release candidate gate warning",
        approval_id: isObject(warning) ? warning.approval_id || warning.approvalId || warning.approval?.id || null : null,
        approved: warningHasApproval(warning, reportApprovals, issueCode, now),
      };
    });

    normalizedReports[reportName] = {
      status: status || "malformed",
      provenance: report.provenance,
      blocker_count: reportBlockers.length,
      warning_count: normalizedWarnings.length,
      approval_count: reportApprovals.length,
      artifact_integrity: artifactIntegrity.integrity,
    };
    warnings.push(...normalizedWarnings);
    blockers.push(...validateApprovals(reportName, reportApprovals, now));

    if (status === "block") {
      blockers.push(issue(
        "RC_GATE_REPORT_BLOCKED",
        reportName,
        "release candidate gate input report did not pass",
        { report_status: report.status },
      ));
    }
    blockers.push(...collectReportBlockerIssues(reportName, report));

    if (reportName === "dogfoodMatrix") {
      blockers.push(...dogfoodFailureIssues(report));
    }
  }

  for (const warning of warnings) {
    if (warning.approved !== true) {
      blockers.push(issue(
        "RC_GATE_WARNING_APPROVAL_REQUIRED",
        warning.report,
        "release candidate gates require every warning to be bound to a valid current approval",
        { issue_code: warning.issue_code, mode },
      ));
    }
  }

  const status = blockers.length > 0 ? "block" : "pass";
  const issueCodes = [...new Set(blockers.map((blocker) => blocker.code))];

  return {
    schema_version: RELEASE_CANDIDATE_GATE_SCHEMA_VERSION,
    schema: "yolo.release.release_candidate_gate_result.v1",
    mode,
    status,
    issue_codes: issueCodes,
    blockers,
    warnings: status === "pass" ? warnings : [],
    reports: normalizedReports,
    contract: {
      required_reports: RELEASE_CANDIDATE_REQUIRED_REPORTS,
      report_statuses: {
        pass: [...RELEASE_CANDIDATE_PASS_STATUSES],
        block: [...RELEASE_CANDIDATE_BLOCK_STATUSES],
      },
      approval_binding: "approval.id, approval.approved_by, approval.approved_at, approval.expires_at/valid_until, and approval.issue_codes are required",
      warning_policy: "rc and publish modes require zero warnings or valid approvals bound to every warning issue code",
    },
    next_actions: status === "pass"
      ? ["Release candidate gate passed for the requested mode."]
      : ["Resolve release candidate gate blockers before promoting or publishing."],
  };
}

export const evaluateReleaseCandidateGate = runReleaseCandidateGate;
