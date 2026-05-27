import { join } from "node:path";
import {
  analyzeFailureFromGateLog,
  analyzeFailureOutput,
} from "../gates/failure-analysis.js";
import { writeContractSuspectEvidence } from "../evidence/writers.js";
import {
  buildContractSuspectTransition,
  summarizeGateFailures,
} from "../recovery/gate-stuck.js";
import { buildGateRemediationPlan } from "../gates/remediation-plan.js";
import { buildGateFailureRetryDecision } from "./gate-failure-outcome.js";
import {
  applyGateFailureLearningEffects,
  gateFailureLearnArgs,
} from "./gate-learning.js";

export function handleGateFailureFlow({
  task,
  prdPath,
  wt,
  gate = {},
  attempt = 0,
  history = [],
  maxRetryForGate = 0,
  runtimeDir,
  yoloRoot,
  projectRoot,
  analyzeFromGateLog = analyzeFailureFromGateLog,
  analyzeOutput = analyzeFailureOutput,
  summarizeFailures = summarizeGateFailures,
  applyLearningEffects = applyGateFailureLearningEffects,
  buildRetryDecision = buildGateFailureRetryDecision,
  writeSuspectEvidence = writeContractSuspectEvidence,
  buildSuspectTransition = buildContractSuspectTransition,
  learnArgs = gateFailureLearnArgs,
  cleanupWorktree = () => {},
  recordTaskTransition = () => {},
  execNode = () => {},
  logEvent = () => {},
  logProgress = () => {},
  logTaskError = () => {},
  logTaskFix = () => {},
  logTaskDone = () => {},
  nowMs = () => Date.now(),
  startedAtMs = nowMs(),
} = {}) {
  const gateExitCode = gate.exitCode;
  logEvent("gate_fail", {
    task: task.id,
    exitCode: gateExitCode,
    reason: (gate.stdout || "").slice(0, 200),
  });

  const failures = analyzeFromGateLog(task.id, runtimeDir) ||
    analyzeOutput((gate.stdout || "").slice(0, 500));
  const gateFailure = summarizeFailures({
    failures,
    gateExitCode,
    gateOutput: gate.stdout || "",
  });
  const gateLearning = applyLearningEffects({
    taskId: task.id,
    gateExitCode,
    failures,
    gateFailure,
    retryCountFile: join(runtimeDir, "retry-count.json"),
    projectRoot,
    stateRoot: yoloRoot,
    logAnalysis: logProgress,
    logFix: logTaskFix,
    execNode,
  });
  const failedSummary = gateLearning.failedSummary;
  const lastGateError = gateLearning.lastGateError;
  const nextHistory = [...history, gateLearning.historyEntry];

  const gateFailureDecision = buildRetryDecision({
    taskId: task.id,
    gateExitCode,
    failures,
    history: nextHistory,
    failedSummary,
    lastGateError,
    attempt,
    maxRetryForGate,
  });
  const remediationPlan = buildGateRemediationPlan({
    source: "runner-gate",
    task,
    gateExitCode,
    attempt,
    maxRetry: maxRetryForGate,
    decisionAction: gateFailureDecision.action,
    gateFailureDecision,
    failures,
    summary: failedSummary,
  });
  logEvent("gate_remediation", {
    task: task.id,
    action: remediationPlan.action,
    status: remediationPlan.status,
    automation_can_continue: remediationPlan.automation_can_continue,
    requires_human: remediationPlan.requires_human,
    unsafe_stop: remediationPlan.unsafe_stop,
  });
  logProgress(task.id, "gate-remediation", `${remediationPlan.action}: ${remediationPlan.summary}`);

  if (gateFailureDecision.action === "contract_suspect" || gateFailureDecision.action === "stuck") {
    logProgress(gateFailureDecision.stopLog.id, gateFailureDecision.stopLog.marker, gateFailureDecision.stopLog.message);
    logTaskError(task.id, gateFailureDecision.errorTitle, gateFailureDecision.errorDetail);
    execNode("learn.js", learnArgs({
      taskId: task.id,
      gateExitCode,
      message: gateFailureDecision.learnMessage,
      projectRoot,
      stateRoot: yoloRoot,
    }));
    cleanupWorktree(wt.path, wt.branch, false);
    if (gateFailureDecision.action === "contract_suspect") {
      const suspect = writeSuspectEvidence({
        task,
        prdPath,
        failures,
        history: nextHistory,
        gateExitCode,
      }, { yoloRoot, projectRoot });
      const suspectTransition = buildSuspectTransition({ task, suspect, failedSummary, attempt });
      recordTaskTransition({
        ...suspectTransition,
        result: suspectTransition?.result
          ? { ...suspectTransition.result, remediation: remediationPlan }
          : suspectTransition?.result,
      });
      logTaskDone(task.id, "blocked", nowMs() - startedAtMs, "contract_suspect");
      return {
        action: "return",
        result: {
          status: "blocked",
          reason: "contract_suspect",
          evidence_file: suspect.evidence_file,
          history: nextHistory,
          remediation: remediationPlan,
        },
        lastGateError,
        history: nextHistory,
        remediation: remediationPlan,
      };
    }
    recordTaskTransition({
      ...gateFailureDecision.transition,
      result: gateFailureDecision.transition?.result
        ? { ...gateFailureDecision.transition.result, remediation: remediationPlan }
        : gateFailureDecision.transition?.result,
    });
    logTaskDone(task.id, gateFailureDecision.doneStatus, nowMs() - startedAtMs, gateFailureDecision.doneReason);
    return {
      action: "return",
      result: { ...gateFailureDecision.result, remediation: remediationPlan },
      lastGateError,
      history: nextHistory,
      remediation: remediationPlan,
    };
  }

  if (gateFailureDecision.action === "max_retry") {
    logTaskError(task.id, gateFailureDecision.errorTitle, gateFailureDecision.errorDetail);
    cleanupWorktree(wt.path, wt.branch, false);
    recordTaskTransition({
      ...gateFailureDecision.transition,
      result: gateFailureDecision.transition?.result
        ? { ...gateFailureDecision.transition.result, remediation: remediationPlan }
        : gateFailureDecision.transition?.result,
    });
    logTaskDone(task.id, gateFailureDecision.doneStatus, nowMs() - startedAtMs, gateFailureDecision.doneReason);
    return {
      action: "return",
      result: { ...gateFailureDecision.result, remediation: remediationPlan },
      lastGateError,
      history: nextHistory,
      remediation: remediationPlan,
    };
  }

  logProgress(task.id, "", gateFailureDecision.retryMessage);
  cleanupWorktree(wt.path, wt.branch, false);
  logProgress("", "├─", gateFailureDecision.cleanupMessage);
  return {
    action: "retry",
    lastGateError,
    history: nextHistory,
    remediation: remediationPlan,
  };
}
