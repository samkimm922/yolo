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
    assert.equal(plan.status, "evidence_only");
    assert.equal(plan.executable, false);
    assert.deepEqual(plan.edit_authority.code_writing_agents, []);
    assert.deepEqual(plan.edit_authority.potential_code_writing_agents, ["implementer-agent"]);
    assert.equal(plan.edit_authority.requires_explicit_user_confirmation, false);
    assert.equal(plan.handoffs[0].agent_id, "pi-agent");
    assert.ok(plan.agents.every((agent) => agent.binding_status === "evidence_only"));
  });

  test("executable dispatch blocks unresolved roles unless runtime-bound or evidence-only", () => {
    const blocked = buildTeamDispatchPlan({
      currentStage: "run",
      objective: "Implement checked PRD",
      executable: true,
      runtimeBindings: {
        "pi-agent": { runtime: "sdk.pi" },
      },
    });

    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.executable, false);
    assert.deepEqual(blocked.unresolved_roles.map((role) => role.agent_id), ["implementer-agent"]);
    assert.ok(blocked.blockers.some((blocker) => blocker.code === "TEAM_AGENT_RUNTIME_BINDING_REQUIRED"));

    const bound = buildTeamDispatchPlan({
      currentStage: "run",
      objective: "Implement checked PRD",
      executable: true,
      runtimeBindings: {
        "pi-agent": { runtime: "sdk.pi" },
        "implementer-agent": { runtime: "provider.spawn" },
      },
    });

    assert.equal(bound.status, "pass");
    assert.equal(bound.executable, true);
    assert.deepEqual(bound.executable_agents, ["pi-agent", "implementer-agent"]);
    assert.deepEqual(bound.edit_authority.code_writing_agents, ["implementer-agent"]);
    assert.equal(bound.edit_authority.requires_explicit_user_confirmation, true);
  });
});
