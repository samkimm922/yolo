import { createTaskTransition } from "../task-state/transitions.js";

function formatContextPackFailure(failure) {
  const code = failure?.code || "UNKNOWN";
  const detail = typeof failure?.detail === "string" && failure.detail.trim() ? failure.detail.trim() : "";
  return detail ? `${code} (${detail})` : code;
}

export function buildContextPackFailureOutcome({
  taskId,
  contextGate = Object(),
  attempt = 0,
} = Object()) {
  const contextPackGate = contextGate.result || contextGate;
  const failures = contextPackGate.failures || [];
  const failReason = `context-pack-validator blocked: ${failures.map(formatContextPackFailure).join(", ")}`;
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
