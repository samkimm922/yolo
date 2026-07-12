import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildLedgerRecord } from "../src/runtime/evidence/ledger.js";
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

function withSignedReleaseRoot(run) {
  const root = mkdtempSync(resolve(tmpdir(), "yolo-release-decision-"));
  const hmacKey = "release-decision-test-hmac-key";
  try {
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ version: packageJson.version, private: true }));
    mkdirSync(resolve(root, ".yolo/keys"), { recursive: true });
    writeFileSync(resolve(root, ".yolo/keys/ledger.hmac"), hmacKey, { mode: 0o600 });
    const decision = buildLedgerRecord("release.controlled_beta_decision", releaseDecision(), {
      ledger: "state",
      source: "human-release-operator",
      now: "2026-05-25T00:00:00.000Z",
      hmacKey,
    });
    return run(root, decision);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    assert.ok(plan.required_decision_fields.includes("record_sig"));
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
    withSignedReleaseRoot((root, decision) => {
      const result = runControlledBetaReleaseDecisionGate({
        yoloRoot: root,
        hardeningDrill: passingHardeningDrill(),
        decision,
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
  });

  test("unsigned human decisions fail closed with project-key signing instructions", () => {
    const result = runControlledBetaReleaseDecisionGate({
      yoloRoot: YOLO_DIR,
      hardeningDrill: passingHardeningDrill(),
      decision: releaseDecision(),
    });

    assert.equal(result.status, "blocked");
    const blocker = result.blockers.find((item) => item.code === "DECISION_GATE_SIGNATURE_VALID");
    assert.ok(blocker);
    assert.equal(blocker.hmac_key_path, resolve(YOLO_DIR, ".yolo/keys/ledger.hmac"));
    assert.match(String(blocker.signing_command), /buildLedgerRecord/);
    assert.match(result.next_actions.join("\n"), /record_sig/);
  });

  test("tampered signed human decisions fail closed", () => {
    withSignedReleaseRoot((root, decision) => {
      const result = runControlledBetaReleaseDecisionGate({
        yoloRoot: root,
        hardeningDrill: passingHardeningDrill(),
        decision: { ...decision, approver: "different-release-owner" },
      });

      assert.equal(result.status, "blocked");
      const blocker = result.blockers.find((item) => item.code === "DECISION_GATE_SIGNATURE_VALID");
      assert.ok(blocker);
      assert.ok(Array.isArray(blocker.validation_errors));
      assert.match(blocker.validation_errors.join("\n"), /record_hash does not match|record_sig does not verify/);
    });
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
