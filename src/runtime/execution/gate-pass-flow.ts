import {
  buildCommitExceptionRetryOutcome,
  buildPreMergePostconditionFailureOutcome,
} from "./gate-pass-outcome.js";
import {
  buildTaskExecutionBaseRecord,
  readWorktreeDiffStats,
} from "./merge-result.js";
import {
  buildPostCommitOutcome,
  shouldRunPostCommitPostconditions,
} from "./post-commit-outcome.js";

export async function handleGatePassFlow({
  task,
  prdPath,
  wt,
  attempt = 0,
  startedAtMs = Date.now(),
  loadPRD,
  taskPostconditionsPass,
  cleanupWorktree,
  commitTask,
  recordTaskTransition,
  logEvent = (..._args) => {},
  logProgress = (..._args) => {},
  logTaskError = (..._args) => {},
  logTaskDone = (..._args) => {},
  readDiffStats = readWorktreeDiffStats,
  buildBaseRecord = buildTaskExecutionBaseRecord,
  nowMs = () => Date.now(),
} = Object()) {
  logEvent("gate_pass", { task: task.id });

  const prdForPreMergePostCheck = loadPRD(prdPath);
  const preMergePost = taskPostconditionsPass(task, prdForPreMergePostCheck, wt.path);
  if (!preMergePost.passed) {
    const preMergeFailure = buildPreMergePostconditionFailureOutcome({
      taskId: task.id,
      postResult: preMergePost,
      attempt,
    });
    logProgress(task.id, "!!", preMergeFailure.reason);
    cleanupWorktree(wt.path, wt.branch, false);
    recordTaskTransition(preMergeFailure.transition);
    logTaskDone(task.id, "failed", nowMs() - startedAtMs, preMergeFailure.reason);
    return { action: "return", result: preMergeFailure.result };
  }

  const diffStats = readDiffStats({ wtPath: wt.path, baseRef: wt.base });
  const worktreeFiles = cleanupWorktree(wt.path, wt.branch, true, task.scope || { targets: task.scope?.targets || [] }, wt.base);
  let commitResult;
  try {
    commitResult = await commitTask(task, prdPath, worktreeFiles);
  } catch (commitErr) {
    const commitRetry = buildCommitExceptionRetryOutcome(commitErr);
    logProgress(task.id, "!!", commitRetry.reason);
    logTaskError(task.id, commitRetry.errorTitle, commitRetry.errorDetail);
    return { action: "retry", reason: commitRetry.reason };
  }

  const scopeTargets = (task.scope?.targets || []).map((target) => target.file).filter(Boolean);
  const baseRecord = buildBaseRecord({
    taskId: task.id,
    startedAtMs,
    diffStats,
    businessFiles: commitResult.businessFiles || [],
    metadataFiles: commitResult.metadataFiles || [],
    outOfScope: commitResult.outOfScope || [],
    scopeTargets,
  });

  let postResult = null;
  if (shouldRunPostCommitPostconditions(commitResult)) {
    const prdForCheck = loadPRD(prdPath);
    const changedFiles = commitResult.code || [
      ...(commitResult.businessFiles || []),
      ...(commitResult.metadataFiles || []),
    ];
    postResult = taskPostconditionsPass(task, prdForCheck, undefined, { changedFiles });
  }

  const postCommitOutcome = buildPostCommitOutcome({
    task,
    commitResult,
    baseRecord,
    postResult,
  });
  recordTaskTransition(postCommitOutcome.transition);
  logTaskDone(task.id, postCommitOutcome.doneStatus, nowMs() - startedAtMs, postCommitOutcome.doneReason);
  return {
    action: "return",
    result: { status: postCommitOutcome.status, reason: postCommitOutcome.reason },
  };
}
