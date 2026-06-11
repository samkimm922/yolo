import { inspectPrdContractDoctorGate } from "./prd-contract-doctor-gate.js";
import { inspectSpecGovernanceGate } from "./spec-governance-gate.js";
import { inspectProviderCapabilityGate } from "./provider-capability-gate.js";

export function inspectPreExecutionGates({ prd, prdPath, stateDir, projectRoot, config }) {
  const contract = inspectPrdContractDoctorGate({
    prd,
    prdPath,
    stateDir,
    projectRoot,
  });
  if (contract.status !== "pass") {
    const warning = contract.status === "warning";
    return {
      status: "blocked",
      stage: "contract",
      code: warning ? "PRD_CONTRACT_WARNING_BLOCKED" : contract.code,
      exit_code: warning ? 2 : contract.exit_code,
      message: contract.message,
      contract,
      spec: null,
      capability: null,
      messages: contract.code === "PLANNING_ONLY_PRD" ? [contract.message] : contract.messages,
    };
  }

  const spec = inspectSpecGovernanceGate({ prd });
  if (spec.status !== "pass") {
    const warning = spec.status === "warning";
    return {
      status: "blocked",
      stage: "spec",
      code: warning ? "PRD_SPEC_GOVERNANCE_WARNING_BLOCKED" : spec.code,
      exit_code: warning ? 2 : spec.exit_code,
      message: warning ? "PRD spec governance warning blocked execution" : spec.message,
      contract,
      spec,
      capability: null,
      messages: [`[spec-governance] ${warning ? "warning-blocked" : "blocked"}\n${spec.summary}`],
    };
  }

  const capability = inspectProviderCapabilityGate({ prd, config });
  if (capability.status !== "pass") {
    const warning = capability.status === "warning";
    return {
      status: "blocked",
      stage: "capability",
      code: warning ? "PROVIDER_CAPABILITY_WARNING_BLOCKED" : "PROVIDER_CAPABILITY_BLOCKED",
      exit_code: warning ? 2 : 1,
      message: capability.message,
      contract,
      spec,
      capability,
      messages: [`[provider-capability] ${warning ? "warning-blocked" : "blocked"}\n${capability.message}`],
    };
  }

  return {
    status: "pass",
    stage: "ready",
    code: "PRE_EXECUTION_GATES_PASS",
    exit_code: 0,
    message: "Pre-execution gates passed",
    contract,
    spec,
    capability,
    messages: [],
  };
}
