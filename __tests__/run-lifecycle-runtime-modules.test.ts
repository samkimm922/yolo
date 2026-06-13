import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyRunnerContextSideEffects, createRunnerLifecycleState, resolveRunnerContext } from "../src/runtime/run-lifecycle/context.js";
import { createRunnerProgressLogger } from "../src/runtime/run-lifecycle/progress-log.js";
import { handleRunCliFailure, registerRunnerProcessHandlers } from "../src/runtime/run-lifecycle/process-handlers.js";
import {
  createRunnerLedgerWriters,
  recordRunnerMemoryCheckpoint,
  writeRunnerRecoveryCheckpoint,
  writeRunnerStateSnapshot,
} from "../src/runtime/run-lifecycle/recovery-checkpoints.js";
import {
  createRunnerWorktreeHandlers,
  detectRunnerModelProvider,
  refreshRunnerBaselinesAfterCommit,
  runRunnerGateInWorktree,
} from "../src/runtime/run-lifecycle/task-runtime-bindings.js";
import { inspectRunnerRuntimeApiFreeze } from "../src/runtime/run-lifecycle/runtime-api-freeze.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");

describe("runner lifecycle runtime modules", () => {
  test("runner context resolves project and state roots without runner-core globals", () => {
    const calls = [];
    const context = resolveRunnerContext({
      projectRoot: "/repo/app",
      stateRoot: "/repo/app/.yolo",
    }, {
      packageRoot: "/package/yolo",
      config: { project: { root: "." }, state: { dir: "state" } },
      yoloPath: (kind, root) => `${root}/runtime/${kind}`,
    });

    assert.equal(context.rootDir, "/repo/app");
    assert.equal(context.stateDir, "/repo/app/.yolo/state");
    assert.equal(context.currentRunFile, "/repo/app/.yolo/runtime/currentRun");

    applyRunnerContextSideEffects(context, {
      ensureCanonicalDirs: (root) => calls.push(["ensure", root]),
      setContractRoot: (root) => calls.push(["contract", root]),
      setTaskLogsDir: (dir) => calls.push(["logs", dir]),
    });

    assert.deepEqual(calls, [
      ["contract", "/repo/app"],
      ["logs", "/repo/app/.yolo/runtime/runtime/task-logs"],
      ["ensure", "/repo/app/.yolo"],
    ]);
  });

  test("lifecycle state reads mutable context and active session lazily", () => {
    let context = { stateDir: "/state-a", currentRunFile: "/state-a/current.json", rootDir: "/repo-a" };
    let active = { activeWorktree: "/wt-a", activeBranch: "yolo/a" };
    const state = createRunnerLifecycleState({
      getContext: () => context,
      getActiveGitSession: () => active,
      getProgressServerProc: () => null,
    });
    context = { stateDir: "/state-b", currentRunFile: "/state-b/current.json", rootDir: "/repo-b" };
    active = { activeWorktree: "/wt-b", activeBranch: "yolo/b" };

    assert.equal(state.stateDir(), "/state-b");
    assert.deepEqual(state.activeGitSession(), active);
  });

  test("progress logger formats and appends without embedding file state in runner-core", () => {
    const lines = [];
    const writes = [];
    const logger = createRunnerProgressLogger({
      progress: { done: 2, failed: 1, total: 5 },
      startTimeMs: 1000,
      nowMs: () => 3500,
      localeTime: () => "00:00:03",
      getOutputLog: () => "/state/yolo-output.log",
      appendFileSync: (file, content) => writes.push([file, content]),
      log: (line) => lines.push(line),
    });

    logger("TASK-1", ">>", "working");

    assert.equal(lines[0], "[00:00:03] (3s) 3/5 TASK-1 >> working");
    assert.deepEqual(writes[0], ["/state/yolo-output.log", `${lines[0]}\n`]);
  });

  test("recovery checkpoints spawn evidence shims only for runner terminal statuses", () => {
    const spawns = [];
    const options = {
      reason: "task_status_A",
      prdPath: "/repo/prd.json",
      taskId: "A",
      update: { status: "done", phase: "commit" },
      packageRoot: "/package/yolo",
      stateRoot: "/repo/.yolo",
      rootDir: "/repo",
      normalizeRepoPath: (filePath, { rootDir }) => filePath.replace(`${rootDir}/`, ""),
      processExecPath: "/node",
      spawnSync: (cmd, args) => {
        spawns.push([cmd, args]);
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    writeRunnerRecoveryCheckpoint(options);
    recordRunnerMemoryCheckpoint({ ...options, update: { status: "updated" } });
    writeRunnerStateSnapshot(options);

    assert.equal(spawns.length, 3);
    assert.equal(spawns[0][1].some((arg) => String(arg).includes("session-memory.js")), true);
    assert.equal(spawns[1][1].some((arg) => String(arg).includes("state-snapshot.js")), true);
    assert.equal(spawns[2][1].some((arg) => String(arg).includes("state-snapshot.js")), true);
  });

  test("ledger writers keep state events injectable and scoped to the active run", () => {
    const events = [];
    const writers = createRunnerLedgerWriters({
      getStateDir: () => "/state",
      getRunId: () => "RUN-ACTIVE",
      appendStateEvent: (dir, event, data) => events.push(["state", dir, event, data]),
      appendRunEvent: (dir, event, data) => events.push(["run", dir, event, data]),
    });

    writers.logEvent("gate.pass", { task: "A" });
    writers.logRun("run_end", { passed: 1 });

    assert.deepEqual(events, [
      ["state", "/state", "gate.pass", { task: "A", run_id: "RUN-ACTIVE" }],
      ["run", "/state", "run_end", { passed: 1, run_id: "RUN-ACTIVE" }],
    ]);
  });

  test("task runtime bindings isolate provider, gate, worktree, and baseline helpers", () => {
    assert.equal(detectRunnerModelProvider({
      config: { ai: {} },
      execSync: () => "0",
      detectProvider: () => ({ selected: "codex" }),
    }), "codex");

    const active = [];
    const handlers = createRunnerWorktreeHandlers({
      getRootDir: () => "/repo",
      getWorktreeRoot: () => "/repo/.worktrees",
      config: {},
      createTaskWorktree: () => ({ path: "/wt", branch: "yolo/FIX", base: "HEAD" }),
      cleanupTaskWorktree: () => ["src/app.js"],
      setActiveGitSession: (session) => active.push(["set", session]),
      clearActiveGitSession: (session) => active.push(["clear", session]),
      log: () => {},
    });
    assert.equal(handlers.createWorktree("A").path, "/wt");
    assert.deepEqual(handlers.cleanupWorktree("/wt", "yolo/FIX", true), ["src/app.js"]);
    assert.equal(active.length, 2);

    const gate = runRunnerGateInWorktree({
      taskId: "A",
      prdPath: "prd.json",
      wtPath: "/wt",
      mode: "fix",
      packageRoot: "/package/yolo",
      runtimeDir: "/state/runtime",
      rootDir: "/repo",
      spawnSync: (_cmd, args, opts) => ({ status: 0, stdout: args.join(" "), stderr: opts.cwd }),
    });
    assert.equal(gate.exitCode, 0);
    assert.match(gate.stdout, /--cwd=\/wt/);

    const logs = [];
    refreshRunnerBaselinesAfterCommit({
      rootDir: "/repo",
      runtimeDir: "/state/runtime",
      config: {},
      refreshBaselineAfterCommit: () => [{ tool: "eslint", skipped: false, removed: 2, after: 1 }],
      log: (...args) => logs.push(args),
    });
    assert.equal(logs[0][0], "BASELINE");
  });

  test("process handlers register signal and fatal cleanup outside runner-core", () => {
    const handlers = new Map();
    const calls = [];
    registerRunnerProcessHandlers({
      processLike: { on: (event, handler) => handlers.set(event, handler) },
      progress: { done: 1, failed: 0 },
      runResultsTracker: { completed: new Set(["A"]), failed: [] },
      state: {
        stateDir: () => "/state",
        currentRunFile: () => "/state/current.json",
        rootDir: () => "/repo",
        activeGitSession: () => ({}),
        progressServerProc: () => null,
      },
      startTimeMs: 0,
      logRun: (event, data) => calls.push(["run", event, data.exit_reason]),
      writeProgressSnapshot: () => calls.push(["snapshot"]),
      archiveCurrentRunFile: () => calls.push(["archive"]),
      cleanupRuntimeStateFiles: () => calls.push(["cleanup"]),
      execSync: () => {},
    });
    assert.deepEqual([...handlers.keys()], ["SIGINT", "SIGTERM", "unhandledRejection", "uncaughtException"]);

    const exits = [];
    handleRunCliFailure({
      error: new Error("boom"),
      progress: { done: 1, failed: 1 },
      runResultsTracker: { completed: new Set(["A"]), failed: ["B"] },
      state: {
        stateDir: () => "/state",
        currentRunFile: () => "/state/current.json",
        rootDir: () => "/repo",
        activeGitSession: () => ({ activeWorktree: "/wt" }),
      },
      startTimeMs: 0,
      logRun: (event, data) => calls.push(["catch", event, data.exit_reason]),
      writeProgressSnapshot: () => calls.push(["catch-snapshot"]),
      archiveCurrentRunFile: () => calls.push(["catch-archive"]),
      cleanupRuntimeStateFiles: () => calls.push(["catch-cleanup"]),
      execSync: () => {},
      logError: () => {},
      exit: (code) => exits.push(code),
    });
    assert.equal(exits[0], 1);
    assert.equal(calls.some((call) => call[2] === "run_catch"), true);
  });

  test("runtime API freeze inspector blocks current experimental runtime but can pass frozen evidence", () => {
    const packageJson = {
      exports: { "./runtime": "./dist/src/runtime/runner-runtime.js" },
    };
    const experimental = inspectRunnerRuntimeApiFreeze({
      yoloRoot: "/tmp/yolo",
      packageJson,
      apiBoundary: { package_exports: [{ export: "./runtime", target: "./dist/src/runtime/runner-runtime.js", tier: "experimental" }] },
      runnerCoreSource: "export async function run() { return true; }\n",
      maxRunnerCoreLines: 5,
    });
    assert.equal(experimental.status, "blocked");
    assert.ok(experimental.blockers.some((blocker) => blocker.code === "RUNTIME_API_BOUNDARY_STABLE"));

    const frozen = inspectRunnerRuntimeApiFreeze({
      yoloRoot: "/tmp/yolo",
      packageJson,
      apiBoundary: { package_exports: [{ export: "./runtime", target: "./dist/src/runtime/runner-runtime.js", tier: "stable" }] },
      runnerCoreSource: "export async function run() { return true; }\n",
      maxRunnerCoreLines: 5,
    });
    assert.equal(frozen.status, "pass");
    assert.equal(frozen.frozen, true);
  });

  test("runner-core keeps remaining orchestration below the P20 line budget", () => {
    const source = readFileSync(resolve(YOLO_DIR, "src/runtime/runner-core.ts"), "utf8");
    const lineCount = source.trimEnd().split(/\r?\n/).length;
    assert.ok(lineCount <= 600, `runner-core line count ${lineCount} exceeds 600`);
    assert.match(source, /resolveRunnerContext\(/);
    assert.match(source, /registerRunnerProcessHandlers\(/);
    assert.match(source, /writeRunnerRecoveryCheckpointImpl\(/);
    assert.match(source, /createRunnerWorktreeHandlers\(/);
  });
});
