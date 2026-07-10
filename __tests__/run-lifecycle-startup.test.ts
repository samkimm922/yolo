import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRunnerPidLock,
  cleanupRetryRoundFiles,
  cleanupStaleGitWorktreesAndBranches,
  ensureRunGitBaseline,
  initializeRuntimeState,
  initializeMissingBaselines,
  loadResumeCompletedFromPrd,
  prepareRunStartup,
  rotateTaskResults,
  RUN_INITIAL_COMMIT_MESSAGE,
  truncateJsonlFile,
} from "../src/runtime/run-lifecycle/startup.js";
import { baselineArtifactHash } from "../src/runtime/execution/baselines.js";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";
import { inspectLifecycleGuard } from "../src/lifecycle/guard.js";
import { readSourceSnapshot, writeSourceSnapshot } from "../src/lifecycle/source-snapshot.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "yolo-run-startup-"));
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function baseStartupOptions({
  root,
  stateRoot,
  stateDir,
  runtimeDir,
  expandedTasksFile,
  resultsFile,
  prdPath,
  logs,
}) {
  return {
    runId: "run-unborn",
    prdPath,
    paths: { stateDir, runtimeDir, expandedTasksFile, resultsFile },
    config: {
      progress_server: { port: 0 },
      state: { max_events: 100, max_changes: 100, max_runs: 100, max_learning: 100, max_session_memory: 100 },
    },
    rootDir: root,
    yoloRoot: stateRoot,
    exitOnComplete: false,
    taskCountsAsCompleted: (task) => task.status === "done",
    initTaskLogs: () => {},
    writeCurrentRun: () => {},
    startProgressApiServer: () => null,
    setProgressServerProc: () => {},
    initializeBaselines: false,
    logProgress: () => {},
    consoleLog: (message) => logs.push(message),
  };
}

describe("run lifecycle startup helpers", () => {
  test("prepareRunStartup fails before side effects when the ledger HMAC key is missing", () => {
    const root = tempDir();
    const logs = [];
    try {
      const stateRoot = join(root, ".yolo");
      const stateDir = join(stateRoot, "state");
      const runtimeDir = join(stateDir, "runtime");
      const expandedTasksFile = join(stateDir, "expanded-tasks.json");
      const resultsFile = join(runtimeDir, "task-results.jsonl");
      const prdPath = join(stateRoot, "data", "prd.json");
      mkdirSync(join(stateRoot, "data"), { recursive: true });
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(prdPath, JSON.stringify({ tasks: [] }), "utf8");

      assert.throws(
        () => prepareRunStartup(baseStartupOptions({
          root,
          stateRoot,
          stateDir,
          runtimeDir,
          expandedTasksFile,
          resultsFile,
          prdPath,
          logs,
        })),
        (error) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "LEDGER_HMAC_KEY_REQUIRED"),
      );
      assert.equal(existsSync(join(stateDir, "runner.pid")), false);
      assert.equal(existsSync(expandedTasksFile), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ensureRunGitBaseline creates a transparent initial commit for unborn git repos", () => {
    const root = tempDir();
    const logs = [];
    try {
      git(root, ["init"]);
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "README.md"), "# unborn\n", "utf8");
      writeFileSync(join(root, "src/app.js"), "console.log('ready');\n", "utf8");

      const result = ensureRunGitBaseline({
        rootDir: root,
        consoleLog: (message) => logs.push(message),
      });

      const head = git(root, ["rev-parse", "--verify", "HEAD"]);
      assert.equal(result.status, "created");
      assert.equal(result.commit, head);
      assert.equal(git(root, ["log", "-1", "--pretty=%s"]), RUN_INITIAL_COMMIT_MESSAGE);
      assert.equal(git(root, ["status", "--porcelain"]), "");
      assert.deepEqual(git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").sort(), [
        "README.md",
        "src/app.js",
      ]);
      assert.match(logs.join("\n"), /尚无 HEAD/);
      assert.match(logs.join("\n"), /yolo 已创建初始 commit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ensureRunGitBaseline leaves true non-git projects for filesystem fallback", () => {
    const root = tempDir();
    const logs = [];
    try {
      writeFileSync(join(root, "README.md"), "# no git\n", "utf8");

      const result = ensureRunGitBaseline({
        rootDir: root,
        consoleLog: (message) => logs.push(message),
      });

      assert.deepEqual(result, { status: "skipped", reason: "not_git_worktree" });
      assert.equal(existsSync(join(root, ".git")), false);
      assert.deepEqual(logs, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prepareRunStartup creates the initial commit before runtime state files", () => {
    const root = tempDir();
    const logs = [];
    try {
      git(root, ["init"]);
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "README.md"), "# startup\n", "utf8");
      writeFileSync(join(root, "src/app.js"), "console.log('ready');\n", "utf8");
      const stateRoot = join(root, ".yolo");
      const stateDir = join(stateRoot, "state");
      const runtimeDir = join(stateDir, "runtime");
      const expandedTasksFile = join(stateDir, "expanded-tasks.json");
      const resultsFile = join(runtimeDir, "task-results.jsonl");
      const prdPath = join(stateRoot, "data", "prd.json");
      mkdirSync(join(stateRoot, "data"), { recursive: true });
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(prdPath, JSON.stringify({ tasks: [{ id: "DONE", status: "done" }] }), "utf8");
      for (const stage of ["discovery", "roadmap"]) {
        writeLifecycleStageReport(stage, { status: "success" }, {
          projectRoot: root,
          stateRoot,
          writeSessionMemory: false,
          skipSequenceCheck: true,
        });
      }
      writeLifecycleStageReport("check", { status: "pass", prd_path: prdPath }, {
        projectRoot: root,
        stateRoot,
        source: "unit",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      writeSourceSnapshot({ projectRoot: root, stateRoot });
      assert.equal(inspectLifecycleGuard({ command: "yolo-run", projectRoot: root, stateRoot, prdPath }).status, "pass");

      const resumeCompleted = prepareRunStartup(baseStartupOptions({
        root,
        stateRoot,
        stateDir,
        runtimeDir,
        expandedTasksFile,
        resultsFile,
        prdPath,
        logs,
      }));

      const committedFiles = git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").sort();
      const head = git(root, ["rev-parse", "--verify", "HEAD"]);
      const snapshot = readSourceSnapshot({ projectRoot: root, stateRoot });
      const checkReport = JSON.parse(readFileSync(join(stateRoot, "lifecycle", "check-report.json"), "utf8"));
      assert.deepEqual([...resumeCompleted], ["DONE"]);
      assert.equal(git(root, ["log", "-1", "--pretty=%s"]), RUN_INITIAL_COMMIT_MESSAGE);
      assert.ok(committedFiles.includes("README.md"));
      assert.ok(committedFiles.includes(".yolo/data/prd.json"));
      assert.equal(committedFiles.includes(".yolo/state/runner.pid"), false);
      assert.equal(committedFiles.some((file) => file.startsWith(".yolo/state/runtime/")), false);
      assert.equal(inspectLifecycleGuard({ command: "yolo-run", projectRoot: root, stateRoot, prdPath }).status, "pass");
      assert.equal(snapshot?.git_head, head);
      assert.equal(checkReport.report.runner_baseline_commit_hash, head);
      assert.equal(checkReport.report.runner_baseline_transition?.source, "runner-baseline");
      assert.match(logs.join("\n"), /yolo 已创建初始 commit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("acquireRunnerPidLock takes over a stale pid file (dead owner) via exclusive create", () => {
    const files = new Map([["/state/runner.pid", "123"]]);
    const unlinked = [];
    let fdCounter = 100;
    const result = acquireRunnerPidLock({
      pidFile: "/state/runner.pid",
      pid: 456,
      openSync: (file, flags) => {
        if (flags === "wx" && files.has(file)) {
          const err = new Error("EEXIST");
          (err as Error & { code: string }).code = "EEXIST";
          throw err;
        }
        files.set(file, "456");
        return ++fdCounter;
      },
      readFileSync: (file) => files.get(file),
      writeSync: () => {},
      closeSync: () => {},
      unlinkSync: (file) => {
        unlinked.push(file);
        files.delete(file);
      },
      processKill: () => {
        throw new Error("dead");
      },
    });

    assert.deepEqual(result, { acquired: true, pid: 456 });
    assert.deepEqual(unlinked, ["/state/runner.pid"]);
    assert.equal(files.get("/state/runner.pid"), "456");
  });

  test("acquireRunnerPidLock throws a structured error for active runners in SDK mode", () => {
    const errors = [];
    assert.throws(() => acquireRunnerPidLock({
      pidFile: "/state/runner.pid",
      pid: 456,
      exitOnComplete: false,
      openSync: () => {
        const err = new Error("EEXIST");
        (err as Error & { code: string }).code = "EEXIST";
        throw err;
      },
      readFileSync: () => "123",
      writeSync: () => {},
      closeSync: () => {},
      unlinkSync: () => {},
      processKill: () => {},
      consoleError: (message) => errors.push(message),
    }), (error) => {
      assert.equal((error as Error & { code: string }).code, "RUNNER_ALREADY_ACTIVE");
      assert.equal((error as Error & { pid: number }).pid, 123);
      return true;
    });
    assert.match(errors[0], /另一个 runner 实例正在运行/);
  });

  test("acquireRunnerPidLock is race-free: only the first contender acquires when both face an existing file (TOCTOU fix)", () => {
    const files = new Map();
    let fdCounter = 200;
    function acquireAs(runnerPid) {
      return acquireRunnerPidLock({
        pidFile: "/state/runner.pid",
        pid: runnerPid,
        exitOnComplete: false,
        openSync: (file, flags) => {
          if (flags === "wx" && files.has(file)) {
            const err = new Error("EEXIST");
            (err as Error & { code: string }).code = "EEXIST";
            throw err;
          }
          files.set(file, String(runnerPid));
          return ++fdCounter;
        },
        readFileSync: (file) => files.get(file),
        writeSync: () => {},
        closeSync: () => {},
        unlinkSync: () => {},
        processKill: () => {}, // first owner always reports alive
      });
    }

    const first = acquireAs(111);
    assert.deepEqual(first, { acquired: true, pid: 111 });

    let second = null;
    let thrown = null;
    try {
      second = acquireAs(222);
    } catch (error) {
      thrown = error;
    }

    assert.equal(second, null, "the second contender must not acquire the lock");
    assert.ok(thrown, "the second contender must throw");
    assert.equal((thrown as Error & { code: string }).code, "RUNNER_ALREADY_ACTIVE");
    assert.equal((thrown as Error & { pid: number }).pid, 111);
    // the pid file must keep the first owner — it must never flip to 222
    assert.equal(files.get("/state/runner.pid"), "111");
  });

  test("acquireRunnerPidLock reclaims the lock after a dead owner when no other runner contends", () => {
    const files = new Map([["/state/runner.pid", "999"]]);
    const unlinked = [];
    let fdCounter = 300;
    const result = acquireRunnerPidLock({
      pidFile: "/state/runner.pid",
      pid: 321,
      openSync: (file, flags) => {
        if (flags === "wx" && files.has(file)) {
          const err = new Error("EEXIST");
          (err as Error & { code: string }).code = "EEXIST";
          throw err;
        }
        files.set(file, "321");
        return ++fdCounter;
      },
      readFileSync: (file) => files.get(file),
      writeSync: () => {},
      closeSync: () => {},
      unlinkSync: (file) => {
        unlinked.push(file);
        files.delete(file);
      },
      processKill: () => {
        throw new Error("no such process");
      },
    });

    assert.deepEqual(result, { acquired: true, pid: 321 });
    assert.deepEqual(unlinked, ["/state/runner.pid"]);
    assert.equal(files.get("/state/runner.pid"), "321");
  });

  test("rotateTaskResults backs up and deletes stale result files", () => {
    const copied = [];
    const unlinked = [];
    const result = rotateTaskResults({
      resultsFile: "/state/task-results.jsonl",
      existsSync: () => true,
      copyFileSync: (...args) => copied.push(args),
      unlinkSync: (file) => unlinked.push(file),
      now: () => new Date("2026-05-24T12:34:56.000Z"),
      consoleLog: () => {},
    });

    assert.equal(result.rotated, true);
    assert.equal(result.bakFile, "/state/task-results.bak.20260524123456.");
    assert.deepEqual(copied[0], ["/state/task-results.jsonl", "/state/task-results.bak.20260524123456."]);
    assert.deepEqual(unlinked, ["/state/task-results.jsonl"]);
  });

  test("initializeRuntimeState removes stale runtime files and directories", () => {
    const root = tempDir();
    try {
      const runtimeDir = join(root, "state/runtime");
      const expandedTasksFile = join(root, "state/expanded-tasks.json");
      const taskLogDir = join(runtimeDir, "task-logs");
      mkdirSync(taskLogDir, { recursive: true });
      writeFileSync(expandedTasksFile, "{}", "utf8");
      writeFileSync(join(taskLogDir, "old.jsonl"), "old", "utf8");
      writeFileSync(join(runtimeDir, "codex-output-old.txt"), "old", "utf8");

      const result = initializeRuntimeState({
        runtimeDir,
        expandedTasksFile,
        consoleLog: () => {},
      });

      assert.equal(result.initialized, true);
      assert.equal(existsSync(join(taskLogDir, "old.jsonl")), false);
      assert.equal(existsSync(join(runtimeDir, "codex-output-old.txt")), false);
      assert.equal(existsSync(expandedTasksFile), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prepareRunStartup exposes the embedded progress server handle for lifecycle cleanup", () => {
    const root = tempDir();
    try {
      const stateDir = join(root, ".yolo", "state");
      const runtimeDir = join(stateDir, "runtime");
      const expandedTasksFile = join(stateDir, "expanded-tasks.json");
      const resultsFile = join(runtimeDir, "task-results.jsonl");
      const prdPath = join(root, ".yolo", "data", "prd.json");
      mkdirSync(join(root, ".yolo", "data"), { recursive: true });
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(prdPath, JSON.stringify({ tasks: [{ id: "A", status: "done" }] }), "utf8");
      const handle = { close: async () => {} };
      let captured = null;

      const resumeCompleted = prepareRunStartup({
        runId: "run-startup",
        prdPath,
        paths: { stateDir, runtimeDir, expandedTasksFile, resultsFile },
        config: {
          progress_server: { port: 0 },
          state: { max_events: 100, max_changes: 100, max_runs: 100, max_learning: 100, max_session_memory: 100 },
        },
        rootDir: root,
        yoloRoot: join(root, ".yolo"),
        exitOnComplete: false,
        taskCountsAsCompleted: (task) => task.status === "done",
        initTaskLogs: () => {},
        writeCurrentRun: () => {},
        startProgressApiServer: () => handle,
        setProgressServerProc: (proc) => { captured = proc; },
        initializeBaselines: false,
        logProgress: () => {},
      });

      assert.equal(captured, handle);
      assert.deepEqual([...resumeCompleted], ["A"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("truncateJsonlFile keeps only the newest records and logs the truncation", () => {
    const writes = new Map();
    const logs = [];
    const result = truncateJsonlFile({
      filePath: "/state/events.jsonl",
      maxLines: 2,
      existsSync: () => true,
      readFileSync: () => "a\nb\nc\n",
      writeFileSync: (file, content) => writes.set(file, content),
      log: (...entry) => logs.push(entry),
    });

    assert.deepEqual(result, { truncated: true, before: 3, after: 2 });
    assert.equal(writes.get("/state/events.jsonl"), "b\nc\n");
    assert.deepEqual(logs[0], ["CLEANUP", "truncate", "events.jsonl: 3 → 2"]);
  });

  test("truncateJsonlFile archives old records when archiveDir is provided", () => {
    const root = tempDir();
    try {
      const filePath = join(root, "events.jsonl");
      const archiveDir = join(root, "archive/jsonl/2026-05");
      writeFileSync(filePath, "a\nb\nc\n", "utf8");

      const result = truncateJsonlFile({
        filePath,
        maxLines: 1,
        archiveDir,
        now: new Date("2026-05-25T12:34:56.000Z"),
        log: () => {},
      });

      assert.equal(result.truncated, true);
      assert.equal(result.archived, 2);
      assert.equal(readFileSync(filePath, "utf8"), "c\n");
      assert.match(readFileSync(result.archiveFile, "utf8"), /a\nb\n/);
      assert.match(result.archiveFile, /archive\/jsonl\/2026-05\/events\.20260525T123456Z\.jsonl$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("initializeMissingBaselines creates generic command output baselines", () => {
    const writes = new Map();
    const logs = [];
    const result = initializeMissingBaselines({
      runtimeDir: "/repo/state/runtime",
      rootDir: "/repo",
      config: { build: { type_check: "tsc --noEmit", lint: "eslint ." } },
      existsSync: () => false,
      writeFileSync: (file, content) => writes.set(file, content),
      execFileSync: (bin, _args) => {
        if (bin === "tsc") return "src/a.ts(1,1): error TS1000: bad\n";
        return JSON.stringify([{ filePath: "/repo/src/a.ts", messages: [
          { line: 2, ruleId: "semi", severity: 2 },
          { line: 3, ruleId: "no-alert", severity: 1 },
        ] }]);
      },
      log: (...entry) => logs.push(entry),
      nowIso: () => "2026-05-24T00:00:00.000Z",
    });

    assert.deepEqual(result.map((item) => [item.kind, item.keys]), [
      ["type_check", ["line:src/a.ts(1,1): error TS1000: bad"]],
      ["lint", [`line:${JSON.stringify([{ filePath: "/repo/src/a.ts", messages: [
        { line: 2, ruleId: "semi", severity: 2 },
        { line: 3, ruleId: "no-alert", severity: 1 },
      ] }])}`]],
    ]);
    const eslintBaseline = JSON.parse(writes.get("/repo/state/runtime/eslint-baseline.json"));
    assert.equal(eslintBaseline.keys.length, 1);
    assert.match(eslintBaseline.keys[0], /^line:/);
    assert.equal(eslintBaseline.meta.command, "eslint .");
    assert.equal(eslintBaseline.meta.exit_code, 0);
    assert.equal(eslintBaseline.meta.artifact_hash, baselineArtifactHash(eslintBaseline));
    assert.match(logs.at(-1)[2], /lint baseline: 1 个条目/);
  });

  test("initializeMissingBaselines records blocked required baseline command failures", () => {
    const writes = new Map();
    const result = initializeMissingBaselines({
      runtimeDir: "/repo/state/runtime",
      rootDir: "/repo",
      config: { build: { type_check: "missing-tsc", lint: "eslint ." } },
      existsSync: () => false,
      writeFileSync: (file, content) => writes.set(file, content),
      execFileSync: (bin, _args) => {
        if (bin === "missing-tsc") {
          const error = new Error("missing-tsc: command not found") as Error & { status: number; stderr: string };
          error.status = 127;
          error.stderr = "missing-tsc: command not found\n";
          throw error;
        }
        return "[]";
      },
      log: () => {},
      nowIso: () => "2026-05-24T00:00:00.000Z",
    });

    assert.equal(result[0].kind, "type_check");
    assert.equal(result[0].blocked, true);
    const baseline = JSON.parse(writes.get("/repo/state/runtime/tsc-baseline.json"));
    assert.equal(baseline.meta.status, "blocked");
    assert.equal(baseline.meta.exit_code, 127);
    assert.equal(baseline.meta.reason, "baseline_command_unavailable");
    assert.equal(baseline.meta.artifact_hash, baselineArtifactHash(baseline));
  });

  test("initializeMissingBaselines uses configured typecheck and skips unconfigured lint", () => {
    const writes = new Map();
    const calls = [];
    const result = initializeMissingBaselines({
      runtimeDir: "/repo/state/runtime",
      rootDir: "/repo",
      config: { build: { type_check: "npx tsc --noEmit", lint: "" } },
      existsSync: () => false,
      writeFileSync: (file, content) => writes.set(file, content),
      execFileSync: (bin, args, options) => {
        calls.push({ bin, args, options });
        if (bin === "tsc") {
          const error = new Error("tsc: command not found") as Error & { status: number; stderr: string };
          error.status = 127;
          error.stderr = "tsc: command not found\n";
          throw error;
        }
        assert.equal(bin, "npx");
        assert.deepEqual(args, ["tsc", "--noEmit"]);
        assert.match(options.env.PATH, /^\/repo\/node_modules\/\.bin/);
        return "";
      },
      log: () => {},
      nowIso: () => "2026-05-24T00:00:00.000Z",
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(result.map((item) => [item.kind, item.status, item.blocked, item.skipped || false]), [
      ["type_check", "pass", false, false],
      ["lint", "skipped", false, true],
    ]);
    const tscBaseline = JSON.parse(writes.get("/repo/state/runtime/tsc-baseline.json"));
    const eslintBaseline = JSON.parse(writes.get("/repo/state/runtime/eslint-baseline.json"));
    assert.equal(tscBaseline.meta.command, "npx tsc --noEmit");
    assert.equal(tscBaseline.meta.status, "pass");
    assert.equal(eslintBaseline.meta.command, "");
    assert.equal(eslintBaseline.meta.status, "skipped");
    assert.equal(eslintBaseline.meta.reason, "baseline_command_not_configured");
  });

  test("cleanupRetryRoundFiles deletes stale retry PRDs but keeps the current PRD", () => {
    const removed = [];
    const result = cleanupRetryRoundFiles({
      retryDir: "/yolo/data",
      currentPrdPath: "/yolo/data/retry-round-current.json",
      existsSync: () => true,
      readdirSync: () => ["retry-round-a.json", "retry-round-current.json", "prd.json"],
      unlinkSync: (file) => removed.push(file),
      consoleLog: () => {},
    });

    assert.deepEqual(result, ["retry-round-a.json"]);
    assert.deepEqual(removed, ["/yolo/data/retry-round-a.json"]);
  });

  test("cleanupStaleGitWorktreesAndBranches removes this run's yolo worktrees and their branches", () => {
    const calls = [];
    const result = cleanupStaleGitWorktreesAndBranches({
      rootDir: "/repo",
      worktreeRoot: "/repo/../.yolo-worktrees",
      consoleLog: () => {},
      execFileSync: (bin, args) => {
        calls.push({ bin, args });
        if (bin === "git" && args[0] === "worktree" && args[1] === "list") {
          return [
            "Worktree /repo",
            "HEAD abc",
            "Worktree /repo/../.yolo-worktrees/yolo-1",
            "HEAD def",
            "branch refs/heads/yolo-a",
            "",
          ].join("\n");
        }
        return "";
      },
    });

    assert.deepEqual(result, {
      worktrees: ["/repo/../.yolo-worktrees/yolo-1"],
      branches: ["yolo-a"],
    });
    assert.ok(calls.some((c) => c.bin === "git" && c.args[0] === "branch" && c.args[1] === "-D" && c.args[2] === "yolo-a"));
  });

  test("cleanupStaleGitWorktreesAndBranches leaves another runner's worktree and branch alone", () => {
    const removed = [];
    const result = cleanupStaleGitWorktreesAndBranches({
      rootDir: "/repo",
      worktreeRoot: "/repo/../.yolo-worktrees",
      consoleLog: () => {},
      execFileSync: (bin, args) => {
        if (bin === "git" && args[0] === "worktree" && args[1] === "list") {
          return [
            "Worktree /repo",
            "HEAD abc",
            // owned by this run: under worktreeRoot
            "Worktree /repo/../.yolo-worktrees/OWNED",
            "HEAD def",
            "branch refs/heads/yolo-owned-1",
            // NOT owned: lives outside this run's worktreeRoot
            "Worktree /elsewhere/.yolo-worktrees/ALIEN",
            "HEAD ghi",
            "branch refs/heads/yolo-alien-1",
            "",
          ].join("\n");
        }
        if (bin === "git" && (args[0] === "worktree" || args[0] === "branch")) {
          removed.push({ bin, args });
        }
        return "";
      },
    });

    assert.deepEqual(result, {
      worktrees: ["/repo/../.yolo-worktrees/OWNED"],
      branches: ["yolo-owned-1"],
    });
    assert.equal(removed.some((c) => c.args.some((a) => typeof a === "string" && a.includes("OWNED"))), true, "owned worktree should be removed");
    assert.equal(removed.some((c) => c.args.includes("yolo-owned-1")), true, "owned branch should be deleted");
    assert.equal(removed.some((c) => c.args.includes("ALIEN")), false, "alien worktree must not be touched");
    assert.equal(removed.some((c) => c.args.includes("yolo-alien-1")), false, "alien branch must not be deleted");
  });

  test("loadResumeCompletedFromPrd resets running tasks and returns completed ids", () => {
    const root = tempDir();
    try {
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, JSON.stringify({
        tasks: [
          { id: "DONE", status: "completed" },
          { id: "RUN", status: "running" },
          { id: "TODO", status: "pending" },
        ],
      }, null, 2), "utf8");

      const completed = loadResumeCompletedFromPrd({
        prdPath,
        taskCountsAsCompleted: (task) => task.status === "completed",
        consoleLog: () => {},
      });

      assert.deepEqual([...completed], ["DONE"]);
      assert.deepEqual(JSON.parse(readFileSync(prdPath, "utf8")).tasks.map((task) => task.status), [
        "completed",
        "pending",
        "pending",
      ]);
      assert.equal(existsSync(`${prdPath}.tmp`), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadResumeCompletedFromPrd returns an empty set when the PRD does not exist (fresh run)", () => {
    const root = tempDir();
    try {
      const prdPath = join(root, "missing-prd.json");
      const completed = loadResumeCompletedFromPrd({
        prdPath,
        taskCountsAsCompleted: () => true,
        consoleLog: () => {},
      });
      assert.equal(completed.size, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadResumeCompletedFromPrd fails closed on a corrupt PRD instead of silently rerunning everything", () => {
    const root = tempDir();
    try {
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, "{ this is not valid json ,,}", "utf8");

      assert.throws(
        () => loadResumeCompletedFromPrd({
          prdPath,
          taskCountsAsCompleted: () => true,
          consoleLog: () => {},
        }),
        (error) => {
          assert.ok(error instanceof SyntaxError, "corrupt PRD should surface as a JSON parse error, not an empty set");
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadResumeCompletedFromPrd rejects oversized PRD JSON before parsing", () => {
    const root = tempDir();
    try {
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, JSON.stringify({
        tasks: [{
          id: "DONE",
          status: "completed",
          padding: "x".repeat(9 * 1024 * 1024),
        }],
      }), "utf8");

      assert.throws(
        () => loadResumeCompletedFromPrd({
          prdPath,
          taskCountsAsCompleted: (task) => task.status === "completed",
          consoleLog: () => {},
        }),
        (error) => {
          assert.equal((error as { code?: string }).code, "PRD_JSON_SIZE_LIMIT_EXCEEDED");
          return true;
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
