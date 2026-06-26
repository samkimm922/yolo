// Pure decision seam extracted from runner-core runPreExecutionGates.
// No module-level side effects so tests can import it directly.
// Behavior is identical to the former inline判定 in runPreExecutionGates.

type PreExecutionGate = {
  status?: string;
  stage?: string;
  code?: string;
  exit_code?: number;
  message?: string;
  messages?: string[];
  contract: { doctor?: unknown; migration?: unknown; evidence_path?: unknown };
  spec: { result?: unknown };
} & Record<string, unknown>;

export function decidePreExecutionOutcome(
  gate: PreExecutionGate,
  { exitOnFailure }: { exitOnFailure?: boolean } = Object(),
) {
  if (gate.status === "pass") {
    return {
      halt: false,
      outcome: "pass",
      exitCode: 0,
      details: Object(),
      logLevel: null,
      output: "",
      errorMessage: "",
      shouldExit: false,
      shouldThrow: false,
      throwExitCode: 0,
    };
  }
  const isWarning = gate.status === "warning";
  const details = gate.stage === "contract"
    ? {
        code: gate.code,
        doctor: gate.contract.doctor,
        migration: gate.contract.migration,
        evidence_file: gate.contract.evidence_path,
      }
    : {
        code: gate.code,
        spec_governance: gate.spec.result,
      };
  const exitCode = gate.exit_code || 1;
  return {
    halt: true,
    outcome: isWarning ? "warning" : "blocked",
    exitCode,
    details,
    logLevel: isWarning ? "warn" : "error",
    output: (gate.messages || []).join("\n"),
    errorMessage: gate.message,
    shouldExit: exitOnFailure === true,
    shouldThrow: exitOnFailure !== true,
    throwExitCode: gate.exit_code,
  };
}
