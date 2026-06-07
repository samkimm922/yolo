import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runReviewLoop } from "../src/runtime/review-loop/orchestrator.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");

function emptyTaskResults() {
  return {
    completed: [],
    failed: [],
    skipped: [],
    blocked: [],
    contractReview: [],
  };
}

function emptyCoveredScan() {
  return JSON.stringify({
    scanner_version: "test-review-scanner@1",
    scanned_files: ["src/app.js"],
    rules: ["R-test"],
    expected_scope: ["src/app.js"],
    coverage_status: "complete",
    findings: [],
  });
}

test("runReviewLoop skips dry-run PRDs before scanner execution", async () => {
  const logs = [];
  const prd = {
    id: "DRY-RUN-PLAN",
    execution_mode: "dry_run",
    tasks: [{ id: "DRY-1", task_kind: "dry_run_artifact" }],
  };

  const result = await runReviewLoop({
    prd,
    prdPath: "/tmp/dry-run-prd.json",
    taskResults: emptyTaskResults(),
    runId: "run-test",
    yoloRoot: YOLO_DIR,
    rootDir: YOLO_DIR,
    progress: { total: 0, done: 0, failed: 0 },
    maxReviewRounds: 2,
    execFileSync: () => {
      throw new Error("scanner should not run");
    },
    mainLoop: async () => {
      throw new Error("mainLoop should not run");
    },
    loadPRD: () => prd,
    logProgress: (...args) => logs.push(args),
  });

  assert.deepEqual(result.failed, []);
  assert.ok(logs.some(([, phase, detail]) => phase === "SKIP" && detail.includes("禁止 review")));
});

test("runReviewLoop exits cleanly when scanner has no findings", async () => {
  const reviewDone = [];
  const prd = {
    id: "PRD-REVIEW-CLEAN",
    tasks: [{
      id: "FIX-1",
      type: "bugfix",
      task_kind: "bugfix",
      scope: { targets: [{ file: "src/app.js" }] },
    }],
  };

  const result = await runReviewLoop({
    prd,
    prdPath: "/tmp/clean-prd.json",
    taskResults: emptyTaskResults(),
    runId: "run-test",
    yoloRoot: YOLO_DIR,
    rootDir: YOLO_DIR,
    progress: { total: 1, done: 0, failed: 0 },
    maxReviewRounds: 2,
    execFileSync: () => emptyCoveredScan(),
    mainLoop: async () => {
      throw new Error("mainLoop should not run");
    },
    loadPRD: () => prd,
    normalizeRepoPath: (value) => value,
    logReviewDone: (...args) => reviewDone.push(args),
  });

  assert.deepEqual(result.failed, []);
  assert.ok(reviewDone.some(([status]) => status === "pass"));
});

test("runReviewLoop blocks empty findings without scanner coverage artifact", async () => {
  const prd = {
    id: "PRD-REVIEW-CLEAN-NO-COVERAGE",
    tasks: [{
      id: "FIX-1",
      type: "bugfix",
      task_kind: "bugfix",
      scope: { targets: [{ file: "src/app.js" }] },
    }],
  };

  const result = await runReviewLoop({
    prd,
    prdPath: "/tmp/clean-no-coverage-prd.json",
    taskResults: emptyTaskResults(),
    runId: "run-test",
    yoloRoot: YOLO_DIR,
    rootDir: YOLO_DIR,
    progress: { total: 1, done: 0, failed: 0 },
    maxReviewRounds: 1,
    execFileSync: () => JSON.stringify([]),
    mainLoop: async () => {
      throw new Error("mainLoop should not run");
    },
    loadPRD: () => prd,
    normalizeRepoPath: (value) => value,
  });

  assert.deepEqual(result.failed, ["REVIEW-SCANNER-COVERAGE-MISSING"]);
  assert.deepEqual(result.blocked, ["REVIEW-SCANNER-COVERAGE-MISSING"]);
  assert.equal(result.review_outcome.status, "blocked");
  assert.equal(result.review_outcome.reason, "scanner_coverage_missing");
});

test("runReviewLoop fails closed after three scanner exec failures", async () => {
  let scannerRuns = 0;
  const prd = {
    id: "PRD-REVIEW-SCANNER-EXEC-FAIL",
    tasks: [{
      id: "FIX-1",
      type: "bugfix",
      task_kind: "bugfix",
      scope: { targets: [{ file: "src/app.js" }] },
    }],
  };

  const result = await runReviewLoop({
    prd,
    prdPath: "/tmp/scanner-exec-fail-prd.json",
    taskResults: emptyTaskResults(),
    runId: "run-test",
    yoloRoot: YOLO_DIR,
    rootDir: YOLO_DIR,
    progress: { total: 1, done: 0, failed: 0 },
    maxReviewRounds: 3,
    execFileSync: () => {
      scannerRuns++;
      throw new Error("scanner crashed");
    },
    mainLoop: async () => {
      throw new Error("mainLoop should not run");
    },
    loadPRD: () => prd,
    normalizeRepoPath: (value) => value,
  });

  assert.equal(scannerRuns, 3);
  assert.deepEqual(result.failed, ["REVIEW-SCANNER-EXEC-FAILED"]);
  assert.equal(result.review_outcome.status, "failed");
  assert.equal(result.review_outcome.reason, "scanner_exec_failed");
});

test("runReviewLoop does not trust scanner stdout when the scanner process fails", async () => {
  const prd = {
    id: "PRD-REVIEW-SCANNER-STDOUT-FAIL",
    tasks: [{
      id: "FIX-1",
      type: "bugfix",
      task_kind: "bugfix",
      scope: { targets: [{ file: "src/app.js" }] },
    }],
  };

  const result = await runReviewLoop({
    prd,
    prdPath: "/tmp/scanner-stdout-fail-prd.json",
    taskResults: emptyTaskResults(),
    runId: "run-test",
    yoloRoot: YOLO_DIR,
    rootDir: YOLO_DIR,
    progress: { total: 1, done: 0, failed: 0 },
    maxReviewRounds: 1,
    execFileSync: () => {
      throw Object.assign(new Error("scanner crashed after writing stdout"), { stdout: "[]\n" });
    },
    mainLoop: async () => {
      throw new Error("mainLoop should not run");
    },
    loadPRD: () => prd,
    normalizeRepoPath: (value) => value,
  });

  assert.deepEqual(result.failed, ["REVIEW-SCANNER-EXEC-FAILED"]);
  assert.equal(result.review_outcome.reason, "scanner_exec_failed");
  assert.equal(result.review_outcome.meta.stdout_sample, "[]");
});

test("runReviewLoop fails closed after three scanner non-json responses", async () => {
  let scannerRuns = 0;
  const prd = {
    id: "PRD-REVIEW-SCANNER-NON-JSON",
    tasks: [{
      id: "FIX-1",
      type: "bugfix",
      task_kind: "bugfix",
      scope: { targets: [{ file: "src/app.js" }] },
    }],
  };

  const result = await runReviewLoop({
    prd,
    prdPath: "/tmp/scanner-non-json-prd.json",
    taskResults: emptyTaskResults(),
    runId: "run-test",
    yoloRoot: YOLO_DIR,
    rootDir: YOLO_DIR,
    progress: { total: 1, done: 0, failed: 0 },
    maxReviewRounds: 3,
    execFileSync: () => {
      scannerRuns++;
      return "not json";
    },
    mainLoop: async () => {
      throw new Error("mainLoop should not run");
    },
    loadPRD: () => prd,
    normalizeRepoPath: (value) => value,
  });

  assert.equal(scannerRuns, 3);
  assert.deepEqual(result.failed, ["REVIEW-SCANNER-NON-JSON"]);
  assert.equal(result.review_outcome.status, "failed");
  assert.equal(result.review_outcome.reason, "scanner_non_json");
});

test("runReviewLoop fails closed when scanner JSON lacks review artifact", async () => {
  const prd = {
    id: "PRD-REVIEW-SCANNER-MISSING-ARTIFACT",
    tasks: [{
      id: "FIX-1",
      type: "bugfix",
      task_kind: "bugfix",
      scope: { targets: [{ file: "src/app.js" }] },
    }],
  };

  const result = await runReviewLoop({
    prd,
    prdPath: "/tmp/scanner-missing-artifact-prd.json",
    taskResults: emptyTaskResults(),
    runId: "run-test",
    yoloRoot: YOLO_DIR,
    rootDir: YOLO_DIR,
    progress: { total: 1, done: 0, failed: 0 },
    maxReviewRounds: 1,
    execFileSync: () => JSON.stringify({ ok: true }),
    mainLoop: async () => {
      throw new Error("mainLoop should not run");
    },
    loadPRD: () => prd,
    normalizeRepoPath: (value) => value,
  });

  assert.deepEqual(result.failed, ["REVIEW-SCANNER-MISSING-ARTIFACT"]);
  assert.equal(result.review_outcome.status, "failed");
  assert.equal(result.review_outcome.reason, "scanner_missing_review_artifact");
});

test("runReviewLoop reloads PRD before appending review tasks to preserve task state", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "yolo-review-loop-"));
  const prdPath = resolve(root, "prd.json");
  const stalePrd = {
    id: "PRD-REVIEW-STALE",
    tasks: [{
      id: "FIX-1",
      type: "bugfix",
      status: "pending",
      scope: { targets: [{ file: "src/app.js" }] },
    }],
  };
  const freshPrd = {
    ...stalePrd,
    tasks: [{ ...stalePrd.tasks[0], status: "completed", phase: "gate_pass" }],
  };

  try {
    writeFileSync(prdPath, JSON.stringify(freshPrd, null, 2), "utf8");

    await runReviewLoop({
      prd: stalePrd,
      prdPath,
      taskResults: emptyTaskResults(),
      runId: "run-test",
      yoloRoot: YOLO_DIR,
      rootDir: YOLO_DIR,
      progress: { total: 1, done: 0, failed: 0 },
      maxReviewRounds: 1,
      maxReviewTasksPerRound: 5,
      execFileSync: () => JSON.stringify([{
        scanner_id: "R6-as-any",
        severity: "MEDIUM",
        fix_type: "CLAUDE_FIX",
        dimension: "code",
        file: "src/app.js",
        line: 1,
        match: "as any",
        description: "Avoid as any",
      }]),
      mainLoop: async () => emptyTaskResults(),
      loadPRD: (path) => JSON.parse(readFileSync(path, "utf8")),
      normalizeRepoPath: (value) => value,
    });

    const written = JSON.parse(readFileSync(prdPath, "utf8"));
    assert.equal(written.tasks.find((task) => task.id === "FIX-1").status, "completed");
    assert.ok(written.tasks.some((task) => task.id.startsWith("FIX-R1-")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runReviewLoop fails closed when review fixes return only blocked tasks", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "yolo-review-fix-blocked-"));
  const prdPath = resolve(root, "prd.json");
  const prd = {
    id: "PRD-REVIEW-FIX-BLOCKED",
    tasks: [{
      id: "FIX-1",
      type: "bugfix",
      status: "pending",
      scope: { targets: [{ file: "src/app.js" }] },
    }],
  };

  try {
    writeFileSync(prdPath, JSON.stringify(prd, null, 2), "utf8");

    const result = await runReviewLoop({
      prd,
      prdPath,
      taskResults: emptyTaskResults(),
      runId: "run-test",
      yoloRoot: YOLO_DIR,
      rootDir: YOLO_DIR,
      progress: { total: 1, done: 0, failed: 0 },
      maxReviewRounds: 1,
      maxReviewTasksPerRound: 5,
      execFileSync: () => JSON.stringify([{
        scanner_id: "R-blocker",
        severity: "HIGH",
        fix_type: "CLAUDE_FIX",
        dimension: "code",
        file: "src/app.js",
        line: 1,
        match: "blocker",
        description: "Fix blocker",
      }]),
      mainLoop: async () => ({
        completed: [],
        failed: [],
        skipped: [],
        blocked: ["FIX-R1-001"],
        contractReview: [],
      }),
      loadPRD: (path) => JSON.parse(readFileSync(path, "utf8")),
      normalizeRepoPath: (value) => value,
    });

    assert.deepEqual(result.failed, ["REVIEW-FIX-BLOCKED"]);
    assert.deepEqual(result.blocked, ["FIX-R1-001", "REVIEW-FIX-BLOCKED"]);
    assert.equal(result.review_outcome.status, "blocked");
    assert.equal(result.review_outcome.reason, "review_fix_blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runReviewLoop preserves original findings when review-to-prd conversion fails", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "yolo-review-conversion-fail-"));
  const fakeYoloRoot = resolve(root, "missing-yolo-root");
  const prdPath = resolve(root, "prd.json");
  const prd = {
    id: "PRD-REVIEW-CONVERSION-FAIL",
    tasks: [{
      id: "FIX-1",
      type: "bugfix",
      status: "pending",
      scope: { targets: [{ file: "src/app.js" }] },
    }],
  };
  const finding = {
    finding_id: "F-CONVERSION",
    scanner_id: "R-conversion",
    severity: "HIGH",
    fix_type: "CLAUDE_FIX",
    dimension: "code",
    file: "src/app.js",
    line: 7,
    match: "unsafe",
    description: "Preserve this finding when converter fails.",
    must_fix_before_ship: true,
    evidence: [{ file: "src/app.js", line: 7 }],
  };

  try {
    writeFileSync(prdPath, JSON.stringify(prd, null, 2), "utf8");

    const result = await runReviewLoop({
      prd,
      prdPath,
      taskResults: emptyTaskResults(),
      runId: "run-test",
      yoloRoot: fakeYoloRoot,
      rootDir: YOLO_DIR,
      progress: { total: 1, done: 0, failed: 0 },
      maxReviewRounds: 1,
      maxReviewTasksPerRound: 5,
      execFileSync: () => JSON.stringify({ findings: [finding] }),
      mainLoop: async () => ({
        completed: [],
        failed: [],
        skipped: [],
        blocked: ["FIX-R1-CONVERSION-FAILED"],
        contractReview: [],
      }),
      loadPRD: (path) => JSON.parse(readFileSync(path, "utf8")),
      normalizeRepoPath: (value) => value,
    });

    const written = JSON.parse(readFileSync(prdPath, "utf8"));
    const preserved = written.tasks.find((task) => task.id === "FIX-R1-CONVERSION-FAILED");
    assert.equal(preserved.blocks_ship, true);
    assert.equal(preserved.review_conversion_failed.preserved_finding_count, 1);
    assert.equal(preserved.source_findings[0].finding_id, "F-CONVERSION");
    assert.deepEqual(result.failed, ["REVIEW-FIX-BLOCKED"]);
    assert.equal(result.review_outcome.reason, "review_fix_blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runReviewLoop marks review task limit as human-needed without mutating PRD", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "yolo-review-limit-"));
  const prdPath = resolve(root, "prd.json");
  const reviewErrors = [];
  const prd = {
    id: "PRD-REVIEW-LIMIT",
    tasks: [{
      id: "FIX-1",
      type: "bugfix",
      status: "pending",
      scope: { targets: [{ file: "src/app.js" }] },
    }],
  };
  const findings = [1, 2, 3].map((index) => ({
    finding_id: `F${index}`,
    scanner_id: `R-limit-${index}`,
    severity: "HIGH",
    fix_type: "CLAUDE_FIX",
    dimension: "code",
    file: `src/review-${index}.ts`,
    line: index,
    match: `bad_${index}`,
    description: `Fix review issue ${index}`,
    must_fix_before_ship: true,
    evidence: [{ file: `src/review-${index}.ts`, line: index }],
  }));

  try {
    writeFileSync(prdPath, JSON.stringify(prd, null, 2), "utf8");

    const result = await runReviewLoop({
      prd,
      prdPath,
      taskResults: emptyTaskResults(),
      runId: "run-test",
      yoloRoot: YOLO_DIR,
      rootDir: YOLO_DIR,
      progress: { total: 1, done: 0, failed: 0 },
      maxReviewRounds: 1,
      maxReviewTasksPerRound: 2,
      execFileSync: () => JSON.stringify(findings),
      mainLoop: async () => {
        throw new Error("mainLoop should not run when task limit blocks");
      },
      loadPRD: (path) => JSON.parse(readFileSync(path, "utf8")),
      normalizeRepoPath: (value) => value,
      logReviewError: (...args) => reviewErrors.push(args),
    });

    const written = JSON.parse(readFileSync(prdPath, "utf8"));
    assert.deepEqual(result.failed, ["REVIEW-TASK-LIMIT-R1"]);
    assert.deepEqual(result.blocked, ["REVIEW-TASK-LIMIT-R1"]);
    assert.equal(result.review_blocker.human_needed, true);
    assert.equal(result.review_blocker.reason, "review_task_limit");
    assert.equal(result.review_outcome.status, "blocked");
    assert.equal(result.review_outcome.reason, "review_task_limit");
    assert.equal(result.review_blocker.meta.queue_strategy, "human_needed");
    assert.equal(written.tasks.length, 1);
    assert.equal(reviewErrors[0][0], "REVIEW_TASK_LIMIT_BLOCKED");
    assert.equal(reviewErrors[0][2].human_needed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
