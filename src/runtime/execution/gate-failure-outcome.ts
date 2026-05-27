import { isContractConditionFailure } from "../gates/failure-analysis.js";
import {
  buildMaxRetryFailure,
  buildRepeatedGateFailureTransition,
  hasRepeatedGateFailure,
} from "../recovery/gate-stuck.js";

export function buildGateFailureRetryDecision({
  taskId,
  gateExitCode,
  failures = [],
  history = [],
  failedSummary = "",
  lastGateError = "",
  attempt = 0,
  maxRetryForGate = 0,
} = {}) {
  if (hasRepeatedGateFailure(history)) {
    const action = isContractConditionFailure(failures) ? "contract_suspect" : "stuck";
    const base = {
      action,
      stopLog: {
        id: taskId,
        marker: "!! 停机",
        message: "连续 2 次同 gate code 失败",
      },
      errorTitle: "连续同因停机",
      errorDetail: `gate exit ${gateExitCode}: ${failedSummary}`,
      learnMessage: `连续同因停机: ${failedSummary}`,
      cleanupWorktree: true,
    };
    if (action === "contract_suspect") {
      return base;
    }
    return {
      ...base,
      transition: buildRepeatedGateFailureTransition({ taskId, attempt }),
      doneStatus: "failed",
      doneReason: "连续同因停机",
      result: { status: "stuck", reason: "连续同因", history },
    };
  }

  if (attempt > maxRetryForGate) {
    const { reason, transition } = buildMaxRetryFailure({ taskId, gateExitCode, attempt });
    return {
      action: "max_retry",
      errorTitle: reason,
      errorDetail: lastGateError?.slice(0, 300),
      cleanupWorktree: true,
      transition,
      doneStatus: "failed",
      doneReason: reason,
      result: { status: "failed", reason },
    };
  }

  return {
    action: "retry",
    retryMessage: `exit=${gateExitCode}, 重试 ${attempt}/${maxRetryForGate}`,
    cleanupWorktree: true,
    cleanupMessage: "worktree: 已丢弃失败改动，从干净基线重试",
  };
}
