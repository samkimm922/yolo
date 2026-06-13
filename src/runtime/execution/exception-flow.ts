import { buildRunTaskExceptionOutcome } from "./exception-outcome.js";

export function sleepFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleRunTaskExceptionFlow({
  task,
  error,
  attempt = 0,
  history = [],
  maxAttempts = 3,
  currentWorktree = Object(),
  cleanupWorktree,
  recordTaskTransition,
  logProgress = (..._args) => {},
  logTaskError = (..._args) => {},
  logTaskDone = (..._args) => {},
  sleep = sleepFor,
  consoleError = (...args) => console.error(...args),
} = Object()) {
  consoleError(`[runTask] ${task.id} 重试 ${attempt} 异常:`, error?.message || error);

  try {
    logTaskError(task.id, `循环异常 (attempt ${attempt})`, String(error));
  } catch (_) {}

  let cleanedWorktree = false;
  if (currentWorktree.path) {
    try {
      cleanupWorktree(currentWorktree.path, currentWorktree.branch, false);
    } catch (_) {}
    cleanedWorktree = true;
  }

  const exceptionOutcome = buildRunTaskExceptionOutcome({
    taskId: task.id,
    error,
    attempt,
    history,
    maxAttempts,
  });
  if (exceptionOutcome.historyEntry) {
    history.push(exceptionOutcome.historyEntry);
  }
  if (exceptionOutcome.consoleMessage) {
    consoleError(exceptionOutcome.consoleMessage);
  }
  if (exceptionOutcome.action === "return") {
    recordTaskTransition(exceptionOutcome.transition);
    logTaskDone(task.id, exceptionOutcome.doneStatus, 0, exceptionOutcome.doneReason);
    return {
      action: "return",
      result: exceptionOutcome.result,
      cleanedWorktree,
      outcome: exceptionOutcome,
    };
  }

  logProgress(task.id, "", exceptionOutcome.retryMessage);
  await sleep(exceptionOutcome.sleepMs);
  return {
    action: "retry",
    cleanedWorktree,
    outcome: exceptionOutcome,
  };
}
