import { buildRunTaskExceptionOutcome } from "./exception-outcome.js";

type TaskLike = { id: string; [key: string]: unknown };
type WorktreeLike = { path?: string | null; branch?: string | null; [key: string]: unknown };
type HistoryEntry = Record<string, unknown>;
type CleanupWorktreeFn = (path: string, branch: string | null | undefined, success: boolean) => unknown;
type RecordTaskTransitionFn = (transition: unknown) => unknown;
type LogFn = (...args: unknown[]) => void;
type SleepFn = (ms: number) => Promise<unknown>;

interface HandleRunTaskExceptionFlowArgs {
  task: TaskLike;
  error: unknown;
  attempt?: number;
  history?: HistoryEntry[];
  maxAttempts?: number;
  currentWorktree?: WorktreeLike;
  cleanupWorktree: CleanupWorktreeFn;
  recordTaskTransition: RecordTaskTransitionFn;
  logProgress?: LogFn;
  logTaskError?: LogFn;
  logTaskDone?: LogFn;
  sleep?: SleepFn;
  consoleError?: LogFn;
}

export function sleepFor(ms: number) {
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
  logProgress = (..._args: unknown[]) => {},
  logTaskError = (..._args: unknown[]) => {},
  logTaskDone = (..._args: unknown[]) => {},
  sleep = sleepFor,
  consoleError = (...args: unknown[]) => console.error(...args),
}: HandleRunTaskExceptionFlowArgs = Object()) {
  const errorMessage = (error as { message?: string } | null | undefined)?.message;
  consoleError(`[runTask] ${task.id} 重试 ${attempt} 异常:`, errorMessage || error);

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
  await sleep(exceptionOutcome.sleepMs as number);
  return {
    action: "retry",
    cleanedWorktree,
    outcome: exceptionOutcome,
  };
}
