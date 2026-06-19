import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { severityToPriority, SEVERITY_PRIORITY_ENTRIES } from "../src/lib/severity-priority.js";
import { scannerToTasks } from "../src/lib/scanner-to-task.js";
import { reviewFindingsToPrdTasks } from "../src/review/findings-to-tasks.js";

describe("severity to priority mapping is unified across review pipelines", () => {
  test("canonical mapping: CRITICAL→P0, HIGH→P1, MEDIUM→P2, LOW/default→P3", () => {
    assert.equal(severityToPriority("CRITICAL"), "P0");
    assert.equal(severityToPriority("HIGH"), "P1");
    assert.equal(severityToPriority("MEDIUM"), "P2");
    assert.equal(severityToPriority("LOW"), "P3");
    assert.equal(severityToPriority(""), "P3");
    assert.equal(severityToPriority(undefined), "P3");
    // Case-insensitive.
    assert.equal(severityToPriority("critical"), "P0");
    assert.equal(severityToPriority("  High  "), "P1");
  });

  test("P8.M6: scannerToTasks and reviewFindingsToPrdTasks agree on severity→priority", () => {
    for (const severity of ["CRITICAL", "HIGH", "MEDIUM", "LOW"]) {
      const scannerResult = scannerToTasks([{
        scanner_id: `rule-${severity}`,
        severity,
        fix_type: "CLAUDE_FIX",
        file: `src/${severity.toLowerCase()}.ts`,
        line: 1,
        description: `${severity} finding`,
        match: "pattern",
      }], 1);
      const reviewResult = reviewFindingsToPrdTasks([{
        finding_id: `finding-${severity}`,
        scanner_id: `rule-${severity}`,
        severity,
        description: `${severity} finding`,
        file: `src/${severity.toLowerCase()}.ts:1`,
        match: "pattern",
      }], { round: 1 });

      const scannerPriority = scannerResult.claudeFixTasks[0]?.priority;
      const reviewPriority = reviewResult.tasks[0]?.priority;
      const canonical = severityToPriority(severity);

      assert.equal(
        scannerPriority,
        canonical,
        `scannerToTasks must map ${severity} to ${canonical}, got ${scannerPriority}`,
      );
      assert.equal(
        reviewPriority,
        canonical,
        `reviewFindingsToPrdTasks must map ${severity} to ${canonical}, got ${reviewPriority}`,
      );
      assert.equal(
        scannerPriority,
        reviewPriority,
        `${severity} must produce the same priority in both pipelines`,
      );
    }
  });

  test("P8.M6: CRITICAL findings are P0 ship blockers in both pipelines", () => {
    // Before unification, scannerToTasks mapped CRITICAL→P1, which let a
    // scanner-driven critical fix land below a review-driven critical fix.
    // Both pipelines must now treat CRITICAL as P0.
    assert.equal(SEVERITY_PRIORITY_ENTRIES.CRITICAL, "P0");

    const scannerCritical = scannerToTasks([{
      scanner_id: "rule-crit",
      severity: "CRITICAL",
      fix_type: "CLAUDE_FIX",
      file: "src/crit.ts",
      line: 1,
      description: "critical",
      match: "x",
    }], 1);
    assert.equal(scannerCritical.claudeFixTasks[0].priority, "P0");

    const reviewCritical = reviewFindingsToPrdTasks([{
      finding_id: "F-crit",
      severity: "CRITICAL",
      description: "critical",
      file: "src/crit.ts:1",
      match: "x",
    }], { round: 1 });
    assert.equal(reviewCritical.tasks[0].priority, "P0");
    assert.equal(reviewCritical.tasks[0].must_fix_before_ship, true);
  });

  test("scannerToTasks emits one review_fix task per source finding with machine closure checks", () => {
    const result = scannerToTasks([{
      finding_id: "REV-SINGLE-001",
      scanner_id: "xss-innerHTML",
      severity: "HIGH",
      fix_type: "CLAUDE_FIX",
      file: "src/profile.tsx",
      line: 12,
      description: "Remove unsafe innerHTML usage",
      match: "innerHTML",
    }], 3);

    assert.equal(result.autoFixTasks.length, 0);
    assert.equal(result.claudeFixTasks.length, 1);
    const task = result.claudeFixTasks[0];
    assert.equal(task.id, "FIX-R3-001");
    assert.equal(task.task_kind, "review_fix");
    assert.deepEqual(task.source_finding_ids, ["REV-SINGLE-001"]);
    assert.deepEqual(task.fix_findings.map((finding) => finding.finding_id), ["REV-SINGLE-001"]);
    assert.ok(task.post_conditions.some((condition) =>
      condition.type === "code_not_contains" &&
      condition.severity === "FAIL" &&
      condition.params.source_finding_id === "REV-SINGLE-001"
    ));
  });
});
