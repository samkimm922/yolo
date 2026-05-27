import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  buildPublicBetaHardeningDrillPlan,
  PUBLIC_BETA_HARDENING_DRILL_SCHEMA_VERSION,
  runPublicBetaHardeningDrill,
} from "../src/release/hardening-drill.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");

function passingPackageInstallSmoke() {
  return {
    status: "pass",
    exit_code: 0,
    dry_run: false,
    summary: "fake package install smoke passed",
    pack: { inspection: { status: "pass", forbidden_entries: [] } },
    install: { status: "pass", exit_code: 0 },
    import_check: { status: "pass", exit_code: 0 },
    bin_checks: [{ status: "pass", exit_code: 0 }],
  };
}

function passingWorkflowTargetSmoke() {
  return {
    status: "pass",
    summary: "fake workflow target smoke passed",
    plan: { targets: [{ target_dir: ".yolo/skills" }] },
  };
}

function commandExists(command) {
  return ["claude", "codex", "cat", "node", "sh"].includes(command);
}

describe("public beta release hardening drill", () => {
  test("buildPublicBetaHardeningDrillPlan encodes no-publish and no-provider-execution guardrails", () => {
    const plan = buildPublicBetaHardeningDrillPlan({ yoloRoot: YOLO_DIR });

    assert.equal(plan.schema_version, PUBLIC_BETA_HARDENING_DRILL_SCHEMA_VERSION);
    assert.equal(plan.publish_allowed, false);
    assert.equal(plan.package_private_mutation_allowed, false);
    assert.equal(plan.billable_provider_execution_allowed, false);
    assert.equal(plan.credential_access_allowed, false);
    assert.deepEqual(plan.steps.map((step) => step.id), [
      "release_readiness",
      "package_install_smoke",
      "fixture_registry",
      "api_boundary_docs",
      "provider_cli_dry_run",
      "workflow_target_smoke",
    ]);
    assert.ok(plan.steps.every((step) => step.publishes === false));
    assert.ok(plan.steps.every((step) => step.spawns_provider === false));
  });

  test("runPublicBetaHardeningDrill passes the drill while preserving private=true as release blocker", () => {
    const result = runPublicBetaHardeningDrill({
      yoloRoot: YOLO_DIR,
      commandExists,
      now: () => 123,
      random: () => 0.5,
      runPackageInstallSmoke: passingPackageInstallSmoke,
      runWorkflowSkillTargetSmoke: passingWorkflowTargetSmoke,
    });

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.blocks_release, true);
    assert.equal(result.release_status, "blocked");
    assert.ok(result.release_blockers.some((blocker) => blocker.code === "PACKAGE_PRIVATE_RELEASE_BLOCK"));
    assert.equal(result.guarantees.published, false);
    assert.equal(result.guarantees.package_private_unchanged, true);
    assert.equal(result.guarantees.provider_execution_allowed, false);
    assert.equal(result.guarantees.billable_provider_execution, false);
    assert.equal(result.guarantees.credential_access, false);

    const checks = new Map(result.checks.map((check) => [check.code, check]));
    for (const code of [
      "DRILL_NO_PUBLISH",
      "DRILL_PRIVATE_FIELD_UNCHANGED",
      "READINESS_EXECUTED",
      "READINESS_PRIVATE_BLOCKER_EXPECTED",
      "PACKAGE_INSTALL_SMOKE_PASS",
      "FIXTURE_REGISTRY_PASS",
      "API_BOUNDARY_DOCS_PASS",
      "DOCS_CONSISTENCY_PASS",
      "PROVIDER_CLI_DRY_RUN_SAFE",
      "PROVIDER_CREDENTIAL_STOP_CONDITION_PRESENT",
      "WORKFLOW_TARGET_SMOKE_PASS",
    ]) {
      assert.equal(checks.get(code)?.passed, true, `${code} should pass`);
    }
    assert.equal(result.components.provider_cli_dry_run.matrix.execution_allowed, false);
    assert.ok(result.components.provider_cli_dry_run.matrix.providers.every((entry) => entry.will_spawn === false));
  });

  test("runPublicBetaHardeningDrill blocks when package install smoke fails", () => {
    const result = runPublicBetaHardeningDrill({
      yoloRoot: YOLO_DIR,
      commandExists,
      now: () => 123,
      random: () => 0.5,
      runPackageInstallSmoke: () => ({ status: "blocked", exit_code: 1, summary: "install failed" }),
      runWorkflowSkillTargetSmoke: passingWorkflowTargetSmoke,
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "PACKAGE_INSTALL_SMOKE_PASS"));
    assert.equal(result.guarantees.published, false);
    assert.equal(result.guarantees.package_private_unchanged, true);
  });
});
