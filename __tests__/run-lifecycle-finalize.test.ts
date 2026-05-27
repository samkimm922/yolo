import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRunReturnResult,
  cleanDirByPattern,
  cleanupRunArtifacts,
  cleanupWorktreeRoot,
  finalizeRun,
} from "../src/runtime/run-lifecycle/finalize.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "yolo-run-finalize-"));
}

function touch(filePath, content = "") {
  writeFileSync(filePath, content, "utf8");
}

describe("run lifecycle finalization helpers", () => {
  test("cleanDirByPattern keeps newest files and honors excludes", () => {
    const dir = tempDir();
    try {
      touch(join(dir, "gate-a.json"));
      touch(join(dir, "gate-b.json"));
      touch(join(dir, "gate-c.json"));
      const removed = cleanDirByPattern({
        dir,
        pattern: /^gate-.*\.json$/,
        keep: 1,
        exclude: new Set([join(dir, "gate-b.json")]),
      });

      assert.deepEqual(removed, ["gate-a.json"]);
      assert.equal(existsSync(join(dir, "gate-a.json")), false);
      assert.equal(existsSync(join(dir, "gate-b.json")), true);
      assert.equal(existsSync(join(dir, "gate-c.json")), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cleanupRunArtifacts removes transient files and keeps runtime persistent files", () => {
    const root = tempDir();
    try {
      const stateDir = join(root, "state");
      const runtimeDir = join(stateDir, "runtime");
      const dataDir = join(root, "data");
      mkdirSync(runtimeDir, { recursive: true });
      mkdirSync(dataDir, { recursive: true });
      touch(join(root, "task-results.bak.old"));
      touch(join(dataDir, "task-results.bak.old"));
      touch(join(runtimeDir, "gate-a.json"));
      touch(join(runtimeDir, "tmp.txt"));
      touch(join(runtimeDir, "learn-stats.json"), "{}");
      touch(join(stateDir, "expanded-tasks.json"));
      touch(join(stateDir, "runner.pid"));
      touch(join(stateDir, "yolo-output.log"));
      touch(join(stateDir, "review-log.jsonl"));
      touch(join(root, "noise-cleanup.js"));
      touch(join(dataDir, "retry-round-old.json"));
      const currentPrd = join(dataDir, "retry-round-current.json");
      touch(currentPrd);

      const logs = [];
      const result = cleanupRunArtifacts({
        yoloRoot: root,
        stateDir,
        runtimeDir,
        prdPath: currentPrd,
        normalizeRepoPath: (value) => value,
        spawnSync: () => ({ status: 0, stdout: "noise ok\n", stderr: "" }),
        consoleLog: (...entry) => logs.push(entry),
      });

      assert.equal(result.cleanedCount, 8);
      assert.equal(existsSync(join(root, "task-results.bak.old")), false);
      assert.equal(existsSync(join(dataDir, "task-results.bak.old")), false);
      assert.equal(existsSync(join(runtimeDir, "tmp.txt")), false);
      assert.equal(existsSync(join(runtimeDir, "learn-stats.json")), true);
      assert.equal(existsSync(join(dataDir, "retry-round-old.json")), false);
      assert.equal(existsSync(currentPrd), true);
      assert.match(logs.at(-1)[0], /noise-cleanup/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cleanupRunArtifacts removes success-only runtime noise and worktree roots", () => {
    const root = tempDir();
    try {
      const projectRoot = join(root, "project");
      const stateDir = join(projectRoot, ".yolo", "state");
      const runtimeDir = join(stateDir, "runtime");
      const worktreeRoot = join(root, ".yolo-worktrees");
      mkdirSync(join(runtimeDir, "task-logs"), { recursive: true });
      mkdirSync(join(stateDir, "progress-snapshots"), { recursive: true });
      mkdirSync(join(worktreeRoot, "FEAT-1"), { recursive: true });
      touch(join(runtimeDir, "codex-output-1.txt"));
      touch(join(runtimeDir, "context-pack-FEAT-1-1.json"));
      touch(join(runtimeDir, "gate-FEAT-1-1.json"));
      touch(join(runtimeDir, "task-results.jsonl"));
      touch(join(runtimeDir, "task-logs", "FEAT-1.jsonl"));
      touch(join(runtimeDir, "tsc-baseline.json"));
      touch(join(stateDir, "yolo-output.log"));
      touch(join(stateDir, "runner.pid"));
      touch(join(stateDir, "progress-snapshots", "latest.json"));
      const prdPath = join(projectRoot, ".yolo", "data", "prd.json");
      mkdirSync(join(projectRoot, ".yolo", "data"), { recursive: true });
      touch(prdPath);

      const result = cleanupRunArtifacts({
        yoloRoot: join(projectRoot, ".yolo"),
        projectRoot,
        stateDir,
        runtimeDir,
        prdPath,
        completionStatus: "success",
        consoleLog: () => {},
      });

      assert.equal(existsSync(join(runtimeDir, "codex-output-1.txt")), false);
      assert.equal(existsSync(join(runtimeDir, "task-results.jsonl")), false);
      assert.equal(existsSync(join(runtimeDir, "task-logs")), false);
      assert.equal(existsSync(join(runtimeDir, "tsc-baseline.json")), false);
      assert.equal(existsSync(join(stateDir, "yolo-output.log")), false);
      assert.equal(existsSync(join(stateDir, "runner.pid")), false);
      assert.equal(existsSync(join(stateDir, "progress-snapshots", "latest.json")), true);
      assert.equal(existsSync(worktreeRoot), false);
      assert.equal(result.worktreeCleanup.skipped, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cleanupWorktreeRoot refuses unsafe paths", () => {
    assert.deepEqual(cleanupWorktreeRoot({ worktreeRoot: "/tmp/not-yolo-worktrees" }), {
      skipped: true,
      reason: "unsafe_worktree_root",
      removed: [],
    });
  });

  test("cleanupRunArtifacts keeps state cleanup separate from package tools root", () => {
    const root = tempDir();
    const toolsRoot = tempDir();
    try {
      const stateDir = join(root, "state");
      const runtimeDir = join(stateDir, "runtime");
      const dataDir = join(root, "data");
      mkdirSync(runtimeDir, { recursive: true });
      mkdirSync(dataDir, { recursive: true });
      touch(join(toolsRoot, "noise-cleanup.js"));
      touch(join(stateDir, "yolo-output.log"));
      touch(join(stateDir, "review-log.jsonl"));
      touch(join(dataDir, "retry-round-old.json"));
      const currentPrd = join(dataDir, "prd.json");
      touch(currentPrd);

      const spawnCalls = [];
      cleanupRunArtifacts({
        yoloRoot: root,
        toolsRoot,
        stateDir,
        runtimeDir,
        prdPath: currentPrd,
        normalizeRepoPath: (value) => value,
        spawnSync: (...args) => {
          spawnCalls.push(args);
          return { status: 0, stdout: "", stderr: "" };
        },
        consoleLog: () => {},
      });

      assert.equal(existsSync(join(stateDir, "yolo-output.log")), false);
      assert.equal(existsSync(join(stateDir, "review-log.jsonl")), false);
      assert.equal(existsSync(join(dataDir, "retry-round-old.json")), false);
      assert.equal(spawnCalls[0][1][0], join(toolsRoot, "noise-cleanup.js"));
      assert.equal(spawnCalls[0][2].cwd, toolsRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(toolsRoot, { recursive: true, force: true });
    }
  });

  test("buildRunReturnResult maps failed task count to status and report paths", () => {
    const result = buildRunReturnResult({
      runId: "run-1",
      prdPath: "/repo/prd.json",
      taskResults: { completed: ["A"], failed: ["B"], skipped: ["C"], blocked: ["D"] },
      runReportResult: {
        json_path: "/repo/state/report.json",
        markdown_path: "/repo/state/report.md",
        final_answer_json_path: "/repo/state/final-answer.json",
        final_answer_markdown_path: "/repo/state/final-answer.md",
      },
      normalizeRepoPath: (value) => value.replace("/repo/", ""),
    });

    assert.deepEqual(result, {
      status: "error",
      summary: "runner completed with 1 failed task(s)",
      exit_code: 1,
      run_id: "run-1",
      prd: "/repo/prd.json",
      completed: ["A"],
      failed: ["B"],
      skipped: ["C"],
      blocked: ["D"],
      remediation: [],
      report_file: "state/report.json",
      report_markdown: "state/report.md",
      final_answer_file: "state/final-answer.json",
      final_answer_markdown: "state/final-answer.md",
    });
  });

  test("finalizeRun writes report, archives current run, kills progress server, and returns result", () => {
    const root = tempDir();
    try {
      const stateDir = join(root, "state");
      const runtimeDir = join(stateDir, "runtime");
      mkdirSync(runtimeDir, { recursive: true });
      touch(join(stateDir, "current-run.json"), JSON.stringify({ run_id: "run-1", started_at: "start" }));
      const calls = { logRun: [], snapshots: [], archives: [], killed: [] };
      const result = finalizeRun({
        runId: "run-1",
        prdPath: join(root, "data", "prd.json"),
        taskResults: { completed: ["A"], failed: [], skipped: [], blocked: [] },
        progressTotal: 1,
        startTimeMs: Date.now(),
        stateDir,
        runtimeDir,
        yoloRoot: root,
        exitOnComplete: false,
        writeRunReport: () => ({
          json_path: join(stateDir, "report.json"),
          markdown_path: join(stateDir, "report.md"),
          report: { summary: { task_success_rate: 100, run_success_rate: 100 } },
        }),
        logRun: (...entry) => calls.logRun.push(entry),
        logProgress: (...entry) => calls.archives.push(entry),
        writeStateSnapshot: (...entry) => calls.snapshots.push(entry),
        archiveCurrentRun: (...entry) => calls.archives.push(entry),
        normalizeRepoPath: (value) => value.replace(`${root}/`, ""),
        progressServerProc: { pid: 123 },
        processKill: (...entry) => calls.killed.push(entry),
        spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
        consoleLog: () => {},
        now: () => new Date("2026-05-24T00:00:00.000Z"),
      });

      assert.equal(result.status, "success");
      assert.equal(result.exit_code, 0);
      assert.equal(result.report_file, "state/report.json");
      assert.deepEqual(calls.logRun[0][0], "run_end");
      assert.deepEqual(calls.snapshots[0], ["run_end", join(root, "data", "prd.json")]);
      assert.deepEqual(calls.killed[0], [123, "SIGTERM"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
