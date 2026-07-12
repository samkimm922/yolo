import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createYoloSdk,
  runPublicBetaEvidenceGate,
} from "../sdk.js";
import {
  buildAgentIntegrationDoctorPlan,
  runAgentIntegrationDoctor,
} from "../src/release/agent-integration-doctor.js";
import { runPiExecutionDrillGate } from "../src/release/pi-execution-drill.js";
import { runPublicBetaEvidenceGate as runPublicBetaEvidenceGateDirect } from "../src/release/public-beta-evidence.js";
import { runRealProjectDogfoodGate } from "../src/release/real-project-dogfood.js";
import { buildDogfoodMatrixEvidence } from "../src/release/dogfood-matrix.js";
import { runRuntimeBoundaryDecisionGate } from "../src/release/runtime-boundary-decision.js";

const tmpRoots = [];

after(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  tmpRoots.push(root);
  return root;
}

function writeArtifact(path, body = "# YOLO test artifact\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

function writeExpectedArtifacts(plan) {
  for (const artifact of plan.expected_artifacts) {
    writeArtifact(artifact.path);
  }
}

function hostDiscoveryEvidence(targets = ["codex"], overrides = {}) {
  return {
    status: "pass",
    targets,
    discovered_at: "2026-05-25T00:00:00.000Z",
    discovery_run_id: "host-discovery-test",
    ...overrides,
  };
}

function agentIntegrationPass(overrides = {}) {
  return {
    status: "pass",
    blockers: [],
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
    },
    ...overrides,
  };
}

function dogfoodEvidence(mode, overrides = {}) {
  return {
    status: "pass",
    mode,
    artifact_path: `state/reports/yolo-${mode}.json`,
    writes_workspace: false,
    edits_code: false,
    provider_execution: false,
    billable_provider_execution: false,
    executed_by_sdk: false,
    ...overrides,
  };
}

function piEvidence(overrides = {}) {
  return {
    status: "pass",
    mode: "dry_run",
    agent: "pi",
    artifact_path: "state/reports/pi-dry-run.json",
    provider_execution: false,
    billable_provider_execution: false,
    executed_by_sdk: false,
    ...overrides,
  };
}

function runtimeCandidate(overrides = {}) {
  return {
    status: "ready_for_decision",
    blockers: [],
    candidate: {
      export: "./runtime",
      target: "./dist/src/runtime/runner-runtime.js",
      current_tier: "experimental",
      proposed_tier: "stable",
    },
    suggested_changes: [],
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      boundary_changed: false,
      stable_runtime_declared: false,
    },
    ...overrides,
  };
}

function runtimeDecisionRecord(overrides = {}) {
  return {
    approved: true,
    approver: "release-owner",
    approved_at: "2026-05-25T00:00:00.000Z",
    target_export: "./runtime",
    current_tier: "experimental",
    proposed_tier: "stable",
    stability_reviewed: true,
    rollback_plan_approved: true,
    rollback_plan: "revert docs/public-sdk-api-boundary.json ./runtime tier to experimental",
    ...overrides,
  };
}

function componentPass(status = "pass", overrides = {}) {
  return {
    status,
    blockers: [],
    guarantees: {
      writes_workspace: false,
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      dogfood_report_published: false,
    },
    ...overrides,
  };
}

describe("P28-P32 release evidence gates", () => {
  test("agent integration doctor blocks missing native skill and command artifacts", () => {
    const root = tempRoot("yolo-p28-missing");
    const projectRoot = join(root, "project");
    const homeDir = join(root, "home");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    const result = runAgentIntegrationDoctor({
      yoloRoot: root,
      projectRoot,
      homeDir,
      target: "codex",
      targets: ["codex"],
      scope: "user",
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "AGENT_INTEGRATION_DOCTOR_ARTIFACTS_PRESENT"));
    assert.ok(!result.blockers.some((blocker) => blocker.code === "AGENT_INTEGRATION_DOCTOR_ROOTS_EXIST"));
    assert.equal(result.guarantees.published, false);
    assert.equal(result.guarantees.provider_execution, false);
  });

  test("agent integration doctor passes when requested artifacts and fresh host discovery exist", () => {
    const root = tempRoot("yolo-p28-pass");
    const projectRoot = join(root, "project");
    const homeDir = join(root, "home");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const plan = buildAgentIntegrationDoctorPlan({
      yoloRoot: root,
      projectRoot,
      homeDir,
      targets: ["codex"],
      scope: "user",
    });
    writeExpectedArtifacts(plan);

    const result = runAgentIntegrationDoctor({
      yoloRoot: root,
      projectRoot,
      homeDir,
      plan,
      hostDiscoveryEvidence: hostDiscoveryEvidence(["codex"]),
      nowMs: Date.parse("2026-05-25T00:05:00.000Z"),
    });

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.artifacts_present, result.artifact_count);
    assert.equal(result.guarantees.writes_user_home, false);
    assert.equal(result.guarantees.host_discovery_fresh, true);
  });

  test("agent integration doctor blocks stale host discovery even when artifacts exist", () => {
    const root = tempRoot("yolo-p28-stale-host");
    const projectRoot = join(root, "project");
    const homeDir = join(root, "home");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const plan = buildAgentIntegrationDoctorPlan({
      yoloRoot: root,
      projectRoot,
      homeDir,
      targets: ["codex"],
      scope: "user",
    });
    writeExpectedArtifacts(plan);

    const result = runAgentIntegrationDoctor({
      yoloRoot: root,
      projectRoot,
      homeDir,
      plan,
      hostDiscoveryEvidence: hostDiscoveryEvidence(["codex"], { discovered_at: "2026-05-25T00:00:00.000Z" }),
      nowMs: Date.parse("2026-05-25T02:00:00.000Z"),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "AGENT_INTEGRATION_DOCTOR_HOST_DISCOVERY_FRESH"));
    assert.ok(!result.blockers.some((blocker) => blocker.code === "AGENT_INTEGRATION_DOCTOR_ARTIFACTS_PRESENT"));
    assert.ok(result.host_discovery.blockers.some((blocker) => blocker.code === "AGENT_INTEGRATION_DOCTOR_HOST_DISCOVERY_STALE"));
    assert.ok(!result.host_discovery.blockers.some((blocker) => blocker.code === "AGENT_INTEGRATION_DOCTOR_HOST_DISCOVERY_MISSING"));
  });

  test("real-project dogfood requires plan/check/review evidence from an external project", () => {
    const root = tempRoot("yolo-p29");
    const yoloRoot = join(root, "yolo");
    const projectRoot = join(root, "external-project");
    mkdirSync(yoloRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });

    const blocked = runRealProjectDogfoodGate({
      yoloRoot,
      projectRoot: yoloRoot,
      agentIntegration: agentIntegrationPass(),
    });
    assert.equal(blocked.status, "blocked");
    assert.ok(blocked.blockers.some((blocker) => blocker.code === "REAL_PROJECT_DOGFOOD_EXTERNAL_PROJECT"));
    assert.ok(!blocked.blockers.some((blocker) => blocker.code === "REAL_PROJECT_DOGFOOD_AGENT_INTEGRATION_PASS"));

    const passed = runRealProjectDogfoodGate({
      yoloRoot,
      projectRoot,
      agentIntegration: agentIntegrationPass(),
      planEvidence: dogfoodEvidence("plan"),
      checkEvidence: dogfoodEvidence("check"),
      reviewEvidence: dogfoodEvidence("review"),
      dogfoodMatrixEvidence: buildDogfoodMatrixEvidence(),
    });
    assert.equal(passed.status, "pass", JSON.stringify(passed.blockers, null, 2));
    assert.equal(passed.guarantees.code_edited, false);
  });

  test("PI execution drill blocks billable evidence without explicit authorization", () => {
    const blocked = runPiExecutionDrillGate({
      yoloRoot: "/tmp/yolo",
      projectRoot: "/tmp/project",
      executionEvidence: piEvidence({
        mode: "controlled_billable",
        provider: "codex",
        cost_acknowledged: true,
      }),
    });

    assert.equal(blocked.status, "blocked");
    assert.ok(blocked.blockers.some((blocker) => blocker.code === "PI_EXECUTION_DRILL_BILLABLE_AUTHORIZATION"));
    assert.ok(!blocked.blockers.some((blocker) => blocker.code === "PI_EXECUTION_DRILL_BILLABLE_COST_ACKNOWLEDGED"));
    assert.equal(blocked.guarantees.billable_provider_execution, false);
  });

  test("PI execution drill accepts dry-run and externally authorized controlled billable evidence", () => {
    const dryRun = runPiExecutionDrillGate({
      yoloRoot: "/tmp/yolo",
      projectRoot: "/tmp/project",
      executionEvidence: piEvidence(),
    });
    assert.equal(dryRun.status, "pass", JSON.stringify(dryRun.blockers, null, 2));

    const billable = runPiExecutionDrillGate({
      yoloRoot: "/tmp/yolo",
      projectRoot: "/tmp/project",
      executionEvidence: piEvidence({
        mode: "controlled_billable",
        provider: "codex",
        cost_acknowledged: true,
      }),
      authorization: {
        approved: true,
        operator: "release-owner",
        approved_at: "2026-05-25T00:00:00.000Z",
        provider: "codex",
        cost_acknowledged: true,
        max_budget_usd: 5,
      },
    });
    assert.equal(billable.status, "pass", JSON.stringify(billable.blockers, null, 2));
    assert.equal(billable.billable_authorized, true);
    assert.equal(billable.guarantees.provider_execution, false);
  });

  test("runtime boundary decision requires explicit human stable-boundary approval", () => {
    const blocked = runRuntimeBoundaryDecisionGate({
      yoloRoot: "/tmp/yolo",
      candidate: runtimeCandidate(),
    });
    assert.equal(blocked.status, "blocked");
    assert.ok(blocked.blockers.some((blocker) => blocker.code === "RUNTIME_BOUNDARY_DECISION_RECORD_PRESENT"));
    assert.ok(!blocked.blockers.some((blocker) => blocker.code === "RUNTIME_BOUNDARY_DECISION_CANDIDATE_READY"));

    const ready = runRuntimeBoundaryDecisionGate({
      yoloRoot: "/tmp/yolo",
      candidate: runtimeCandidate(),
      decisionRecord: runtimeDecisionRecord(),
    });
    assert.equal(ready.status, "ready_to_apply", JSON.stringify(ready.blockers, null, 2));
    assert.equal(ready.guarantees.boundary_changed, false);
    assert.equal(ready.guarantees.stable_runtime_declared, false);
  });

  test("runtime boundary decision blocked result carries a decision record schema template and attach path", () => {
    const blocked = runRuntimeBoundaryDecisionGate({
      yoloRoot: "/tmp/yolo",
      candidate: runtimeCandidate(),
    });
    assert.equal(blocked.status, "blocked");
    assert.ok(blocked.decision_record_template, "blocked gate must surface a decision_record_template");

    const template = blocked.decision_record_template as Record<string, unknown>;
    const entry = template.entry_template as Record<string, unknown>;

    // The skeleton must satisfy decisionApproved() so operators can copy it verbatim.
    assert.equal(entry.approved, true);
    assert.equal(entry.target_export, "./runtime");
    assert.equal(entry.current_tier, "experimental");
    assert.equal(entry.proposed_tier, "stable");
    assert.equal(entry.stability_reviewed, true);
    assert.equal(entry.rollback_plan_approved, true);
    assert.ok(typeof entry.approver === "string" && entry.approver.length > 0);
    assert.ok(typeof entry.approved_at === "string" && entry.approved_at.length > 0);
    assert.ok(typeof entry.rollback_plan === "string" && entry.rollback_plan.length > 0);

    // The template must name the option used to attach the record at the gate boundary.
    assert.ok(
      typeof template.attach_via === "string" && template.attach_via.length > 0,
      "template must document the attach option",
    );
  });

  test("public beta evidence bundle aggregates P28-P31 without executing release side effects", () => {
    const result = runPublicBetaEvidenceGateDirect({
      yoloRoot: "/tmp/yolo",
      projectRoot: "/tmp/project",
      agentIntegration: agentIntegrationPass(),
      realProjectDogfood: componentPass("pass"),
      piExecutionDrill: componentPass("pass"),
      runtimeBoundaryDecision: componentPass("not_required", {
        guarantees: {
          published: false,
          credential_access: false,
          provider_execution: false,
          billable_provider_execution: false,
          boundary_changed: false,
          stable_runtime_declared: false,
        },
      }),
      manualExternalRelease: componentPass("not_required"),
    });

    assert.equal(result.status, "ready_for_operator", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.guarantees.published, false);
    assert.equal(result.guarantees.evidence_bundle_only, true);
  });

  test("public stable evidence requires runtime decision and manual external release pass", () => {
    const result = runPublicBetaEvidenceGateDirect({
      yoloRoot: "/tmp/yolo",
      projectRoot: "/tmp/project",
      releaseScope: "public-stable",
      agentIntegration: agentIntegrationPass(),
      realProjectDogfood: componentPass("pass"),
      piExecutionDrill: componentPass("pass"),
      runtimeBoundaryDecision: componentPass("ready_to_apply"),
      manualExternalRelease: componentPass("pass"),
    });

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.plan.require_runtime_stable_decision, true);
    assert.equal(result.plan.require_manual_external_release_evidence, true);
  });

  test("SDK facade exposes P28-P32 release helpers", () => {
    const sdk = createYoloSdk();

    assert.equal(typeof sdk.release.runAgentIntegrationDoctor, "function");
    assert.equal(typeof sdk.release.runRealProjectDogfoodGate, "function");
    assert.equal(typeof sdk.release.runPiExecutionDrillGate, "function");
    assert.equal(typeof sdk.release.runRuntimeBoundaryDecisionGate, "function");
    assert.equal(typeof sdk.release.runPublicBetaEvidenceGate, "function");
    assert.equal(typeof runPublicBetaEvidenceGate, "function");
  });
});
