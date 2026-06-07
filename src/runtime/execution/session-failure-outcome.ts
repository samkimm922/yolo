import {
  blockedTaskTransition,
  createTaskTransition,
  failTaskTransition,
} from "../task-state/transitions.js";
import { buildProviderAttemptLedgerEntry, classifyProviderFailure } from "./provider-adapter.js";

export function providerFailureDiagnostic(providerRun = {}) {
  return [
    providerRun.exitCode !== null && providerRun.exitCode !== undefined ? `exit=${providerRun.exitCode}` : null,
    providerRun.signal ? `signal=${providerRun.signal}` : null,
    providerRun.stderr ? `stderr=${providerRun.stderr.slice(0, 120)}` : null,
  ].filter(Boolean).join(" ");
}

function terminalProviderPhase(reason) {
  return reason === "provider_budget_exceeded" ? "provider_budget" : "provider_preflight";
}

function providerStatusFailureReason(providerName, providerRun = {}, diagnostic = "", providerFailure = {}) {
  if (providerRun.status === "timed_out" || providerRun.timedOut === true) return `${providerName} 超时`;
  if (providerRun.status === "no_output") return `${providerName} 输出为空`;
  if (providerRun.status === "killed") return `${providerName} 被终止${diagnostic ? `: ${diagnostic}` : ""}`;
  if (providerRun.status === "verification_failed") {
    const detail = providerFailure.detail || providerRun.reason || "";
    return `${providerName} 完成验证失败${detail ? `: ${detail.slice(0, 120)}` : ""}`;
  }
  if (!providerRun.success) {
    return `${providerName} 退出失败${diagnostic ? `: ${diagnostic}` : ""}`;
  }
  return `${providerName} 输出为空`;
}

export function buildProviderFailureOutcome({
  taskId,
  providerName = "provider",
  providerRun = {},
  attempt = 0,
  maxRetry = 0,
} = {}) {
  const providerFailure = classifyProviderFailure(providerRun);
  const diagnostic = providerFailureDiagnostic(providerRun);
  const failReason = providerStatusFailureReason(providerName, providerRun, diagnostic, providerFailure);
  const recordedReason = providerFailure.terminal ? providerFailure.reason : failReason;
  const transitionBuilder = providerFailure.terminal ? blockedTaskTransition : failTaskTransition;
  const attemptLedger = (providerRun.attempt_ledger && providerRun.attempt_ledger.length > 0
    ? providerRun.attempt_ledger
    : [buildProviderAttemptLedgerEntry(providerRun)]
  ).map((entry) => ({
    ...entry,
    task_id: entry.task_id || taskId,
    attempt: entry.attempt ?? attempt,
  }));
  const transition = transitionBuilder({
    taskId,
    reason: recordedReason,
    result: {
      detail: providerFailure.detail || undefined,
      provider: providerName,
      provider_status: providerFailure.status,
      provider_reason: providerFailure.reason || providerRun.reason || undefined,
      exitCode: providerRun.exitCode,
      signal: providerRun.signal,
      timedOut: providerRun.timedOut,
      retries: attempt,
      attempt_ledger: attemptLedger,
    },
    prdUpdate: {
      phase: providerFailure.terminal ? terminalProviderPhase(providerFailure.reason) : "claude",
      phaseDetail: providerFailure.terminal ? providerFailure.reason : undefined,
    },
  });

  if (providerFailure.terminal) {
    return {
      failReason,
      transition,
      retryMessage: null,
      result: { status: "blocked", reason: providerFailure.reason },
    };
  }

  if (attempt > maxRetry) {
    return {
      failReason,
      transition,
      retryMessage: null,
      result: { status: "failed", reason: failReason },
    };
  }

  return {
    failReason,
    transition,
    retryMessage: `${providerName} 失败, 重试 ${attempt}/${maxRetry}`,
    result: null,
  };
}

export function buildDiffQualityFailureOutcome({
  taskId,
  diffQualityGate = {},
  attempt = 0,
  maxRetry = 1,
} = {}) {
  const failures = diffQualityGate.failures || [];
  const failReason = `diff-quality-gate blocked: ${failures.map((failure) => failure.code).join(", ")}`;
  const lastGateError = [
    failReason,
    diffQualityGate.recovery_hint,
    ...failures.map((failure) => `- ${failure.code}: ${failure.detail}`),
  ].filter(Boolean).join("\n");
  const historyEntry = {
    gate: 1,
    fingerprint: `diff-quality:${failures.map((failure) => failure.code).join("|")}`,
    message: failReason,
  };

  if (attempt > maxRetry) {
    return {
      failReason,
      recoveryHint: diffQualityGate.recovery_hint || "",
      lastGateError,
      historyEntry,
      retryMessage: null,
      transition: failTaskTransition({
        taskId,
        reason: failReason,
        result: {
          detail: diffQualityGate,
          retries: attempt,
        },
        prdUpdate: {
          phase: "diff_quality",
          diffQualityGate,
        },
      }),
      result: { status: "failed", reason: failReason },
    };
  }

  return {
    failReason,
    recoveryHint: diffQualityGate.recovery_hint || "",
    lastGateError,
    historyEntry,
    retryMessage: `diff quality 失败, 重试 ${attempt}/${maxRetry}`,
    transition: null,
    result: null,
  };
}

export function buildTestGenerationFailureOutcome({
  taskId,
  testGenerationGate = {},
  attempt = 0,
} = {}) {
  const failReason = `test-generation-validator blocked: ${(testGenerationGate.failures || []).map((failure) => failure.code).join(", ")}`;
  return {
    failReason,
    transition: createTaskTransition({
      taskId,
      result: {
        status: "FAIL",
        reason: failReason,
        retries: attempt,
      },
      prdUpdate: {
        status: "blocked",
        phase: "test_generation",
        failReason,
        testGenerationGate,
      },
    }),
    result: { status: "failed", reason: failReason },
  };
}
