import { captureExecutionBaselines } from "./baselines.js";
import { buildContextPackFailureOutcome } from "./context-pack-outcome.js";
import { buildPromptSession } from "./session-prompt.js";
import { validateContextPackBeforeSession } from "./session-validation.js";

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
  logTaskBash = () => {},
  logProgress = () => {},
  onWorktreeCreated = () => {},
  nowMs = () => Date.now(),
  validateContextPack = validateContextPackBeforeSession,
  captureBaselines = captureExecutionBaselines,
} = {}) {
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
    lastGateError,
    learnStdout: learn.stdout,
    rootDir,
    stateRoot,
  });
  if (promptSession.failureHintLog) {
    logProgress("", "├─", promptSession.failureHintLog);
  }

  const promptResult = execNode("prompt.js", promptSession.args);
  logTaskBash(task.id, "node prompt.js", promptResult.ok ? "pass" : "fail", promptResult.stdout?.slice(0, 200));
  if (!promptResult.ok) {
    return {
      action: "return",
      reason: "prompt_failed",
      result: { status: "failed", reason: "prompt 生成失败" },
    };
  }

  const baselineResult = captureBaselines({
    rootDir,
    config,
    tscBaselinePath,
    eslintBaselinePath,
  });

  const wt = createWorktree(task.id);
  onWorktreeCreated(wt);
  logProgress("", "├─", `worktree: ${wt.branch}`);

  const startedAtMs = nowMs();
  const timeout = computeTaskTimeout(task.scope?.targets || []);
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
    startedAtMs,
    providerRun,
    providerName,
    timeout,
    promptSession,
    baselineResult,
  };
}
