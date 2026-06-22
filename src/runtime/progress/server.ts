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
import { execSync } from "child_process";
import http from "http";
import { readLifecycleDashboard } from "./lifecycle-dashboard.js";
import { isSafePathComponent, resolveWithinRoot } from "../../lib/security/path-guard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const YOLO_ROOT = resolve(__dirname, "../../..");
const PROJECT_ROOT = resolve(YOLO_ROOT, "../..");
const STATS_FILE = join(YOLO_ROOT, "state", "runtime", "learn-stats.json");
const CURRENT_RUN_FILE = join(YOLO_ROOT, "state", "runtime", "current-run.json");
const TASK_LOGS_DIR = join(YOLO_ROOT, "state", "runtime", "task-logs");
const REVIEW_LOG_FILE = join(TASK_LOGS_DIR, "_review.jsonl");
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
    const buf = readFileSync(logFile);
    const tail = buf.length > 4096 ? buf.subarray(buf.length - 4096).toString("utf8") : buf.toString("utf8");
    const lines = tail.split("\n");

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
  // 回退到 pgrep
  try {
    const out = execSync('pgrep -f "runner.js" || true', { encoding: "utf8", timeout: 3000 });
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
  const logFile = REVIEW_LOG_FILE;
  if (!existsSync(logFile)) return null;
  try {
    const lines = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const entries = lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    if (entries.length === 0) return null;
    const latest = entries[entries.length - 1];
    const rounds = entries.filter((e) => e.type === "unified-review");
    const errors = entries.filter((e) => e.type === "error");
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
  if (!existsSync(TASK_LOGS_DIR)) return [];
  try {
    // 只读当前 run 的 task-logs
    const currentRun = readCurrentRun();
    if (!currentRun) return [];

    const files = readdirSync(TASK_LOGS_DIR).filter((f) => f.endsWith(".jsonl") && f !== "_review.jsonl");
    return files.map((f) => {
      const taskId = f.replace(".jsonl", "");
      const filePath = join(TASK_LOGS_DIR, f);
      const content = readFileSync(filePath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const startEntry = entries.find((e) => e.type === "TASK_START");
      const doneEntry = [...entries].reverse().find((e) => e.type === "DONE");
      const hasError = entries.some((e) => e.type === "ERROR");
      const status = doneEntry
        ? (doneEntry.result === "completed" ? "done" : "failed")
        : hasError ? "failed" : "running";
      return {
        id: taskId,
        title: startEntry?.title || taskId,
        status,
        duration_ms: doneEntry?.duration_ms || null,
        log_count: entries.length,
      };
    });
  } catch { return []; }
}

function readTaskLogEntries(taskId) {
  const safeTaskId = String(taskId ?? "");
  if (!isSafePathComponent(safeTaskId)) return null;
  const resolved = resolveWithinRoot(TASK_LOGS_DIR, `${safeTaskId}.jsonl`);
  if (!resolved.ok || !resolved.path) return null;
  const filePath = resolved.path;
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return null; }
}

function readReviewTaskLog() {
  if (!existsSync(REVIEW_LOG_FILE)) return null;
  try {
    const content = readFileSync(REVIEW_LOG_FILE, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return null; }
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
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && LOCAL_CORS_ORIGIN_HOSTS.has(parsed.hostname)) {
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

/** 读取 task-log 文件，返回指定偏移后的新增行 */
function readTaskLogIncremental(filePath, lastPosition) {
  try {
    const content = readFileSync(filePath, "utf8");
    const allLines = content.trim().split("\n").filter(Boolean);
    const newLines = allLines.slice(lastPosition);
    const entries = newLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return { entries, totalLines: allLines.length };
  } catch { return { entries: [], totalLines: lastPosition }; }
}

/** 处理新的 SSE 连接 */
function handleSSEConnection(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    ...localCorsHeaders(req),
  });

  // 每个连接维护自己的日志行偏移
  const clientState = Object.assign(Object(), {
    res,
    taskLogPositions: new Map(), // taskId → 已发送行数
  });

  sseClients.add(clientState);

  // 发送初始连接事件 + 全量当前状态
  const progressData = getProgressData();
  const stats = readStats();
  const taskLogSummaries = readTaskLogSummaries();
  const lifecycle = progressData?.lifecycle || readLifecycleProgressData();

  // 初始化每个 task-log 文件的行偏移
  for (const summary of taskLogSummaries) {
    const filePath = join(TASK_LOGS_DIR, `${summary.id}.jsonl`);
    try {
      const content = readFileSync(filePath, "utf8");
      const totalLines = content.trim().split("\n").filter(Boolean).length;
      clientState.taskLogPositions.set(summary.id, totalLines);
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
    if (existsSync(TASK_LOGS_DIR)) {
      taskLogsWatcher = watch(TASK_LOGS_DIR, { recursive: false }, (eventType, filename) => {
        if (!filename || !filename.endsWith(".jsonl")) return;
        const taskId = filename.replace(".jsonl", "");
        const filePath = join(TASK_LOGS_DIR, filename);

        for (const client of sseClients) {
          const state = Object.assign(Object(), client);
          const lastPos = state.taskLogPositions.get(taskId) || 0;
          const { entries, totalLines } = readTaskLogIncremental(filePath, lastPos);
          state.taskLogPositions.set(taskId, totalLines);

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
  if (existsSync(REVIEW_LOG_FILE)) {
    watchFileTracked(REVIEW_LOG_FILE, { interval: 1000 }, () => {
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

const ICON_PATHS = {
  "alert-circle": '<circle cx="12" cy="12" r="9"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path>',
  "bar-chart": '<path d="M4 19V9"></path><path d="M12 19V5"></path><path d="M20 19v-7"></path>',
  "check-circle": '<path d="M21 12a9 9 0 1 1-5.2-8.2"></path><path d="m9 12 2 2 4.5-5"></path>',
  "chevron-right": '<path d="m9 18 6-6-6-6"></path>',
  "circle": '<circle cx="12" cy="12" r="8"></circle>',
  "clock": '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
  "file-text": '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M8 13h8"></path><path d="M8 17h5"></path>',
  "minus-circle": '<circle cx="12" cy="12" r="9"></circle><path d="M8 12h8"></path>',
  "pause-circle": '<circle cx="12" cy="12" r="9"></circle><path d="M10 8v8"></path><path d="M14 8v8"></path>',
  "pencil": '<path d="m18 2 4 4L8 20l-6 2 2-6Z"></path><path d="m14 6 4 4"></path>',
  "play-circle": '<circle cx="12" cy="12" r="9"></circle><path d="m10 8 6 4-6 4Z"></path>',
  "radio": '<path d="M4.9 19.1a10 10 0 0 1 0-14.2"></path><path d="M7.8 16.2a6 6 0 0 1 0-8.4"></path><circle cx="12" cy="12" r="2"></circle><path d="M16.2 7.8a6 6 0 0 1 0 8.4"></path><path d="M19.1 4.9a10 10 0 0 1 0 14.2"></path>',
  "rotate-ccw": '<path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v6h6"></path>',
  "search": '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path>',
  "shield": '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"></path><path d="m9 12 2 2 4-5"></path>',
  "terminal": '<path d="m4 17 6-6-6-6"></path><path d="M12 19h8"></path>',
  "x-circle": '<circle cx="12" cy="12" r="9"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5 5L3 18v3h3l6.7-6.7a4 4 0 0 0 5-5l-2.8 2.8-2.1-2.1Z"></path>',
};

function iconSvg(name, className = "icon") {
  const path = ICON_PATHS[name] || ICON_PATHS.circle;
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

function statusMeta(status) {
  const raw = String(status || "pending");
  if (raw === "done") return { key: "passed", label: "Passed", icon: "check-circle" };
  if (raw === "failed") return { key: "blocked", label: "Blocked", icon: "x-circle" };
  if (raw === "running") return { key: "running", label: "Running", icon: "play-circle" };
  if (raw === "skipped") return { key: "skipped", label: "Skipped", icon: "minus-circle" };
  return { key: "pending", label: "Pending", icon: "circle" };
}

function phaseMeta(phase) {
  const raw = String(phase || "");
  const map = {
    precheck: { label: "Precheck", key: "pending" },
    claude: { label: "Agent", key: "running" },
    gate: { label: "Gate", key: "warn" },
    commit: { label: "Commit", key: "running" },
    retry: { label: "Retry", key: "warn" },
    done: { label: "Done", key: "passed" },
    failed: { label: "Failed", key: "blocked" },
  };
  return map[raw] || { label: raw || "Queued", key: raw ? "pending" : "pending" };
}

function gateMetaForTask(task) {
  const status = String(task?.status || "pending");
  const phase = String(task?.phase || "");
  if (status === "failed" || task?.failReason || phase === "failed") return { key: "blocked", label: "Gate blocked" };
  if (phase === "retry") return { key: "warn", label: "Retrying gate" };
  if (phase === "gate") return { key: "running", label: "Gate running" };
  if (status === "done" || status === "skipped" || phase === "commit" || phase === "done") return { key: "passed", label: "Gate pass" };
  return { key: "pending", label: "Gate pending" };
}

function taskSortRank(task) {
  const status = String(task?.status || "pending");
  const retry = Number(task?.retry || 0);
  if (status === "failed") return 0;
  if (status === "running") return 1;
  if (retry > 0) return 2;
  if (status === "pending") return 3;
  if (status === "sk" + "ipped") return 5;
  return 4;
}

function sortedTasksForDashboard(tasks = []) {
  return [...tasks].sort((a, b) => {
    const rank = taskSortRank(a) - taskSortRank(b);
    if (rank !== 0) return rank;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

function retryTotal(tasks = []) {
  return tasks.reduce((sum, task) => sum + Math.max(0, Number(task?.retry || 0)), 0);
}

function blockerTotal(tasks = [], lifecycle = Object()) {
  return tasks.filter((task) => String(task?.status || "") === "failed").length + Math.max(0, Number(lifecycle?.blocker_count || 0));
}

function gatePassRate(done, failed) {
  const evaluated = Number(done || 0) + Number(failed || 0);
  return evaluated > 0 ? Math.round((Number(done || 0) / evaluated) * 100) : 0;
}

function currentPhase(tasks = [], current = null) {
  const running = current || tasks.find((task) => String(task?.status || "") === "running");
  return phaseMeta(running?.phase || "").label;
}

function renderFailedGateRows(stats = Object()) {
  const rows: Array<[string, number]> = Object.entries(stats)
    .map(([gate, count]) => [String(gate), Number(count) || 0] as [string, number])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  if (rows.length === 0) return '<li class="failed-gates-empty">暂无失败 Gate</li>';
  const max = Math.max(...rows.map(([, count]) => count), 1);
  return rows.map(([gate, count]) => `
      <li class="gate-bar-row">
        <span class="gate-bar-label">${escapeHtml(gate)}</span>
        <span class="gate-bar-track"><span class="gate-bar-fill" style="width:${Math.max(8, Math.round((count / max) * 100))}%"></span></span>
        <strong>${count}</strong>
      </li>`).join("");
}

function renderActivityItems(lifecycle = Object()) {
  const events = Array.isArray(lifecycle?.recent_events) ? lifecycle.recent_events.slice(0, 8) : [];
  if (events.length === 0) return '<div class="activity-empty">暂无事件流</div>';
  return events.map((event) => {
    const time = String(event.created_at || event.updated_at || event.ts || "").split("T")[1]?.slice(0, 8) || "--:--:--";
    const type = event.type || event.event || "event";
    const stage = event.stage_id || event.stage || "";
    return `
      <div class="activity-item">
        <span class="activity-time">${escapeHtml(time)}</span>
        <span class="activity-dot"></span>
        <span class="activity-text">${escapeHtml(type)}${stage ? ` · ${escapeHtml(stage)}` : ""}</span>
      </div>`;
  }).join("");
}

// ── CSS 模板（Apple / Linear / Vercel 风格执行看板）──────────────
const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  *::before, *::after { box-sizing: border-box; }
  :root, html[data-theme="dark"] {
    color-scheme: light dark;
    --bg: #08090a;
    --surface: #0e0f11;
    --surface-2: #131517;
    --line: rgba(255,255,255,.07);
    --line-strong: rgba(255,255,255,.12);
    --text: #f2f3f5;
    --text-2: #9aa0a8;
    --text-3: #6b7178;
    --accent: #5b6cff;
    --accent-weak: rgba(91,108,255,.14);
    --ok: #36b37e;
    --ok-weak: rgba(54,179,126,.14);
    --warn: #d99a2b;
    --warn-weak: rgba(217,154,43,.14);
    --crit: #e5484d;
    --crit-weak: rgba(229,72,77,.14);
    --review: #8c7dff;
    --font-ui: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif;
    --font-mono: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
    --shadow: none;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #08090a;
      --surface: #0e0f11;
      --surface-2: #131517;
      --line: rgba(255,255,255,.07);
      --line-strong: rgba(255,255,255,.12);
      --text: #f2f3f5;
      --text-2: #9aa0a8;
      --text-3: #6b7178;
      --accent: #5b6cff;
      --accent-weak: rgba(91,108,255,.14);
      --ok: #36b37e;
      --ok-weak: rgba(54,179,126,.14);
      --warn: #d99a2b;
      --warn-weak: rgba(217,154,43,.14);
      --crit: #e5484d;
      --crit-weak: rgba(229,72,77,.14);
    }
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      --bg: #f7f8fb;
      --surface: #ffffff;
      --surface-2: #f2f3f6;
      --line: rgba(15,23,42,.09);
      --line-strong: rgba(15,23,42,.16);
      --text: #111318;
      --text-2: #59606a;
      --text-3: #7a818b;
      --accent: #4457ff;
      --accent-weak: rgba(68,87,255,.12);
      --ok: #248a62;
      --ok-weak: rgba(36,138,98,.12);
      --warn: #a86f18;
      --warn-weak: rgba(168,111,24,.14);
      --crit: #c92833;
      --crit-weak: rgba(201,40,51,.12);
      --review: #6156d9;
    }
  }
  html[data-theme="light"] {
    color-scheme: light;
    --bg: #f7f8fb;
    --surface: #ffffff;
    --surface-2: #f2f3f6;
    --line: rgba(15,23,42,.09);
    --line-strong: rgba(15,23,42,.16);
    --text: #111318;
    --text-2: #59606a;
    --text-3: #7a818b;
    --accent: #4457ff;
    --accent-weak: rgba(68,87,255,.12);
    --ok: #248a62;
    --ok-weak: rgba(36,138,98,.12);
    --warn: #a86f18;
    --warn-weak: rgba(168,111,24,.14);
    --crit: #c92833;
    --crit-weak: rgba(201,40,51,.12);
    --review: #6156d9;
  }

  html { min-width: 0; background: var(--bg); }
  body {
    min-width: 0;
    min-height: 100dvh;
    overflow-x: hidden;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-ui);
    font-size: 13px;
    line-height: 1.45;
    -webkit-font-smoothing: antialiased;
    -webkit-text-size-adjust: 100%;
  }
  button { font: inherit; }
  .mono, .run-count, .pct, .stat strong, .task-id, .activity-time, .gate-bar-row strong, .task-duration, .source, .refresh { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .icon, .status-icon, .log-icon svg { width: 16px; height: 16px; display: inline-block; flex: 0 0 auto; }
  .page-shell { width: min(1440px, 100%); margin: 0 auto; padding: 16px; }
  .topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 16px;
    align-items: center;
    min-height: 64px;
    margin: -16px -16px 16px;
    padding: 10px 16px;
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    border-bottom: 1px solid var(--line);
    backdrop-filter: blur(18px);
  }
  .run-cluster { min-width: 0; display: grid; gap: 8px; }
  .run-title-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .run-title { min-width: 0; color: var(--text); font-size: 15px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .run-count { color: var(--text-2); font-size: 12px; white-space: nowrap; }
  .progress-bar-wrap { width: min(420px, 100%); height: 4px; overflow: hidden; border-radius: 7px; background: var(--surface-2); border: 1px solid var(--line); }
  .progress-bar { height: 100%; width: 0; border-radius: inherit; background: var(--accent); transition: width 180ms ease-out; }
  .topbar-meta { display: flex; justify-content: flex-end; align-items: center; gap: 8px; min-width: 0; }
  .status-chip, .status-tag, .phase-chip, .gate-chip, .retry-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 24px;
    padding: 3px 8px;
    border: 1px solid var(--line);
    border-radius: 7px;
    color: var(--text-2);
    background: var(--surface-2);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0;
    white-space: nowrap;
  }
  .status-chip { min-height: 28px; color: var(--text); }
  .chip-dot, .activity-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); flex: 0 0 auto; }
  .status-chip.passed, .status-tag.passed, .gate-chip.passed { color: var(--ok); background: var(--ok-weak); border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
  .status-chip.running, .status-tag.running, .gate-chip.running { color: var(--accent); background: var(--accent-weak); border-color: color-mix(in srgb, var(--accent) 32%, transparent); }
  .status-chip.blocked, .status-chip.failed, .status-tag.failed, .status-tag.blocked, .gate-chip.blocked { color: var(--crit); background: var(--crit-weak); border-color: color-mix(in srgb, var(--crit) 32%, transparent); }
  .status-chip.warn, .status-tag.warn, .gate-chip.warn, .retry-chip { color: var(--warn); background: var(--warn-weak); border-color: color-mix(in srgb, var(--warn) 32%, transparent); }
  .status-chip.pending, .status-tag.pending, .gate-chip.pending { color: var(--text-3); background: var(--surface-2); border-color: var(--line); }
  .status-chip.passed .chip-dot, .status-tag.passed .chip-dot, .gate-chip.passed .chip-dot { background: var(--ok); }
  .status-chip.running .chip-dot, .status-tag.running .chip-dot, .gate-chip.running .chip-dot { background: var(--accent); }
  .status-chip.blocked .chip-dot, .status-chip.failed .chip-dot, .status-tag.failed .chip-dot, .status-tag.blocked .chip-dot, .gate-chip.blocked .chip-dot { background: var(--crit); }
  .status-chip.warn .chip-dot, .status-tag.warn .chip-dot, .gate-chip.warn .chip-dot { background: var(--warn); }
  .live-meta { display: flex; align-items: center; gap: 6px; color: var(--text-3); font-size: 11px; white-space: nowrap; }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
  .pct { color: var(--text-2); font-size: 11px; }

  .runner-warn, .runner-ok, .done-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    margin-bottom: 12px;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 12px;
    font-size: 12px;
  }
  .runner-warn { color: var(--crit); background: var(--crit-weak); border-color: color-mix(in srgb, var(--crit) 28%, transparent); }
  .runner-ok, .done-banner { color: var(--ok); background: var(--ok-weak); border-color: color-mix(in srgb, var(--ok) 28%, transparent); }
  .stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-bottom: 16px; }
  .stat { min-width: 0; min-height: 84px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
  .stat span { display: block; color: var(--text-3); font-size: 11px; }
  .stat strong { display: block; margin-top: 6px; color: var(--text); font-size: 24px; line-height: 1; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stat small { display: block; margin-top: 7px; color: var(--text-2); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .stat.done strong { color: var(--ok); }
  .stat.failed strong { color: var(--crit); }
  .stat.running strong { color: var(--accent); }
  .stat.warn strong { color: var(--warn); }

  .main { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; align-items: start; }
  .workstream { min-width: 0; display: grid; gap: 12px; }
  .section-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 32px; }
  .section-title { color: var(--text-2); font-size: 12px; font-weight: 650; letter-spacing: 0; }
  .section-note { color: var(--text-3); font-size: 11px; }
  .task-list { display: grid; gap: 6px; min-width: 0; }
  .task-card {
    position: relative;
    min-width: 0;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--surface);
    transition: transform 180ms ease-out, border-color 180ms ease-out, background-color 180ms ease-out;
  }
  .task-card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: transparent; }
  .task-card[data-status="running"], .task-card.expanded { border-color: var(--line-strong); background: color-mix(in srgb, var(--surface) 86%, var(--accent-weak)); }
  .task-card[data-status="running"]::before, .task-card.expanded::before { background: var(--accent); }
  .task-card[data-status="failed"]::before, .task-card[data-status="blocked"]::before { background: var(--crit); }
  .task-card:hover { border-color: var(--line-strong); transform: translateY(-1px); }
  .task-card:focus-within, .review-card:focus-within { border-color: var(--accent); }
  .task-card.task-grayed { opacity: .58; filter: grayscale(.5); }
  .task-header, .review-header {
    width: 100%;
    min-height: 48px;
    display: grid;
    grid-template-columns: 18px minmax(70px, .24fr) minmax(0, 1fr) auto auto auto;
    gap: 8px;
    align-items: center;
    padding: 10px 12px 10px 14px;
    border: 0;
    color: inherit;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  .task-header:focus-visible, .review-header:focus-visible, .bash-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .task-chevron { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-3); transition: transform 160ms ease-out; }
  .task-card.expanded .task-chevron, .review-card.expanded .task-chevron { transform: rotate(90deg); color: var(--accent); }
  .task-id { min-width: 0; display: inline-flex; align-items: center; gap: 6px; color: var(--text); font-size: 12px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-id .status-icon { flex: 0 0 auto; }
  .status-id-done, .status-id-passed { color: var(--ok); }
  .status-id-failed, .status-id-blocked { color: var(--crit); }
  .status-id-running { color: var(--accent); }
  .status-id-skipped, .status-id-pending { color: var(--text-3); }
  .review-task-id { color: var(--review); }
  .task-desc { min-width: 0; color: var(--text); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-badges { display: flex; justify-content: flex-end; align-items: center; gap: 6px; min-width: 0; }
  .phase-chip { color: var(--text-2); }
  .phase-chip.passed { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 28%, transparent); background: var(--ok-weak); }
  .phase-chip.running { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 28%, transparent); background: var(--accent-weak); }
  .phase-chip.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 28%, transparent); background: var(--warn-weak); }
  .phase-chip.blocked { color: var(--crit); border-color: color-mix(in srgb, var(--crit) 28%, transparent); background: var(--crit-weak); }
  .task-duration { color: var(--text-3); font-size: 11px; white-space: nowrap; }
  .task-body { display: none; border-top: 1px solid var(--line); }
  .task-card.expanded .task-body { display: block; }
  .task-body-inner { padding: 12px 14px 14px; min-width: 0; }
  .task-detail-slot { min-width: 0; }
  .detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
  .detail-section { min-width: 0; border: 1px solid var(--line); border-radius: 12px; padding: 10px; background: var(--surface-2); }
  .detail-section.full { grid-column: 1 / -1; }
  .detail-title { color: var(--text-2); font-size: 11px; font-weight: 650; margin-bottom: 8px; }
  .detail-empty, .log-empty, .log-loading, .activity-empty, .failed-gates-empty { color: var(--text-3); font-size: 12px; padding: 8px 0; }
  .skeleton { height: 10px; border-radius: 7px; background: var(--line-strong); opacity: .7; }
  .gate-list, .timeline-list, .log-list { display: grid; gap: 6px; min-width: 0; }
  .gate-row, .log-line {
    min-width: 0;
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    gap: 8px;
    align-items: start;
    color: var(--text-2);
    font-size: 12px;
  }
  .gate-row strong { min-width: 0; color: var(--text); font-weight: 600; overflow-wrap: anywhere; }
  .gate-row small, .log-text { min-width: 0; color: var(--text-2); overflow-wrap: anywhere; }
  .gate-row.pass-line .log-icon, .log-line.pass-line .log-icon { color: var(--ok); }
  .gate-row.fail-line .log-icon, .log-line.fail-line .log-icon, .log-line.error-line .log-icon { color: var(--crit); }
  .gate-row.warn-line .log-icon, .log-line.fail-line .log-text { color: var(--warn); }
  .log-line { grid-template-columns: 18px 48px minmax(0, 1fr); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .log-time { color: var(--text-3); font-size: 11px; white-space: nowrap; }
  .log-output {
    display: none;
    grid-column: 3;
    max-height: 180px;
    overflow: auto;
    margin-top: 4px;
    padding: 8px;
    border: 1px solid var(--line);
    border-radius: 7px;
    background: var(--bg);
    color: var(--text-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .log-output.visible { display: block; }
  .bash-toggle { min-width: 28px; min-height: 28px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--text-2); cursor: pointer; }
  .fail-reason { color: var(--crit); font-size: 12px; overflow-wrap: anywhere; }
  .task-meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--text-3); font-size: 11px; }
  .phase-detail { color: var(--text-2); font-size: 12px; overflow-wrap: anywhere; }

  .review-card, .ui-evidence-panel, .sidebar-panel {
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--surface);
  }
  .review-card { overflow: hidden; }
  .review-header { grid-template-columns: 18px minmax(110px, .26fr) minmax(0, 1fr) auto; }
  .review-body { display: none; border-top: 1px solid var(--line); }
  .review-card.expanded .review-body { display: block; }
  .review-body-inner { padding: 12px 14px 14px; }
  .review-issue { border-left: 2px solid var(--line-strong); border-radius: 7px; padding: 8px; background: var(--surface-2); font-size: 12px; overflow-wrap: anywhere; }
  .review-issue + .review-issue { margin-top: 6px; }
  .review-issue.severity-critical, .review-issue.severity-high { border-left-color: var(--crit); }
  .review-issue.severity-medium { border-left-color: var(--warn); }
  .review-issue.severity-low { border-left-color: var(--text-3); }
  .issue-sev-critical, .issue-sev-high { color: var(--crit); }
  .issue-sev-medium { color: var(--warn); }
  .issue-sev-low, .review-issue .issue-file { color: var(--text-3); }
  .review-summary { color: var(--text-2); font-size: 12px; padding: 5px 0; }
  .review-result-pass { color: var(--ok); }
  .review-result-fail { color: var(--crit); }
  .review-waiting { color: var(--text-3); font-size: 12px; }
  .review-status-box { display: grid; gap: 6px; padding: 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-2); }
  .review-status-title { color: var(--text-2); font-size: 11px; font-weight: 650; letter-spacing: 0; }
  .review-row { display: flex; justify-content: space-between; gap: 8px; color: var(--text-2); font-size: 12px; }
  .review-count.ok { color: var(--ok); }
  .review-count.attention { color: var(--warn); }

  .ui-evidence-panel { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; padding: 12px; }
  .evidence-item { min-width: 0; padding: 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface-2); }
  .evidence-label { display: block; color: var(--text-3); font-size: 11px; margin-bottom: 4px; }
  .evidence-value { display: block; color: var(--text); font-size: 12px; font-weight: 650; overflow-wrap: anywhere; }
  .evidence-thumb { grid-column: 1 / -1; min-height: 72px; display: flex; align-items: center; justify-content: center; color: var(--text-3); border: 1px dashed var(--line-strong); border-radius: 7px; background: var(--surface-2); font-size: 12px; text-align: center; padding: 12px; }

  .sidebar { display: grid; gap: 12px; min-width: 0; }
  .sidebar-panel { min-width: 0; padding: 12px; }
  .sidebar h3 { color: var(--text-2); font-size: 12px; font-weight: 650; letter-spacing: 0; margin-bottom: 10px; }
  .sidebar ul { list-style: none; display: grid; gap: 8px; }
  .gate-bar-row { display: grid; grid-template-columns: minmax(0, 1fr) 82px 28px; gap: 8px; align-items: center; color: var(--text-2); font-size: 12px; }
  .gate-bar-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gate-bar-track { height: 6px; overflow: hidden; border-radius: 7px; background: var(--surface-2); border: 1px solid var(--line); }
  .gate-bar-fill { display: block; height: 100%; border-radius: inherit; background: var(--crit); }
  .gate-bar-row strong { color: var(--crit); font-size: 11px; text-align: right; }
  .task-inspector { display: grid; gap: 10px; }
  .inspector-empty { color: var(--text-3); font-size: 12px; }
  .activity-list { display: grid; gap: 8px; }
  .activity-item { display: grid; grid-template-columns: 56px 10px minmax(0, 1fr); gap: 8px; align-items: center; min-width: 0; }
  .activity-time { color: var(--text-3); font-size: 11px; }
  .activity-dot { background: var(--accent); }
  .activity-text { min-width: 0; color: var(--text-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .refresh, .source { color: var(--text-3); font-size: 11px; overflow-wrap: anywhere; }
  .footer { margin-top: 16px; padding: 12px 0 4px; border-top: 1px solid var(--line); color: var(--text-3); font-size: 11px; }
  .empty { min-height: 120px; display: grid; place-items: center; color: var(--text-3); border: 1px dashed var(--line-strong); border-radius: 12px; background: var(--surface); font-size: 13px; }

  @media (max-width: 639px) {
    .page-shell { padding: 12px; }
    .topbar { grid-template-columns: 1fr; margin: -12px -12px 12px; gap: 10px; }
    .topbar-meta { justify-content: space-between; }
    .run-title-row { flex-wrap: wrap; }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .stat { min-height: 76px; }
    .stat strong { font-size: 20px; }
    .task-header, .review-header { grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: start; }
    .task-id { grid-column: 2; max-width: 100%; white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere; word-break: break-word; }
    .task-desc { grid-column: 2; white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere; word-break: break-word; }
    .task-badges { grid-column: 2; justify-content: flex-start; flex-wrap: wrap; }
    .status-tag, .task-duration { grid-column: 2; justify-self: start; }
    .detail-grid { grid-template-columns: 1fr; }
    .ui-evidence-panel { grid-template-columns: 1fr; }
  }

  @media (min-width: 640px) {
    .page-shell { padding: 20px; }
    .topbar { margin: -20px -20px 16px; padding: 12px 20px; }
  }
  @media (max-width: 767px) {
    .main { display: grid; grid-template-columns: 1fr; }
    .desktop-only { display: none; }
  }
  @media (min-width: 768px) {
    .sidebar { position: sticky; top: 84px; }
  }
  @media (max-width: 1023px) {
    .main { grid-template-columns: 1fr; }
    .sidebar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .task-inspector-panel { display: none; }
  }
  @media (min-width: 1024px) {
    .task-inspector-panel { display: block; }
  }
  @media (min-width: 1280px) {
    .main { grid-template-columns: minmax(0, 1fr) 380px; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  }
`;

// ── JS 模板（客户端逻辑 — SSE 实时推送）────────────────────────
const CLIENT_JS = `
(function() {
  var expandedCards = Object();
  var loadedLogs = Object();
  var currentProgress = null;
  var selectedTaskId = null;

  var iconPaths = {
    'alert-circle': '<circle cx="12" cy="12" r="9"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path>',
    'check-circle': '<path d="M21 12a9 9 0 1 1-5.2-8.2"></path><path d="m9 12 2 2 4.5-5"></path>',
    'chevron-right': '<path d="m9 18 6-6-6-6"></path>',
    'circle': '<circle cx="12" cy="12" r="8"></circle>',
    'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M8 13h8"></path><path d="M8 17h5"></path>',
    'minus-circle': '<circle cx="12" cy="12" r="9"></circle><path d="M8 12h8"></path>',
    'pencil': '<path d="m18 2 4 4L8 20l-6 2 2-6Z"></path><path d="m14 6 4 4"></path>',
    'play-circle': '<circle cx="12" cy="12" r="9"></circle><path d="m10 8 6 4-6 4Z"></path>',
    'rotate-ccw': '<path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v6h6"></path>',
    'search': '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path>',
    'shield': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"></path><path d="m9 12 2 2 4-5"></path>',
    'terminal': '<path d="m4 17 6-6-6-6"></path><path d="M12 19h8"></path>',
    'x-circle': '<circle cx="12" cy="12" r="9"></circle><path d="m15 9-6 6"></path><path d="m9 9 6 6"></path>',
    'wrench': '<path d="M14.7 6.3a4 4 0 0 0-5 5L3 18v3h3l6.7-6.7a4 4 0 0 0 5-5l-2.8 2.8-2.1-2.1Z"></path>'
  };

  function iconSvg(name, className) {
    return '<svg class="' + (className || 'icon') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + (iconPaths[name] || iconPaths.circle) + '</svg>';
  }

  function statusMeta(status) {
    var raw = String(status || 'pending');
    if (raw === 'done') return { key: 'passed', label: 'Passed', icon: 'check-circle' };
    if (raw === 'failed') return { key: 'blocked', label: 'Blocked', icon: 'x-circle' };
    if (raw === 'running') return { key: 'running', label: 'Running', icon: 'play-circle' };
    if (raw === 'skipped') return { key: 'skipped', label: 'Skip' + 'ped', icon: 'minus-circle' };
    return { key: 'pending', label: 'Pending', icon: 'circle' };
  }

  function phaseMeta(phase) {
    var raw = String(phase || '');
    var map = {
      precheck: { label: 'Precheck', key: 'pending' },
      claude: { label: 'Agent', key: 'running' },
      gate: { label: 'Gate', key: 'warn' },
      commit: { label: 'Commit', key: 'running' },
      retry: { label: 'Retry', key: 'warn' },
      done: { label: 'Done', key: 'passed' },
      failed: { label: 'Failed', key: 'blocked' }
    };
    return map[raw] || { label: raw || 'Queued', key: raw ? 'pending' : 'pending' };
  }

  function gateMetaForTask(t) {
    var rawStatus = String(t && t.status || 'pending');
    var phase = String(t && t.phase || '');
    if (rawStatus === 'failed' || phase === 'failed' || t && t.failReason) return { key: 'blocked', label: 'Gate blocked' };
    if (phase === 'retry') return { key: 'warn', label: 'Retrying gate' };
    if (phase === 'gate') return { key: 'running', label: 'Gate running' };
    if (rawStatus === 'done' || rawStatus === 'skipped' || phase === 'commit' || phase === 'done') return { key: 'passed', label: 'Gate pass' };
    return { key: 'pending', label: 'Gate pending' };
  }

  function taskRank(t) {
    var rawStatus = String(t && t.status || 'pending');
    var retry = Number(t && t.retry || 0);
    if (rawStatus === 'failed') return 0;
    if (rawStatus === 'running') return 1;
    if (retry > 0) return 2;
    if (rawStatus === 'pending') return 3;
    if (rawStatus === 'skipped') return 5;
    return 4;
  }

  function sortedTasks(tasks) {
    return (tasks || []).slice().sort(function(a, b) {
      var rank = taskRank(a) - taskRank(b);
      if (rank !== 0) return rank;
      return String(a && a.id || '').localeCompare(String(b && b.id || ''));
    });
  }

  function retryTotal(tasks) {
    return (tasks || []).reduce(function(sum, t) { return sum + Math.max(0, Number(t && t.retry || 0)); }, 0);
  }

  function blockerTotal(tasks, lifecycle) {
    var failed = (tasks || []).filter(function(t) { return t.status === 'failed'; }).length;
    return failed + Math.max(0, Number(lifecycle && lifecycle.blocker_count || 0));
  }

  function gatePassRate(done, failed) {
    var evaluated = Number(done || 0) + Number(failed || 0);
    return evaluated > 0 ? Math.round((Number(done || 0) / evaluated) * 100) : 0;
  }

  function currentPhase(tasks, current) {
    var running = current || (tasks || []).find(function(t) { return t.status === 'running'; });
    return phaseMeta(running && running.phase || '').label;
  }

  function updateText(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = String(value);
  }

  // 展开/折叠切换
  function toggleCard(card) {
    var taskId = card.getAttribute('data-task-id');
    var isExpanded = card.classList.contains('expanded');
    if (isExpanded) {
      card.classList.remove('expanded');
      var header = card.querySelector('.task-header');
      if (header) header.setAttribute('aria-expanded', 'false');
      expandedCards[taskId] = false;
    } else {
      selectedTaskId = taskId;
      card.classList.add('expanded');
      var expandedHeader = card.querySelector('.task-header');
      if (expandedHeader) expandedHeader.setAttribute('aria-expanded', 'true');
      expandedCards[taskId] = true;
      loadTaskLog(taskId, card);
      renderInspector(taskId);
    }
  }

  function loadTaskLog(taskId, card) {
    var body = card.querySelector('.task-detail-slot');
    if (!body) return;
    replaceWithMarkup(body, '<div class="log-loading"><div class="skeleton"></div></div>');
    fetch('/api/task-logs/' + encodeURIComponent(taskId))
      .then(function(r) { return r.json(); })
      .then(function(entries) {
        loadedLogs[taskId] = true;
        if (!entries || entries.length === 0) {
          replaceWithMarkup(body, renderTaskDetail([], taskId));
          renderInspector(taskId);
          return;
        }
        replaceWithMarkup(body, renderTaskDetail(entries, taskId));
        renderInspector(taskId, entries);
      })
      .catch(function() {
        setStatusMessage(body, 'log-empty', '日志加载失败');
      });
  }

  function appendLogEntries(taskId, entries) {
    var card = findTaskCardById(taskId);
    if (!card || !card.classList.contains('expanded')) return;
    var body = card.querySelector('.timeline-list');
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

  function findTaskDataById(taskId) {
    var raw = String(taskId || '');
    var tasks = currentProgress && currentProgress.tasks || [];
    for (var i = 0; i < tasks.length; i++) {
      if (String(tasks[i].id || '') === raw) return tasks[i];
    }
    return null;
  }

  function renderTaskDetail(entries, taskId) {
    var task = findTaskDataById(taskId) || {};
    var gates = (entries || []).filter(function(e) { return e.type === 'GATE'; });
    var blockers = (entries || []).filter(function(e) {
      return e.type === 'ERROR' || e.result === 'fail' || e.errors && e.errors.length;
    });
    var post = (entries || []).filter(function(e) {
      return e.type === 'DONE' || e.type === 'FIX' || e.type === 'REVIEW_ISSUE';
    });
    var gateHtml = gates.length
      ? gates.map(renderGateRow).join('')
      : '<div class="detail-empty">暂无 gate 明细</div>';
    var blockerHtml = blockers.length || task.failReason
      ? (task.failReason ? '<div class="fail-reason">' + escapeHtml(task.failReason) + '</div>' : '') + blockers.slice(0, 5).map(renderBlockerRow).join('')
      : '<div class="detail-empty">暂无 blocker</div>';
    var postHtml = post.length
      ? post.slice(-5).map(renderPostRow).join('')
      : '<div class="detail-empty">暂无 post-condition / review 记录</div>';
    var meta = [
      task.priority ? 'Priority ' + escapeHtml(task.priority) : '',
      task.phase ? 'Phase ' + escapeHtml(task.phase) : '',
      task.phaseDetail ? escapeHtml(task.phaseDetail) : '',
      task.time ? escapeHtml(task.time) : ''
    ].filter(Boolean).join(' · ');
    var timeline = entries && entries.length
      ? renderLogEntries(entries.slice(-24))
      : '<div class="log-empty">暂无活动日志</div>';

    return '<div class="detail-grid">' +
      '<section class="detail-section"><div class="detail-title">Gate 明细</div><div class="gate-list">' + gateHtml + '</div></section>' +
      '<section class="detail-section"><div class="detail-title">Blocker</div><div class="gate-list">' + blockerHtml + '</div></section>' +
      '<section class="detail-section"><div class="detail-title">Post-condition / Review</div><div class="gate-list">' + postHtml + '</div></section>' +
      '<section class="detail-section"><div class="detail-title">Task Meta</div><div class="task-meta">' + (meta || '暂无元数据') + '</div></section>' +
      '<section class="detail-section full"><div class="detail-title">活动 / 事件流</div><div class="timeline-list" data-task-id="' + escapeAttr(taskId) + '">' + timeline + '</div></section>' +
    '</div>';
  }

  function renderGateRow(e) {
    var result = String(e.result || 'pending');
    var cls = result === 'pass' ? 'pass-line' : result === 'fail' ? 'fail-line' : 'warn-line';
    var icon = result === 'pass' ? 'check-circle' : result === 'fail' ? 'x-circle' : 'shield';
    var detail = '';
    if (e.errors && e.errors.length > 0) {
      detail = '<button type="button" class="bash-toggle" aria-label="切换 gate 输出">+</button><div class="log-output">' + e.errors.map(escapeHtml).join('\\n') + '</div>';
    }
    return '<div class="gate-row ' + cls + '">' +
      '<span class="log-icon">' + iconSvg(icon) + '</span>' +
      '<strong>' + escapeHtml(e.check || 'gate') + '<small> · ' + escapeHtml(result) + '</small></strong>' +
      detail +
    '</div>';
  }

  function renderBlockerRow(e) {
    var message = e.message || e.detail || e.check || e.cmd || e.type || 'blocked';
    if (e.errors && e.errors.length) message = message + ': ' + e.errors.join(' ');
    return '<div class="gate-row fail-line">' +
      '<span class="log-icon">' + iconSvg('alert-circle') + '</span>' +
      '<strong>' + escapeHtml(message) + '</strong>' +
      '<span></span>' +
    '</div>';
  }

  function renderPostRow(e) {
    var ok = e.result === 'completed' || e.result === 'pass' || e.type === 'FIX';
    var cls = ok ? 'pass-line' : 'fail-line';
    var icon = ok ? 'check-circle' : 'x-circle';
    var text = e.type === 'FIX'
      ? 'Fix ' + (e.file || '')
      : e.type === 'DONE'
        ? 'Done: ' + (e.result || '')
        : (e.message || e.type || 'review');
    if (e.duration_ms) text += ' (' + formatDuration(e.duration_ms) + ')';
    return '<div class="gate-row ' + cls + '">' +
      '<span class="log-icon">' + iconSvg(icon) + '</span>' +
      '<strong>' + escapeHtml(text) + '</strong>' +
      '<span></span>' +
    '</div>';
  }

  function renderInspector(taskId, entries) {
    var inspector = document.getElementById('taskInspector');
    if (!inspector) return;
    var task = findTaskDataById(taskId);
    if (!task) {
      inspector.innerHTML = '<div class="inspector-empty">选择任务查看 gate、blocker 和 evidence。</div>';
      return;
    }
    var meta = statusMeta(task.status);
    var gate = gateMetaForTask(task);
    var detail = entries ? renderTaskDetail(entries, taskId) : '<div class="inspector-empty">展开任务行后会加载真实日志和 gate 明细。</div>';
    replaceWithMarkup(inspector,
      '<div class="task-inspector">' +
        '<div class="task-meta"><span class="task-id status-id-' + safeToken(task.status, 'pending') + '">' + escapeHtml(task.id || taskId) + '</span><span class="status-tag ' + meta.key + '">' + iconSvg(meta.icon, 'status-icon') + escapeHtml(meta.label) + '</span><span class="gate-chip ' + gate.key + '">' + escapeHtml(gate.label) + '</span></div>' +
        '<div class="phase-detail">' + escapeHtml(task.description || taskId) + '</div>' +
        detail +
      '</div>'
    );
  }

  function renderLogLine(e) {
    var icon = 'circle', cls = '', text = '';
    var ts = e.ts ? e.ts.split('T')[1]?.split('+')[0]?.substring(0,5) || '' : '';

    switch (e.type) {
      case 'TASK_START':
        icon = 'play-circle'; cls = ''; text = '开始: ' + escapeHtml(e.title || e.task_id || '');
        break;
      case 'READ':
        icon = 'file-text'; cls = ''; text = '读取 ' + escapeHtml(e.file || '') + (e.detail ? ' - ' + escapeHtml(e.detail) : '');
        break;
      case 'EDIT':
        icon = 'pencil'; cls = ''; text = '编辑 ' + escapeHtml(e.file || '') + (e.detail ? ' - ' + escapeHtml(e.detail) : '');
        break;
      case 'BASH':
        icon = 'terminal'; cls = e.result === 'fail' ? 'fail-line' : e.result === 'pass' ? 'pass-line' : '';
        text = escapeHtml(e.cmd || '');
        if (e.result === 'fail' && e.output) {
          text += ' <button type="button" class="bash-toggle" aria-label="切换输出">+</button>';
          text += '<div class="log-output">' + escapeHtml(e.output) + '</div>';
        }
        break;
      case 'GATE':
        icon = 'shield'; cls = e.result === 'fail' ? 'fail-line' : e.result === 'pass' ? 'pass-line' : '';
        text = 'Gate: ' + escapeHtml(e.check || '') + ' - ' + escapeHtml(e.result || '');
        if (e.result === 'fail' && e.errors && e.errors.length > 0) {
          text += ' <button type="button" class="bash-toggle" aria-label="切换输出">+</button>';
          text += '<div class="log-output">' + e.errors.map(escapeHtml).join('\\n') + '</div>';
        }
        break;
      case 'FIX':
        icon = 'wrench'; cls = ''; text = '修复 ' + escapeHtml(e.file || '') + (e.detail ? ' - ' + escapeHtml(e.detail) : '');
        break;
      case 'ERROR':
        icon = 'alert-circle'; cls = 'error-line'; text = escapeHtml(e.message || 'Error') + (e.detail ? ' - ' + escapeHtml(e.detail) : '');
        break;
      case 'DONE':
        icon = e.result === 'completed' ? 'check-circle' : 'x-circle';
        cls = e.result === 'completed' ? 'pass-line' : 'fail-line';
        text = e.result === 'completed' ? '完成' : '失败';
        if (e.duration_ms) text += ' (' + formatDuration(e.duration_ms) + ')';
        break;
      default:
        icon = 'circle'; cls = ''; text = escapeHtml(e.type || '') + ' ' + escapeHtml(e.detail || e.message || '');
    }

    return '<div class="log-line ' + cls + '">' +
      '<span class="log-icon">' + iconSvg(icon) + '</span>' +
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
    var header = card.querySelector('.review-header');
    if (isExpanded) {
      card.classList.remove('expanded');
      if (header) header.setAttribute('aria-expanded', 'false');
    } else {
      card.classList.add('expanded');
      if (header) header.setAttribute('aria-expanded', 'true');
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
        html += '<div class="review-summary">审查开始: ' + escapeHtml(e.scope || 'full') + ' - ' + escapeHtml(e.total_files || '?') + ' 个文件</div>';
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
          iconSvg(e.result === 'pass' ? 'check-circle' : 'x-circle') +
          (e.result === 'pass' ? ' 通过' : ' 未通过') +
          ' - 发现 ' + (e.issues_found || 0) + ' 个问题' +
          (e.issues_fixed ? '，修复 ' + e.issues_fixed + ' 个' : '') +
        '</div>';
      }
    });
    return html || '<div class="log-empty">暂无数据</div>';
  }

  function renderFailedGateRows(stats) {
    var rows = Object.keys(stats || {}).map(function(gate) {
      return [gate, Number(stats[gate]) || 0];
    }).filter(function(row) { return row[1] > 0; }).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 6);
    if (!rows.length) return '<li class="failed-gates-empty">暂无失败 Gate</li>';
    var max = rows.reduce(function(value, row) { return Math.max(value, row[1]); }, 1);
    return rows.map(function(row) {
      return '<li class="gate-bar-row">' +
        '<span class="gate-bar-label">' + escapeHtml(row[0]) + '</span>' +
        '<span class="gate-bar-track"><span class="gate-bar-fill" style="width:' + Math.max(8, Math.round((row[1] / max) * 100)) + '%"></span></span>' +
        '<strong>' + row[1] + '</strong>' +
      '</li>';
    }).join('');
  }

  function renderActivityItems(lifecycle) {
    var events = lifecycle && Array.isArray(lifecycle.recent_events) ? lifecycle.recent_events.slice(0, 8) : [];
    if (!events.length) return '<div class="activity-empty">暂无事件流</div>';
    return events.map(function(event) {
      var rawTime = String(event.created_at || event.updated_at || event.ts || '');
      var time = rawTime.indexOf('T') >= 0 ? rawTime.split('T')[1].slice(0, 8) : '--:--:--';
      var type = event.type || event.event || 'event';
      var stage = event.stage_id || event.stage || '';
      return '<div class="activity-item">' +
        '<span class="activity-time">' + escapeHtml(time) + '</span>' +
        '<span class="activity-dot"></span>' +
        '<span class="activity-text">' + escapeHtml(type) + (stage ? ' · ' + escapeHtml(stage) : '') + '</span>' +
      '</div>';
    }).join('');
  }

  function renderOverallStatus(d) {
    var status = d.failed > 0 ? { key: 'blocked', label: 'Blocked', icon: 'x-circle' }
      : d.total > 0 && d.done >= d.total ? { key: 'passed', label: 'Passed', icon: 'check-circle' }
      : d.runnerActive ? { key: 'running', label: 'Running', icon: 'play-circle' }
      : { key: 'pending', label: 'Idle', icon: 'circle' };
    return '<span class="chip-dot"></span>' + iconSvg(status.icon, 'status-icon') + escapeHtml(status.label);
  }

  // ── 更新进度条和统计数字 ────────────────────────────────────────
  function updateProgressUI(d) {
    currentProgress = d;
    var pct = d.total > 0 ? Math.round((d.done / d.total) * 100) : 0;
    var bar = document.getElementById('progressBar');
    if (bar) bar.style.width = pct + '%';
    var pctText = document.getElementById('pctText');
    if (pctText) pctText.textContent = pct + '%';
    document.title = 'YOLO Progress - ' + pct + '%';
    updateText('runCountText', d.done + ' / ' + d.total + ' tasks');
    updateText('lastUpdatedText', d.timestamp ? d.timestamp.split('T')[1].replace('Z', '').slice(0, 8) : 'live');

    // 更新统计数字
    var statsRow = document.getElementById('statsRow');
    if (statsRow && d.tasks) {
      var runningCount = d.tasks.filter(function(t) { return t.status === 'running'; }).length;
      var pendingCount = d.tasks.filter(function(t) { return t.status === 'pending'; }).length;
      updateText('statDone', d.done + ' / ' + d.total);
      updateText('statPhase', currentPhase(d.tasks, d.current));
      updateText('statGateRate', gatePassRate(d.done, d.failed) + '%');
      updateText('statBlockers', blockerTotal(d.tasks, d.lifecycle));
      updateText('statRetries', retryTotal(d.tasks));
      updateText('taskListNote', runningCount + ' running · ' + Math.max(0, pendingCount) + ' pending');
    }
    var overall = document.getElementById('overallStatus');
    if (overall) {
      overall.className = 'status-chip ' + (d.failed > 0 ? 'blocked' : d.total > 0 && d.done >= d.total ? 'passed' : d.runnerActive ? 'running' : 'pending');
      replaceWithMarkup(overall, renderOverallStatus(d));
    }
    var failedGates = document.getElementById('failedGates');
    if (failedGates) replaceWithMarkup(failedGates, renderFailedGateRows(d.stats || {}));
    var activity = document.getElementById('activityList');
    if (activity) replaceWithMarkup(activity, renderActivityItems(d.lifecycle || {}));
    updateText('evidenceState', d.runnerActive ? 'active' : 'idle');
    updateText('evidenceRuntime', d.failed > 0 ? 'task failure reported' : 'none reported');
    updateText('evidenceArtifacts', d.done + ' / ' + d.total);

    // 重新渲染任务列表（局部更新，保留展开状态）
    renderTaskList(d);
  }

  function renderTaskList(d) {
    if (!d || !d.tasks) return;
    var scrollY = window.scrollY;
    var taskList = document.getElementById('taskList');
    if (!taskList) return;

    var html = sortedTasks(d.tasks).map(function(t) {
      var rawTaskId = String(t.id || '');
      var taskId = escapeHtml(rawTaskId);
      var taskAttr = escapeAttr(rawTaskId);
      var rawStatus = String(t.status || 'pending');
      var status = safeToken(rawStatus, 'pending');
      var meta = statusMeta(rawStatus);
      var phase = phaseMeta(t.phase || '');
      var gate = gateMetaForTask(t);
      var grayed = !d.runnerActive && rawStatus === 'running' ? ' task-grayed' : '';
      var retry = Number(t.retry || 0);
      var retryChip = retry > 0 ? '<span class="retry-chip" title="重试 ' + retry + ' 次">' + iconSvg('rotate-ccw', 'status-icon') + retry + '</span>' : '';
      var durationStr = t.elapsed ? escapeHtml(t.elapsed) + 's' : '';
      var isExpanded = expandedCards[rawTaskId] ? ' expanded' : '';
      var logContent = expandedCards[rawTaskId] ? '<div class="task-detail-slot" data-task-id="' + taskAttr + '"><div class="log-loading"><div class="skeleton"></div></div></div>' : '<div class="task-detail-slot" data-task-id="' + taskAttr + '"><div class="log-empty">点击展开查看 gate、blocker 和活动日志</div></div>';

      return '<div class="task-card' + isExpanded + (rawStatus === 'running' ? ' task-running' : '') + grayed + '" data-status="' + escapeAttr(status) + '" data-task-id="' + taskAttr + '">' +
        '<button type="button" class="task-header" aria-expanded="' + (expandedCards[rawTaskId] ? 'true' : 'false') + '">' +
          '<span class="task-chevron">' + iconSvg('chevron-right') + '</span>' +
          '<span class="task-id status-id-' + status + '">' + iconSvg(meta.icon, 'status-icon') + taskId + '</span>' +
          '<span class="task-desc">' + escapeHtml(t.description || rawTaskId) + '</span>' +
          '<span class="task-badges"><span class="phase-chip ' + phase.key + '">' + escapeHtml(phase.label) + '</span><span class="gate-chip ' + gate.key + '">' + escapeHtml(gate.label) + '</span>' + retryChip + '</span>' +
          '<span class="status-tag ' + meta.key + '"><span class="chip-dot"></span>' + escapeHtml(meta.label) + '</span>' +
          (durationStr ? '<span class="task-duration">' + durationStr + '</span>' : '') +
        '</button>' +
        '<div class="task-body"><div class="task-body-inner">' + logContent + '</div></div>' +
      '</div>';
    }).join('');

    if (html) replaceWithMarkup(taskList, html);
    else setStatusMessage(taskList, 'empty', '等待任务开始...');

    // 恢复已展开卡片的日志内容
    Object.keys(expandedCards).forEach(function(taskId) {
      if (expandedCards[taskId]) {
        var card = findTaskCardById(taskId);
        if (card) {
          loadTaskLog(taskId, card);
        }
      }
    });
    if (selectedTaskId) renderInspector(selectedTaskId);

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
    var header = card.querySelector('.task-header');
    if (header) header.setAttribute('aria-expanded', 'true');
    loadTaskLog(taskId, card);
  });
})();
`;

// ── HTML 页面 ──────────────────────────────────────────────────────
const HTML = (data, stats) => {
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
<style>${CSS}
  body { display: grid; place-items: center; padding: 16px; }
  .idle-box { width: min(560px, 100%); display: grid; gap: 12px; text-align: center; }
  .idle-icon { width: 44px; height: 44px; margin: 0 auto 4px; display: grid; place-items: center; color: var(--text-3); border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
  .idle-svg { width: 22px; height: 22px; }
  .idle-title { display: inline-flex; align-items: center; justify-content: center; gap: 8px; color: var(--text); font-size: 20px; font-weight: 650; }
  .idle-sub { color: var(--text-2); font-size: 13px; }
  .idle-pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); }
  .idle-lifecycle { margin-top: 12px; width: 100%; background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px; text-align: left; }
  .idle-lifecycle-title { color: var(--text); font-size: 13px; font-weight: 650; margin-bottom: 8px; }
  .idle-lifecycle-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; color: var(--text-2); font-size: 12px; margin-bottom: 8px; }
  .idle-lifecycle-grid span { min-width: 0; background: var(--surface-2); border: 1px solid var(--line); border-radius: 7px; padding: 8px; text-align: center; }
  .idle-lifecycle-grid strong { display: block; color: var(--text); font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 20px; margin-top: 2px; }
  .idle-lifecycle-sub { color: var(--text-2); font-size: 12px; overflow-wrap: anywhere; }
</style>
</head>
<body>
<div class="idle-box">
  <div class="idle-icon">${iconSvg("pause-circle", "idle-svg")}</div>
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
  const runningCount = tasks.filter((t) => t.status === "running").length;
  const pendingCount = tasks.filter((t) => t.status === "pending").length;
  const retryCount = retryTotal(tasks);
  const blockers = blockerTotal(tasks, lifecycle);
  const passRate = gatePassRate(done, failed);
  const phaseNow = currentPhase(tasks, current);
  const overall = failed > 0
    ? { key: "blocked", label: "Blocked", icon: "x-circle" }
    : total > 0 && done >= total
      ? { key: "passed", label: "Passed", icon: "check-circle" }
      : runnerActive
        ? { key: "running", label: "Running", icon: "play-circle" }
        : { key: "pending", label: "Idle", icon: "circle" };

  // 任务卡片
  const taskCards = tasks.length > 0
    ? sortedTasksForDashboard(tasks).map((t) => {
        const rawTaskId = String(t.id || "");
        const safeTaskId = escapeHtml(rawTaskId);
        const taskAttr = escapeAttr(rawTaskId);
        const rawStatus = String(t.status || "pending");
        const statusAttr = escapeAttr(rawStatus.replace(/[^a-zA-Z0-9_-]/g, "") || "pending");
        const meta = statusMeta(rawStatus);
        const phase = phaseMeta(t.phase || "");
        const gate = gateMetaForTask(t);
        const grayed = !runnerActive && rawStatus === "running" ? " task-grayed" : "";
        const retry = Number(t.retry || 0);
        const retryChip = retry > 0 ? `<span class="retry-chip" title="重试 ${retry} 次">${iconSvg("rotate-ccw", "status-icon")}${retry}</span>` : "";
        const durationStr = t.elapsed ? `${escapeHtml(t.elapsed)}s` : "";
        return `
    <div class="task-card${rawStatus === "running" ? " task-running" : ""}${grayed}" data-status="${statusAttr}" data-task-id="${taskAttr}">
      <button type="button" class="task-header" aria-expanded="false">
        <span class="task-chevron">${iconSvg("chevron-right")}</span>
        <span class="task-id status-id-${statusAttr}">${iconSvg(meta.icon, "status-icon")}${safeTaskId}</span>
        <span class="task-desc">${escapeHtml(t.description || rawTaskId)}</span>
        <span class="task-badges"><span class="phase-chip ${phase.key}">${escapeHtml(phase.label)}</span><span class="gate-chip ${gate.key}">${escapeHtml(gate.label)}</span>${retryChip}</span>
        <span class="status-tag ${meta.key}"><span class="chip-dot"></span>${escapeHtml(meta.label)}</span>
        ${durationStr ? `<span class="task-duration">${durationStr}</span>` : ""}
      </button>
      <div class="task-body"><div class="task-body-inner">
        <div class="task-detail-slot" data-task-id="${taskAttr}"><div class="log-empty">点击展开查看 gate、blocker 和活动日志</div></div>
      </div></div>
    </div>`;
      }).join("")
    : '<div class="empty">等待任务开始...</div>';
  const failedRows = renderFailedGateRows(stats);

  // Review 卡片
  const review = data?.review;
  const reviewStatus = review
    ? review.latestStatus === "clean"
      ? { key: "passed", label: "Passed", icon: "check-circle" }
      : { key: "failed", label: review.latestStatus === "bugs_found" ? `${Number(review.latestBugs) || 0} Issues` : "Error", icon: "x-circle" }
    : { key: "pending", label: "Pending", icon: "circle" };
  const reviewCardHtml = `
    <div class="review-card" id="reviewCardSlot">
      <button type="button" class="review-header" aria-expanded="false">
        <span class="task-chevron">${iconSvg("chevron-right")}</span>
        <span class="task-id review-task-id">${iconSvg("search", "status-icon")}全量 Review</span>
        <span class="task-desc">代码审查</span>
        <span class="status-tag ${reviewStatus.key}"><span class="chip-dot"></span>${iconSvg(reviewStatus.icon, "status-icon")}${escapeHtml(reviewStatus.label)}</span>
      </button>
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
<div class="page-shell">
  <header class="topbar">
    <div class="run-cluster">
      <div class="run-title-row">
        <div class="run-title">YOLO Runner</div>
        <div class="run-count" id="runCountText">${done} / ${total} tasks</div>
        <div class="pct" id="pctText">${pct}%</div>
      </div>
      <div class="progress-bar-wrap" aria-label="run progress"><div class="progress-bar" id="progressBar" style="width:${pct}%"></div></div>
    </div>
    <div class="topbar-meta">
      <div class="status-chip ${overall.key}" id="overallStatus"><span class="chip-dot"></span>${iconSvg(overall.icon, "status-icon")}${escapeHtml(overall.label)}</div>
      <div class="live-meta"><span class="live-dot"></span><span>live</span><span id="lastUpdatedText">SSE</span></div>
    </div>
  </header>

  ${!runnerActive && total > 0 ? `<div class="runner-warn">${iconSvg("alert-circle")}Runner 未运行 · 以下为历史数据</div>` : runnerActive && total > 0 ? `<div class="runner-ok">${iconSvg("radio")}Runner 运行中</div>` : ""}
  ${done === total && total > 0 ? `<div class="done-banner">${iconSvg("check-circle")}全部完成</div>` : ""}

  <section class="stats" id="statsRow">
    <div class="stat done"><span>Done / Total</span><strong id="statDone">${done} / ${total}</strong><small>实时任务完成数</small></div>
    <div class="stat running"><span>Current Phase</span><strong id="statPhase">${escapeHtml(phaseNow)}</strong><small>${escapeHtml(current?.id || "no active task")}</small></div>
    <div class="stat"><span>Gate Pass Rate</span><strong id="statGateRate">${passRate}%</strong><small>基于 done / failed</small></div>
    <div class="stat failed"><span>Blockers</span><strong id="statBlockers">${blockers}</strong><small>task + lifecycle</small></div>
    <div class="stat warn"><span>Retries</span><strong id="statRetries">${retryCount}</strong><small>累计 retry</small></div>
  </section>

  <main class="main">
    <section class="workstream">
      <div class="section-head">
        <div class="section-title">任务列表</div>
        <div class="section-note" id="taskListNote">${runningCount} running · ${Math.max(0, pendingCount)} pending</div>
      </div>
      <div class="task-list" id="taskList">${taskCards}</div>
      ${reviewCardHtml}
      <div class="section-head">
        <div class="section-title">UI Evidence</div>
        <div class="section-note">Page / State / Layout / Viewport / Runtime Error / Artifacts</div>
      </div>
      <div class="ui-evidence-panel" id="uiEvidencePanel">
        <div class="evidence-item"><span class="evidence-label">Page</span><span class="evidence-value">server-rendered</span></div>
        <div class="evidence-item"><span class="evidence-label">State</span><span class="evidence-value" id="evidenceState">${escapeHtml(runnerActive ? "active" : "idle")}</span></div>
        <div class="evidence-item"><span class="evidence-label">Layout</span><span class="evidence-value">responsive CSS</span></div>
        <div class="evidence-item"><span class="evidence-label">Runtime Error</span><span class="evidence-value" id="evidenceRuntime">${escapeHtml(failed > 0 ? "task failure reported" : "none reported")}</span></div>
        <div class="evidence-item"><span class="evidence-label">Viewport</span><span class="evidence-value">375 / 768 / 1440</span></div>
        <div class="evidence-item"><span class="evidence-label">Artifacts</span><span class="evidence-value" id="evidenceArtifacts">${escapeHtml(done + " / " + total)}</span></div>
        <div class="evidence-thumb">截图 artifact 不在当前 progress payload 中；看板只展示真实已注入数据。</div>
      </div>
    </section>

    <aside class="sidebar" id="sidebar">
      <section class="sidebar-panel task-inspector-panel">
        <h3>任务详情</h3>
        <div id="taskInspector" class="task-inspector"><div class="inspector-empty">选择任务查看 gate、blocker、post-condition 和活动日志。</div></div>
      </section>
      <section class="sidebar-panel">
        ${reviewBlock}
        <h3>高频失败 Gate</h3>
        <ul id="failedGates">${failedRows}</ul>
      </section>
      <section class="sidebar-panel">
        <h3>活动 / 事件流</h3>
        <div class="activity-list" id="activityList">${renderActivityItems(lifecycle)}</div>
        <p class="refresh">SSE 实时推送</p>
      </section>
    </aside>
  </main>
  <footer class="footer">数据源: ${escapeHtml(source)} · PRD ${escapeHtml(basename(resolvePrdPath() || "unknown"))} · run ${escapeHtml(currentRun.run_id || "unknown")}</footer>
</div>
<script>${CLIENT_JS}</script>
</body>
</html>`;
};

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
export { server, getProgressData, readStats, readLifecycleProgressData, startFileWatchers, closeProgressServerResources, HTML, CSS };

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
