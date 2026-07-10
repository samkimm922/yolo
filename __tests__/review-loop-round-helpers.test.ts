import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewPreCompletedSet,
  contractReviewFindings,
  ensureReviewTaskShape,
  fallbackClassifyFindings,
  isDryRunPrd,
  mergeReviewResults,
  pendingReviewTasks,
  reviewClassifierMeta,
  reviewIssueLogInput,
  reviewScopeFilesForPrd,
  shouldSkipReviewForPrd,
} from "../src/runtime/review-loop/round-helpers.js";

describe("review-loop round helpers", () => {
  test("shouldSkipReviewForPrd blocks dry-run and report-only PRDs", () => {
    assert.equal(isDryRunPrd({ execution_mode: "dry_run" }), true);
    assert.equal(isDryRunPrd({ review_policy: { allow_prd_mutation: false } }), true);
    assert.equal(isDryRunPrd({ id: "DRY-RUN-PLAN" }), true);
    assert.equal(isDryRunPrd({ tasks: [{ task_kind: "dry_run_artifact" }] }), true);
    assert.equal(shouldSkipReviewForPrd({ review_policy: { mode: "report_only" } }), true);
    assert.equal(shouldSkipReviewForPrd({ review_policy: { mode: "disabled" } }), true);
    assert.equal(shouldSkipReviewForPrd({ tasks: [{ task_kind: "feature" }] }), false);
  });

  test("reviewScopeFilesForPrd collects unique src code targets unless review scope is full", () => {
    const prd = {
      tasks: [
        { scope: { targets: [{ file: "./src/a.ts" }, { file: "README.md" }] } },
        { scope: { targets: [{ file: "src/a.ts" }, { file: "src/b.test.tsx" }] } },
      ],
    };

    assert.deepEqual(reviewScopeFilesForPrd(prd, {
      normalizeRepoPath: (value) => String(value).replace(/^\.\//, ""),
    }), ["src/a.ts", "src/b.test.tsx"]);
    assert.deepEqual(reviewScopeFilesForPrd({ ...prd, review_policy: { scope: "full" } }), []);
  });

  test("fallbackClassifyFindings turns findings into provider executor tasks", () => {
    const classified = fallbackClassifyFindings([
      { fix_type: "INFO", description: "FYI" },
      { finding_id: "F-A", fix_type: "CLAUDE_FIX", description: "Fix this", severity: "HIGH", files: ["src/a.ts:10"], match: "badA" },
      { finding_id: "F-B", description: "Fix that", files: ["src/b.ts"], match: "badB" },
    ], 2);

    assert.equal(classified.infoCount, 1);
    assert.equal(classified.executorTasks.length, 2);
    assert.equal(classified.executorTasks[0].id, "FIX-R2-001");
    assert.equal(classified.executorTasks[0].task_kind, "review_fix");
    assert.equal(classified.executorTasks[0].fix_type, "CLAUDE_FIX");
    assert.deepEqual(classified.executorTasks[0].source_finding_ids, ["F-A"]);
    assert.deepEqual(classified.executorTasks[0].scope.targets, [{ file: "src/a.ts" }]);
    assert.ok(classified.executorTasks[0].post_conditions.some((condition) => condition.type === "target_file_modified" && condition.severity === "FAIL"));
    assert.ok(classified.executorTasks[0].post_conditions.some((condition) =>
      condition.type === "code_not_contains" &&
      condition.severity === "FAIL" &&
      condition.params.source_finding_id === "F-A"
    ));
    assert.ok(classified.executorTasks[0].post_conditions.some((condition) => condition.type === "no_new_type_errors" && condition.severity === "FAIL"));
  });

  test("groups same-file same-rule mechanical findings before applying the review task limit", () => {
    const classified = fallbackClassifyFindings(
      Array.from({ length: 8 }, (_, index) => ({
        finding_id: `AUTO-${index + 1}`,
        scanner_id: "debug-console-log",
        fix_type: "AUTO_FIX",
        severity: "LOW",
        file: "src/a.ts",
        line: index + 1,
        match: `console.log(${index + 1})`,
        description: `Remove console.log at line ${index + 1}`,
        suggested_fix: "Remove the debug-only console call.",
      })),
      3,
    );

    assert.equal(classified.executorTasks.length, 1);
    assert.equal(classified.executorTasks[0].fix_type, "CLAUDE_FIX");
    assert.deepEqual(classified.executorTasks[0].source_finding_ids, [
      "AUTO-1", "AUTO-2", "AUTO-3", "AUTO-4", "AUTO-5", "AUTO-6", "AUTO-7", "AUTO-8",
    ]);
    assert.equal(classified.executorTasks[0].source_findings.length, 8);
    assert.equal(classified.executorTasks[0].recipe_hint.rule_id, "debug-console-log");
  });

  test("contractReviewFindings selects ship-blocking review findings", () => {
    const findings = contractReviewFindings([
      { description: "plain" },
      { finding_id: "F1" },
      { must_fix_before_ship: true },
      { evidence: [] },
    ]);

    assert.equal(findings.length, 3);
    assert.deepEqual(findings.map((finding) => finding.schema), [
      "yolo.review.finding.v1",
      "yolo.review.finding.v1",
      "yolo.review.finding.v1",
    ]);
    assert.equal(findings[0].finding_id, "F1");
    assert.equal(findings[1].must_fix_before_ship, true);
    assert.deepEqual(findings[2].evidence, []);
  });

  test("review metadata helpers build classifier and issue log payloads", () => {
    assert.deepEqual(reviewClassifierMeta({
      round: 1,
      findings: [{}, {}],
      executorTasks: [{ id: "FIX-R1-001" }, { id: "FIX-R1-002" }],
      infoCount: 3,
    }), {
      round: 1,
      total_findings: 2,
      executor_tasks: 2,
      info_count: 3,
      executor_task_ids: ["FIX-R1-001", "FIX-R1-002"],
    });

    assert.deepEqual(reviewIssueLogInput({
      severity: "HIGH",
      files: ["src/a.ts:42"],
      description: "bad code",
      fix_type: "CLAUDE_FIX",
      finding_id: "F1",
      rule_id: "R1",
    }), {
      schema_version: "1.0",
      schema: "yolo.review.finding.v1",
      severity: "HIGH",
      file: "src/a.ts",
      line: 42,
      message: "bad code",
      code: "R1",
      source: "review-log",
      fix_type: "CLAUDE_FIX",
      finding_id: "F1",
      rule_id: "R1",
      scanner_id: "R1",
      suggested_fix: null,
    });
  });

  test("task and result helpers preserve review-loop behavior", () => {
    const task = { id: "FIX-R1-001" };
    assert.equal(ensureReviewTaskShape(task), task);
    assert.deepEqual(task, {
      id: "FIX-R1-001",
      scope: { targets: [] },
      pre_conditions: [],
      post_conditions: [],
      acceptance_criteria: [],
    });

    assert.deepEqual([...buildReviewPreCompletedSet({
      resumeCompleted: new Set(["A"]),
      completed: ["B"],
      skipped: ["C"],
    })], ["A", "B", "C"]);

    const taskResults = { completed: ["A"], failed: [], skipped: [], blocked: [] };
    assert.equal(mergeReviewResults({
      taskResults,
      reviewResults: { completed: ["A", "B"], failed: ["C"], skipped: ["D"], blocked: ["E"] },
    }), taskResults);
    assert.deepEqual(taskResults, { completed: ["A", "B"], failed: ["C"], skipped: ["D"], blocked: ["E"] });
  });

  test("pendingReviewTasks returns pending review task ids only", () => {
    assert.deepEqual(pendingReviewTasks({
      tasks: [
        { id: "FIX-R1-001", status: "pending" },
        { id: "AUTO-FIX-R1-001", status: "pending" },
        { id: "FIX-R1-002", status: "done" },
        { id: "OTHER-1", status: "pending" },
      ],
    }), [
      { id: "FIX-R1-001", status: "pending" },
      { id: "AUTO-FIX-R1-001", status: "pending" },
    ]);
  });
});
