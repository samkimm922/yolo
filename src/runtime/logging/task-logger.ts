// task-logger.js — 全量操作日志模块
// 数据契约：每个任务一个 JSONL 文件，progress-server 可实时 tail
// 路径：state/runtime/task-logs/{task_id}.jsonl
// Review：state/runtime/task-logs/_review.jsonl

import { appendFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSafePathComponent } from "../../lib/security/path-guard.js";
import { redact, redactDeep } from "../../lib/security/redact.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const YOLO_ROOT = resolve(__dirname, "../../..");
export const TASK_LOGS_DIR = join(YOLO_ROOT, "state", "runtime", "task-logs");
let taskLogsDir = TASK_LOGS_DIR;
let taskLogRunId = null;

export function setTaskLogsDir(dir = TASK_LOGS_DIR) {
  taskLogsDir = resolve(dir);
  return taskLogsDir;
}

export function getTaskLogsDir() {
  return taskLogsDir;
}

export function setTaskLogRunId(runId = null) {
  taskLogRunId = runId || null;
  return taskLogRunId;
}

// ── ISO 8601 带时区偏移 ──────────────────────────────────────
function isoLocal() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  const sign = off <= 0 ? "+" : "-";
  const absOff = Math.abs(off);
  const hh = String(Math.floor(absOff / 60)).padStart(2, "0");
  const mm = String(absOff % 60).padStart(2, "0");
  const iso = d.toISOString().slice(0, 19);
  return `${iso}${sign}${hh}:${mm}`;
}

// ── 初始化：创建目录 + 清理旧日志 ────────────────────────────
export function initTaskLogs(options = Object()) {
  const dir = options.taskLogsDir || options.task_logs_dir;
  if (dir) setTaskLogsDir(dir);
  setTaskLogRunId(options.runId || options.run_id || null);
  try {
    if (!existsSync(taskLogsDir)) {
      mkdirSync(taskLogsDir, { recursive: true });
    } else {
      // 清理上次运行的日志文件（保留目录）
      for (const f of readdirSync(taskLogsDir)) {
        try { unlinkSync(join(taskLogsDir, f)); } catch {}
      }
    }
  } catch (e) {
    console.error('[task-logger] initTaskLogs 失败:', e.message);
    // best effort — 不阻塞主流程
  }
}

// ── 核心写入函数 ──────────────────────────────────────────────
// taskId: 任务 ID 或 "_review"
// entry: { type, ... } — ts 字段自动添加
export function writeTaskLog(taskId, entry) {
  try {
    if (!isSafePathComponent(String(taskId))) {
      console.error(`[task-logger] writeTaskLog rejected unsafe taskId: ${taskId}`);
      return;
    }
    const runContext = taskLogRunId ? { run_id: taskLogRunId } : {};
    const safeEntry = redactDeep(entry || Object());
    const line = JSON.stringify({ ts: isoLocal(), ...safeEntry, task_id: taskId, ...runContext }) + "\n";
    appendFileSync(join(taskLogsDir, `${taskId}.jsonl`), line, "utf8");
  } catch (e) {
    console.error('[task-logger] writeTaskLog 失败:', e.message);
    // crash-safe: 日志写入失败不阻塞主流程
  }
}

// ── 便捷工厂函数 ─────────────────────────────────────────────
export function logTaskStart(taskId, title) {
  writeTaskLog(taskId, { type: "TASK_START", title });
}

export function logTaskRead(taskId, file, detail) {
  writeTaskLog(taskId, { type: "READ", file, detail });
}

export function logTaskEdit(taskId, file, detail) {
  writeTaskLog(taskId, { type: "EDIT", file, detail });
}

export function logTaskBash(taskId, cmd, result, output) {
  writeTaskLog(taskId, { type: "BASH", cmd, result, output: redact(output?.slice(0, 500) || "") });
}

export function logTaskGate(taskId, check, result, errors) {
  writeTaskLog(taskId, { type: "GATE", check, result, errors: errors || [] });
}

export function logTaskFix(taskId, file, detail) {
  writeTaskLog(taskId, { type: "FIX", file, detail });
}

export function logTaskError(taskId, message, detail, stack) {
  writeTaskLog(taskId, { type: "ERROR", message, detail: detail || "", stack: stack || "" });
}

export function logTaskDone(taskId, result, durationMs, error) {
  const entry = Object.assign(Object(), { type: "DONE", result, duration_ms: durationMs });
  if (error) entry.error = error;
  writeTaskLog(taskId, entry);
}

// ── Review 专用 ──────────────────────────────────────────────
export function logReviewStart(scope, totalFiles, meta = Object()) {
  writeTaskLog("_review", { type: "REVIEW_START", scope, total_files: totalFiles, ...meta });
}

export function logReviewRead(file, detail) {
  writeTaskLog("_review", { type: "READ", file, detail });
}

export function logReviewGate(check, result, meta = Object()) {
  writeTaskLog("_review", { type: "GATE", check, result, ...meta });
}

export function logReviewIssue(severity, file, line, message, meta = Object()) {
  writeTaskLog("_review", { type: "REVIEW_ISSUE", severity, file, line, message, ...meta });
}

export function logReviewDone(result, issuesFound, issuesFixed, meta = Object()) {
  writeTaskLog("_review", { type: "DONE", result, issues_found: issuesFound, issues_fixed: issuesFixed, ...meta });
}

export function logReviewError(message, detail, meta = Object()) {
  writeTaskLog("_review", { type: "ERROR", message, detail: detail || "", ...meta });
}
