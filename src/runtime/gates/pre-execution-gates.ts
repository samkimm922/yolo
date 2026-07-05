import { inspectPrdContractDoctorGate } from "./prd-contract-doctor-gate.js";
import { inspectSpecGovernanceGate } from "./spec-governance-gate.js";
import { inspectProviderCapabilityGate, providerCapabilityExecutionBlock } from "./provider-capability-gate.js";

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
  const capabilityBlock = providerCapabilityExecutionBlock(capability);
  if (capabilityBlock) {
    return {
      status: "blocked",
      stage: capabilityBlock.stage,
      code: capabilityBlock.code,
      exit_code: capabilityBlock.exit_code,
      message: capabilityBlock.message,
      contract,
      spec,
      capability,
      messages: capabilityBlock.messages,
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
