import {
  copyFileSync as defaultCopyFileSync,
  existsSync as defaultExistsSync,
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  readdirSync as defaultReaddirSync,
  renameSync as defaultRenameSync,
  rmSync as defaultRmSync,
  unlinkSync as defaultUnlinkSync,
  writeFileSync as defaultWriteFileSync,
} from "node:fs";
import { execFileSync as defaultExecFileSync, execSync as defaultExecSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import {
  parseEslintBaselineErrorKeys,
  parseTscBaselineKeys,
} from "../execution/baselines.js";
import { trimJsonlWithArchive } from "../memory/retention.js";

export function createRunnerError(message, exitCode = 1, details = {}) {
  const error = new Error(message);
  error.exitCode = exitCode;
  Object.assign(error, details);
  return error;
}

export function acquireRunnerPidLock({
  pidFile,
  pid,
  exitOnComplete = true,
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
  writeFileSync = defaultWriteFileSync,
  unlinkSync = defaultUnlinkSync,
  processKill = process.kill,
  processExit = process.exit,
  makeError = createRunnerError,
  consoleError = (...args) => console.error(...args),
} = {}) {
  if (existsSync(pidFile)) {
    const oldPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    try {
      processKill(oldPid, 0);
    } catch {
      try { unlinkSync(pidFile); } catch (_) {}
    }
    if (existsSync(pidFile)) {
      consoleError(`[yolo-runner] 另一个 runner 实例正在运行 (PID ${oldPid})。如确认已停止，删除 ${pidFile}`);
      if (exitOnComplete) {
        processExit(1);
        return { acquired: false, pid: oldPid, exited: true };
      }
      throw makeError(`Another runner instance is active (PID ${oldPid})`, 1, {
        code: "RUNNER_ALREADY_ACTIVE",
        pid: oldPid,
      });
    }
  }
  writeFileSync(pidFile, String(pid), "utf8");
  return { acquired: true, pid };
}

export function rotateTaskResults({
  resultsFile,
  existsSync = defaultExistsSync,
  copyFileSync = defaultCopyFileSync,
  unlinkSync = defaultUnlinkSync,
  now = () => new Date(),
  consoleLog = (...args) => console.log(...args),
} = {}) {
  if (!existsSync(resultsFile)) return { rotated: false };
  const bakFile = `${resultsFile.replace(".jsonl", "")}.bak.${now().toISOString().replace(/[-:T]/g, "").slice(0, 15)}`;
  try { copyFileSync(resultsFile, bakFile); } catch (_) {}
  try { unlinkSync(resultsFile); } catch (_) {}
  consoleLog(`[yolo-runner] 已归档上次结果: ${bakFile}`);
  return { rotated: true, bakFile };
}

export function initializeRuntimeState({
  runtimeDir,
  expandedTasksFile,
  existsSync = defaultExistsSync,
  mkdirSync = defaultMkdirSync,
  readdirSync = defaultReaddirSync,
  rmSync = defaultRmSync,
  unlinkSync = defaultUnlinkSync,
  consoleLog = (...args) => console.log(...args),
  consoleError = (...args) => console.error(...args),
} = {}) {
  try {
    if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { recursive: true });
    for (const file of readdirSync(runtimeDir)) {
      try { rmSync(join(runtimeDir, file), { recursive: true, force: true }); } catch (_) {
        try { unlinkSync(join(runtimeDir, file)); } catch (_) {}
      }
    }
    if (existsSync(expandedTasksFile)) {
      try { unlinkSync(expandedTasksFile); } catch (_) {}
    }
    consoleLog("[yolo-runner] state/runtime/ 已初始化");
    return { initialized: true };
  } catch (error) {
    consoleError(`[yolo-runner] state/runtime/ 初始化失败: ${error.message}`);
    return { initialized: false, error };
  }
}

export function truncateJsonlFile({
  filePath,
  maxLines,
  archiveDir,
  now = new Date(),
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
  writeFileSync = defaultWriteFileSync,
  mkdirSync = defaultMkdirSync,
  log = () => {},
} = {}) {
  const result = trimJsonlWithArchive({
    filePath,
    maxLines,
    archiveDir: archiveDir ?? null,
    now,
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
  });
  if (result.status === "missing") return { truncated: false, reason: "missing" };
  if (!result.trimmed) return { truncated: false, lines: result.line_count };
  const archiveNote = result.archive_file ? `, archived ${result.archived}` : "";
  log("CLEANUP", "truncate", `${basename(filePath)}: ${result.before} → ${result.after}${archiveNote}`);
  if (archiveDir) {
    return {
      truncated: true,
      before: result.before,
      after: result.after,
      archived: result.archived,
      archiveFile: result.archive_file,
    };
  }
  return { truncated: true, before: result.before, after: result.after };
}

export function initializeMissingBaselines({
  runtimeDir,
  rootDir,
  config,
  existsSync = defaultExistsSync,
  writeFileSync = defaultWriteFileSync,
  execFileSync = defaultExecFileSync,
  log = () => {},
  nowIso = () => new Date().toISOString(),
} = {}) {
  const initialized = [];
  for (const tool of ["tsc", "eslint"]) {
    const baselinePath = join(runtimeDir, `${tool}-baseline.json`);
    if (existsSync(baselinePath)) continue;
    log("BASELINE", "init", `初始化 ${tool} baseline...`);
    try {
      const command = tool === "tsc"
        ? `${config.build.type_check} 2>&1 || true`
        : `${config.build.lint} 2>&1 || true`;
      const output = execFileSync("sh", ["-c", command], { cwd: rootDir, encoding: "utf8", timeout: 120000 });
      const keys = tool === "tsc"
        ? parseTscBaselineKeys(output)
        : parseEslintBaselineErrorKeys(output, rootDir);
      writeFileSync(baselinePath, JSON.stringify({
        keys,
        meta: { created_at: nowIso(), updated_at: nowIso(), tool },
      }, null, 2), "utf8");
      log("BASELINE", "init", `${tool} baseline: ${keys.length} 个条目`);
      initialized.push({ tool, keys });
    } catch (error) {
      log("BASELINE", "WARN", `${tool} baseline 初始化失败: ${error.message}，跳过`);
    }
  }
  return initialized;
}

export function cleanupStaleGitWorktreesAndBranches({
  rootDir,
  execSync = defaultExecSync,
  consoleLog = (...args) => console.log(...args),
} = {}) {
  const removed = { worktrees: [], branches: [] };
  try {
    const wtList = execSync("git worktree list --porcelain", {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const wtLines = wtList.split("\n").filter((line) => line.startsWith("Worktree "));
    for (const line of wtLines) {
      const wtPath = line.replace("Worktree ", "");
      if (!wtPath.includes(".yolo-worktrees") && !wtPath.includes("yolo-")) continue;
      try {
        execSync(`git worktree remove --force "${wtPath}" 2>/dev/null`, {
          cwd: rootDir,
          stdio: ["ignore", "pipe", "ignore"],
        });
        removed.worktrees.push(wtPath);
        consoleLog(`  清理残留 worktree: ${wtPath}`);
      } catch (_) {}
    }
  } catch (_) {}

  try {
    const branches = execSync('git branch --list "yolo-*"', {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branches) {
      for (const branch of branches.split("\n").map((line) => line.trim()).filter(Boolean)) {
        try {
          execSync(`git branch -D "${branch}" 2>/dev/null`, {
            cwd: rootDir,
            stdio: ["ignore", "pipe", "ignore"],
          });
          removed.branches.push(branch);
          consoleLog(`  清理残留分支: ${branch}`);
        } catch (_) {}
      }
    }
  } catch (_) {}
  return removed;
}

export function cleanupRetryRoundFiles({
  retryDir,
  currentPrdPath,
  existsSync = defaultExistsSync,
  readdirSync = defaultReaddirSync,
  unlinkSync = defaultUnlinkSync,
  consoleLog = (...args) => console.log(...args),
} = {}) {
  const removed = [];
  try {
    if (!existsSync(retryDir)) return removed;
    const currentPrdAbs = resolve(currentPrdPath);
    for (const file of readdirSync(retryDir).filter((name) => name.startsWith("retry-round"))) {
      const filePath = join(retryDir, file);
      if (resolve(filePath) === currentPrdAbs) continue;
      try {
        unlinkSync(filePath);
        removed.push(file);
        consoleLog(`  清理残留文件: ${file}`);
      } catch (_) {}
    }
  } catch (_) {}
  return removed;
}

export function loadResumeCompletedFromPrd({
  prdPath,
  taskCountsAsCompleted,
  readFileSync = defaultReadFileSync,
  writeFileSync = defaultWriteFileSync,
  renameSync = defaultRenameSync,
  consoleLog = (...args) => console.log(...args),
} = {}) {
  try {
    const prd = JSON.parse(readFileSync(prdPath, "utf8"));
    const resumeCompleted = new Set((prd.tasks || []).filter(taskCountsAsCompleted).map((task) => task.id));
    const staleRunning = (prd.tasks || []).filter((task) => task.status === "running");
    if (staleRunning.length > 0) {
      for (const task of staleRunning) task.status = "pending";
      const tmp = `${prdPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(prd, null, 2), "utf8");
      renameSync(tmp, prdPath);
      consoleLog(`[resume] 重置 ${staleRunning.length} 个中断任务: ${staleRunning.map((task) => task.id).join(", ")}`);
    }
    consoleLog(`[resume] PRD 中已完成: ${resumeCompleted.size} 个任务`);
    return resumeCompleted;
  } catch (_) {
    return new Set();
  }
}

export function prepareRunStartup({
  runId,
  prdPath,
  paths,
  config,
  rootDir,
  yoloRoot,
  exitOnComplete,
  pid = process.pid,
  taskCountsAsCompleted,
  initTaskLogs = () => {},
  writeCurrentRun = () => {},
  startProgressApiServer = () => {},
  initializeBaselines = true,
  logProgress = () => {},
  runnerError = createRunnerError,
  processKill = process.kill,
  processExit = process.exit,
} = {}) {
  acquireRunnerPidLock({
    pidFile: join(paths.stateDir, "runner.pid"),
    pid,
    exitOnComplete,
    makeError: runnerError,
    processKill,
    processExit,
  });
  rotateTaskResults({ resultsFile: paths.resultsFile });
  initializeRuntimeState({ runtimeDir: paths.runtimeDir, expandedTasksFile: paths.expandedTasksFile });
  initTaskLogs({ runId });
  const archiveDir = join(paths.stateDir, "archive", "jsonl", new Date().toISOString().slice(0, 7));
  truncateJsonlFile({ filePath: join(paths.stateDir, "events.jsonl"), maxLines: config.state.max_events, archiveDir, log: logProgress });
  truncateJsonlFile({ filePath: join(paths.stateDir, "changes.jsonl"), maxLines: config.state.max_changes, archiveDir, log: logProgress });
  truncateJsonlFile({ filePath: join(paths.stateDir, "runs.jsonl"), maxLines: config.state.max_runs, archiveDir, log: logProgress });
  truncateJsonlFile({ filePath: join(paths.stateDir, "learning.jsonl"), maxLines: config.state.max_learning || 500, archiveDir, log: logProgress });
  truncateJsonlFile({ filePath: join(paths.stateDir, "session-memory.jsonl"), maxLines: config.state.max_session_memory || 200, archiveDir, log: logProgress });
  try { defaultWriteFileSync(join(paths.runtimeDir, "learn-stats.json"), "{}", "utf8"); } catch (_) {}
  if (initializeBaselines) {
    initializeMissingBaselines({ runtimeDir: paths.runtimeDir, rootDir, config, log: logProgress });
  }
  const reviewLogPath = join(paths.stateDir, "review-log.jsonl");
  if (defaultExistsSync(reviewLogPath)) {
    defaultWriteFileSync(reviewLogPath, "", "utf8");
    console.log("[yolo-runner] 已清理 review-log.jsonl");
  }
  writeCurrentRun(runId, prdPath);
  logProgress("RUN", runId, "started");
  startProgressApiServer(config.progress_server.port);
  cleanupStaleGitWorktreesAndBranches({ rootDir });
  cleanupRetryRoundFiles({ retryDir: join(yoloRoot, "data"), currentPrdPath: prdPath });
  return loadResumeCompletedFromPrd({ prdPath, taskCountsAsCompleted });
}
