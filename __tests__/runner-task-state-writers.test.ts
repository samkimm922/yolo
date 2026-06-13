import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendTaskResult, updatePrdTaskStatusFile } from "../src/runtime/task-state/writers.js";
import {
  applyTaskTransition,
  blockedTaskTransition,
  createTaskTransition,
  failTaskTransition,
  passTaskTransition,
  skipTaskTransition,
} from "../src/runtime/task-state/transitions.js";

describe("runner task state writers", () => {
  test("appends task result JSONL with default timestamp", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-state-"));
    try {
      const resultsFile = join(root, "task-results.jsonl");
      const result = appendTaskResult(resultsFile, {
        id: "FIX-STATE-001",
        status: "PASS",
      }, {
        now: "2026-05-24T00:00:00.000Z",
        runId: "RUN-STATE",
        workspaceRoot: root,
        allowInitialAttempt: true,
      });

      assert.deepEqual(result, {
        id: "FIX-STATE-001",
        task_id: "FIX-STATE-001",
        run_id: "RUN-STATE",
        attempt_id: "FIX-STATE-001-attempt-0",
        workspace_root: root,
        status: "PASS",
        timestamp: "2026-05-24T00:00:00.000Z",
      });
      assert.deepEqual(JSON.parse(readFileSync(resultsFile, "utf8").trim()), result);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves explicit task result timestamps", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-state-"));
    try {
      const resultsFile = join(root, "task-results.jsonl");
      const result = appendTaskResult(resultsFile, {
        id: "FIX-STATE-002",
        status: "FAIL",
        timestamp: "2026-05-23T00:00:00.000Z",
      }, {
        now: "2026-05-24T00:00:00.000Z",
        runId: "RUN-STATE",
        workspaceRoot: root,
        attemptId: "FIX-STATE-002-attempt-1",
      });

      assert.equal(result.timestamp, "2026-05-23T00:00:00.000Z");
      assert.equal(result.attempt_id, "FIX-STATE-002-attempt-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("YB-006 rejects task result writes missing evidence chain fields", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-state-"));
    try {
      const resultsFile = join(root, "task-results.jsonl");
      assert.throws(() => appendTaskResult(resultsFile, {
        id: "FIX-STATE-MISSING",
        status: "PASS",
      }, {
        runId: "RUN-STATE",
        workspaceRoot: root,
      }), /attempt_id/);
      assert.equal(existsSync(resultsFile), false);

      assert.throws(() => appendTaskResult(resultsFile, {
        id: "FIX-STATE-MISSING",
        status: "PASS",
        attempt_id: "FIX-STATE-MISSING-attempt-1",
      }, {
        workspaceRoot: root,
      }), /run_id/);
      assert.equal(existsSync(resultsFile), false);

      assert.throws(() => appendTaskResult(resultsFile, {
        id: "FIX-STATE-MISSING",
        status: "PASS",
        attempt_id: "FIX-STATE-MISSING-attempt-1",
      }, {
        runId: "RUN-STATE",
      }), /workspace_root/);
      assert.equal(existsSync(resultsFile), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("updates a PRD task atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-state-"));
    try {
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, JSON.stringify({
        version: "2.0",
        tasks: [
          { id: "FIX-STATE-003", status: "pending" },
          { id: "FIX-STATE-004", status: "pending" },
        ],
      }), "utf8");

      const result = updatePrdTaskStatusFile(prdPath, "FIX-STATE-003", {
        status: "done",
        phase: "done",
      });

      assert.equal(result.wrote, true);
      const prd = JSON.parse(readFileSync(prdPath, "utf8"));
      assert.deepEqual(prd.tasks[0], { id: "FIX-STATE-003", status: "done", phase: "done" });
      assert.deepEqual(prd.tasks[1], { id: "FIX-STATE-004", status: "pending" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports missing PRD tasks without writing", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-state-"));
    try {
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, JSON.stringify({ tasks: [{ id: "FIX-STATE-005", status: "pending" }] }), "utf8");

      const result = updatePrdTaskStatusFile(prdPath, "FIX-MISSING-001", { status: "done" });

      assert.equal(result.wrote, false);
      assert.equal(result.reason, "task_not_found");
      const prd = JSON.parse(readFileSync(prdPath, "utf8"));
      assert.equal(prd.tasks[0].status, "pending");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("builds standard terminal task transitions", () => {
    assert.deepEqual(failTaskTransition({
      taskId: "FIX-STATE-006",
      reason: "postconditions failed",
      result: { retries: 2 },
      prdUpdate: { phase: "postcondition" },
      now: "2026-05-24T00:00:00.000Z",
    }), {
      task_id: "FIX-STATE-006",
      result: {
        id: "FIX-STATE-006",
        status: "FAIL",
        reason: "postconditions failed",
        retries: 2,
        timestamp: "2026-05-24T00:00:00.000Z",
      },
      prd_update: {
        status: "failed",
        failReason: "postconditions failed",
        phase: "postcondition",
      },
    });

    assert.equal(passTaskTransition({ taskId: "FIX-STATE-007", now: "2026-05-24T00:00:00.000Z" }).prd_update.status, "done");
    assert.equal(skipTaskTransition({ taskId: "FIX-STATE-008", reason: "already fixed", now: "2026-05-24T00:00:00.000Z" }).result.status, "SKIP");
    assert.equal(blockedTaskTransition({ taskId: "FIX-STATE-009", reason: "dependency", now: "2026-05-24T00:00:00.000Z" }).prd_update.status, "blocked");
  });

  test("applies task transitions through injected writer callbacks", () => {
    const calls = [];
    const transition = passTaskTransition({
      taskId: "FIX-STATE-010",
      result: { duration_sec: "1.0" },
      prdUpdate: { completedAt: "2026-05-24T00:00:00.000Z" },
      now: "2026-05-24T00:00:00.000Z",
    });

    const returned = applyTaskTransition(transition, {
      writeTaskResult(record) {
        calls.push(["result", record]);
      },
      updatePrdTaskStatus(taskId, update) {
        calls.push(["prd", taskId, update]);
      },
    });

    assert.equal(returned, transition);
    assert.deepEqual(calls, [
      ["result", {
        id: "FIX-STATE-010",
        status: "PASS",
        duration_sec: "1.0",
        timestamp: "2026-05-24T00:00:00.000Z",
      }],
      ["prd", "FIX-STATE-010", {
        status: "done",
        phase: "done",
        completedAt: "2026-05-24T00:00:00.000Z",
      }],
    ]);
  });

  test("supports custom result and PRD states for nonstandard terminal outcomes", () => {
    const transition = createTaskTransition({
      taskId: "FIX-STATE-011",
      result: {
        status: "CONTRACT_SUSPECT",
        reason: "same_contract_condition_failed_repeatedly",
        evidence_file: "state/evidence/FIX-STATE-011/contract-suspect.json",
      },
      prdUpdate: {
        status: "needs_contract_review",
        phase: "contract_review",
      },
      now: "2026-05-24T00:00:00.000Z",
    });

    assert.deepEqual(transition, {
      task_id: "FIX-STATE-011",
      result: {
        id: "FIX-STATE-011",
        status: "CONTRACT_SUSPECT",
        reason: "same_contract_condition_failed_repeatedly",
        evidence_file: "state/evidence/FIX-STATE-011/contract-suspect.json",
        timestamp: "2026-05-24T00:00:00.000Z",
      },
      prd_update: {
        status: "needs_contract_review",
        phase: "contract_review",
      },
    });
  });
});
