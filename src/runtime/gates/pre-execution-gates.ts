import { inspectPrdContractDoctorGate } from "./prd-contract-doctor-gate.js";
import { inspectSpecGovernanceGate } from "./spec-governance-gate.js";

export function inspectPreExecutionGates({ prd, prdPath, stateDir, projectRoot }) {
  const contract = inspectPrdContractDoctorGate({
    prd,
    prdPath,
    stateDir,
    projectRoot,
  });
  if (contract.status === "blocked") {
    return {
      status: "blocked",
      stage: "contract",
      code: contract.code,
      exit_code: contract.exit_code,
      message: contract.message,
      contract,
      spec: null,
      messages: contract.code === "PLANNING_ONLY_PRD" ? [contract.message] : contract.messages,
    };
  }

  const spec = inspectSpecGovernanceGate({ prd });
  if (spec.status === "blocked") {
    return {
      status: "blocked",
      stage: "spec",
      code: spec.code,
      exit_code: spec.exit_code,
      message: spec.message,
      contract,
      spec,
      messages: [`[spec-governance] blocked\n${spec.summary}`],
    };
  }

  return {
    status: contract.status === "warning" ? "warning" : "pass",
    stage: "ready",
    code: "PRE_EXECUTION_GATES_PASS",
    exit_code: 0,
    message: "Pre-execution gates passed",
    contract,
    spec,
    messages: contract.status === "warning" ? contract.messages : [],
  };
}
