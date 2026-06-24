import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspectRunnerRuntimeApiFreeze } from "../runtime/run-lifecycle/runtime-api-freeze.js";
import type { ReleaseCheck, ReleaseIssue, ReleaseRecord } from "./readiness.js";

export const RUNTIME_BOUNDARY_CANDIDATE_SCHEMA_VERSION = "1.0";

const DEFAULT_RUNTIME_EXPORT = "./runtime";
const DEFAULT_RUNTIME_TARGET = "./dist/src/runtime/runner-runtime.js";

export interface PackageJsonLike extends ReleaseRecord {
  name?: string;
  version?: string;
  private?: boolean;
  exports?: Record<string, string>;
}

export interface ApiBoundaryEntry extends ReleaseRecord {
  export?: string;
  target?: string;
  tier?: string;
}

export interface ApiBoundaryDocument extends ReleaseRecord {
  package_exports?: ApiBoundaryEntry[];
}

export interface RuntimeApiFreezeReport extends ReleaseRecord {
  status?: string;
  implementation_ready?: boolean;
  implementation_blockers?: ReleaseIssue[];
  blockers?: ReleaseIssue[];
}

export interface RuntimeBoundaryCandidatePlan extends ReleaseRecord {
  yolo_root: string;
  target_export: string;
  expected_target: string;
  current_tier_expected: string;
  proposed_tier: string;
  public_api_change_required: boolean;
  requires_human_approval: boolean;
  applies_changes: boolean;
  writes_workspace: boolean;
  publishes: boolean;
  reads_credentials: boolean;
  spawns_provider: boolean;
  executes_billable_provider: boolean;
  publishes_dogfood_report: boolean;
}

export interface RuntimeBoundaryCandidateOptions extends ReleaseRecord {
  yoloRoot?: string;
  cwd?: string;
  packageJson?: PackageJsonLike;
  apiBoundary?: ApiBoundaryDocument;
  api_boundary?: ApiBoundaryDocument;
  plan?: RuntimeBoundaryCandidatePlan;
  targetExport?: string;
  target_export?: string;
  expectedTarget?: string;
  expected_target?: string;
  runtimeApiFreeze?: RuntimeApiFreezeReport;
  runtime_api_freeze?: RuntimeApiFreezeReport;
  inspectRunnerRuntimeApiFreeze?: (options: ReleaseRecord) => RuntimeApiFreezeReport;
  maxRunnerCoreLines?: number;
  max_runner_core_lines?: number;
}

function readJson(filePath: string): ReleaseRecord {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function check(code: string, passed: boolean, message: string, extra: ReleaseRecord = Object()): ReleaseCheck {
  return { code, passed, message, ...extra };
}

function boundaryEntry(apiBoundary: ApiBoundaryDocument, exportName: string): ApiBoundaryEntry | null {
  return (apiBoundary.package_exports || []).find((entry) => entry.export === exportName) || null;
}

function implementationReady(runtimeApiFreeze: RuntimeApiFreezeReport = Object()): boolean {
  if (runtimeApiFreeze.implementation_ready === true) return true;
  const blockers = runtimeApiFreeze.blockers || [];
  return blockers.length > 0 && blockers.every((blocker) => blocker.code === "RUNTIME_API_BOUNDARY_STABLE");
}

function implementationBlockerCodes(runtimeApiFreeze: RuntimeApiFreezeReport = Object()): string[] {
  if (Array.isArray(runtimeApiFreeze.implementation_blockers)) {
    return runtimeApiFreeze.implementation_blockers.map((blocker) => blocker.code);
  }
  return (runtimeApiFreeze.blockers || [])
    .filter((blocker) => blocker.code !== "RUNTIME_API_BOUNDARY_STABLE")
    .map((blocker) => blocker.code);
}

export function buildRuntimeBoundaryCandidatePlan(options: RuntimeBoundaryCandidateOptions = Object()): RuntimeBoundaryCandidatePlan {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const targetExport = options.targetExport || options.target_export || DEFAULT_RUNTIME_EXPORT;
  return {
    schema_version: RUNTIME_BOUNDARY_CANDIDATE_SCHEMA_VERSION,
    schema: "yolo.release.runtime_boundary_candidate_plan.v1",
    yolo_root: yoloRoot,
    target_export: targetExport,
    expected_target: options.expectedTarget || options.expected_target || DEFAULT_RUNTIME_TARGET,
    current_tier_expected: "experimental",
    proposed_tier: "stable",
    public_api_change_required: true,
    requires_human_approval: true,
    applies_changes: false,
    writes_workspace: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    publishes_dogfood_report: false,
    required_evidence: [
      "runtime API freeze report has zero implementation blockers",
      "package export target still points at the runner runtime facade",
      "current API boundary classifies the runtime export as experimental",
      "human stability review explicitly approves the stable boundary promotion",
    ],
    stop_conditions: [
      "runtime implementation blockers are present",
      "package export target no longer matches the documented runtime facade",
      "the API boundary tier changed outside an explicit stability review",
      "public release or dogfood evidence is being claimed without external operator proof",
    ],
  };
}

export function inspectRuntimeBoundaryCandidate(options: RuntimeBoundaryCandidateOptions = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const packageJson: PackageJsonLike = options.packageJson || readJson(join(yoloRoot, "package.json"));
  const apiBoundary: ApiBoundaryDocument = options.apiBoundary || options.api_boundary || readJson(join(yoloRoot, "docs/public-sdk-api-boundary.json"));
  const plan = options.plan || buildRuntimeBoundaryCandidatePlan({
    yoloRoot,
    targetExport: options.targetExport || options.target_export,
    expectedTarget: options.expectedTarget || options.expected_target,
  });
  const runtimeApiFreeze: RuntimeApiFreezeReport = options.runtimeApiFreeze || options.runtime_api_freeze || (options.inspectRunnerRuntimeApiFreeze || inspectRunnerRuntimeApiFreeze)({
    yoloRoot,
    packageJson,
    apiBoundary,
    maxRunnerCoreLines: options.maxRunnerCoreLines || options.max_runner_core_lines,
  });

  const runtimeBoundary = boundaryEntry(apiBoundary, plan.target_export);
  const actualTarget = packageJson.exports?.[plan.target_export] || null;
  const currentTier = runtimeBoundary?.tier || null;
  const implementationBlockers = implementationBlockerCodes(runtimeApiFreeze);
  const checks = [
    check(
      "RUNTIME_BOUNDARY_CANDIDATE_NO_SIDE_EFFECTS",
      plan.writes_workspace === false
        && plan.publishes === false
        && plan.reads_credentials === false
        && plan.spawns_provider === false
        && plan.executes_billable_provider === false
        && plan.publishes_dogfood_report === false
        && plan.applies_changes === false,
      "runtime boundary candidate inspection must not mutate workspace, publish, read credentials, execute providers, publish reports, or apply API changes",
    ),
    check(
      "RUNTIME_BOUNDARY_CANDIDATE_EXPORT_TARGET",
      actualTarget === plan.expected_target,
      `${plan.target_export} must still point at ${plan.expected_target}`,
      { export: plan.target_export, expected_target: plan.expected_target, actual_target: actualTarget },
    ),
    check(
      "RUNTIME_BOUNDARY_CANDIDATE_CURRENT_TIER_EXPERIMENTAL",
      currentTier === plan.current_tier_expected,
      `${plan.target_export} must still be experimental until the human stable-boundary decision is applied`,
      { export: plan.target_export, current_tier: currentTier, expected_tier: plan.current_tier_expected },
    ),
    check(
      "RUNTIME_BOUNDARY_CANDIDATE_IMPLEMENTATION_READY",
      implementationReady(runtimeApiFreeze),
      "runtime implementation must be freeze-ready apart from the explicit public API boundary decision",
      {
        runtime_freeze_status: runtimeApiFreeze.status || null,
        implementation_blockers: implementationBlockers,
      },
    ),
    check(
      "RUNTIME_BOUNDARY_CANDIDATE_HUMAN_APPROVAL_GATE",
      plan.requires_human_approval === true && plan.public_api_change_required === true,
      "runtime stable promotion must remain a human-approved public API boundary change",
    ),
  ];

  const blockers = checks.filter((item) => item.passed !== true);
  const readyForDecision = blockers.length === 0;
  return {
    schema_version: RUNTIME_BOUNDARY_CANDIDATE_SCHEMA_VERSION,
    schema: "yolo.release.runtime_boundary_candidate_result.v1",
    status: readyForDecision ? "ready_for_decision" : "blocked",
    yolo_root: yoloRoot,
    package: {
      name: packageJson.name || null,
      version: packageJson.version || null,
      private: packageJson.private === true,
    },
    candidate: {
      export: plan.target_export,
      target: actualTarget,
      current_tier: currentTier,
      proposed_tier: plan.proposed_tier,
      public_api_change_required: true,
      ready_for_decision: readyForDecision,
      can_apply_without_human_approval: false,
    },
    plan,
    checks,
    blockers,
    components: {
      api_boundary_entry: runtimeBoundary,
      runtime_api_freeze: runtimeApiFreeze,
    },
    decision: {
      required: true,
      approved: false,
      approval_record_required: true,
      gate: "explicit_human_runtime_boundary_approval",
    },
    suggested_changes: readyForDecision
      ? [
          {
            file: "docs/public-sdk-api-boundary.json",
            action: "after approval, change ./runtime tier from experimental to stable and replace the reason with the approved stability note",
            applies_automatically: false,
          },
          {
            file: "docs/public-sdk-contract.md",
            action: "after approval, move yolo/runtime from Experimental to Stable and document compatibility expectations",
            applies_automatically: false,
          },
          {
            file: "docs/api-reference.md",
            action: "after approval, list yolo/runtime under stable package exports and update release blockers",
            applies_automatically: false,
          },
          {
            file: "CHANGELOG.md",
            action: "after approval, record the stable runtime boundary promotion and rollback notes",
            applies_automatically: false,
          },
        ]
      : [],
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      dogfood_report_published: false,
      boundary_changed: false,
      stable_runtime_declared: false,
    },
    next_actions: readyForDecision
      ? [
          "Ask a human operator to approve or reject the runtime stable-boundary promotion.",
          "Do not change docs/public-sdk-api-boundary.json tier until that approval exists.",
        ]
      : ["Resolve runtime boundary candidate blockers before asking for a stable-boundary decision."],
  };
}
