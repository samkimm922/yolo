import { inspectSpecGovernance } from "../../spec/traceability.js";

export function specGovernancePolicy(options = Object()) {
  return {
    requireRequirements: options.requireRequirements !== false,
    requireDesign: options.requireDesign !== false,
    requireEvidenceForTerminal: options.requireEvidenceForTerminal !== false,
  };
}

export function formatSpecGovernanceBlockers(blockers = [], limit = 8) {
  return blockers
    .slice(0, limit)
    .map((blocker) => `${blocker.code}${blocker.task_id ? ` task=${blocker.task_id}` : ""}: ${blocker.message}`)
    .join("\n");
}

export function inspectSpecGovernanceGate({ prd, policyOptions = Object() }) {
  const result = inspectSpecGovernance(prd, specGovernancePolicy(policyOptions));
  if (result.blocks_execution) {
    return {
      status: "blocked",
      code: "PRD_SPEC_GOVERNANCE_BLOCKED",
      exit_code: 1,
      message: "PRD spec governance blocked execution",
      result,
      summary: formatSpecGovernanceBlockers(result.blockers),
    };
  }
  return {
    status: result.status,
    code: "PRD_SPEC_GOVERNANCE_PASS",
    exit_code: 0,
    message: "PRD spec governance passed",
    result,
    summary: "",
  };
}
