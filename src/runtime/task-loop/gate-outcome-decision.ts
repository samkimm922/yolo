// gate-outcome-decision.ts — pure decision: which gate handler branch runs

// Extracted from task-runner.ts to make the exitCode branch testable without
// running the full runner pipeline. The decision is based solely on the gate
// exit code and the retry budget map.
export function decideGateOutcome(
  exitCode: number,
  { maxRetry = {} as Record<number, number> }: { maxRetry?: Record<number, number> } = Object(),
) {
  if (exitCode === 0) {
    return { branch: "pass" as const, handler: "handleGatePassFlow" as const };
  }
  return {
    branch: "failure" as const,
    handler: "handleGateFailureFlow" as const,
    exitCode,
    maxRetryForGate: maxRetry[exitCode] ?? 0,
  };
}
