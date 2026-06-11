import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getTaskLogsDir,
  initTaskLogs,
  setTaskLogRunId,
  setTaskLogsDir,
  TASK_LOGS_DIR,
  writeTaskLog,
} from "../src/runtime/logging/task-logger.js";
import { getTaskLogsDir as getSrcTaskLogsDir } from "../src/runtime/logging/task-logger.js";

describe("task logger", () => {
  test("can write task logs under a caller supplied state root", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-logger-"));
    try {
      const taskLogsDir = join(root, "state/runtime/task-logs");
      setTaskLogsDir(taskLogsDir);
      initTaskLogs({ runId: "RUN-LOGGER" });
      writeTaskLog("FIX-LOGGER-001", { type: "TASK_START", title: "state root smoke" });

      const logFile = join(taskLogsDir, "FIX-LOGGER-001.jsonl");
      assert.equal(getTaskLogsDir(), taskLogsDir);
      assert.equal(getSrcTaskLogsDir(), taskLogsDir);
      assert.equal(existsSync(logFile), true);
      const record = JSON.parse(readFileSync(logFile, "utf8"));
      assert.equal(record.task_id, "FIX-LOGGER-001");
      assert.equal(record.run_id, "RUN-LOGGER");

      writeTaskLog("FIX-LOGGER-OVERRIDE", { type: "TASK_START", task_id: "WRONG", run_id: "RUN-WRONG" });
      const overrideRecord = JSON.parse(readFileSync(join(taskLogsDir, "FIX-LOGGER-OVERRIDE.jsonl"), "utf8"));
      assert.equal(overrideRecord.task_id, "FIX-LOGGER-OVERRIDE");
      assert.equal(overrideRecord.run_id, "RUN-LOGGER");

      writeFileSync(logFile, "stale\n", "utf8");
      initTaskLogs({ taskLogsDir });
      assert.equal(existsSync(logFile), false);

      writeTaskLog("FIX-LOGGER-002", { type: "TASK_START", title: "legacy init smoke" });
      const legacyRecord = JSON.parse(readFileSync(join(taskLogsDir, "FIX-LOGGER-002.jsonl"), "utf8"));
      assert.equal(legacyRecord.task_id, "FIX-LOGGER-002");
      assert.equal("run_id" in legacyRecord, false);
    } finally {
      setTaskLogRunId(null);
      setTaskLogsDir(TASK_LOGS_DIR);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
