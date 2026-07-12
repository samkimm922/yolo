import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanProject } from "../src/review/scanner.js";
import {
  buildReviewScannerArgs,
  inspectReviewScannerCoverage,
  parseReviewFindings,
  scannerFailureDiagnostic,
  scannerStdoutFromError,
  shouldStopReviewAfterFailure,
} from "../src/runtime/review-loop/execution-helpers.js";

describe("review-loop execution helpers", () => {
  test("buildReviewScannerArgs includes file scope only when present", () => {
    assert.deepEqual(buildReviewScannerArgs({
      yoloRoot: "/repo/scripts/yolo",
      rootDir: "/repo/scripts/yolo",
      reviewScopeFiles: [],
    }), [join("/repo/scripts/yolo", "dist/src/review/scanner.js"), "--json", "--root=/repo/scripts/yolo"]);

    assert.deepEqual(buildReviewScannerArgs({
      yoloRoot: "/repo/scripts/yolo",
      rootDir: "/repo/scripts/yolo",
      reviewScopeFiles: ["src/a.ts", "src/b.ts"],
    }), [join("/repo/scripts/yolo", "dist/src/review/scanner.js"), "--json", "--root=/repo/scripts/yolo", "--files=src/a.ts,src/b.ts"]);
  });

  test("scannerStdoutFromError extracts trimmed stdout fallback", () => {
    assert.equal(scannerStdoutFromError({ stdout: "  []\n" }), "[]");
    assert.equal(scannerStdoutFromError({ stderr: "bad" }), "");
    assert.equal(scannerStdoutFromError(null), "");
  });

  test("scannerFailureDiagnostic preserves stdout as diagnostic, not scan input", () => {
    const diagnostic = scannerFailureDiagnostic({ message: "scanner crashed", stdout: " []\n", stderr: "boom" });
    assert.equal(diagnostic.message, "scanner crashed");
    assert.equal(diagnostic.stdout_sample, "[]");
    assert.equal(diagnostic.stderr_sample, "boom");
    assert.match(diagnostic.detail, /stdout: \[\]/);
  });

  test("parseReviewFindings accepts arrays and object-wrapped findings", () => {
    const arrayFindings = parseReviewFindings(JSON.stringify([{ id: "A", message: "a" }]));
    assert.equal(arrayFindings[0].schema, "yolo.review.finding.v1");
    assert.equal(arrayFindings[0].finding_id, "A");
    assert.equal(arrayFindings[0].message, "a");

    const wrappedFindings = parseReviewFindings(JSON.stringify({ source: "review-scanner", findings: [{ id: "B", message: "b" }] }));
    assert.equal(wrappedFindings[0].source, "review-scanner");
    assert.equal(wrappedFindings[0].finding_id, "B");
    assert.deepEqual(parseReviewFindings(JSON.stringify({ findings: null })), []);
    assert.throws(() => parseReviewFindings("{not-json"));
  });

  test("malformed scanner findings are blocked without parser TypeError", () => {
    const coverage = {
      scanner_version: "test-review-scanner@1",
      scanned_files: ["src/app.ts"],
      rules: ["R-test"],
      expected_scope: ["src/app.ts"],
      coverage_status: "complete",
    };

    for (const findings of [{ id: "not-an-array" }, [null]]) {
      const scanResult = JSON.stringify({ ...coverage, findings });
      assert.doesNotThrow(() => parseReviewFindings(scanResult));

      const result = inspectReviewScannerCoverage(scanResult, parseReviewFindings(scanResult));
      assert.equal(result.status, "blocked");
      assert.equal(result.reason, "scanner_findings_malformed");
      assert.equal(result.blockers[0].code, "REVIEW_SCANNER_FINDINGS_MALFORMED");
    }
  });

  test("inspectReviewScannerCoverage blocks empty findings without complete coverage", () => {
    const missing = inspectReviewScannerCoverage(JSON.stringify({ findings: [] }));
    assert.equal(missing.status, "blocked");
    assert.equal(missing.reason, "scanner_coverage_missing");
    assert.ok(missing["missing_fields"].includes("scanner_version"));

    const complete = inspectReviewScannerCoverage(JSON.stringify({
      scanner_version: "test-review-scanner@1",
      scanned_files: ["src/app.ts"],
      rules: ["R-test"],
      expected_scope: ["src/app.ts"],
      coverage_status: "complete",
      findings: [],
    }));
    assert.equal(complete.status, "pass");
    assert.equal(complete.blocks_execution, false);
  });

  test("inspectReviewScannerCoverage includes a copyable coverage_template skeleton when coverage is missing", () => {
    // No coverage artifact at all -> scanner author needs a full template to copy.
    const missing = inspectReviewScannerCoverage(JSON.stringify({ findings: [] }));
    assert.equal(missing.status, "blocked");
    assert.equal(missing.reason, "scanner_coverage_missing");
    const blocker = missing.blockers.find((b) => b.code === "REVIEW_SCANNER_COVERAGE_MISSING");
    assert.ok(blocker, "expected REVIEW_SCANNER_COVERAGE_MISSING blocker");
    assert.ok(blocker && typeof blocker.coverage_template === "object" && blocker.coverage_template !== null,
      "blocker.coverage_template must be a non-null object");

    const template = blocker.coverage_template;
    // Template must mirror every field the inspection logic in inspectReviewScannerCoverage checks.
    assert.equal(typeof template.scanner_version, "string");
    assert.ok(Array.isArray(template.scanned_files));
    assert.ok(Array.isArray(template.rules) || (template.rules && typeof template.rules === "object"));
    assert.ok(template.expected_scope !== undefined && template.expected_scope !== null);
    assert.ok(["complete", "pass", "covered"].includes(template.coverage_status),
      `coverage_status must be one of complete|pass|covered, got ${String(template.coverage_status)}`);

    // The top-level inspection result should also carry the template so orchestrator logs surface it.
    assert.ok(typeof missing.coverage_template === "object" && missing.coverage_template !== null);

    // Filling the template verbatim must satisfy the inspection (no missing fields, coverage complete).
    const filled = inspectReviewScannerCoverage(JSON.stringify({ ...template, findings: [] }));
    assert.notEqual(filled.reason, "scanner_coverage_missing");
    assert.deepEqual(filled.missing_fields ?? [], []);
  });

  test("inspectReviewScannerCoverage checks scanner coverage against external scope", () => {
    const result = inspectReviewScannerCoverage(JSON.stringify({
      scanner_version: "test-review-scanner@1",
      scanned_files: ["src/unrelated.ts"],
      rules: ["R-test"],
      expected_scope: ["src/changed.ts"],
      coverage_status: "complete",
      findings: [],
    }), null, { expectedFiles: ["src/changed.ts"] });

    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "scanner_coverage_missing_changed_files");
    assert.equal(result.blockers[0].code, "REVIEW_SCANNER_CHANGED_FILES_UNSCANNED");
  });

  test("scanProject emits complete coverage_artifact for clean scoped projects", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-review-scan-clean-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/app.ts"), "export const value = 1;\n", "utf8");

      const result = scanProject({
        root,
        files: ["src/app.ts"],
        includeExternalChecks: false,
      });
      const coverage = inspectReviewScannerCoverage(JSON.stringify(result), result.findings);

      assert.equal(result.findings.length, 0);
      assert.deepEqual(result.coverage_artifact.scanned_files, ["src/app.ts"]);
      assert.equal(result.coverage_artifact.coverage_status, "complete");
      assert.equal(coverage.status, "pass");
      assert.equal(coverage.blocks_execution, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scanProject blocks unavailable validation commands instead of self-greenlighting", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-review-scan-missing-typecheck-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/app.ts"), "export const value = 1;\n", "utf8");

      const result = scanProject({
        root,
        includeExternalChecks: true,
        config: {
          project: { source_roots: ["src"], src: "src", source_extensions: [".ts"], exclude: ["node_modules", "dist", ".git"] },
          build: { type_check: "definitely_missing_typecheck_tool_zz --noEmit", lint: "" },
          gate: { max_lines_per_file: 150, timeout: { type_check: 1000, lint: 1000 } },
        },
      });

      assert.ok(
        result.findings.some((finding) => finding.scanner_id === "command-failed"),
        `expected COMMAND_FAILED finding: ${JSON.stringify(result.findings)}`,
      );
      assert.equal(result.total_findings > 0, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports a custom command failure without assuming TypeScript output", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-review-custom-check-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/app.ts"), "export const value = 1;\n", "utf8");

      const result = scanProject({
        root,
        files: ["src/app.ts"],
        includeExternalChecks: true,
        config: {
          project: { source_roots: ["src"], src: "src", source_extensions: [".ts"], exclude: ["node_modules", "dist", ".git"] },
          build: { type_check: "custom-check-tool-does-not-exist --check", lint: "" },
          gate: { max_lines_per_file: 150, timeout: { type_check: 1000, lint: 1000 } },
        },
      });

      const finding = result.findings.find((item) => item.scanner_id === "command-failed");
      assert.ok(finding);
      assert.doesNotMatch(finding.description, /TypeScript/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("shouldStopReviewAfterFailure follows the max failure threshold", () => {
    assert.equal(shouldStopReviewAfterFailure(2), false);
    assert.equal(shouldStopReviewAfterFailure(3), true);
    assert.equal(shouldStopReviewAfterFailure(4, 5), false);
    assert.equal(shouldStopReviewAfterFailure(5, 5), true);
  });

});
