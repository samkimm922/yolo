import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config, loadConfig } from "./src/core/config.js";
import { buildProjectBootstrapPlan, initProject } from "./src/core/bootstrap.js";
import { buildInitToFirstPrdSmokePlan, runInitToFirstPrdSmoke } from "./src/core/init-smoke.js";
import { buildProjectSetupPlan, inspectProjectSetupTarget, runProjectSetup } from "./src/core/setup.js";
import { ensureCanonicalDirs, resolvePrdPath, yoloPath } from "./src/core/paths.js";
import {
  evaluatePostConditions,
  evaluatePreConditions,
  supportedConditionTypes,
  toGateFormat,
} from "./src/prd/contract.js";
import { inspectAtomicTask, inspectTaskFromPrd } from "./src/runtime/execution/atomic-task-doctor.js";
import { inspectPrdContract } from "./src/runtime/gates/prd-contract-doctor.js";
import { detectModelProvider } from "./src/runtime/adapters/provider-doctor.js";
import { scanProject, scanFile } from "./src/review/scanner.js";
import { classifyTaskExecution } from "./src/runtime/task-loop/router.js";
import { validateDiffQuality } from "./src/runtime/gates/diff-quality-gate.js";
import { validateTestGeneration } from "./src/runtime/gates/test-generation-validator.js";
import { createAgentPlan, getAgentPreset, listAgentPresets } from "./src/agents/presets.js";
import { createPiAgent, createPiRunPlan, runPiAgent } from "./src/agents/pi.js";
import {
  buildAgentAdapterCapabilities,
  buildAgentAdapterContract,
  inspectAgentAdapterContract,
  normalizeAgentProvider,
} from "./src/runtime/adapters/agent-contract.js";
import {
  ADAPTER_EVIDENCE_COLLECTOR_SCHEMA_VERSION,
  buildAdapterEvidencePlan,
  runAdapterEvidenceCollector,
} from "./src/runtime/adapters/evidence-collector.js";
import {
  buildProviderCliDryRunMatrix,
  buildProviderRuntimeMatrix,
  inspectProviderCliDryRunMatrix,
  inspectProviderRuntimeMatrix,
} from "./src/runtime/adapters/provider-runtime-matrix.js";
import { runPiRuntime } from "./src/runtime/pi-runtimes.js";
import { runRunnerRuntime } from "./src/runtime/runner-runtime.js";
import { inspectYoloCheck, formatYoloCheckText } from "./src/runtime/gates/check-report.js";
import { buildAcceptanceReport, formatAcceptanceReportText, inspectAcceptanceReport } from "./src/runtime/acceptance/report.js";
import {
  buildProgressDashboardUiEvidence,
  inspectProgressDashboardUiEvidence,
  PROGRESS_DASHBOARD_UI_EVIDENCE_SCHEMA_VERSION,
  runProgressDashboardUiEvidence,
} from "./src/runtime/progress/ui-evidence.js";
import {
  buildYoloBenchmarkPlan,
  formatYoloBenchmarkText,
  listBenchmarkFixtures,
  runBenchmark,
  runYoloBenchmark,
  scoreBenchmarkScenario,
  YOLO_BENCHMARK_RUBRIC,
  YOLO_BENCHMARK_SCHEMA_VERSION,
} from "./src/eval/benchmark.js";
import {
  buildControlledParallelExecutionPlan,
  buildTaskDependencyGraph,
  CONTROLLED_PARALLEL_SCHEMA_VERSION,
  detectParallelConflicts,
  formatControlledParallelPlanText,
  inspectParallelMergeGate,
  mergeParallelEvidence,
  planControlledParallelWaves,
} from "./src/runtime/parallel/wave-planner.js";
import { buildLifecycleStageReport, writeLifecycleStageReport } from "./src/lifecycle/progress.js";
import {
  buildDiscoveryArtifact,
  buildDiscoveryPlan,
  buildPrdFromDiscovery,
} from "./src/discovery/artifacts.js";
import {
  defaultDiscoveryPath,
  defaultDiscoveryPlanPath,
  defaultDiscoveryPrdPath,
  readDiscoveryArtifact,
  runDiscoveryPlanRuntime,
  runDiscoveryPrdRuntime,
  runDiscoveryRuntime,
} from "./src/discovery/runtime.js";
import {
  buildDemandSession,
  demandMarkdownArtifacts,
  DEMAND_SESSION_SCHEMA_VERSION,
} from "./src/demand/artifacts.js";
import {
  buildDemandArtifactGraph,
  DEMAND_GRAPH_SCHEMA_VERSION,
  demandBlockedArtifacts,
  demandBuildOrder,
  demandReadyArtifacts,
} from "./src/demand/graph.js";
import {
  DEMAND_READINESS_SCHEMA_VERSION,
  inspectDemandReadiness,
} from "./src/demand/gate.js";
import {
  buildDemandEvidenceTasks,
  buildDemandSessionState,
  DEMAND_EVIDENCE_AGENT_PROTOCOLS,
  DEMAND_EVIDENCE_RESULT_SCHEMA_DEFINITION,
  DEMAND_PRD_READINESS_SCHEMA_VERSION,
  DEMAND_ROUTER_SCHEMA_VERSION,
  inspectDemandPrdReadiness,
  inspectDemandTriage,
  inspectEvidenceAgreement,
} from "./src/demand/router.js";
import {
  buildDemandEvidenceDispatchPlan,
  DEMAND_EVIDENCE_DISPATCH_SCHEMA_VERSION,
  runDemandEvidenceDispatchRuntime,
} from "./src/demand/evidence-dispatch.js";
import {
  defaultDemandSessionPath,
  demandStateDir,
  readDemandSession,
  runDemandBrainstormRuntime,
  runDemandDiscussRuntime,
  runDemandPrdRuntime,
  runDemandStatusRuntime,
  writeDemandArtifacts,
} from "./src/demand/runtime.js";
import { buildUnderstandingPlayback } from "./src/demand/understanding-playback.js";
import { discoverPackManifests, readPackManifest, validatePackManifest } from "./src/packs/manifest.js";
import { resolveProjectContext } from "./src/packs/resolver.js";
import { buildTraceabilityMatrix, inspectSpecGovernance } from "./src/spec/traceability.js";
import {
  buildChangeArtifact,
  buildDesignArtifact,
  buildRequirementArtifact,
  buildSpecLifecyclePackage,
  buildTaskArtifact,
  inspectSpecLifecyclePackage,
  specLifecycleToPrd,
} from "./src/spec/lifecycle.js";
import {
  appendJsonlRecord,
  appendRunEvent,
  appendStateEvent,
  buildEvidenceArtifact,
  buildLedgerRecord,
  createEvidenceLedger,
  EVIDENCE_ARTIFACT_SCHEMA,
  EVIDENCE_SCHEMA_VERSION,
  LEDGER_EVENT_SCHEMA,
  validateEvidenceArtifact,
  validateLedgerRecord,
  writeJsonArtifact,
} from "./src/runtime/evidence/ledger.js";
import {
  buildReviewOutput,
  normalizeReviewFinding,
  normalizeReviewFindings,
  REVIEW_FINDING_SCHEMA,
  REVIEW_OUTPUT_SCHEMA,
  summarizeReviewFindings,
  validateReviewFinding,
} from "./src/review/findings.js";
import { buildReviewFixPrd, inspectReviewFixLoop } from "./src/review/fix-loop.js";
import {
  buildRunFinalAnswer,
  buildRunReport,
  formatRunFinalAnswerMarkdown,
  formatRunReportMarkdown,
  runReportPaths,
  writeRunReport,
} from "./src/runtime/evidence/report.js";
import {
  createWorkflowPlan,
  getWorkflow,
  listWorkflowSkillDescriptors,
  listWorkflows,
  workflowToSkillDescriptor,
} from "./src/workflows/registry.js";
import {
  buildYoloCommandRegistry,
  getYoloCommand,
  listYoloBridgeWorkflowIds,
  listYoloCommandNames,
  listYoloCommands,
  renderYoloCommandUsage,
  YOLO_COMMAND_REGISTRY_SCHEMA_VERSION,
} from "./src/workflows/command-registry.js";
import {
  buildWorkflowSkillInstallPlan,
  installWorkflowSkills,
  inspectWorkflowSkillInstallPlan,
  buildWorkflowSkillTargetSmokePlan,
  runWorkflowSkillTargetSmoke,
  validateWorkflowSkillDescriptor,
} from "./src/workflows/install.js";
import {
  fixtureEvidenceRecord,
  getFixtureDefinition,
  inspectFixtureDefinition,
  inspectFixtureRegistry,
  listFixtureDefinitions,
} from "./src/fixtures/registry.js";
import {
  copyFixtureToWorkspace,
  runFixtureHarness,
} from "./src/fixtures/harness.js";
import {
  inspectPackageReadiness,
  inspectPublicBetaReadiness,
} from "./src/release/readiness.js";
import {
  buildPackageInstallSmokePlan,
  inspectPackedPackage,
  PACKAGE_INSTALL_SMOKE_SCHEMA_VERSION,
  runPackageInstallSmoke,
} from "./src/release/pack-smoke.js";
import {
  buildPublicBetaHardeningDrillPlan,
  PUBLIC_BETA_HARDENING_DRILL_SCHEMA_VERSION,
  runPublicBetaHardeningDrill,
} from "./src/release/hardening-drill.js";
import {
  buildControlledBetaReleaseDecisionPlan,
  CONTROLLED_BETA_RELEASE_ACTIONS,
  CONTROLLED_BETA_RELEASE_DECISION_SCHEMA_VERSION,
  evaluateReleaseCandidateGate,
  RELEASE_CANDIDATE_GATE_SCHEMA_VERSION,
  RELEASE_CANDIDATE_REQUIRED_REPORTS,
  runControlledBetaReleaseDecisionGate,
  runReleaseCandidateGate,
} from "./src/release/decision-gate.js";
import {
  buildReleaseCandidateChangeManifest,
  classifyReleaseChangeDomain,
  readReleaseCandidateChangeManifest,
  RELEASE_CHANGE_DOMAINS,
} from "./src/release/change-provenance.js";
import {
  buildCleanEnvironmentVerifyPlan,
  CLEAN_ENVIRONMENT_VERIFY_SCHEMA_VERSION,
  executeCleanEnvironmentVerifyPlan,
  runCleanEnvironmentVerify,
} from "./src/release/clean-environment-verify.js";
import {
  buildDogfoodMatrixEvidence,
  buildDogfoodMatrixPlan,
  buildDogfoodMatrixReport,
  DOGFOOD_MATRIX_SCENARIO_IDS,
  DOGFOOD_MATRIX_SCHEMA_VERSION,
  listDogfoodMatrixScenarios,
} from "./src/release/dogfood-matrix.js";
import {
  buildOperatorReleaseStatePlan,
  OPERATOR_RELEASE_STATE_SCHEMA_VERSION,
  runOperatorReleaseStateMutation,
} from "./src/release/operator-state.js";
import {
  buildOperatorReleaseRunbookPlan,
  OPERATOR_RELEASE_OPERATIONS,
  OPERATOR_RELEASE_RUNBOOK_SCHEMA_VERSION,
  runOperatorReleaseRunbookGate,
} from "./src/release/operator-runbook.js";
import {
  buildPostReleaseAuditPlan,
  POST_RELEASE_AUDIT_SCHEMA_VERSION,
  runPostReleaseAuditGate,
} from "./src/release/post-release-audit.js";
import {
  buildStableGraduationPlan,
  STABLE_GRADUATION_SCHEMA_VERSION,
  runStableGraduationGate,
} from "./src/release/stable-graduation.js";
import {
  buildManualExternalReleasePlan,
  MANUAL_EXTERNAL_RELEASE_SCHEMA_VERSION,
  runManualExternalReleaseGate,
} from "./src/release/manual-external-release.js";
import {
  AGENT_INTEGRATION_DOCTOR_SCHEMA_VERSION,
  buildAgentIntegrationDoctorPlan,
  runAgentIntegrationDoctor,
} from "./src/release/agent-integration-doctor.js";
import {
  buildRealProjectDogfoodPlan,
  REAL_PROJECT_DOGFOOD_SCHEMA_VERSION,
  runRealProjectDogfoodGate,
} from "./src/release/real-project-dogfood.js";
import {
  buildPiExecutionDrillPlan,
  PI_EXECUTION_DRILL_SCHEMA_VERSION,
  runPiExecutionDrillGate,
} from "./src/release/pi-execution-drill.js";
import {
  buildRuntimeBoundaryDecisionPlan,
  RUNTIME_BOUNDARY_DECISION_SCHEMA_VERSION,
  runRuntimeBoundaryDecisionGate,
} from "./src/release/runtime-boundary-decision.js";
import {
  buildPublicBetaEvidencePlan,
  PUBLIC_BETA_EVIDENCE_SCHEMA_VERSION,
  runPublicBetaEvidenceGate,
} from "./src/release/public-beta-evidence.js";
import {
  buildRealProjectDogfoodPackPlan,
  inspectAgentBridgeDryRunDoctor,
  REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
  runRealProjectDogfoodPack,
} from "./src/release/real-project-dogfood-pack.js";
import {
  buildExperiencePackEffectivenessAuditPlan,
  EXPERIENCE_PACK_AUDIT_SCHEMA_VERSION,
  runExperiencePackEffectivenessAudit,
} from "./src/release/experience-pack-audit.js";
import {
  buildNonTechnicalUxDoctorPlan,
  NONTECHNICAL_UX_DOCTOR_SCHEMA_VERSION,
  runNonTechnicalUxDoctor,
  YOLO_CODEX_FALLBACK_ENTRY,
  YOLO_ONE_SENTENCE_ENTRY,
} from "./src/release/nontechnical-ux-doctor.js";
import {
  buildYoloDoctorReport,
  formatYoloDoctorText,
  YOLO_DOCTOR_SCHEMA_VERSION,
} from "./src/devtools/doctor.js";
import { generateFindingsFromRequirement } from "./src/demand/findings-generator.js";
import { convertAuditToPrd } from "./src/prd/audit-to-prd.js";
import { validatePrdPath } from "./src/prd/validate.js";
import { createPrdMigrationAdvice, migratePrdFile, migratePrdGates } from "./src/prd/migration.js";
import { preflightAllPrds, preflightPrd } from "./src/prd/preflight.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function buildStableSdkFacade(sdk) {
  return {
    agents: {
      createPlan: sdk.agents.createPlan,
      getPreset: sdk.agents.getPreset,
      listPresets: sdk.agents.listPresets,
    },
    config: sdk.config,
    contract: sdk.contract,
    paths: sdk.paths,
    prd: {
      preflightAllPrds: sdk.prd.preflightAllPrds,
      preflightPrd: sdk.prd.preflightPrd,
      validatePrdPath: sdk.prd.validatePrdPath,
    },
    provider: {
      detectModelProvider: sdk.provider.detectModelProvider,
    },
    review: {
      scanFile: sdk.review.scanFile,
      scanProject: sdk.review.scanProject,
    },
    task: {
      inspectAtomicTask: sdk.task.inspectAtomicTask,
      inspectTaskFromPrd: sdk.task.inspectTaskFromPrd,
    },
  };
}

function buildExperimentalSdkFacade(sdk) {
  return {
    acceptance: sdk.acceptance,
    agents: {
      createPiAgent: sdk.agents.createPiAgent,
      createPiPlan: sdk.agents.createPiPlan,
      runPi: sdk.agents.runPi,
    },
    commands: sdk.commands,
    demand: sdk.demand,
    discovery: sdk.discovery,
    doctor: sdk.doctor,
    eval: sdk.eval,
    evidence: sdk.evidence,
    fixtures: sdk.fixtures,
    lifecycle: sdk.lifecycle,
    packs: sdk.packs,
    parallel: sdk.parallel,
    pi: sdk.pi,
    prd: {
      convertAuditToPrd: sdk.prd.convertAuditToPrd,
      createPrdMigrationAdvice: sdk.prd.createPrdMigrationAdvice,
      generateFindingsFromRequirement: sdk.prd.generateFindingsFromRequirement,
      migratePrdFile: sdk.prd.migratePrdFile,
      migratePrdGates: sdk.prd.migratePrdGates,
    },
    progress: sdk.progress,
    project: sdk.project,
    provider: {
      buildAgentAdapterCapabilities: sdk.provider.buildAgentAdapterCapabilities,
      buildAgentAdapterContract: sdk.provider.buildAgentAdapterContract,
      buildProviderCliDryRunMatrix: sdk.provider.buildProviderCliDryRunMatrix,
      buildProviderRuntimeMatrix: sdk.provider.buildProviderRuntimeMatrix,
      inspectAgentAdapterContract: sdk.provider.inspectAgentAdapterContract,
      inspectProviderCliDryRunMatrix: sdk.provider.inspectProviderCliDryRunMatrix,
      inspectProviderRuntimeMatrix: sdk.provider.inspectProviderRuntimeMatrix,
      normalizeAgentProvider: sdk.provider.normalizeAgentProvider,
    },
    release: sdk.release,
    review: {
      REVIEW_FINDING_SCHEMA: sdk.review.REVIEW_FINDING_SCHEMA,
      REVIEW_OUTPUT_SCHEMA: sdk.review.REVIEW_OUTPUT_SCHEMA,
      buildReviewFixPrd: sdk.review.buildReviewFixPrd,
      buildReviewOutput: sdk.review.buildReviewOutput,
      inspectReviewFixLoop: sdk.review.inspectReviewFixLoop,
      normalizeReviewFinding: sdk.review.normalizeReviewFinding,
      normalizeReviewFindings: sdk.review.normalizeReviewFindings,
      summarizeReviewFindings: sdk.review.summarizeReviewFindings,
      validateReviewFinding: sdk.review.validateReviewFinding,
    },
    runtime: sdk.runtime,
    spec: sdk.spec,
    task: {
      classifyTaskExecution: sdk.task.classifyTaskExecution,
      validateDiffQuality: sdk.task.validateDiffQuality,
      validateTestGeneration: sdk.task.validateTestGeneration,
    },
    workflows: sdk.workflows,
  };
}

export function createYoloSdk(options = Object()) {
  const cfg = options.config || loadConfig({
    forceReload: Boolean(options.forceConfigReload),
    path: options.configPath,
  });
  const yoloRoot = resolve(options.yoloRoot || __dirname);
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const stateRoot = resolve(options.stateRoot || options.state_root || join(projectRoot, ".yolo"));
  if (options.ensureDirs === true || options.ensureCanonicalDirs === true) {
    ensureCanonicalDirs(stateRoot);
  }

  const sdk = {
    config: cfg,
    paths: {
      yoloRoot,
      projectRoot,
      stateRoot,
      yoloPath: (key) => yoloPath(key, stateRoot),
      resolvePrdPath: (input) => resolvePrdPath(input, stateRoot),
    },
    project: {
      buildInitPlan: (projectOptions = Object()) => buildProjectBootstrapPlan({ projectRoot, ...projectOptions }),
      buildInitToFirstPrdSmokePlan: (projectOptions = Object()) => buildInitToFirstPrdSmokePlan({ projectRoot, ...projectOptions }),
      buildSetupPlan: (projectOptions = Object()) => buildProjectSetupPlan({ projectRoot, yoloRoot, ...projectOptions }),
      inspectSetupTarget: (projectOptions = Object()) => inspectProjectSetupTarget({ projectRoot, ...projectOptions }),
      initProject: (projectOptions = Object()) => initProject({ projectRoot, ...projectOptions }),
      runSetup: (projectOptions = Object()) => runProjectSetup({ projectRoot, yoloRoot, ...projectOptions }),
      runInitToFirstPrdSmoke: (projectOptions = Object()) => runInitToFirstPrdSmoke({ projectRoot, ...projectOptions }),
    },
    contract: {
      evaluatePreConditions: (task, prd, evalOptions = Object()) => evaluatePreConditions(task, prd, { root: projectRoot, ...evalOptions }),
      evaluatePostConditions: (task, prd, evalOptions = Object()) => evaluatePostConditions(task, prd, { root: projectRoot, ...evalOptions }),
      supportedConditionTypes,
      toGateFormat,
      inspectPrdContract,
    },
    prd: {
      convertAuditToPrd,
      createPrdMigrationAdvice,
      generateFindingsFromRequirement,
      migratePrdFile,
      migratePrdGates,
      preflightAllPrds,
      preflightPrd,
      validatePrdPath,
    },
    task: {
      inspectAtomicTask,
      inspectTaskFromPrd,
      classifyTaskExecution,
      validateDiffQuality,
      validateTestGeneration,
    },
    spec: {
      buildChangeArtifact,
      buildDesignArtifact,
      buildRequirementArtifact,
      buildSpecLifecyclePackage,
      buildTaskArtifact,
      buildTraceabilityMatrix,
      inspectSpecLifecyclePackage,
      inspectSpecGovernance,
      specLifecycleToPrd,
    },
    evidence: {
      appendJsonlRecord,
      appendRunEvent,
      appendStateEvent,
      buildEvidenceArtifact,
      buildLedgerRecord,
      buildRunFinalAnswer,
      buildRunReport,
      createEvidenceLedger,
      EVIDENCE_ARTIFACT_SCHEMA,
      EVIDENCE_SCHEMA_VERSION,
      formatRunFinalAnswerMarkdown,
      formatRunReportMarkdown,
      LEDGER_EVENT_SCHEMA,
      runReportPaths,
      validateEvidenceArtifact,
      validateLedgerRecord,
      writeRunReport,
      writeJsonArtifact,
    },
    lifecycle: {
      buildStageReport: buildLifecycleStageReport,
      writeStageReport: (stageId, report = Object(), lifecycleOptions = Object()) => {
        // Strip skipSequenceCheck — SDK path always enforces sequence validation.
        // Internal callers needing exemption must import writeLifecycleStageReport directly.
        const { skipSequenceCheck, skip_sequence_check, ...safe } = lifecycleOptions;
        return writeLifecycleStageReport(stageId, report, {
          projectRoot,
          stateRoot,
          ...safe,
        });
      },
    },
    discovery: {
      buildArtifact: (discoveryInput = Object(), discoveryOptions = Object()) => buildDiscoveryArtifact({
        projectRoot,
        stateRoot,
        ...discoveryInput,
      }, {
        projectRoot,
        stateRoot,
        ...discoveryOptions,
      }),
      buildPlan: buildDiscoveryPlan,
      buildPrd: (discovery, prdInput = Object(), prdOptions = Object()) => buildPrdFromDiscovery(discovery, prdInput, {
        projectRoot,
        stateRoot,
        ...prdOptions,
      }),
      defaultPath: () => defaultDiscoveryPath(stateRoot),
      defaultPlanPath: () => defaultDiscoveryPlanPath(stateRoot),
      defaultPrdPath: () => defaultDiscoveryPrdPath(stateRoot),
      readArtifact: readDiscoveryArtifact,
      run: (discoveryInput = Object(), discoveryOptions = Object()) => runDiscoveryRuntime({
        projectRoot,
        stateRoot,
        ...discoveryInput,
      }, {
        projectRoot,
        stateRoot,
        ...discoveryOptions,
      }),
      runPlan: (planInput = Object(), planOptions = Object()) => runDiscoveryPlanRuntime({
        projectRoot,
        stateRoot,
        ...planInput,
      }, {
        projectRoot,
        stateRoot,
        ...planOptions,
      }),
      runPrd: (prdInput = Object(), prdOptions = Object()) => runDiscoveryPrdRuntime({
        projectRoot,
        stateRoot,
        ...prdInput,
      }, {
        projectRoot,
        stateRoot,
        ...prdOptions,
      }),
    },
    demand: {
      buildArtifactGraph: buildDemandArtifactGraph,
      buildOrder: demandBuildOrder,
      buildSession: (demandInput = Object(), demandOptions = Object()) => buildDemandSession({
        projectRoot,
        stateRoot,
        ...demandInput,
      }, {
        projectRoot,
        stateRoot,
        ...demandOptions,
      }),
      blockedArtifacts: demandBlockedArtifacts,
      defaultSessionPath: (id = "") => defaultDemandSessionPath(stateRoot, id),
      inspectReadiness: inspectDemandReadiness,
      inspectPrdReadiness: (demandInput = Object(), demandOptions = Object()) => inspectDemandPrdReadiness({
        projectRoot,
        stateRoot,
        ...demandInput,
      }, {
        projectRoot,
        stateRoot,
        ...demandOptions,
      }),
      inspectTriage: (demandInput = Object(), demandOptions = Object()) => inspectDemandTriage({
        projectRoot,
        stateRoot,
        ...demandInput,
      }, {
        projectRoot,
        stateRoot,
        ...demandOptions,
      }),
      markdownArtifacts: demandMarkdownArtifacts,
      playbackUnderstanding: (session = Object()) => buildUnderstandingPlayback(session),
      readSession: readDemandSession,
      readyArtifacts: demandReadyArtifacts,
      runBrainstorm: (demandInput = Object(), demandOptions = Object()) => runDemandBrainstormRuntime({
        projectRoot,
        stateRoot,
        ...demandInput,
      }, {
        projectRoot,
        stateRoot,
        ...demandOptions,
      }),
      runDiscuss: (demandInput = Object(), demandOptions = Object()) => runDemandDiscussRuntime({
        projectRoot,
        stateRoot,
        ...demandInput,
      }, {
        projectRoot,
        stateRoot,
        ...demandOptions,
      }),
      runPrd: (demandInput = Object(), demandOptions = Object()) => runDemandPrdRuntime({
        projectRoot,
        stateRoot,
        ...demandInput,
      }, {
        projectRoot,
        stateRoot,
        ...demandOptions,
      }),
      status: (demandInput = Object(), demandOptions = Object()) => runDemandStatusRuntime({
        projectRoot,
        stateRoot,
        ...demandInput,
      }, {
        projectRoot,
        stateRoot,
        ...demandOptions,
      }),
      buildEvidenceDispatchPlan: (demandInput = Object(), demandOptions = Object()) => buildDemandEvidenceDispatchPlan({
        projectRoot,
        stateRoot,
        ...demandInput,
      }, {
        projectRoot,
        stateRoot,
        ...demandOptions,
      }),
      dispatchEvidence: (demandInput = Object(), demandOptions = Object()) => runDemandEvidenceDispatchRuntime({
        projectRoot,
        stateRoot,
        ...demandInput,
      }, {
        projectRoot,
        stateRoot,
        ...demandOptions,
      }),
      buildSessionState: (demandInput = Object(), demandOptions = Object()) => buildDemandSessionState({
        projectRoot,
        stateRoot,
        ...demandInput,
      }, {
        projectRoot,
        stateRoot,
        ...demandOptions,
      }),
      buildEvidenceTasks: buildDemandEvidenceTasks,
      evidenceAgentProtocols: DEMAND_EVIDENCE_AGENT_PROTOCOLS,
      evidenceResultSchema: DEMAND_EVIDENCE_RESULT_SCHEMA_DEFINITION,
      inspectEvidenceAgreement,
      schemaVersion: DEMAND_SESSION_SCHEMA_VERSION,
      stateDir: (id = "") => demandStateDir(stateRoot, id),
      graphSchemaVersion: DEMAND_GRAPH_SCHEMA_VERSION,
      readinessSchemaVersion: DEMAND_READINESS_SCHEMA_VERSION,
      routerSchemaVersion: DEMAND_ROUTER_SCHEMA_VERSION,
      prdReadinessSchemaVersion: DEMAND_PRD_READINESS_SCHEMA_VERSION,
      evidenceDispatchSchemaVersion: DEMAND_EVIDENCE_DISPATCH_SCHEMA_VERSION,
      writeArtifacts: writeDemandArtifacts,
    },
    packs: {
      discoverManifests: (packOptions = Object()) => discoverPackManifests({ projectRoot, stateRoot, ...packOptions }),
      readManifest: readPackManifest,
      resolveProjectContext: (packOptions = Object()) => resolveProjectContext({ projectRoot, stateRoot, ...packOptions }),
      validateManifest: validatePackManifest,
    },
    acceptance: {
      buildAdapterEvidencePlan: (adapterInput = Object(), adapterOptions = Object()) => buildAdapterEvidencePlan({
        projectRoot,
        stateRoot,
        ...adapterInput,
      }, {
        projectRoot,
        stateRoot,
        ...adapterOptions,
      }),
      buildReport: (acceptanceInput = Object(), acceptanceOptions = Object()) => buildAcceptanceReport({
        projectRoot,
        stateRoot,
        ...acceptanceInput,
      }, {
        projectRoot,
        stateRoot,
        ...acceptanceOptions,
      }),
      collectAdapterEvidence: (adapterInput = Object(), adapterOptions = Object()) => runAdapterEvidenceCollector({
        projectRoot,
        stateRoot,
        ...adapterInput,
      }, {
        projectRoot,
        stateRoot,
        ...adapterOptions,
      }),
      formatReportText: formatAcceptanceReportText,
      inspectReport: (acceptanceInput = Object(), acceptanceOptions = Object()) => inspectAcceptanceReport({
        projectRoot,
        stateRoot,
        ...acceptanceInput,
      }, {
        projectRoot,
        stateRoot,
        ...acceptanceOptions,
      }),
    },
    eval: {
      buildBenchmarkPlan: (evalOptions = Object()) => buildYoloBenchmarkPlan({ projectRoot, stateRoot, ...evalOptions }),
      formatBenchmarkText: formatYoloBenchmarkText,
      listBenchmarkFixtures,
      rubric: YOLO_BENCHMARK_RUBRIC,
      runBenchmark: (evalInput = Object(), evalOptions = Object()) => runYoloBenchmark({
        projectRoot,
        stateRoot,
        ...evalInput,
      }, {
        projectRoot,
        stateRoot,
        ...evalOptions,
      }),
      scoreScenario: scoreBenchmarkScenario,
    },
    commands: {
      buildRegistry: buildYoloCommandRegistry,
      get: getYoloCommand,
      list: listYoloCommands,
      listBridgeWorkflowIds: listYoloBridgeWorkflowIds,
      listNames: listYoloCommandNames,
      renderUsage: renderYoloCommandUsage,
      schemaVersion: YOLO_COMMAND_REGISTRY_SCHEMA_VERSION,
    },
    doctor: {
      buildReport: (doctorOptions = Object()) => buildYoloDoctorReport({
        yoloRoot,
        projectRoot,
        ...doctorOptions,
      }),
      formatReportText: formatYoloDoctorText,
      schemaVersion: YOLO_DOCTOR_SCHEMA_VERSION,
    },
    parallel: {
      buildExecutionPlan: (parallelInput = Object(), parallelOptions = Object()) => buildControlledParallelExecutionPlan({
        projectRoot,
        stateRoot,
        ...parallelInput,
      }, {
        projectRoot,
        stateRoot,
        ...parallelOptions,
      }),
      buildTaskDependencyGraph,
      detectConflicts: detectParallelConflicts,
      formatPlanText: formatControlledParallelPlanText,
      inspectMergeGate: inspectParallelMergeGate,
      mergeEvidence: mergeParallelEvidence,
      planWaves: (parallelInput = Object(), parallelOptions = Object()) => planControlledParallelWaves({
        projectRoot,
        stateRoot,
        ...parallelInput,
      }, {
        projectRoot,
        stateRoot,
        ...parallelOptions,
      }),
    },
    workflows: {
      buildSkillInstallPlan: (workflowOptions = Object()) => buildWorkflowSkillInstallPlan({ projectRoot, ...workflowOptions }),
      buildSkillTargetSmokePlan: (workflowOptions = Object()) => buildWorkflowSkillTargetSmokePlan({ projectRoot, ...workflowOptions }),
      createWorkflowPlan,
      getWorkflow,
      installSkills: (workflowOptions = Object()) => installWorkflowSkills({ projectRoot, ...workflowOptions }),
      inspectSkillInstallPlan: inspectWorkflowSkillInstallPlan,
      listWorkflowSkillDescriptors,
      listWorkflows,
      runSkillTargetSmoke: (workflowOptions = Object()) => runWorkflowSkillTargetSmoke({ projectRoot, ...workflowOptions }),
      validateSkillDescriptor: validateWorkflowSkillDescriptor,
      workflowToSkillDescriptor,
    },
    fixtures: {
      fixtureEvidenceRecord,
      copyFixtureToWorkspace,
      getFixtureDefinition: (id, fixtureOptions = Object()) => getFixtureDefinition(id, { yoloRoot, ...fixtureOptions }),
      inspectFixtureDefinition,
      inspectFixtureRegistry: (fixtureOptions = Object()) => inspectFixtureRegistry({ yoloRoot, ...fixtureOptions }),
      listFixtureDefinitions: (fixtureOptions = Object()) => listFixtureDefinitions({ yoloRoot, ...fixtureOptions }),
      runFixtureHarness: (id, fixtureOptions = Object()) => runFixtureHarness(id, { yoloRoot, ...fixtureOptions }),
    },
    release: {
      buildPackageInstallSmokePlan: (releaseOptions = Object()) => buildPackageInstallSmokePlan({ yoloRoot, ...releaseOptions }),
      buildControlledBetaReleaseDecisionPlan: (releaseOptions = Object()) => buildControlledBetaReleaseDecisionPlan({ yoloRoot, ...releaseOptions }),
      buildReleaseCandidateChangeManifest: (releaseOptions = Object()) => buildReleaseCandidateChangeManifest({ rootDir: yoloRoot, ...releaseOptions }),
      buildCleanEnvironmentVerifyPlan: (releaseOptions = Object()) => buildCleanEnvironmentVerifyPlan({ yoloRoot, ...releaseOptions }),
      buildDogfoodMatrixPlan: (releaseOptions = Object()) => buildDogfoodMatrixPlan({ yoloRoot, projectRoot, ...releaseOptions }),
      buildDogfoodMatrixReport: (releaseOptions = Object()) => buildDogfoodMatrixReport({ yoloRoot, projectRoot, ...releaseOptions }),
      buildDogfoodMatrixEvidence,
      buildOperatorReleaseRunbookPlan: (releaseOptions = Object()) => buildOperatorReleaseRunbookPlan({ yoloRoot, ...releaseOptions }),
      buildOperatorReleaseStatePlan: (releaseOptions = Object()) => buildOperatorReleaseStatePlan({ yoloRoot, ...releaseOptions }),
      buildPostReleaseAuditPlan: (releaseOptions = Object()) => buildPostReleaseAuditPlan({ yoloRoot, ...releaseOptions }),
      buildPublicBetaHardeningDrillPlan: (releaseOptions = Object()) => buildPublicBetaHardeningDrillPlan({ yoloRoot, ...releaseOptions }),
      buildStableGraduationPlan: (releaseOptions = Object()) => buildStableGraduationPlan({ yoloRoot, ...releaseOptions }),
      buildManualExternalReleasePlan: (releaseOptions = Object()) => buildManualExternalReleasePlan({ yoloRoot, ...releaseOptions }),
      buildAgentIntegrationDoctorPlan: (releaseOptions = Object()) => buildAgentIntegrationDoctorPlan({ yoloRoot, projectRoot, ...releaseOptions }),
      buildRealProjectDogfoodPlan: (releaseOptions = Object()) => buildRealProjectDogfoodPlan({ yoloRoot, projectRoot, ...releaseOptions }),
      buildPiExecutionDrillPlan: (releaseOptions = Object()) => buildPiExecutionDrillPlan({ yoloRoot, projectRoot, ...releaseOptions }),
      buildRuntimeBoundaryDecisionPlan: (releaseOptions = Object()) => buildRuntimeBoundaryDecisionPlan({ yoloRoot, ...releaseOptions }),
      buildPublicBetaEvidencePlan: (releaseOptions = Object()) => buildPublicBetaEvidencePlan({ yoloRoot, projectRoot, ...releaseOptions }),
      buildRealProjectDogfoodPackPlan: (releaseOptions = Object()) => buildRealProjectDogfoodPackPlan({ yoloRoot, projectRoot, ...releaseOptions }),
      buildExperiencePackEffectivenessAuditPlan: (releaseOptions = Object()) => buildExperiencePackEffectivenessAuditPlan({ projectRoot, stateRoot, ...releaseOptions }),
      buildNonTechnicalUxDoctorPlan: (releaseOptions = Object()) => buildNonTechnicalUxDoctorPlan({ yoloRoot, ...releaseOptions }),
      inspectAgentBridgeDryRunDoctor,
      inspectPackedPackage,
      inspectPackageReadiness,
      inspectPublicBetaReadiness: (releaseOptions = Object()) => inspectPublicBetaReadiness({ yoloRoot, ...releaseOptions }),
      classifyReleaseChangeDomain,
      listDogfoodMatrixScenarios,
      runPackageInstallSmoke: (releaseOptions = Object()) => runPackageInstallSmoke({ yoloRoot, ...releaseOptions }),
      runControlledBetaReleaseDecisionGate: (releaseOptions = Object()) => runControlledBetaReleaseDecisionGate({ yoloRoot, ...releaseOptions }),
      runReleaseCandidateGate,
      evaluateReleaseCandidateGate,
      readReleaseCandidateChangeManifest: (releaseOptions = Object()) => readReleaseCandidateChangeManifest({ rootDir: yoloRoot, ...releaseOptions }),
      executeCleanEnvironmentVerifyPlan,
      runCleanEnvironmentVerify: (releaseOptions = Object()) => runCleanEnvironmentVerify({ yoloRoot, ...releaseOptions }),
      runOperatorReleaseRunbookGate: (releaseOptions = Object()) => runOperatorReleaseRunbookGate({ yoloRoot, ...releaseOptions }),
      runOperatorReleaseStateMutation: (releaseOptions = Object()) => runOperatorReleaseStateMutation({ yoloRoot, ...releaseOptions }),
      runPostReleaseAuditGate: (releaseOptions = Object()) => runPostReleaseAuditGate({ yoloRoot, ...releaseOptions }),
      runPublicBetaHardeningDrill: (releaseOptions = Object()) => runPublicBetaHardeningDrill({ yoloRoot, ...releaseOptions }),
      runStableGraduationGate: (releaseOptions = Object()) => runStableGraduationGate({ yoloRoot, ...releaseOptions }),
      runManualExternalReleaseGate: (releaseOptions = Object()) => runManualExternalReleaseGate({ yoloRoot, ...releaseOptions }),
      runAgentIntegrationDoctor: (releaseOptions = Object()) => runAgentIntegrationDoctor({ yoloRoot, projectRoot, ...releaseOptions }),
      runRealProjectDogfoodGate: (releaseOptions = Object()) => runRealProjectDogfoodGate({ yoloRoot, projectRoot, ...releaseOptions }),
      runPiExecutionDrillGate: (releaseOptions = Object()) => runPiExecutionDrillGate({ yoloRoot, projectRoot, ...releaseOptions }),
      runRuntimeBoundaryDecisionGate: (releaseOptions = Object()) => runRuntimeBoundaryDecisionGate({ yoloRoot, ...releaseOptions }),
      runPublicBetaEvidenceGate: (releaseOptions = Object()) => runPublicBetaEvidenceGate({ yoloRoot, projectRoot, ...releaseOptions }),
      runRealProjectDogfoodPack: (releaseOptions = Object()) => runRealProjectDogfoodPack({ yoloRoot, projectRoot, ...releaseOptions }),
      runExperiencePackEffectivenessAudit: (releaseOptions = Object()) => runExperiencePackEffectivenessAudit({ projectRoot, stateRoot, ...releaseOptions }),
      runNonTechnicalUxDoctor: (releaseOptions = Object()) => runNonTechnicalUxDoctor({ yoloRoot, ...releaseOptions }),
    },
    provider: {
      buildAgentAdapterCapabilities,
      buildAgentAdapterContract: (providerOptions = Object()) => buildAgentAdapterContract({ config: cfg, ...providerOptions }),
      buildProviderRuntimeMatrix: (providerOptions = Object()) => buildProviderRuntimeMatrix({
        config: cfg,
        projectRoot,
        stateRoot,
        ...providerOptions,
      }),
      buildProviderCliDryRunMatrix: (providerOptions = Object()) => buildProviderCliDryRunMatrix({
        config: cfg,
        projectRoot,
        stateRoot,
        ...providerOptions,
      }),
      detectModelProvider,
      inspectAgentAdapterContract: (providerOptions = Object()) => inspectAgentAdapterContract({
        config: cfg,
        providerDetection: detectModelProvider({ config: cfg }),
        ...providerOptions,
      }),
      inspectProviderRuntimeMatrix: (providerOptions = Object()) => inspectProviderRuntimeMatrix({
        config: cfg,
        projectRoot,
        stateRoot,
        ...providerOptions,
      }),
      inspectProviderCliDryRunMatrix: (providerOptions = Object()) => inspectProviderCliDryRunMatrix({
        config: cfg,
        projectRoot,
        stateRoot,
        ...providerOptions,
      }),
      normalizeAgentProvider,
    },
    runtime: {
      runPiRuntime,
      runRunner: (input = Object(), runtimeOptions = Object()) => runRunnerRuntime({
        projectRoot,
        stateRoot,
        ...input,
      }, {
        projectRoot,
        stateRoot,
        ...runtimeOptions,
      }),
      inspectCheck: (input = Object(), checkOptions = Object()) => inspectYoloCheck({
        projectRoot,
        stateRoot,
        ...input,
      }, {
        projectRoot,
        stateRoot,
        ...checkOptions,
      }),
      formatCheckText: formatYoloCheckText,
    },
    progress: {
      buildUiEvidence: (progressInput = Object(), progressOptions = Object()) => buildProgressDashboardUiEvidence({
        projectRoot,
        stateRoot,
        ...progressInput,
      }, {
        projectRoot,
        stateRoot,
        ...progressOptions,
      }),
      inspectUiEvidence: (progressInput = Object(), progressOptions = Object()) => inspectProgressDashboardUiEvidence({
        projectRoot,
        stateRoot,
        ...progressInput,
      }, {
        projectRoot,
        stateRoot,
        ...progressOptions,
      }),
      runUiEvidence: (progressInput = Object(), progressOptions = Object()) => runProgressDashboardUiEvidence({
        projectRoot,
        stateRoot,
        ...progressInput,
      }, {
        projectRoot,
        stateRoot,
        ...progressOptions,
      }),
    },
    agents: {
      createPlan: createAgentPlan,
      getPreset: getAgentPreset,
      listPresets: listAgentPresets,
      createPiAgent: (agentOptions = Object()) => createPiAgent({ yoloRoot, projectRoot, stateRoot, sdk, ...agentOptions }),
      createPiPlan: (input = Object(), agentOptions = Object()) => createPiRunPlan(input, { yoloRoot, projectRoot, stateRoot, ...agentOptions }),
      runPi: (input = Object(), agentOptions = Object()) => runPiAgent(input, { yoloRoot, projectRoot, stateRoot, ...agentOptions }),
    },
    pi: {
      createAgent: (agentOptions = Object()) => createPiAgent({ yoloRoot, projectRoot, stateRoot, sdk, ...agentOptions }),
      createPlan: (input = Object(), agentOptions = Object()) => createPiRunPlan(input, { yoloRoot, projectRoot, stateRoot, ...agentOptions }),
      run: (input = Object(), agentOptions = Object()) => runPiAgent(input, { yoloRoot, projectRoot, stateRoot, ...agentOptions }),
    },
    review: {
      scanProject: (scanOptions = Object()) => scanProject({ root: projectRoot, config: cfg, ...scanOptions }),
      scanFile: (file, scanOptions = Object()) => scanFile(file, { root: projectRoot, config: cfg, ...scanOptions }),
      buildReviewOutput,
      buildReviewFixPrd,
      inspectReviewFixLoop: (input = Object(), reviewOptions = Object()) => inspectReviewFixLoop({
        projectRoot,
        stateRoot,
        ...input,
      }, {
        projectRoot,
        stateRoot,
        ...reviewOptions,
      }),
      normalizeReviewFinding,
      normalizeReviewFindings,
      REVIEW_FINDING_SCHEMA,
      REVIEW_OUTPUT_SCHEMA,
      summarizeReviewFindings,
      validateReviewFinding,
    },
  };
  return Object.assign(sdk, {
    stable: buildStableSdkFacade(sdk),
    experimental: buildExperimentalSdkFacade(sdk),
  });
}

export {
  config,
  loadConfig,
  buildProjectBootstrapPlan,
  buildInitToFirstPrdSmokePlan,
  initProject,
  inspectProjectSetupTarget,
  buildProjectSetupPlan,
  runProjectSetup,
  runInitToFirstPrdSmoke,
  evaluatePreConditions,
  evaluatePostConditions,
  inspectAtomicTask,
  inspectTaskFromPrd,
  inspectPrdContract,
  detectModelProvider,
  scanProject,
  scanFile,
  supportedConditionTypes,
  toGateFormat,
  createAgentPlan,
  getAgentPreset,
  listAgentPresets,
  buildAgentAdapterCapabilities,
  buildAgentAdapterContract,
  inspectAgentAdapterContract,
  normalizeAgentProvider,
  ADAPTER_EVIDENCE_COLLECTOR_SCHEMA_VERSION,
  buildAdapterEvidencePlan,
  runAdapterEvidenceCollector,
  buildDemandEvidenceDispatchPlan,
  runDemandEvidenceDispatchRuntime,
  DEMAND_EVIDENCE_DISPATCH_SCHEMA_VERSION,
  buildProgressDashboardUiEvidence,
  inspectProgressDashboardUiEvidence,
  PROGRESS_DASHBOARD_UI_EVIDENCE_SCHEMA_VERSION,
  runProgressDashboardUiEvidence,
  createPiAgent,
  createPiRunPlan,
  runPiAgent,
  runPiRuntime,
  runRunnerRuntime,
  inspectYoloCheck,
  formatYoloCheckText,
  buildAcceptanceReport,
  formatAcceptanceReportText,
  inspectAcceptanceReport,
  buildYoloBenchmarkPlan,
  formatYoloBenchmarkText,
  listBenchmarkFixtures,
  runBenchmark,
  runYoloBenchmark,
  scoreBenchmarkScenario,
  YOLO_BENCHMARK_RUBRIC,
  YOLO_BENCHMARK_SCHEMA_VERSION,
  buildYoloCommandRegistry,
  getYoloCommand,
  listYoloBridgeWorkflowIds,
  listYoloCommandNames,
  listYoloCommands,
  renderYoloCommandUsage,
  YOLO_COMMAND_REGISTRY_SCHEMA_VERSION,
  buildYoloDoctorReport,
  formatYoloDoctorText,
  YOLO_DOCTOR_SCHEMA_VERSION,
  buildControlledParallelExecutionPlan,
  buildTaskDependencyGraph,
  CONTROLLED_PARALLEL_SCHEMA_VERSION,
  detectParallelConflicts,
  formatControlledParallelPlanText,
  inspectParallelMergeGate,
  mergeParallelEvidence,
  planControlledParallelWaves,
  buildLifecycleStageReport,
  buildDiscoveryArtifact,
  buildDiscoveryPlan,
  buildPrdFromDiscovery,
  defaultDiscoveryPath,
  defaultDiscoveryPlanPath,
  defaultDiscoveryPrdPath,
  readDiscoveryArtifact,
  runDiscoveryPlanRuntime,
  runDiscoveryPrdRuntime,
  runDiscoveryRuntime,
  buildDemandArtifactGraph,
  buildDemandSession,
  demandBlockedArtifacts,
  demandBuildOrder,
  demandMarkdownArtifacts,
  demandReadyArtifacts,
  demandStateDir,
  defaultDemandSessionPath,
  DEMAND_GRAPH_SCHEMA_VERSION,
  DEMAND_READINESS_SCHEMA_VERSION,
  DEMAND_SESSION_SCHEMA_VERSION,
  inspectDemandReadiness,
  readDemandSession,
  runDemandBrainstormRuntime,
  runDemandDiscussRuntime,
  runDemandPrdRuntime,
  writeDemandArtifacts,
  discoverPackManifests,
  readPackManifest,
  resolveProjectContext,
  validatePackManifest,
  buildTraceabilityMatrix,
  buildChangeArtifact,
  buildDesignArtifact,
  buildRequirementArtifact,
  buildSpecLifecyclePackage,
  buildTaskArtifact,
  inspectSpecLifecyclePackage,
  inspectSpecGovernance,
  specLifecycleToPrd,
  appendJsonlRecord,
  appendRunEvent,
  appendStateEvent,
  buildEvidenceArtifact,
  buildLedgerRecord,
  buildRunReport,
  buildRunFinalAnswer,
  createEvidenceLedger,
  EVIDENCE_ARTIFACT_SCHEMA,
  EVIDENCE_SCHEMA_VERSION,
  formatRunReportMarkdown,
  formatRunFinalAnswerMarkdown,
  LEDGER_EVENT_SCHEMA,
  runReportPaths,
  validateEvidenceArtifact,
  validateLedgerRecord,
  writeRunReport,
  writeJsonArtifact,
  buildReviewOutput,
  buildReviewFixPrd,
  inspectReviewFixLoop,
  normalizeReviewFinding,
  normalizeReviewFindings,
  REVIEW_FINDING_SCHEMA,
  REVIEW_OUTPUT_SCHEMA,
  summarizeReviewFindings,
  validateReviewFinding,
  createWorkflowPlan,
  getWorkflow,
  buildWorkflowSkillInstallPlan,
  buildWorkflowSkillTargetSmokePlan,
  installWorkflowSkills,
  inspectWorkflowSkillInstallPlan,
  runWorkflowSkillTargetSmoke,
  listWorkflowSkillDescriptors,
  listWorkflows,
  validateWorkflowSkillDescriptor,
  workflowToSkillDescriptor,
  fixtureEvidenceRecord,
  copyFixtureToWorkspace,
  getFixtureDefinition,
  inspectFixtureDefinition,
  inspectFixtureRegistry,
  listFixtureDefinitions,
  runFixtureHarness,
  inspectPackageReadiness,
  inspectPublicBetaReadiness,
  buildPackageInstallSmokePlan,
  buildControlledBetaReleaseDecisionPlan,
  buildPublicBetaHardeningDrillPlan,
  buildReleaseCandidateChangeManifest,
  buildCleanEnvironmentVerifyPlan,
  buildDogfoodMatrixEvidence,
  buildDogfoodMatrixPlan,
  buildDogfoodMatrixReport,
  inspectPackedPackage,
  classifyReleaseChangeDomain,
  listDogfoodMatrixScenarios,
  CONTROLLED_BETA_RELEASE_ACTIONS,
  CONTROLLED_BETA_RELEASE_DECISION_SCHEMA_VERSION,
  RELEASE_CANDIDATE_GATE_SCHEMA_VERSION,
  RELEASE_CANDIDATE_REQUIRED_REPORTS,
  RELEASE_CHANGE_DOMAINS,
  CLEAN_ENVIRONMENT_VERIFY_SCHEMA_VERSION,
  DOGFOOD_MATRIX_SCHEMA_VERSION,
  DOGFOOD_MATRIX_SCENARIO_IDS,
  buildOperatorReleaseRunbookPlan,
  buildOperatorReleaseStatePlan,
  buildPostReleaseAuditPlan,
  buildStableGraduationPlan,
  buildManualExternalReleasePlan,
  buildAgentIntegrationDoctorPlan,
  buildRealProjectDogfoodPlan,
  buildPiExecutionDrillPlan,
  buildRuntimeBoundaryDecisionPlan,
  buildPublicBetaEvidencePlan,
  buildRealProjectDogfoodPackPlan,
  buildExperiencePackEffectivenessAuditPlan,
  buildNonTechnicalUxDoctorPlan,
  inspectAgentBridgeDryRunDoctor,
  OPERATOR_RELEASE_OPERATIONS,
  OPERATOR_RELEASE_RUNBOOK_SCHEMA_VERSION,
  PACKAGE_INSTALL_SMOKE_SCHEMA_VERSION,
  OPERATOR_RELEASE_STATE_SCHEMA_VERSION,
  POST_RELEASE_AUDIT_SCHEMA_VERSION,
  PUBLIC_BETA_HARDENING_DRILL_SCHEMA_VERSION,
  STABLE_GRADUATION_SCHEMA_VERSION,
  MANUAL_EXTERNAL_RELEASE_SCHEMA_VERSION,
  AGENT_INTEGRATION_DOCTOR_SCHEMA_VERSION,
  REAL_PROJECT_DOGFOOD_SCHEMA_VERSION,
  PI_EXECUTION_DRILL_SCHEMA_VERSION,
  RUNTIME_BOUNDARY_DECISION_SCHEMA_VERSION,
  PUBLIC_BETA_EVIDENCE_SCHEMA_VERSION,
  REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
  EXPERIENCE_PACK_AUDIT_SCHEMA_VERSION,
  NONTECHNICAL_UX_DOCTOR_SCHEMA_VERSION,
  YOLO_CODEX_FALLBACK_ENTRY,
  YOLO_ONE_SENTENCE_ENTRY,
  runPackageInstallSmoke,
  runControlledBetaReleaseDecisionGate,
  runReleaseCandidateGate,
  evaluateReleaseCandidateGate,
  readReleaseCandidateChangeManifest,
  executeCleanEnvironmentVerifyPlan,
  runCleanEnvironmentVerify,
  runOperatorReleaseRunbookGate,
  runOperatorReleaseStateMutation,
  runPostReleaseAuditGate,
  runPublicBetaHardeningDrill,
  runStableGraduationGate,
  runManualExternalReleaseGate,
  runAgentIntegrationDoctor,
  runRealProjectDogfoodGate,
  runPiExecutionDrillGate,
  runRuntimeBoundaryDecisionGate,
  runPublicBetaEvidenceGate,
  runRealProjectDogfoodPack,
  runExperiencePackEffectivenessAudit,
  runNonTechnicalUxDoctor,
  convertAuditToPrd,
  createPrdMigrationAdvice,
  generateFindingsFromRequirement,
  migratePrdFile,
  migratePrdGates,
  preflightAllPrds,
  preflightPrd,
  validatePrdPath,
};

export default createYoloSdk;
