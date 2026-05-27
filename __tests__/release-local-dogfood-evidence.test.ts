import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLocalDogfoodEvidencePlan,
  LOCAL_DOGFOOD_EVIDENCE_SCHEMA_VERSION,
  runLocalDogfoodEvidenceDrill,
} from "../src/release/local-dogfood-evidence.js";
import {
  exportedRunCallsProcessExit,
  inspectRunnerRuntimeApiFreeze,
} from "../src/runtime/run-lifecycle/runtime-api-freeze.js";

const stablePackage = {
  name: "yolo",
  version: "0.1.0",
  private: true,
  exports: { "./runtime": "./dist/src/runtime/runner-runtime.js" },
};

function hardeningDrill(overrides = {}) {
  return {
    status: "pass",
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

function fixtureRegistry(overrides = {}) {
  return {
    status: "pass",
    fixture_count: 9,
    ...overrides,
  };
}

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

describe("local dogfood evidence drill", () => {
  test("buildLocalDogfoodEvidencePlan is non-publishing and local-only", () => {
    const plan = buildLocalDogfoodEvidencePlan({ yoloRoot: "/tmp/yolo" });

    assert.equal(plan.schema_version, LOCAL_DOGFOOD_EVIDENCE_SCHEMA_VERSION);
    assert.equal(plan.writes_workspace, false);
    assert.equal(plan.publishes, false);
    assert.equal(plan.reads_credentials, false);
    assert.equal(plan.executes_billable_provider, false);
    assert.equal(plan.publishes_dogfood_report, false);
    assert.equal(plan.public_claim, false);
  });

  test("passes with hardening, fixture coverage, and implementation-ready runtime freeze", () => {
    const result = runLocalDogfoodEvidenceDrill({
      yoloRoot: "/tmp/yolo",
      packageJson: stablePackage,
      hardeningDrill: hardeningDrill(),
      fixtureRegistry: fixtureRegistry(),
      runtimeApiFreeze: runtimeApiFreeze(),
    });

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.dogfood_report.public, false);
    assert.equal(result.dogfood_report.local_only, true);
    assert.equal(result.guarantees.public_dogfood_claimed, false);
    assert.equal(result.guarantees.billable_provider_execution, false);
  });

  test("blocks if hardening has side effects or fixtures are under-covered", () => {
    const result = runLocalDogfoodEvidenceDrill({
      yoloRoot: "/tmp/yolo",
      packageJson: stablePackage,
      hardeningDrill: hardeningDrill({
        guarantees: {
          published: true,
          provider_execution_allowed: false,
          billable_provider_execution: false,
          credential_access: false,
        },
      }),
      fixtureRegistry: fixtureRegistry({ fixture_count: 3 }),
      runtimeApiFreeze: runtimeApiFreeze(),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "LOCAL_DOGFOOD_HARDENING_NO_RELEASE_SIDE_EFFECTS"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "LOCAL_DOGFOOD_FIXTURE_COVERAGE"));
  });

  test("blocks runtime implementation blockers while allowing boundary-only blockers", () => {
    const result = runLocalDogfoodEvidenceDrill({
      yoloRoot: "/tmp/yolo",
      packageJson: stablePackage,
      hardeningDrill: hardeningDrill(),
      fixtureRegistry: fixtureRegistry(),
      runtimeApiFreeze: runtimeApiFreeze({
        implementation_ready: false,
        implementation_blockers: [{ code: "RUNTIME_CORE_LINE_BUDGET" }],
        blockers: [
          { code: "RUNTIME_API_BOUNDARY_STABLE" },
          { code: "RUNTIME_CORE_LINE_BUDGET" },
        ],
      }),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "LOCAL_DOGFOOD_RUNTIME_IMPLEMENTATION_READY"));
  });
});

describe("runtime API freeze inspector precision", () => {
  test("does not treat runCli process.exit as SDK run() process exit", () => {
    const source = [
      "export async function run() {",
      "  return { exit_code: 0 };",
      "}",
      "export async function runCli() {",
      "  process.exit(1);",
      "}",
      "",
    ].join("\n");

    assert.equal(exportedRunCallsProcessExit(source), false);
    const result = inspectRunnerRuntimeApiFreeze({
      yoloRoot: "/tmp/yolo",
      packageJson: stablePackage,
      apiBoundary: { package_exports: [{ export: "./runtime", target: "./dist/src/runtime/runner-runtime.js", tier: "stable" }] },
      runnerCoreSource: source,
      maxRunnerCoreLines: 6,
    });

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.runner_core_lines, 6);
  });

  test("current runtime freeze implementation is ready apart from explicit API boundary decision", () => {
    const result = inspectRunnerRuntimeApiFreeze({ yoloRoot: process.cwd() });

    assert.equal(result.implementation_ready, true, JSON.stringify(result.implementation_blockers, null, 2));
    assert.equal(result.stable_boundary_decision_required, true);
    assert.ok(result.blockers.every((blocker) => blocker.code === "RUNTIME_API_BOUNDARY_STABLE"));
  });
});
