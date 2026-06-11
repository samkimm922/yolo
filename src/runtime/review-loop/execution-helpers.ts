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

export function parseReviewFindings(scanResult) {
  const parsed = JSON.parse(scanResult);
  const findings = Array.isArray(parsed) ? parsed : (parsed?.findings || []);
  return normalizeReviewFindings(findings, { source: parsed?.source || "review-parser" });
}

function clean(value) {
  return String(value ?? "").trim();
}

function coverageArtifact(parsed = Object()) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed.coverage_artifact || parsed.coverage || parsed.scan_coverage || parsed.review_coverage || parsed;
}

export function inspectReviewScannerCoverage(scanResult, findings = null) {
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
  const normalizedFindings = findings || normalizeReviewFindings(
    Array.isArray(parsed) ? parsed : (parsed?.findings || []),
    { source: parsed?.source || "review-parser" },
  );
  if (normalizedFindings.length > 0) {
    return {
      status: "pass",
      blocks_execution: false,
      reason: null,
      coverage: coverageArtifact(parsed),
      blockers: [],
    };
  }

  const coverage = coverageArtifact(parsed);
  const missingFields = [];
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
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

  const coverageStatus = clean(coverage.coverage_status).toLowerCase();
  if (!["complete", "pass", "covered"].includes(coverageStatus)) {
    return {
      status: "blocked",
      blocks_execution: true,
      reason: "scanner_coverage_incomplete",
      message: `Scanner coverage is not complete: ${coverage.coverage_status}`,
      coverage,
      blockers: [{
        code: "REVIEW_SCANNER_COVERAGE_INCOMPLETE",
        message: "Empty review findings cannot pass when scanner coverage is incomplete.",
        coverage_status: coverage.coverage_status,
      }],
    };
  }

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
