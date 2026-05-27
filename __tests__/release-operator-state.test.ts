import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildOperatorReleaseStatePlan,
  OPERATOR_RELEASE_STATE_SCHEMA_VERSION,
  runOperatorReleaseStateMutation,
} from "../src/release/operator-state.js";

function withPackageRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "yolo-operator-release-state-"));
  try {
    writeFileSync(join(root, "package.json"), `${JSON.stringify({
      name: "yolo",
      version: "0.1.0",
      private: true,
      type: "module",
    }, null, 2)}\n`, "utf8");
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readPackage(root) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
}

function readyDecisionGate() {
  return {
    status: "ready",
    approved_actions: ["remove_private", "publish_public_beta"],
    action_authorization: {
      remove_private: true,
      publish_public_beta: true,
      access_credentials: false,
      billable_provider_execution: false,
    },
    blockers: [],
    release_blockers: [{ code: "PACKAGE_PRIVATE_RELEASE_BLOCK" }],
  };
}

function blockedDecisionGate() {
  return {
    status: "blocked",
    approved_actions: [],
    action_authorization: {
      remove_private: false,
      publish_public_beta: false,
      access_credentials: false,
      billable_provider_execution: false,
    },
    blockers: [{ code: "DECISION_GATE_HUMAN_DECISION_PRESENT" }],
    release_blockers: [{ code: "PACKAGE_PRIVATE_RELEASE_BLOCK" }],
  };
}

function postMutationReadiness(overrides = {}) {
  return {
    status: "pass",
    blocks_release: false,
    blockers: [],
    checks: [],
    ...overrides,
  };
}

describe("operator release-state mutation", () => {
  test("buildOperatorReleaseStatePlan defaults to dry-run and never publishes or reads credentials", () => {
    const plan = buildOperatorReleaseStatePlan({ yoloRoot: "/tmp/yolo" });

    assert.equal(plan.schema_version, OPERATOR_RELEASE_STATE_SCHEMA_VERSION);
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.writes_workspace, false);
    assert.equal(plan.publishes, false);
    assert.equal(plan.reads_credentials, false);
    assert.equal(plan.spawns_provider, false);
    assert.deepEqual(plan.requested_actions, ["remove_private", "publish_public_beta"]);
    assert.deepEqual(plan.manual_commands_not_executed, ["npm publish --access public --tag beta"]);
  });

  test("runOperatorReleaseStateMutation blocks without a ready decision gate and leaves package private unchanged", () => withPackageRoot((root) => {
    const result = runOperatorReleaseStateMutation({
      yoloRoot: root,
      decisionGate: blockedDecisionGate(),
      inspectPostMutationReadiness: () => postMutationReadiness(),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "OPERATOR_STATE_DECISION_GATE_READY"));
    assert.equal(readPackage(root).private, true);
    assert.equal(result.guarantees.published, false);
    assert.equal(result.guarantees.credential_access, false);
    assert.equal(result.guarantees.provider_execution, false);
    assert.equal(result.guarantees.package_private_mutated, false);
  }));

  test("runOperatorReleaseStateMutation dry-runs approved private removal without changing package.json", () => withPackageRoot((root) => {
    const result = runOperatorReleaseStateMutation({
      yoloRoot: root,
      decisionGate: readyDecisionGate(),
      inspectPostMutationReadiness: () => postMutationReadiness(),
    });

    assert.equal(result.status, "planned", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.mode, "dry-run");
    assert.equal(result.mutation.applied, false);
    assert.equal(result.mutation.simulated_private_after, false);
    assert.equal(readPackage(root).private, true);
    assert.equal(result.guarantees.publish_command_executed, false);
  }));

  test("apply mode requires allowWorkspaceMutation before mutating package.json", () => withPackageRoot((root) => {
    const result = runOperatorReleaseStateMutation({
      yoloRoot: root,
      apply: true,
      decisionGate: readyDecisionGate(),
      inspectPostMutationReadiness: () => postMutationReadiness(),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "OPERATOR_STATE_APPLY_EXPLICITLY_ALLOWED"));
    assert.equal(readPackage(root).private, true);
  }));

  test("authorized apply removes private in a temp package root and still does not publish", () => withPackageRoot((root) => {
    const result = runOperatorReleaseStateMutation({
      yoloRoot: root,
      apply: true,
      allowWorkspaceMutation: true,
      decisionGate: readyDecisionGate(),
      inspectPostMutationReadiness: () => postMutationReadiness(),
    });

    assert.equal(result.status, "applied", JSON.stringify(result.blockers, null, 2));
    assert.equal(readPackage(root).private, undefined);
    assert.equal(result.mutation.applied, true);
    assert.deepEqual(result.mutation.changed_fields, ["private"]);
    assert.equal(result.guarantees.published, false);
    assert.equal(result.guarantees.publish_command_executed, false);
    assert.equal(result.guarantees.package_private_mutated, true);
  }));

  test("post-mutation readiness must clear PACKAGE_PRIVATE_RELEASE_BLOCK", () => withPackageRoot((root) => {
    const result = runOperatorReleaseStateMutation({
      yoloRoot: root,
      decisionGate: readyDecisionGate(),
      inspectPostMutationReadiness: () => postMutationReadiness({
        status: "blocked",
        blocks_release: true,
        blockers: [{ code: "PACKAGE_PRIVATE_RELEASE_BLOCK" }],
      }),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "OPERATOR_STATE_POST_MUTATION_READINESS_NO_PRIVATE_BLOCKER"));
    assert.equal(readPackage(root).private, true);
  }));
});
