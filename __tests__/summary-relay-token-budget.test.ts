import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildTaskSummary, estimateTokens } from "../src/runtime/execution/task-summary.js";
import { buildRelayInjection, rollupBatch } from "../src/runtime/execution/summary-relay.js";

function makeTask(id, title, files, postConditions = []) {
  return {
    id,
    title,
    type: "bugfix",
    status: "pending",
    scope: {
      targets: files.map((file) => ({ file })),
      readonly_files: ["src/types/models.ts", "src/config/constants.ts"],
    },
    post_conditions: postConditions.length
      ? postConditions
      : [
        { id: "POST-1", type: "code_contains", severity: "FAIL", params: { file: files[0], text: "fix" } },
      ],
  };
}

function makeCompletedOutcome() {
  return { status: "completed", reason: "" };
}

function makeFailedOutcome(reason) {
  return { status: "failed", reason };
}

describe("summary relay token budget", () => {
  test("single task summary token estimate is reasonable", () => {
    const summary = buildTaskSummary({
      task: makeTask("FIX-001", "修复库存扣减事务问题", ["src/services/inventory.ts"]),
      outcome: makeCompletedOutcome(),
    });
    assert.ok(summary.token_estimate > 0);
    assert.ok(summary.token_estimate < 200, `single task summary should be < 200 tokens, got ${summary.token_estimate}`);
    assert.equal(summary.task_id, "FIX-001");
    assert.equal(summary.status, "completed");
    assert.ok(Array.isArray(summary.forward_intelligence.fragility_points));
    assert.ok(Array.isArray(summary.forward_intelligence.assumption_changes));
  });

  test("relay injection from 3 tasks stays under 2500 token budget", () => {
    const summaries = [
      buildTaskSummary({
        task: makeTask("FIX-001", "修复库存扣减事务原子性问题", ["src/services/inventory.ts"]),
        outcome: makeCompletedOutcome(),
      }),
      buildTaskSummary({
        task: makeTask("FIX-002", "修复销售页面折扣输入框校验逻辑", ["src/pages/sales/sales.tsx"]),
        outcome: makeCompletedOutcome(),
      }),
      buildTaskSummary({
        task: makeTask("FIX-003", "更新 discounts 表 migration 添加默认值", ["src/db/migrations/006-discounts.sql"]),
        outcome: makeCompletedOutcome(),
      }),
    ];

    const relay = buildRelayInjection(summaries, { maxTokens: 2500 });
    const tokens = estimateTokens(relay);

    assert.ok(relay.length > 0, "relay must not be empty for 3 tasks");
    assert.ok(tokens <= 2500, `relay tokens ${tokens} must be <= 2500`);
    assert.ok(relay.includes("Prior Task Relay"), "relay must include header");
    assert.ok(relay.includes("FIX-001"), "relay must reference first task");
  });

  test("relay injection from 10+ tasks still stays under 2500 token budget", () => {
    const summaries = [];
    for (let i = 1; i <= 12; i++) {
      summaries.push(buildTaskSummary({
        task: makeTask(
          `FIX-${String(i).padStart(3, "0")}`,
          `修复多文件跨层改动任务 #${i}`,
          [`src/pages/page${i}.tsx`, `src/services/service${i}.ts`],
          [
            { id: `POST-${i}-1`, type: "files_modified_max", severity: "FAIL", params: { max: 2 } },
            { id: `POST-${i}-2`, type: "code_contains", severity: "FAIL", params: { file: `src/pages/page${i}.tsx`, text: "fix" } },
          ],
        ),
        outcome: i % 4 === 0 ? makeFailedOutcome("gate_failure: post_condition_not_met") : makeCompletedOutcome(),
      }));
    }

    const relay = buildRelayInjection(summaries, { maxTokens: 2500 });
    const tokens = estimateTokens(relay);

    assert.ok(relay.length > 0, "relay must not be empty for 12 tasks");
    assert.ok(tokens <= 2500, `relay tokens ${tokens} must be <= 2500 even with 12 tasks`);
  });

  test("empty summaries produce empty relay", () => {
    const relay = buildRelayInjection([], { maxTokens: 2500 });
    assert.equal(relay, "");
  });

  test("rollup batch computes cross-task fragility from repeated fragility points", () => {
    const summaries = [];
    for (let i = 1; i <= 5; i++) {
      summaries.push(buildTaskSummary({
        task: makeTask(
          `FIX-00${i}`,
          `修复文件行数超标问题 #${i}`,
          [`src/services/svc${i}.ts`],
          [
            { id: `POST-${i}-1`, type: "file_lines_max", severity: "FAIL", params: { file: `src/services/svc${i}.ts`, max: 150 } },
          ],
        ),
        outcome: i <= 3 ? makeCompletedOutcome() : makeFailedOutcome("file_lines_max exceeded"),
      }));
    }

    const rollup = rollupBatch(summaries);

    assert.equal(rollup.total_tasks, 5);
    assert.equal(rollup.completed, 3);
    assert.equal(rollup.failed, 2);
    assert.ok(rollup.cross_task_fragility.length > 0, "repeated fragility must surface in cross-task fragility");
  });

  test("task summary with failure captures fragility in forward intelligence", () => {
    const summary = buildTaskSummary({
      task: makeTask("FIX-FAIL-001", "修复跨4文件事务问题", [
        "src/pages/checkout.tsx",
        "src/services/payment.ts",
        "src/services/inventory.ts",
        "src/db/migrations/010-fix.sql",
      ]),
      outcome: makeFailedOutcome("gate_failure: acceptance_criteria_not_met"),
    });

    assert.equal(summary.status, "failed");
    assert.ok(summary.forward_intelligence.fragility_points.length > 0, "failed task must have fragility points");
    assert.ok(
      summary.forward_intelligence.fragility_points.some((fp) => fp.includes("跨") || fp.includes("failed") || fp.includes("失败")),
      "fragility must reference cross-file or failure risk",
    );
  });

  test("relay injection truncates within budget when tasks have verbose fragility", () => {
    // Create a task with artificially long fragility/assumption content
    const longAssumption = "A".repeat(500);
    const summaries = [];
    for (let i = 1; i <= 8; i++) {
      summaries.push(buildTaskSummary({
        task: makeTask(`FIX-LONG-${i}`, `长描述任务 ${i} ${longAssumption.slice(0, 100)}`, [`src/file${i}.ts`]),
        outcome: i % 2 === 0 ? makeFailedOutcome("failure with long reason: " + longAssumption) : makeCompletedOutcome(),
      }));
    }

    const relay = buildRelayInjection(summaries, { maxTokens: 2500 });
    const tokens = estimateTokens(relay);

    assert.ok(tokens <= 2500, `relay with verbose tasks must fit in 2500 tokens, got ${tokens}`);
    assert.ok(relay.length > 0, "relay must still have content");
  });

  test("estimateTokens returns 0 for empty string", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
  });

  test("estimateTokens handles mixed CJK and English", () => {
    const mixed = "修复 inventory 库存扣减的 transaction 原子性问题";
    const tokens = estimateTokens(mixed);
    assert.ok(tokens > 0);
    assert.ok(tokens < mixed.length, "token count should be less than character count for mixed text");
  });
});
