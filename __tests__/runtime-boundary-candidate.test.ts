import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRuntimeBoundaryCandidatePlan,
  inspectRuntimeBoundaryCandidate,
  RUNTIME_BOUNDARY_CANDIDATE_SCHEMA_VERSION,
} from "../src/release/runtime-boundary-candidate.js";

const packageJson = {
  name: "yolo",
  version: "0.1.0",
  private: true,
  exports: {
    "./runtime": "./dist/src/runtime/runner-runtime.js",
  },
};

const apiBoundary = {
  package_exports: [
    {
      export: "./runtime",
      target: "./dist/src/runtime/runner-runtime.js",
      tier: "experimental",
      reason: "runtime boundary is awaiting stable promotion approval",
    },
  ],
};

function runtimeApiFreeze(overrides = {}) {
  return {
    status: "blocked",
    frozen: false,
    implementation_ready: true,
    stable_boundary_decision_required: true,
    blockers: [{ code: "RUNTIME_API_BOUNDARY_STABLE" }],
    implementation_blockers: [],
    ...overrides,
  };
}

describe("runtime boundary candidate", () => {
  test("plan is a no-side-effect public API decision packet", () => {
    const plan = buildRuntimeBoundaryCandidatePlan({ yoloRoot: "/tmp/yolo" });

    assert.equal(plan.schema_version, RUNTIME_BOUNDARY_CANDIDATE_SCHEMA_VERSION);
    assert.equal(plan.public_api_change_required, true);
    assert.equal(plan.requires_human_approval, true);
    assert.equal(plan.applies_changes, false);
    assert.equal(plan.writes_workspace, false);
    assert.equal(plan.publishes, false);
    assert.equal(plan.reads_credentials, false);
    assert.equal(plan.executes_billable_provider, false);
  });

  test("is ready for decision when runtime implementation is freeze-ready and boundary remains experimental", () => {
    const result = inspectRuntimeBoundaryCandidate({
      yoloRoot: "/tmp/yolo",
      packageJson,
      apiBoundary,
      runtimeApiFreeze: runtimeApiFreeze(),
    });

    assert.equal(result.status, "ready_for_decision", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.candidate.current_tier, "experimental");
    assert.equal(result.candidate.proposed_tier, "stable");
    assert.equal(result.candidate.can_apply_without_human_approval, false);
    assert.equal(result.decision.required, true);
    assert.equal(result.decision.approved, false);
    assert.equal(result.guarantees.boundary_changed, false);
    assert.equal(result.guarantees.stable_runtime_declared, false);
    assert.ok(result.suggested_changes.some((change) => change.file === "docs/public-sdk-api-boundary.json"));
  });

  test("blocks implementation blockers before requesting a stable-boundary decision", () => {
    const result = inspectRuntimeBoundaryCandidate({
      yoloRoot: "/tmp/yolo",
      packageJson,
      apiBoundary,
      runtimeApiFreeze: runtimeApiFreeze({
        implementation_ready: false,
        blockers: [
          { code: "RUNTIME_API_BOUNDARY_STABLE" },
          { code: "RUNTIME_CORE_LINE_BUDGET" },
        ],
        implementation_blockers: [{ code: "RUNTIME_CORE_LINE_BUDGET" }],
      }),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "RUNTIME_BOUNDARY_CANDIDATE_IMPLEMENTATION_READY"));
    assert.deepEqual(result.suggested_changes, []);
  });

  test("blocks if the boundary tier has already changed outside this approval gate", () => {
    const result = inspectRuntimeBoundaryCandidate({
      yoloRoot: "/tmp/yolo",
      packageJson,
      apiBoundary: {
        package_exports: [
          {
            export: "./runtime",
            target: "./dist/src/runtime/runner-runtime.js",
            tier: "stable",
            reason: "changed without this candidate gate",
          },
        ],
      },
      runtimeApiFreeze: runtimeApiFreeze({ status: "pass", frozen: true, blockers: [] }),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "RUNTIME_BOUNDARY_CANDIDATE_CURRENT_TIER_EXPERIMENTAL"));
    assert.equal(result.guarantees.stable_runtime_declared, false);
  });

  test("current workspace is ready for a runtime boundary decision but does not declare stable", () => {
    const result = inspectRuntimeBoundaryCandidate({ yoloRoot: process.cwd() });

    assert.equal(result.status, "ready_for_decision", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.candidate.export, "./runtime");
    assert.equal(result.candidate.current_tier, "experimental");
    assert.equal(result.components.runtime_api_freeze.implementation_ready, true);
    assert.equal(result.guarantees.boundary_changed, false);
    assert.equal(result.guarantees.stable_runtime_declared, false);
  });
});
