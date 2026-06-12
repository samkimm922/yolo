import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  appendReviewTasksToPrd,
  buildReviewTaskLimitBlock,
  hasReviewFixFailures,
  markReviewTaskLimitBlocked,
  pendingReviewDecision,
  reviewFixFailureDetail,
  reviewTaskIdSet,
  shouldBlockReviewTaskLimit,
} from "../src/runtime/review-loop/task-application.js";

describe("review-loop task application helpers", () => {
  test("shouldBlockReviewTaskLimit blocks only above the configured max", () => {
    assert.equal(shouldBlockReviewTaskLimit(5, 5), false);
    assert.equal(shouldBlockReviewTaskLimit(6, 5), true);
  });

  test("buildReviewTaskLimitBlock returns stable blocker metadata before PRD mutation", () => {
    assert.deepEqual(buildReviewTaskLimitBlock({
      round: 2,
      taskCount: 7,
      maxTasks: 5,
      taskIds: ["A", "B"],
    }), {
      blockerId: "REVIEW-TASK-LIMIT-R2",
      message: "本轮将生成 7 个 CLAUDE_FIX，超过上限 5，拒绝写入 PRD",
      errorTitle: "REVIEW_TASK_LIMIT_BLOCKED",
      errorDetail: "generated=7, max=5",
      status: "blocked",
      reason: "review_task_limit",
      human_needed: true,
      recovery_action: "split_review_findings_or_raise_review_task_limit",
      meta: {
        round: 2,
        phase: "REVIEW_TASK_LIMIT_BLOCKED",
        generated_tasks: 7,
        max_allowed: 5,
        blocked_task_ids: ["A", "B"],
        human_needed: true,
        recoverable: true,
        queue_strategy: "human_needed",
      },
    });
  });

  test("markReviewTaskLimitBlocked records a recoverable human-needed blocker", () => {
    const taskResults: Record<string, unknown> = { completed: [], failed: [], skipped: [] };
    const block = buildReviewTaskLimitBlock({
      round: 1,
      taskCount: 8,
      maxTasks: 5,
      taskIds: ["FIX-R1-001"],
    });

    assert.equal(markReviewTaskLimitBlocked({ taskResults: taskResults as Record<string, unknown>, taskLimitBlock: block, appendUnique: undefined as unknown }), taskResults);
    assert.deepEqual(taskResults.failed, []);
    assert.deepEqual(taskResults.blocked, ["REVIEW-TASK-LIMIT-R1"]);
    const reviewBlocker = taskResults.review_blocker as Record<string, unknown>;
    assert.equal(reviewBlocker.human_needed, true);
    assert.equal(reviewBlocker.reason, "review_task_limit");
  });

  test("appendReviewTasksToPrd shapes tasks, mutates PRD, and increments progress", () => {
    const prd: { tasks: Record<string, unknown>[] } = { tasks: [{ id: "DONE" }] };
    const progress = { total: 1 };
    const added = appendReviewTasksToPrd({
      prd,
      progress,
      tasks: [{ id: "FIX-R1-001", priority: "P2", title: "Fix issue" }],
      ensureTaskShape: (task: Record<string, unknown>) => {
        task.scope = task.scope || { targets: [] };
        return task;
      },
    });

    assert.equal(progress.total, 2);
    assert.equal(prd.tasks.length, 2);
    assert.deepEqual(prd.tasks[1].scope, { targets: [] });
    assert.deepEqual(added, [{ id: "FIX-R1-001", priority: "P2", title: "Fix issue" }]);
  });

  test("reviewTaskIdSet filters empty ids", () => {
    assert.deepEqual([...reviewTaskIdSet([{ id: "A" }, {}, { id: "B" }])], ["A", "B"]);
  });

  test("review result helpers detect and summarize failed or blocked fixes", () => {
    assert.equal(hasReviewFixFailures({ failed: [], blocked: [] }), false);
    assert.equal(hasReviewFixFailures({ failed: ["A"], blocked: [] }), true);
    assert.equal(hasReviewFixFailures({ failed: [], blocked: ["B"] }), true);
    assert.equal(reviewFixFailureDetail({ failed: ["A"], blocked: ["B", "C"] }), "failed=1, blocked=2");
  });

  test("pendingReviewDecision models round completion, stalling, and next-round states", () => {
    assert.deepEqual(pendingReviewDecision({ pendingReviewTasks: [] as { id: string }[], round: 1, prevPendingCount: 0 }), {
      action: "continue",
      nextPendingCount: 0,
      message: "本轮 review 任务已处理，继续下一轮扫描",
    });
    assert.deepEqual(pendingReviewDecision({
      pendingReviewTasks: [{ id: "FIX-R1-001" }],
      prevPendingCount: 1,
      round: 2,
    }), {
      action: "break",
      nextPendingCount: 1,
      message: "连续两轮无进展，退出 review",
    });
    assert.deepEqual(pendingReviewDecision({
      pendingReviewTasks: [{ id: "FIX-R1-001" }],
      prevPendingCount: 2,
      round: 2,
    }), {
      action: "next-round",
      nextPendingCount: 1,
      message: null,
    });
  });
});
