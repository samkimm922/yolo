// gate-outcome-decision.ts — pure decision: which gate handler branch runs

// Extracted from task-runner.ts to make the exitCode branch testable without
// running the full runner pipeline. The decision is based solely on the gate
// exit code and the retry budget map.
export function decideGateOutcome(
  exitCode: number,
  { maxRetry = {} }: { maxRetry?: Record<number, number> } = Object(),
) {
  if (exitCode === 0) {
    return { branch: "pass", handler: "handleGatePassFlow" };
  }
  return {
    branch: "failure",
    handler: "handleGateFailureFlow",
    exitCode,
    maxRetryForGate: maxRetry[exitCode] ?? 0,
  };
}
