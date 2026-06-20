#!/usr/bin/env node
// YOLO Runner — PRD Contract v2.0 契约引擎 + narrower 重试 + WARN→FAIL 升级
// 仅支持 PRD Contract v2.0 (scope + pre_conditions + post_conditions); 用法: node runner.js [prd.json] [--mode=dev] [--reset]
// PRD 路径可选，不传则自动找 scripts/yolo/ 下最新的 PRD JSON
import { appendFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { config } from "../lib/config.js";
import { ensureCanonicalDirs, yoloPath } from "../lib/paths.js";
import { detectModelProvider as detectProvider } from "./adapters/provider-doctor.js";
import { evaluatePostConditions, setContractRoot } from "../prd/contract.js";
import { inspectPreExecutionGates } from "./gates/pre-execution-gates.js";
import { appendRunEvent, appendStateEvent } from "./evidence/ledger.js";
import { writeRunReport } from "./evidence/report.js";
import { appendTaskResult, updatePrdTaskStatusFile } from "./task-state/writers.js";
import { applyTaskTransition } from "./task-state/transitions.js";
import { writeProgressSnapshot } from "./task-loop/side-effects.js";
import { runMainLoopWithRuntime } from "./task-loop/main-loop.js";
import { runTaskWithRuntime } from "./task-loop/task-runner.js";
import { applySplitSuggestionsToPrd as applySplitSuggestionsToPrdFile } from "./task-loop/split-application.js";
import {
  archiveCurrentRunFile,
  cleanupRuntimeStateFiles,
  writeCurrentRunFile,
} from "./run-lifecycle/state-files.js";
import { resolveRunnerCliArgs } from "./run-lifecycle/prd-discovery.js";
import { prepareRunStartup } from "./run-lifecycle/startup.js";
import { runTaskPipeline } from "./run-lifecycle/run-orchestrator.js";
import {
  applyRunnerContextSideEffects,
  createRunnerLifecycleState,
  resolveRunnerContext,
} from "./run-lifecycle/context.js";
import { createRunnerProgressLogger } from "./run-lifecycle/progress-log.js";
import { handleRunCliFailure, registerRunnerProcessHandlers } from "./run-lifecycle/process-handlers.js";
import {
  createRunnerLedgerWriters,
  writeRunnerRecoveryCheckpoint as writeRunnerRecoveryCheckpointImpl,
  writeRunnerStateSnapshot,
} from "./run-lifecycle/recovery-checkpoints.js";
import { createRunnerTimeoutController } from "./run-lifecycle/shutdown.js";
import { decidePreExecutionOutcome } from "./run-lifecycle/pre-execution-outcome.js";
import { inspectLifecycleGuard } from "../lifecycle/guard.js";
import {
  createRunnerWorktreeHandlers,
  detectRunnerModelProvider,
  refreshRunnerBaselinesAfterCommit,
  runRunnerGateInWorktree,
} from "./run-lifecycle/task-runtime-bindings.js";
import {
  appendUnique,
  computeTaskTimeout,
  createRunnerError,
  execNodeScript,
  killTree,
  loadRunnerPrd,
  normalizeRepoPath as normalizeRepoPathForRoot,
  shouldRunPrecheck,
  taskCountsAsCompleted,
  taskIsSplitParent,
  withExecutionConfig,
} from "./runner-core-helpers.js";
import { spawnProviderPrompt } from "./execution/provider-adapter.js";
import { refreshBaselineAfterCommit } from "./execution/baselines.js";
import { applyScopeAudit, runTaskCommitFlow } from "./execution/commit-flow.js";
import { buildCommitChangeContext } from "./execution/change-set.js";
import {
  cleanupTaskWorktree,
  createTaskWorktree,
  isFileAllowedByScope,
} from "./execution/worktree-session.js";
import { taskForValidSkipPostconditions } from "./execution/post-precheck.js";
import {
  initTaskLogs,
  setTaskLogsDir,
  logTaskStart,
  logTaskBash,
  logTaskGate,
  logTaskFix,
  logTaskError,
  logTaskDone,
  logReviewStart,
  logReviewGate,
  logReviewIssue,
  logReviewDone,
  logReviewError,
} from "./logging/task-logger.js";
import { startEmbeddedProgressServer } from "./progress/embedded-server.js";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(MODULE_DIR, "../..");
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
let globalMode = "fix";
let runnerContext = resolveRunnerContext({ projectRoot: resolve(PACKAGE_ROOT, config.project.root), stateRoot: PACKAGE_ROOT }, { packageRoot: PACKAGE_ROOT, config, yoloPath });
let ROOT = runnerContext.rootDir, STATE_ROOT = runnerContext.stateRoot;
setContractRoot(ROOT);
let runtimeConfig = config;
let STATE_DIR = runnerContext.stateDir;
let RUNTIME_DIR = runnerContext.runtimeDir;
let TSC_BASELINE = runnerContext.tscBaselinePath, ESLINT_BASELINE = runnerContext.eslintBaselinePath;
let RESULTS_FILE = runnerContext.resultsFile;
let WORKTREE_ROOT = runnerContext.worktreeRoot;
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
const MAX_REVIEW_ROUNDS = 5;
const MAX_REVIEW_TASKS_PER_ROUND = config.runner.max_review_tasks_per_round ?? 5;
const startTime = Date.now();
const progress = { total: 0, done: 0, failed: 0 };
let CURRENT_RUN_FILE = runnerContext.currentRunFile, EXPANDED_TASKS_FILE = runnerContext.expandedTasksFile, OUTPUT_LOG = runnerContext.outputLog, activeRunId = null;
process.env.YOLO_LOOP = "1";

function applyRunnerContext(options = Object(), cfg = runtimeConfig) {
  runnerContext = resolveRunnerContext(options, { packageRoot: PACKAGE_ROOT, config: cfg, yoloPath });
  ROOT = runnerContext.rootDir;
  STATE_ROOT = runnerContext.stateRoot;
  STATE_DIR = runnerContext.stateDir;
  RUNTIME_DIR = runnerContext.runtimeDir;
  TSC_BASELINE = runnerContext.tscBaselinePath;
  ESLINT_BASELINE = runnerContext.eslintBaselinePath;
  RESULTS_FILE = runnerContext.resultsFile;
  WORKTREE_ROOT = runnerContext.worktreeRoot;
  CURRENT_RUN_FILE = runnerContext.currentRunFile;
  EXPANDED_TASKS_FILE = runnerContext.expandedTasksFile;
  OUTPUT_LOG = runnerContext.outputLog;
  applyRunnerContextSideEffects(runnerContext, { ensureCanonicalDirs, setContractRoot, setTaskLogsDir });
}

// ── state 日志函数 ──────────────────────────────────────

const runnerLedgerWriters = createRunnerLedgerWriters({
  getStateDir: () => STATE_DIR,
  getRunId: () => activeRunId,
  appendStateEvent,
  appendRunEvent,
});
const { logEvent, logRun } = runnerLedgerWriters;

function writeStateSnapshot(reason, prdPath = null) {
  writeRunnerStateSnapshot({
    reason,
    prdPath,
    packageRoot: PACKAGE_ROOT, stateRoot: STATE_ROOT,
    rootDir: ROOT,
    normalizeRepoPath: normalizeRepoPathForRoot,
    spawnSync,
    processExecPath: process.execPath,
  });
}

function writeRunnerRecoveryCheckpoint(reason, prdPath, taskId, update = Object()) {
  writeRunnerRecoveryCheckpointImpl({
    reason,
    prdPath,
    taskId,
    update,
    packageRoot: PACKAGE_ROOT,
    stateRoot: STATE_ROOT,
    rootDir: ROOT,
    normalizeRepoPath: normalizeRepoPathForRoot,
    spawnSync,
    processExecPath: process.execPath,
  });
}

// ── 工具函数 ────────────────────────────────────────────────────
const logP = createRunnerProgressLogger({
  progress,
  startTimeMs: startTime,
  getOutputLog: () => OUTPUT_LOG,
  appendFileSync,
});

function loadPRD(prdPath) {
  try {
    return loadRunnerPrd(prdPath, { runnerError });
  } catch (error) {
    console.error(error.message);
    throw error;
  }
}

function detectModelProvider() {
  return detectRunnerModelProvider({ config: runtimeConfig, execSync, detectProvider });
}

function applySplitSuggestionsToPrd(prdPath, parentTask, doctor) {
  return applySplitSuggestionsToPrdFile({
    prdPath,
    parentTask,
    doctor,
    yoloRoot: STATE_ROOT,
    projectRoot: ROOT,
    writeRecoveryCheckpoint: writeRunnerRecoveryCheckpoint,
  });
}

function spawnProvider(prompt, timeout = runtimeConfig.ai.timeout_ms, { cwd: cwdPath } = Object()) {
  return spawnProviderPrompt(prompt, {
    timeout,
    cwd: cwdPath || ROOT,
    config: runtimeConfig,
    rootDir: ROOT,
    runtimeDir: RUNTIME_DIR,
    detectModelProvider,
    killTree,
  });
}

// ── Worktree 管理 ──────────────────────────────────────────────────

function createWorktree(taskId) {
  return runnerWorktreeHandlers.createWorktree(taskId);
}

function cleanupWorktree(wtPath, wtBranch, mergeToMain = false, allowedScope = [], baseRef = null) {
  return runnerWorktreeHandlers.cleanupWorktree(wtPath, wtBranch, mergeToMain, allowedScope, baseRef);
}

function spawnClaudeInWorktree(prompt, wtPath, timeout = runtimeConfig.ai.timeout_ms) {
  return spawnProvider(prompt, timeout, { cwd: wtPath });
}

function runGateInWorktree(taskId, prdPath, wtPath, mode) {
  return runRunnerGateInWorktree({
    taskId,
    prdPath,
    wtPath,
    mode,
    packageRoot: PACKAGE_ROOT,
    stateRoot: STATE_ROOT,
    runtimeDir: RUNTIME_DIR,
    rootDir: ROOT,
    spawnSync,
  });
}

// ── commitTask ──────────────────────────────────────────────────
function refreshBaselinesAfterCommit() {
  return refreshRunnerBaselinesAfterCommit({
    rootDir: ROOT,
    runtimeDir: RUNTIME_DIR,
    config: runtimeConfig,
    refreshBaselineAfterCommit,
    log: logP,
  });
}

async function commitTask(task, prdPath, worktreeFiles = null) {
  const {
    code,
    businessFiles,
    metadataFiles,
    hasRealCode,
    auditTargets,
    outOfScope,
  } = buildCommitChangeContext({
    rootDir: ROOT,
    task,
    worktreeFiles,
    isFileAllowedByScope,
    config: runtimeConfig,
  });
  applyScopeAudit({
    auditPath: join(RUNTIME_DIR, "task-audit.jsonl"),
    task,
    outOfScope,
    targetFiles: auditTargets,
    modified: code,
    log: logP,
  });
  const commitFlow = await runTaskCommitFlow({
    rootDir: ROOT,
    task,
    code,
    hasRealCode,
    businessFiles,
    metadataFiles,
    outOfScope,
    mode: globalMode,
    log: logP,
    emitEvent: logEvent,
    refreshBaselines: refreshBaselinesAfterCommit,
  });
  return { ...commitFlow.result, code };
}

// ── PRD 任务状态更新（单源真相：PRD 文件本身）────────────────────
function updatePrdTaskStatus(prdPath, taskId, update) {
  const result = updatePrdTaskStatusFile(prdPath, taskId, update);
  if (result.wrote) {
    writeRunnerRecoveryCheckpoint(`task_status_${taskId}`, prdPath, taskId, update);
  }
}

function writeTaskResult(record) {
  return appendTaskResult(RESULTS_FILE, record, {
    runId: activeRunId,
    workspaceRoot: ROOT,
    allowInitialAttempt: true,
  });
}

function recordTaskTransition(prdPath, transition) {
  return applyTaskTransition(transition, {
    writeTaskResult,
    updatePrdTaskStatus: (taskId, update) => updatePrdTaskStatus(prdPath, taskId, update),
  });
}

function taskPostconditionsPass(task, prd, contractRoot = ROOT, options = Object()) {
  try {
    setContractRoot(contractRoot);
    const result = evaluatePostConditions(task, prd, {
      root: contractRoot,
      config: runtimeConfig,
      changedFiles: options.changedFiles || options.changed_files,
    });
    const blocking = (result.results || []).filter((item) => item.severity === "FAIL" && item.passed === false);
    return {
      passed: blocking.length === 0,
      failed: blocking.map((item) => `${item.id || item.type}: ${item.detail || "failed"}`),
    };
  } finally {
    setContractRoot(ROOT);
  }
}

function skippedTaskPostconditionsPass(task, prd) {
  return taskPostconditionsPass(taskForValidSkipPostconditions(task), prd);
}

async function runTask(task, prdPath) {
  return runTaskWithRuntime({
    task,
    prdPath,
    config: runtimeConfig,
    mode: globalMode,
    stateRoot: STATE_ROOT,
    projectRoot: ROOT,
    runtimeDir: RUNTIME_DIR,
    tscBaselinePath: TSC_BASELINE,
    eslintBaselinePath: ESLINT_BASELINE,
    execNode: (script, args, timeout) => execNodeScript(script, args, { toolsRoot: PACKAGE_ROOT, cwd: ROOT, timeout }),
    loadPRD,
    shouldRunPrecheck,
    skippedTaskPostconditionsPass,
    taskPostconditionsPass,
    commitTask,
    recordTaskTransition: (transition) => recordTaskTransition(prdPath, transition),
    writeTaskResult,
    updatePrdTaskStatus: (taskId, update) => updatePrdTaskStatus(prdPath, taskId, update),
    applySplitSuggestionsToPrd,
    createWorktree,
    computeTaskTimeout: (targets, options = Object()) => computeTaskTimeout(targets, { ...options, rootDir: options.rootDir || ROOT, config: options.config || runtimeConfig }),
    spawnProviderInWorktree: spawnClaudeInWorktree,
    cleanupWorktree,
    runGateInWorktree,
      logEvent,
    logProgress: logP,
    logTaskStart,
    logTaskBash,
    logTaskGate,
    logTaskFix,
    logTaskError,
    logTaskDone,
  });
}

async function mainLoop(prdPath, preCompleted = new Set()) {
  return runMainLoopWithRuntime({
    prdPath,
    preCompleted,
    mode: globalMode,
    rootDir: ROOT,
    yoloRoot: PACKAGE_ROOT,
    expandedTasksFile: EXPANDED_TASKS_FILE,
    progress,
    runResultsTracker,
    priorityOrder: PRIORITY_ORDER,
    loadPRD,
    runTask,
    updateTaskStatus: (taskId, update) => updatePrdTaskStatus(prdPath, taskId, update),
    recordTaskTransition: (transition) => recordTaskTransition(prdPath, transition),
    taskCountsAsCompleted,
    taskIsSplitParent,
    skippedTaskPostconditionsPass,
    log: (id, phase, detail) => logP(id, phase, detail),
  });
}

// Track completed/failed task IDs for progress snapshot
const runResultsTracker = { completed: new Set(), failed: [] };

let activeWorktree = null;
let activeBranch = null;
let progressServerProc = null;

const runnerLifecycleState = createRunnerLifecycleState({
  getContext: () => runnerContext,
  getActiveGitSession: () => ({ activeWorktree, activeBranch }),
  getProgressServerProc: () => progressServerProc,
});

const runnerWorktreeHandlers = createRunnerWorktreeHandlers({
  getRootDir: () => ROOT,
  getWorktreeRoot: () => WORKTREE_ROOT,
  config: () => runtimeConfig,
  createTaskWorktree,
  cleanupTaskWorktree,
  setActiveGitSession({ activeWorktree: nextWorktree, activeBranch: nextBranch }) {
    activeWorktree = nextWorktree;
    activeBranch = nextBranch;
  },
  clearActiveGitSession({ activeWorktree: finishedWorktree, activeBranch: finishedBranch }) {
    if (activeWorktree === finishedWorktree) activeWorktree = null;
    if (activeBranch === finishedBranch) activeBranch = null;
  },
  log: logP,
});

const globalTimeoutController = createRunnerTimeoutController({
  initialTimeoutMs: config.runner.session_timeout_h * 3600 * 1000,
  startTimeMs: startTime,
  runResultsTracker,
  state: runnerLifecycleState,
  logRun,
  writeProgressSnapshot,
  archiveCurrentRunFile,
  cleanupRuntimeStateFiles,
  execSync,
});

function _setGlobalTimeout(ms, options = Object()) {
  return globalTimeoutController.setGlobalTimeout(ms, options);
}

function registerInitialGlobalTimeout() {
  return globalTimeoutController.registerInitialGlobalTimeout();
}

if (isMain) {
  registerInitialGlobalTimeout();
}

if (isMain) {
  registerRunnerProcessHandlers({
    progress,
    runResultsTracker,
    state: runnerLifecycleState,
    startTimeMs: startTime,
    logRun,
    writeProgressSnapshot,
    archiveCurrentRunFile,
    cleanupRuntimeStateFiles,
    execSync,
  });
}

// ── run_id management ──────────────────────────────────────────────
function generateRunId() {
  const d = new Date();
  const ts = d.toISOString().replace(/[-:T.]/g, '').slice(0, 14); // 20260504163030
  return `run-${ts}`;
}

function writeCurrentRun(runId, prdPath) {
  writeCurrentRunFile({ currentRunFile: CURRENT_RUN_FILE, runId, prdPath, projectRoot: ROOT });
}

const runnerError = createRunnerError;

export function runPreExecutionGates(prdPath, options = Object()) {
  const exitOnFailure = options.exitOnFailure !== false;
  const deps = options.deps || Object();
  const loadFn = deps.loadPRD || loadPRD;
  const inspectFn = deps.inspectGates || inspectPreExecutionGates;
  const prd = loadFn(prdPath);
  const gate = inspectFn({
    prd,
    prdPath,
    stateDir: STATE_DIR,
    projectRoot: ROOT, config: runtimeConfig,
  });
  const decision = decidePreExecutionOutcome(gate, { exitOnFailure });
  if (decision.halt) {
    if (typeof deps.onHalt === "function") deps.onHalt(decision, gate);
    if (decision.logLevel === "warn") console.warn(decision.output);
    else console.error(decision.output);
    if (decision.shouldExit) process.exit(decision.exitCode);
    throw runnerError(decision.errorMessage, decision.throwExitCode, decision.details);
  }
}

function archiveCurrentRun(runId, results) {
  archiveCurrentRunFile({ currentRunFile: CURRENT_RUN_FILE, stateDir: STATE_DIR, runId, results });
}

export async function run(prdPath, options = Object()) {
  runtimeConfig = withExecutionConfig(options.config || config, options);
  applyRunnerContext(options, runtimeConfig);
  const exitOnComplete = options.exitOnComplete !== false;
  if (options.mode) globalMode = options.mode;
  // Generate run_id for this session
  const runId = options.runId || options.run_id || generateRunId();
  activeRunId = runId;
  try {
    const lg = inspectLifecycleGuard({ command: "yolo-run", projectRoot: ROOT, stateRoot: STATE_ROOT, prdPath });
    if (lg.status !== "pass") { console.error(lg.summary || "Lifecycle guard blocked"); throw runnerError(lg.summary || "Lifecycle guard blocked", 1, { lifecycle_guard: lg }); }
    runPreExecutionGates(prdPath, { exitOnFailure: exitOnComplete, deps: options.deps });
    const resumeCompleted = prepareRunStartup({
      runId,
      prdPath,
      paths: {
        stateDir: STATE_DIR,
        runtimeDir: RUNTIME_DIR,
        expandedTasksFile: EXPANDED_TASKS_FILE,
        resultsFile: RESULTS_FILE,
      },
      config: runtimeConfig,
      rootDir: ROOT,
      yoloRoot: STATE_ROOT,
      exitOnComplete,
      taskCountsAsCompleted,
      initTaskLogs,
      writeCurrentRun,
      startProgressApiServer: options.startProgressServer === false ? () => null : startEmbeddedProgressServer,
      setProgressServerProc: (proc) => { progressServerProc = proc; },
      initializeBaselines: options.initializeBaselines !== false,
      logProgress: logP,
      runnerError,
    });

    return await runTaskPipeline({
      runId,
      prdPath,
      resumeCompleted,
      exitOnComplete,
      sessionTimeoutHours: runtimeConfig.runner.session_timeout_h,
      runReviewLoop: options.runReviewLoop !== false,
      maxReviewRounds: MAX_REVIEW_ROUNDS,
      maxReviewTasksPerRound: runtimeConfig.runner.max_review_tasks_per_round ?? MAX_REVIEW_TASKS_PER_ROUND,
      projectRoot: ROOT,
      stateRoot: STATE_ROOT,
      toolsRoot: PACKAGE_ROOT,
      stateDir: STATE_DIR,
      runtimeDir: RUNTIME_DIR,
      expandedTasksFile: EXPANDED_TASKS_FILE,
      progress,
      startTimeMs: startTime,
      progressServerProc,
      loadPRD,
      mainLoop,
      taskPostconditionsPass,
      updateTaskStatus: (id, update) => updatePrdTaskStatus(prdPath, id, update),
      appendUnique,
      normalizeRepoPath: (filePath) => normalizeRepoPathForRoot(filePath, { rootDir: ROOT }),
      setGlobalTimeout: _setGlobalTimeout,
      logRun,
      logProgress: logP,
      writeStateSnapshot,
      writeRunReport,
      archiveCurrentRun,
      execFileSync,
      processExecPath: process.execPath,
      logReviewStart,
      logReviewGate,
      logReviewIssue,
      logReviewDone,
      logReviewError,
    });
  } finally {
    if (activeRunId === runId) activeRunId = null;
  }
}

export async function runCli(argv = process.argv) {
  registerInitialGlobalTimeout();
  const { prdArg, mode } = resolveRunnerCliArgs({ argv, yoloRoot: PACKAGE_ROOT });
  globalMode = mode;
  if (!prdArg) {
    console.error("用法: node runner.js [prd.json] [--mode=dev|fix]");
    console.error("      未传 PRD 且 scripts/yolo/ 下未找到 PRD JSON 文件");
    process.exit(1);
  }
  try {
    return await run(prdArg);
  } catch (err) {
    return handleRunCliFailure({
      error: err,
      progress,
      runResultsTracker,
      state: runnerLifecycleState,
      startTimeMs: startTime,
      logRun,
      writeProgressSnapshot,
      archiveCurrentRunFile,
      cleanupRuntimeStateFiles,
      execSync,
    });
  }
}
