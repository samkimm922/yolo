import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspectFixtureRegistry } from "../fixtures/registry.js";
import { inspectRunnerRuntimeApiFreeze } from "../runtime/run-lifecycle/runtime-api-freeze.js";
import { runPublicBetaHardeningDrill } from "./hardening-drill.js";

export const LOCAL_DOGFOOD_EVIDENCE_SCHEMA_VERSION = "1.0";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function check(code, passed, message, extra = {}) {
  return { code, passed, message, ...extra };
}

function hasNoReleaseSideEffects(hardeningDrill = {}) {
  return hardeningDrill.guarantees?.published === false
    && hardeningDrill.guarantees?.credential_access === false
    && hardeningDrill.guarantees?.billable_provider_execution === false
    && hardeningDrill.guarantees?.provider_execution_allowed === false;
}

function runtimeImplementationReady(runtimeApiFreeze = {}) {
  if (runtimeApiFreeze.implementation_ready === true) return true;
  const blockers = runtimeApiFreeze.blockers || [];
  return blockers.length > 0 && blockers.every((blocker) => blocker.code === "RUNTIME_API_BOUNDARY_STABLE");
}

export function buildLocalDogfoodEvidencePlan(options = {}) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  return {
    schema_version: LOCAL_DOGFOOD_EVIDENCE_SCHEMA_VERSION,
    schema: "yolo.release.local_dogfood_evidence_plan.v1",
    yolo_root: yoloRoot,
    writes_workspace: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    publishes_dogfood_report: false,
    public_claim: false,
    required_evidence: [
      "public beta hardening drill pass",
      "fixture registry pass with cross-project coverage",
      "runtime API freeze implementation-ready report",
      "explicit marker that this is local evidence, not a public dogfood report",
    ],
  };
}

export function runLocalDogfoodEvidenceDrill(options = {}) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const packageJson = options.packageJson || readJson(join(yoloRoot, "package.json"));
  const plan = options.plan || buildLocalDogfoodEvidencePlan({ yoloRoot });
  const hardeningDrill = options.hardeningDrill || options.hardening_drill || (options.runPublicBetaHardeningDrill || runPublicBetaHardeningDrill)({
    yoloRoot,
    timeout_ms: options.timeout_ms || 120000,
    keepWorkspace: options.keepWorkspace === true,
    commandExists: options.commandExists,
    now: options.now,
    random: options.random,
    providerConfigs: options.providerConfigs,
  });
  const fixtureRegistry = options.fixtureRegistry || options.fixture_registry || (options.inspectFixtureRegistry || inspectFixtureRegistry)({ yoloRoot });
  const runtimeApiFreeze = options.runtimeApiFreeze || options.runtime_api_freeze || (options.inspectRunnerRuntimeApiFreeze || inspectRunnerRuntimeApiFreeze)({
    yoloRoot,
    packageJson,
    apiBoundary: options.apiBoundary || options.api_boundary,
    maxRunnerCoreLines: options.maxRunnerCoreLines || options.max_runner_core_lines,
  });
  const minFixtureCount = options.minFixtureCount || options.min_fixture_count || 9;

  const checks = [
    check(
      "LOCAL_DOGFOOD_NO_SIDE_EFFECTS",
      plan.writes_workspace === false
        && plan.publishes === false
        && plan.reads_credentials === false
        && plan.spawns_provider === false
        && plan.executes_billable_provider === false
        && plan.publishes_dogfood_report === false,
      "local dogfood evidence must not mutate workspace, publish, read credentials, execute providers, or publish reports",
    ),
    check(
      "LOCAL_DOGFOOD_HARDENING_PASS",
      hardeningDrill.status === "pass",
      "public beta hardening drill must pass before local dogfood evidence is trusted",
      { hardening_status: hardeningDrill.status },
    ),
    check(
      "LOCAL_DOGFOOD_HARDENING_NO_RELEASE_SIDE_EFFECTS",
      hasNoReleaseSideEffects(hardeningDrill),
      "hardening evidence must prove no SDK publish, credentials, provider execution, or billable execution",
    ),
    check(
      "LOCAL_DOGFOOD_FIXTURE_COVERAGE",
      fixtureRegistry.status === "pass" && fixtureRegistry.fixture_count >= minFixtureCount,
      "fixture registry must pass with enough cross-project coverage",
      { fixture_count: fixtureRegistry.fixture_count || 0, min_fixture_count: minFixtureCount },
    ),
    check(
      "LOCAL_DOGFOOD_RUNTIME_IMPLEMENTATION_READY",
      runtimeImplementationReady(runtimeApiFreeze),
      "runtime implementation must be freeze-ready apart from explicit public API boundary approval",
      {
        runtime_freeze_status: runtimeApiFreeze.status,
        implementation_blockers: (runtimeApiFreeze.implementation_blockers || []).map((blocker) => blocker.code),
      },
    ),
    check(
      "LOCAL_DOGFOOD_NOT_PUBLIC_CLAIM",
      plan.public_claim === false,
      "local dogfood evidence must not claim public dogfood publication",
    ),
  ];

  const blockers = checks.filter((item) => item.passed !== true);
  return {
    schema_version: LOCAL_DOGFOOD_EVIDENCE_SCHEMA_VERSION,
    schema: "yolo.release.local_dogfood_evidence_result.v1",
    status: blockers.length > 0 ? "blocked" : "pass",
    yolo_root: yoloRoot,
    package: {
      name: packageJson.name || null,
      version: packageJson.version || null,
      private: packageJson.private === true,
    },
    plan,
    checks,
    blockers,
    components: {
      hardening_drill: hardeningDrill,
      fixture_registry: fixtureRegistry,
      runtime_api_freeze: runtimeApiFreeze,
    },
    dogfood_report: {
      status: blockers.length > 0 ? "blocked" : "pass",
      public: false,
      local_only: true,
      privacy_reviewed: false,
      publication_approved: false,
      evidence_files: [
        "docs/yolo-public-sdk-progress.md",
        "docs/sdk-gap-matrix.md",
      ],
    },
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      dogfood_report_published: false,
      public_dogfood_claimed: false,
    },
    next_actions: blockers.length === 0
      ? [
          "Local dogfood evidence is ready for human review.",
          "Do not treat this as public dogfood until a privacy-reviewed public report is approved and published outside the SDK.",
        ]
      : ["Resolve local dogfood evidence blockers before requesting public dogfood review."],
  };
}
