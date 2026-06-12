import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireRunnerPidLock,
  cleanupRetryRoundFiles,
  cleanupStaleGitWorktreesAndBranches,
  initializeRuntimeState,
  initializeMissingBaselines,
  loadResumeCompletedFromPrd,
  rotateTaskResults,
  truncateJsonlFile,
} from "../src/runtime/run-lifecycle/startup.js";
import { baselineArtifactHash } from "../src/runtime/execution/baselines.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "yolo-run-startup-"));
}

describe("run lifecycle startup helpers", () => {
  test("acquireRunnerPidLock removes stale pid files and writes the current pid", () => {
    const files = new Map([["/state/runner.pid", "123"]]);
    const unlinked = [];
    const result = acquireRunnerPidLock({
      pidFile: "/state/runner.pid",
      pid: 456,
      existsSync: (file) => files.has(file),
      readFileSync: (file) => files.get(file),
      writeFileSync: (file, value) => files.set(file, value),
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
      existsSync: () => true,
      readFileSync: () => "123",
      writeFileSync: () => {},
      processKill: () => {},
      consoleError: (message) => errors.push(message),
    }), (error) => {
      assert.equal((error as Error & { code: string }).code, "RUNNER_ALREADY_ACTIVE");
      assert.equal((error as Error & { pid: number }).pid, 123);
      return true;
    });
    assert.match(errors[0], /另一个 runner 实例正在运行/);
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

  test("initializeMissingBaselines creates tsc and eslint error baselines", () => {
    const writes = new Map();
    const logs = [];
    const result = initializeMissingBaselines({
      runtimeDir: "/repo/state/runtime",
      rootDir: "/repo",
      config: { build: { type_check: "tsc --noEmit", lint: "eslint ." } },
      existsSync: () => false,
      writeFileSync: (file, content) => writes.set(file, content),
      execFileSync: (_bin, args) => {
        if (args[1].startsWith("tsc")) return "src/a.ts(1,1): error TS1000: bad\n";
        return JSON.stringify([{ filePath: "/repo/src/a.ts", messages: [
          { line: 2, ruleId: "semi", severity: 2 },
          { line: 3, ruleId: "no-alert", severity: 1 },
        ] }]);
      },
      log: (...entry) => logs.push(entry),
      nowIso: () => "2026-05-24T00:00:00.000Z",
    });

    assert.deepEqual(result.map((item) => [item.tool, item.keys]), [
      ["tsc", ["src/a.ts:1:TS1000"]],
      ["eslint", ["src/a.ts:2:semi"]],
    ]);
    const eslintBaseline = JSON.parse(writes.get("/repo/state/runtime/eslint-baseline.json"));
    assert.deepEqual(eslintBaseline.keys, ["src/a.ts:2:semi"]);
    assert.equal(eslintBaseline.meta.command, "eslint .");
    assert.equal(eslintBaseline.meta.exit_code, 0);
    assert.equal(eslintBaseline.meta.artifact_hash, baselineArtifactHash(eslintBaseline));
    assert.match(logs.at(-1)[2], /eslint baseline: 1 个条目/);
  });

  test("initializeMissingBaselines records blocked required baseline command failures", () => {
    const writes = new Map();
    const result = initializeMissingBaselines({
      runtimeDir: "/repo/state/runtime",
      rootDir: "/repo",
      config: { build: { type_check: "missing-tsc", lint: "eslint ." } },
      existsSync: () => false,
      writeFileSync: (file, content) => writes.set(file, content),
      execFileSync: (_bin, args) => {
        if (args[1].startsWith("missing-tsc")) {
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

    assert.equal(result[0].tool, "tsc");
    assert.equal(result[0].blocked, true);
    const baseline = JSON.parse(writes.get("/repo/state/runtime/tsc-baseline.json"));
    assert.equal(baseline.meta.status, "blocked");
    assert.equal(baseline.meta.exit_code, 127);
    assert.equal(baseline.meta.reason, "baseline_command_unavailable");
    assert.equal(baseline.meta.artifact_hash, baselineArtifactHash(baseline));
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

  test("cleanupStaleGitWorktreesAndBranches removes yolo worktrees and branches", () => {
    const commands = [];
    const result = cleanupStaleGitWorktreesAndBranches({
      rootDir: "/repo",
      consoleLog: () => {},
      execSync: (command) => {
        commands.push(command);
        if (command === "git worktree list --porcelain") {
          return "Worktree /repo\nWorktree /repo/../.yolo-worktrees/yolo-1\n";
        }
        if (command === 'git branch --list "yolo-*"') return "yolo-a\n";
        return "";
      },
    });

    assert.deepEqual(result, {
      worktrees: ["/repo/../.yolo-worktrees/yolo-1"],
      branches: ["yolo-a"],
    });
    assert.ok(commands.includes('git branch -D "yolo-a" 2>/dev/null'));
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
});
