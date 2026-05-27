import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStableGraduationPlan,
  STABLE_GRADUATION_SCHEMA_VERSION,
  runStableGraduationGate,
} from "../src/release/stable-graduation.js";

const stablePackage = {
  name: "yolo",
  version: "1.0.0",
  private: false,
  type: "module",
};

function postReleaseAudit(overrides = {}) {
  return {
    status: "pass",
    blockers: [],
    components: {
      dogfood_audit: {
        status: "pass",
        public_url: "https://example.com/yolo-dogfood-1.0.0",
        evidence_files: ["state/reports/run-1/run-report.json"],
        privacy_reviewed: true,
        publication_approved: true,
        approver: "release-owner",
      },
    },
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      publish_command_executed: false,
      dogfood_report_published: false,
    },
    ...overrides,
  };
}

function readiness(overrides = {}) {
  return {
    status: "pass",
    blocks_release: false,
    blockers: [],
    checks: [],
    ...overrides,
  };
}

function stabilityReview(overrides = {}) {
  return {
    approved: true,
    approver: "release-owner",
    approved_at: "2026-05-25T00:00:00.000Z",
    version_policy_reviewed: true,
    api_boundary_reviewed: true,
    breaking_changes_reviewed: true,
    deprecation_policy_reviewed: true,
    rollback_plan: "Deprecate via minor release and republish prior tag if stable regression is found.",
    ...overrides,
  };
}

function stableGate(options = {}) {
  return runStableGraduationGate({
    yoloRoot: "/tmp/yolo",
    packageJson: stablePackage,
    postReleaseAudit: postReleaseAudit(),
    readiness: readiness(),
    stabilityReview: stabilityReview(),
    rootEntrypointCount: 8,
    runnerRuntimeApiFrozen: true,
    ...options,
  });
}

describe("stable graduation gate", () => {
  test("buildStableGraduationPlan is a no-side-effect stable release checklist", () => {
    const plan = buildStableGraduationPlan({ yoloRoot: "/tmp/yolo" });

    assert.equal(plan.schema_version, STABLE_GRADUATION_SCHEMA_VERSION);
    assert.equal(plan.writes_workspace, false);
    assert.equal(plan.publishes, false);
    assert.equal(plan.reads_credentials, false);
    assert.equal(plan.executes_billable_provider, false);
    assert.equal(plan.max_root_entrypoints, 8);
    assert.ok(plan.required_evidence.some((item) => item.includes("post-release audit")));
  });

  test("blocks current pre-stable package shape and missing release evidence", () => {
    const result = stableGate({
      packageJson: { ...stablePackage, version: "0.1.0", private: true },
      postReleaseAudit: postReleaseAudit({
        status: "blocked",
        blockers: [{ code: "POST_RELEASE_AUDIT_PACKAGE_PUBLIC" }],
      }),
      readiness: readiness({ status: "blocked", blocks_release: true }),
      stabilityReview: {},
      rootEntrypointCount: 33,
      runnerRuntimeApiFrozen: false,
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "STABLE_GRADUATION_POST_RELEASE_AUDIT_PASS"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "STABLE_GRADUATION_PACKAGE_PUBLIC"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "STABLE_GRADUATION_VERSION_STABLE"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "STABLE_GRADUATION_ROOT_ENTRYPOINT_BUDGET"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "STABLE_GRADUATION_STABILITY_REVIEW_APPROVED"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "STABLE_GRADUATION_RUNTIME_API_FROZEN"));
    assert.equal(result.guarantees.stable_graduation_declared, false);
  });

  test("requires public dogfood evidence from the post-release audit", () => {
    const result = stableGate({
      postReleaseAudit: postReleaseAudit({
        components: { dogfood_audit: { status: "pass" } },
      }),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "STABLE_GRADUATION_PUBLIC_DOGFOOD_EVIDENCE"));
  });

  test("requires public beta readiness to pass without release blockers", () => {
    const result = stableGate({
      readiness: readiness({
        status: "blocked",
        blocks_release: true,
        blockers: [{ code: "PACKAGE_PRIVATE_RELEASE_BLOCK" }],
      }),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "STABLE_GRADUATION_READINESS_PASS"));
  });

  test("passes only with post-release audit, stable version, root budget, review, and frozen runtime API", () => {
    const result = stableGate();

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.package.version, "1.0.0");
    assert.equal(result.metrics.root_entrypoint_count, 8);
    assert.equal(result.guarantees.published, false);
    assert.equal(result.guarantees.billable_provider_execution, false);
    assert.equal(result.guarantees.stable_graduation_declared, true);
  });
});
