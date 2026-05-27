import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getTaskLogsDir,
  initTaskLogs,
  setTaskLogsDir,
  TASK_LOGS_DIR,
  writeTaskLog,
} from "../task-logger.js";
import { getTaskLogsDir as getSrcTaskLogsDir } from "../src/runtime/logging/task-logger.js";

describe("task logger", () => {
  test("can write task logs under a caller supplied state root", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-logger-"));
    try {
      const taskLogsDir = join(root, "state/runtime/task-logs");
      setTaskLogsDir(taskLogsDir);
      initTaskLogs();
      writeTaskLog("FIX-LOGGER-001", { type: "TASK_START", title: "state root smoke" });

      const logFile = join(taskLogsDir, "FIX-LOGGER-001.jsonl");
      assert.equal(getTaskLogsDir(), taskLogsDir);
      assert.equal(getSrcTaskLogsDir(), taskLogsDir);
      assert.equal(existsSync(logFile), true);
      assert.equal(JSON.parse(readFileSync(logFile, "utf8")).task_id, "FIX-LOGGER-001");

      writeFileSync(logFile, "stale\n", "utf8");
      initTaskLogs({ taskLogsDir });
      assert.equal(existsSync(logFile), false);
    } finally {
      setTaskLogsDir(TASK_LOGS_DIR);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
