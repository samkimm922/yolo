import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  applyGateFailureLearningEffects,
  gateFailureLearnArgs,
} from "../src/runtime/execution/gate-learning.js";

describe("gate failure learning helpers", () => {
  test("gateFailureLearnArgs preserves learn.js record command shape", () => {
    assert.deepEqual(gateFailureLearnArgs({
      taskId: "FIX-1",
      gateExitCode: 2,
      message: "tsc: type error",
    }), [
      "--record",
      "--task=FIX-1",
      "--result=fail",
      "--gate=gate-exit-2",
      "--message=tsc: type error",
    ]);
  });

  test("applyGateFailureLearningEffects logs analysis, fix categories, learn, and retry count", () => {
    const analysisLogs = [];
    const fixLogs = [];
    const execCalls = [];
    const retryCalls = [];
    const gateFailure = {
      failedSummary: "tsc: bad type | eslint: unused",
      lastGateError: "full gate error",
      historyEntry: { gate: 1, fingerprint: "abc", message: "tsc: bad type" },
    };

    const result = applyGateFailureLearningEffects({
      taskId: "FIX-2",
      gateExitCode: 1,
      failures: [
        { type: "tsc", detail: "bad type" },
        { type: "eslint", detail: "unused" },
      ],
      gateFailure,
      retryCountFile: "/repo/state/runtime/retry-count.json",
      projectRoot: "/repo",
      stateRoot: "/repo/.yolo",
      logAnalysis: (id, marker, message) => analysisLogs.push({ id, marker, message }),
      logFix: (id, type, detail) => fixLogs.push({ id, type, detail }),
      execNode: (script, args) => {
        execCalls.push({ script, args });
        return { ok: true };
      },
      incrementRetryCountFile: (file, taskId) => {
        retryCalls.push({ file, taskId });
        return { wrote: true, count: 1 };
      },
    });

    assert.deepEqual(analysisLogs, [
      { id: "", marker: "├─", message: "分析: tsc: bad type | eslint: unused" },
    ]);
    assert.deepEqual(fixLogs, [
      { id: "FIX-2", type: "tsc", detail: "bad type" },
      { id: "FIX-2", type: "eslint", detail: "unused" },
    ]);
    assert.deepEqual(execCalls, [{
      script: "learn.js",
      args: [
        "--record",
        "--task=FIX-2",
        "--result=fail",
        "--gate=gate-exit-1",
        "--message=tsc: bad type | eslint: unused",
        "--project-root=/repo",
        "--state-root=/repo/.yolo",
      ],
    }]);
    assert.deepEqual(retryCalls, [{
      file: "/repo/state/runtime/retry-count.json",
      taskId: "FIX-2",
    }]);
    assert.equal(result.failedSummary, gateFailure.failedSummary);
    assert.equal(result.lastGateError, gateFailure.lastGateError);
    assert.equal(result.historyEntry, gateFailure.historyEntry);
    assert.deepEqual(result.learnResult, { ok: true });
    assert.deepEqual(result.retryCountResult, { wrote: true, count: 1 });
  });
});
