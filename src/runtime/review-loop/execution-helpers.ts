import { existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeReviewFindings } from "../../review/findings.js";
import type { NormalizedReviewFinding, ReviewFindingInput } from "../../review/findings.js";

function runtimeScript(yoloRoot: string, relativePath: string): string {
  const direct = join(yoloRoot, relativePath);
  if (existsSync(direct)) return direct;
  return join(yoloRoot, "dist", relativePath);
}

export function buildReviewScannerArgs({ yoloRoot, rootDir, reviewScopeFiles = [] }: {
  yoloRoot: string;
  rootDir?: string | null;
  reviewScopeFiles?: string[];
}): string[] {
  const args: string[] = [runtimeScript(yoloRoot, "src/review/scanner.js"), "--json"];
  if (rootDir) args.push(`--root=${rootDir}`);
  if (reviewScopeFiles.length > 0) args.push(`--files=${reviewScopeFiles.join(",")}`);
  return args;
}

type ScannerLikeError = {
  stdout?: unknown;
  stderr?: unknown;
  message?: unknown;
} | null | undefined;

export function scannerStdoutFromError(error: ScannerLikeError): string {
  const stdout = error && typeof error === "object" ? (error as Record<string, unknown>).stdout : undefined;
  return String(stdout || "").trim();
}

export type ScannerFailureDiagnostic = {
  message: string;
  stdout_sample: string;
  stderr_sample: string;
  detail: string;
};

export function scannerFailureDiagnostic(error: ScannerLikeError): ScannerFailureDiagnostic {
  const stdout = scannerStdoutFromError(error);
  const rec = (error && typeof error === "object") ? (error as Record<string, unknown>) : Object();
  const stderr = String(rec.stderr || "").trim();
  const message = String(rec.message || "scanner failed");
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

function isReviewFindingRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rawReviewFindings(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed as unknown[];
  if (parsed && typeof parsed === "object") {
    const findings = (parsed as Record<string, unknown>).findings;
    if (Array.isArray(findings)) return findings as unknown[];
  }
  return [];
}

function malformedFindingsMessage(parsed: unknown): string | null {
  const hasFindings = parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "findings");
  const raw = Array.isArray(parsed)
    ? parsed
    : (hasFindings ? (parsed as Record<string, unknown>).findings : null);
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return "Scanner findings must be an array.";
  return (raw as unknown[]).some((finding) => !isReviewFindingRecord(finding))
    ? "Scanner findings entries must be objects."
    : null;
}

export function parseReviewFindings(scanResult: string): NormalizedReviewFinding[] {
  const parsed = JSON.parse(scanResult);
  const findings = rawReviewFindings(parsed).filter(isReviewFindingRecord) as ReviewFindingInput[];
  const source = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
    ? (parsed as Record<string, unknown>).source
    : undefined;
  return normalizeReviewFindings(findings, { source: source || "review-parser" });
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function cleanPath(value: unknown): string {
  return clean(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

function cleanPathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).map((item) => cleanPath(item)).filter(Boolean);
}

function coverageArtifact(parsed: unknown = Object()): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  return rec.coverage_artifact || rec.coverage || rec.scan_coverage || rec.review_coverage || parsed;
}

function isCoverageObject(coverage: unknown): coverage is Record<string, unknown> {
  return !!coverage && typeof coverage === "object" && !Array.isArray(coverage);
}

function missingExpectedFiles(coverage: unknown): string[] {
  if (!isCoverageObject(coverage) || !Array.isArray(coverage.missing_expected_files)) return [];
  return cleanPathList(coverage.missing_expected_files);
}

export type ReviewCoverageBlocker = {
  code: string;
  message: string;
  coverage_status?: unknown;
  missing_expected_files?: string[];
  missing_fields?: string[];
};

export type ReviewCoverageInspection = {
  status: "blocked" | "pass";
  blocks_execution: boolean;
  reason: string | null;
  message?: string;
  coverage: unknown;
  blockers: ReviewCoverageBlocker[];
  missing_expected_files?: string[];
  missing_fields?: string[];
};

function incompleteCoverageBlock(coverage: unknown): ReviewCoverageInspection | null {
  if (!isCoverageObject(coverage)) return null;
  const coverageStatus = clean(coverage.coverage_status).toLowerCase();
  if (coverageStatus && !["complete", "pass", "covered"].includes(coverageStatus)) {
    return {
      status: "blocked",
      blocks_execution: true,
      reason: "scanner_coverage_incomplete",
      message: `Scanner coverage is not complete: ${String(coverage.coverage_status)}`,
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

function changedFilesCoverageBlock(coverage: unknown, expectedFiles: unknown[] = []): ReviewCoverageInspection | null {
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

export function inspectReviewScannerCoverage(
  scanResult: string,
  findings: NormalizedReviewFinding[] | null = null,
  options: { expectedFiles?: unknown[]; reviewScopeFiles?: unknown[] } = Object(),
): ReviewCoverageInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scanResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "blocked",
      blocks_execution: true,
      reason: "scanner_non_json",
      message,
      coverage: null,
      blockers: [{ code: "REVIEW_SCANNER_NON_JSON", message }],
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

  const parsedSource = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).source
    : undefined;
  const normalizedFindings = findings || normalizeReviewFindings(
    rawReviewFindings(parsed).filter(isReviewFindingRecord) as ReviewFindingInput[],
    { source: parsedSource || "review-parser" },
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

  const missingFields: string[] = [];
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

export function shouldStopReviewAfterFailure(failureCount: number, maxFailures = 3): boolean {
  return failureCount >= maxFailures;
}
