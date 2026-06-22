// P10.S6 regression test — secure file permissions on state files (CWE-276)
// Verifies that task log and ledger files are created with 0o600 permissions
// (owner read/write only, not world-readable).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getTaskLogsDir,
  initTaskLogs,
  setTaskLogsDir,
  setTaskLogRunId,
  TASK_LOGS_DIR,
  writeTaskLog,
} from "../src/runtime/logging/task-logger.js";
import { appendJsonlRecord, writeJsonArtifact } from "../src/runtime/evidence/ledger.js";

function modeBits(stat) {
  return stat.mode & 0o777;
}

/**
 * Run a callback with a specific umask, restoring the original afterwards.
 * This lets us test file permissions under the default insecure umask (0o022)
 * regardless of the running process's umask.
 */
function withUmask(mask, fn) {
  const prev = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(prev);
  }
}

describe("P10.S6 secure file permissions (CWE-276)", () => {
  test("writeTaskLog creates files with 0o600 (not world-readable)", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-p10-s6-"));
    try {
      const taskLogsDir = join(root, "task-logs");
      setTaskLogsDir(taskLogsDir);
      // Simulate default insecure umask that would normally produce 0o644
      withUmask(0o22, () => {
        initTaskLogs({ runId: "PERM-TEST" });
        writeTaskLog("PERM-CHECK-001", { type: "TASK_START", title: "perm test" });
      });

      const logFile = join(taskLogsDir, "PERM-CHECK-001.jsonl");
      assert.equal(existsSync(logFile), true);

      const stat = statSync(logFile);
      const bits = modeBits(stat);
      assert.equal(bits & 0o004, 0, `file must NOT be world-readable (got 0o${bits.toString(8).padStart(3, "0")})`);
      assert.equal(bits & 0o040, 0, `file must NOT be group-readable (got 0o${bits.toString(8).padStart(3, "0")})`);
      assert.ok(bits & 0o400, `file must be owner-readable (got 0o${bits.toString(8).padStart(3, "0")})`);
      assert.ok(bits & 0o200, `file must be owner-writable (got 0o${bits.toString(8).padStart(3, "0")})`);

      const record = JSON.parse(readFileSync(logFile, "utf8"));
      assert.equal(record.task_id, "PERM-CHECK-001");
      assert.equal(record.type, "TASK_START");
    } finally {
      setTaskLogRunId(null);
      setTaskLogsDir(TASK_LOGS_DIR);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writeTaskLog appending maintains 0o600 permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-p10-s6-append-"));
    try {
      const taskLogsDir = join(root, "task-logs");
      setTaskLogsDir(taskLogsDir);
      withUmask(0o22, () => {
        initTaskLogs({ runId: "PERM-APPEND" });
        writeTaskLog("PERM-APPEND-001", { type: "TASK_START", title: "first" });
        writeTaskLog("PERM-APPEND-001", { type: "BASH", cmd: "echo second", output: "second" });
      });

      const logFile = join(taskLogsDir, "PERM-APPEND-001.jsonl");
      const stat = statSync(logFile);
      const bits = modeBits(stat);
      assert.equal(bits & 0o004, 0, `file must NOT be world-readable after append (got 0o${bits.toString(8).padStart(3, "0")})`);

      const content = readFileSync(logFile, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 2, "must have 2 entries after append");
    } finally {
      setTaskLogRunId(null);
      setTaskLogsDir(TASK_LOGS_DIR);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("initTaskLogs creates directory with secure permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-p10-s6-dir-"));
    try {
      const taskLogsDir = join(root, "secure-logs");
      setTaskLogsDir(taskLogsDir);
      withUmask(0o22, () => {
        initTaskLogs({ runId: "DIR-PERM" });
      });

      assert.equal(existsSync(taskLogsDir), true);
      const stat = statSync(taskLogsDir);
      const bits = modeBits(stat);
      assert.equal(bits & 0o007, 0, `directory must NOT be world-accessible (got 0o${bits.toString(8).padStart(3, "0")})`);
    } finally {
      setTaskLogRunId(null);
      setTaskLogsDir(TASK_LOGS_DIR);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("appendJsonlRecord creates files with 0o600 permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-p10-s6-ledger-"));
    try {
      const ledgerFile = join(root, "events.jsonl");
      const record = withUmask(0o22, () => {
        return appendJsonlRecord(ledgerFile, { event: "test_event", detail: "perm check" });
      });

      assert.equal(existsSync(ledgerFile), true);
      const stat = statSync(ledgerFile);
      const bits = modeBits(stat);
      assert.equal(bits & 0o004, 0, `ledger file must NOT be world-readable (got 0o${bits.toString(8).padStart(3, "0")})`);
      assert.equal(bits & 0o040, 0, `ledger file must NOT be group-readable (got 0o${bits.toString(8).padStart(3, "0")})`);
      assert.ok(bits & 0o400, `ledger file must be owner-readable (got 0o${bits.toString(8).padStart(3, "0")})`);

      assert.ok(record.record_hash, "appendJsonlRecord must return a valid record");
      assert.equal(record.event, "test_event");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writeJsonArtifact creates files with 0o600 permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-p10-s6-artifact-"));
    try {
      const artifactFile = join(root, "artifact.json");
      withUmask(0o22, () => {
        writeJsonArtifact(artifactFile, { test: true, value: 42 });
      });

      assert.equal(existsSync(artifactFile), true);
      const stat = statSync(artifactFile);
      const bits = modeBits(stat);
      assert.equal(bits & 0o004, 0, `artifact file must NOT be world-readable (got 0o${bits.toString(8).padStart(3, "0")})`);
      assert.ok(bits & 0o400, `artifact file must be owner-readable (got 0o${bits.toString(8).padStart(3, "0")})`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
