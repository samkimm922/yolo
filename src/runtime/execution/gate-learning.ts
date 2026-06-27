import { incrementRetryCountFile as defaultIncrementRetryCountFile } from "../recovery/gate-stuck.js";

interface GateFailureLearnArgsInput {
  taskId: string;
  gateExitCode: number | string;
  message: string;
  projectRoot?: string;
  stateRoot?: string;
}

type GateFailureLike = {
  failedSummary?: string;
  lastGateError?: unknown;
  historyEntry?: unknown;
  [key: string]: unknown;
};

type GateFailureEntry = {
  type?: string;
  detail?: string;
  [key: string]: unknown;
};

type LogFn = (...args: unknown[]) => void;
type ExecNodeFn = (...args: unknown[]) => unknown;
type IncrementRetryCountFileFn = (file: string, taskId: string) => unknown;

interface ApplyGateFailureLearningEffectsArgs {
  taskId: string;
  gateExitCode: number | string;
  failures?: GateFailureEntry[];
  gateFailure?: GateFailureLike;
  retryCountFile: string;
  projectRoot?: string;
  stateRoot?: string;
  logAnalysis?: LogFn;
  logFix?: LogFn;
  execNode?: ExecNodeFn;
  incrementRetryCountFile?: IncrementRetryCountFileFn;
}

export function gateFailureLearnArgs({ taskId, gateExitCode, message, projectRoot = "", stateRoot = "" }: GateFailureLearnArgsInput) {
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
  logAnalysis = (..._args: unknown[]) => {},
  logFix = (..._args: unknown[]) => {},
  execNode = () => null,
  incrementRetryCountFile = defaultIncrementRetryCountFile,
}: ApplyGateFailureLearningEffectsArgs = Object()) {
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
