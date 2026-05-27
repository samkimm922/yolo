import { createTaskTransition } from "../task-state/transitions.js";

export function buildContextPackFailureOutcome({
  taskId,
  contextGate = {},
  attempt = 0,
} = {}) {
  const contextPackGate = contextGate.result || contextGate;
  const failReason = `context-pack-validator blocked: ${(contextPackGate.failures || []).map((failure) => failure.code).join(", ")}`;
  return {
    failReason,
    transition: createTaskTransition({
      taskId,
      result: {
        status: "FAIL",
        reason: failReason,
        retries: attempt,
      },
      prdUpdate: {
        status: "blocked",
        phase: "context_pack",
        failReason,
        contextPackGate,
      },
    }),
    result: { status: "failed", reason: failReason },
  };
}
