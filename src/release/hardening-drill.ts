import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { config as defaultConfig } from "../core/config.js";
import { inspectFixtureRegistry } from "../fixtures/registry.js";
import { inspectProviderCliDryRunMatrix } from "../runtime/adapters/provider-runtime-matrix.js";
import { runWorkflowSkillTargetSmoke } from "../workflows/install.js";
import { runPackageInstallSmoke } from "./pack-smoke.js";
import { inspectPublicBetaReadiness } from "./readiness.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS } from "../lib/toolchain.js";
import type { ReleaseCheck, ReleaseIssue, ReleaseRecord } from "./readiness.js";

export const PUBLIC_BETA_HARDENING_DRILL_SCHEMA_VERSION = "1.0";

const DEFAULT_PROVIDER_COMMANDS = new Set(["claude", "codex", "cat", "node", "sh"]);

export interface PackageJsonLike extends ReleaseRecord {
  private?: boolean;
}

export interface ReadinessResult extends ReleaseRecord {
  status?: string;
  blocks_release?: boolean;
  blockers?: ReleaseIssue[];
  checks?: ReleaseCheck[];
}

export interface ProviderMatrixEntry extends ReleaseRecord {
  dry_run?: boolean;
  execution_allowed?: boolean;
  will_spawn?: boolean;
  stop_conditions?: string[];
}

export interface ProviderCliDryRunResult extends ReleaseRecord {
  status?: string;
  blocks_execution?: boolean;
  warnings?: unknown[];
  matrix?: {
    dry_run?: boolean;
    execution_allowed?: boolean;
    providers?: ProviderMatrixEntry[];
    stop_conditions?: string[];
  };
}

export interface ComponentResult extends ReleaseRecord {
  status?: string;
  dry_run?: boolean;
  summary?: string;
  fixture_count?: number;
}

export interface PublicBetaHardeningPlan extends ReleaseRecord {
  publish_allowed: boolean;
  external_publish_commands_allowed: boolean;
  package_private_mutation_allowed: boolean;
  billable_provider_execution_allowed: boolean;
  credential_access_allowed: boolean;
  steps: ReleaseRecord[];
}

export interface PublicBetaHardeningOptions extends ReleaseRecord {
  yoloRoot?: string;
  cwd?: string;
  plan?: PublicBetaHardeningPlan;
  commandExists?: (command: string) => boolean;
  inspectPublicBetaReadiness?: (options: ReleaseRecord) => ReadinessResult;
  packageInstall?: boolean;
  runPackageInstallSmoke?: (options: ReleaseRecord) => ComponentResult;
  timeout_ms?: number;
  keepWorkspace?: boolean;
  inspectFixtureRegistry?: (options: ReleaseRecord) => ComponentResult;
  inspectProviderCliDryRunMatrix?: (options: ReleaseRecord) => ProviderCliDryRunResult;
  config?: unknown;
  projectRoot?: string;
  stateRoot?: string;
  now?: unknown;
  random?: unknown;
  providerConfigs?: unknown;
  workflowTargetSmoke?: boolean;
  runWorkflowSkillTargetSmoke?: (options: ReleaseRecord) => ComponentResult;
}

function readJson(filePath: string): ReleaseRecord {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function check(code: string, passed: boolean, message: string, extra: ReleaseRecord = Object()): ReleaseCheck {
  return { code, passed, message, ...extra };
}

function packagePrivateBlocker(readiness: ReadinessResult = Object()): boolean {
  return (readiness.blockers || []).some((item) => item.code === "PACKAGE_PRIVATE_RELEASE_BLOCK");
}

function providerDryRunSafe(providerCliDryRun: ProviderCliDryRunResult = Object()): boolean {
  const matrix = providerCliDryRun.matrix || {};
  return matrix.dry_run === true
    && matrix.execution_allowed === false
    && (matrix.providers || []).every((entry) =>
      entry.dry_run === true && entry.execution_allowed === false && entry.will_spawn === false
    );
}

function providerCredentialStopConditionPresent(providerCliDryRun: ProviderCliDryRunResult = Object()): boolean {
  const matrix = providerCliDryRun.matrix || {};
  const text = [
    ...(matrix.stop_conditions || []),
    ...(matrix.providers || []).flatMap((entry) => entry.stop_conditions || []),
  ].join("\n");
  return /credentials|billable|external network|model execution/i.test(text);
}

function prefixedChecks(readiness: ReadinessResult, prefix: string): ReleaseCheck[] {
  return (readiness.checks || []).filter((item) => item.code?.startsWith(prefix));
}

function allPassed(items: ReleaseCheck[] = []): boolean {
  return items.length > 0 && items.every((item) => item.passed === true);
}

function runWorkflowTargetSmokeInTemp({
  yoloRoot,
  runWorkflowSkillTargetSmokeImpl = runWorkflowSkillTargetSmoke,
}: { yoloRoot?: string; runWorkflowSkillTargetSmokeImpl?: (options: ReleaseRecord) => ComponentResult } = Object()): ComponentResult {
  const workspace = mkdtempSync(join(tmpdir(), "yolo-release-workflow-smoke-"));
  try {
    return runWorkflowSkillTargetSmokeImpl({
      projectRoot: workspace,
      packageRoot: yoloRoot,
      targets: ["yolo", "agents", "claude", "codex"],
      workflows: ["fix", "review", "ship"],
      forbiddenPackageDirs: [".yolo", ".agents", ".claude", ".codex"],
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export function buildPublicBetaHardeningDrillPlan(options: PublicBetaHardeningOptions = Object()): PublicBetaHardeningPlan {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  return {
    schema_version: PUBLIC_BETA_HARDENING_DRILL_SCHEMA_VERSION,
    schema: "yolo.release.public_beta_hardening_drill.v1",
    yolo_root: yoloRoot,
    publish_allowed: false,
    package_private_mutation_allowed: false,
    billable_provider_execution_allowed: false,
    credential_access_allowed: false,
    external_publish_commands_allowed: false,
    expected_release_blocker: "PACKAGE_PRIVATE_RELEASE_BLOCK",
    steps: [
      {
        id: "release_readiness",
        purpose: "Run public beta readiness checks and keep private=true as a fail-closed release blocker.",
        writes_workspace: false,
        publishes: false,
        spawns_provider: false,
      },
      {
        id: "package_install_smoke",
        purpose: "Run npm pack/install/import/bin smoke in a temporary external consumer project.",
        writes_workspace: false,
        writes_temp: true,
        publishes: false,
        spawns_provider: false,
      },
      {
        id: "fixture_registry",
        purpose: "Verify every public beta fixture is registered and structurally executable.",
        writes_workspace: false,
        publishes: false,
        spawns_provider: false,
      },
      {
        id: "api_boundary_docs",
        purpose: "Verify package exports, SDK namespaces, version policy, API docs, and fixture matrix consistency.",
        writes_workspace: false,
        publishes: false,
        spawns_provider: false,
      },
      {
        id: "provider_cli_dry_run",
        purpose: "Describe provider CLI contracts without executing model providers or requiring credentials.",
        writes_workspace: false,
        publishes: false,
        spawns_provider: false,
      },
      {
        id: "workflow_target_smoke",
        purpose: "Install workflow skill artifacts into a temporary project target matrix.",
        writes_workspace: false,
        writes_temp: true,
        publishes: false,
        spawns_provider: false,
      },
    ],
  };
}

export function runPublicBetaHardeningDrill(options: PublicBetaHardeningOptions = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const packageJsonPath = join(yoloRoot, "package.json");
  const packageBefore: PackageJsonLike = readJson(packageJsonPath);
  const plan = options.plan || buildPublicBetaHardeningDrillPlan({ yoloRoot });
  const commandExists = options.commandExists || ((command: string) => DEFAULT_PROVIDER_COMMANDS.has(command));

  const readiness = (options.inspectPublicBetaReadiness || inspectPublicBetaReadiness)({ yoloRoot });
  const packageInstall = options.packageInstall === false
    ? { status: "skipped", dry_run: true, summary: "package install smoke skipped by caller" }
    : (options.runPackageInstallSmoke || runPackageInstallSmoke)({
        yoloRoot,
        timeout_ms: options.timeout_ms || DEFAULT_EXECUTOR_TIMEOUT_MS,
        keepWorkspace: options.keepWorkspace === true,
      });
  const fixtureRegistry = (options.inspectFixtureRegistry || inspectFixtureRegistry)({ yoloRoot });
  const providerCliDryRun = (options.inspectProviderCliDryRunMatrix || inspectProviderCliDryRunMatrix)({
    config: options.config || defaultConfig,
    projectRoot: options.projectRoot || yoloRoot,
    stateRoot: options.stateRoot || join(yoloRoot, ".yolo"),
    commandExists,
    now: options.now,
    random: options.random,
    providerConfigs: options.providerConfigs,
  });
  const workflowTargetSmoke = options.workflowTargetSmoke === false
    ? { status: "skipped", summary: "workflow target smoke skipped by caller" }
    : (options.runWorkflowSkillTargetSmoke
        ? options.runWorkflowSkillTargetSmoke({ yoloRoot })
        : runWorkflowTargetSmokeInTemp({ yoloRoot }));
  const packageAfter: PackageJsonLike = readJson(packageJsonPath);

  const apiBoundaryChecks = prefixedChecks(readiness, "API_BOUNDARY_");
  const docChecks = prefixedChecks(readiness, "DOC_");
  const packageInstallPassed = packageInstall.status === "pass";
  const workflowTargetSmokePassed = workflowTargetSmoke.status === "pass";
  const privateBlockerExpected = packageBefore.private === true;

  const checks = [
    check(
      "DRILL_NO_PUBLISH",
      plan.publish_allowed === false && plan.external_publish_commands_allowed === false,
      "hardening drill must not publish or include external publish commands",
    ),
    check(
      "DRILL_PRIVATE_FIELD_UNCHANGED",
      packageBefore.private === packageAfter.private,
      "hardening drill must not mutate package.json private field",
      { before: packageBefore.private === true, after: packageAfter.private === true },
    ),
    check(
      "READINESS_EXECUTED",
      Array.isArray(readiness.checks) && readiness.checks.length > 0,
      "public beta readiness must execute package, docs, API boundary, and fixture checks",
      { status: readiness.status, check_count: readiness.checks?.length || 0 },
    ),
    check(
      "READINESS_PRIVATE_BLOCKER_EXPECTED",
      privateBlockerExpected ? packagePrivateBlocker(readiness) : readiness.blocks_release === false,
      "private=true must remain an intentional release blocker until a human release decision",
      { package_private: packageBefore.private === true, release_blocked: readiness.blocks_release === true },
    ),
    check(
      "PACKAGE_INSTALL_SMOKE_PASS",
      packageInstallPassed,
      "package install smoke must pass from an external temp consumer project",
      { status: packageInstall.status, exit_code: packageInstall.exit_code ?? null },
    ),
    check(
      "FIXTURE_REGISTRY_PASS",
      fixtureRegistry.status === "pass" && (fixtureRegistry.fixture_count || 0) > 0,
      "fixture registry must pass and include public beta fixtures",
      { fixture_count: fixtureRegistry.fixture_count || 0 },
    ),
    check(
      "API_BOUNDARY_DOCS_PASS",
      allPassed(apiBoundaryChecks),
      "API boundary checks must pass inside public beta readiness",
      { check_count: apiBoundaryChecks.length },
    ),
    check(
      "DOCS_CONSISTENCY_PASS",
      allPassed(docChecks),
      "release docs, API reference, fixture matrix, and changelog checks must pass",
      { check_count: docChecks.length },
    ),
    check(
      "PROVIDER_CLI_DRY_RUN_SAFE",
      providerCliDryRun.blocks_execution !== true && providerDryRunSafe(providerCliDryRun),
      "provider CLI matrix must remain dry-run and must not spawn model providers",
      { status: providerCliDryRun.status, warning_count: providerCliDryRun.warnings?.length || 0 },
    ),
    check(
      "PROVIDER_CREDENTIAL_STOP_CONDITION_PRESENT",
      providerCredentialStopConditionPresent(providerCliDryRun),
      "provider CLI dry-run matrix must stop before credentials, network calls, or billable execution",
    ),
    check(
      "WORKFLOW_TARGET_SMOKE_PASS",
      workflowTargetSmokePassed,
      "workflow target smoke must pass in a temporary target project",
      { status: workflowTargetSmoke.status },
    ),
  ];

  const blockers = checks.filter((item) => item.passed !== true);
  return {
    schema_version: PUBLIC_BETA_HARDENING_DRILL_SCHEMA_VERSION,
    schema: "yolo.release.public_beta_hardening_drill_result.v1",
    status: blockers.length > 0 ? "blocked" : "pass",
    blocks_release: readiness.blocks_release === true,
    release_status: readiness.status,
    release_blockers: readiness.blockers || [],
    yolo_root: yoloRoot,
    plan,
    checks,
    blockers,
    guarantees: {
      published: false,
      package_private_unchanged: packageBefore.private === packageAfter.private,
      provider_execution_allowed: false,
      billable_provider_execution: false,
      credential_access: false,
    },
    components: {
      readiness,
      package_install: packageInstall,
      fixture_registry: fixtureRegistry,
      provider_cli_dry_run: providerCliDryRun,
      workflow_target_smoke: workflowTargetSmoke,
    },
    next_actions: blockers.length > 0
      ? ["Fix hardening drill blockers before considering any public beta release decision."]
      : readiness.blocks_release
        ? ["Hardening drill passed; run the controlled beta release decision gate before changing private=true, publishing, touching credentials, or authorizing billable execution."]
        : ["Hardening drill passed and release readiness is unblocked; perform a final human release review before publishing."],
  };
}
