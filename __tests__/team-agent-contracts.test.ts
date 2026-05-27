import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  agentsForLifecycleStage,
  buildTeamDispatchPlan,
  getTeamAgentContract,
  listTeamAgentContracts,
  validateTeamAgentContract,
} from "../src/agents/team-contracts.js";

describe("team agent contracts", () => {
  test("defines model-agnostic agents across the lifecycle", () => {
    const contracts = listTeamAgentContracts();

    assert.ok(contracts.some((contract) => contract.id === "pi-agent"));
    assert.ok(contracts.some((contract) => contract.id === "discovery-agent"));
    assert.ok(contracts.some((contract) => contract.id === "implementer-agent" && contract.may_edit_code));
    assert.ok(contracts.every((contract) => validateTeamAgentContract(contract).valid));
  });

  test("maps lifecycle stages to the right team agents", () => {
    const discoveryAgents = agentsForLifecycleStage("discovery").map((agent) => agent.id);
    const runAgents = agentsForLifecycleStage("run").map((agent) => agent.id);

    assert.deepEqual(discoveryAgents, ["pi-agent", "discovery-agent"]);
    assert.deepEqual(runAgents, ["pi-agent", "implementer-agent"]);
    assert.throws(() => getTeamAgentContract("unknown"), /Unknown YOLO team agent/);
  });

  test("buildTeamDispatchPlan exposes edit authority and handoffs", () => {
    const plan = buildTeamDispatchPlan({
      currentStage: "run",
      objective: "Implement checked PRD",
    });

    assert.equal(plan.schema, "yolo.team.dispatch_plan.v1");
    assert.deepEqual(plan.edit_authority.code_writing_agents, ["implementer-agent"]);
    assert.equal(plan.edit_authority.requires_explicit_user_confirmation, true);
    assert.equal(plan.handoffs[0].agent_id, "pi-agent");
  });
});
