import {
  closeSync as defaultCloseSync,
  copyFileSync as defaultCopyFileSync,
  existsSync as defaultExistsSync,
  mkdirSync as defaultMkdirSync,
  openSync as defaultOpenSync,
  readFileSync as defaultReadFileSync,
  readdirSync as defaultReaddirSync,
  renameSync as defaultRenameSync,
  rmSync as defaultRmSync,
  statSync as defaultStatSync,
  unlinkSync as defaultUnlinkSync,
  writeFileSync as defaultWriteFileSync,
  writeSync as defaultWriteSync,
} from "node:fs";
import { basename, delimiter, join, resolve, sep } from "node:path";
import {
  BASELINE_KINDS,
  baselineFileName,
  buildBaselineArtifact,
  snapshotCommandOutput,
} from "../execution/baselines.js";
import { trimJsonlWithArchive } from "../memory/retention.js";
import { safeExecFileSync as defaultExecFileSync } from "../../lib/security/safe-exec.js";
import { parseCommandToArgv } from "../../lib/security/command-guard.js";
import { readJsonFileBounded } from "../../lib/bounded-read.js";
import { resolveBuildCommand, resolveGateTimeout } from "../../lib/toolchain.js";
import { writeLifecycleStageReport } from "../../lifecycle/progress.js";

export function createRunnerError(message, exitCode = 1, details = Object()) {
  const error = Object.assign(new Error(message), { exitCode }, details);
  return error;
}

export const RUN_INITIAL_COMMIT_MESSAGE = "chore(yolo): initial commit for run baseline";
export const RUNNER_BASELINE_SOURCE = "runner-baseline";

function describeCommandFailure(error) {
  const stderr = String(error?.stderr || "").trim();
  const stdout = String(error?.stdout || "").trim();
  return stderr || stdout || error?.message || String(error);
}

function runGit(rootDir, args, { execFileSync = defaultExecFileSync, env = process.env } = Object()) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env,
  }).trim();
}

export function ensureRunGitBaseline({
  rootDir,
  execFileSync = defaultExecFileSync,
  consoleLog = (...args) => console.log(...args),
  runnerError = createRunnerError,
  commitMessage = RUN_INITIAL_COMMIT_MESSAGE,
} = Object()) {
  let insideGitWorkTree = false;
  try {
    insideGitWorkTree = runGit(rootDir, ["rev-parse", "--is-inside-work-tree"], { execFileSync }) === "true";
  } catch {
    return { status: "skipped", reason: "not_git_worktree" };
  }
  if (!insideGitWorkTree) return { status: "skipped", reason: "not_git_worktree" };

  try {
    const commit = runGit(rootDir, ["rev-parse", "--verify", "HEAD"], { execFileSync });
    return { status: "ready", commit };
  } catch (headError) {
    let commitCount = 0;
    try {
      commitCount = Number(runGit(rootDir, ["rev-list", "--count", "--all"], { execFileSync }) || "0");
    } catch (historyError) {
      throw runnerError("Unable to inspect git history before yolo run baseline", 1, {
        code: "GIT_HISTORY_UNAVAILABLE",
        detail: describeCommandFailure(historyError),
        head_detail: describeCommandFailure(headError),
      });
    }

    if (commitCount > 0) {
      throw runnerError("Git repository has commits but HEAD is unavailable before yolo run", 1, {
        code: "GIT_HEAD_UNAVAILABLE",
        detail: describeCommandFailure(headError),
      });
    }
  }

  consoleLog("[yolo-runner] 检测到 git 仓库尚无 HEAD；yolo 将暂存当前项目状态并创建初始 commit 作为 run baseline。");
  const commitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "YOLO Runner",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "yolo-runner@example.invalid",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "YOLO Runner",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "yolo-runner@example.invalid",
  };
  try {
    runGit(rootDir, ["add", "-A"], { execFileSync, env: commitEnv });
    runGit(rootDir, ["commit", "--allow-empty", "-m", commitMessage], { execFileSync, env: commitEnv });
  } catch (error) {
    throw runnerError("Unable to create initial git commit for yolo run baseline", 1, {
      code: "GIT_INITIAL_COMMIT_FAILED",
      detail: describeCommandFailure(error),
    });
  }

  const commit = runGit(rootDir, ["rev-parse", "--verify", "HEAD"], { execFileSync });
  consoleLog(`[yolo-runner] yolo 已创建初始 commit ${commit.slice(0, 12)}: ${commitMessage}`);
  return { status: "created", commit, message: commitMessage };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function refreshCheckSnapshotAfterRunnerBaseline({
  rootDir,
  stateRoot,
  commit,
  commitMessage = RUN_INITIAL_COMMIT_MESSAGE,
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
  writeStageReport = writeLifecycleStageReport,
  now = () => new Date().toISOString(),
  consoleLog = (...args) => console.log(...args),
} = Object()) {
  const commitHash = String(commit || "").trim();
  if (!commitHash) return { status: "not_applicable", reason: "missing_commit" };
  const checkReportPath = join(stateRoot, "lifecycle", "check-report.json");
  if (!existsSync(checkReportPath)) return { status: "not_applicable", reason: "missing_check_report", commit: commitHash };

  let artifact;
  try {
    artifact = JSON.parse(readFileSync(checkReportPath, "utf8"));
  } catch (error) {
    return {
      status: "not_applicable",
      reason: "unreadable_check_report",
      commit: commitHash,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const rawReport = artifact?.report && typeof artifact.report === "object" && !Array.isArray(artifact.report)
    ? artifact.report
    : artifact;
  const refreshedAt = now();
  const report = {
    ...cloneJson(rawReport || {}),
    runner_baseline_commit_hash: commitHash,
    runner_baseline_transition: {
      source: RUNNER_BASELINE_SOURCE,
      commit_hash: commitHash,
      message: commitMessage,
      refreshed_at: refreshedAt,
    },
  };

  const write = writeStageReport("check", report, {
    projectRoot: rootDir,
    stateRoot,
    source: RUNNER_BASELINE_SOURCE,
    runnerBaselineCommit: commitHash,
    writeSessionMemory: false,
    skipSequenceCheck: true,
    now: refreshedAt,
  });
  consoleLog(`[yolo-runner] 已刷新 check source snapshot for baseline ${commitHash.slice(0, 12)}`);
  return {
    status: "refreshed",
    commit: commitHash,
    check_report_path: write.artifact_path,
    source_snapshot: write.source_snapshot,
  };
}

function baselineCommandEnv(rootDir) {
  const localBin = join(rootDir, "node_modules", ".bin");
  return {
    ...process.env,
    PATH: [localBin, process.env.PATH || ""].filter(Boolean).join(delimiter),
  };
}

export function acquireRunnerPidLock({
  pidFile,
  pid,
  exitOnComplete = true,
  readFileSync = defaultReadFileSync,
  openSync = defaultOpenSync,
  writeSync = defaultWriteSync,
  closeSync = defaultCloseSync,
  unlinkSync = defaultUnlinkSync,
  processKill = process.kill,
  processExit = process.exit,
  makeError = createRunnerError,
  consoleError = (...args) => console.error(...args),
} = Object()) {
  // P9.H1: claim the pid file atomically with O_EXCL (openSync "wx") so two
  // runners cannot both pass an existsSync check and then race on the write —
  // the TOCTOU that let two runners both "acquire" the lock (verified: two
  // acquires both returned acquired:true and wrote [111,222]). openSync("wx")
  // either creates the file exclusively or throws EEXIST.
  const tryCreate = () => {
    const fd = openSync(pidFile, "wx");
    writeSync(fd, String(pid));
    closeSync(fd);
  };

  const rejectActive = (oldPid) => {
    consoleError(`[yolo-runner] 另一个 runner 实例正在运行 (PID ${oldPid})。如确认已停止，删除 ${pidFile}`);
    if (exitOnComplete) {
      processExit(1);
      return { acquired: false, pid: oldPid, exited: true };
    }
    throw makeError(`Another runner instance is active (PID ${oldPid})`, 1, {
      code: "RUNNER_ALREADY_ACTIVE",
      pid: oldPid,
    });
  };

  // Fast path: exclusive create succeeds when no pid file exists yet.
  try {
    tryCreate();
    return { acquired: true, pid };
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
  }

  // pid file exists — read the owner and check whether it is alive.
  let oldPid = NaN;
  try {
    oldPid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  } catch (_) {
    return rejectActive(oldPid);
  }
  try {
    processKill(oldPid, 0);
    return rejectActive(oldPid);
  } catch (_) {
    // owner is dead — fall through to takeover
  }

  // Stale lock from a dead process: remove it and retry the exclusive create
  // once. If another runner grabbed it in the gap, fail as already-active.
  try { unlinkSync(pidFile); } catch (_) {}
  try {
    tryCreate();
    return { acquired: true, pid };
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    return rejectActive(oldPid);
  }
}

export function rotateTaskResults({
  resultsFile,
  existsSync = defaultExistsSync,
  copyFileSync = defaultCopyFileSync,
  unlinkSync = defaultUnlinkSync,
  now = () => new Date(),
  consoleLog = (...args) => console.log(...args),
  consoleError = (...args) => console.error(...args),
} = Object()) {
  if (!existsSync(resultsFile)) return { rotated: false };
  const bakFile = `${resultsFile.replace(".jsonl", "")}.bak.${now().toISOString().replace(/[-:T]/g, "").slice(0, 15)}`;
  // L3: previously both ops swallowed errors with empty catches, and a failed
  // copy was followed by an unlink — silently dropping the previous results
  // with no backup. Track each op's outcome and only unlink after a successful
  // copy; surface partial failures instead of masking them.
  let copyError: unknown = null;
  try {
    copyFileSync(resultsFile, bakFile);
  } catch (error) {
    copyError = error;
  }
  if (copyError) {
    // Backup failed — do NOT delete the original (would lose results with no archive).
    consoleError(`[yolo-runner] 归档失败:无法复制 ${resultsFile} -> ${bakFile}: ${copyError instanceof Error ? copyError.message : String(copyError)}; 保留原文件`);
    return { rotated: false, bakFile: null, copyError: copyError instanceof Error ? copyError.message : String(copyError) };
  }
  let unlinkError: unknown = null;
  try {
    unlinkSync(resultsFile);
  } catch (error) {
    unlinkError = error;
  }
  if (unlinkError) {
    // Copy succeeded but original still present — non-fatal, but surface it.
    consoleError(`[yolo-runner] 归档警告:已备份到 ${bakFile} 但无法删除原文件 ${resultsFile}: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`);
    consoleLog(`[yolo-runner] 已归档上次结果: ${bakFile} (原文件保留)`);
    return { rotated: true, bakFile, unlinkError: unlinkError instanceof Error ? unlinkError.message : String(unlinkError) };
  }
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
} = Object()) {
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
  log = (..._args) => {},
} = Object()) {
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
  log = (..._args) => {},
  nowIso = () => new Date().toISOString(),
} = Object()) {
  const initialized = [];
  for (const kind of BASELINE_KINDS) {
    const baselinePath = join(runtimeDir, baselineFileName(kind));
    if (existsSync(baselinePath)) continue;
    log("BASELINE", "init", `初始化 ${kind} baseline...`);
    try {
      const rawCommand = resolveBuildCommand(kind, config, rootDir);
      if (!rawCommand) {
        const createdAt = nowIso();
        const baseline = buildBaselineArtifact({
          tool: kind,
          keys: [],
          command: rawCommand,
          exitCode: 0,
          stdout: "",
          stderr: "",
          status: "skipped",
          reason: "baseline_command_not_configured",
          createdAt,
          updatedAt: createdAt,
        });
        writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), "utf8");
        log("BASELINE", "skip", `${kind} baseline: 未配置命令，跳过`);
        initialized.push({ kind, tool: kind, keys: [], status: "skipped", skipped: true, blocked: false, baseline });
        continue;
      }
      // P12.I1: parse config command to argv, route through execFileSync DI
      // (default = safeExecFileSync, no shell). Rejects metacharacters at parse.
      const parsed = parseCommandToArgv(rawCommand);
      let output = "";
      let stderr = "";
      let exitCode = 0;
      let status = "pass";
      let reason = null;
      if (!parsed.ok) {
        output = `command rejected: ${parsed.detail}`;
        stderr = output;
        exitCode = 127;
        status = "blocked";
        reason = "baseline_command_rejected";
      } else {
        const argv = parsed.argv ?? [];
        try {
          const stdout = execFileSync(argv[0], argv.slice(1), {
            cwd: rootDir,
            encoding: "utf8",
            timeout: resolveGateTimeout(kind, config),
            env: baselineCommandEnv(rootDir),
          });
          output = String(stdout || "");
        } catch (error) {
          output = `${String(error?.stdout || "")}${String(error?.stderr || "")}`;
          stderr = String(error?.stderr || error?.message || "");
          exitCode = Number.isInteger(error?.status) ? error.status : (Number.isInteger(error?.code) ? error.code : 1);
          const blocked = Boolean(error?.signal) ||
            exitCode === 127 ||
            /\bnot found\b|is not recognized|command not found/i.test(output) ||
            !output.trim();
          if (blocked) {
            status = "blocked";
            reason = error?.signal ? "baseline_command_timeout_or_signal" : "baseline_command_unavailable";
          }
        }
      }
      const keys = output.trim() ? snapshotCommandOutput(output, config) : [];
      const createdAt = nowIso();
      const baseline = buildBaselineArtifact({
        tool: kind,
        keys,
        command: rawCommand,
        exitCode,
        stdout: output,
        stderr,
        status,
        reason,
        createdAt,
        updatedAt: createdAt,
      });
      writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), "utf8");
      log("BASELINE", status === "blocked" ? "BLOCK" : "init", `${kind} baseline: ${keys.length} 个条目`);
      initialized.push({ kind, tool: kind, keys, status, blocked: status === "blocked", baseline });
    } catch (error) {
      const createdAt = nowIso();
      const baseline = buildBaselineArtifact({
        tool: kind,
        keys: [],
        command: kind === "type_check" ? config.build?.type_check || "" : config.build?.lint || "",
        exitCode: 1,
        stderr: error?.message || String(error),
        status: "blocked",
        reason: "baseline_capture_exception",
        createdAt,
        updatedAt: createdAt,
      });
      try { writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), "utf8"); } catch (_) {}
      log("BASELINE", "BLOCK", `${kind} baseline 初始化失败: ${error.message}`);
      initialized.push({ kind, tool: kind, keys: [], status: "blocked", blocked: true, error: error.message, baseline });
    }
  }
  return initialized;
}

export function cleanupStaleGitWorktreesAndBranches({
  rootDir,
  worktreeRoot = null,
  execFileSync = defaultExecFileSync,
  consoleLog = (...args) => console.log(...args),
} = Object()) {
  const removed = { worktrees: [], branches: [] };

  // P9.M4: only touch worktrees (and the branches checked out in them) that live
  // under THIS run's worktreeRoot. The previous blanket "yolo-*" sweep deleted
  // another runner's active worktree/branch when two runners shared a repo.
  // H1's PID lock prevents concurrent same-repo runners; this is the
  // defense-in-depth that keeps cleanup out of unrelated yolo-* state.
  const wtRootResolved = worktreeRoot ? resolve(worktreeRoot) : null;
  const isYoloPath = (wtPath) => wtPath.includes(".yolo-worktrees") || wtPath.includes("yolo-");
  const isUnderRoot = (wtPath) => {
    if (!wtRootResolved) return true;
    const resolved = resolve(wtPath);
    return resolved === wtRootResolved || resolved.startsWith(`${wtRootResolved}${sep}`);
  };

  const ownedWorktrees = [];
  const ownedBranches = [];
  try {
    const wtList = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let curPath = null;
    let curBranch = null;
    const flush = () => {
      if (curPath && isYoloPath(curPath) && isUnderRoot(curPath)) {
        ownedWorktrees.push(curPath);
        if (curBranch) ownedBranches.push(curBranch);
      }
    };
    for (const rawLine of wtList.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("Worktree ")) {
        flush();
        curPath = line.slice("Worktree ".length).trim();
        curBranch = null;
      } else if (line.startsWith("branch ")) {
        curBranch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      }
    }
    flush();
  } catch (_) {}

  for (const wtPath of ownedWorktrees) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", wtPath], {
        cwd: rootDir,
        stdio: ["ignore", "pipe", "ignore"],
      });
      removed.worktrees.push(wtPath);
      consoleLog(`  清理残留 worktree: ${wtPath}`);
    } catch (_) {}
  }

  for (const branch of ownedBranches) {
    try {
      execFileSync("git", ["branch", "-D", branch], {
        cwd: rootDir,
        stdio: ["ignore", "pipe", "ignore"],
      });
      removed.branches.push(branch);
      consoleLog(`  清理残留分支: ${branch}`);
    } catch (_) {}
  }
  return removed;
}

export function cleanupRetryRoundFiles({
  retryDir,
  currentPrdPath,
  existsSync = defaultExistsSync,
  readdirSync = defaultReaddirSync,
  unlinkSync = defaultUnlinkSync,
  consoleLog = (...args) => console.log(...args),
} = Object()) {
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
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
  statSync = defaultStatSync,
  writeFileSync = defaultWriteFileSync,
  renameSync = defaultRenameSync,
  consoleLog = (...args) => console.log(...args),
} = Object()) {
  // Fresh run: no PRD yet — there is nothing to resume from, an empty set is correct.
  if (!existsSync(prdPath)) {
    return new Set();
  }
  // PRD exists. A parse failure means the PRD is corrupt; fail closed (surface the
  // error) instead of silently returning an empty set, which would mark every prior
  // completion as undone and rerun the whole plan (A3 silent-failure family).
  const prd = readJsonFileBounded(prdPath, {
    readFile: readFileSync,
    statFile: statSync,
    errorCode: "PRD_JSON_SIZE_LIMIT_EXCEEDED",
  });
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
  initTaskLogs = (..._args) => {},
  writeCurrentRun = (..._args) => {},
  startProgressApiServer = (..._args) => {},
  setProgressServerProc = (..._args) => {},
  initializeBaselines = true,
  logProgress = (..._args) => {},
  execFileSync = defaultExecFileSync,
  consoleLog = (...args) => console.log(...args),
  runnerError = createRunnerError,
  processKill = process.kill,
  processExit = process.exit,
} = Object()) {
  const gitBaseline = ensureRunGitBaseline({ rootDir, execFileSync, consoleLog, runnerError });
  if (gitBaseline.status === "created") {
    refreshCheckSnapshotAfterRunnerBaseline({
      rootDir,
      stateRoot: yoloRoot,
      commit: gitBaseline.commit,
      commitMessage: gitBaseline.message,
      consoleLog,
    });
  }
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
    const baselineResults = initializeMissingBaselines({ runtimeDir: paths.runtimeDir, rootDir, config, log: logProgress });
    const blockedBaselines = baselineResults.filter((result) => result.blocked);
    if (blockedBaselines.length > 0) {
      throw runnerError("Required baseline initialization failed", 1, {
        code: "BASELINE_INITIALIZATION_BLOCKED",
        baselines: blockedBaselines.map(({ tool, status, error }) => ({ tool, status, error: error || null })),
      });
    }
  }
  const reviewLogPath = join(paths.stateDir, "review-log.jsonl");
  if (defaultExistsSync(reviewLogPath)) {
    defaultWriteFileSync(reviewLogPath, "", "utf8");
    console.log("[yolo-runner] 已清理 review-log.jsonl");
  }
  writeCurrentRun(runId, prdPath);
  logProgress("RUN", runId, "started");
  const progressServerProc = startProgressApiServer(config.progress_server.port) || null;
  setProgressServerProc(progressServerProc);
  // P9.M4: scope cleanup to this run's worktree root (same convention as
  // resolveRunnerContext) so a shared repo's other yolo-* state is not swept.
  cleanupStaleGitWorktreesAndBranches({ rootDir, worktreeRoot: join(rootDir, "..", ".yolo-worktrees"), execFileSync });
  cleanupRetryRoundFiles({ retryDir: join(yoloRoot, "data"), currentPrdPath: prdPath });
  return loadResumeCompletedFromPrd({ prdPath, taskCountsAsCompleted });
}
