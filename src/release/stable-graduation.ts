import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspectPublicBetaReadiness } from "./readiness.js";
import { runPostReleaseAuditGate } from "./post-release-audit.js";
import { inspectRunnerRuntimeApiFreeze } from "../runtime/run-lifecycle/runtime-api-freeze.js";

export const STABLE_GRADUATION_SCHEMA_VERSION = "1.0";

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DEFAULT_MAX_ROOT_ENTRYPOINTS = 8;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function check(code, passed, message, extra = Object()) {
  return { code, passed, message, ...extra };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function stableSemver(version) {
  const match = SEMVER_RE.exec(version || "");
  return Boolean(match) && Number(match[1]) >= 1;
}

function countRootMjs(yoloRoot) {
  return readdirSync(yoloRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .length;
}

function stabilityReviewApproved(review = Object()) {
  return review.approved === true
    && nonEmptyString(review.approver)
    && validTimestamp(review.approved_at)
    && review.version_policy_reviewed === true
    && review.api_boundary_reviewed === true
    && review.breaking_changes_reviewed === true
    && review.deprecation_policy_reviewed === true
    && nonEmptyString(review.rollback_plan);
}

function dogfoodEvidencePublic(postReleaseAudit = Object()) {
  const dogfoodAudit = postReleaseAudit.components?.dogfood_audit || postReleaseAudit.dogfood_audit || {};
  return dogfoodAudit.status === "pass"
    && nonEmptyString(dogfoodAudit.public_url || dogfoodAudit.report_path || dogfoodAudit.artifact_path);
}

export function buildStableGraduationPlan(options = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  return {
    schema_version: STABLE_GRADUATION_SCHEMA_VERSION,
    schema: "yolo.release.stable_graduation_plan.v1",
    yolo_root: yoloRoot,
    writes_workspace: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    publishes_dogfood_report: false,
    max_root_entrypoints: options.maxRootEntrypoints || options.max_root_entrypoints || DEFAULT_MAX_ROOT_ENTRYPOINTS,
    required_evidence: [
      "post-release audit pass",
      "package is public and version is stable semver >=1.0.0",
      "public beta readiness pass after private removal",
      "root entrypoint count is within the stable release budget",
      "stability review approves version policy, API boundary, breaking changes, deprecation policy, and rollback plan",
      "runner runtime API is frozen for stable callers",
      "public dogfood evidence is linked",
    ],
    stop_conditions: [
      "post-release audit has blockers",
      "package is private or still on 0.x",
      "public beta readiness does not pass after release-state mutation",
      "root scripts still exceed stable release budget",
      "stability review or runtime API freeze is missing",
    ],
  };
}

export function runStableGraduationGate(options = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const packageJson = options.packageJson || readJson(join(yoloRoot, "package.json"));
  const plan = options.plan || buildStableGraduationPlan({
    yoloRoot,
    maxRootEntrypoints: options.maxRootEntrypoints || options.max_root_entrypoints,
  });
  const postReleaseAudit = options.postReleaseAudit || options.post_release_audit || (options.runPostReleaseAuditGate || runPostReleaseAuditGate)({
    yoloRoot,
    timeout_ms: options.timeout_ms || 120000,
    commandExists: options.commandExists,
    now: options.now,
    random: options.random,
    providerConfigs: options.providerConfigs,
  });
  const readiness = options.readiness || options.publicBetaReadiness || options.public_beta_readiness || (options.inspectPublicBetaReadiness || inspectPublicBetaReadiness)({
    yoloRoot,
    packageJson,
  });
  const stabilityReview = options.stabilityReview || options.stability_review || {};
  const rootEntrypointCount = options.rootEntrypointCount ?? options.root_entrypoint_count ?? countRootMjs(yoloRoot);
  const hasRuntimeApiFrozenOption = Object.hasOwn(options, "runnerRuntimeApiFrozen")
    || Object.hasOwn(options, "runner_runtime_api_frozen");
  const runtimeApiFreeze = options.runtimeApiFreeze || options.runtime_api_freeze || (
    hasRuntimeApiFrozenOption
      ? { status: options.runnerRuntimeApiFrozen === true || options.runner_runtime_api_frozen === true ? "pass" : "blocked", frozen: options.runnerRuntimeApiFrozen === true || options.runner_runtime_api_frozen === true, checks: [], blockers: [] }
      : (options.inspectRunnerRuntimeApiFreeze || inspectRunnerRuntimeApiFreeze)({
          yoloRoot,
          packageJson,
          apiBoundary: options.apiBoundary || options.api_boundary,
          maxRunnerCoreLines: options.maxRunnerCoreLines || options.max_runner_core_lines,
        })
  );
  const runtimeApiFrozen = options.runnerRuntimeApiFrozen === true
    || options.runner_runtime_api_frozen === true
    || runtimeApiFreeze?.frozen === true
    || runtimeApiFreeze?.status === "pass";

  const checks = [
    check(
      "STABLE_GRADUATION_NO_SIDE_EFFECTS",
      plan.writes_workspace === false
        && plan.publishes === false
        && plan.reads_credentials === false
        && plan.spawns_provider === false
        && plan.executes_billable_provider === false
        && plan.publishes_dogfood_report === false,
      "stable graduation gate must not publish, mutate workspace, read credentials, execute providers, or publish dogfood reports",
    ),
    check(
      "STABLE_GRADUATION_POST_RELEASE_AUDIT_PASS",
      postReleaseAudit.status === "pass",
      "post-release audit must pass before stable graduation",
      { post_release_status: postReleaseAudit.status, post_release_blockers: (postReleaseAudit.blockers || []).map((item) => item.code) },
    ),
    check(
      "STABLE_GRADUATION_PACKAGE_PUBLIC",
      packageJson.private !== true,
      "stable package must not be private",
      { package_private: packageJson.private === true },
    ),
    check(
      "STABLE_GRADUATION_VERSION_STABLE",
      stableSemver(packageJson.version),
      "stable graduation requires semver >= 1.0.0",
      { version: packageJson.version || null },
    ),
    check(
      "STABLE_GRADUATION_READINESS_PASS",
      readiness.status === "pass" && readiness.blocks_release !== true,
      "public beta readiness must pass without release blockers after release-state mutation",
      { readiness_status: readiness.status, blocks_release: readiness.blocks_release === true },
    ),
    check(
      "STABLE_GRADUATION_ROOT_ENTRYPOINT_BUDGET",
      rootEntrypointCount <= plan.max_root_entrypoints,
      "root .js entrypoints must be within the stable release budget",
      { root_entrypoint_count: rootEntrypointCount, max_root_entrypoints: plan.max_root_entrypoints },
    ),
    check(
      "STABLE_GRADUATION_STABILITY_REVIEW_APPROVED",
      stabilityReviewApproved(stabilityReview),
      "stability review must approve version policy, API boundary, breaking changes, deprecation policy, and rollback plan",
    ),
    check(
      "STABLE_GRADUATION_RUNTIME_API_FROZEN",
      runtimeApiFrozen,
      "runner runtime API must be frozen before stable graduation",
      { runtime_api_freeze_status: runtimeApiFreeze?.status || null },
    ),
    check(
      "STABLE_GRADUATION_PUBLIC_DOGFOOD_EVIDENCE",
      dogfoodEvidencePublic(postReleaseAudit),
      "stable graduation requires public dogfood evidence from the post-release audit",
    ),
  ];

  const blockers = checks.filter((item) => item.passed !== true);
  return {
    schema_version: STABLE_GRADUATION_SCHEMA_VERSION,
    schema: "yolo.release.stable_graduation_result.v1",
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
    metrics: {
      root_entrypoint_count: rootEntrypointCount,
      max_root_entrypoints: plan.max_root_entrypoints,
    },
    components: {
      post_release_audit: postReleaseAudit,
      readiness,
      stability_review: stabilityReview,
      runtime_api_freeze: runtimeApiFreeze,
    },
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      publish_command_executed: false,
      dogfood_report_published: false,
      stable_graduation_declared: blockers.length === 0,
    },
    next_actions: blockers.length === 0
      ? ["Stable graduation gate passed. Freeze the documented API and publish stable release notes."]
      : ["Resolve stable graduation blockers before treating YOLO as a stable public SDK."],
  };
}
