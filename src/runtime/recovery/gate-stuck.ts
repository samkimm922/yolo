import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createTaskTransition, failTaskTransition } from "../task-state/transitions.js";
import { gateFailureFingerprint } from "../gates/failure-analysis.js";

/**
 * A single gate failure observation. `failure-analysis` parses gate output
 * into these; only the fields read by recovery are named here.
 */
interface GateFailure {
  id?: unknown;
  type?: unknown;
  detail?: unknown;
  severity?: unknown;
  rules?: unknown;
}

/** A rolled-up history entry produced by {@link summarizeGateFailures}. */
interface GateFailureHistoryEntry {
  gate: unknown;
  fingerprint: string;
  message: string;
}

/** The subset of a history entry that {@link hasRepeatedGateFailure} reads. */
interface GateFailureHistoryFingerprint {
  gate: unknown;
  fingerprint: string;
}

export function summarizeGateFailures({
  failures = [],
  gateExitCode,
  gateOutput = "",
}: {
  failures?: GateFailure[];
  gateExitCode?: unknown;
  gateOutput?: unknown;
}) {
  const failedSummary = failures.map((failure) => `${failure.type}: ${failure.detail}`).join(" | ");
  const lastGateError = [
    "以下 gate 检查失败:",
    failures.map((failure) => `- ${failure.type} [${failure.severity}]: ${failure.detail}`).join("\n"),
    "",
    "原始输出:",
    String(gateOutput || "").slice(0, 300),
  ].join("\n");
  const fingerprint = gateFailureFingerprint(failures);
  return {
    failedSummary,
    fingerprint,
    lastGateError,
    historyEntry: {
      gate: gateExitCode,
      fingerprint,
      message: failedSummary.slice(0, 200),
    },
  };
}

export function incrementRetryCountFile(retryCountFile: string, taskId: string) {
  try {
    let retryData: Record<string, number> = {};
    if (existsSync(retryCountFile)) {
      retryData = JSON.parse(readFileSync(retryCountFile, "utf8"));
    }
    retryData[taskId] = (retryData[taskId] || 0) + 1;
    writeFileSync(retryCountFile, JSON.stringify(retryData));
    return { wrote: true, count: retryData[taskId], retryData };
  } catch (error) {
    return { wrote: false, reason: "write_failed", error };
  }
}

export function hasRepeatedGateFailure(history: GateFailureHistoryFingerprint[] = []) {
  const last2 = history.slice(-2);
  return last2.length >= 2 &&
    last2.every((failure) => failure.gate === last2[0].gate && failure.fingerprint === last2[0].fingerprint);
}

export function buildContractSuspectTransition({
  task,
  suspect,
  failedSummary,
  attempt,
  now = undefined,
}: {
  task: { id: string };
  suspect: { evidence_file: unknown };
  failedSummary: string;
  attempt: number;
  now?: string;
}) {
  return createTaskTransition({
    taskId: task.id,
    result: {
      status: "CONTRACT_SUSPECT",
      reason: "same_contract_condition_failed_repeatedly",
      evidence_file: suspect.evidence_file,
      retries: attempt,
    },
    prdUpdate: {
      status: "needs_contract_review",
      phase: "contract_review",
      phaseDetail: "same_contract_condition_failed_repeatedly",
      failReason: `contract_suspect: ${failedSummary.slice(0, 300)}`,
      blocked_by: [suspect.evidence_file],
      counts_as_completed: false,
      updatedAt: now || new Date().toISOString(),
    },
    now,
  });
}

export function buildRepeatedGateFailureTransition({
  taskId,
  attempt,
  now = undefined,
}: {
  taskId: string;
  attempt: number;
  now?: string;
}) {
  return failTaskTransition({
    taskId,
    reason: "连续同因",
    result: { retries: attempt },
    now,
  });
}

export function buildMaxRetryFailure({
  taskId,
  gateExitCode,
  attempt,
  now = undefined,
}: {
  taskId: string;
  gateExitCode: number;
  attempt: number;
  now?: string;
}) {
  const reason = `闸门 exit ${gateExitCode}, 重试 ${attempt} 次仍失败`;
  return {
    reason,
    transition: failTaskTransition({
      taskId,
      reason,
      result: { retries: attempt },
      prdUpdate: { retry: attempt },
      now,
    }),
  };
}
