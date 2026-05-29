import { execSync } from "node:child_process";
import { classifyTaskExecution } from "./router.js";
import { isBusinessFile } from "../execution/change-set.js";
import { handleGatePassFlow } from "../execution/gate-pass-flow.js";
import { handleGateFailureFlow } from "../execution/gate-failure-flow.js";
import { handleRunTaskExceptionFlow } from "../execution/exception-flow.js";
import { prepareProviderSession } from "../execution/session-attempt.js";
import { inspectSessionPreGateChecks } from "../execution/session-pre-gates.js";
import { handlePreSessionFlow } from "../execution/pre-session-flow.js";

function noop() {}

export async function runTaskWithRuntime({
  task,
  prdPath,
  config,
  mode,
  stateRoot,
  projectRoot,
  runtimeDir,
  tscBaselinePath,
  eslintBaselinePath,
  execNode,
  loadPRD,
  shouldRunPrecheck,
  skippedTaskPostconditionsPass,
  taskPostconditionsPass,
  commitTask,
  recordTaskTransition,
  writeTaskResult,
  updatePrdTaskStatus,
  applySplitSuggestionsToPrd,
  createWorktree,
  computeTaskTimeout,
  spawnProviderInWorktree,
  cleanupWorktree,
  runGateInWorktree,
  logEvent = noop,
  logProgress = noop,
  logTaskStart = noop,
  logTaskBash = noop,
  logTaskGate = noop,
  logTaskFix = noop,
  logTaskError = noop,
  logTaskDone = noop,
} = {}) {
  const defaultMaxRetry = config.runner.max_retries;
  const taskMaxRetry = task.retry?.max_retries;
  const maxRetry = taskMaxRetry != null
    ? { 1: taskMaxRetry, 2: Math.max(1, Math.floor(taskMaxRetry / 3)) }
    : defaultMaxRetry;
  let attempt = 0;
  let lastGateError = "";
  const history = [];
  logEvent("task_start", { task: task.id, kind: task.task_kind });
  const taskRoute = classifyTaskExecution(task);
  logTaskBash(task.id, "task-router", "pass", JSON.stringify(taskRoute).slice(0, 300));
  logProgress(task.id, "route", `${taskRoute.route}: ${taskRoute.reason}`);
  logProgress(
    task.id,
    ">>",
    `(${task.priority}) ${(task.description || "").slice(0, 40)}`,
  );
  logTaskStart(task.id, task.title || task.description || "");
  updatePrdTaskStatus(task.id, {
    status: "running",
    phase: taskRoute.route === "auto_fix"
      ? "auto_fix"
      : taskRoute.route === "deterministic_check" ? "deterministic_check" : "claude",
    updatedAt: new Date().toISOString(),
  });

  const preSession = await handlePreSessionFlow({
    task,
    prdPath,
    attempt,
    taskRoute,
    config,
    yoloRoot: stateRoot,
    projectRoot,
    execNode,
    execSync,
    loadPRD,
    shouldRunPrecheck,
    skippedTaskPostconditionsPass,
    taskPostconditionsPass,
    commitTask,
    recordTaskTransition,
    writeTaskResult,
    updatePrdTaskStatus,
    applySplitSuggestionsToPrd,
    isBusinessFile,
    logProgress,
    logTaskBash,
    logTaskDone,
  });
  if (preSession.action === "return") {
    return preSession.result;
  }

  let currentWorktreePath = null;
  let currentWorktreeBranch = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    currentWorktreePath = null;
    currentWorktreeBranch = null;
    attempt++;
    try {
      const session = await prepareProviderSession({
        task,
        prdPath,
        attempt,
        mode,
        lastGateError,
        rootDir: projectRoot,
        stateRoot,
        runtimeDir,
        config,
        tscBaselinePath,
        eslintBaselinePath,
        execNode,
        createWorktree,
        computeTaskTimeout,
        spawnProviderInWorktree,
        logTaskBash,
        logProgress,
        logEvent,
        onWorktreeCreated: (wt) => {
          currentWorktreePath = wt.path;
          currentWorktreeBranch = wt.branch;
        },
      });
      if (session.action === "return") {
        if (session.failReason) logProgress(task.id, "!!", session.failReason);
        if (session.transition) recordTaskTransition(session.transition);
        return session.result;
      }

      const { wt, startedAtMs: startedAt, providerRun, providerName } = session;
      currentWorktreePath = wt.path;
      currentWorktreeBranch = wt.branch;

      const preGate = await inspectSessionPreGateChecks({
        task,
        attempt,
        wt,
        startedAtMs: startedAt,
        providerRun,
        providerName,
        maxRetryForProvider: maxRetry[1] ?? 0,
        maxRetryForDiffQuality: maxRetry[1] ?? 1,
        cleanupWorktree,
        recordTaskTransition,
        logProgress,
        logTaskError,
        logTaskBash,
        logTaskDone,
      });
      if (preGate.lastGateError) lastGateError = preGate.lastGateError;
      if (preGate.historyEntry) history.push(preGate.historyEntry);
      if (preGate.action === "return") {
        return preGate.result;
      }
      if (preGate.action === "retry") {
        continue;
      }

      const gate = runGateInWorktree(task.id, prdPath, wt.path, mode);
      const exitCode = gate.exitCode;
      logProgress("", "├─", `gate ${exitCode === 0 ? "PASS" : "FAIL(" + exitCode + ")"}`);
      logTaskGate(task.id, "gate", exitCode === 0 ? "pass" : "fail", exitCode !== 0 ? (gate.stdout || "").slice(0, 500).split("\n").slice(0, 10) : []);

      if (exitCode === 0) {
        const gatePass = await handleGatePassFlow({
          task,
          prdPath,
          wt,
          attempt,
          startedAtMs: startedAt,
          loadPRD,
          taskPostconditionsPass,
          cleanupWorktree,
          commitTask,
          recordTaskTransition,
          logEvent,
          logProgress,
          logTaskError,
          logTaskDone,
        });
        if (gatePass.action === "retry") {
          continue;
        }
        return gatePass.result;
      }

      const gateFailure = handleGateFailureFlow({
        task,
        prdPath,
        wt,
        gate,
        attempt,
        maxRetryForGate: maxRetry[exitCode] ?? 0,
        history,
        runtimeDir,
        yoloRoot: stateRoot,
        projectRoot,
        cleanupWorktree,
        recordTaskTransition,
        execNode,
        logEvent,
        logProgress,
        logTaskError,
        logTaskFix,
        logTaskDone,
        startedAtMs: startedAt,
      });
      lastGateError = gateFailure.lastGateError || lastGateError;
      history.length = 0;
      history.push(...(gateFailure.history || []));
      if (gateFailure.action === "return") {
        return gateFailure.result;
      }
      continue;
    } catch (error) {
      const exceptionFlow = await handleRunTaskExceptionFlow({
        task,
        error,
        attempt,
        history,
        maxAttempts: maxRetry[1] ?? maxRetry[2] ?? 3,
        currentWorktree: { path: currentWorktreePath, branch: currentWorktreeBranch },
        cleanupWorktree,
        recordTaskTransition,
        logProgress,
        logTaskError,
        logTaskDone,
      });
      if (exceptionFlow.cleanedWorktree) {
        currentWorktreePath = null;
        currentWorktreeBranch = null;
      }
      if (exceptionFlow.action === "return") {
        return exceptionFlow.result;
      }
    }
  }
}
