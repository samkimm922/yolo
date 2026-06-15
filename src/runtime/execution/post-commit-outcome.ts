import {
  createTaskTransition,
  failTaskTransition,
  passTaskTransition,
} from "../task-state/transitions.js";

export function shouldRunPostCommitPostconditions(commitResult = Object()) {
  return commitResult.blocked !== true
    && commitResult.hasRealCode === true
    && commitResult.committed === true;
}

function buildCommitFailureReason(commitResult = Object()) {
  const reason = commitResult.commitFailure || commitResult.reason || commitResult.commitWarning || "commit_failed";
  return reason === "commit_failed" ? "commit 失败" : `commit 失败: ${reason}`;
}

export function buildPostCommitOutcome({
  task = Object(),
  commitResult = Object(),
  baseRecord = Object(),
  postResult = null,
} = Object()) {
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
      reason: undefined,
      doneStatus: "completed",
      doneReason: undefined,
      transition: passTaskTransition({
        taskId,
        result: baseRecord,
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
          reason: "仅元数据改动,无真实业务代码",
        },
        prdUpdate: {
          status: "failed_no_code",
          failReason: "0 业务代码改动",
        },
      }),
    };
  }

  const reason = buildCommitFailureReason(commitResult);
  return {
    status: "failed",
    reason,
    doneStatus: "failed",
    doneReason: reason,
    transition: failTaskTransition({
      taskId,
      reason,
      result: {
        ...baseRecord,
        commit_failure: commitResult.commitFailure || commitResult.reason || commitResult.commitWarning || "commit_failed",
        ...(commitResult.commitError || commitResult.error ? { commit_error: commitResult.commitError || commitResult.error } : {}),
      },
    }),
  };
}
