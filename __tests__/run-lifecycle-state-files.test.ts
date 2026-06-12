import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveCurrentRunFile,
  buildCurrentRunPayload,
  cleanupRuntimeStateFiles,
  writeCurrentRunFile,
} from "../src/runtime/run-lifecycle/state-files.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "yolo-run-lifecycle-"));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

describe("run lifecycle state files", () => {
  test("buildCurrentRunPayload records project-relative PRD paths", () => {
    assert.deepEqual(buildCurrentRunPayload({
      runId: "run-20260524150000",
      prdPath: "/repo/data/prd/current/plan.json",
      projectRoot: "/repo",
      now: "2026-05-24T15:00:00.000Z",
    }), {
      run_id: "run-20260524150000",
      started_at: "2026-05-24T15:00:00.000Z",
      prd: "data/prd/current/plan.json",
    });

    assert.equal(buildCurrentRunPayload({ runId: "run-1", prdPath: undefined, projectRoot: undefined }).prd, "auto");
  });

  test("writeCurrentRunFile writes atomically to nested state path", () => {
    const root = tempDir();
    try {
      const currentRunFile = join(root, "state", "current-run.json");
      const result = writeCurrentRunFile({
        currentRunFile,
        runId: "run-20260524150000",
        prdPath: join(root, "data/prd.json"),
        projectRoot: root,
        now: "2026-05-24T15:00:00.000Z",
      });

      assert.equal(result.wrote, true);
      assert.deepEqual(readJson(currentRunFile), {
        run_id: "run-20260524150000",
        started_at: "2026-05-24T15:00:00.000Z",
        prd: "data/prd.json",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("archiveCurrentRunFile archives successful runs and removes active file", () => {
    const root = tempDir();
    try {
      const currentRunFile = join(root, "current-run.json");
      writeFileSync(currentRunFile, JSON.stringify({
        run_id: "run-20260524150000",
        started_at: "2026-05-24T15:00:00.000Z",
        prd: "data/prd.json",
      }), "utf8");

      const result = archiveCurrentRunFile({
        currentRunFile,
        stateDir: root,
        runId: "run-20260524150000",
        results: { completed: ["A", "B"], failed: ["C"] },
        now: "2026-05-24T15:30:00.000Z",
      });

      assert.equal(result.archived, true);
      assert.equal(existsSync(currentRunFile), false);
      assert.deepEqual(readJson(join(root, "archive", "run-20260524150000.json")), {
        run_id: "run-20260524150000",
        started_at: "2026-05-24T15:00:00.000Z",
        prd: "data/prd.json",
        completed_at: "2026-05-24T15:30:00.000Z",
        passed: 2,
        failed: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("archiveCurrentRunFile archives interrupted runs using payload run id when caller has none", () => {
    const root = tempDir();
    try {
      const currentRunFile = join(root, "current-run.json");
      writeFileSync(currentRunFile, JSON.stringify({ run_id: "run-active", started_at: "start" }), "utf8");

      const result = archiveCurrentRunFile({
        currentRunFile,
        stateDir: root,
        runId: undefined,
        interrupted: true,
        now: "2026-05-24T15:30:00.000Z",
      });

      assert.equal(result.archived, true);
      assert.equal(readJson(join(root, "archive", "run-active.json")).interrupted, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cleanupRuntimeStateFiles removes runtime files and reports skipped files", () => {
    const root = tempDir();
    try {
      writeFileSync(join(root, "expanded-tasks.json"), "{}", "utf8");
      writeFileSync(join(root, "runner.pid"), "123", "utf8");

      const result = cleanupRuntimeStateFiles({ stateDir: root });

      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.deleted.sort(), [
        join(root, "expanded-tasks.json"),
        join(root, "runner.pid"),
      ].sort());
      assert.equal(existsSync(join(root, "expanded-tasks.json")), false);
      assert.equal(existsSync(join(root, "runner.pid")), false);

      const second = cleanupRuntimeStateFiles({ stateDir: root });
      assert.equal(second.deleted.length, 0);
      assert.equal(second.skipped.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
