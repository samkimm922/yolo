import {
  createTaskTransition,
  failTaskTransition,
  passTaskTransition,
} from "../task-state/transitions.js";

export function shouldRunPostCommitPostconditions(commitResult = {}) {
  return commitResult.blocked !== true
    && commitResult.hasRealCode === true
    && (commitResult.committed === true || commitResult.nonBlocking === true);
}

export function buildPostCommitOutcome({
  task = {},
  commitResult = {},
  baseRecord = {},
  postResult = null,
} = {}) {
  const taskId = task.id;
  if (commitResult.blocked) {
    const reason = commitResult.blockReason || "scope audit blocked";
    return {
      status: "failed",
      reason,
      doneStatus: "failed",
      doneReason: reason,
      transition: failTaskTransition({ taskId, reason, result: baseRecord }),
    };
  }

  if (task.task_kind === "dry_run_artifact" && baseRecord.scope_targets_missed?.length > 0) {
    const reason = `scope targets missed: ${baseRecord.scope_targets_missed.join(", ")}`;
    return {
      status: "failed",
      reason,
      doneStatus: "failed",
      doneReason: reason,
      transition: failTaskTransition({ taskId, reason, result: baseRecord }),
    };
  }

  if (shouldRunPostCommitPostconditions(commitResult)) {
    if (!postResult?.passed) {
      const failed = postResult?.failed || [];
      const reason = `post_conditions failed: ${failed.join("; ")}`;
      return {
        status: "failed",
        reason,
        doneStatus: "failed",
        doneReason: reason,
        transition: failTaskTransition({
          taskId,
          reason,
          result: baseRecord,
          prdUpdate: { phase: "postcondition" },
        }),
      };
    }
    return {
      status: "completed",
      reason: commitResult.nonBlocking ? `commit warning: ${commitResult.commitWarning || "commit_failed"}` : undefined,
      doneStatus: "completed",
      doneReason: commitResult.nonBlocking ? `commit warning: ${commitResult.commitWarning || "commit_failed"}` : undefined,
      transition: passTaskTransition({
        taskId,
        result: commitResult.nonBlocking
          ? { ...baseRecord, commit_warning: commitResult.commitWarning || "commit_failed" }
          : baseRecord,
      }),
    };
  }

  if (!commitResult.hasRealCode) {
    return {
      status: "failed",
      reason: "0 业务代码",
      doneStatus: "failed",
      doneReason: "0 业务代码",
      transition: createTaskTransition({
        taskId,
        result: {
          ...baseRecord,
          status: "FAILED_NO_CODE",
          reason: "仅元数据改动,无 src/cloudfunctions 业务代码",
        },
        prdUpdate: {
          status: "failed_no_code",
          failReason: "0 业务代码改动",
        },
      }),
    };
  }

  return {
    status: "failed",
    reason: "commit 失败",
    doneStatus: "failed",
    doneReason: "commit 失败",
    transition: createTaskTransition({
      taskId,
      result: { ...baseRecord, status: "FAIL", reason: "commit 失败" },
    }),
  };
}
