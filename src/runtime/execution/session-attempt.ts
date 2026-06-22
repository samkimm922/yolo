import { captureExecutionBaselines } from "./baselines.js";
import { buildContextPackFailureOutcome } from "./context-pack-outcome.js";
import { buildPromptSession } from "./session-prompt.js";
import { validateContextPackBeforeSession } from "./session-validation.js";
import { blockedTaskTransition } from "../task-state/transitions.js";

function isUnsafeWorktreeError(error) {
  return String(error?.message || error).startsWith("createWorktree: unsafe ");
}

export async function prepareProviderSession({
  task,
  prdPath,
  attempt,
  mode,
  lastGateError = "",
  rootDir,
  stateRoot,
  runtimeDir,
  config,
  tscBaselinePath,
  eslintBaselinePath,
  execNode,
  createWorktree,
  computeTaskTimeout,
  spawnProviderInWorktree,
  logTaskBash = (..._args) => {},
  logProgress = (..._args) => {},
  logEvent = (..._args) => {},
  onWorktreeCreated = (..._args) => {},
  nowMs = () => Date.now(),
  createSessionId = ({ task, attempt }) => `${task?.id || "task"}-attempt-${attempt}`,
  validateContextPack = validateContextPackBeforeSession,
  captureBaselines = captureExecutionBaselines,
} = Object()) {
  const sessionId = createSessionId({ task, attempt });
  const contextGate = await validateContextPack({
    task,
    attempt,
    rootDir,
    runtimeDir,
  });
  logTaskBash(task.id, "context-pack-validator", contextGate.ok ? "pass" : "fail", JSON.stringify(contextGate.result).slice(0, 300));
  if (!contextGate.ok) {
    const contextFailure = buildContextPackFailureOutcome({
      taskId: task.id,
      contextGate,
      attempt,
    });
    return {
      action: "return",
      reason: "context_pack_blocked",
      failReason: contextFailure.failReason,
      transition: contextFailure.transition,
      result: contextFailure.result,
    };
  }

  const learnArgs = ["--load"];
  if (rootDir) learnArgs.push(`--project-root=${rootDir}`);
  if (stateRoot) learnArgs.push(`--state-root=${stateRoot}`);
  const learn = execNode("learn.js", learnArgs);
  const promptSession = buildPromptSession({
    task,
    prdPath,
    attempt,
    mode,
    sessionId,
    lastGateError,
    learnStdout: learn.stdout,
    rootDir,
    stateRoot,
  });
  logEvent("task_session_start", {
    task: task.id,
    attempt,
    session_id: promptSession.contextContract.session_id,
    fresh_session: true,
    allowed_context_refs: promptSession.contextContract.allowed_context_refs,
    forbidden_context: promptSession.contextContract.forbidden_context,
  });
  if (promptSession.failureHintLog) {
    logProgress("", "├─", promptSession.failureHintLog);
  }

  const promptResult = execNode("prompt.js", promptSession.args);
  logTaskBash(task.id, "node prompt.js", promptResult.ok ? "pass" : "fail", (promptResult.stdout || promptResult.stderr)?.slice(0, 200));
  if (!promptResult.ok) {
    return {
      action: "return",
      reason: "prompt_failed",
      result: { status: "failed", reason: promptResult.helperMissing ? promptResult.stderr : "prompt 生成失败" },
    };
  }

  const baselineResult = captureBaselines({
    rootDir,
    config,
    tscBaselinePath,
    eslintBaselinePath,
  });

  let wt;
  try {
    wt = createWorktree(task.id);
  } catch (error) {
    if (!isUnsafeWorktreeError(error)) throw error;
    const failReason = String(error?.message || error);
    return {
      action: "return",
      reason: "worktree_blocked",
      failReason,
      transition: blockedTaskTransition({
        taskId: task.id,
        reason: failReason,
        result: { retries: attempt },
        prdUpdate: {
          phase: "worktree",
          phaseDetail: "unsafe_component",
        },
      }),
      result: { status: "blocked", reason: failReason },
    };
  }
  onWorktreeCreated(wt);
  logProgress("", "├─", `worktree: ${wt.branch}`);

  const startedAtMs = nowMs();
  const timeout = computeTaskTimeout(task.scope?.targets || [], { rootDir, config });
  const providerRun = await spawnProviderInWorktree(promptResult.stdout, wt.path, timeout);
  const providerName = providerRun.provider || "provider";
  logProgress(
    "",
    "├─",
    `${providerName} ${providerRun.success ? "ok" : "fail"} (${((nowMs() - startedAtMs) / 1000).toFixed(0)}s)`,
  );
  logTaskBash(task.id, `${providerName} spawn`, providerRun.success ? "pass" : "fail", providerRun.stdout?.slice(0, 300));

  return {
    action: "continue",
    wt,
    sessionId: promptSession.contextContract.session_id,
    contextContract: promptSession.contextContract,
    startedAtMs,
    providerRun,
    providerName,
    timeout,
    promptSession,
    baselineResult,
  };
}
