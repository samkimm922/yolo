import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildExpandedTasksSnapshot,
  runLessonsAnalyzer,
  updateExpandedTaskSnapshot,
  writeExpandedTasksSnapshot,
  writeProgressSnapshot,
} from "../src/runtime/task-loop/side-effects.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "yolo-side-effects-"));
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

describe("task-loop side effects", () => {
  test("buildExpandedTasksSnapshot keeps only active tasks and normalizes completed status", () => {
    const snapshot = buildExpandedTasksSnapshot({
      source: "data/prd.json",
      completedIds: new Set(["FIX-P36-001"]),
      now: "2026-05-24T15:00:00.000Z",
      tasks: [
        { id: "FIX-P36-001", status: "done" },
        { id: "FIX-P36-002", status: "completed" },
        { id: "FIX-P36-003", status: "pending" },
      ],
    });

    assert.deepEqual(snapshot, {
      source: "data/prd.json",
      updatedAt: "2026-05-24T15:00:00.000Z",
      tasks: [
        { id: "FIX-P36-002", status: "done" },
        { id: "FIX-P36-003", status: "pending" },
      ],
    });
  });

  test("writeExpandedTasksSnapshot writes JSON under nested directories", () => {
    const root = tempDir();
    try {
      const filePath = join(root, "state", "expanded-tasks.json");
      const result = writeExpandedTasksSnapshot({
        filePath,
        source: "data/prd.json",
        tasks: [{ id: "FIX-P36-001", status: "pending" }],
        now: "2026-05-24T15:00:00.000Z",
      });

      assert.equal(result.wrote, true);
      assert.deepEqual(readJson(filePath), result.payload);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("updateExpandedTaskSnapshot syncs outcome details to the active task", () => {
    const root = tempDir();
    try {
      const filePath = join(root, "expanded-tasks.json");
      writeFileSync(filePath, JSON.stringify({
        source: "data/prd.json",
        tasks: [{ id: "FIX-P36-001", status: "pending" }],
      }, null, 2), "utf8");

      const result = updateExpandedTaskSnapshot({
        filePath,
        taskId: "FIX-P36-001",
        outcome: {
          status: "completed",
          skip_kind: "valid_skip_already_satisfied",
          counts_as_completed: true,
          reason: "already fixed",
        },
        now: "2026-05-24T15:00:00.000Z",
      });

      assert.equal(result.wrote, true);
      assert.deepEqual(readJson(filePath).tasks[0], {
        id: "FIX-P36-001",
        status: "done",
        skip_kind: "valid_skip_already_satisfied",
        counts_as_completed: true,
        failReason: "already fixed",
        updatedAt: "2026-05-24T15:00:00.000Z",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writeProgressSnapshot writes completed and failed ids with total", () => {
    const root = tempDir();
    try {
      const result = writeProgressSnapshot({
        stateDir: root,
        completedIds: new Set(["FIX-P36-001", "FIX-P36-002"]),
        failedIds: ["FIX-P36-003"],
        now: "2026-05-24T15:00:00.000Z",
      });

      assert.equal(result.wrote, true);
      assert.deepEqual(readJson(join(root, "runtime", "progress-snapshot.json")), {
        ts: "2026-05-24T15:00:00.000Z",
        completed: ["FIX-P36-001", "FIX-P36-002"],
        failed: ["FIX-P36-003"],
        total: 3,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runLessonsAnalyzer is best-effort and reports missing or executed scripts", () => {
    const root = tempDir();
    try {
      assert.deepEqual(
        runLessonsAnalyzer({ yoloRoot: root, nodeBin: "node", execFile: () => assert.fail("should not run") }),
        { ran: false, reason: "missing_script", scriptPath: join(root, "lessons-analyzer.js") },
      );

      writeFileSync(join(root, "lessons-analyzer.js"), "console.log('ok');\n", "utf8");
      const calls = [];
      const result = runLessonsAnalyzer({
        yoloRoot: root,
        nodeBin: "node",
        timeout: 1234,
        execFile: (...args) => calls.push(args),
      });

      assert.deepEqual(result, { ran: true, scriptPath: join(root, "lessons-analyzer.js") });
      assert.equal(calls[0][0], "node");
      assert.deepEqual(calls[0][1], [join(root, "lessons-analyzer.js")]);
      assert.equal(calls[0][2].cwd, root);
      assert.equal(calls[0][2].timeout, 1234);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
