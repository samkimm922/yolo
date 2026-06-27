import { validateDiffQuality } from "../gates/diff-quality-gate.js";
import {
  buildDiffQualityFailureOutcome,
  buildProviderFailureOutcome,
  buildTestGenerationFailureOutcome,
} from "./session-failure-outcome.js";
import { validateTestGenerationAfterSession } from "./session-validation.js";

function providerOutputMissing(providerRun = Object()) {
  return !providerRun.success || !providerRun.stdout || providerRun.stdout.trim().length === 0;
}

export async function inspectSessionPreGateChecks({
  task,
  attempt = 0,
  wt,
  startedAtMs = Date.now(),
  providerRun = Object(),
  providerName = "provider",
  maxRetryForProvider = 0,
  maxRetryForDiffQuality = 1,
  validateDiffQualityGate = validateDiffQuality,
  validateTestGeneration = validateTestGenerationAfterSession,
  cleanupWorktree = (..._args: unknown[]) => {},
  recordTaskTransition = (..._args: unknown[]) => {},
  logProgress = (..._args: unknown[]) => {},
  logTaskError = (..._args: unknown[]) => {},
  logTaskBash = (..._args: unknown[]) => {},
  logTaskDone = (..._args: unknown[]) => {},
  nowMs = () => Date.now(),
} = Object()) {
  if (providerOutputMissing(providerRun)) {
    const providerFailureOutcome = buildProviderFailureOutcome({
      taskId: task.id,
      providerName,
      providerRun,
      attempt,
      maxRetry: maxRetryForProvider,
    });
    logProgress(task.id, "!!", providerFailureOutcome.failReason);
    logTaskError(task.id, providerFailureOutcome.failReason, providerRun.stderr?.slice(0, 200) || "");
    cleanupWorktree(wt.path, wt.branch, false);
    recordTaskTransition(providerFailureOutcome.transition);
    logTaskDone(task.id, "failed", nowMs() - startedAtMs, providerFailureOutcome.failReason);
    if (providerFailureOutcome.result) {
      return { action: "return", result: providerFailureOutcome.result };
    }
    logProgress(task.id, "", providerFailureOutcome.retryMessage);
    return { action: "retry", retryMessage: providerFailureOutcome.retryMessage };
  }

  const diffQualityGate = validateDiffQualityGate(task, { cwd: wt.path });
  logTaskBash(task.id, "diff-quality-gate", diffQualityGate.blocks_execution ? "fail" : "pass", JSON.stringify(diffQualityGate).slice(0, 500));
  if (diffQualityGate.blocks_execution) {
    const diffFailureOutcome = buildDiffQualityFailureOutcome({
      taskId: task.id,
      diffQualityGate,
      attempt,
      maxRetry: maxRetryForDiffQuality,
    });
    logProgress(task.id, "!!", diffFailureOutcome.failReason);
    logTaskError(task.id, diffFailureOutcome.failReason, diffFailureOutcome.recoveryHint);
    cleanupWorktree(wt.path, wt.branch, false);
    const state = {
      lastGateError: diffFailureOutcome.lastGateError,
      historyEntry: diffFailureOutcome.historyEntry,
    };
    if (diffFailureOutcome.result) {
      recordTaskTransition(diffFailureOutcome.transition);
      logTaskDone(task.id, "failed", nowMs() - startedAtMs, diffFailureOutcome.failReason);
      return { action: "return", result: diffFailureOutcome.result, ...state };
    }
    logProgress(task.id, "", diffFailureOutcome.retryMessage);
    return { action: "retry", retryMessage: diffFailureOutcome.retryMessage, ...state };
  }

  const testGenerationGate = await validateTestGeneration({
    task,
    cwd: wt.path,
  });
  logTaskBash(task.id, "test-generation-validator", testGenerationGate.blocks_execution ? "fail" : "pass", JSON.stringify(testGenerationGate).slice(0, 300));
  if (testGenerationGate.blocks_execution) {
    const testGenerationFailure = buildTestGenerationFailureOutcome({
      taskId: task.id,
      testGenerationGate,
      attempt,
    });
    logProgress(task.id, "!!", testGenerationFailure.failReason);
    cleanupWorktree(wt.path, wt.branch, false);
    recordTaskTransition(testGenerationFailure.transition);
    logTaskDone(task.id, "failed", nowMs() - startedAtMs, testGenerationFailure.failReason);
    return { action: "return", result: testGenerationFailure.result };
  }

  return { action: "continue" };
}
