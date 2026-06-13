import { incrementRetryCountFile as defaultIncrementRetryCountFile } from "../recovery/gate-stuck.js";

export function gateFailureLearnArgs({ taskId, gateExitCode, message, projectRoot = "", stateRoot = "" }) {
  const args = [
    "--record",
    `--task=${taskId}`,
    "--result=fail",
    `--gate=gate-exit-${gateExitCode}`,
    `--message=${message}`,
  ];
  if (projectRoot) args.push(`--project-root=${projectRoot}`);
  if (stateRoot) args.push(`--state-root=${stateRoot}`);
  return args;
}

export function applyGateFailureLearningEffects({
  taskId,
  gateExitCode,
  failures = [],
  gateFailure = Object(),
  retryCountFile,
  projectRoot = "",
  stateRoot = "",
  logAnalysis = (..._args) => {},
  logFix = (..._args) => {},
  execNode = () => null,
  incrementRetryCountFile = defaultIncrementRetryCountFile,
} = Object()) {
  const failedSummary = gateFailure.failedSummary || "";
  logAnalysis("", "├─", `分析: ${failedSummary}`);
  for (const failure of failures) {
    logFix(taskId, failure.type, failure.detail);
  }
  const learnArgs = gateFailureLearnArgs({
    taskId,
    gateExitCode,
    message: failedSummary,
    projectRoot,
    stateRoot,
  });
  const learnResult = execNode("learn.js", learnArgs);
  const retryCountResult = incrementRetryCountFile(retryCountFile, taskId);
  return {
    failedSummary,
    lastGateError: gateFailure.lastGateError,
    historyEntry: gateFailure.historyEntry,
    learnArgs,
    learnResult,
    retryCountResult,
  };
}
