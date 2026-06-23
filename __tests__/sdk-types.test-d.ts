/**
 * Public SDK surface — compile-time type tests.
 *
 * This file is the regression net for the public SDK contract published via
 * `dist/sdk.d.ts` (package.json `"types": "./dist/sdk.d.ts"`). It imports the
 * SDK exactly as an external consumer would and asserts, at the type level,
 * that every named export, the default export, and the option interfaces keep
 * a real, non-`any` type. It is compiled under strict mode by tsconfig.sdk.json
 * (run via `npm run typecheck:sdk`), separately from the repo-wide typecheck.
 *
 * If a change widens an export to `any`, drops a binding, or changes a public
 * option shape, the corresponding assertion here fails to compile.
 *
 * Why a `.test-d.ts` file: it is a pure type-level module (no runtime code) so
 * the node:test runner never picks it up; only `tsc -p tsconfig.sdk.json`
 * compiles it. This keeps type coverage of the boundary isolated and explicit.
 */

import type {
  CreateYoloSdkOptions,
  LifecycleStageWriteOptions,
} from "../dist/sdk.js";
import {
  ADAPTER_EVIDENCE_COLLECTOR_SCHEMA_VERSION,
  AGENT_INTEGRATION_DOCTOR_SCHEMA_VERSION,
  appendJsonlRecord,
  appendRunEvent,
  appendStateEvent,
  buildAcceptanceReport,
  buildAdapterEvidencePlan,
  buildAgentAdapterCapabilities,
  buildAgentAdapterContract,
  buildAgentIntegrationDoctorPlan,
  buildChangeArtifact,
  buildCleanEnvironmentVerifyPlan,
  buildControlledBetaReleaseDecisionPlan,
  buildControlledParallelExecutionPlan,
  buildDemandArtifactGraph,
  buildDemandEvidenceDispatchPlan,
  buildDemandSession,
  buildDesignArtifact,
  buildDiscoveryArtifact,
  buildDiscoveryPlan,
  buildDogfoodMatrixEvidence,
  buildDogfoodMatrixPlan,
  buildDogfoodMatrixReport,
  buildEvidenceArtifact,
  buildExperiencePackEffectivenessAuditPlan,
  buildInitToFirstPrdSmokePlan,
  buildLedgerRecord,
  buildLifecycleStageReport,
  buildManualExternalReleasePlan,
  buildNonTechnicalUxDoctorPlan,
  buildOperatorReleaseRunbookPlan,
  buildOperatorReleaseStatePlan,
  buildPackageInstallSmokePlan,
  buildPiExecutionDrillPlan,
  buildPostReleaseAuditPlan,
  buildPrdFromDiscovery,
  buildProgressDashboardUiEvidence,
  buildProjectBootstrapPlan,
  buildProjectSetupPlan,
  buildPublicBetaEvidencePlan,
  buildPublicBetaHardeningDrillPlan,
  buildRealProjectDogfoodPackPlan,
  buildRealProjectDogfoodPlan,
  buildReleaseCandidateChangeManifest,
  buildRequirementArtifact,
  buildReviewFixPrd,
  buildReviewOutput,
  buildRunFinalAnswer,
  buildRunReport,
  buildRuntimeBoundaryDecisionPlan,
  buildSpecLifecyclePackage,
  buildStableGraduationPlan,
  buildTaskArtifact,
  buildTaskDependencyGraph,
  buildTraceabilityMatrix,
  buildWorkflowSkillInstallPlan,
  buildWorkflowSkillTargetSmokePlan,
  buildYoloBenchmarkPlan,
  buildYoloCommandRegistry,
  buildYoloDoctorReport,
  classifyReleaseChangeDomain,
  CLEAN_ENVIRONMENT_VERIFY_SCHEMA_VERSION,
  config,
  CONTROLLED_BETA_RELEASE_ACTIONS,
  CONTROLLED_BETA_RELEASE_DECISION_SCHEMA_VERSION,
  CONTROLLED_PARALLEL_SCHEMA_VERSION,
  convertAuditToPrd,
  copyFixtureToWorkspace,
  createAgentPlan,
  createEvidenceLedger,
  createPiAgent,
  createPiRunPlan,
  createPrdMigrationAdvice,
  createWorkflowPlan,
  defaultDemandSessionPath,
  defaultDiscoveryPath,
  defaultDiscoveryPlanPath,
  defaultDiscoveryPrdPath,
  DEMAND_EVIDENCE_DISPATCH_SCHEMA_VERSION,
  DEMAND_GRAPH_SCHEMA_VERSION,
  DEMAND_READINESS_SCHEMA_VERSION,
  DEMAND_SESSION_SCHEMA_VERSION,
  demandBlockedArtifacts,
  demandBuildOrder,
  demandMarkdownArtifacts,
  demandReadyArtifacts,
  demandStateDir,
  detectModelProvider,
  detectParallelConflicts,
  discoverPackManifests,
  DOGFOOD_MATRIX_SCENARIO_IDS,
  DOGFOOD_MATRIX_SCHEMA_VERSION,
  evaluatePostConditions,
  evaluatePreConditions,
  evaluateReleaseCandidateGate,
  EVIDENCE_ARTIFACT_SCHEMA,
  EVIDENCE_SCHEMA_VERSION,
  executeCleanEnvironmentVerifyPlan,
  EXPERIENCE_PACK_AUDIT_SCHEMA_VERSION,
  fixtureEvidenceRecord,
  formatAcceptanceReportText,
  formatControlledParallelPlanText,
  formatRunFinalAnswerMarkdown,
  formatRunReportMarkdown,
  formatYoloBenchmarkText,
  formatYoloCheckText,
  formatYoloDoctorText,
  generateFindingsFromRequirement,
  getAgentPreset,
  getFixtureDefinition,
  getWorkflow,
  getYoloCommand,
  initProject,
  inspectAcceptanceReport,
  inspectAgentAdapterContract,
  inspectAgentBridgeDryRunDoctor,
  inspectAtomicTask,
  inspectDemandReadiness,
  inspectFixtureDefinition,
  inspectFixtureRegistry,
  inspectPackageReadiness,
  inspectPackedPackage,
  inspectParallelMergeGate,
  inspectPrdContract,
  inspectProgressDashboardUiEvidence,
  inspectProjectSetupTarget,
  inspectPublicBetaReadiness,
  inspectReviewFixLoop,
  inspectSpecGovernance,
  inspectSpecLifecyclePackage,
  inspectTaskFromPrd,
  inspectWorkflowSkillInstallPlan,
  inspectYoloCheck,
  installWorkflowSkills,
  LEDGER_EVENT_SCHEMA,
  listAgentPresets,
  listBenchmarkFixtures,
  listDogfoodMatrixScenarios,
  listFixtureDefinitions,
  listWorkflows,
  listWorkflowSkillDescriptors,
  listYoloBridgeWorkflowIds,
  listYoloCommandNames,
  listYoloCommands,
  loadConfig,
  MANUAL_EXTERNAL_RELEASE_SCHEMA_VERSION,
  mergeParallelEvidence,
  migratePrdFile,
  migratePrdGates,
  NONTECHNICAL_UX_DOCTOR_SCHEMA_VERSION,
  normalizeAgentProvider,
  normalizeReviewFinding,
  normalizeReviewFindings,
  OPERATOR_RELEASE_OPERATIONS,
  OPERATOR_RELEASE_RUNBOOK_SCHEMA_VERSION,
  OPERATOR_RELEASE_STATE_SCHEMA_VERSION,
  PACKAGE_INSTALL_SMOKE_SCHEMA_VERSION,
  PI_EXECUTION_DRILL_SCHEMA_VERSION,
  planControlledParallelWaves,
  POST_RELEASE_AUDIT_SCHEMA_VERSION,
  preflightAllPrds,
  preflightPrd,
  PROGRESS_DASHBOARD_UI_EVIDENCE_SCHEMA_VERSION,
  PUBLIC_BETA_EVIDENCE_SCHEMA_VERSION,
  PUBLIC_BETA_HARDENING_DRILL_SCHEMA_VERSION,
  readDemandSession,
  readDiscoveryArtifact,
  readPackManifest,
  readReleaseCandidateChangeManifest,
  REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
  REAL_PROJECT_DOGFOOD_SCHEMA_VERSION,
  RELEASE_CANDIDATE_GATE_SCHEMA_VERSION,
  RELEASE_CANDIDATE_REQUIRED_REPORTS,
  RELEASE_CHANGE_DOMAINS,
  renderYoloCommandUsage,
  resolveProjectContext,
  REVIEW_FINDING_SCHEMA,
  REVIEW_OUTPUT_SCHEMA,
  runAdapterEvidenceCollector,
  runAgentIntegrationDoctor,
  runBenchmark,
  runCleanEnvironmentVerify,
  runControlledBetaReleaseDecisionGate,
  runDemandBrainstormRuntime,
  runDemandDiscussRuntime,
  runDemandEvidenceDispatchRuntime,
  runDemandPrdRuntime,
  runDiscoveryPlanRuntime,
  runDiscoveryPrdRuntime,
  runDiscoveryRuntime,
  runExperiencePackEffectivenessAudit,
  runFixtureHarness,
  runInitToFirstPrdSmoke,
  runManualExternalReleaseGate,
  runNonTechnicalUxDoctor,
  runOperatorReleaseRunbookGate,
  runOperatorReleaseStateMutation,
  runPackageInstallSmoke,
  runPiAgent,
  runPiExecutionDrillGate,
  runPiRuntime,
  runPostReleaseAuditGate,
  runProgressDashboardUiEvidence,
  runProjectSetup,
  runPublicBetaEvidenceGate,
  runPublicBetaHardeningDrill,
  runRealProjectDogfoodGate,
  runRealProjectDogfoodPack,
  runReleaseCandidateGate,
  runReportPaths,
  runRunnerRuntime,
  runRuntimeBoundaryDecisionGate,
  runStableGraduationGate,
  RUNTIME_BOUNDARY_DECISION_SCHEMA_VERSION,
  runWorkflowSkillTargetSmoke,
  runYoloBenchmark,
  scanFile,
  scanProject,
  scoreBenchmarkScenario,
  specLifecycleToPrd,
  STABLE_GRADUATION_SCHEMA_VERSION,
  summarizeReviewFindings,
  supportedConditionTypes,
  toGateFormat,
  validateEvidenceArtifact,
  validateLedgerRecord,
  validatePackManifest,
  validatePrdPath,
  validateReviewFinding,
  validateWorkflowSkillDescriptor,
  workflowToSkillDescriptor,
  writeDemandArtifacts,
  writeJsonArtifact,
  writeRunReport,
  YOLO_BENCHMARK_RUBRIC,
  YOLO_BENCHMARK_SCHEMA_VERSION,
  YOLO_CODEX_FALLBACK_ENTRY,
  YOLO_COMMAND_REGISTRY_SCHEMA_VERSION,
  YOLO_DOCTOR_SCHEMA_VERSION,
  YOLO_ONE_SENTENCE_ENTRY,
} from "../dist/sdk.js";
import createYoloSdkDefault from "../dist/sdk.js";

// ---------------------------------------------------------------------------
// Helpers — these fail to compile when the asserted relationship is wrong.
// ---------------------------------------------------------------------------

/**
 * Asserts `T` is exactly `any` (the failure we want to prevent on the boundary).
 * Used as a building block: a public binding that is `any` would silently pass
 * most structural checks, so we explicitly trap it.
 */
type IsAny<T> = 0 extends 1 & T ? true : false;

/**
 * Asserts `T` is NOT `any`. A regression that widens an export to `any` makes
 * the inner conditional resolve to `false`, which is not assignable to `true`.
 */
type NotAny<T> = IsAny<T> extends true ? false : true;

/**
 * Compile-time assertion. `expectType<true>(true)` always compiles; passing any
 * other type for the argument fails because `false`/`boolean` are not assignable
 * to the literal `true`.
 */
declare function expectType<T extends true>(value: T): void;

/**
 * Assert a binding is a function with a real (non-`any`) call signature.
 * Catches exports silently degrading to `any`, which would otherwise type-check
 * as callable. We allow `any[]` args because internal helpers are intentionally
 * loose, but the binding itself must be a concrete function, not `any`.
 */
type IsFunction<T> = T extends (...args: any[]) => unknown ? NotAny<T> : false;

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

expectType<NotAny<typeof createYoloSdkDefault>>(true);
expectType<IsFunction<typeof createYoloSdkDefault>>(true);

// createYoloSdk options must be a real interface, not `any`.
expectType<NotAny<CreateYoloSdkOptions>>(true);
expectType<NotAny<LifecycleStageWriteOptions>>(true);

// ---------------------------------------------------------------------------
// Function exports — each must be a real callable, never `any`.
// ---------------------------------------------------------------------------

expectType<IsFunction<typeof appendJsonlRecord>>(true);
expectType<IsFunction<typeof appendRunEvent>>(true);
expectType<IsFunction<typeof appendStateEvent>>(true);
expectType<IsFunction<typeof buildAcceptanceReport>>(true);
expectType<IsFunction<typeof buildAdapterEvidencePlan>>(true);
expectType<IsFunction<typeof buildAgentAdapterCapabilities>>(true);
expectType<IsFunction<typeof buildAgentAdapterContract>>(true);
expectType<IsFunction<typeof buildAgentIntegrationDoctorPlan>>(true);
expectType<IsFunction<typeof buildChangeArtifact>>(true);
expectType<IsFunction<typeof buildCleanEnvironmentVerifyPlan>>(true);
expectType<IsFunction<typeof buildControlledBetaReleaseDecisionPlan>>(true);
expectType<IsFunction<typeof buildControlledParallelExecutionPlan>>(true);
expectType<IsFunction<typeof buildDemandArtifactGraph>>(true);
expectType<IsFunction<typeof buildDemandEvidenceDispatchPlan>>(true);
expectType<IsFunction<typeof buildDemandSession>>(true);
expectType<IsFunction<typeof buildDesignArtifact>>(true);
expectType<IsFunction<typeof buildDiscoveryArtifact>>(true);
expectType<IsFunction<typeof buildDiscoveryPlan>>(true);
expectType<IsFunction<typeof buildDogfoodMatrixEvidence>>(true);
expectType<IsFunction<typeof buildDogfoodMatrixPlan>>(true);
expectType<IsFunction<typeof buildDogfoodMatrixReport>>(true);
expectType<IsFunction<typeof buildEvidenceArtifact>>(true);
expectType<IsFunction<typeof buildExperiencePackEffectivenessAuditPlan>>(true);
expectType<IsFunction<typeof buildInitToFirstPrdSmokePlan>>(true);
expectType<IsFunction<typeof buildLedgerRecord>>(true);
expectType<IsFunction<typeof buildLifecycleStageReport>>(true);
expectType<IsFunction<typeof buildManualExternalReleasePlan>>(true);
expectType<IsFunction<typeof buildNonTechnicalUxDoctorPlan>>(true);
expectType<IsFunction<typeof buildOperatorReleaseRunbookPlan>>(true);
expectType<IsFunction<typeof buildOperatorReleaseStatePlan>>(true);
expectType<IsFunction<typeof buildPackageInstallSmokePlan>>(true);
expectType<IsFunction<typeof buildPiExecutionDrillPlan>>(true);
expectType<IsFunction<typeof buildPostReleaseAuditPlan>>(true);
expectType<IsFunction<typeof buildPrdFromDiscovery>>(true);
expectType<IsFunction<typeof buildProgressDashboardUiEvidence>>(true);
expectType<IsFunction<typeof buildProjectBootstrapPlan>>(true);
expectType<IsFunction<typeof buildProjectSetupPlan>>(true);
expectType<IsFunction<typeof buildPublicBetaEvidencePlan>>(true);
expectType<IsFunction<typeof buildPublicBetaHardeningDrillPlan>>(true);
expectType<IsFunction<typeof buildRealProjectDogfoodPackPlan>>(true);
expectType<IsFunction<typeof buildRealProjectDogfoodPlan>>(true);
expectType<IsFunction<typeof buildReleaseCandidateChangeManifest>>(true);
expectType<IsFunction<typeof buildRequirementArtifact>>(true);
expectType<IsFunction<typeof buildReviewFixPrd>>(true);
expectType<IsFunction<typeof buildReviewOutput>>(true);
expectType<IsFunction<typeof buildRunFinalAnswer>>(true);
expectType<IsFunction<typeof buildRunReport>>(true);
expectType<IsFunction<typeof buildRuntimeBoundaryDecisionPlan>>(true);
expectType<IsFunction<typeof buildSpecLifecyclePackage>>(true);
expectType<IsFunction<typeof buildStableGraduationPlan>>(true);
expectType<IsFunction<typeof buildTaskArtifact>>(true);
expectType<IsFunction<typeof buildTaskDependencyGraph>>(true);
expectType<IsFunction<typeof buildTraceabilityMatrix>>(true);
expectType<IsFunction<typeof buildWorkflowSkillInstallPlan>>(true);
expectType<IsFunction<typeof buildWorkflowSkillTargetSmokePlan>>(true);
expectType<IsFunction<typeof buildYoloBenchmarkPlan>>(true);
expectType<IsFunction<typeof buildYoloCommandRegistry>>(true);
expectType<IsFunction<typeof buildYoloDoctorReport>>(true);
expectType<IsFunction<typeof classifyReleaseChangeDomain>>(true);
expectType<IsFunction<typeof convertAuditToPrd>>(true);
expectType<IsFunction<typeof copyFixtureToWorkspace>>(true);
expectType<IsFunction<typeof createAgentPlan>>(true);
expectType<IsFunction<typeof createEvidenceLedger>>(true);
expectType<IsFunction<typeof createPiAgent>>(true);
expectType<IsFunction<typeof createPiRunPlan>>(true);
expectType<IsFunction<typeof createPrdMigrationAdvice>>(true);
expectType<IsFunction<typeof createWorkflowPlan>>(true);
expectType<IsFunction<typeof defaultDemandSessionPath>>(true);
expectType<IsFunction<typeof defaultDiscoveryPath>>(true);
expectType<IsFunction<typeof defaultDiscoveryPlanPath>>(true);
expectType<IsFunction<typeof defaultDiscoveryPrdPath>>(true);
expectType<IsFunction<typeof demandBlockedArtifacts>>(true);
expectType<IsFunction<typeof demandBuildOrder>>(true);
expectType<IsFunction<typeof demandMarkdownArtifacts>>(true);
expectType<IsFunction<typeof demandReadyArtifacts>>(true);
expectType<IsFunction<typeof demandStateDir>>(true);
expectType<IsFunction<typeof detectModelProvider>>(true);
expectType<IsFunction<typeof detectParallelConflicts>>(true);
expectType<IsFunction<typeof discoverPackManifests>>(true);
expectType<IsFunction<typeof evaluatePostConditions>>(true);
expectType<IsFunction<typeof evaluatePreConditions>>(true);
expectType<IsFunction<typeof evaluateReleaseCandidateGate>>(true);
expectType<IsFunction<typeof executeCleanEnvironmentVerifyPlan>>(true);
expectType<IsFunction<typeof fixtureEvidenceRecord>>(true);
expectType<IsFunction<typeof formatAcceptanceReportText>>(true);
expectType<IsFunction<typeof formatControlledParallelPlanText>>(true);
expectType<IsFunction<typeof formatRunFinalAnswerMarkdown>>(true);
expectType<IsFunction<typeof formatRunReportMarkdown>>(true);
expectType<IsFunction<typeof formatYoloBenchmarkText>>(true);
expectType<IsFunction<typeof formatYoloCheckText>>(true);
expectType<IsFunction<typeof formatYoloDoctorText>>(true);
expectType<IsFunction<typeof generateFindingsFromRequirement>>(true);
expectType<IsFunction<typeof getAgentPreset>>(true);
expectType<IsFunction<typeof getFixtureDefinition>>(true);
expectType<IsFunction<typeof getWorkflow>>(true);
expectType<IsFunction<typeof getYoloCommand>>(true);
expectType<IsFunction<typeof initProject>>(true);
expectType<IsFunction<typeof inspectAcceptanceReport>>(true);
expectType<IsFunction<typeof inspectAgentAdapterContract>>(true);
expectType<IsFunction<typeof inspectAgentBridgeDryRunDoctor>>(true);
expectType<IsFunction<typeof inspectAtomicTask>>(true);
expectType<IsFunction<typeof inspectDemandReadiness>>(true);
expectType<IsFunction<typeof inspectFixtureDefinition>>(true);
expectType<IsFunction<typeof inspectFixtureRegistry>>(true);
expectType<IsFunction<typeof inspectPackageReadiness>>(true);
expectType<IsFunction<typeof inspectPackedPackage>>(true);
expectType<IsFunction<typeof inspectParallelMergeGate>>(true);
expectType<IsFunction<typeof inspectPrdContract>>(true);
expectType<IsFunction<typeof inspectProgressDashboardUiEvidence>>(true);
expectType<IsFunction<typeof inspectProjectSetupTarget>>(true);
expectType<IsFunction<typeof inspectPublicBetaReadiness>>(true);
expectType<IsFunction<typeof inspectReviewFixLoop>>(true);
expectType<IsFunction<typeof inspectSpecGovernance>>(true);
expectType<IsFunction<typeof inspectSpecLifecyclePackage>>(true);
expectType<IsFunction<typeof inspectTaskFromPrd>>(true);
expectType<IsFunction<typeof inspectWorkflowSkillInstallPlan>>(true);
expectType<IsFunction<typeof inspectYoloCheck>>(true);
expectType<IsFunction<typeof installWorkflowSkills>>(true);
expectType<IsFunction<typeof listAgentPresets>>(true);
expectType<IsFunction<typeof listBenchmarkFixtures>>(true);
expectType<IsFunction<typeof listDogfoodMatrixScenarios>>(true);
expectType<IsFunction<typeof listFixtureDefinitions>>(true);
expectType<IsFunction<typeof listWorkflows>>(true);
expectType<IsFunction<typeof listWorkflowSkillDescriptors>>(true);
expectType<IsFunction<typeof listYoloBridgeWorkflowIds>>(true);
expectType<IsFunction<typeof listYoloCommandNames>>(true);
expectType<IsFunction<typeof listYoloCommands>>(true);
expectType<IsFunction<typeof loadConfig>>(true);
expectType<IsFunction<typeof mergeParallelEvidence>>(true);
expectType<IsFunction<typeof migratePrdFile>>(true);
expectType<IsFunction<typeof migratePrdGates>>(true);
expectType<IsFunction<typeof normalizeAgentProvider>>(true);
expectType<IsFunction<typeof normalizeReviewFinding>>(true);
expectType<IsFunction<typeof normalizeReviewFindings>>(true);
expectType<IsFunction<typeof planControlledParallelWaves>>(true);
expectType<IsFunction<typeof preflightAllPrds>>(true);
expectType<IsFunction<typeof preflightPrd>>(true);
expectType<IsFunction<typeof readDemandSession>>(true);
expectType<IsFunction<typeof readDiscoveryArtifact>>(true);
expectType<IsFunction<typeof readPackManifest>>(true);
expectType<IsFunction<typeof readReleaseCandidateChangeManifest>>(true);
expectType<IsFunction<typeof renderYoloCommandUsage>>(true);
expectType<IsFunction<typeof resolveProjectContext>>(true);
expectType<IsFunction<typeof runAdapterEvidenceCollector>>(true);
expectType<IsFunction<typeof runAgentIntegrationDoctor>>(true);
expectType<IsFunction<typeof runBenchmark>>(true);
expectType<IsFunction<typeof runCleanEnvironmentVerify>>(true);
expectType<IsFunction<typeof runControlledBetaReleaseDecisionGate>>(true);
expectType<IsFunction<typeof runDemandBrainstormRuntime>>(true);
expectType<IsFunction<typeof runDemandDiscussRuntime>>(true);
expectType<IsFunction<typeof runDemandEvidenceDispatchRuntime>>(true);
expectType<IsFunction<typeof runDemandPrdRuntime>>(true);
expectType<IsFunction<typeof runDiscoveryPlanRuntime>>(true);
expectType<IsFunction<typeof runDiscoveryPrdRuntime>>(true);
expectType<IsFunction<typeof runDiscoveryRuntime>>(true);
expectType<IsFunction<typeof runExperiencePackEffectivenessAudit>>(true);
expectType<IsFunction<typeof runFixtureHarness>>(true);
expectType<IsFunction<typeof runInitToFirstPrdSmoke>>(true);
expectType<IsFunction<typeof runManualExternalReleaseGate>>(true);
expectType<IsFunction<typeof runNonTechnicalUxDoctor>>(true);
expectType<IsFunction<typeof runOperatorReleaseRunbookGate>>(true);
expectType<IsFunction<typeof runOperatorReleaseStateMutation>>(true);
expectType<IsFunction<typeof runPackageInstallSmoke>>(true);
expectType<IsFunction<typeof runPiAgent>>(true);
expectType<IsFunction<typeof runPiExecutionDrillGate>>(true);
expectType<IsFunction<typeof runPiRuntime>>(true);
expectType<IsFunction<typeof runPostReleaseAuditGate>>(true);
expectType<IsFunction<typeof runProgressDashboardUiEvidence>>(true);
expectType<IsFunction<typeof runProjectSetup>>(true);
expectType<IsFunction<typeof runPublicBetaEvidenceGate>>(true);
expectType<IsFunction<typeof runPublicBetaHardeningDrill>>(true);
expectType<IsFunction<typeof runRealProjectDogfoodGate>>(true);
expectType<IsFunction<typeof runRealProjectDogfoodPack>>(true);
expectType<IsFunction<typeof runReleaseCandidateGate>>(true);
expectType<IsFunction<typeof runReportPaths>>(true);
expectType<IsFunction<typeof runRunnerRuntime>>(true);
expectType<IsFunction<typeof runRuntimeBoundaryDecisionGate>>(true);
expectType<IsFunction<typeof runStableGraduationGate>>(true);
expectType<IsFunction<typeof runWorkflowSkillTargetSmoke>>(true);
expectType<IsFunction<typeof runYoloBenchmark>>(true);
expectType<IsFunction<typeof scanFile>>(true);
expectType<IsFunction<typeof scanProject>>(true);
expectType<IsFunction<typeof scoreBenchmarkScenario>>(true);
expectType<IsFunction<typeof specLifecycleToPrd>>(true);
expectType<IsFunction<typeof summarizeReviewFindings>>(true);
expectType<IsFunction<typeof supportedConditionTypes>>(true);
expectType<IsFunction<typeof toGateFormat>>(true);
expectType<IsFunction<typeof validateEvidenceArtifact>>(true);
expectType<IsFunction<typeof validateLedgerRecord>>(true);
expectType<IsFunction<typeof validatePackManifest>>(true);
expectType<IsFunction<typeof validatePrdPath>>(true);
expectType<IsFunction<typeof validateReviewFinding>>(true);
expectType<IsFunction<typeof validateWorkflowSkillDescriptor>>(true);
expectType<IsFunction<typeof workflowToSkillDescriptor>>(true);
expectType<IsFunction<typeof writeDemandArtifacts>>(true);
expectType<IsFunction<typeof writeJsonArtifact>>(true);
expectType<IsFunction<typeof writeRunReport>>(true);

// ---------------------------------------------------------------------------
// Non-function exports (config, schemas, constants) — must be defined and
// non-`any`. A dropped or widened binding makes `NotAny` resolve to `false`.
// ---------------------------------------------------------------------------

// `config` is the loaded configuration singleton (re-exported from a non-strict
// module). It is intentionally a loose object, so we assert it is assignable to
// an object shape rather than non-`any` — widening it to a full config schema
// is out of scope for the SDK-boundary type gate. The assertType helper accepts
// `any` (any is assignable to any type) but would reject `undefined`.
declare function assertAssignable<T>(): (value: T) => void;
const _configAssignable = assertAssignable<Record<string, unknown>>();
_configAssignable(config);
expectType<NotAny<typeof ADAPTER_EVIDENCE_COLLECTOR_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof AGENT_INTEGRATION_DOCTOR_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof CLEAN_ENVIRONMENT_VERIFY_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof CONTROLLED_BETA_RELEASE_ACTIONS>>(true);
expectType<NotAny<typeof CONTROLLED_BETA_RELEASE_DECISION_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof CONTROLLED_PARALLEL_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof DEMAND_EVIDENCE_DISPATCH_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof DEMAND_GRAPH_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof DEMAND_READINESS_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof DEMAND_SESSION_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof DOGFOOD_MATRIX_SCENARIO_IDS>>(true);
expectType<NotAny<typeof DOGFOOD_MATRIX_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof EVIDENCE_ARTIFACT_SCHEMA>>(true);
expectType<NotAny<typeof EVIDENCE_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof EXPERIENCE_PACK_AUDIT_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof LEDGER_EVENT_SCHEMA>>(true);
expectType<NotAny<typeof MANUAL_EXTERNAL_RELEASE_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof NONTECHNICAL_UX_DOCTOR_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof OPERATOR_RELEASE_OPERATIONS>>(true);
expectType<NotAny<typeof OPERATOR_RELEASE_RUNBOOK_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof OPERATOR_RELEASE_STATE_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof PACKAGE_INSTALL_SMOKE_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof PI_EXECUTION_DRILL_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof POST_RELEASE_AUDIT_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof PROGRESS_DASHBOARD_UI_EVIDENCE_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof PUBLIC_BETA_EVIDENCE_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof PUBLIC_BETA_HARDENING_DRILL_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof REAL_PROJECT_DOGFOOD_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof RELEASE_CANDIDATE_GATE_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof RELEASE_CANDIDATE_REQUIRED_REPORTS>>(true);
expectType<NotAny<typeof RELEASE_CHANGE_DOMAINS>>(true);
expectType<NotAny<typeof REVIEW_FINDING_SCHEMA>>(true);
expectType<NotAny<typeof REVIEW_OUTPUT_SCHEMA>>(true);
expectType<NotAny<typeof RUNTIME_BOUNDARY_DECISION_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof STABLE_GRADUATION_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof YOLO_BENCHMARK_RUBRIC>>(true);
expectType<NotAny<typeof YOLO_BENCHMARK_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof YOLO_CODEX_FALLBACK_ENTRY>>(true);
expectType<NotAny<typeof YOLO_COMMAND_REGISTRY_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof YOLO_DOCTOR_SCHEMA_VERSION>>(true);
expectType<NotAny<typeof YOLO_ONE_SENTENCE_ENTRY>>(true);

// ---------------------------------------------------------------------------
// SDK instance shape — createYoloSdk must return a real object whose top-level
// namespaces are themselves non-`any` objects (the stable + experimental split).
// ---------------------------------------------------------------------------

type Sdk = ReturnType<typeof createYoloSdkDefault>;
expectType<NotAny<Sdk>>(true);

// Stable facade exposes exactly the curated namespaces and never the full SDK.
type StableKeys = keyof Sdk["stable"];
// Use a non-distributive check (wrap in a 1-tuple) so the conditional does not
// split the key union across members. `stable` must never expose the full SDK's
// release/runtime/pi namespaces — only its curated set.
expectType<["release"] extends [StableKeys] ? false : true>(true);
expectType<["runtime"] extends [StableKeys] ? false : true>(true);
expectType<["agents"] extends [StableKeys] ? true : false>(true);
expectType<["contract"] extends [StableKeys] ? true : false>(true);

// A few representative runtime values stay non-any so consumers get guidance.
expectType<NotAny<Sdk["stable"]["agents"]["listPresets"]>>(true);
expectType<NotAny<Sdk["experimental"]["runtime"]["runRunner"]>>(true);
expectType<NotAny<Sdk["contract"]["evaluatePostConditions"]>>(true);

// The typed option shapes flow through: scanFile takes a string file argument.
expectType<Sdk["review"]["scanFile"] extends (file: string, ...rest: any[]) => unknown ? true : false>(true);
