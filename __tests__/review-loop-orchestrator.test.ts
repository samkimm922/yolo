import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function coveredScan(findings = [], scannedFiles = ["src/app.js"]) {
  return JSON.stringify({
    coverage_artifact: {
      scanner_version: "test-review-scanner@1",
      scanned_files: scannedFiles,
      rules: ["R-test"],
      expected_scope: scannedFiles,
      coverage_status: "complete",
    },
    findings,
  });
}

function emptyCoveredScan() {
  return coveredScan();
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

test("runReviewLoop converts one finding into one review_fix task with non-empty post conditions", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "yolo-review-one-finding-"));
  const prdPath = resolve(root, "prd.json");
  const prd = {
    id: "PRD-REVIEW-ONE-FINDING",
    tasks: [{
      id: "BASE-1",
      type: "bugfix",
      status: "completed",
      requirement_ids: ["REQ-BASE-1"],
      design_ids: ["DES-BASE-1"],
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
      execFileSync: () => JSON.stringify({
        coverage_artifact: {
          scanner_version: "test-review-scanner@1",
          scanned_files: ["src/app.js"],
          rules: ["R6-as-any"],
          expected_scope: ["src/app.js"],
          coverage_status: "complete",
        },
        findings: [{
          finding_id: "REV-ONE",
          scanner_id: "R6-as-any",
          severity: "MEDIUM",
          fix_type: "CLAUDE_FIX",
          dimension: "code",
          file: "src/app.js",
          line: 1,
          match: "as any",
          description: "Avoid as any",
        }],
      }),
      mainLoop: async () => emptyTaskResults(),
      loadPRD: (path) => JSON.parse(readFileSync(path, "utf8")),
      normalizeRepoPath: (value) => value,
    });

    const written = JSON.parse(readFileSync(prdPath, "utf8"));
    const reviewTasks = written.tasks.filter((task) => task.task_kind === "review_fix");
    assert.equal(reviewTasks.length, 1);
    assert.deepEqual(reviewTasks[0].source_finding_ids, ["REV-ONE"]);
    assert.deepEqual(reviewTasks[0].requirement_ids, ["REQ-BASE-1"]);
    assert.deepEqual(reviewTasks[0].design_ids, ["DES-BASE-1"]);
    assert.deepEqual(reviewTasks[0].evidence_files, ["review-report.json#REV-ONE"]);
    assert.ok(reviewTasks[0].post_conditions.length > 0);
    assert.ok(reviewTasks[0].post_conditions.some((condition) =>
      condition.type === "code_not_contains" &&
      condition.severity === "FAIL" &&
      condition.params.source_finding_id === "REV-ONE"
    ));
    assert.deepEqual(result.failed, ["FIX-R1-001", "REVIEW-FINDINGS-PERSISTED"]);
    assert.deepEqual(result.blocked, ["REVIEW-FINDINGS-PERSISTED"]);
    assert.equal(result.review_outcome.reason, "review_findings_persisted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      execFileSync: () => coveredScan([{
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
      execFileSync: () => coveredScan([{
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

test("runReviewLoop fallback classifier still writes canonical review_fix tasks when dynamic import fails", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "yolo-review-fallback-classifier-"));
  const fakeYoloRoot = resolve(root, "missing-yolo-root");
  const prdPath = resolve(root, "prd.json");
  const prd = {
    id: "PRD-REVIEW-FALLBACK-CLASSIFIER",
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
      execFileSync: () => coveredScan([finding]),
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

    const written = JSON.parse(readFileSync(prdPath, "utf8"));
    const preserved = written.tasks.find((task) => task.id === "FIX-R1-001");
    assert.equal(preserved.task_kind, "review_fix");
    assert.deepEqual(preserved.source_finding_ids, ["F-CONVERSION"]);
    assert.ok(preserved.post_conditions.some((condition) => condition.type === "target_file_modified" && condition.severity === "FAIL"));
    assert.ok(preserved.post_conditions.some((condition) =>
      condition.type === "code_not_contains" &&
      condition.severity === "FAIL" &&
      condition.params.source_finding_id === "F-CONVERSION"
    ));
    assert.deepEqual(result.failed, ["REVIEW-FIX-BLOCKED"]);
    assert.equal(result.review_outcome.reason, "review_fix_blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runReviewLoop loads auto-fix from dist src layout", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "yolo-review-autofix-dist-src-"));
  const fakeYoloRoot = resolve(root, "fake-dist");
  const prdPath = resolve(root, "prd.json");
  const reviewErrors = [];
  const prd = {
    id: "PRD-REVIEW-AUTOFIX-DIST-SRC",
    tasks: [{
      id: "BASE-1",
      type: "bugfix",
      status: "completed",
      scope: { targets: [{ file: "src/app.js" }] },
    }],
  };
  const finding = {
    finding_id: "REV-AUTO",
    scanner_id: "R-console-log",
    severity: "LOW",
    fix_type: "AUTO_FIX",
    dimension: "code",
    file: "src/app.js",
    line: 1,
    match: "console.log",
    description: "Remove console.log",
  };
  let scanRuns = 0;

  try {
    mkdirSync(resolve(fakeYoloRoot, "src/lib"), { recursive: true });
    writeFileSync(resolve(fakeYoloRoot, "src/lib/auto-fix.js"), `
      export async function applyAutoFixTasks() {
        return { stats: { fixed: 1 }, escalatedTasks: [], modifiedFiles: ["src/app.js"] };
      }
    `, "utf8");
    writeFileSync(prdPath, JSON.stringify(prd, null, 2), "utf8");

    const result = await runReviewLoop({
      prd,
      prdPath,
      taskResults: emptyTaskResults(),
      runId: "run-test",
      yoloRoot: fakeYoloRoot,
      rootDir: root,
      progress: { total: 1, done: 0, failed: 0 },
      maxReviewRounds: 2,
      maxReviewTasksPerRound: 5,
      execFileSync: () => {
        scanRuns++;
        return scanRuns === 1 ? coveredScan([finding]) : emptyCoveredScan();
      },
      mainLoop: async () => {
        throw new Error("mainLoop should not run after AUTO_FIX succeeds");
      },
      loadPRD: (path) => JSON.parse(readFileSync(path, "utf8")),
      normalizeRepoPath: (value) => value,
      logReviewError: (...args) => reviewErrors.push(args),
    });

    assert.equal(scanRuns, 2);
    assert.deepEqual(result.failed, []);
    assert.equal(reviewErrors.some(([title]) => title === "AUTO_FIX 异常"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runReviewLoop blocks when the same completed review finding persists across rounds", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "yolo-review-persisted-finding-"));
  const prdPath = resolve(root, "prd.json");
  const prd = {
    id: "PRD-REVIEW-PERSISTED-FINDING",
    tasks: [{
      id: "BASE-1",
      type: "bugfix",
      status: "completed",
      scope: { targets: [{ file: "src/app.js" }] },
    }],
  };
  const finding = {
    finding_id: "REV-PERSIST",
    scanner_id: "R6-as-any",
    severity: "HIGH",
    fix_type: "CLAUDE_FIX",
    dimension: "code",
    file: "src/app.js",
    line: 1,
    match: "as any",
    description: "Avoid as any",
  };
  let scanRuns = 0;

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
      maxReviewRounds: 3,
      maxReviewTasksPerRound: 5,
      execFileSync: () => {
        scanRuns++;
        return JSON.stringify({
          coverage_artifact: {
            scanner_version: "test-review-scanner@1",
            scanned_files: ["src/app.js"],
            rules: ["R6-as-any"],
            expected_scope: ["src/app.js"],
            coverage_status: "complete",
          },
          findings: [finding],
        });
      },
      mainLoop: async () => {
        const latest = JSON.parse(readFileSync(prdPath, "utf8"));
        for (const task of latest.tasks) {
          if (task.task_kind === "review_fix") task.status = "completed";
        }
        writeFileSync(prdPath, JSON.stringify(latest, null, 2), "utf8");
        return {
          completed: ["FIX-R1-001"],
          failed: [],
          skipped: [],
          blocked: [],
          contractReview: [],
        };
      },
      loadPRD: (path) => JSON.parse(readFileSync(path, "utf8")),
      normalizeRepoPath: (value) => value,
    });

    const written = JSON.parse(readFileSync(prdPath, "utf8"));
    assert.equal(scanRuns, 2);
    assert.equal(written.tasks.filter((task) => task.task_kind === "review_fix").length, 1);
    assert.deepEqual(result.failed, ["REVIEW-FINDINGS-PERSISTED"]);
    assert.deepEqual(result.blocked, ["REVIEW-FINDINGS-PERSISTED"]);
    assert.equal(result.review_outcome.status, "blocked");
    assert.equal(result.review_outcome.reason, "review_findings_persisted");
    assert.equal(result.review_outcome.meta.persisted_findings[0].finding_id, "REV-PERSIST");
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
      execFileSync: () => coveredScan(findings),
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
