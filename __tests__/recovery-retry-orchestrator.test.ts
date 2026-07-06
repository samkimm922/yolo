import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRetryPhase } from "../src/runtime/recovery/retry-orchestrator.js";

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "yolo-retry-orchestrator-"));
  mkdirSync(join(root, "data"), { recursive: true });
  return root;
}

function taskResults(overrides = {}) {
  return {
    completed: [],
    failed: [],
    skipped: [],
    blocked: [],
    contractReview: [],
    ...overrides,
  };
}

test("runRetryPhase blocks missing failed task definitions without running mainLoop", async () => {
  const root = tempDir();
  const logs = [];
  try {
    const results = taskResults({ failed: ["MISSING"] });
    await runRetryPhase({
      prd: { id: "PRD", title: "Retry missing", tasks: [] },
      prdPath: join(root, "data", "prd.json"),
      taskResults: results,
      runId: "run-test",
      yoloRoot: root,
      expandedTasksFile: join(root, "state", "expanded-tasks.json"),
      progress: { total: 1, done: 0, failed: 1 },
      maxRetryRounds: 3,
      mainLoop: async () => {
        throw new Error("mainLoop should not run");
      },
      logProgress: (...args) => logs.push(args),
    });

    assert.deepEqual(results.failed, ["MISSING"]);
    assert.ok(logs.some(([, phase, detail]) => phase === "BLOCKED" && detail.includes("MISSING")));
    assert.ok(logs.some(([, phase]) => phase === "STOP"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runRetryPhase executes retry PRDs, syncs completions, and cleans retry files", async () => {
  const root = tempDir();
  const updates = [];
  let retryPrdPath;
  try {
    const results = taskResults({ failed: ["FIX-1"] });
    const prd = {
      id: "PRD",
      title: "Retry success",
      tasks: [{ id: "FIX-1", status: "failed", task_kind: "feature" }],
    };

    await runRetryPhase({
      prd,
      prdPath: join(root, "data", "prd.json"),
      taskResults: results,
      resumeCompleted: new Set(["DONE-ALREADY"]),
      runId: "run-parent",
      yoloRoot: root,
      expandedTasksFile: join(root, "state", "expanded-tasks.json"),
      progress: { total: 1, done: 2, failed: 1 },
      maxRetryRounds: 3,
      mainLoop: async (filePath, retryCompleted) => {
        retryPrdPath = filePath;
        const retryPrd = JSON.parse(readFileSync(filePath, "utf8"));
        assert.equal(retryPrd.retry_round, 1);
        assert.deepEqual(retryPrd.tasks, [{ id: "FIX-1", status: "pending", task_kind: "feature" }]);
        assert.equal(retryCompleted.has("DONE-ALREADY"), true);
        return { completed: ["FIX-1"], failed: [], skipped: [], blocked: [], contractReview: [] };
      },
      taskPostconditionsPass: () => ({ passed: true, failed: [] }),
      updateTaskStatus: (id, update) => updates.push({ id, update }),
    });

    assert.deepEqual(results.completed, ["FIX-1"]);
    assert.deepEqual(results.failed, []);
    assert.deepEqual(updates, [{
      id: "FIX-1",
      update: {
        status: "done",
        phase: "done",
        completedViaRetry: true,
        failReason: undefined,
      },
    }]);
    assert.equal(existsSync(retryPrdPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runRetryPhase drops dependencies already completed outside the retry PRD", async () => {
  const root = tempDir();
  try {
    const results = taskResults({ completed: ["DONE-ALREADY"], failed: ["FIX-LATE"] });
    const prd = {
      id: "PRD",
      title: "Retry dependency pruning",
      tasks: [
        { id: "DONE-ALREADY", status: "done", task_kind: "feature" },
        { id: "FIX-LATE", status: "failed", task_kind: "feature", depends_on: ["DONE-ALREADY"] },
      ],
    };

    await runRetryPhase({
      prd,
      prdPath: join(root, "data", "prd.json"),
      taskResults: results,
      resumeCompleted: new Set(["DONE-ALREADY"]),
      runId: "run-parent",
      yoloRoot: root,
      expandedTasksFile: join(root, "state", "expanded-tasks.json"),
      progress: { total: 2, done: 1, failed: 1 },
      maxRetryRounds: 3,
      mainLoop: async (filePath) => {
        const retryPrd = JSON.parse(readFileSync(filePath, "utf8"));
        assert.deepEqual(retryPrd.tasks, [
          { id: "FIX-LATE", status: "pending", task_kind: "feature", depends_on: [] },
        ]);
        return { completed: ["FIX-LATE"], failed: [], skipped: [], blocked: [], contractReview: [] };
      },
      taskPostconditionsPass: () => ({ passed: true, failed: [] }),
      updateTaskStatus: () => {},
    });

    assert.deepEqual(results.failed, []);
    assert.deepEqual(results.completed, ["DONE-ALREADY", "FIX-LATE"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
