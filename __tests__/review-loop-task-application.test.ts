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
      taskIds: ["A", "B", "C", "D", "E", "F", "G"],
    }), {
      blockerId: "REVIEW-TASK-LIMIT-R2",
      message: "本轮将生成 7 个 executor 修复任务，超过上限 5，拒绝写入 PRD",
      errorTitle: "REVIEW_TASK_LIMIT_BLOCKED",
      errorDetail: "generated=7, max=5",
      status: "blocked",
      reason: "review_task_limit",
      human_needed: true,
      recovery_action: "ask_human_review_task_limit_recovery",
      next_question: "本轮有 7 个 review 修复任务，单轮上限为 5。请选择：按给出的批次拆分处理，或由人工显式设置 runner.max_review_tasks_per_round；YOLO 不会自动修改配置或选择方案。",
      remediation: {
        status: "human_required",
        action: "ASK_HUMAN",
        automation_can_continue: false,
        requires_human: true,
        unsafe_stop: false,
        blocks_ship: true,
        config: {
          path: "config.yaml",
          env_override: "YOLO_CONFIG",
          key: "runner.max_review_tasks_per_round",
          current_value: 5,
          requested_value: null,
          change_requires_explicit_human_approval: true,
        },
        split_template: {
          strategy: "bounded_review_task_batches",
          max_tasks_per_batch: 5,
          batch_count: 2,
          batches: [
            { batch: 1, task_ids: ["A", "B", "C", "D", "E"] },
            { batch: 2, task_ids: ["F", "G"] },
          ],
        },
        rerun_command: "yolo run <PRD_PATH>",
        next_actions: [
          "Answer the review task limit question with either `split_review_findings` or `set_configured_limit`.",
          "After applying the explicit human decision, rerun `yolo run <PRD_PATH>`.",
        ],
      },
      meta: {
        round: 2,
        phase: "REVIEW_TASK_LIMIT_BLOCKED",
        generated_tasks: 7,
        max_allowed: 5,
        blocked_task_ids: ["A", "B", "C", "D", "E", "F", "G"],
        human_needed: true,
        recoverable: true,
        queue_strategy: "human_needed",
        recovery: {
          question_id: "review_task_limit_recovery",
          allowed_answers: ["split_review_findings", "set_configured_limit"],
          config_key: "runner.max_review_tasks_per_round",
          rerun_command: "yolo run <PRD_PATH>",
        },
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
    assert.equal(reviewBlocker.next_question, block.next_question);
    assert.deepEqual(reviewBlocker.remediation, block.remediation);
    assert.deepEqual(taskResults.remediation, [{
      task_id: "REVIEW-TASK-LIMIT-R1",
      ...block.remediation,
    }]);
  });

  test("appendReviewTasksToPrd shapes tasks, mutates PRD, and increments progress", () => {
    const prd: { tasks: Record<string, unknown>[] } = {
      tasks: [{
        id: "DONE",
        requirement_ids: ["REQ-BASE"],
        design_ids: ["DES-BASE"],
        scope: { targets: [{ file: "src/app.ts" }] },
      }],
    };
    const progress = { total: 1 };
    const added = appendReviewTasksToPrd({
      prd,
      progress,
      tasks: [{
        id: "FIX-R1-001",
        priority: "P2",
        title: "Fix issue",
        task_kind: "review_fix",
        scope: { targets: [{ file: "src/app.ts" }] },
        source_finding_ids: ["REV-1"],
      }],
      ensureTaskShape: (task: Record<string, unknown>) => {
        task.scope = task.scope || { targets: [] };
        return task;
      },
    });

    assert.equal(progress.total, 2);
    assert.equal(prd.tasks.length, 2);
    assert.deepEqual(prd.tasks[1].scope, { targets: [{ file: "src/app.ts" }] });
    assert.deepEqual(prd.tasks[1].requirement_ids, ["REQ-BASE"]);
    assert.deepEqual(prd.tasks[1].design_ids, ["DES-BASE"]);
    assert.deepEqual(prd.tasks[1].evidence_files, ["REV-1"]);
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
