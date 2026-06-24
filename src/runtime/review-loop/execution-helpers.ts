import { existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeReviewFindings } from "../../review/findings.js";

function runtimeScript(yoloRoot, relativePath) {
  const direct = join(yoloRoot, relativePath);
  if (existsSync(direct)) return direct;
  return join(yoloRoot, "dist", relativePath);
}

export function buildReviewScannerArgs({ yoloRoot, rootDir, reviewScopeFiles = [] }) {
  const args = [runtimeScript(yoloRoot, "src/review/scanner.js"), "--json"];
  if (rootDir) args.push(`--root=${rootDir}`);
  if (reviewScopeFiles.length > 0) args.push(`--files=${reviewScopeFiles.join(",")}`);
  return args;
}

export function scannerStdoutFromError(error) {
  return (error?.stdout || "").trim();
}

export function scannerFailureDiagnostic(error) {
  const stdout = scannerStdoutFromError(error);
  const stderr = (error?.stderr || "").trim();
  const message = error?.message || "scanner failed";
  return {
    message,
    stdout_sample: stdout.slice(0, 300),
    stderr_sample: stderr.slice(0, 300),
    detail: [
      message,
      stdout ? `stdout: ${stdout.slice(0, 300)}` : "",
      stderr ? `stderr: ${stderr.slice(0, 300)}` : "",
    ].filter(Boolean).join("\n"),
  };
}

function isReviewFindingRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rawReviewFindings(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.findings)) return parsed.findings;
  return [];
}

function malformedFindingsMessage(parsed) {
  const hasFindings = parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "findings");
  const raw = Array.isArray(parsed) ? parsed : (hasFindings ? parsed.findings : null);
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return "Scanner findings must be an array.";
  return raw.some((finding) => !isReviewFindingRecord(finding))
    ? "Scanner findings entries must be objects."
    : null;
}

export function parseReviewFindings(scanResult) {
  const parsed = JSON.parse(scanResult);
  const findings = rawReviewFindings(parsed).filter(isReviewFindingRecord);
  return normalizeReviewFindings(findings, { source: parsed?.source || "review-parser" });
}

function clean(value) {
  return String(value ?? "").trim();
}

function cleanPath(value) {
  return clean(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

function cleanPathList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanPath(item)).filter(Boolean);
}

function coverageArtifact(parsed = Object()) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed.coverage_artifact || parsed.coverage || parsed.scan_coverage || parsed.review_coverage || parsed;
}

function isCoverageObject(coverage) {
  return coverage && typeof coverage === "object" && !Array.isArray(coverage);
}

function missingExpectedFiles(coverage) {
  if (!isCoverageObject(coverage) || !Array.isArray(coverage.missing_expected_files)) return [];
  return cleanPathList(coverage.missing_expected_files);
}

function incompleteCoverageBlock(coverage) {
  if (!isCoverageObject(coverage)) return null;
  const coverageStatus = clean(coverage.coverage_status).toLowerCase();
  if (coverageStatus && !["complete", "pass", "covered"].includes(coverageStatus)) {
    return {
      status: "blocked",
      blocks_execution: true,
      reason: "scanner_coverage_incomplete",
      message: `Scanner coverage is not complete: ${coverage.coverage_status}`,
      coverage,
      blockers: [{
        code: "REVIEW_SCANNER_COVERAGE_INCOMPLETE",
        message: "Review findings cannot pass when scanner coverage is incomplete.",
        coverage_status: coverage.coverage_status,
      }],
    };
  }
  const missing = missingExpectedFiles(coverage);
  if (missing.length > 0) {
    return {
      status: "blocked",
      blocks_execution: true,
      reason: "scanner_coverage_missing_expected_files",
      message: `Scanner did not cover expected files: ${missing.join(", ")}`,
      coverage,
      missing_expected_files: missing,
      blockers: [{
        code: "REVIEW_SCANNER_COVERAGE_MISSING_EXPECTED_FILES",
        message: "Review scanner coverage is missing expected files.",
        missing_expected_files: missing,
      }],
    };
  }
  return null;
}

function changedFilesCoverageBlock(coverage, expectedFiles = []) {
  const expected = cleanPathList(expectedFiles);
  if (expected.length === 0) return null;
  const scanned = new Set(isCoverageObject(coverage) ? cleanPathList(coverage.scanned_files) : []);
  const missing = expected.filter((file) => !scanned.has(file));
  if (missing.length === 0) return null;
  return {
    status: "blocked",
    blocks_execution: true,
    reason: "scanner_coverage_missing_changed_files",
    message: `Scanner did not scan changed files: ${missing.join(", ")}`,
    coverage: isCoverageObject(coverage) ? coverage : null,
    missing_expected_files: missing,
    blockers: [{
      code: "REVIEW_SCANNER_CHANGED_FILES_UNSCANNED",
      message: "Review scanner coverage does not include the external changed-file scope.",
      missing_expected_files: missing,
    }],
  };
}

export function inspectReviewScannerCoverage(scanResult, findings = null, options = Object()) {
  let parsed;
  try {
    parsed = JSON.parse(scanResult);
  } catch (error) {
    return {
      status: "blocked",
      blocks_execution: true,
      reason: "scanner_non_json",
      message: error.message,
      coverage: null,
      blockers: [{ code: "REVIEW_SCANNER_NON_JSON", message: error.message }],
    };
  }
  const malformedFindings = malformedFindingsMessage(parsed);
  if (malformedFindings) {
    return {
      status: "blocked",
      blocks_execution: true,
      reason: "scanner_findings_malformed",
      message: malformedFindings,
      coverage: coverageArtifact(parsed),
      blockers: [{
        code: "REVIEW_SCANNER_FINDINGS_MALFORMED",
        message: malformedFindings,
      }],
    };
  }

  const normalizedFindings = findings || normalizeReviewFindings(
    rawReviewFindings(parsed),
    { source: parsed?.source || "review-parser" },
  );
  const coverage = coverageArtifact(parsed);
  const coverageBlock = incompleteCoverageBlock(coverage)
    || changedFilesCoverageBlock(coverage, options.expectedFiles || options.reviewScopeFiles || []);
  if (normalizedFindings.length > 0) {
    if (coverageBlock) return coverageBlock;
    return {
      status: "pass",
      blocks_execution: false,
      reason: null,
      coverage,
      blockers: [],
    };
  }

  const missingFields = [];
  if (!isCoverageObject(coverage)) {
    missingFields.push("coverage_artifact");
  } else {
    if (!clean(coverage.scanner_version)) missingFields.push("scanner_version");
    if (!Array.isArray(coverage.scanned_files)) missingFields.push("scanned_files");
    if (!Array.isArray(coverage.rules) && (!coverage.rules || typeof coverage.rules !== "object")) missingFields.push("rules");
    if (coverage.expected_scope === undefined || coverage.expected_scope === null) missingFields.push("expected_scope");
    if (!clean(coverage.coverage_status)) missingFields.push("coverage_status");
  }
  if (missingFields.length > 0) {
    return {
      status: "blocked",
      blocks_execution: true,
      reason: "scanner_coverage_missing",
      message: `Scanner returned empty findings without complete coverage artifact: ${missingFields.join(", ")}`,
      coverage: coverage || null,
      missing_fields: missingFields,
      blockers: [{
        code: "REVIEW_SCANNER_COVERAGE_MISSING",
        message: "Empty review findings require a complete scanner coverage artifact.",
        missing_fields: missingFields,
      }],
    };
  }

  if (coverageBlock) return coverageBlock;

  return {
    status: "pass",
    blocks_execution: false,
    reason: null,
    coverage,
    blockers: [],
  };
}

export function shouldStopReviewAfterFailure(failureCount, maxFailures = 3) {
  return failureCount >= maxFailures;
}

export function normalizeAutoFixResult(autoResult = Object()) {
  const escalatedFromAuto = autoResult.escalatedTasks || [];
  const autoFixedCount = autoResult.stats?.fixed || 0;
  return {
    escalatedFromAuto,
    autoFixedCount,
    summary: `AUTO_FIX 完成: ${autoFixedCount} 已修复, ${escalatedFromAuto.length} 升级为 CLAUDE_FIX`,
    gateMeta: {
      phase: "AUTO_FIX_RESULT",
      stats: autoResult.stats,
      escalated: escalatedFromAuto.map((task) => task.id),
    },
  };
}

export function autoFixErrorFallback(autoFixTasks = []) {
  return {
    escalatedFromAuto: autoFixTasks,
    autoFixedCount: 0,
  };
}
