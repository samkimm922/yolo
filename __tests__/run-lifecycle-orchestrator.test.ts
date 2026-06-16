import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendBlockedTaskFailures,
  estimateRunTimeoutMs,
  runTaskPipeline,
} from "../src/runtime/run-lifecycle/run-orchestrator.js";

test("estimateRunTimeoutMs keeps the configured minimum and scales with task count", () => {
  assert.equal(estimateRunTimeoutMs({ taskCount: 10, sessionTimeoutHours: 4 }), 4 * 3600000);
  assert.equal(estimateRunTimeoutMs({ taskCount: 100, sessionTimeoutHours: 4 }), 72_000_000);
});

test("appendBlockedTaskFailures excludes contract review blockers", () => {
  const taskResults = {
    completed: [],
    failed: ["OLD"],
    skipped: [],
    blocked: ["BLOCKED-TASK", "CONTRACT-REVIEW"],
    contractReview: ["CONTRACT-REVIEW"],
  };

  appendBlockedTaskFailures({ taskResults });

  assert.deepEqual(taskResults.failed, ["OLD", "BLOCKED-TASK"]);
});

test("runTaskPipeline wires main, retry, review, and finalize phases in order", async () => {
  const calls = [];
  const progress = { total: 0, done: 0, failed: 0 };
  const taskResults = {
    completed: [],
    failed: [],
    skipped: [],
    blocked: ["BLOCKED-TASK", "CONTRACT-REVIEW"],
    contractReview: ["CONTRACT-REVIEW"],
  };

  const result = await runTaskPipeline({
    prdPath: "/repo/.yolo/data/prd.json",
    runId: "run-test",
    resumeCompleted: new Set(["DONE"]),
    exitOnComplete: false,
    sessionTimeoutHours: 4,
    projectRoot: "/repo",
    stateRoot: "/repo/.yolo",
    toolsRoot: "/repo/scripts/yolo",
    stateDir: "/repo/.yolo/state",
    runtimeDir: "/repo/.yolo/state/runtime",
    expandedTasksFile: "/repo/.yolo/state/expanded-tasks.json",
    progress,
    startTimeMs: 100,
    progressServerProc: null,
    loadPRD: () => ({ id: "PRD", tasks: [{ id: "A" }, { id: "B" }] }),
    mainLoop: async (prdPath, completed) => {
      calls.push(["main", prdPath, completed.has("DONE")]);
      return taskResults;
    },
    updateTaskStatus: () => {},
    normalizeRepoPath: (value) => value,
    setGlobalTimeout: (ms, options) => calls.push(["timeout", ms, options]),
    logRun: (event, payload) => calls.push(["logRun", event, payload.tasks]),
    logProgress: (id, phase) => calls.push(["logProgress", id, phase]),
    writeStateSnapshot: (phase, prdPath) => calls.push(["snapshot", phase, prdPath]),
    retryPhase: async ({ taskResults: retryResults }) => {
      calls.push(["retry", [...retryResults.failed]]);
    },
    reviewLoop: async ({ taskResults: reviewResults }) => {
      calls.push(["review", [...reviewResults.failed]]);
    },
    finalize: (input) => {
      calls.push(["finalize", input.progressTotal, [...input.taskResults.failed]]);
      return { status: "success", failed: input.taskResults.failed };
    },
  });

  assert.equal(progress.total, 2);
  assert.deepEqual(result, { status: "success", failed: ["BLOCKED-TASK"] });
  assert.deepEqual(calls, [
    ["logProgress", "RESUME", ""],
    ["timeout", 14_400_000, { exitOnTimeout: false }],
    ["logRun", "run_start", 2],
    ["snapshot", "run_start", "/repo/.yolo/data/prd.json"],
    ["main", "/repo/.yolo/data/prd.json", true],
    ["retry", ["BLOCKED-TASK"]],
    ["review", ["BLOCKED-TASK"]],
    ["timeout", 0, { exitOnTimeout: false }],
    ["finalize", 2, ["BLOCKED-TASK"]],
  ]);
});
