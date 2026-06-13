import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMainLoopWithRuntime } from "../src/runtime/task-loop/main-loop.js";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "yolo-main-loop-"));
}

test("runMainLoopWithRuntime executes pending tasks and updates snapshots", async () => {
  const root = makeTempDir();
  try {
    const expandedTasksFile = join(root, "state", "expanded-tasks.json");
    const progress = { total: 0, done: 0, failed: 0 };
    const runResultsTracker = { completed: new Set(), failed: [] };
    const logs = [];
    const transitions = [];
    const task = {
      id: "FIX-P36-001",
      title: "Fix one",
      priority: "P1",
      status: "pending",
      depends_on: [],
      scope: { targets: [{ file: "src/a.ts" }] },
    };

    const result = await runMainLoopWithRuntime({
      prdPath: join(root, "prd.json"),
      preCompleted: new Set(),
      mode: "fix",
      rootDir: root,
      yoloRoot: root,
      expandedTasksFile,
      progress,
      runResultsTracker,
      priorityOrder: { P0: 0, P1: 1, P2: 2, P3: 3 },
      loadPRD: () => ({ version: "2.0", tasks: [task] }),
      runTask: async () => ({ status: "completed" }),
      updateTaskStatus: () => {},
      recordTaskTransition: (transition) => transitions.push(transition),
      taskCountsAsCompleted: (item) => item?.status === "done" || item?.status === "completed",
      taskIsSplitParent: () => false,
      skippedTaskPostconditionsPass: () => ({ passed: true, failed: [] }),
      log: (...args) => logs.push(args),
    });

    assert.deepEqual(result.completed, ["FIX-P36-001"]);
    assert.equal(progress.total, 1);
    assert.equal(progress.done, 1);
    assert.equal(runResultsTracker.completed.has("FIX-P36-001"), true);
    assert.equal(existsSync(expandedTasksFile), true);
    const snapshot = JSON.parse(readFileSync(expandedTasksFile, "utf8"));
    assert.equal(snapshot.tasks[0].id, "FIX-P36-001");
    assert.equal(snapshot.tasks[0].status, "done");
    assert.deepEqual(transitions, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runMainLoopWithRuntime stops before unrelated work when immediate remediation is required", async () => {
  const root = makeTempDir();
  try {
    const expandedTasksFile = join(root, "state", "expanded-tasks.json");
    const progress = { total: 0, done: 0, failed: 0 };
    const runResultsTracker = { completed: new Set(), failed: [] };
    const tasks = [
      {
        id: "FIX-HARNESS-001",
        title: "Fix harness evidence",
        priority: "P1",
        status: "pending",
        depends_on: [],
        scope: { targets: [{ file: "src/a.ts" }] },
      },
      {
        id: "FEATURE-002",
        title: "Unrelated feature",
        priority: "P2",
        status: "pending",
        depends_on: [],
        scope: { targets: [{ file: "src/b.ts" }] },
      },
    ];
    const runCalls = [];

    const result = await runMainLoopWithRuntime({
      prdPath: join(root, "prd.json"),
      preCompleted: new Set(),
      mode: "fix",
      rootDir: root,
      yoloRoot: root,
      expandedTasksFile,
      progress,
      runResultsTracker,
      priorityOrder: { P0: 0, P1: 1, P2: 2, P3: 3 },
      loadPRD: () => ({ version: "2.0", tasks }),
      runTask: async (task) => {
        runCalls.push(task.id);
        return {
          status: "failed",
          reason: "fixture evidence missing",
          remediation: {
            action: "AUTO_REMEDIATE",
            status: "blocked_pending_remediation",
            automation_can_continue: true,
            blocks_ship: true,
            next_actions: ["Regenerate fixture evidence, then rerun the strict harness."],
          },
        };
      },
      updateTaskStatus: () => {},
      recordTaskTransition: () => {},
      taskCountsAsCompleted: (item) => item?.status === "done" || item?.status === "completed",
      taskIsSplitParent: () => false,
      skippedTaskPostconditionsPass: () => ({ passed: true, failed: [] }),
      log: () => {},
    });

    assert.deepEqual(runCalls, ["FIX-HARNESS-001"]);
    assert.deepEqual(result.failed, ["FIX-HARNESS-001"]);
    assert.deepEqual(result.immediateRemediationQueue, [
      {
        source_task_id: "FIX-HARNESS-001",
        routing: "before_next_feature_task",
        reason: "harness_remediation_must_be_cleared_before_new_work",
        action: "AUTO_REMEDIATE",
        status: "blocked_pending_remediation",
        next_actions: ["Regenerate fixture evidence, then rerun the strict harness."],
      },
    ]);
    assert.equal(progress.failed, 1);
    assert.equal(progress.done, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
