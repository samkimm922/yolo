import { failTaskTransition } from "../task-state/transitions.js";

export function buildPreMergePostconditionFailureOutcome({
  taskId,
  postResult = Object(),
  attempt = 0,
} = Object()) {
  const reason = `post_conditions failed before merge: ${(postResult.failed || []).join("; ")}`;
  return {
    reason,
    transition: failTaskTransition({
      taskId,
      reason,
      result: { retries: attempt },
      prdUpdate: { phase: "postcondition" },
    }),
    result: { status: "failed", reason },
  };
}

export function buildCommitExceptionRetryOutcome(error: unknown) {
  const message = (error as { message?: string } | null | undefined)?.message;
  return {
    reason: `commit 异常（将重试）: ${message}`,
    errorTitle: "commit 异常（将重试）",
    errorDetail: String(error),
    gateResult: {
      exitCode: 1,
      stdout: "",
      stderr: `commit 异常: ${message}`,
      results: [],
      allPassed: false,
    },
  };
}
