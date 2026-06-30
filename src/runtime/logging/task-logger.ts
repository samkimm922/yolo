// task-logger.js — 全量操作日志模块
// 数据契约：每个任务一个 JSONL 文件，progress-server 可实时 tail
// 路径：state/runtime/task-logs/{task_id}.jsonl
// Review：state/runtime/task-logs/_review.jsonl

import { appendFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSafePathComponent } from "../../lib/security/path-guard.js";
import { redact, redactDeep } from "../../lib/security/redact.js";
import { withLedgerAppendLock } from "../evidence/ledger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const YOLO_ROOT = resolve(__dirname, "../../..");
export const TASK_LOGS_DIR = join(YOLO_ROOT, "state", "runtime", "task-logs");
let taskLogsDir: string = TASK_LOGS_DIR;
let taskLogRunId: string | null = null;

// 日志条目：JSON 可序列化对象，字段由调用方决定；ts/task_id/run_id 由 writeTaskLog 自动注入
type TaskLogEntry = Record<string, unknown>;
// 可选元信息（review 日志），展开后合并进条目
type LogMeta = Record<string, unknown>;

// initTaskLogs 初始化选项（同时兼容 camelCase / snake_case）
type InitTaskLogsOptions = {
  taskLogsDir?: string;
  task_logs_dir?: string;
  runId?: string;
  run_id?: string;
};

export function setTaskLogsDir(dir: string = TASK_LOGS_DIR): string {
  taskLogsDir = resolve(dir);
  return taskLogsDir;
}

export function getTaskLogsDir(): string {
  return taskLogsDir;
}

export function setTaskLogRunId(runId: string | null = null): string | null {
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
export function initTaskLogs(options: InitTaskLogsOptions = Object()) {
  const dir = options.taskLogsDir || options.task_logs_dir;
  if (dir) setTaskLogsDir(dir);
  setTaskLogRunId(options.runId || options.run_id || null);
  try {
    if (!existsSync(taskLogsDir)) {
      mkdirSync(taskLogsDir, { recursive: true, mode: 0o700 });
    } else {
      // 清理上次运行的日志文件（保留目录）
      for (const f of readdirSync(taskLogsDir)) {
        try { unlinkSync(join(taskLogsDir, f)); } catch {}
      }
    }
  } catch (e) {
    console.error('[task-logger] initTaskLogs 失败:', e instanceof Error ? e.message : String(e));
    // best effort — 不阻塞主流程
  }
}

// ── 核心写入函数 ──────────────────────────────────────────────
// taskId: 任务 ID 或 "_review"
// entry: { type, ... } — ts 字段自动添加
export function writeTaskLog(taskId: string, entry: TaskLogEntry) {
  try {
    if (!isSafePathComponent(String(taskId))) {
      console.error(`[task-logger] writeTaskLog rejected unsafe taskId: ${taskId}`);
      return;
    }
    const runContext = taskLogRunId ? { run_id: taskLogRunId } : {};
    const safeEntry = redactDeep(entry || Object());
    const line = JSON.stringify({ ts: isoLocal(), ...safeEntry, task_id: taskId, ...runContext }) + "\n";
    const logPath = join(taskLogsDir, `${taskId}.jsonl`);
    // H8: serialize appends under the ledger lock so concurrent log writes don't
    // interleave past PIPE_BUF and corrupt lines.
    withLedgerAppendLock(logPath, {}, () => {
      appendFileSync(logPath, line, { encoding: "utf8", mode: 0o600 });
    });
  } catch (e) {
    console.error('[task-logger] writeTaskLog 失败:', e instanceof Error ? e.message : String(e));
    // crash-safe: 日志写入失败不阻塞主流程
  }
}

// ── 便捷工厂函数 ─────────────────────────────────────────────
export function logTaskStart(taskId: string, title: string) {
  writeTaskLog(taskId, { type: "TASK_START", title });
}

export function logTaskRead(taskId: string, file: string, detail: string) {
  writeTaskLog(taskId, { type: "READ", file, detail });
}

export function logTaskEdit(taskId: string, file: string, detail: string) {
  writeTaskLog(taskId, { type: "EDIT", file, detail });
}

export function logTaskBash(taskId: string, cmd: string, result: string, output: string | undefined) {
  writeTaskLog(taskId, { type: "BASH", cmd, result, output: redact(output?.slice(0, 500) || "") });
}

export function logTaskGate(taskId: string, check: string, result: string, errors: string[] | undefined) {
  writeTaskLog(taskId, { type: "GATE", check, result, errors: errors || [] });
}

export function logTaskFix(taskId: string, file: string, detail: string) {
  writeTaskLog(taskId, { type: "FIX", file, detail });
}

export function logTaskError(taskId: string, message: string, detail: string, stack: string) {
  writeTaskLog(taskId, { type: "ERROR", message, detail: detail || "", stack: stack || "" });
}

export function logTaskDone(taskId: string, result: string, durationMs: number, error?: string) {
  const entry: TaskLogEntry = Object.assign(Object(), { type: "DONE", result, duration_ms: durationMs });
  if (error) entry.error = error;
  writeTaskLog(taskId, entry);
}

// ── Review 专用 ──────────────────────────────────────────────
export function logReviewStart(scope: Record<string, unknown>, totalFiles: number, meta: LogMeta = Object()) {
  writeTaskLog("_review", { type: "REVIEW_START", scope, total_files: totalFiles, ...meta });
}

export function logReviewRead(file: string, detail: string) {
  writeTaskLog("_review", { type: "READ", file, detail });
}

export function logReviewGate(check: string, result: string, meta: LogMeta = Object()) {
  writeTaskLog("_review", { type: "GATE", check, result, ...meta });
}

export function logReviewIssue(severity: string, file: string, line: number | string, message: string, meta: LogMeta = Object()) {
  writeTaskLog("_review", { type: "REVIEW_ISSUE", severity, file, line, message, ...meta });
}

export function logReviewDone(result: string, issuesFound: number, issuesFixed: number, meta: LogMeta = Object()) {
  writeTaskLog("_review", { type: "DONE", result, issues_found: issuesFound, issues_fixed: issuesFixed, ...meta });
}

export function logReviewError(message: string, detail: string, meta: LogMeta = Object()) {
  writeTaskLog("_review", { type: "ERROR", message, detail: detail || "", ...meta });
}
