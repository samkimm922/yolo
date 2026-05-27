import {
  existsSync as defaultExistsSync,
  readdirSync as defaultReaddirSync,
  rmSync as defaultRmSync,
  unlinkSync as defaultUnlinkSync,
} from "node:fs";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const PERSIST_RUNTIME_FILES = new Set([
  "learn-stats.json",
  "condition-stats.json",
  "tsc-baseline.json",
  "eslint-baseline.json",
  "task-results.jsonl",
  "task-logs",
]);

function isSafeWorktreeRoot(worktreeRoot) {
  if (!worktreeRoot) return false;
  const normalized = resolve(worktreeRoot);
  return normalized.split(/[\\/]+/).includes(".yolo-worktrees");
}

export function cleanupWorktreeRoot({
  worktreeRoot,
  existsSync = defaultExistsSync,
  readdirSync = defaultReaddirSync,
  rmSync = defaultRmSync,
} = {}) {
  if (!isSafeWorktreeRoot(worktreeRoot)) {
    return { skipped: true, reason: "unsafe_worktree_root", removed: [] };
  }
  if (!existsSync(worktreeRoot)) {
    return { skipped: true, reason: "missing_worktree_root", removed: [] };
  }
  let entries = [];
  try {
    entries = readdirSync(worktreeRoot).map((entry) => join(worktreeRoot, entry));
    rmSync(worktreeRoot, { recursive: true, force: true });
    return { skipped: false, removed: entries };
  } catch (error) {
    return { skipped: true, reason: "cleanup_failed", error, removed: entries };
  }
}

export function cleanDirByPattern({
  dir,
  pattern,
  keep = 10,
  exclude = new Set(),
  existsSync = defaultExistsSync,
  readdirSync = defaultReaddirSync,
  unlinkSync = defaultUnlinkSync,
} = {}) {
  const removed = [];
  if (!existsSync(dir)) return removed;
  const files = readdirSync(dir).filter((file) => file.match(pattern)).sort().reverse();
  const removable = files.filter((file) => !exclude.has(resolve(dir, file)));
  for (const file of removable.slice(keep)) {
    try {
      unlinkSync(join(dir, file));
      removed.push(file);
    } catch (_) {}
  }
  return removed;
}

export function cleanupRunArtifacts({
  yoloRoot,
  toolsRoot = yoloRoot,
  projectRoot,
  worktreeRoot = projectRoot ? join(projectRoot, "..", ".yolo-worktrees") : null,
  stateDir,
  runtimeDir,
  prdPath,
  completionStatus = "unknown",
  normalizeRepoPath = (value) => value,
  existsSync = defaultExistsSync,
  readdirSync = defaultReaddirSync,
  rmSync = defaultRmSync,
  unlinkSync = defaultUnlinkSync,
  spawnSync = defaultSpawnSync,
  consoleLog = (...args) => console.log(...args),
} = {}) {
  consoleLog("\n[cleanup] 自动清理临时文件...");
  let cleanedCount = 0;
  const removePath = (filePath) => {
    try {
      if (!existsSync(filePath)) return false;
      rmSync(filePath, { recursive: true, force: true });
      cleanedCount++;
      return true;
    } catch (_) {
      return false;
    }
  };

  try {
    for (const file of readdirSync(yoloRoot)) {
      if (file.startsWith("task-results.bak.")) removePath(join(yoloRoot, file));
    }
    const dataDir = join(yoloRoot, "data");
    if (existsSync(dataDir)) {
      for (const file of readdirSync(dataDir)) {
        if (file.startsWith("task-results.bak.")) removePath(join(dataDir, file));
      }
    }
  } catch (_) {}

  const preserveDebugRuntime = completionStatus !== "success";
  const runtimeKeep = preserveDebugRuntime ? PERSIST_RUNTIME_FILES : new Set();
  try {
    if (existsSync(runtimeDir)) {
      for (const file of readdirSync(runtimeDir)) {
        if (runtimeKeep.has(file)) continue;
        removePath(join(runtimeDir, file));
      }
    }
  } catch (_) {}

  removePath(join(stateDir, "expanded-tasks.json"));
  removePath(join(stateDir, "runner.pid"));
  removePath(join(stateDir, "yolo-output.log"));
  removePath(join(stateDir, "review-log.jsonl"));

  const worktreeCleanup = cleanupWorktreeRoot({ worktreeRoot, existsSync, readdirSync, rmSync });
  if (!worktreeCleanup.skipped) {
    cleanedCount += worktreeCleanup.removed.length;
  }
  consoleLog(`[cleanup] 已清理 ${cleanedCount} 个临时文件`);

  cleanDirByPattern({ dir: runtimeDir, pattern: /^gate-.*\.json$/, keep: 10, existsSync, readdirSync, unlinkSync });
  cleanDirByPattern({
    dir: join(yoloRoot, "data"),
    pattern: /^retry-round.*\.json$/,
    keep: 0,
    exclude: new Set([resolve(prdPath)]),
    existsSync,
    readdirSync,
    unlinkSync,
  });

  try {
    const cleanupScript = join(toolsRoot, "noise-cleanup.js");
    if (!existsSync(cleanupScript)) {
      return { cleanedCount, worktreeCleanup };
    }
    const cleanup = spawnSync("node", [
      cleanupScript,
      "--apply",
      `--current-prd=${normalizeRepoPath(prdPath).replace(/^scripts\/yolo\//, "")}`,
    ], {
      cwd: toolsRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cleanupText = (cleanup.stdout || cleanup.stderr || "").trim();
    if (cleanupText) consoleLog(`[cleanup] noise-cleanup: ${cleanupText.split("\n")[0]}`);
    if (cleanup.status !== 0) consoleLog(`[cleanup] noise-cleanup 非阻断失败: ${cleanup.stderr || cleanup.status}`);
  } catch (error) {
    consoleLog(`[cleanup] noise-cleanup 非阻断异常: ${error.message}`);
  }

  return { cleanedCount, worktreeCleanup };
}

export function buildRunReturnResult({
  runId,
  prdPath,
  taskResults,
  runReportResult,
  normalizeRepoPath = (value) => value,
} = {}) {
  const exitCode = taskResults.failed.length > 0 ? 1 : 0;
  return {
    status: exitCode === 0 ? "success" : "error",
    summary: exitCode === 0 ? "runner completed" : `runner completed with ${taskResults.failed.length} failed task(s)`,
    exit_code: exitCode,
    run_id: runId,
    prd: prdPath,
    completed: taskResults.completed,
    failed: taskResults.failed,
    skipped: taskResults.skipped,
    blocked: taskResults.blocked || [],
    remediation: taskResults.remediation || [],
    report_file: normalizeRepoPath(runReportResult.json_path),
    report_markdown: normalizeRepoPath(runReportResult.markdown_path),
    ...(runReportResult.final_answer_json_path ? { final_answer_file: normalizeRepoPath(runReportResult.final_answer_json_path) } : {}),
    ...(runReportResult.final_answer_markdown_path ? { final_answer_markdown: normalizeRepoPath(runReportResult.final_answer_markdown_path) } : {}),
  };
}

export function printRunReportSummary({
  taskResults,
  progressTotal,
  elapsed,
  reportSummary = {},
  runReportResult,
  normalizeRepoPath = (value) => value,
  consoleLog = (...args) => console.log(...args),
} = {}) {
  const totalTasks = taskResults.completed.length + taskResults.failed.length;
  const taskSuccessRate = reportSummary.task_success_rate == null ? "N/A" : `${reportSummary.task_success_rate.toFixed(1)}%`;
  const runSuccessRate = reportSummary.run_success_rate == null ? "N/A" : `${reportSummary.run_success_rate.toFixed(1)}%`;
  consoleLog(`task_success_rate: ${taskSuccessRate} (${taskResults.completed.length}/${totalTasks})`);
  consoleLog(`run_success_rate: ${runSuccessRate} (${taskResults.completed.length}/${progressTotal})`);
  consoleLog(`\n=== 最终报告 ===\n完成: ${taskResults.completed.length} | 失败: ${taskResults.failed.length} | 耗时: ${elapsed}s`);
  if (taskResults.completed.length) consoleLog(`ok ${taskResults.completed.join(", ")}`);
  if (taskResults.failed.length) consoleLog(`FAIL ${taskResults.failed.join(", ")}`);
  consoleLog(`report_json: ${normalizeRepoPath(runReportResult.json_path)}`);
  consoleLog(`report_markdown: ${normalizeRepoPath(runReportResult.markdown_path)}`);
  if (runReportResult.final_answer_markdown_path) {
    consoleLog(`final_answer_markdown: ${normalizeRepoPath(runReportResult.final_answer_markdown_path)}`);
  }
}

export function finalizeRun({
  runId,
  prdPath,
  taskResults,
  progressTotal,
  startTimeMs,
  projectRoot,
  stateDir,
  runtimeDir,
  yoloRoot,
  toolsRoot = yoloRoot,
  exitOnComplete,
  writeRunReport,
  logRun,
  logProgress,
  writeStateSnapshot,
  archiveCurrentRun,
  normalizeRepoPath,
  progressServerProc = null,
  processExit = process.exit,
  processKill = process.kill,
  spawnSync = defaultSpawnSync,
  consoleLog = (...args) => console.log(...args),
  now = () => new Date(),
} = {}) {
  const elapsed = ((Date.now() - startTimeMs) / 1000).toFixed(1);
  logRun("run_end", {
    run_id: runId,
    prd: prdPath || "auto",
    passed: taskResults.completed.length,
    failed: taskResults.failed.length,
    duration_sec: elapsed,
  });
  const runReportResult = writeRunReport({
    stateDir,
    runId,
    prdPath,
    taskResults,
    progressTotal,
    startedAt: new Date(startTimeMs).toISOString(),
    finishedAt: now().toISOString(),
    durationSec: elapsed,
    taskLogsDir: join(runtimeDir, "task-logs"),
  });
  printRunReportSummary({
    taskResults,
    progressTotal,
    elapsed,
    reportSummary: runReportResult.report?.summary || {},
    runReportResult,
    normalizeRepoPath,
    consoleLog,
  });
  writeStateSnapshot("run_end", prdPath);
  archiveCurrentRun(runId, taskResults);
  logProgress("RUN", runId, "archived");
  if (progressServerProc?.pid) {
    try { processKill(progressServerProc.pid, "SIGTERM"); } catch (_) {}
  }
  const result = buildRunReturnResult({ runId, prdPath, taskResults, runReportResult, normalizeRepoPath });
  cleanupRunArtifacts({
    yoloRoot,
    toolsRoot,
    projectRoot,
    stateDir,
    runtimeDir,
    prdPath,
    completionStatus: result.status,
    normalizeRepoPath,
    spawnSync,
    consoleLog,
  });
  if (exitOnComplete) processExit(result.exit_code);
  return result;
}
