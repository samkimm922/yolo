import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  autoFixErrorFallback,
  buildReviewScannerArgs,
  normalizeAutoFixResult,
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

  test("shouldStopReviewAfterFailure follows the max failure threshold", () => {
    assert.equal(shouldStopReviewAfterFailure(2), false);
    assert.equal(shouldStopReviewAfterFailure(3), true);
    assert.equal(shouldStopReviewAfterFailure(4, 5), false);
    assert.equal(shouldStopReviewAfterFailure(5, 5), true);
  });

  test("normalizeAutoFixResult returns escalations, count, summary, and gate metadata", () => {
    const task = { id: "FIX-R1-001" };
    assert.deepEqual(normalizeAutoFixResult({
      escalatedTasks: [task],
      stats: { fixed: 2, skipped: 1 },
    }), {
      escalatedFromAuto: [task],
      autoFixedCount: 2,
      summary: "AUTO_FIX 完成: 2 已修复, 1 升级为 CLAUDE_FIX",
      gateMeta: {
        phase: "AUTO_FIX_RESULT",
        stats: { fixed: 2, skipped: 1 },
        escalated: ["FIX-R1-001"],
      },
    });
  });

  test("autoFixErrorFallback escalates all auto-fix tasks", () => {
    const tasks = [{ id: "AUTO-FIX-R1-001" }];
    assert.deepEqual(autoFixErrorFallback(tasks), {
      escalatedFromAuto: tasks,
      autoFixedCount: 0,
    });
  });
});
