import { failTaskTransition } from "../task-state/transitions.js";
import { circuitBreakerThreshold, hasRepeatedFailure } from "../recovery/retry-policy.js";

export function exceptionFailureKey(error) {
  return `exception:${(error?.message || "unknown").substring(0, 50)}`;
}

export function hasRepeatedExceptionFailure(history = [], failKey = "", threshold: unknown = circuitBreakerThreshold()) {
  const keyPrefix = failKey.slice(0, 30);
  const matchesFailKey = (item) => Boolean(item?.message && item.message.includes(keyPrefix));
  return hasRepeatedFailure(history, threshold, (item, first) => matchesFailKey(first) && matchesFailKey(item));
}

export function buildRunTaskExceptionOutcome({
  taskId,
  error,
  attempt = 0,
  history = [],
  maxAttempts = 3,
} = Object()) {
  const failKey = exceptionFailureKey(error);
  const errorMessage = String(error?.message || error);

  if (hasRepeatedExceptionFailure(history, failKey)) {
    const reason = `连续异常停机: ${errorMessage.slice(0, 100)}`;
    return {
      action: "return",
      failKey,
      consoleMessage: `[runTask] ${taskId} 连续异常停机: ${failKey}`,
      transition: failTaskTransition({
        taskId,
        reason,
        result: { retries: attempt },
        prdUpdate: { failReason: "连续异常停机" },
      }),
      doneStatus: "failed",
      doneReason: `连续异常停机: ${errorMessage.slice(0, 80)}`,
      result: { status: "failed", reason: "stuck_exception", error: String(error) },
    };
  }

  const historyEntry = { gate: -1, message: failKey };
  if (attempt > maxAttempts) {
    const reason = `重试耗尽 (异常): ${errorMessage.slice(0, 100)}`;
    return {
      action: "return",
      failKey,
      historyEntry,
      consoleMessage: `[runTask] ${taskId} 重试耗尽: ${String(error)}`,
      transition: failTaskTransition({
        taskId,
        reason,
        result: { retries: attempt },
        prdUpdate: { failReason: `重试耗尽 (异常): ${errorMessage.slice(0, 80)}` },
      }),
      doneStatus: "failed",
      doneReason: "重试耗尽 (异常)",
      result: { status: "failed", reason: "max_retry_exception", error: String(error) },
    };
  }

  return {
    action: "retry",
    failKey,
    historyEntry,
    retryMessage: `异常, 重试 ${attempt}/${maxAttempts}: ${String(error?.message || String(error)).slice(0, 80)}`,
    sleepMs: 2000,
  };
}
