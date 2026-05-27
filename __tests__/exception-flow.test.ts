import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handleRunTaskExceptionFlow } from "../src/runtime/execution/exception-flow.js";

function baseRecord() {
  return {
    console: [],
    cleanup: [],
    transitions: [],
    progress: [],
    errors: [],
    done: [],
    slept: [],
  };
}

function baseOptions(record, overrides = {}) {
  return {
    task: { id: "FIX-EX" },
    error: new Error("temporary crash"),
    attempt: 1,
    history: [],
    maxAttempts: 3,
    currentWorktree: { path: "/tmp/wt", branch: "yolo-task" },
    cleanupWorktree: (...args) => record.cleanup.push(args),
    recordTaskTransition: (transition) => record.transitions.push(transition),
    logProgress: (...entry) => record.progress.push(entry),
    logTaskError: (...entry) => record.errors.push(entry),
    logTaskDone: (...entry) => record.done.push(entry),
    sleep: async (ms) => record.slept.push(ms),
    consoleError: (...entry) => record.console.push(entry),
    ...overrides,
  };
}

describe("runTask exception flow", () => {
  test("cleans current worktree, records retry history, logs, and sleeps before retry", async () => {
    const record = baseRecord();
    const history = [];
    const result = await handleRunTaskExceptionFlow(baseOptions(record, { history }));

    assert.equal(result.action, "retry");
    assert.equal(result.cleanedWorktree, true);
    assert.deepEqual(history, [{ gate: -1, message: "exception:temporary crash" }]);
    assert.deepEqual(record.cleanup[0], ["/tmp/wt", "yolo-task", false]);
    assert.deepEqual(record.errors[0], ["FIX-EX", "循环异常 (attempt 1)", "Error: temporary crash"]);
    assert.deepEqual(record.progress[0], ["FIX-EX", "", "异常, 重试 1/3: temporary crash"]);
    assert.deepEqual(record.slept, [2000]);
    assert.match(record.console[0][0], /\[runTask\] FIX-EX 重试 1 异常:/);
    assert.equal(record.transitions.length, 0);
    assert.equal(record.done.length, 0);
  });

  test("terminal exception outcome records transition and does not sleep", async () => {
    const record = baseRecord();
    const history = [
      { gate: -1, message: "exception:same crash" },
      { gate: -1, message: "exception:same crash" },
    ];
    const result = await handleRunTaskExceptionFlow(baseOptions(record, {
      error: new Error("same crash"),
      attempt: 3,
      history,
    }));

    assert.equal(result.action, "return");
    assert.deepEqual(result.result, {
      status: "failed",
      reason: "stuck_exception",
      error: "Error: same crash",
    });
    assert.equal(record.transitions[0].result.status, "FAIL");
    assert.equal(record.done[0][1], "failed");
    assert.match(record.done[0][3], /连续异常停机/);
    assert.equal(record.slept.length, 0);
    assert.match(record.console[1][0], /连续异常停机/);
  });

  test("cleanup and task log failures do not block exception handling", async () => {
    const record = baseRecord();
    const result = await handleRunTaskExceptionFlow(baseOptions(record, {
      logTaskError: () => {
        throw new Error("logger down");
      },
      cleanupWorktree: () => {
        throw new Error("cleanup down");
      },
    }));

    assert.equal(result.action, "retry");
    assert.equal(result.cleanedWorktree, true);
    assert.deepEqual(record.slept, [2000]);
  });
});
