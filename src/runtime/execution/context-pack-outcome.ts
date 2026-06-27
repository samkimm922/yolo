import { createTaskTransition } from "../task-state/transitions.js";

export function buildContextPackFailureOutcome({
  taskId,
  contextGate = Object(),
  attempt = 0,
} = Object()) {
  const contextPackGate = contextGate.result || contextGate;
  const failReason = `context-pack-validator blocked: ${((contextPackGate.failures || []) as Array<{ code?: string }>).map((failure) => failure.code).join(", ")}`;
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
