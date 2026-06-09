export type RecoveryStrategy = "retry" | "retry_narrower" | "retry_with_hint" | "abort" | "escalate";

export interface RecoveryDecision {
  strategy: RecoveryStrategy;
  reason: string;
}

export function classifyRecovery(
  status: string,
  ctx: { attempt?: number; maxRetry?: number } = {},
): RecoveryDecision {
  const { attempt = 1, maxRetry = 3 } = ctx;
  if (attempt > maxRetry) {
    return { strategy: "escalate", reason: "max_retries_exhausted" };
  }
  switch (status) {
    case "timed_out":
      return { strategy: "retry_narrower", reason: "task_too_large_for_session" };
    case "killed":
      return { strategy: "retry", reason: "process_killed_transient" };
    case "no_output":
      return { strategy: "retry", reason: "empty_provider_output" };
    case "verification_failed":
      return { strategy: "retry_with_hint", reason: "output_verification_failed" };
    case "failed":
      return { strategy: "retry_with_hint", reason: "nonzero_exit" };
    default:
      return { strategy: "abort", reason: "unrecoverable" };
  }
}
