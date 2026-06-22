#!/usr/bin/env node
/**
 * YOLO Progress Dashboard — 实时显示 yolo 任务进度
 * 数据源：PRD 文件（单源真相），辅助 yolo-output.log（仅查当前 running 任务）
 * 增强功能：任务日志展示 + Review 进度展示 + 卡片布局
 *
 * 用法: node scripts/yolo/src/runtime/progress/server.js [--port=3456] [--prd=audit-fix-xxx.json]
 */
import { readFileSync, existsSync, readdirSync, statSync, watch, watchFile, unwatchFile } from "fs";
import { join, dirname, basename, resolve } from "path";
import { fileURLToPath } from "url";
import http from "http";
import { readLifecycleDashboard } from "./lifecycle-dashboard.js";
import { CSS as DASHBOARD_CSS, renderProgressDashboard } from "./dashboard-template.js";
import { isSafePathComponent, resolveWithinRoot } from "../../lib/security/path-guard.js";
import { readJsonlTail, readJsonlSince, readTextTail } from "../../lib/bounded-read.js";
import { redactDeep } from "../../lib/security/redact.js";
import { safeExecSync } from "../../lib/security/safe-exec.js";

// Bounded tail-read ceilings for dashboard logs. These files grow with run
// length; the caps keep per-request memory and event-loop time O(window)
// rather than O(file size). 512 KiB covers thousands of log lines while
// staying well clear of memory pressure under many concurrent SSE clients.
const LOG_TAIL_MAX_BYTES = 512 * 1024;
const LOG_TAIL_MAX_ENTRIES = 2000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const YOLO_ROOT = resolve(__dirname, "../../..");
const PROJECT_ROOT = resolve(YOLO_ROOT, "../..");
const STATS_FILE = join(YOLO_ROOT, "state", "runtime", "learn-stats.json");
const CURRENT_RUN_FILE = join(YOLO_ROOT, "state", "runtime", "current-run.json");
let taskLogsDir = join(YOLO_ROOT, "state", "runtime", "task-logs");
function getReviewLogFile() { return join(taskLogsDir, "_review.jsonl"); }
function getTaskLogsDir() { return taskLogsDir; }
function setTaskLogsDir(dir) { taskLogsDir = resolve(dir); }
const LOCAL_CORS_ORIGIN_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export const PROGRESS_SERVER_HOST = "127.0.0.1";

const PORT = parseInt(
  process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] || "3456",
);

// ── 自动发现 PRD ──────────────────────────────────────────────────
function findLatestPrd() {
  try {
    const searchDirs = [YOLO_ROOT, join(YOLO_ROOT, "data")];
    const files = [];
    for (const dir of searchDirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.json') && f !== 'package.json' && !f.startsWith('retry-')) {
          files.push({ name: f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs });
        }
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    for (const f of files) {
      try {
        const raw = readFileSync(f.path, 'utf8');
        const p = JSON.parse(raw);
        if (Array.isArray(p.tasks) && p.tasks.length > 0 && p.tasks[0].id && p.tasks[0].priority) return f.path;
      } catch {}
    }
  } catch {}
  return null;
}

// 优先从 current-run.json 读取当前 PRD
function resolvePrdFromCurrentRun() {
  try {
    if (existsSync(CURRENT_RUN_FILE)) {
      const run = JSON.parse(readFileSync(CURRENT_RUN_FILE, "utf8"));
      if (run.prd) {
        // prd 路径可能相对于项目根目录
        const absPath = run.prd.startsWith("/") ? run.prd : resolve(PROJECT_ROOT, run.prd);
        if (existsSync(absPath)) return absPath;
        // 也尝试相对于 scripts/yolo/
        const relPath = join(YOLO_ROOT, run.prd);
        if (existsSync(relPath)) return relPath;
        // 也尝试 scripts/yolo/data/
        const dataPath = join(YOLO_ROOT, "data", run.prd);
        if (existsSync(dataPath)) return dataPath;
      }
    }
  } catch {}
  return null;
}

function resolvePrdPath() {
  return resolvePrdFromCurrentRun()
    || process.argv.find((a) => a.startsWith("--prd="))?.split("=")[1]
    || findLatestPrd()
    || null;
}

// ── 单数据源：读 PRD ─────────────────────────────────────────────
function readPrd() {
  // 优先读 expanded-tasks.json（runner 写入的运行时状态）
  // 只在有活跃运行时才使用 expanded-tasks，避免展示历史残留数据
  const etFile = join(YOLO_ROOT, "state", "expanded-tasks.json");
  const currentRun = readCurrentRun();
  if (existsSync(etFile) && currentRun) {
    try {
      const etData = JSON.parse(readFileSync(etFile, "utf8"));
      const runnerActive = isRunnerActive();
      const tasks = (etData.tasks || []).map((t) => ({
        id: t.id,
        status: t.status === "done" ? "done"
          : t.status === "skipped" ? "skipped"
          : t.status === "failed" ? "failed"
          : t.status === "failed_no_code" ? "failed"
          : t.status === "running" && runnerActive ? "running"
          : t.status === "running" && t.failReason ? "failed"
          : t.status === "running" ? "pending"
          : "pending",
        priority: t.priority || "",
        description: t.title || t.description || t.id,
        phase: t.phase || "",
        phaseDetail: t.phaseDetail || "",
        retry: typeof t.retry === "number" ? t.retry : 0,
        failReason: t.failReason || "",
        time: t.updatedAt || "",
        elapsed: null,
      }));
      const done = tasks.filter((t) => t.status === "done").length;
      const skipped = tasks.filter((t) => t.status === "skipped").length;
      const failed = tasks.filter((t) => t.status === "failed").length;
      // 读 PRD 元数据（标题等）
      const prdFile = etData.source || resolvePrdPath();
      let prdMeta = Object();
      try { prdMeta = JSON.parse(readFileSync(prdFile, "utf8")); } catch (e) { console.warn('[progress-server] PRD 元数据解析失败:', e.message); }
      return { tasks, done: done + skipped, failed, total: tasks.length, prd: { ...prdMeta, tasks: etData.tasks } };
    } catch (e) { console.warn('[progress-server] PRD 解析失败:', e.message); }
  }
  // fallback: 读 PRD 原文件
  const prdFile = resolvePrdPath();
  if (!existsSync(prdFile)) return null;
  try {
    const prd = JSON.parse(readFileSync(prdFile, "utf8"));
    const runnerActive = isRunnerActive();
    const tasks = (prd.tasks || []).map((t) => ({
      id: t.id,
      status: t.status === "done" ? "done"
        : t.status === "skipped" ? "skipped"
        : t.status === "failed" ? "failed"
        : t.status === "failed_no_code" ? "failed"
        : t.status === "running" && runnerActive ? "running"
        : t.status === "running" && t.failReason ? "failed"
        : t.status === "running" ? "pending"
        : "pending",
      priority: t.priority || "",
      description: t.title || t.description || t.id,
      phase: t.phase || "",
      phaseDetail: t.phaseDetail || "",
      retry: typeof t.retry === "number" ? t.retry : 0,
      failReason: t.failReason || "",
      time: t.updatedAt || "",
      elapsed: null,
    }));

    const done = tasks.filter((t) => t.status === "done").length;
    const skipped = tasks.filter((t) => t.status === "skipped").length;
    const failed = tasks.filter((t) => t.status === "failed").length;

    return { tasks, done: done + skipped, failed, total: tasks.length, prd };
  } catch {
    return null;
  }
}

// ── 仅从 yolo-output.log 最后几行找当前正在跑的任务 ──────────────
function findCurrentRunning() {
  const logFile = join(YOLO_ROOT, "state", "yolo-output.log");
  if (!existsSync(logFile)) return null;
  try {
    // Bounded tail read: only the last 8 KiB is needed to find the most recent
    // running-task marker. Avoids reading multi-megabyte logs on every poll.
    const tail = readTextTail(logFile, 8192);
    if (!tail) return null;
    const lines = tail.text.split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^\[([^\]]+)\]\s*\(\d+s\)\s*(\d+)\/(\d+)\s+(\S+)\s+>>\s*(\([^)]+\))?\s*(.*)/);
      if (m) {
        const [, time, , , id, priority, description] = m;
        let phase = "claude";
        let phaseDetail = "";
        let retry = 0;
        let failReason = "";
        for (let j = i + 1; j < lines.length; j++) {
          const pl = lines[j];
          if (pl.includes("claude ok")) { phase = "gate"; phaseDetail = pl.trim(); }
          else if (pl.includes("gate PASS")) { phase = "commit"; phaseDetail = "gate PASS"; }
          else if (pl.match(/gate FAIL/)) { phase = "retry"; phaseDetail = pl.trim(); failReason = pl.trim(); }
          else if (pl.includes("commit ok")) { phase = "done"; phaseDetail = "commit ok"; }
          else if (pl.match(/exit=\d+,\s*重试\s+(\d+)\/(\d+)/)) {
            const rm = pl.match(/重试\s+(\d+)\/(\d+)/);
            if (rm) retry = parseInt(rm[1]);
            phase = "retry";
            failReason = pl.trim();
          }
        }
        return {
          id, time,
          priority: priority || "",
          description: description?.trim() || "",
          phase, phaseDetail, retry, failReason,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Runner 存活检测 ──────────────────────────────────────────────
function isRunnerActive() {
  // 优先检查 PID 文件（runner 写入到 state/runner.pid），比 pgrep 更可靠
  const pidFile = join(YOLO_ROOT, "state", "runner.pid");
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          // 额外检查: PID 文件 mtime 超过 1 小时视为过期
          const pidStat = statSync(pidFile);
          const ageMs = Date.now() - pidStat.mtimeMs;
          if (ageMs > 60 * 60 * 1000) {
            return false;  // PID 文件太久没更新，runner 已死但 PID 被回收
          }
          return true;
        } catch {}
      }
    } catch {}
  }
  // 回退到 pgrep (P12.I1: safeExecSync routes through parseCommandToArgv + spawnSync, no shell)
  try {
    const out = safeExecSync('pgrep -f "runner.js"', { timeout: 3000 });
    return out.trim().length > 0;
  } catch { return false; }
}

// ── 读 learn-stats.json ──────────────────────────────────────────
function readStats() {
  if (!existsSync(STATS_FILE)) return {};
  try { return JSON.parse(readFileSync(STATS_FILE, "utf8")); } catch { return {}; }
}

// ── Read current-run.json for run isolation ──────────────────────
function readCurrentRun() {
  if (!existsSync(CURRENT_RUN_FILE)) return null;
  try {
    const run = JSON.parse(readFileSync(CURRENT_RUN_FILE, "utf8"));
    const startedAt = new Date(run.started_at).getTime();
    const ageMs = Date.now() - startedAt;
    if (ageMs > 24 * 60 * 60 * 1000) return null;
    // 交叉验证：runner 是否真的存活（PID 检查）
    if (!isRunnerActive()) return null;
    return run;
  } catch { return null; }
}

// ── 读 review-log.jsonl ──────────────────────────────────────────
function readReviewLog() {
  const logFile = getReviewLogFile();
  if (!existsSync(logFile)) return null;
  try {
    // Bounded tail read: review-log.jsonl grows across review rounds; reading
    // the whole file on every poll (1s) pins the event loop for long runs.
    // currentRound / latestStatus / latestBugs derive from the newest entry
    // and are exact. totalRounds / totalBugs summarize the visible tail and
    // are exact whenever the log fits the window.
    const tail = readJsonlTail(logFile, { maxBytes: LOG_TAIL_MAX_BYTES, maxEntries: LOG_TAIL_MAX_ENTRIES });
    if (!tail) return null;
    const entries = tail.entries;
    if (entries.length === 0) return null;
    const latest = entries[entries.length - 1];
    const rounds = entries.filter((e) => e?.type === "unified-review");
    const totalBugs = rounds.reduce((sum, r) => sum + (r.bugs_found || 0), 0);
    return {
      currentRound: latest.round || 0,
      totalRounds: rounds.length,
      totalBugs,
      latestStatus:
        latest.type === "error"
          ? "error"
          : latest.bugs_found > 0
            ? "bugs_found"
            : "clean",
      latestBugs: latest.bugs_found || 0,
      latestError: latest.type === "error" ? latest.error : null,
    };
  } catch {
    return null;
  }
}

// ── Task Logs 读取 ──────────────────────────────────────────────
function readTaskLogSummaries() {
  if (!existsSync(taskLogsDir)) return [];
  try {
    // 只读当前 run 的 task-logs
    const currentRun = readCurrentRun();
    if (!currentRun) return [];

    const files = readdirSync(taskLogsDir).filter((f) => f.endsWith(".jsonl") && f !== "_review.jsonl");
    return files.map((f) => {
      const taskId = f.replace(".jsonl", "");
      const filePath = join(taskLogsDir, f);
      const stat = statSync(filePath);
      const tail = readJsonlTail(filePath, { maxBytes: LOG_TAIL_MAX_BYTES, maxEntries: LOG_TAIL_MAX_ENTRIES });
      const entries = tail ? tail.entries.map((entry) => redactDeep(entry)) : [];
      const startEntry = entries.find((e) => e?.type === "TASK_START");
      const doneEntry = [...entries].reverse().find((e) => e?.type === "DONE");
      const hasError = entries.some((e) => e?.type === "ERROR");
      const status = doneEntry
        ? (doneEntry.result === "completed" ? "done" : "failed")
        : hasError ? "failed" : "running";
      // log_count historically reflected entries.length; when the log exceeds
      // the tail window, surface the full file size instead so a truncated read
      // does not underreport activity (callers treat this as a rough magnitude,
      // never an exact line count to branch on).
      const logCount = tail && !tail.meta.truncated ? entries.length : stat.size;
      return {
        id: taskId,
        title: startEntry?.title || taskId,
        status,
        duration_ms: doneEntry?.duration_ms || null,
        log_count: logCount,
      };
    });
  } catch { return []; }
}

function readTaskLogEntries(taskId) {
  const safeTaskId = String(taskId ?? "");
  if (!isSafePathComponent(safeTaskId)) return null;
  const resolved = resolveWithinRoot(taskLogsDir, `${safeTaskId}.jsonl`);
  if (!resolved.ok || !resolved.path) return null;
  const filePath = resolved.path;
  if (!existsSync(filePath)) return null;
  // Bounded tail read: a single task log can grow large over a long-running
  // task; the dashboard only renders the most recent entries.
  const tail = readJsonlTail(filePath, { maxBytes: LOG_TAIL_MAX_BYTES, maxEntries: LOG_TAIL_MAX_ENTRIES });
  return tail ? tail.entries.map((entry) => redactDeep(entry)) : [];
}

function readReviewTaskLog() {
  const reviewLogFile = getReviewLogFile();
  if (!existsSync(reviewLogFile)) return null;
  const tail = readJsonlTail(reviewLogFile, { maxBytes: LOG_TAIL_MAX_BYTES, maxEntries: LOG_TAIL_MAX_ENTRIES });
  return tail ? tail.entries.map((entry) => redactDeep(entry)) : [];
}

function readLifecycleProgressData() {
  return readLifecycleDashboard({
    projectRoots: [PROJECT_ROOT, YOLO_ROOT],
    yoloRoot: YOLO_ROOT,
    reportLimit: 5,
    eventLimit: 8,
  });
}

// ── SSE 连接管理 ──────────────────────────────────────────────────
const sseClients = new Set<any>();

/** 最大 SSE 并发连接数（CWE-770 缓解） */
export const MAX_SSE_CLIENTS = 128;
/** 测试用 override，设为较小值以触发连接限制 */
export let _testSseMaxOverride: number | undefined;
export function _setSseMaxOverrideForTest(v: number | undefined) { _testSseMaxOverride = v; }
export function getSseClientCount(): number { return sseClients.size; }
export function resetSseClientsForTest() { sseClients.clear(); }
let taskLogsWatcher = null;
let currentRunWatcher = null;
let reviewLogWatcher = null;
let fileWatchersStarted = false;
let selfWatcher = null;
let selfRestartDebounceTimer = null;
const SELF_FILE_PATH = fileURLToPath(import.meta.url);
const watchedFiles = new Set<string>();

function watchFileTracked(filePath, options, listener) {
  watchFile(filePath, options, listener);
  watchedFiles.add(filePath);
}

function unwatchFileTracked(filePath) {
  try { unwatchFile(filePath); } catch {}
  watchedFiles.delete(filePath);
}

/** 向所有 SSE 客户端广播事件 */
function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    const state = Object.assign(Object(), client);
    try { state.res.write(payload); } catch { /* 连接已断开 */ }
  }
}

function localCorsHeaders(req) {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return {};
  const host = req.headers.host;
  if (typeof host !== "string" || !host) return {};
  try {
    const parsed = new URL(origin);
    const requestOrigin = new URL(`http://${host}`);
    if (
      parsed.protocol === "http:" &&
      parsed.origin === requestOrigin.origin &&
      LOCAL_CORS_ORIGIN_HOSTS.has(requestOrigin.hostname)
    ) {
      return {
        "Access-Control-Allow-Origin": origin,
        "Vary": "Origin",
      };
    }
  } catch {}
  return {};
}

function writeBadRequest(res) {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Bad Request" }));
}

function parseTaskLogId(pathname) {
  const encodedTaskId = pathname.slice("/api/task-logs/".length);
  try {
    const taskId = decodeURIComponent(encodedTaskId);
    return isSafePathComponent(taskId) ? taskId : null;
  } catch {
    return null;
  }
}

/** 读取 task-log 文件，返回指定字节偏移之后的新增条目。
 *  以字节偏移取代旧的「行号」实现，避免每次 watch 触发都 readFileSync 整个文件。 */
function readTaskLogIncremental(filePath, lastOffset) {
  const result = readJsonlSince(filePath, lastOffset, {
    maxBytes: LOG_TAIL_MAX_BYTES,
    maxEntries: LOG_TAIL_MAX_ENTRIES,
  });
  if (!result) return { entries: [], totalBytes: lastOffset };
  return {
    entries: result.entries.map((entry) => redactDeep(entry)),
    totalBytes: result.nextOffset,
    rotated: result.rotated,
  };
}

/** 处理新的 SSE 连接 */
function handleSSEConnection(req, res) {
  const sseLimit = _testSseMaxOverride ?? MAX_SSE_CLIENTS;
  if (sseClients.size >= sseLimit) {
    res.writeHead(503, { "Content-Type": "application/json", ...localCorsHeaders(req) });
    res.end(JSON.stringify({ error: "SSE connection limit reached", max: sseLimit }));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    ...localCorsHeaders(req),
  });

  // 每个连接维护自己的日志字节偏移（取代旧行号实现：每次 watch 触发
  // 不再 readFileSync 整个文件，而是从 lastOffset 增量读取新增尾部）
  const clientState = Object.assign(Object(), {
    res,
    taskLogPositions: new Map(), // taskId → 已发送字节偏移
  });

  sseClients.add(clientState);

  // 发送初始连接事件 + 全量当前状态
  const progressData = getProgressData();
  const stats = readStats();
  const taskLogSummaries = readTaskLogSummaries();
  const lifecycle = progressData?.lifecycle || readLifecycleProgressData();

  // 初始化每个 task-log 文件的字节偏移：以当前文件大小为起点，之后的
  // watcher 事件只推送新增内容。用 statSync 取 size，不读文件内容。
  for (const summary of taskLogSummaries) {
    try {
      clientState.taskLogPositions.set(summary.id, statSync(join(taskLogsDir, `${summary.id}.jsonl`)).size);
    } catch { /* ignore */ }
  }

  // 推送连接成功 + 全量状态
  res.write(`event: connected\ndata: ${JSON.stringify({
    progress: {
      tasks: progressData?.tasks || [],
      done: progressData?.done || 0,
      failed: progressData?.failed || 0,
      total: progressData?.total || 0,
      current: progressData?.current || null,
      runnerActive: progressData?.runnerActive ?? false,
      stats,
      review: progressData?.review || null,
      source: progressData?.source || "none",
      currentRun: progressData?.currentRun || null,
      lifecycle,
      timestamp: new Date().toISOString(),
    },
  })}\n\n`);

  // 心跳（每 30 秒）
  const heartbeat = setInterval(() => {
    try { res.write(":heartbeat\n\n"); } catch { clearInterval(heartbeat); }
  }, 30000);
  clientState._heartbeat = heartbeat;

  // 连接关闭时清理
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(clientState);
    clientState.taskLogPositions.clear();
  });
}

/** 启动文件监听器 */
function startFileWatchers() {
  if (fileWatchersStarted) return;
  fileWatchersStarted = true;
  // 监听 task-logs 目录变化
  try {
    if (existsSync(taskLogsDir)) {
      taskLogsWatcher = watch(taskLogsDir, { recursive: false }, (eventType, filename) => {
        if (!filename || !filename.endsWith(".jsonl")) return;
        const taskId = filename.replace(".jsonl", "");
        const filePath = join(taskLogsDir, filename);

        for (const client of sseClients) {
          const state = Object.assign(Object(), client);
          const lastPos = state.taskLogPositions.get(taskId) || 0;
          const { entries, totalBytes } = readTaskLogIncremental(filePath, lastPos);
          state.taskLogPositions.set(taskId, totalBytes);

          if (entries.length > 0) {
            try {
              state.res.write(`event: task-log\ndata: ${JSON.stringify({ taskId, entries })}\n\n`);
            } catch { /* 连接已断开 */ }
          }
        }
      });
    }
  } catch { /* 目录不存在或无法监听 */ }

  // 监听 current-run.json 变化（用 watchFile 做轮询式监听，更可靠）
  if (existsSync(CURRENT_RUN_FILE)) {
    watchFileTracked(CURRENT_RUN_FILE, { interval: 1000 }, () => {
      const run = readCurrentRun();
      sseBroadcast("run-status", { currentRun: run });
    });
    currentRunWatcher = true;
  }

  // 监听 review-log.jsonl 变化
  if (existsSync(getReviewLogFile())) {
    watchFileTracked(getReviewLogFile(), { interval: 1000 }, () => {
      const review = readReviewLog();
      sseBroadcast("review-status", { review });
    });
    reviewLogWatcher = true;
  }

  // 监听 expanded-tasks.json 变化 → 推送全量进度更新（runner 写入此文件）
  const etFile = join(YOLO_ROOT, "state", "expanded-tasks.json");
  if (existsSync(etFile)) {
    watchFileTracked(etFile, { interval: 2000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        const progressData = getProgressData();
        const stats = readStats();
        sseBroadcast("progress", {
          tasks: progressData?.tasks || [],
          done: progressData?.done || 0,
          failed: progressData?.failed || 0,
          total: progressData?.total || 0,
          current: progressData?.current || null,
          runnerActive: progressData?.runnerActive ?? false,
          stats,
          review: progressData?.review || null,
          source: progressData?.source || "none",
          currentRun: progressData?.currentRun || null,
          lifecycle: progressData?.lifecycle || readLifecycleProgressData(),
          timestamp: new Date().toISOString(),
        });
      }
    });
  }

  // 监听 PRD 文件变化 → 推送全量进度更新
  let lastWatchedPrd = resolvePrdPath();
  const onPrdChange = () => {
    // 如果 PRD 路径发生变化（新 run），切换监听目标
    const currentPrd = resolvePrdPath();
    if (currentPrd !== lastWatchedPrd) {
      if (lastWatchedPrd) unwatchFileTracked(lastWatchedPrd);
      lastWatchedPrd = currentPrd;
      if (lastWatchedPrd) {
        watchFileTracked(lastWatchedPrd, { interval: 2000 }, onPrdChange);
      }
    }
    const progressData = getProgressData();
    const stats = readStats();
    sseBroadcast("progress", {
      tasks: progressData?.tasks || [],
      done: progressData?.done || 0,
      failed: progressData?.failed || 0,
      total: progressData?.total || 0,
      current: progressData?.current || null,
      runnerActive: progressData?.runnerActive ?? false,
      stats,
      review: progressData?.review || null,
      source: progressData?.source || "none",
      currentRun: progressData?.currentRun || null,
      lifecycle: progressData?.lifecycle || readLifecycleProgressData(),
      timestamp: new Date().toISOString(),
    });
  };
  if (lastWatchedPrd) {
    watchFileTracked(lastWatchedPrd, { interval: 2000 }, onPrdChange);
  }
}

/** 启动自身文件监听（用于开发时自动重启） */
function startSelfWatcher() {
  try {
    selfWatcher = watch(SELF_FILE_PATH, (eventType, filename) => {
      clearTimeout(selfRestartDebounceTimer);
      selfRestartDebounceTimer = setTimeout(() => {
        process.stderr.write('[self-restart] 检测到文件变化，正在重启...\n');
        process.exit(0);
      }, 500);
    });
  } catch (e) {
    console.warn('[self-restart] 无法启动自身文件监听:', e.message);
  }
}

function closeProgressServerResources() {
  if (taskLogsWatcher) {
    try { taskLogsWatcher.close(); } catch {}
    taskLogsWatcher = null;
  }
  for (const filePath of [...watchedFiles]) {
    unwatchFileTracked(filePath);
  }
  currentRunWatcher = null;
  reviewLogWatcher = null;
  fileWatchersStarted = false;
  if (selfRestartDebounceTimer) {
    clearTimeout(selfRestartDebounceTimer);
    selfRestartDebounceTimer = null;
  }
  if (selfWatcher) {
    try { selfWatcher.close(); } catch {}
    selfWatcher = null;
  }
  for (const client of [...sseClients]) {
    try { clearInterval(client._heartbeat); } catch {}
    try { client.res.end(); } catch {}
    try { client.taskLogPositions?.clear?.(); } catch {}
    sseClients.delete(client);
  }
}

// ── 组装进度数据 ───────────────────────────────────────────────
function getProgressData() {
  const prdData = readPrd();
  if (!prdData) {
    return {
      tasks: [], done: 0, failed: 0, total: 0, current: null,
      runnerActive: false, source: "none", review: null, currentRun: readCurrentRun(), lifecycle: readLifecycleProgressData(),
    };
  }

  const { tasks, done, failed, total } = prdData;
  const runnerActive = isRunnerActive();
  const current = runnerActive ? findCurrentRunning() : null;

  if (current) {
    const existing = tasks.find((t) => t.id === current.id);
    if (existing) {
      existing.status = "running";
      existing.phase = current.phase;
      existing.phaseDetail = current.phaseDetail;
      existing.retry = current.retry;
      existing.failReason = current.failReason;
      existing.time = current.time;
    } else {
      tasks.push({
        id: current.id,
        status: "running",
        priority: current.priority,
        description: current.description,
        phase: current.phase,
        phaseDetail: current.phaseDetail,
        retry: current.retry,
        failReason: current.failReason,
        time: current.time,
        elapsed: null,
      });
    }
  }

  return { tasks, done, failed, total, current, runnerActive, source: "prd", review: readReviewLog(), currentRun: readCurrentRun(), lifecycle: readLifecycleProgressData() };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function lifecycleIdleSummary(lifecycle = Object()) {
  const counts = lifecycle.stage_counts || {};
  if (!lifecycle.exists) {
    return `
  <div class="idle-lifecycle">
    <div class="idle-lifecycle-title">Lifecycle 未初始化</div>
    <div class="idle-lifecycle-sub">${escapeHtml(lifecycle.next_action || "Run /yolo-init first.")}</div>
  </div>`;
  }
  return `
  <div class="idle-lifecycle">
    <div class="idle-lifecycle-title">Lifecycle: ${escapeHtml(lifecycle.current_stage || "unknown")}</div>
    <div class="idle-lifecycle-grid">
      <span>完成 <strong>${counts.completed || 0}</strong></span>
      <span>阻塞 <strong>${lifecycle.blocker_count || 0}</strong></span>
      <span>证据 <strong>${lifecycle.evidence_count || 0}</strong></span>
    </div>
    <div class="idle-lifecycle-sub">${escapeHtml(lifecycle.next_action || "Continue lifecycle work.")}</div>
  </div>`;
}

// ── CSS 模板（卡片布局 + 日志展示 + 手机端响应式）─────────────────
const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root, html[data-theme="light"] {
    color-scheme: light dark;
    --bg: #f8fafc;
    --surface: #ffffff;
    --surface-muted: #f1f5f9;
    --surface-strong: #e2e8f0;
    --text: #0f172a;
    --text-strong: #020617;
    --text-muted: #64748b;
    --text-subtle: #94a3b8;
    --border: #e2e8f0;
    --border-strong: #cbd5e1;
    --hover: rgba(15, 23, 42, 0.04);
    --shadow: 0 18px 48px rgba(15, 23, 42, 0.08);
    --ok: #16a34a;
    --ok-bg: #dcfce7;
    --ok-text: #166534;
    --danger: #dc2626;
    --danger-bg: #fee2e2;
    --danger-text: #991b1b;
    --warn: #d97706;
    --warn-bg: #fef3c7;
    --warn-text: #92400e;
    --pending-bg: #f1f5f9;
    --pending-text: #64748b;
    --accent: #2563eb;
    --review: #7c3aed;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f172a;
      --surface: #1e293b;
      --surface-muted: #111827;
      --surface-strong: #0f172a;
      --text: #e2e8f0;
      --text-strong: #f8fafc;
      --text-muted: #94a3b8;
      --text-subtle: #64748b;
      --border: #334155;
      --border-strong: #1e293b;
      --hover: rgba(255, 255, 255, 0.03);
      --shadow: none;
      --ok: #22c55e;
      --ok-bg: #14532d;
      --ok-text: #86efac;
      --danger: #ef4444;
      --danger-bg: #7f1d1d;
      --danger-text: #fca5a5;
      --warn: #f59e0b;
      --warn-bg: #78350f;
      --warn-text: #fde68a;
      --pending-bg: #1e293b;
      --pending-text: #64748b;
      --accent: #3b82f6;
      --review: #8b5cf6;
    }
  }
  html[data-theme="dark"] {
    --bg: #0f172a;
    --surface: #1e293b;
    --surface-muted: #111827;
    --surface-strong: #0f172a;
    --text: #e2e8f0;
    --text-strong: #f8fafc;
    --text-muted: #94a3b8;
    --text-subtle: #64748b;
    --border: #334155;
    --border-strong: #1e293b;
    --hover: rgba(255, 255, 255, 0.03);
    --shadow: none;
    --ok: #22c55e;
    --ok-bg: #14532d;
    --ok-text: #86efac;
    --danger: #ef4444;
    --danger-bg: #7f1d1d;
    --danger-text: #fca5a5;
    --warn: #f59e0b;
    --warn-bg: #78350f;
    --warn-text: #fde68a;
    --pending-bg: #1e293b;
    --pending-text: #64748b;
    --accent: #3b82f6;
    --review: #8b5cf6;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; padding: 8px; -webkit-text-size-adjust: 100%; overflow-x: hidden; font-size: 14px; }
  .header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  h1 { font-size: 15px; font-weight: 700; color: var(--text-strong); flex-shrink: 0; }
  .progress-bar-wrap { flex: 1; min-width: 60px; height: 14px; background: var(--surface-strong); border-radius: 7px; overflow: hidden; }
  .progress-bar { height: 100%; background: linear-gradient(90deg, var(--ok), #16a34a); border-radius: 7px; transition: width 0.5s ease; }
  .pct { font-size: 13px; font-weight: 700; color: var(--ok); min-width: 40px; flex-shrink: 0; }

  /* 统计卡片：小屏 2 列，大屏 4 列 */
  .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px; margin-bottom: 8px; }
  .stat { background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); padding: 8px 4px; border-radius: 6px; text-align: center; font-size: 11px; min-height: 44px; display: flex; flex-direction: column; justify-content: center; }
  .stat strong { color: var(--text-strong); font-size: 16px; display: block; }
  .stat.done strong { color: var(--ok); }
  .stat.failed strong { color: var(--danger); }
  .stat.running strong { color: var(--warn); }

  .main { display: flex; flex-direction: column; gap: 10px; }
  .section-title { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; font-weight: 600; }

  /* 卡片列表：手机端不限高，方便滚动浏览 */
  .task-list { display: flex; flex-direction: column; gap: 4px; max-height: none; overflow-y: auto; -webkit-overflow-scrolling: touch; }

  /* 任务卡片 */
  .task-card {
    background: var(--surface); border-radius: 8px; overflow: hidden;
    border: 1px solid var(--border); box-shadow: var(--shadow);
    border-left: 3px solid transparent; transition: border-color 0.2s;
  }
  .task-card[data-status="running"] { border-left-color: var(--warn); }
  .task-card[data-status="done"] { border-left-color: var(--ok); }
  .task-card[data-status="failed"] { border-left-color: var(--danger); }
  .task-card[data-status="skipped"] { border-left-color: var(--text-muted); }
  .task-card[data-status="pending"] { border-left-color: var(--text-subtle); }

  /* 点击区域至少 44px 高，方便手机触控 */
  .task-header {
    display: flex; align-items: center; gap: 6px;
    padding: 10px 8px; min-height: 44px; cursor: pointer; user-select: none;
    flex-wrap: wrap;
  }
  .task-header:hover { background: var(--hover); }
  .task-chevron { color: var(--text-subtle); font-size: 10px; transition: transform 0.2s; flex-shrink: 0; }
  .task-card.expanded .task-chevron { transform: rotate(90deg); }
  .task-id { font-weight: 600; font-size: 12px; flex-shrink: 0; }
  .status-id-done { color: var(--ok); }
  .status-id-failed { color: var(--danger); }
  .status-id-running { color: var(--warn); }
  .status-id-skipped { color: var(--text-muted); }
  .status-id-pending { color: var(--text-subtle); }
  .review-task-id { color: var(--review); }
  .task-desc { color: var(--text-muted); font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  /* 徽章区：小屏允许换行 */
  .task-badges { display: flex; gap: 4px; align-items: center; flex-shrink: 0; flex-wrap: wrap; }
  .phase-chip { display: inline-block; font-size: 10px; padding: 2px 6px; border-radius: 3px; border: 1px solid; font-weight: 600; white-space: nowrap; }
  .retry-chip { display: inline-block; font-size: 10px; padding: 2px 5px; border-radius: 3px; background: var(--danger-bg); color: var(--danger-text); font-weight: 700; white-space: nowrap; cursor: help; }
  .status-tag { display: inline-block; font-size: 10px; padding: 2px 6px; border-radius: 3px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .status-tag.passed { background: var(--ok-bg); color: var(--ok-text); }
  .status-tag.failed { background: var(--danger-bg); color: var(--danger-text); }
  .status-tag.running { background: var(--warn-bg); color: var(--warn-text); }
  .status-tag.pending { background: var(--pending-bg); color: var(--pending-text); }
  .task-prio { font-size: 10px; color: var(--text-muted); }
  .task-duration { font-size: 10px; color: var(--text-subtle); flex-shrink: 0; }

  /* 折叠区域 */
  .task-body { display: none; border-top: 1px solid var(--border); }
  .task-card.expanded .task-body { display: block; }
  .task-body-inner { padding: 6px 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }

  /* 日志行 */
  .log-list { display: flex; flex-direction: column; gap: 2px; }
  .log-line {
    display: flex; align-items: flex-start; gap: 4px;
    font-size: 11px; font-family: 'SF Mono', 'Menlo', monospace;
    padding: 3px 0; line-height: 1.4;
  }
  .log-icon { flex-shrink: 0; width: 14px; text-align: center; }
  .log-time { color: var(--text-subtle); flex-shrink: 0; font-size: 10px; min-width: 40px; }
  .log-text { color: var(--text-muted); word-break: break-all; flex: 1; min-width: 0; overflow-wrap: break-word; }
  .log-text.has-output { cursor: pointer; }
  .log-text.has-output:hover { color: var(--text); }
  .bash-toggle { border: 0; background: transparent; color: var(--text-muted); cursor: pointer; padding: 0 4px; font: inherit; }
  .bash-toggle:hover { color: var(--text); }
  .log-line.error-line .log-text { color: var(--danger); }
  .log-line.error-line { background: color-mix(in srgb, var(--danger) 10%, transparent); border-radius: 3px; padding: 3px 4px; }
  .log-line.fail-line .log-text { color: var(--danger-text); }
  .log-line.pass-line .log-text { color: var(--ok-text); }

  /* 日志输出折叠：手机端可横向滚动 */
  .log-output {
    display: none; background: var(--surface-muted); border-radius: 4px; padding: 6px 8px;
    margin-top: 4px; font-size: 10px; color: var(--text-muted); white-space: pre-wrap;
    word-break: break-all; max-height: 150px; overflow: auto;
    border: 1px solid var(--border); -webkit-overflow-scrolling: touch;
  }
  .log-output.visible { display: block; }

  .fail-reason { color: var(--danger); font-size: 11px; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: help; word-break: break-all; }
  .task-meta { display: flex; gap: 8px; color: var(--text-subtle); font-size: 10px; margin-top: 2px; flex-wrap: wrap; }
  .phase-detail { color: var(--text-muted); font-size: 10px; word-break: break-all; }
  .task-grayed { opacity: 0.4; filter: grayscale(0.6); }
  .runner-warn { background: var(--danger-bg); color: var(--danger-text); padding: 8px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; text-align: center; margin-bottom: 8px; }
  .runner-ok { background: var(--ok-bg); color: var(--ok-text); padding: 6px 10px; border-radius: 4px; font-size: 10px; text-align: center; margin-bottom: 8px; }

  /* UI Evidence 面板 */
  .ui-evidence-panel {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px;
    box-shadow: var(--shadow);
    margin-bottom: 16px; display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px;
  }
  .evidence-item { display: flex; flex-direction: column; gap: 4px; }
  .evidence-label { color: var(--text-muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
  .evidence-value { color: var(--text); font-size: 12px; font-weight: 600; }

  /* Review 卡片 */
  .review-card {
    background: var(--surface); border-radius: 8px; overflow: hidden;
    border: 1px solid var(--border); box-shadow: var(--shadow);
  }
  .review-header {
    display: flex; align-items: center; gap: 6px;
    padding: 10px 8px; min-height: 44px; cursor: pointer; user-select: none;
  }
  .review-header:hover { background: var(--hover); }
  .review-body { display: none; border-top: 1px solid var(--border); }
  .review-card.expanded .review-body { display: block; }
  .review-body-inner { padding: 6px 8px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .review-issue {
    padding: 6px 8px; margin-bottom: 4px; border-radius: 4px; font-size: 11px;
    border-left: 2px solid; word-break: break-word;
  }
  .review-issue.severity-critical { background: color-mix(in srgb, var(--danger) 10%, transparent); border-left-color: var(--danger); }
  .review-issue.severity-high { background: rgba(249,115,22,0.08); border-left-color: #f97316; }
  .review-issue.severity-medium { background: color-mix(in srgb, var(--warn) 10%, transparent); border-left-color: var(--warn); }
  .review-issue.severity-low { background: color-mix(in srgb, var(--text-muted) 10%, transparent); border-left-color: var(--text-muted); }
  .review-issue .issue-sev { font-weight: 700; text-transform: uppercase; font-size: 10px; margin-right: 6px; }
  .issue-sev-critical { color: var(--danger); }
  .issue-sev-high { color: #f97316; }
  .issue-sev-medium { color: var(--warn); }
  .issue-sev-low { color: var(--text-muted); }
  .review-issue .issue-file { color: var(--text-muted); font-size: 10px; word-break: break-all; }
  .review-issue .issue-msg { color: var(--text); margin-top: 2px; }
  .review-summary { font-size: 11px; color: var(--text-muted); padding: 4px 0; }
  .review-result-pass { color: var(--ok); }
  .review-result-fail { color: var(--danger); }
  .review-waiting { color: var(--text-muted); font-size: 11px; margin-bottom: 10px; }
  .review-status-box { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 10px; box-shadow: var(--shadow); }
  .review-status-title { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; font-weight: 600; }
  .review-row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; font-size: 12px; border-bottom: 1px solid var(--border); }
  .review-row:last-child { border-bottom: none; }
  .review-row span { color: var(--text-muted); }
  .review-count.ok { color: var(--ok); }
  .review-count.attention { color: var(--warn); }

  .sidebar { background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); border-radius: 8px; padding: 8px; }
  .sidebar h3 { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; font-weight: 600; }
  .sidebar ul { list-style: none; }
  .sidebar li { padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  .sidebar li:last-child { border-bottom: none; }
  .sidebar strong { color: var(--danger); }
  .failed-gates-empty { color: var(--text-subtle); }
  .refresh { font-size: 10px; color: var(--text-subtle); margin-top: 6px; }
  .source { font-size: 10px; color: var(--text-subtle); margin-top: 4px; word-break: break-all; }
  .empty { text-align: center; color: var(--text-subtle); padding: 24px 0; font-size: 13px; }
  .done-banner { background: var(--ok); color: #052e16; padding: 10px; border-radius: 8px; font-size: 14px; font-weight: 700; text-align: center; margin-bottom: 8px; }
  .run-id { font-size: 10px; color: var(--text-muted); text-align: right; margin-bottom: 4px; word-break: break-all; }
  .log-empty { color: var(--text-subtle); font-size: 11px; text-align: center; padding: 8px; }
  .log-loading { color: var(--text-subtle); font-size: 11px; text-align: center; padding: 8px; }

  /* 手机端（< 640px）专用优化 */
  @media (max-width: 639px) {
    /* 任务卡片第二行放描述和徽章 */
    .task-header { gap: 4px; }
    .task-desc { flex-basis: 100%; order: 10; padding-left: 20px; }
    .task-badges { order: 11; padding-left: 20px; }
    .task-duration { order: 12; }
    .status-tag { order: 5; }
  }

  /* 平板及桌面端 */
  @media (min-width: 640px) {
    body { padding: 20px; }
    h1 { font-size: 20px; }
    .progress-bar-wrap { height: 22px; border-radius: 11px; }
    .progress-bar { border-radius: 11px; }
    .pct { font-size: 16px; }
    .stats { grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 16px; }
    .stat { padding: 10px 14px; font-size: 13px; border-radius: 8px; }
    .stat strong { font-size: 22px; }
    .main { display: grid; grid-template-columns: 1fr 280px; gap: 16px; align-items: start; }
    .task-list { max-height: none; gap: 6px; }
    .task-header { padding: 12px 14px; }
    .task-id { font-size: 13px; }
    .task-desc { font-size: 12px; }
  }
`;

// ── JS 模板（客户端逻辑 — SSE 实时推送）────────────────────────
const CLIENT_JS = `
(function() {
  var expandedCards = Object();
  var loadedLogs = Object();
  var currentProgress = null;

  // 展开/折叠切换
  function toggleCard(card) {
    var taskId = card.getAttribute('data-task-id');
    var isExpanded = card.classList.contains('expanded');
    if (isExpanded) {
      card.classList.remove('expanded');
      expandedCards[taskId] = false;
    } else {
      card.classList.add('expanded');
      expandedCards[taskId] = true;
      if (!loadedLogs[taskId]) {
        loadTaskLog(taskId, card);
      }
    }
  }

  function loadTaskLog(taskId, card) {
    var body = card.querySelector('.log-list');
    if (!body) return;
    setStatusMessage(body, 'log-loading', '加载中...');
    fetch('/api/task-logs/' + encodeURIComponent(taskId))
      .then(function(r) { return r.json(); })
      .then(function(entries) {
        loadedLogs[taskId] = true;
        if (!entries || entries.length === 0) {
          setStatusMessage(body, 'log-empty', '暂无日志');
          return;
        }
        replaceWithMarkup(body, renderLogEntries(entries));
      })
      .catch(function() {
        setStatusMessage(body, 'log-empty', '日志加载失败');
      });
  }

  function appendLogEntries(taskId, entries) {
    var card = findTaskCardById(taskId);
    if (!card || !card.classList.contains('expanded')) return;
    var body = card.querySelector('.log-list');
    if (!body) return;

    // 移除占位符
    var placeholder = body.querySelector('.log-empty, .log-loading');
    if (placeholder) placeholder.remove();

    var html = renderLogEntries(entries);
    appendMarkup(body, html);
  }

  function renderLogEntries(entries) {
    return entries.map(function(e) { return renderLogLine(e); }).join('');
  }

  function renderLogLine(e) {
    var icon = '', cls = '', text = '';
    var ts = e.ts ? e.ts.split('T')[1]?.split('+')[0]?.substring(0,5) || '' : '';

    switch (e.type) {
      case 'TASK_START':
        icon = '&#9654;'; cls = ''; text = '开始: ' + escapeHtml(e.title || e.task_id || '');
        break;
      case 'READ':
        icon = '&#128196;'; cls = ''; text = '读取 ' + escapeHtml(e.file || '') + (e.detail ? ' — ' + escapeHtml(e.detail) : '');
        break;
      case 'EDIT':
        icon = '&#9998;'; cls = ''; text = '编辑 ' + escapeHtml(e.file || '') + (e.detail ? ' — ' + escapeHtml(e.detail) : '');
        break;
      case 'BASH':
        icon = '&#9889;'; cls = e.result === 'fail' ? 'fail-line' : e.result === 'pass' ? 'pass-line' : '';
        text = escapeHtml(e.cmd || '');
        if (e.result === 'fail' && e.output) {
          text += ' <button type="button" class="bash-toggle" aria-label="切换输出">&#9660;</button>';
          text += '<div class="log-output">' + escapeHtml(e.output) + '</div>';
        }
        break;
      case 'GATE':
        icon = '&#128737;'; cls = e.result === 'fail' ? 'fail-line' : e.result === 'pass' ? 'pass-line' : '';
        text = 'Gate: ' + escapeHtml(e.check || '') + ' — ' + escapeHtml(e.result || '');
        if (e.result === 'fail' && e.errors && e.errors.length > 0) {
          text += ' <button type="button" class="bash-toggle" aria-label="切换输出">&#9660;</button>';
          text += '<div class="log-output">' + e.errors.map(escapeHtml).join('\\n') + '</div>';
        }
        break;
      case 'FIX':
        icon = '&#128295;'; cls = ''; text = '修复 ' + escapeHtml(e.file || '') + (e.detail ? ' — ' + escapeHtml(e.detail) : '');
        break;
      case 'ERROR':
        icon = '&#10060;'; cls = 'error-line'; text = escapeHtml(e.message || 'Error') + (e.detail ? ' — ' + escapeHtml(e.detail) : '');
        break;
      case 'DONE':
        icon = e.result === 'completed' ? '&#9989;' : '&#10060;';
        cls = e.result === 'completed' ? 'pass-line' : 'fail-line';
        text = e.result === 'completed' ? '完成' : '失败';
        if (e.duration_ms) text += ' (' + formatDuration(e.duration_ms) + ')';
        break;
      default:
        icon = '&#8226;'; cls = ''; text = escapeHtml(e.type || '') + ' ' + escapeHtml(e.detail || e.message || '');
    }

    return '<div class="log-line ' + cls + '">' +
      '<span class="log-icon">' + icon + '</span>' +
      '<span class="log-time">' + ts + '</span>' +
      '<span class="log-text">' + text + '</span>' +
    '</div>';
  }

  function escapeHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function replaceWithMarkup(node, markup) {
    var range = document.createRange();
    range.selectNodeContents(node);
    node.replaceChildren(range.createContextualFragment(markup));
  }

  function appendMarkup(node, markup) {
    var range = document.createRange();
    range.selectNodeContents(node);
    node.appendChild(range.createContextualFragment(markup));
  }

  function setStatusMessage(node, className, text) {
    var el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    node.replaceChildren(el);
  }

  function safeToken(value, fallback) {
    var token = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
    return token || fallback || 'unknown';
  }

  function findTaskCardById(taskId) {
    var cards = document.querySelectorAll('.task-card');
    var raw = String(taskId || '');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-task-id') === raw) return cards[i];
    }
    return null;
  }

  function formatDuration(ms) {
    if (ms < 1000) return ms + 'ms';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + 'm' + (s > 0 ? s + 's' : '');
  }

  // Review 卡片展开
  function toggleReview(card) {
    var isExpanded = card.classList.contains('expanded');
    if (isExpanded) {
      card.classList.remove('expanded');
    } else {
      card.classList.add('expanded');
      loadReviewLog(card);
    }
  }

  function loadReviewLog(card) {
    var body = card.querySelector('.review-log-list');
    if (!body || body.dataset.loaded === 'true') return;
    setStatusMessage(body, 'log-loading', '加载中...');
    fetch('/api/review-log')
      .then(function(r) { return r.json(); })
      .then(function(entries) {
        body.dataset.loaded = 'true';
        if (!entries || entries.length === 0) {
          setStatusMessage(body, 'log-empty', '暂无 Review 日志');
          return;
        }
        replaceWithMarkup(body, renderReviewEntries(entries));
      })
      .catch(function() {
        setStatusMessage(body, 'log-empty', '日志加载失败');
      });
  }

  function renderReviewEntries(entries) {
    var html = '';
    entries.forEach(function(e) {
      if (e.type === 'REVIEW_START') {
        html += '<div class="review-summary">审查开始: ' + escapeHtml(e.scope || 'full') + ' — ' + escapeHtml(e.total_files || '?') + ' 个文件</div>';
      } else if (e.type === 'REVIEW_ISSUE') {
        var sev = safeToken(String(e.severity || 'medium').toLowerCase(), 'medium');
        html += '<div class="review-issue severity-' + sev + '">' +
          '<span class="issue-sev issue-sev-' + sev + '">' + escapeHtml(sev) + '</span>' +
          (e.file ? '<span class="issue-file">' + escapeHtml(e.file) + (e.line ? ':' + escapeHtml(e.line) : '') + '</span>' : '') +
          '<div class="issue-msg">' + escapeHtml(e.message || '') + '</div>' +
        '</div>';
      } else if (e.type === 'DONE') {
        var resultClass = e.result === 'pass' ? 'review-result-pass' : 'review-result-fail';
        html += '<div class="review-summary ' + resultClass + '">' +
          (e.result === 'pass' ? '&#9989; 通过' : '&#10060; 未通过') +
          ' — 发现 ' + (e.issues_found || 0) + ' 个问题' +
          (e.issues_fixed ? '，修复 ' + e.issues_fixed + ' 个' : '') +
        '</div>';
      }
    });
    return html || '<div class="log-empty">暂无数据</div>';
  }

  // ── 更新进度条和统计数字 ────────────────────────────────────────
  function updateProgressUI(d) {
    currentProgress = d;
    var pct = d.total > 0 ? Math.round((d.done / d.total) * 100) : 0;
    var bar = document.getElementById('progressBar');
    if (bar) bar.style.width = pct + '%';
    var pctText = document.getElementById('pctText');
    if (pctText) pctText.textContent = pct + '%';
    document.title = 'YOLO Progress — ' + pct + '%';

    // 更新统计数字
    var statsRow = document.getElementById('statsRow');
    if (statsRow && d.tasks) {
      var runningCount = d.tasks.filter(function(t) { return t.status === 'running'; }).length;
      var pendingCount = d.tasks.filter(function(t) { return t.status === 'pending'; }).length;
      var cells = statsRow.querySelectorAll('.stat strong');
      if (cells.length >= 4) {
        cells[0].textContent = d.done;
        cells[1].textContent = d.failed;
        cells[2].textContent = runningCount;
        cells[3].textContent = Math.max(0, pendingCount);
      }
    }

    // 重新渲染任务列表（局部更新，保留展开状态）
    renderTaskList(d);
  }

  function renderTaskList(d) {
    if (!d || !d.tasks) return;
    var scrollY = window.scrollY;
    var taskList = document.getElementById('taskList');
    if (!taskList) return;

    var statusIcon = { done: '\\u2713', failed: '\\u2717', running: '\\u2026', skipped: '\\u2212', pending: '\\u25CB' };
    var statusTag = { done: 'passed', failed: 'failed', running: 'running', skipped: 'passed', pending: 'pending' };
    var phaseLabel = { precheck: ['预检','#64748b'], claude: ['Claude','#8b5cf6'], gate: ['闸门','#f59e0b'], commit: ['提交','#3b82f6'], retry: ['重试','#ef4444'], done: ['完成','#22c55e'], failed: ['失败','#ef4444'] };

    var html = d.tasks.map(function(t) {
      var rawTaskId = String(t.id || '');
      var taskId = escapeHtml(rawTaskId);
      var taskAttr = escapeAttr(rawTaskId);
      var rawStatus = String(t.status || 'pending');
      var status = safeToken(rawStatus, 'pending');
      var grayed = !d.runnerActive && rawStatus === 'running' ? ' task-grayed' : '';
      var p = t.phase || '';
      var phaseInfo = phaseLabel[p] || (p ? [p, '#475569'] : ['', '']);
      var phaseChip = p ? '<span class="phase-chip" style="border-color:' + phaseInfo[1] + ';color:' + phaseInfo[1] + '">' + escapeHtml(phaseInfo[0]) + '</span>' : '';
      var retry = Number(t.retry || 0);
      var retryChip = retry > 0 ? '<span class="retry-chip" title="重试 ' + retry + ' 次">\\u21BA' + retry + '</span>' : '';
      var durationStr = t.elapsed ? escapeHtml(t.elapsed) + 's' : '';
      var isExpanded = expandedCards[rawTaskId] ? ' expanded' : '';
      var logContent = expandedCards[rawTaskId] ? '<div class="log-list" data-task-id="' + taskAttr + '"><div class="log-loading">加载中...</div></div>' : '<div class="log-list" data-task-id="' + taskAttr + '"><div class="log-empty">点击展开查看日志</div></div>';

      return '<div class="task-card' + isExpanded + (rawStatus === 'running' ? ' task-running' : '') + grayed + '" data-status="' + escapeAttr(status) + '" data-task-id="' + taskAttr + '">' +
        '<div class="task-header">' +
          '<span class="task-chevron">&#9654;</span>' +
          '<span class="task-id status-id-' + status + '">' + (statusIcon[rawStatus] || '?') + ' ' + taskId + '</span>' +
          '<span class="task-desc">' + escapeHtml(t.description || rawTaskId) + '</span>' +
          '<span class="task-badges">' + phaseChip + retryChip + '</span>' +
          '<span class="status-tag ' + (statusTag[rawStatus] || 'pending') + '">' + (rawStatus === 'done' ? 'PASS' : rawStatus === 'skipped' ? 'SKIP' : escapeHtml(rawStatus.toUpperCase())) + '</span>' +
          (durationStr ? '<span class="task-duration">' + durationStr + '</span>' : '') +
        '</div>' +
        '<div class="task-body"><div class="task-body-inner">' + logContent + '</div></div>' +
      '</div>';
    }).join('');

    if (html) replaceWithMarkup(taskList, html);
    else setStatusMessage(taskList, 'empty', '等待任务开始...');

    // 恢复已展开卡片的日志内容
    Object.keys(expandedCards).forEach(function(taskId) {
      if (expandedCards[taskId]) {
        var card = findTaskCardById(taskId);
        if (card && loadedLogs[taskId]) {
          loadTaskLog(taskId, card);
        }
      }
    });

    window.scrollTo(0, scrollY);
  }

  // ── SSE 连接 ────────────────────────────────────────────────────
  function connectSSE() {
    var es = new EventSource('/events');

    es.addEventListener('connected', function(e) {
      var data = JSON.parse(e.data);
      if (data.progress) {
        if (!data.progress.currentRun) {
          location.reload();
          return;
        }
        updateProgressUI(data.progress);
      }
    });

    es.addEventListener('progress', function(e) {
      var d = JSON.parse(e.data);
      if (!d.currentRun) {
        location.reload();
        return;
      }
      updateProgressUI(d);
    });

    es.addEventListener('task-log', function(e) {
      var d = JSON.parse(e.data);
      if (d.entries && d.entries.length > 0) {
        appendLogEntries(d.taskId, d.entries);
      }
    });

    es.addEventListener('run-status', function(e) {
      var d = JSON.parse(e.data);
      if (!d.currentRun) {
        location.reload();
      }
    });

    es.addEventListener('review-status', function(e) {
      // Review 状态变化时更新 sidebar（如果需要可以扩展）
    });

    es.onerror = function() {
      // EventSource 自动重连，无需手动处理
    };
  }

  // 绑定事件（事件委托）
  document.addEventListener('click', function(ev) {
    var outputToggle = ev.target.closest('.bash-toggle');
    if (outputToggle) {
      var output = outputToggle.nextElementSibling;
      if (output) output.classList.toggle('visible');
      return;
    }
    var header = ev.target.closest('.task-header');
    if (header) {
      var card = header.closest('.task-card');
      if (card) toggleCard(card);
      return;
    }
    var revHeader = ev.target.closest('.review-header');
    if (revHeader) {
      var revCard = revHeader.closest('.review-card');
      if (revCard) toggleReview(revCard);
      return;
    }
  });

  // 启动 SSE 连接
  connectSSE();

  // 自动展开失败的卡片
  document.querySelectorAll('.task-card[data-status="failed"]').forEach(function(card) {
    var taskId = card.getAttribute('data-task-id');
    expandedCards[taskId] = true;
    card.classList.add('expanded');
    loadTaskLog(taskId, card);
  });
})();
`;

// ── HTML 页面 ──────────────────────────────────────────────────────
const LEGACY_HTML = (data, stats) => {
  const currentRun = data?.currentRun || null;
  const hasActiveRun = !!currentRun;
  const lifecycle = data?.lifecycle || readLifecycleProgressData();

  // 空闲页面
  if (!hasActiveRun) {
    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>YOLO Progress</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root, html[data-theme="light"] {
    color-scheme: light dark;
    --bg: #f8fafc;
    --surface: #ffffff;
    --surface-muted: #f1f5f9;
    --text: #0f172a;
    --text-strong: #020617;
    --text-muted: #64748b;
    --text-subtle: #94a3b8;
    --border: #e2e8f0;
    --shadow: 0 18px 48px rgba(15, 23, 42, 0.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f172a;
      --surface: #111827;
      --surface-muted: #0f172a;
      --text: #e2e8f0;
      --text-strong: #f8fafc;
      --text-muted: #94a3b8;
      --text-subtle: #64748b;
      --border: #1f2937;
      --shadow: none;
    }
  }
  html[data-theme="dark"] {
    --bg: #0f172a;
    --surface: #111827;
    --surface-muted: #0f172a;
    --text: #e2e8f0;
    --text-strong: #f8fafc;
    --text-muted: #94a3b8;
    --text-subtle: #64748b;
    --border: #1f2937;
    --shadow: none;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; display: flex; align-items: center; justify-content: center; -webkit-text-size-adjust: 100%; }
  .idle-box { text-align: center; padding: 40px; }
  .idle-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.3; }
  .idle-title { font-size: 18px; font-weight: 700; color: var(--text-muted); margin-bottom: 8px; }
  .idle-sub { font-size: 13px; color: var(--text-subtle); }
  .idle-lifecycle { margin-top: 22px; min-width: min(520px, calc(100vw - 40px)); background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow); border-radius: 8px; padding: 14px; text-align: left; }
  .idle-lifecycle-title { color: var(--text-strong); font-size: 13px; font-weight: 700; margin-bottom: 8px; }
  .idle-lifecycle-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; color: var(--text-muted); font-size: 12px; margin-bottom: 8px; }
  .idle-lifecycle-grid span { background: var(--surface-muted); border-radius: 6px; padding: 8px; text-align: center; }
  .idle-lifecycle-grid strong { display: block; color: var(--text-strong); font-size: 16px; margin-top: 2px; }
  .idle-pulse { display: inline-block; width: 8px; height: 8px; background: var(--text-subtle); border-radius: 50%; margin-right: 8px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
</style>
</head>
<body>
<div class="idle-box">
  <div class="idle-icon">⏸</div>
  <div class="idle-title"><span class="idle-pulse"></span>无活跃运行</div>
  <div class="idle-sub">等待 Runner 启动...</div>
  ${lifecycleIdleSummary(lifecycle)}
</div>
<script>
(function() {
  var es = new EventSource('/events');
  es.addEventListener('connected', function(e) {
    var data = JSON.parse(e.data);
    if (data.progress && data.progress.currentRun) {
      location.reload();
    }
  });
  es.addEventListener('run-status', function(e) {
    var data = JSON.parse(e.data);
    if (data.currentRun) {
      location.reload();
    }
  });
  es.onerror = function() {
    // 断线后 5 秒回退刷新
    setTimeout(function() { location.reload(); }, 5000);
  };
})();
</script>
</body>
</html>`;
  }

  const {
    tasks = [],
    done = 0,
    failed = 0,
    total = 0,
    current = null,
    source = "none",
    runnerActive = false,
  } = data || {};
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const statusIcon = { done: "✓", failed: "✗", running: "…", skipped: "−", pending: "○" };
  const statusTag = {
    done: "passed", failed: "failed", running: "running", skipped: "passed", pending: "pending",
  };

  const phaseLabel = {
    precheck: ["预检", "#64748b"],
    claude:   ["Claude", "#8b5cf6"],
    gate:     ["闸门", "#f59e0b"],
    commit:   ["提交", "#3b82f6"],
    retry:    ["重试", "#ef4444"],
    done:     ["完成", "#22c55e"],
    failed:   ["失败", "#ef4444"],
  };

  // 任务卡片
  const taskCards = tasks.length > 0
    ? tasks.map((t) => {
        const rawTaskId = String(t.id || "");
        const safeTaskId = escapeHtml(rawTaskId);
        const taskAttr = escapeAttr(rawTaskId);
        const rawStatus = String(t.status || "pending");
        const statusAttr = escapeAttr(rawStatus.replace(/[^a-zA-Z0-9_-]/g, "") || "pending");
        const grayed = !runnerActive && rawStatus === "running" ? " task-grayed" : "";
        const p = String(t.phase || "");
        const [plabel, pcolor] = phaseLabel[p] || (p ? [p, "#475569"] : ["", ""]);
        const phaseChip = p ? `<span class="phase-chip" style="border-color:${pcolor};color:${pcolor}">${escapeHtml(plabel)}</span>` : "";
        const retry = Number(t.retry || 0);
        const retryChip = retry > 0 ? `<span class="retry-chip" title="重试 ${retry} 次">&#8635;${retry}</span>` : "";
        const durationStr = t.elapsed ? `${escapeHtml(t.elapsed)}s` : "";
        const taskStatusLabel = rawStatus === "done" ? "PASS" : rawStatus === "skipped" ? "SKIP" : rawStatus.toUpperCase();
        return `
    <div class="task-card${rawStatus === "running" ? " task-running" : ""}${grayed}" data-status="${statusAttr}" data-task-id="${taskAttr}">
      <div class="task-header">
        <span class="task-chevron">&#9654;</span>
        <span class="task-id status-id-${statusAttr}">${statusIcon[rawStatus] || "?"} ${safeTaskId}</span>
        <span class="task-desc">${escapeHtml(t.description || rawTaskId)}</span>
        <span class="task-badges">${phaseChip}${retryChip}</span>
        <span class="status-tag ${statusTag[rawStatus] || "pending"}">${escapeHtml(taskStatusLabel)}</span>
        ${durationStr ? `<span class="task-duration">${durationStr}</span>` : ""}
      </div>
      <div class="task-body"><div class="task-body-inner">
        <div class="log-list" data-task-id="${taskAttr}"><div class="log-empty">点击展开查看日志</div></div>
      </div></div>
    </div>`;
      }).join("")
    : '<div class="empty">等待任务开始...</div>';

  const pendingCount = tasks.filter((t) => t.status === "pending").length;

  const failedRows = Object.entries(stats)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 5)
    .map(([gate, count]) => `<li>${escapeHtml(gate)}: <strong>${Number(count) || 0}次</strong></li>`)
    .join("");

  // Review 卡片
  const review = data?.review;
  const reviewCardHtml = `
    <div class="review-card" id="reviewCardSlot">
      <div class="review-header">
        <span class="task-chevron">&#9654;</span>
        <span class="task-id review-task-id">&#128269; 全量 Review</span>
        <span class="task-desc">代码审查</span>
        ${review ? `<span class="status-tag ${review.latestStatus === "clean" ? "passed" : "failed"}">${review.latestStatus === "clean" ? "PASS" : review.latestStatus === "bugs_found" ? `${Number(review.latestBugs) || 0} ISSUES` : "ERROR"}</span>` : '<span class="status-tag pending">PENDING</span>'}
      </div>
      <div class="review-body"><div class="review-body-inner">
        <div class="review-log-list"><div class="log-empty">点击展开查看 Review 日志</div></div>
      </div></div>
    </div>`;

  // 旧版 review box（sidebar 内兼容）
  const reviewBlock = review
    ? `
    <div class="review-status-box">
      <div class="review-status-title">Review 状态</div>
      <div class="review-row"><span>Round</span><strong>${Number(review.currentRound) || 0}${review.totalRounds > 1 ? ` / ${Number(review.totalRounds) || 0}轮` : ""}</strong></div>
      <div class="review-row"><span>本轮发现</span><strong class="review-count ${review.latestStatus === "clean" ? "ok" : "attention"}">${Number(review.latestBugs) || 0} 个问题</strong></div>
      <div class="review-row"><span>累计发现</span><strong>${Number(review.totalBugs) || 0} 个</strong></div>
    </div>`
    : runnerActive
      ? `<div class="review-waiting">Review 阶段 · 等待数据...</div>`
      : "";

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>YOLO Progress</title>
<style>${CSS}</style>
</head>
<body>
  <div class="run-id">${escapeHtml(currentRun.run_id)} · ${escapeHtml(currentRun.prd || "auto")}</div>
  ${!runnerActive && total > 0 ? '<div class="runner-warn">&#9888; Runner 未运行 · 以下为历史数据</div>' : runnerActive && total > 0 ? '<div class="runner-ok">&#9679; Runner 运行中</div>' : ""}
  ${done === total && total > 0 ? '<div class="done-banner">全部完成！</div>' : ""}
<div class="header">
  <h1>YOLO — ${Number(total) || 0} Tasks</h1>
  <div class="progress-bar-wrap"><div class="progress-bar" id="progressBar" style="width:${pct}%"></div></div>
  <div class="pct" id="pctText">${pct}%</div>
</div>
<div class="stats" id="statsRow">
  <div class="stat done">完成<strong>${done}</strong></div>
  <div class="stat failed">失败<strong>${failed}</strong></div>
  <div class="stat running">进行中<strong>${tasks.filter((t) => t.status === "running").length}</strong></div>
  <div class="stat">待处理<strong>${Math.max(0, pendingCount)}</strong></div>
</div>
<div class="main">
  <div>
    <div class="section-title">任务列表</div>
    <div class="task-list" id="taskList">${taskCards}</div>
    ${reviewCardHtml}
    <div class="section-title">UI Evidence</div>
    <div class="ui-evidence-panel" id="uiEvidencePanel">
      <div class="evidence-item"><span class="evidence-label">Page</span><span class="evidence-value">stable</span></div>
      <div class="evidence-item"><span class="evidence-label">State</span><span class="evidence-value">${escapeHtml(runnerActive ? 'active' : 'idle')}</span></div>
      <div class="evidence-item"><span class="evidence-label">Layout</span><span class="evidence-value">card-grid</span></div>
      <div class="evidence-item"><span class="evidence-label">Runtime Error</span><span class="evidence-value">${escapeHtml(failed > 0 ? 'detected' : 'none')}</span></div>
      <div class="evidence-item"><span class="evidence-label">Viewport</span><span class="evidence-value">responsive</span></div>
      <div class="evidence-item"><span class="evidence-label">Artifacts</span><span class="evidence-value">${escapeHtml(done + ' / ' + total)}</span></div>
    </div>
    <p class="source">数据来源: PRD (${escapeHtml(basename(resolvePrdPath() || "unknown"))})</p>
  </div>
  <div class="sidebar" id="sidebar">
    ${reviewBlock}
    <h3>高频失败 Gate</h3>
    <ul id="failedGates">${failedRows || '<li class="failed-gates-empty">暂无数据</li>'}</ul>
    <p class="refresh">SSE 实时推送</p>
  </div>
</div>
<script>${CLIENT_JS}</script>
</body>
</html>`;
};

const HTML = (data, stats) => renderProgressDashboard(data, stats, {
  lifecycle: data?.lifecycle || readLifecycleProgressData(),
  prdPath: resolvePrdPath() || "unknown",
});

// ── HTTP Server ────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    writeBadRequest(res);
    return;
  }
  const url = requestUrl.pathname;

  if (url === "/" || url === "/index.html") {
    const data = getProgressData();
    const stats = readStats();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML(data, stats));

  } else if (url === "/progress.json") {
    const data = getProgressData();
    const stats = readStats();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        tasks: data?.tasks || [],
        done: data?.done || 0,
        failed: data?.failed || 0,
        total: data?.total || 0,
        current: data?.current || null,
        runnerActive: data?.runnerActive ?? false,
        stats,
        review: data?.review || null,
        source: data?.source || "none",
        currentRun: data?.currentRun || null,
        lifecycle: data?.lifecycle || readLifecycleProgressData(),
        timestamp: new Date().toISOString(),
      }),
    );

  } else if (url === "/events") {
    handleSSEConnection(req, res);

  } else if (url === "/lifecycle.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readLifecycleProgressData()));

  } else if (url === "/api/task-logs") {
    const summaries = readTaskLogSummaries();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tasks: summaries }));

  } else if (url.startsWith("/api/task-logs/")) {
    const taskId = parseTaskLogId(url);
    if (taskId === null) {
      writeBadRequest(res);
      return;
    }
    const entries = readTaskLogEntries(taskId);
    if (entries === null) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Task log not found" }));
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(entries));
    }

  } else if (url === "/api/review-log") {
    const entries = readReviewTaskLog();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(entries || []));

  } else {
    res.writeHead(404);
    res.end("Not Found");
  }
});

// 导出供 runner 内嵌使用
export { server, getProgressData, readStats, readLifecycleProgressData, startFileWatchers, closeProgressServerResources, HTML, DASHBOARD_CSS as CSS, readTaskLogEntries, readTaskLogIncremental, readReviewTaskLog, getTaskLogsDir, setTaskLogsDir };

// 只在直接运行时启动（被 import 时不启动）
const __main = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (__main) {
  server.listen(PORT, PROGRESS_SERVER_HOST, () => {
    process.stdout.write(`\n  YOLO Progress Dashboard\n`);
    process.stdout.write(`  http://${PROGRESS_SERVER_HOST}:${PORT}\n`);
    process.stdout.write(`  数据源: PRD (${resolvePrdPath()})\n`);
    process.stdout.write(`  推送方式: SSE (实时)\n`);
    startFileWatchers();
    startSelfWatcher();
  });
}
