import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildDiscoveryArtifact, buildResearchDecision } from "../src/discovery/artifacts.js";
import { inspectDiscoveryReadiness } from "../src/discovery/gate.js";

function passingReadinessInput() {
  return {
    idea: "For store managers, add an inventory alerts API in src/inventory/alerts.js so an alert appears when stock is below threshold.",
    success_criteria: ["alert appears below threshold"],
    target_files: ["src/inventory/alerts.js"],
    constraints: ["keep imports unchanged"],
  };
}

describe("discovery research decision derives from content", () => {
  test("idea containing a URL marks research required", () => {
    const input = {
      ...passingReadinessInput(),
      idea: "For store managers, add an inventory alerts API modeled on https://example.com/alerts-guide so an alert appears when stock is below threshold.",
    };
    const readiness = inspectDiscoveryReadiness(input);
    const decision = buildResearchDecision(input, readiness);
    assert.equal(decision.decision, "research");
    assert.ok(decision.scouts.length > 0);
  });

  test("pure local idea marks research as skip", () => {
    const input = passingReadinessInput();
    const readiness = inspectDiscoveryReadiness(input);
    const decision = buildResearchDecision(input, readiness);
    assert.equal(decision.decision, "skip");
    assert.deepEqual(decision.scouts, []);
  });

  test("external-reference intent (replicate) marks research required", () => {
    const input = {
      ...passingReadinessInput(),
      idea: "For store managers, replicate the existing alert behavior in the new inventory module so an alert appears when stock is below threshold.",
    };
    const readiness = inspectDiscoveryReadiness(input);
    const decision = buildResearchDecision(input, readiness);
    assert.equal(decision.decision, "research");
  });

  test("explicit research flag overrides content-derived skip", () => {
    const input = { ...passingReadinessInput(), research: true };
    const readiness = inspectDiscoveryReadiness(input);
    const decision = buildResearchDecision(input, readiness);
    assert.equal(decision.decision, "research");
  });

  test("blocked readiness still reflects content-derived research signal (BUG-A/B interaction)", () => {
    // BUG-B blocks the PRD gate when a URL is present but no external evidence.
    // BUG-A's research decision must still read "research" so the user knows
    // external research is the next step — the block and the decision are
    // complementary, not conflicting.
    const input = { idea: "check https://example.com" };
    const readiness = inspectDiscoveryReadiness(input);
    assert.equal(readiness.status, "blocked");
    const decision = buildResearchDecision(input, readiness);
    assert.equal(decision.decision, "research");
  });

  test("full artifact reflects content-derived research decision", () => {
    const input = {
      ...passingReadinessInput(),
      idea: "For store managers, add an inventory alerts API modeled on https://example.com/alerts-guide so an alert appears when stock is below threshold.",
    };
    const artifact = buildDiscoveryArtifact(input);
    assert.equal(artifact.research_decision.decision, "research");
  });
});
