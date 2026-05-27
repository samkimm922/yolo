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
    execFileSync: () => JSON.stringify([]),
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
