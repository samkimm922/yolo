import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRetryCompletedSet,
  buildRetryPrd,
  cleanupRetryPrdFile,
  findRetryTaskById,
  loadExpandedTasksForRetryFile,
  mergeRetryRoundResults,
  prepareRetryTasks,
  retryBlockedFailureIds,
  syncRetryCompletions,
  writeRetryPrdFile,
} from "../src/runtime/recovery/retry-round.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "yolo-retry-round-"));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

describe("recovery retry round helpers", () => {
  test("loadExpandedTasksForRetryFile reads active expanded task snapshots defensively", () => {
    const root = tempDir();
    try {
      const filePath = join(root, "expanded-tasks.json");
      assert.deepEqual(loadExpandedTasksForRetryFile(filePath), []);

      writeFileSync(filePath, JSON.stringify({ tasks: [{ id: "FIX-P36-001" }] }), "utf8");
      assert.deepEqual(loadExpandedTasksForRetryFile(filePath), [{ id: "FIX-P36-001" }]);

      writeFileSync(filePath, "{not-json", "utf8");
      assert.deepEqual(loadExpandedTasksForRetryFile(filePath), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prepareRetryTasks prefers PRD tasks and reports missing failed ids", () => {
    const prd = {
      tasks: [{ id: "FIX-P36-001", status: "failed", source: "prd" }],
    };
    const expandedTasks = [
      { id: "FIX-P36-001", status: "failed", source: "expanded" },
      { id: "FIX-P36-002", status: "blocked", source: "expanded" },
    ];

    assert.equal(findRetryTaskById("FIX-P36-001", prd, expandedTasks).source, "prd");
    assert.deepEqual(prepareRetryTasks({
      failedIds: ["FIX-P36-001", "FIX-P36-002", "FIX-P36-003"],
      prd,
      expandedTasks,
    }), {
      retryTasks: [
        { id: "FIX-P36-001", status: "pending", source: "prd" },
        { id: "FIX-P36-002", status: "pending", source: "expanded" },
      ],
      missingRetryTaskIds: ["FIX-P36-003"],
    });
  });

  test("buildRetryPrd preserves source metadata and limits tasks to retry tasks", () => {
    const retryPrd = buildRetryPrd({
      prd: {
        id: "PRD-1",
        title: "Original",
        generated_by: "pi",
        tasks: [{ id: "OLD" }],
      },
      prdPath: "scripts/yolo/data/prd.json",
      retryTasks: [{ id: "FIX-P36-001" }],
      round: 2,
      parentRunId: "run-parent",
      normalizePrdPath: (value) => value,
    });

    assert.equal(retryPrd.title, "Original — 重试第2轮");
    assert.equal(retryPrd.source_prd, "data/prd.json");
    assert.equal(retryPrd.retry_of, "PRD-1");
    assert.equal(retryPrd.retry_round, 2);
    assert.equal(retryPrd.parent_run_id, "run-parent");
    assert.deepEqual(retryPrd.tasks, [{ id: "FIX-P36-001" }]);
  });

  test("writeRetryPrdFile and cleanupRetryPrdFile manage retry PRD artifacts", () => {
      const root = tempDir();
      try {
        const dataDir = join(root, "data");
        writeFileSync(join(root, "placeholder"), "", "utf8");
        mkdirSync(dataDir, { recursive: true });

      const filePath = writeRetryPrdFile({
        yoloRoot: root,
        retryPrd: { id: "PRD-RETRY", tasks: [] },
        round: 1,
        nowMs: 123,
      });

      assert.equal(filePath, join(root, "data", "retry-round1-123.json"));
      assert.deepEqual(readJson(filePath), { id: "PRD-RETRY", tasks: [] });
      assert.deepEqual(cleanupRetryPrdFile(filePath), { deleted: true });
      assert.equal(existsSync(filePath), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("buildRetryCompletedSet combines resume, completed, and skipped ids", () => {
    assert.deepEqual([...buildRetryCompletedSet({
      resumeCompleted: new Set(["A"]),
      completed: ["B"],
      skipped: ["C"],
    })], ["A", "B", "C"]);
  });

  test("syncRetryCompletions blocks invalid dry-run retry completions before PRD sync", () => {
    const taskResults = { completed: [], failed: [], skipped: [] };
    const updates = [];
    const logs = [];
    const result = syncRetryCompletions({
      retryResults: { completed: ["DRY", "CODE"] },
      prd: {
        tasks: [
          { id: "DRY", task_kind: "dry_run_artifact" },
          { id: "CODE", task_kind: "feature" },
        ],
      },
      taskResults,
      taskPostconditionsPass: (task) => task.id === "DRY"
        ? { passed: false, failed: ["missing artifact"] }
        : { passed: true, failed: [] },
      updateTaskStatus: (id, update) => updates.push({ id, update }),
      log: (...args) => logs.push(args),
    });

    assert.deepEqual(result, {
      synced: ["CODE"],
      blocked: [{ id: "DRY", failed: ["missing artifact"] }],
    });
    assert.deepEqual(taskResults.failed, ["DRY"]);
    assert.deepEqual(updates, [{
      id: "CODE",
      update: {
        status: "done",
        phase: "done",
        completedViaRetry: true,
        failReason: undefined,
      },
    }]);
    assert.deepEqual(logs, [["RETRY", "BLOCKED", "DRY retry 声称完成，但主工作区 post_conditions 未满足: missing artifact"]]);
  });

  test("mergeRetryRoundResults folds retry outcomes into base task results", () => {
    const taskResults = {
      completed: ["A"],
      failed: ["B", "C"],
      skipped: [],
    };
    const retryResults = {
      completed: ["B"],
      failed: ["D"],
      skipped: ["C"],
      blocked: ["E", "CONTRACT"],
      contractReview: ["CONTRACT"],
    };

    assert.deepEqual(retryBlockedFailureIds(retryResults), ["E"]);
    assert.equal(mergeRetryRoundResults({ taskResults, retryResults }), taskResults);
    assert.deepEqual(taskResults, {
      completed: ["A", "B"],
      failed: ["D", "E"],
      skipped: ["C"],
    });
  });

  test("mergeRetryRoundResults drains remediation queue for retry-completed tasks", () => {
    // RED: a task that failed with AUTO_REMEDIATE was enqueued in the immediate
    // remediation queue. After a successful retry, that queue entry must be
    // drained — otherwise finalize reports UNRESOLVED_REMEDIATION_QUEUE forever.
    const taskResults = {
      completed: ["A"],
      failed: ["B", "C"],
      skipped: [],
      immediateRemediationQueue: [
        {
          source_task_id: "B",
          routing: "before_next_feature_task",
          reason: "harness_remediation_must_be_cleared_before_new_work",
          action: "AUTO_REMEDIATE",
          status: "remediation_required",
          next_actions: ["Regenerate fixture evidence."],
        },
        {
          source_task_id: "C",
          routing: "before_next_feature_task",
          reason: "harness_remediation_must_be_cleared_before_new_work",
          action: "AUTO_REMEDIATE",
          status: "remediation_required",
          next_actions: ["Rebuild test harness."],
        },
      ],
    };
    const retryResults = {
      completed: ["B"],
      failed: [],
      skipped: ["C"],
    };

    mergeRetryRoundResults({ taskResults, retryResults });

    // B succeeded on retry and C was skipped — both queue entries must be gone.
    assert.deepEqual(taskResults.immediateRemediationQueue, []);
  });

  test("mergeRetryRoundResults keeps remediation queue for still-failed tasks", () => {
    const taskResults = {
      completed: ["A"],
      failed: ["B"],
      skipped: [],
      immediateRemediationQueue: [
        {
          source_task_id: "B",
          routing: "before_next_feature_task",
          reason: "harness_remediation_must_be_cleared_before_new_work",
          action: "AUTO_REMEDIATE",
          status: "remediation_required",
          next_actions: ["Regenerate fixture evidence."],
        },
      ],
    };
    const retryResults = {
      completed: [],
      failed: ["B"],
      skipped: [],
    };

    mergeRetryRoundResults({ taskResults, retryResults });

    // B still failed after retry — its queue entry must remain so the operator
    // sees the remediation is still required.
    assert.equal(taskResults.immediateRemediationQueue.length, 1);
    assert.equal(taskResults.immediateRemediationQueue[0].source_task_id, "B");
  });
});
