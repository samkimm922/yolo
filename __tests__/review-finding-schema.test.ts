import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewOutput,
  normalizeReviewFinding,
  normalizeReviewFindings,
  REVIEW_FINDING_SCHEMA,
  REVIEW_OUTPUT_SCHEMA,
  summarizeReviewFindings,
  validateReviewFinding,
} from "../src/review/findings.js";

describe("review finding v1 schema", () => {
  test("normalizes legacy scanner fields into canonical review findings", () => {
    const finding = normalizeReviewFinding({
      scanner_id: "xss-innerHTML",
      severity: "critical",
      fix_type: "CLAUDE_FIX",
      dimension: "security",
      file: "./src/pages/profile.tsx:24",
      description: "Remove unsafe innerHTML usage",
      suggestion: "Use textContent or a sanitizer.",
      match: "innerHTML",
    }, { source: "review-scanner", index: 0 });

    assert.equal(finding.schema, REVIEW_FINDING_SCHEMA);
    assert.equal(finding.source, "review-scanner");
    assert.equal(finding.code, "xss-innerHTML");
    assert.equal(finding.scanner_id, "xss-innerHTML");
    assert.equal(finding.severity, "CRITICAL");
    assert.equal(finding.fix_type, "CLAUDE_FIX");
    assert.equal(finding.file, "src/pages/profile.tsx");
    assert.equal(finding.line, 24);
    assert.deepEqual(finding.files, ["src/pages/profile.tsx"]);
    assert.equal(finding.message, "Remove unsafe innerHTML usage");
    assert.equal(finding.suggested_fix, "Use textContent or a sanitizer.");
    assert.equal(finding.must_fix_before_ship, true);
    assert.equal(validateReviewFinding(finding).ok, true);
  });

  test("buildReviewOutput adds schema metadata and severity summary", () => {
    const output = buildReviewOutput([
      { scanner_id: "debug-console-log", severity: "LOW", fix_type: "AUTO_FIX", file: "src/a.ts", description: "debug" },
      { rule_id: "custom-risk", severity: "HIGH", fix_type: "MANUAL_REVIEW", file: "src/b.ts", message: "risk" },
    ], { source: "review-scanner", now: "2026-05-24T00:00:00.000Z" });

    assert.equal(output.schema, REVIEW_OUTPUT_SCHEMA);
    assert.equal(output.generated_at, "2026-05-24T00:00:00.000Z");
    assert.equal(output.summary.total, 2);
    assert.equal(output.summary.high, 1);
    assert.equal(output.summary.low, 1);
    assert.equal(output.findings.every((finding) => finding.schema === REVIEW_FINDING_SCHEMA), true);
  });

  test("summary and validation are deterministic for normalized arrays", () => {
    const findings = normalizeReviewFindings([
      { code: "A", severity: "INFO", fix_type: "INFO", message: "note" },
      { code: "B", severity: "UNKNOWN", fix_type: "UNKNOWN", message: "unknown" },
    ], { source: "unit" });

    assert.deepEqual(summarizeReviewFindings(findings), {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 1,
      unknown: 1,
      total: 2,
    });
    assert.equal(validateReviewFinding(findings[0]).ok, true);
  });
});
