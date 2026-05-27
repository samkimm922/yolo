import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildControlledBetaReleaseDecisionPlan,
  CONTROLLED_BETA_RELEASE_ACTIONS,
  CONTROLLED_BETA_RELEASE_DECISION_SCHEMA_VERSION,
  runControlledBetaReleaseDecisionGate,
} from "../src/release/decision-gate.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(YOLO_DIR, "package.json"), "utf8"));

function passingHardeningDrill(overrides = {}) {
  return {
    status: "pass",
    blocks_release: true,
    release_status: "blocked",
    release_blockers: [
      { code: "PACKAGE_PRIVATE_RELEASE_BLOCK", message: "package.json private=true blocks public release" },
    ],
    blockers: [],
    guarantees: {
      published: false,
      package_private_unchanged: true,
      provider_execution_allowed: false,
      billable_provider_execution: false,
      credential_access: false,
    },
    ...overrides,
  };
}

function releaseDecision(overrides = {}) {
  return {
    approved: true,
    approver: "release-owner",
    approved_at: "2026-05-25T00:00:00.000Z",
    scope: "public-beta",
    package_version: packageJson.version,
    approved_actions: ["remove_private", "publish_public_beta"],
    risk_acceptance: ["public beta is still experimental and private=true must be removed manually"],
    hardening_drill_reviewed: true,
    private_blocker_acknowledged: true,
    ...overrides,
  };
}

describe("controlled beta release decision gate", () => {
  test("buildControlledBetaReleaseDecisionPlan encodes manual-only release guardrails", () => {
    const plan = buildControlledBetaReleaseDecisionPlan({ yoloRoot: YOLO_DIR });

    assert.equal(plan.schema_version, CONTROLLED_BETA_RELEASE_DECISION_SCHEMA_VERSION);
    assert.deepEqual(plan.requested_actions, ["remove_private", "publish_public_beta"]);
    assert.equal(plan.publishes, false);
    assert.equal(plan.writes_workspace, false);
    assert.equal(plan.reads_credentials, false);
    assert.equal(plan.spawns_provider, false);
    assert.ok(plan.required_decision_fields.includes("approver"));
    assert.ok(CONTROLLED_BETA_RELEASE_ACTIONS.includes("billable_provider_execution"));
  });

  test("runControlledBetaReleaseDecisionGate blocks without a human decision record", () => {
    const result = runControlledBetaReleaseDecisionGate({
      yoloRoot: YOLO_DIR,
      hardeningDrill: passingHardeningDrill(),
    });

    assert.equal(result.status, "blocked");
    assert.deepEqual(result.approved_actions, []);
    assert.ok(result.blockers.some((blocker) => blocker.code === "DECISION_GATE_HUMAN_DECISION_PRESENT"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "DECISION_GATE_ACTIONS_APPROVED"));
    assert.equal(result.guarantees.published, false);
    assert.equal(result.guarantees.package_private_unchanged, true);
    assert.equal(result.guarantees.credential_access, false);
    assert.equal(result.guarantees.billable_provider_execution, false);
  });

  test("runControlledBetaReleaseDecisionGate becomes ready with explicit human approval and private blocker acknowledgement", () => {
    const result = runControlledBetaReleaseDecisionGate({
      yoloRoot: YOLO_DIR,
      hardeningDrill: passingHardeningDrill(),
      decision: releaseDecision(),
    });

    assert.equal(result.status, "ready", JSON.stringify(result.blockers, null, 2));
    assert.deepEqual(result.approved_actions, ["remove_private", "publish_public_beta"]);
    assert.equal(result.action_authorization.remove_private, true);
    assert.equal(result.action_authorization.publish_public_beta, true);
    assert.equal(result.action_authorization.access_credentials, false);
    assert.equal(result.action_authorization.billable_provider_execution, false);
    assert.equal(result.guarantees.published, false);
    assert.equal(result.guarantees.package_private_unchanged, true);
    assert.equal(result.guarantees.provider_execution, false);
  });

  test("credential and billable provider actions require explicit action approval", () => {
    const result = runControlledBetaReleaseDecisionGate({
      yoloRoot: YOLO_DIR,
      requestedActions: [
        "remove_private",
        "publish_public_beta",
        "access_credentials",
        "billable_provider_execution",
      ],
      hardeningDrill: passingHardeningDrill(),
      decision: releaseDecision(),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "DECISION_GATE_ACTIONS_APPROVED"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "DECISION_GATE_CREDENTIAL_ACTION_EXPLICIT"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "DECISION_GATE_BILLABLE_ACTION_EXPLICIT"));
  });

  test("non-private release blockers keep the controlled beta decision blocked", () => {
    const result = runControlledBetaReleaseDecisionGate({
      yoloRoot: YOLO_DIR,
      hardeningDrill: passingHardeningDrill({
        release_blockers: [
          { code: "PACKAGE_PRIVATE_RELEASE_BLOCK" },
          { code: "DOC_API_REFERENCE_SURFACES" },
        ],
      }),
      decision: releaseDecision(),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "DECISION_GATE_RELEASE_BLOCKERS_PRIVATE_ONLY"));
  });
});
