import { resolve } from "node:path";
import { runAgentIntegrationDoctor } from "./agent-integration-doctor.js";
import { runManualExternalReleaseGate } from "./manual-external-release.js";
import { runPiExecutionDrillGate } from "./pi-execution-drill.js";
import { runRealProjectDogfoodGate } from "./real-project-dogfood.js";
import { runRuntimeBoundaryDecisionGate } from "./runtime-boundary-decision.js";
import type { ReleaseCheck, ReleaseIssue, ReleaseRecord } from "./readiness.js";

export const PUBLIC_BETA_EVIDENCE_SCHEMA_VERSION = "1.0";

export type RealProjectDogfoodOptions = NonNullable<Parameters<typeof runRealProjectDogfoodGate>[0]>;

export interface PublicBetaEvidencePlan extends ReleaseRecord {
  yolo_root: string;
  project_root: string;
  release_scope: string;
  require_manual_external_release_evidence: boolean;
  require_runtime_stable_decision: boolean;
  writes_workspace: boolean;
  publishes: boolean;
  reads_credentials: boolean;
  spawns_provider: boolean;
  executes_billable_provider: boolean;
}

export interface ReleaseComponentResult extends ReleaseRecord {
  status?: string;
  blockers?: ReleaseIssue[];
  guarantees?: ReleaseRecord;
}

export interface PublicBetaEvidenceOptions extends ReleaseRecord {
  yoloRoot?: string;
  cwd?: string;
  projectRoot?: string;
  project_root?: string;
  releaseScope?: string;
  release_scope?: string;
  requireManualExternalReleaseEvidence?: boolean;
  require_manual_external_release_evidence?: boolean;
  requireRuntimeStableDecision?: boolean;
  require_runtime_stable_decision?: boolean;
  plan?: PublicBetaEvidencePlan;
  agentIntegration?: ReleaseComponentResult;
  agent_integration?: ReleaseComponentResult;
  realProjectDogfood?: ReleaseComponentResult;
  real_project_dogfood?: ReleaseComponentResult;
  piExecutionDrill?: ReleaseComponentResult;
  pi_execution_drill?: ReleaseComponentResult;
  runtimeBoundaryDecision?: ReleaseComponentResult;
  runtime_boundary_decision?: ReleaseComponentResult;
  manualExternalRelease?: ReleaseComponentResult;
  manual_external_release?: ReleaseComponentResult;
  homeDir?: string;
  home_dir?: string;
  targets?: unknown;
  scopes?: unknown;
  scope?: string;
  installScope?: string;
  install_scope?: string;
  planEvidence?: RealProjectDogfoodOptions["planEvidence"];
  plan_evidence?: RealProjectDogfoodOptions["plan_evidence"];
  checkEvidence?: RealProjectDogfoodOptions["checkEvidence"];
  check_evidence?: RealProjectDogfoodOptions["check_evidence"];
  reviewEvidence?: RealProjectDogfoodOptions["reviewEvidence"];
  review_evidence?: RealProjectDogfoodOptions["review_evidence"];
  dogfoodEvidence?: RealProjectDogfoodOptions["dogfoodEvidence"];
  dogfood_evidence?: RealProjectDogfoodOptions["dogfood_evidence"];
  executionEvidence?: ReleaseRecord;
  execution_evidence?: ReleaseRecord;
  authorization?: ReleaseRecord;
  billableAuthorization?: ReleaseRecord;
  billable_authorization?: ReleaseRecord;
  targetExport?: string;
  target_export?: string;
  decisionRecord?: ReleaseRecord;
  decision_record?: ReleaseRecord;
  runtimeBoundaryCandidate?: ReleaseComponentResult;
  runtime_boundary_candidate?: ReleaseComponentResult;
  packageJson?: ReleaseRecord;
  apiBoundary?: ReleaseRecord;
  api_boundary?: ReleaseRecord;
  runtimeApiFreeze?: ReleaseRecord;
  runtime_api_freeze?: ReleaseRecord;
  requestedOperations?: unknown;
  requested_operations?: unknown;
  operatorRunbook?: ReleaseComponentResult;
  operator_runbook?: ReleaseComponentResult;
  manualReleaseRecord?: ReleaseRecord;
  manual_release_record?: ReleaseRecord;
  credentialEvidence?: ReleaseRecord;
  credential_evidence?: ReleaseRecord;
  billableProviderEvidence?: ReleaseRecord;
  billable_provider_evidence?: ReleaseRecord;
  dogfoodPublicationEvidence?: ReleaseRecord;
  dogfood_publication_evidence?: ReleaseRecord;
  postReleaseAudit?: ReleaseComponentResult;
  post_release_audit?: ReleaseComponentResult;
  stableGraduation?: ReleaseComponentResult;
  stable_graduation?: ReleaseComponentResult;
}

function check(code: string, passed: boolean, message: string, extra: ReleaseRecord = Object()): ReleaseCheck {
  return { code, passed, message, ...extra };
}

function isObject(value: unknown): value is ReleaseRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function noReleaseSideEffects(result: ReleaseComponentResult = Object()): boolean {
  const guarantees = result.guarantees || {};
  return guarantees.published !== true
    && guarantees.credential_access !== true
    && guarantees.provider_execution !== true
    && guarantees.billable_provider_execution !== true
    && guarantees.dogfood_report_published !== true;
}

function defaultRequireManualExternalRelease(releaseScope: string): boolean {
  return releaseScope !== "public-beta";
}

function statusOf(component: unknown): unknown {
  return isObject(component) ? component.status || "unknown" : "missing";
}

export function buildPublicBetaEvidencePlan(options: PublicBetaEvidenceOptions = Object()): PublicBetaEvidencePlan {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const projectRoot = resolve(options.projectRoot || options.project_root || process.cwd());
  const releaseScope = options.releaseScope || options.release_scope || "public-beta";
  const requireManualExternalReleaseEvidence = options.requireManualExternalReleaseEvidence
    ?? options.require_manual_external_release_evidence
    ?? defaultRequireManualExternalRelease(releaseScope);
  const requireRuntimeStableDecision = options.requireRuntimeStableDecision
    ?? options.require_runtime_stable_decision
    ?? releaseScope !== "public-beta";

  return {
    schema_version: PUBLIC_BETA_EVIDENCE_SCHEMA_VERSION,
    schema: "yolo.release.public_beta_evidence_plan.v1",
    yolo_root: yoloRoot,
    project_root: projectRoot,
    release_scope: releaseScope,
    require_manual_external_release_evidence: requireManualExternalReleaseEvidence,
    require_runtime_stable_decision: requireRuntimeStableDecision,
    writes_workspace: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    required_evidence: [
      "agent integration doctor pass for native Codex/Claude usage",
      "real external project plan/check/review dogfood pass",
      "PI execution drill pass",
      "runtime stable-boundary decision ready_to_apply when stable runtime is requested",
      "manual external release evidence pass when public-stable release evidence is requested",
    ],
    stop_conditions: [
      "native agent integration is missing or current host session cannot discover it",
      "real-project dogfood is absent or only covers the YOLO repository",
      "PI drill evidence is missing, failed, or lacks billable authorization when billable mode is claimed",
      "stable runtime or public-stable release is claimed without explicit human evidence",
      "any component claims SDK-executed publish, credential access, provider execution, or dogfood publication",
    ],
  };
}

export function runPublicBetaEvidenceGate(options: PublicBetaEvidenceOptions = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const projectRoot = resolve(options.projectRoot || options.project_root || process.cwd());
  const plan = options.plan || buildPublicBetaEvidencePlan({
    yoloRoot,
    projectRoot,
    releaseScope: options.releaseScope || options.release_scope,
    requireManualExternalReleaseEvidence: options.requireManualExternalReleaseEvidence ?? options.require_manual_external_release_evidence,
    requireRuntimeStableDecision: options.requireRuntimeStableDecision ?? options.require_runtime_stable_decision,
  });
  const agentIntegration = options.agentIntegration || options.agent_integration || runAgentIntegrationDoctor({
    yoloRoot,
    projectRoot,
    homeDir: options.homeDir || options.home_dir,
    targets: options.targets || "both",
    scopes: options.scopes,
    scope: options.scope || options.installScope || options.install_scope || "project",
  });
  const realProjectDogfood = options.realProjectDogfood || options.real_project_dogfood || runRealProjectDogfoodGate({
    yoloRoot,
    projectRoot,
    agentIntegration,
    planEvidence: options.planEvidence || options.plan_evidence,
    checkEvidence: options.checkEvidence || options.check_evidence,
    reviewEvidence: options.reviewEvidence || options.review_evidence,
    dogfoodEvidence: options.dogfoodEvidence || options.dogfood_evidence,
  });
  const piExecutionDrill = options.piExecutionDrill || options.pi_execution_drill || runPiExecutionDrillGate({
    yoloRoot,
    projectRoot,
    executionEvidence: options.executionEvidence || options.execution_evidence,
    authorization: options.authorization || options.billableAuthorization || options.billable_authorization,
  });
  const runtimeBoundaryDecision = options.runtimeBoundaryDecision || options.runtime_boundary_decision || (
    plan.require_runtime_stable_decision
      ? runRuntimeBoundaryDecisionGate({
          yoloRoot,
          targetExport: options.targetExport || options.target_export,
          decisionRecord: options.decisionRecord || options.decision_record,
          candidate: options.runtimeBoundaryCandidate || options.runtime_boundary_candidate,
          packageJson: options.packageJson,
          apiBoundary: options.apiBoundary || options.api_boundary,
          runtimeApiFreeze: options.runtimeApiFreeze || options.runtime_api_freeze,
        })
      : {
          status: "not_required",
          guarantees: {
            published: false,
            credential_access: false,
            provider_execution: false,
            billable_provider_execution: false,
            boundary_changed: false,
            stable_runtime_declared: false,
          },
        }
  );
  const manualExternalRelease = options.manualExternalRelease || options.manual_external_release || (
    plan.require_manual_external_release_evidence
      ? runManualExternalReleaseGate({
          yoloRoot,
          packageJson: options.packageJson,
          requestedOperations: options.requestedOperations || options.requested_operations,
          operatorRunbook: options.operatorRunbook || options.operator_runbook,
          manualReleaseRecord: options.manualReleaseRecord || options.manual_release_record,
          credentialEvidence: options.credentialEvidence || options.credential_evidence,
          billableProviderEvidence: options.billableProviderEvidence || options.billable_provider_evidence,
          dogfoodPublicationEvidence: options.dogfoodPublicationEvidence || options.dogfood_publication_evidence,
          postReleaseAudit: options.postReleaseAudit || options.post_release_audit,
          stableGraduation: options.stableGraduation || options.stable_graduation,
        })
      : {
          status: "not_required",
          guarantees: {
            published: false,
            credential_access: false,
            provider_execution: false,
            billable_provider_execution: false,
            dogfood_report_published: false,
          },
        }
  );

  const checks = [
    check(
      "PUBLIC_BETA_EVIDENCE_NO_SIDE_EFFECTS",
      plan.writes_workspace === false
        && plan.publishes === false
        && plan.reads_credentials === false
        && plan.spawns_provider === false
        && plan.executes_billable_provider === false,
      "public beta evidence gate must validate evidence only; it must not publish, read credentials, execute providers, or mutate workspace",
    ),
    check(
      "PUBLIC_BETA_EVIDENCE_AGENT_INTEGRATION_PASS",
      statusOf(agentIntegration) === "pass",
      "agent integration doctor must pass",
      { status: statusOf(agentIntegration), blockers: (agentIntegration.blockers || []).map((item) => item.code) },
    ),
    check(
      "PUBLIC_BETA_EVIDENCE_REAL_PROJECT_DOGFOOD_PASS",
      statusOf(realProjectDogfood) === "pass",
      "real external project dogfood must pass",
      { status: statusOf(realProjectDogfood), blockers: (realProjectDogfood.blockers || []).map((item) => item.code) },
    ),
    check(
      "PUBLIC_BETA_EVIDENCE_PI_EXECUTION_DRILL_PASS",
      statusOf(piExecutionDrill) === "pass",
      "PI execution drill must pass",
      { status: statusOf(piExecutionDrill), blockers: (piExecutionDrill.blockers || []).map((item) => item.code) },
    ),
    check(
      "PUBLIC_BETA_EVIDENCE_RUNTIME_DECISION_READY",
      !plan.require_runtime_stable_decision || statusOf(runtimeBoundaryDecision) === "ready_to_apply",
      "stable runtime claims require an approved runtime boundary decision",
      { status: statusOf(runtimeBoundaryDecision), blockers: (runtimeBoundaryDecision.blockers || []).map((item) => item.code) },
    ),
    check(
      "PUBLIC_BETA_EVIDENCE_MANUAL_EXTERNAL_RELEASE_PASS",
      !plan.require_manual_external_release_evidence || statusOf(manualExternalRelease) === "pass",
      "public-stable/manual external release claims require external release evidence pass",
      { status: statusOf(manualExternalRelease), blockers: (manualExternalRelease.blockers || []).map((item) => item.code) },
    ),
    check(
      "PUBLIC_BETA_EVIDENCE_COMPONENTS_NO_RELEASE_SIDE_EFFECTS",
      [agentIntegration, realProjectDogfood, piExecutionDrill, runtimeBoundaryDecision, manualExternalRelease].every(noReleaseSideEffects),
      "all evidence components must remain evidence-only and must not claim SDK-executed publish, credential, provider, billable, or report side effects",
    ),
  ];
  const blockers = checks.filter((item) => item.passed !== true);
  const readyStatus = plan.require_manual_external_release_evidence ? "pass" : "ready_for_operator";

  return {
    schema_version: PUBLIC_BETA_EVIDENCE_SCHEMA_VERSION,
    schema: "yolo.release.public_beta_evidence_result.v1",
    status: blockers.length === 0 ? readyStatus : "blocked",
    yolo_root: yoloRoot,
    project_root: projectRoot,
    release_scope: plan.release_scope,
    checks,
    blockers,
    components: {
      agent_integration: agentIntegration,
      real_project_dogfood: realProjectDogfood,
      pi_execution_drill: piExecutionDrill,
      runtime_boundary_decision: runtimeBoundaryDecision,
      manual_external_release: manualExternalRelease,
    },
    plan,
    guarantees: {
      writes_workspace: false,
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      dogfood_report_published: false,
      evidence_bundle_only: true,
    },
    next_actions: blockers.length === 0
      ? ["Use this evidence bundle in the operator release runbook; execute sensitive release actions manually outside the SDK when approved."]
      : ["Complete the blocked evidence components before claiming public beta or public stable readiness."],
  };
}
