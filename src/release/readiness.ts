import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectFixtureRegistry } from "../fixtures/registry.js";

const DEFAULT_YOLO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const REQUIRED_RELIABILITY_INCIDENT_IDS = Object.freeze([
  "YB-001",
  "YB-002",
  "YB-003",
  "YB-004",
  "YB-005",
  "YB-006",
  "YB-007",
  "YB-008",
  "YB-009",
  "YB-010",
  "YB-011",
  "YB-012",
]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function check(code, passed, message, extra = Object()) {
  return { code, passed, message, ...extra };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function rateValue(numerator, denominator) {
  if (!denominator || denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function normalizeIncidentEvidence(evidence = Object()) {
  const source = asArray(evidence.incidents).length
    ? evidence.incidents
    : asArray(evidence.results).length
      ? evidence.results
      : asArray(evidence.checks);
  return source
    .map((entry) => ({
      id: entry.id || entry.incident_id || entry.code || null,
      status: entry.status || (entry.passed === true ? "pass" : entry.passed === false ? "fail" : null),
      passed: entry.passed === true || ["pass", "passed", "fixed", "closed"].includes(String(entry.status || "").toLowerCase()),
      evidence: entry.evidence || entry.evidence_file || entry.artifact || null,
    }))
    .filter((entry) => entry.id);
}

function cleanStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function claimsPass(report = Object()) {
  const status = cleanStatus(report.status);
  const outcome = cleanStatus(report.outcome || report.final_answer?.outcome);
  return ["pass", "passed", "success", "completed"].includes(status)
    || ["success", "completed"].includes(outcome);
}

function numericZero(value) {
  return value != null && Number(value) === 0;
}

function explicitlyNoFileChanges(report = Object()) {
  const summary = report.summary || report.final_answer?.summary || {};
  if (numericZero(report.files_changed_total ?? report.filesChangedTotal ?? summary.files_changed_total ?? summary.filesChangedTotal)) return true;
  if (numericZero(report.file_changes ?? report.fileChanges ?? summary.file_changes ?? summary.fileChanges)) return true;
  if (Array.isArray(report.changed_files) && report.changed_files.length === 0) return true;
  if (Array.isArray(report.changedFiles) && report.changedFiles.length === 0) return true;
  if (Array.isArray(summary.changed_files) && summary.changed_files.length === 0) return true;
  if (Array.isArray(summary.changedFiles) && summary.changedFiles.length === 0) return true;
  return false;
}

function fakeSuccessReasons(report = Object()) {
  const status = String(report.status || "").toLowerCase();
  const outcome = String(report.outcome || report.final_answer?.outcome || "").toLowerCase();
  const summary = report.summary || report.final_answer?.summary || {};
  const runSuccessRate = Number(summary.run_success_rate);
  const taskSuccessRate = Number(summary.task_success_rate);
  const reasons = [];
  if ((status === "error" || status === "blocked" || outcome === "needs_attention")
    && (runSuccessRate === 100 || taskSuccessRate === 100 || outcome === "completed")) {
    reasons.push("failed_with_100_percent_metrics");
  }
  if (claimsPass(report) && explicitlyNoFileChanges(report)) {
    reasons.push("pass_without_file_changes");
  }
  return reasons;
}

export function classifyFakeSuccessReport(report = Object()) {
  const reasons = fakeSuccessReasons(report);
  if (reasons.length === 0) return null;
  const summary = report.summary || report.final_answer?.summary || {};
  return {
    run_id: report.run_id || null,
    status: report.status || null,
    outcome: report.outcome || report.final_answer?.outcome || null,
    reasons,
    run_success_rate: summary.run_success_rate ?? null,
    task_success_rate: summary.task_success_rate ?? null,
    files_changed_total: report.files_changed_total ?? summary.files_changed_total ?? null,
    changed_files: report.changed_files ?? summary.changed_files ?? null,
  };
}

export function inspectYoloReliabilityReadiness(options = Object()) {
  const incidentEvidence = options.incidentEvidence || options.incident_evidence || null;
  const incidents = normalizeIncidentEvidence(incidentEvidence || {});
  const incidentIds = new Set(incidents.map((entry) => entry.id));
  const missingIncidentIds = REQUIRED_RELIABILITY_INCIDENT_IDS.filter((id) => !incidentIds.has(id));
  const failedIncidents = incidents.filter((entry) =>
    REQUIRED_RELIABILITY_INCIDENT_IDS.includes(entry.id) && entry.passed !== true
  );
  const runReports = asArray(options.runReports || options.run_reports);
  const fakeSuccessReports = runReports
    .map(classifyFakeSuccessReport)
    .filter(Boolean);
  const externalRemediation = asArray(options.externalRemediation || options.external_remediation);
  const contaminatedExternalRemediation = externalRemediation.filter((entry) =>
    entry.counts_as_yolo_success === true || entry.internal === true || entry.yolo_runner_success === true
  );
  const summary = {
    run_report_count: runReports.length,
    fake_success: fakeSuccessReports.length,
    fake_success_rate: rateValue(fakeSuccessReports.length, runReports.length),
    contaminated_external_remediation: contaminatedExternalRemediation.length,
  };

  const checks = [
    check(
      "YOLO_RELIABILITY_INCIDENT_EVIDENCE_PRESENT",
      Boolean(incidentEvidence),
      "YOLO release readiness requires project-independent reliability incident evidence.",
    ),
    check(
      "YOLO_RELIABILITY_INCIDENT_COVERAGE",
      missingIncidentIds.length === 0,
      "Reliability evidence must cover every known YB incident.",
      { missing_incident_ids: missingIncidentIds },
    ),
    check(
      "YOLO_RELIABILITY_INCIDENTS_PASS",
      failedIncidents.length === 0 && incidents.length >= REQUIRED_RELIABILITY_INCIDENT_IDS.length,
      "Every known YB reliability incident must be closed by a passing regression.",
      { failed_incidents: failedIncidents.map((entry) => ({ id: entry.id, status: entry.status })) },
    ),
    check(
      "YOLO_RELIABILITY_NO_FAKE_SUCCESS_REPORTS",
      fakeSuccessReports.length === 0,
      "Run reports must not combine failed/error outcomes with 100% success metrics.",
      { fake_success_reports: fakeSuccessReports },
    ),
    check(
      "YOLO_RELIABILITY_EXTERNAL_REMEDIATION_ISOLATED",
      contaminatedExternalRemediation.length === 0,
      "External claude-p or manual remediation must not count as YOLO runner success.",
      { contaminated_count: contaminatedExternalRemediation.length },
    ),
  ];
  const blockers = checks.filter((item) => item.passed !== true);
  return {
    status: blockers.length > 0 ? "blocked" : "pass",
    blocks_release: blockers.length > 0,
    required_incident_ids: [...REQUIRED_RELIABILITY_INCIDENT_IDS],
    incidents,
    summary,
    checks,
    blockers,
  };
}

function inspectApiBoundaryDocument({ yoloRoot, packageJson }) {
  const boundaryPath = join(yoloRoot, "docs/public-sdk-api-boundary.json");
  const checks = [
    check("API_BOUNDARY_EXISTS", existsSync(boundaryPath), "docs/public-sdk-api-boundary.json must exist", { file: "docs/public-sdk-api-boundary.json" }),
  ];
  if (!existsSync(boundaryPath)) {
    return checks;
  }

  let boundary;
  try {
    boundary = readJson(boundaryPath);
    checks.push(check("API_BOUNDARY_JSON", true, "public SDK API boundary must be valid JSON"));
  } catch (error) {
    checks.push(check("API_BOUNDARY_JSON", false, "public SDK API boundary must be valid JSON", { error: error.message }));
    return checks;
  }

  const exportsEntries = Array.isArray(boundary.package_exports) ? boundary.package_exports : [];
  const packageExports = packageJson.exports || {};
  const byExport = new Map(exportsEntries.map((entry) => {
    const exportEntry = Object.assign(Object(), entry);
    return [String(exportEntry.export), exportEntry];
  }));
  const packageExportKeys = Object.keys(packageExports).sort();
  const boundaryExportKeys = [...byExport.keys()].map(String).sort();
  const missingExports = packageExportKeys.filter((name) => !byExport.has(name));
  const extraExports = boundaryExportKeys.filter((name) => !Object.hasOwn(packageExports, name));
  const targetMismatches = Object.entries(packageExports)
    .filter(([name, target]) => Object.assign(Object(), byExport.get(name)).target !== target)
    .map(([name]) => name);

  checks.push(check(
    "API_BOUNDARY_PACKAGE_EXPORTS",
    missingExports.length === 0 && extraExports.length === 0 && targetMismatches.length === 0,
    "public SDK API boundary must classify every package export with matching target",
    { missing_exports: missingExports, extra_exports: extraExports, target_mismatches: targetMismatches },
  ));

  const policy = boundary.version_policy || {};
  const usedTiers = new Set(exportsEntries.map((entry) => entry.tier).filter(Boolean));
  for (const tier of Object.keys(boundary.sdk_module_exports || {})) {
    usedTiers.add(tier);
  }
  for (const namespace of boundary.create_yolo_sdk?.namespaces || []) {
    for (const tier of Object.values(namespace.entries || {})) {
      usedTiers.add(tier);
    }
  }
  const missingPolicies = [...usedTiers].filter((tier) => !policy[String(tier)]);
  checks.push(check(
    "API_BOUNDARY_VERSION_POLICY",
    missingPolicies.length === 0,
    "public SDK API boundary must define version policy for every used API tier",
    { missing_policies: missingPolicies },
  ));

  const moduleExports = boundary.sdk_module_exports || {};
  const namespaceEntries = boundary.create_yolo_sdk?.namespaces || [];
  checks.push(check(
    "API_BOUNDARY_SDK_SURFACE",
    Object.keys(moduleExports).length > 0 && namespaceEntries.length > 0,
    "public SDK API boundary must classify sdk.js exports and createYoloSdk namespaces",
    { module_tiers: Object.keys(moduleExports), namespace_count: namespaceEntries.length },
  ));

  return checks;
}

export function inspectPackageReadiness(packageJson = Object()) {
  const packageFiles = Array.isArray(packageJson.files) ? packageJson.files : [];
  const forbiddenFileEntries = packageFiles.filter((entry) =>
    ["__tests__", "closed-loop", "data", "logs", "node_modules", "state", "tmp", "scripts", "hooks"].some((forbidden) =>
      entry === forbidden || entry.startsWith(`${forbidden}/`)
    )
  );
  const checks = [
    check("PACKAGE_NAME", Boolean(packageJson.name), "package.json must define name"),
    check("PACKAGE_VERSION_SEMVER", SEMVER_RE.test(packageJson.version || ""), "package.json version must be semver", { version: packageJson.version || null }),
    check("PACKAGE_LICENSE", Boolean(packageJson.license), "package.json must define license"),
    check("PACKAGE_EXPORTS", Boolean(packageJson.exports?.["."]), "package.json must expose the SDK entrypoint"),
    check("PACKAGE_BIN", Object.keys(packageJson.bin || {}).length > 0, "package.json must expose public bins"),
    check(
      "PACKAGE_FILES_ALLOWLIST",
      packageFiles.some((entry) => entry === "dist/" || entry.startsWith("dist/")),
      "package.json must publish compiled TypeScript output through an explicit dist/ files allowlist",
      { files: packageFiles },
    ),
    check(
      "PACKAGE_FILES_NO_WORKSPACE_STATE",
      forbiddenFileEntries.length === 0,
      "package files allowlist must not include tests, local state, legacy workspace data, logs, or tmp files",
      { forbidden_entries: forbiddenFileEntries },
    ),
    check("PACKAGE_PRIVATE_RELEASE_BLOCK", packageJson.private !== true, "package.json private=true blocks public release"),
  ];
  const blockers = checks.filter((item) => item.passed !== true);
  return {
    status: blockers.length > 0 ? "blocked" : "pass",
    blocks_release: blockers.length > 0,
    checks,
    blockers,
  };
}

export function inspectPublicBetaReadiness(options = Object()) {
  const yoloRoot = resolve(options.yoloRoot || DEFAULT_YOLO_ROOT);
  const packageJsonPath = join(yoloRoot, "package.json");
  const packageJson = options.packageJson || readJson(packageJsonPath);
  const packageReadiness = inspectPackageReadiness(packageJson);
  const requiredDocs = [
    "README.md",
    "CHANGELOG.md",
    "docs/api-reference.md",
    "docs/fixture-matrix.md",
    "docs/public-sdk-contract.md",
    "docs/public-sdk-api-boundary.json",
    "docs/sdk-gap-matrix.md",
    "docs/sdk-agent-architecture.md",
  ];
  const docChecks = requiredDocs.map((relativePath) =>
    check("DOC_EXISTS", existsSync(join(yoloRoot, relativePath)), `${relativePath} must exist`, { file: relativePath })
  );
  const contractText = existsSync(join(yoloRoot, "docs/public-sdk-contract.md"))
    ? readFileSync(join(yoloRoot, "docs/public-sdk-contract.md"), "utf8")
    : "";
  const readmeText = existsSync(join(yoloRoot, "README.md"))
    ? readFileSync(join(yoloRoot, "README.md"), "utf8")
    : "";
  const changelogText = existsSync(join(yoloRoot, "CHANGELOG.md"))
    ? readFileSync(join(yoloRoot, "CHANGELOG.md"), "utf8")
    : "";
  const apiReferenceText = existsSync(join(yoloRoot, "docs/api-reference.md"))
    ? readFileSync(join(yoloRoot, "docs/api-reference.md"), "utf8")
    : "";
  const fixtureMatrixText = existsSync(join(yoloRoot, "docs/fixture-matrix.md"))
    ? readFileSync(join(yoloRoot, "docs/fixture-matrix.md"), "utf8")
    : "";
  docChecks.push(
    check(
      "DOC_API_BOUNDARIES",
      /## Version Policy/.test(contractText) && /## Stable/.test(contractText) && /## Experimental/.test(contractText) && /## Internal/.test(contractText) && /public-sdk-api-boundary\.json/.test(contractText),
      "public SDK contract must document version policy plus stable, experimental, and internal APIs",
    ),
    check(
      "DOC_README_PUBLIC_BETA_SURFACES",
      /yolo init/.test(readmeText) && /sdk\.project/.test(readmeText) && /sdk\.spec/.test(readmeText) && /docs\/api-reference\.md/.test(readmeText) && /docs\/fixture-matrix\.md/.test(readmeText),
      "README must describe bootstrap, spec lifecycle, API reference, and fixture matrix",
    ),
    check(
      "DOC_API_REFERENCE_SURFACES",
      /Stable Package Exports/.test(apiReferenceText) && /Experimental Package Exports/.test(apiReferenceText) && /yolo init/.test(apiReferenceText) && /Release Blockers/.test(apiReferenceText) && /runPublicBetaHardeningDrill/.test(apiReferenceText) && /runControlledBetaReleaseDecisionGate/.test(apiReferenceText) && /runOperatorReleaseStateMutation/.test(apiReferenceText) && /runOperatorReleaseRunbookGate/.test(apiReferenceText) && /runPostReleaseAuditGate/.test(apiReferenceText) && /runStableGraduationGate/.test(apiReferenceText) && /runManualExternalReleaseGate/.test(apiReferenceText) && /runAgentIntegrationDoctor/.test(apiReferenceText) && /runRealProjectDogfoodGate/.test(apiReferenceText) && /runPiExecutionDrillGate/.test(apiReferenceText) && /runRuntimeBoundaryDecisionGate/.test(apiReferenceText) && /runPublicBetaEvidenceGate/.test(apiReferenceText),
      "API reference must cover stable exports, experimental exports, CLI bootstrap, release blockers, hardening drill, controlled release decision gate, operator release-state mutation, operator runbook gate, post-release audit gate, stable graduation gate, manual external release evidence gate, agent integration doctor, real-project dogfood gate, PI drill gate, runtime boundary decision gate, and public beta evidence gate",
    ),
    check(
      "DOC_FIXTURE_MATRIX_COVERAGE",
      ["node-basic", "no-tests", "python-basic", "python-service", "frontend-vite", "monorepo", "dirty-tree", "failing-baseline", "backend-api"].every((fixtureId) => fixtureMatrixText.includes(fixtureId)),
      "fixture matrix must list every public beta fixture",
    ),
    check(
      "DOC_CHANGELOG_PUBLIC_BETA",
      /Public Beta Readiness/.test(changelogText) && /private: true/.test(changelogText),
      "CHANGELOG must summarize public beta readiness and remaining package blocker",
    ),
  );
  const apiBoundaryChecks = inspectApiBoundaryDocument({ yoloRoot, packageJson });

  const fixtureReadiness = inspectFixtureRegistry({ yoloRoot });
  const reliabilityReadiness = inspectYoloReliabilityReadiness({
    incidentEvidence: options.reliabilityIncidentEvidence || options.reliability_incident_evidence,
    runReports: options.reliabilityRunReports || options.reliability_run_reports,
    externalRemediation: options.externalRemediation || options.external_remediation,
  });
  const fixtureCheck = check(
    "FIXTURE_REGISTRY_PASS",
    fixtureReadiness.status === "pass" && fixtureReadiness.fixture_count > 0,
    "fixture registry must pass with at least one fixture",
    { fixture_count: fixtureReadiness.fixture_count },
  );

  const checks = [
    ...packageReadiness.checks,
    ...docChecks,
    ...apiBoundaryChecks,
    fixtureCheck,
    ...reliabilityReadiness.checks,
  ];
  const blockers = checks.filter((item) => item.passed !== true);

  return {
    status: blockers.length > 0 ? "blocked" : "pass",
    blocks_release: blockers.length > 0,
    package: {
      name: packageJson.name || null,
      version: packageJson.version || null,
      private: packageJson.private === true,
    },
    checks,
    blockers,
    fixture_readiness: fixtureReadiness,
    reliability_readiness: reliabilityReadiness,
  };
}
