import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupActiveGitSession,
  createGracefulShutdownHandler,
  createRunnerTimeoutController,
  handleRunnerFatalError,
  saveRunnerProgressSnapshot,
  writeRunEndOnCrashEvent,
} from "../src/runtime/run-lifecycle/shutdown.js";

function makeState() {
  return {
    stateDir: () => "/tmp/.yolo/state",
    currentRunFile: () => "/tmp/.yolo/state/runtime/current-run.json",
    rootDir: () => "/repo",
    activeGitSession: () => ({ activeWorktree: "/tmp/wt", activeBranch: "yolo/FIX" }),
    progressServerProc: () => ({ pid: 123456789 }),
  };
}

describe("run lifecycle shutdown helpers", () => {
  test("writeRunEndOnCrashEvent preserves runner run_end payload shape", () => {
    const events = [];
    writeRunEndOnCrashEvent({
      prd: "prd.json",
      passed: 2,
      failed: 1,
      reason: "SIGINT",
    }, {
      startTimeMs: 1000,
      nowMs: () => 3500,
      logRun: (event, data) => events.push([event, data]),
    });

    assert.deepEqual(events, [[
      "run_end",
      { prd: "prd.json", passed: 2, failed: 1, duration_sec: "2.5", exit_reason: "SIGINT" },
    ]]);
  });

  test("timeout controller snapshots progress, archives current run, cleans runtime, and exits", () => {
    const calls = [];
    const controller = createRunnerTimeoutController({
      initialTimeoutMs: 7200000,
      startTimeMs: 1000,
      runResultsTracker: { completed: new Set(["A"]), failed: ["B"] },
      state: makeState(),
      logRun: (event, data) => calls.push(["logRun", event, data]),
      writeProgressSnapshot: (data) => calls.push(["snapshot", data]),
      archiveCurrentRunFile: (data) => calls.push(["archive", data]),
      cleanupRuntimeStateFiles: (data) => calls.push(["cleanup", data]),
      execSync: (cmd, opts) => calls.push(["exec", cmd, opts.cwd]),
      log: (message) => calls.push(["log", message]),
      exit: (code) => calls.push(["exit", code]),
      nowMs: () => 61000,
    });

    controller.handleGlobalTimeout();

    assert.deepEqual(calls[0], ["log", "[yolo-runner] 全局超时（2.0 小时）"]);
    assert.equal(calls.some((call) => call[0] === "snapshot" && call[1].stateDir === "/tmp/.yolo/state"), true);
    assert.equal(calls.some((call) => call[0] === "archive" && call[1].interrupted === true), true);
    assert.equal(calls.some((call) => call[0] === "cleanup"), true);
    assert.deepEqual(calls.at(-1), ["exit", 2]);
  });

  test("graceful shutdown handler records progress and exits nonzero on signals", async () => {
    const calls = [];
    const shutdown = createGracefulShutdownHandler({
      progress: { done: 3, failed: 0 },
      runResultsTracker: { completed: new Set(["A"]), failed: [] },
      state: makeState(),
      startTimeMs: 0,
      logRun: (event, data) => calls.push(["logRun", event, data]),
      writeProgressSnapshot: (data) => calls.push(["snapshot", data]),
      archiveCurrentRunFile: (data) => calls.push(["archive", data]),
      cleanupRuntimeStateFiles: (data) => calls.push(["cleanup", data]),
      execSync: (cmd, opts) => calls.push(["exec", cmd, opts.cwd]),
      log: (message) => calls.push(["log", message]),
      exit: (code) => calls.push(["exit", code]),
    });

    await shutdown("SIGTERM");

    assert.equal(calls.some((call) => call[0] === "logRun" && call[2].exit_reason === "SIGTERM"), true);
    assert.equal(calls.some((call) => call[0] === "archive" && call[1].interrupted === true), true);
    assert.deepEqual(calls.at(-1), ["exit", 130]);
  });

  test("fatal error handler writes crash evidence and exits with failure", () => {
    const calls = [];
    handleRunnerFatalError({
      reason: new Error("boom"),
      exitReason: "uncaughtException",
      runResultsTracker: { completed: new Set(["A"]), failed: ["B"] },
      state: makeState(),
      startTimeMs: 0,
      logRun: (event, data) => calls.push(["logRun", event, data]),
      writeProgressSnapshot: (data) => calls.push(["snapshot", data]),
      cleanupRuntimeStateFiles: (data) => calls.push(["cleanup", data]),
      execSync: (cmd, opts) => calls.push(["exec", cmd, opts.cwd]),
      error: (_message, value) => calls.push(["error", value.message]),
      exit: (code) => calls.push(["exit", code]),
    });

    assert.deepEqual(calls[0], ["error", "boom"]);
    assert.equal(calls.some((call) => call[0] === "logRun" && call[2].exit_reason === "uncaughtException"), true);
    assert.deepEqual(calls.at(-1), ["exit", 1]);
  });

  test("fatal error handler cleans up the active worktree and branch like graceful shutdown", () => {
    const calls = [];
    handleRunnerFatalError({
      reason: new Error("boom"),
      exitReason: "uncaughtException",
      runResultsTracker: { completed: new Set(), failed: [] },
      state: makeState(),
      startTimeMs: 0,
      logRun: () => {},
      writeProgressSnapshot: () => {},
      cleanupRuntimeStateFiles: () => {},
      execSync: (cmd, opts) => calls.push([cmd, opts.cwd]),
      error: () => {},
      exit: () => {},
    });

    assert.equal(
      calls.some(([cmd, cwd]) => cmd.includes("git worktree remove --force") && cmd.includes("/tmp/wt") && cwd === "/repo"),
      true,
      "fatal error should remove the active worktree",
    );
    assert.equal(
      calls.some(([cmd, cwd]) => cmd.includes("git branch -D") && cmd.includes("yolo/FIX") && cwd === "/repo"),
      true,
      "fatal error should delete the active branch",
    );
  });

  test("standalone cleanup and snapshot helpers are injectable", () => {
    const execs = [];
    cleanupActiveGitSession({
      activeWorktree: "/tmp/wt",
      activeBranch: "yolo/FIX",
      rootDir: "/repo",
      execSync: (cmd, opts) => execs.push([cmd, opts.cwd]),
    });
    assert.equal(execs.length, 2);

    const snapshots = [];
    saveRunnerProgressSnapshot({
      stateDir: "/state",
      completedIds: new Set(["A"]),
      failedIds: ["B"],
      writeProgressSnapshot: (payload) => snapshots.push(payload),
    });
    assert.deepEqual(snapshots[0].failedIds, ["B"]);
  });
});
