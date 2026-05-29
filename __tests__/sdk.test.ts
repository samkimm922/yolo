import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import createYoloSdk, { ADAPTER_EVIDENCE_COLLECTOR_SCHEMA_VERSION, buildAcceptanceReport, buildAdapterEvidencePlan, buildAgentIntegrationDoctorPlan, buildControlledBetaReleaseDecisionPlan, buildEvidenceArtifact, buildInitToFirstPrdSmokePlan, buildLifecycleStageReport, buildManualExternalReleasePlan, buildOperatorReleaseRunbookPlan, buildOperatorReleaseStatePlan, buildPackageInstallSmokePlan, buildPiExecutionDrillPlan, buildPostReleaseAuditPlan, buildProgressDashboardUiEvidence, buildPublicBetaEvidencePlan, buildPublicBetaHardeningDrillPlan, buildRealProjectDogfoodPlan, buildReviewFixPrd, buildReviewOutput, buildRunFinalAnswer, buildRunReport, buildRuntimeBoundaryDecisionPlan, buildStableGraduationPlan, buildTraceabilityMatrix, buildYoloBenchmarkPlan, createEvidenceLedger, createPrdMigrationAdvice, discoverPackManifests, formatAcceptanceReportText, formatRunFinalAnswerMarkdown, formatYoloBenchmarkText, formatYoloCheckText, inspectAcceptanceReport, inspectPackageReadiness, inspectPackedPackage, inspectPrdContract, inspectProgressDashboardUiEvidence, inspectReviewFixLoop, inspectYoloCheck, listAgentPresets, listBenchmarkFixtures, listFixtureDefinitions, listWorkflows, migratePrdFile, migratePrdGates, normalizeReviewFinding, preflightPrd, PROGRESS_DASHBOARD_UI_EVIDENCE_SCHEMA_VERSION, readPackManifest, resolveProjectContext, runAdapterEvidenceCollector, runAgentIntegrationDoctor, runBenchmark, runControlledBetaReleaseDecisionGate, runFixtureHarness, runInitToFirstPrdSmoke, runManualExternalReleaseGate, runOperatorReleaseRunbookGate, runOperatorReleaseStateMutation, runPackageInstallSmoke, runPiAgent, runPiExecutionDrillGate, runPiRuntime, runPostReleaseAuditGate, runProgressDashboardUiEvidence, runPublicBetaEvidenceGate, runPublicBetaHardeningDrill, runRealProjectDogfoodGate, runRunnerRuntime, runRuntimeBoundaryDecisionGate, runStableGraduationGate, runYoloBenchmark, scanProject, scoreBenchmarkScenario, supportedConditionTypes, validatePackManifest, writeLifecycleStageReport, writeRunReport, YOLO_BENCHMARK_SCHEMA_VERSION } from "../sdk.js";
import {
  buildControlledParallelExecutionPlan,
  buildTaskDependencyGraph,
  CONTROLLED_PARALLEL_SCHEMA_VERSION,
  detectParallelConflicts,
  formatControlledParallelPlanText,
  inspectParallelMergeGate,
  mergeParallelEvidence,
  planControlledParallelWaves,
} from "../sdk.js";
import {
  buildDemandArtifactGraph,
  buildDemandSession,
  buildDiscoveryArtifact,
  buildYoloCommandRegistry,
  buildYoloDoctorReport,
  DEMAND_SESSION_SCHEMA_VERSION,
  formatYoloDoctorText,
  getYoloCommand,
  inspectDemandReadiness,
  listYoloCommandNames,
  renderYoloCommandUsage,
  runDemandBrainstormRuntime,
  runDemandDiscussRuntime,
  runDemandPrdRuntime,
  runDiscoveryRuntime,
  YOLO_COMMAND_REGISTRY_SCHEMA_VERSION,
  YOLO_DOCTOR_SCHEMA_VERSION,
} from "../sdk.js";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../lib/config.js";

const YOLO_DIR = fileURLToPath(new URL("..", import.meta.url));

describe("yolo sdk", () => {
  test("exports stable contract and scanner APIs", () => {
    const sdk = createYoloSdk();
    assert.equal(typeof sdk.contract.evaluatePostConditions, "function");
    assert.equal(typeof sdk.prd.convertAuditToPrd, "function");
    assert.equal(typeof sdk.prd.createPrdMigrationAdvice, "function");
    assert.equal(typeof sdk.prd.migratePrdGates, "function");
    assert.equal(typeof sdk.prd.migratePrdFile, "function");
    assert.equal(typeof sdk.prd.preflightPrd, "function");
    assert.equal(typeof sdk.prd.validatePrdPath, "function");
    assert.equal(typeof sdk.review.scanProject, "function");
    assert.equal(typeof sdk.runtime.runPiRuntime, "function");
    assert.equal(typeof sdk.runtime.runRunner, "function");
    assert.equal(typeof sdk.agents.createPlan, "function");
    assert.equal(typeof sdk.agents.createPiPlan, "function");
    assert.equal(typeof sdk.pi.createAgent, "function");
    assert.equal(typeof sdk.pi.createPlan, "function");
    assert.equal(typeof sdk.pi.run, "function");
    assert.equal(typeof sdk.project.buildInitToFirstPrdSmokePlan, "function");
    assert.equal(typeof sdk.project.runInitToFirstPrdSmoke, "function");
    assert.equal(typeof sdk.spec.buildTraceabilityMatrix, "function");
    assert.equal(typeof sdk.spec.inspectSpecGovernance, "function");
    assert.equal(typeof sdk.evidence.buildEvidenceArtifact, "function");
    assert.equal(typeof sdk.evidence.buildRunFinalAnswer, "function");
    assert.equal(typeof sdk.evidence.buildRunReport, "function");
    assert.equal(typeof sdk.evidence.createEvidenceLedger, "function");
    assert.equal(typeof sdk.evidence.writeRunReport, "function");
    assert.equal(typeof sdk.lifecycle.buildStageReport, "function");
    assert.equal(typeof sdk.lifecycle.writeStageReport, "function");
    assert.equal(typeof sdk.discovery.buildArtifact, "function");
    assert.equal(typeof sdk.discovery.run, "function");
    assert.equal(typeof sdk.discovery.runPlan, "function");
    assert.equal(typeof sdk.discovery.runPrd, "function");
    assert.equal(typeof sdk.demand.buildSession, "function");
    assert.equal(typeof sdk.demand.inspectReadiness, "function");
    assert.equal(typeof sdk.demand.runBrainstorm, "function");
    assert.equal(typeof sdk.demand.runDiscuss, "function");
    assert.equal(typeof sdk.demand.runPrd, "function");
    assert.equal(sdk.demand.schemaVersion, "1.0");
    assert.equal(typeof sdk.packs.resolveProjectContext, "function");
    assert.equal(typeof sdk.packs.validateManifest, "function");
    assert.equal(typeof sdk.acceptance.buildReport, "function");
    assert.equal(typeof sdk.acceptance.buildAdapterEvidencePlan, "function");
    assert.equal(typeof sdk.acceptance.collectAdapterEvidence, "function");
    assert.equal(typeof sdk.acceptance.inspectReport, "function");
    assert.equal(typeof sdk.eval.buildBenchmarkPlan, "function");
    assert.equal(typeof sdk.eval.runBenchmark, "function");
    assert.equal(typeof sdk.eval.scoreScenario, "function");
    assert.equal(typeof sdk.commands.buildRegistry, "function");
    assert.equal(typeof sdk.commands.get, "function");
    assert.equal(typeof sdk.commands.list, "function");
    assert.equal(typeof sdk.commands.listBridgeWorkflowIds, "function");
    assert.equal(typeof sdk.commands.listNames, "function");
    assert.equal(typeof sdk.commands.renderUsage, "function");
    assert.equal(sdk.commands.schemaVersion, "1.0");
    assert.equal(typeof sdk.doctor.buildReport, "function");
    assert.equal(typeof sdk.doctor.formatReportText, "function");
    assert.equal(sdk.doctor.schemaVersion, "1.0");
    assert.equal(typeof sdk.parallel.buildExecutionPlan, "function");
    assert.equal(typeof sdk.parallel.buildTaskDependencyGraph, "function");
    assert.equal(typeof sdk.parallel.detectConflicts, "function");
    assert.equal(typeof sdk.parallel.formatPlanText, "function");
    assert.equal(typeof sdk.parallel.inspectMergeGate, "function");
    assert.equal(typeof sdk.parallel.mergeEvidence, "function");
    assert.equal(typeof sdk.parallel.planWaves, "function");
    assert.equal(typeof sdk.runtime.inspectCheck, "function");
    assert.equal(typeof sdk.runtime.formatCheckText, "function");
    assert.equal(typeof sdk.progress.buildUiEvidence, "function");
    assert.equal(typeof sdk.progress.inspectUiEvidence, "function");
    assert.equal(typeof sdk.progress.runUiEvidence, "function");
    assert.equal(typeof sdk.review.normalizeReviewFinding, "function");
    assert.equal(typeof sdk.review.buildReviewOutput, "function");
    assert.equal(typeof sdk.review.buildReviewFixPrd, "function");
    assert.equal(typeof sdk.review.inspectReviewFixLoop, "function");
    assert.equal(typeof sdk.workflows.createWorkflowPlan, "function");
    assert.equal(typeof sdk.workflows.listWorkflowSkillDescriptors, "function");
    assert.equal(typeof sdk.fixtures.listFixtureDefinitions, "function");
    assert.equal(typeof sdk.fixtures.inspectFixtureRegistry, "function");
    assert.equal(typeof sdk.fixtures.runFixtureHarness, "function");
    assert.equal(typeof sdk.release.buildPackageInstallSmokePlan, "function");
    assert.equal(typeof sdk.release.inspectPackedPackage, "function");
    assert.equal(typeof sdk.release.inspectPublicBetaReadiness, "function");
    assert.equal(typeof sdk.release.runPackageInstallSmoke, "function");
    assert.equal(typeof sdk.release.buildControlledBetaReleaseDecisionPlan, "function");
    assert.equal(typeof sdk.release.buildOperatorReleaseRunbookPlan, "function");
    assert.equal(typeof sdk.release.buildOperatorReleaseStatePlan, "function");
    assert.equal(typeof sdk.release.buildPostReleaseAuditPlan, "function");
    assert.equal(typeof sdk.release.buildPublicBetaHardeningDrillPlan, "function");
    assert.equal(typeof sdk.release.buildStableGraduationPlan, "function");
    assert.equal(typeof sdk.release.buildManualExternalReleasePlan, "function");
    assert.equal(typeof sdk.release.buildAgentIntegrationDoctorPlan, "function");
    assert.equal(typeof sdk.release.buildRealProjectDogfoodPlan, "function");
    assert.equal(typeof sdk.release.buildPiExecutionDrillPlan, "function");
    assert.equal(typeof sdk.release.buildRuntimeBoundaryDecisionPlan, "function");
    assert.equal(typeof sdk.release.buildPublicBetaEvidencePlan, "function");
    assert.equal(typeof sdk.release.runControlledBetaReleaseDecisionGate, "function");
    assert.equal(typeof sdk.release.runOperatorReleaseRunbookGate, "function");
    assert.equal(typeof sdk.release.runOperatorReleaseStateMutation, "function");
    assert.equal(typeof sdk.release.runPostReleaseAuditGate, "function");
    assert.equal(typeof sdk.release.runPublicBetaHardeningDrill, "function");
    assert.equal(typeof sdk.release.runStableGraduationGate, "function");
    assert.equal(typeof sdk.release.runManualExternalReleaseGate, "function");
    assert.equal(typeof sdk.release.runAgentIntegrationDoctor, "function");
    assert.equal(typeof sdk.release.runRealProjectDogfoodGate, "function");
    assert.equal(typeof sdk.release.runPiExecutionDrillGate, "function");
    assert.equal(typeof sdk.release.runRuntimeBoundaryDecisionGate, "function");
    assert.equal(typeof sdk.release.runPublicBetaEvidenceGate, "function");
    assert.equal(typeof buildTraceabilityMatrix, "function");
    assert.equal(typeof buildInitToFirstPrdSmokePlan, "function");
    assert.equal(typeof runInitToFirstPrdSmoke, "function");
    assert.equal(typeof buildEvidenceArtifact, "function");
    assert.equal(typeof buildRunFinalAnswer, "function");
    assert.equal(typeof buildRunReport, "function");
    assert.equal(typeof buildLifecycleStageReport, "function");
    assert.equal(typeof writeLifecycleStageReport, "function");
    assert.equal(typeof inspectYoloCheck, "function");
    assert.equal(typeof formatYoloCheckText, "function");
    assert.equal(typeof discoverPackManifests, "function");
    assert.equal(typeof readPackManifest, "function");
    assert.equal(typeof resolveProjectContext, "function");
    assert.equal(typeof validatePackManifest, "function");
    assert.equal(typeof buildAcceptanceReport, "function");
    assert.equal(typeof buildAdapterEvidencePlan, "function");
    assert.equal(typeof runAdapterEvidenceCollector, "function");
    assert.equal(ADAPTER_EVIDENCE_COLLECTOR_SCHEMA_VERSION, "1.0");
    assert.equal(typeof buildProgressDashboardUiEvidence, "function");
    assert.equal(typeof inspectProgressDashboardUiEvidence, "function");
    assert.equal(typeof runProgressDashboardUiEvidence, "function");
    assert.equal(PROGRESS_DASHBOARD_UI_EVIDENCE_SCHEMA_VERSION, "1.0");
    assert.equal(typeof inspectAcceptanceReport, "function");
    assert.equal(typeof formatAcceptanceReportText, "function");
    assert.equal(typeof buildYoloBenchmarkPlan, "function");
    assert.equal(typeof formatYoloBenchmarkText, "function");
    assert.equal(typeof listBenchmarkFixtures, "function");
    assert.equal(typeof runBenchmark, "function");
    assert.equal(typeof runYoloBenchmark, "function");
    assert.equal(typeof scoreBenchmarkScenario, "function");
    assert.equal(YOLO_BENCHMARK_SCHEMA_VERSION, "1.0");
    assert.equal(typeof buildYoloCommandRegistry, "function");
    assert.equal(typeof getYoloCommand, "function");
    assert.equal(typeof listYoloCommandNames, "function");
    assert.equal(typeof renderYoloCommandUsage, "function");
    assert.equal(YOLO_COMMAND_REGISTRY_SCHEMA_VERSION, "1.0");
    assert.equal(typeof buildYoloDoctorReport, "function");
    assert.equal(typeof formatYoloDoctorText, "function");
    assert.equal(YOLO_DOCTOR_SCHEMA_VERSION, "1.0");
    assert.equal(typeof buildDiscoveryArtifact, "function");
    assert.equal(typeof runDiscoveryRuntime, "function");
    assert.equal(typeof buildDemandArtifactGraph, "function");
    assert.equal(typeof buildDemandSession, "function");
    assert.equal(typeof inspectDemandReadiness, "function");
    assert.equal(typeof runDemandBrainstormRuntime, "function");
    assert.equal(typeof runDemandDiscussRuntime, "function");
    assert.equal(typeof runDemandPrdRuntime, "function");
    assert.equal(DEMAND_SESSION_SCHEMA_VERSION, "1.0");
    assert.equal(typeof buildControlledParallelExecutionPlan, "function");
    assert.equal(typeof buildTaskDependencyGraph, "function");
    assert.equal(CONTROLLED_PARALLEL_SCHEMA_VERSION, "1.0");
    assert.equal(typeof detectParallelConflicts, "function");
    assert.equal(typeof formatControlledParallelPlanText, "function");
    assert.equal(typeof inspectParallelMergeGate, "function");
    assert.equal(typeof mergeParallelEvidence, "function");
    assert.equal(typeof planControlledParallelWaves, "function");
    assert.equal(typeof createEvidenceLedger, "function");
    assert.equal(typeof formatRunFinalAnswerMarkdown, "function");
    assert.equal(typeof writeRunReport, "function");
    assert.equal(typeof normalizeReviewFinding, "function");
    assert.equal(typeof buildReviewOutput, "function");
    assert.equal(typeof buildReviewFixPrd, "function");
    assert.equal(typeof inspectReviewFixLoop, "function");
    assert.equal(typeof listWorkflows, "function");
    assert.equal(typeof listFixtureDefinitions, "function");
    assert.equal(typeof runFixtureHarness, "function");
    assert.equal(typeof inspectPackageReadiness, "function");
    assert.equal(typeof buildPackageInstallSmokePlan, "function");
    assert.equal(typeof buildControlledBetaReleaseDecisionPlan, "function");
    assert.equal(typeof buildOperatorReleaseRunbookPlan, "function");
    assert.equal(typeof buildOperatorReleaseStatePlan, "function");
    assert.equal(typeof buildPostReleaseAuditPlan, "function");
    assert.equal(typeof buildPublicBetaHardeningDrillPlan, "function");
    assert.equal(typeof buildStableGraduationPlan, "function");
    assert.equal(typeof buildManualExternalReleasePlan, "function");
    assert.equal(typeof buildAgentIntegrationDoctorPlan, "function");
    assert.equal(typeof buildRealProjectDogfoodPlan, "function");
    assert.equal(typeof buildPiExecutionDrillPlan, "function");
    assert.equal(typeof buildRuntimeBoundaryDecisionPlan, "function");
    assert.equal(typeof buildPublicBetaEvidencePlan, "function");
    assert.equal(typeof inspectPackedPackage, "function");
    assert.equal(typeof runPackageInstallSmoke, "function");
    assert.equal(typeof runControlledBetaReleaseDecisionGate, "function");
    assert.equal(typeof runOperatorReleaseRunbookGate, "function");
    assert.equal(typeof runOperatorReleaseStateMutation, "function");
    assert.equal(typeof runPostReleaseAuditGate, "function");
    assert.equal(typeof runPublicBetaHardeningDrill, "function");
    assert.equal(typeof runStableGraduationGate, "function");
    assert.equal(typeof runManualExternalReleaseGate, "function");
    assert.equal(typeof runAgentIntegrationDoctor, "function");
    assert.equal(typeof runRealProjectDogfoodGate, "function");
    assert.equal(typeof runPiExecutionDrillGate, "function");
    assert.equal(typeof runRuntimeBoundaryDecisionGate, "function");
    assert.equal(typeof runPublicBetaEvidenceGate, "function");
    assert.ok(supportedConditionTypes().includes("function_contains_text"));
  });

  test("keeps package root separate from project state root", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-sdk-state-root-"));
    try {
      const packageRoot = join(root, "node_modules/yolo");
      const projectRoot = join(root, "consumer");
      mkdirSync(packageRoot, { recursive: true });
      mkdirSync(projectRoot, { recursive: true });
      const sdk = createYoloSdk({ yoloRoot: packageRoot, projectRoot });

      assert.equal(sdk.paths.yoloRoot, packageRoot);
      assert.equal(sdk.paths.projectRoot, projectRoot);
      assert.equal(sdk.paths.stateRoot, join(projectRoot, ".yolo"));
      assert.equal(sdk.paths.yoloPath("runtime"), join(projectRoot, ".yolo", "state", "runtime"));
      assert.equal(existsSync(join(packageRoot, "state")), false);
      assert.equal(existsSync(join(packageRoot, "data")), false);

      const piPlan = sdk.agents.createPiPlan({
        requirement: "Keep PI artifacts out of package root",
        runId: "pi-state-root",
      });
      assert.equal(piPlan.artifacts.outputDir, join(projectRoot, ".yolo", "data", "pi", "pi-state-root"));
      assert.equal(piPlan.artifacts.statePath, join(projectRoot, ".yolo", "state", "pi", "pi-state-root.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("supports non-PI agent presets instead of a PI-only SDK surface", () => {
    const presets = listAgentPresets();
    assert.ok(presets.some((preset) => preset.id === "pi"));
    assert.ok(presets.some((preset) => preset.id === "reviewer"));
    assert.ok(presets.some((preset) => preset.id === "gatekeeper"));

    const sdk = createYoloSdk();
    const plan = sdk.agents.createPlan({
      preset: "reviewer",
      objective: "Review a scoped implementation without writing code",
    });

    assert.equal(plan.preset, "reviewer");
    assert.deepEqual(plan.sdk_namespaces, ["contract", "review"]);
    assert.ok(plan.steps.length > 0);
  });

  test("PI agent builds a full requirement-to-runner action plan without executing", () => {
    const sdk = createYoloSdk();
    const result = sdk.agents.createPiPlan({
      requirement: "For store managers, build inventory alerts in src/inventory/alerts.js so an alert appears when stock is below threshold; success criteria: alert appears below threshold.",
      title: "Inventory alerts",
      outputDir: "state/dry-run/pi-plan-test",
    });

    assert.equal(result.status, "success");
    assert.equal(result.input_source, "requirement");
    assert.equal(result.lifecycle.current_stage, "discovery");
    assert.ok(result.team.agents.some((agent) => agent.id === "discovery-agent"));
    assert.equal(result.discovery.ready_for_plan, true);
    assert.deepEqual(result.actions.map((action) => action.id), [
      "pi.intake",
      "pi.discovery.write",
      "pi.findings.generate",
      "pi.prd.generate",
      "pi.prd.preflight",
      "pi.execute.runner",
      "pi.review.scan",
      "pi.final.schema_gate",
      "pi.acceptance",
      "pi.delivery.ship",
      "pi.learn.record",
    ]);
    const runnerAction = result.actions.find((action) => action.id === "pi.execute.runner");
    assert.equal(runnerAction.kind, "runtime");
    assert.equal(runnerAction.runtime, "runner");
    assert.ok(result.actions.filter((action) => action.kind !== "observe").every((action) => action.kind === "runtime"));
    const discoveryAction = result.actions.find((action) => action.id === "pi.discovery.write");
    assert.equal(discoveryAction.runtime, "discovery.write");
    assert.equal(discoveryAction.params.outputFile, result.artifacts.discoveryPath);
  });

  test("PI agent routes vague requirements to discovery before PRD or runner actions", () => {
    const sdk = createYoloSdk();
    const result = sdk.agents.createPiPlan({
      requirement: "Build inventory alerts",
      title: "Inventory alerts",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.stop_condition, "needs_discovery");
    assert.deepEqual(result.actions.map((action) => action.id), [
      "pi.intake",
      "pi.discovery.required",
    ]);
    assert.ok(result.discovery.blockers.some((blocker) => blocker.code === "DISCOVERY_SUCCESS_CRITERIA_PRESENT"));
  });

  test("runner runtime reports missing PRD without spawning a CLI process", async () => {
    const result = await runRunnerRuntime();
    assert.equal(result.status, "error");
    assert.equal(result.code, "MISSING_PRD_PATH");
  });

  test("runner runtime preflight blocks weak PRDs with migration advice before execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-runner-preflight-"));
    try {
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, JSON.stringify({
        version: "2.0",
        id: "PRD-20260524-PREFLIGHT",
        title: "Preflight blocked PRD",
        project: { name: "test", language: "typescript" },
        generated_by: "yolo-review-agent",
        generated_at: "2026-05-24T00:00:00.000Z",
        base_commit: "abcdef0",
        requirements: [{ id: "REQ-AUTO-001", text: "Fix inventory alerts" }],
        designs: [{ id: "DES-AUTO-001", text: "Use executable target coverage gates." }],
        tasks: [{
          id: "FIX-AUTO-001",
          title: "Fix inventory alerts",
          priority: "P2",
          type: "bugfix",
          task_kind: "atomic_fix",
          status: "pending",
          requirement_ids: ["REQ-AUTO-001"],
          design_ids: ["DES-AUTO-001"],
          scope: { targets: [{ file: "src/services/inventory-alerts.ts" }] },
          post_conditions: [{
            id: "POST-TSC",
            type: "no_new_type_errors",
            severity: "FAIL",
            params: { command: "npm run typecheck" },
          }],
        }],
      }), "utf8");

      const result = await runRunnerRuntime({ prdPath });

      assert.equal(result.status, "error");
      assert.equal(result.code, "PRD_CONTRACT_BLOCKED");
      assert.equal(result.migration.available, true);
      assert.equal(result.migration.would_fix_contract, true);
      assert.equal(result.remediation_plan.action, "AUTO_REMEDIATE");
      assert.equal(result.remediation_plan.automation_can_continue, true);
      assert.ok(result.next_actions.some((action) => action.includes("--apply")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PI runtimes can generate and schema-validate a PRD without shelling to CLI scripts", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-pi-runtime-"));
    try {
      const findingsPath = join(root, "findings.json");
      const prdPath = join(root, "prd.json");
      writeFileSync(findingsPath, JSON.stringify({
        findings: [{
          id: "DEV-001",
          severity: "HIGH",
          kind: "atomic_feature",
          type: "new_page",
          description: "Build a simple page",
          files: ["src/pages/inventory-alerts.tsx"],
          scope: { targets: [{ file: "src/pages/inventory-alerts.tsx" }] },
          post_conditions: [{
            id: "POST-FILE",
            type: "file_exists",
            severity: "FAIL",
            params: { file: "src/pages/inventory-alerts.tsx" },
          }],
        }],
      }), "utf8");

      const generated = await runPiRuntime("prd.generate", {
        findingsPath,
        output: prdPath,
        title: "Inventory alerts",
        projectRoot: root,
      });
      assert.equal(generated.status, "success");

      const schema = await runPiRuntime("prd.schema_gate", { prdPath });
      assert.equal(schema.status, "success");

      const contract = await runPiRuntime("prd.contract_gate", { prdPath });
      assert.equal(contract.status, "success");

      const preflight = await runPiRuntime("prd.preflight", { prdPath });
      assert.equal(preflight.status, "success");
      assert.equal(preflight.preflight.runner_readiness.can_execute, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PI runtimes close acceptance, ship, and learn lifecycle stages", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-pi-lifecycle-"));
    const stateRoot = join(root, ".yolo");
    try {
      mkdirSync(join(stateRoot, "lifecycle"), { recursive: true });
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, JSON.stringify({
        version: "2.0",
        id: "PRD-PI-LIFECYCLE",
        title: "PI lifecycle",
        project: { name: "test", language: "typescript" },
        generated_by: "test",
        generated_at: "2026-05-26T00:00:00.000Z",
        base_commit: "abcdef0",
        requirements: [{ id: "REQ-1", text: "Update service." }],
        designs: [{ id: "DES-1", text: "Service only." }],
        tasks: [{
          id: "FIX-1",
          title: "Update service",
          priority: "P1",
          type: "bugfix",
          status: "completed",
          requirement_ids: ["REQ-1"],
          design_ids: ["DES-1"],
          scope: { targets: [{ file: "src/service.ts" }] },
          acceptance_criteria: ["Service update is complete."],
          post_conditions: [{
            id: "POST-FILE",
            type: "file_exists",
            severity: "FAIL",
            params: { file: "src/service.ts" },
          }],
        }],
      }), "utf8");
      writeFileSync(join(stateRoot, "lifecycle/run-report.json"), JSON.stringify({
        status: "success",
        summary: { failed: 0, blocked: 0 },
      }), "utf8");
      writeFileSync(join(stateRoot, "lifecycle/review-report.json"), JSON.stringify({ findings: [] }), "utf8");

      const acceptance = await runPiRuntime("acceptance", { prdPath, projectRoot: root, stateRoot });
      assert.equal(acceptance.status, "success");

      const ship = await runPiRuntime("ship", { prdPath, projectRoot: root, stateRoot });
      assert.equal(ship.status, "success");

      const learn = await runPiRuntime("learn", { prdPath, projectRoot: root, stateRoot });
      assert.equal(learn.status, "success");
      assert.ok(existsSync(join(stateRoot, "lifecycle/acceptance-report.json")));
      assert.ok(existsSync(join(stateRoot, "lifecycle/delivery-report.json")));
      assert.ok(existsSync(join(stateRoot, "lifecycle/retrospective.json")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PRD generation injects target coverage when findings only include generic gates", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-pi-target-coverage-"));
    try {
      const findingsPath = join(root, "findings.json");
      const prdPath = join(root, "prd.json");
      writeFileSync(findingsPath, JSON.stringify({
        findings: [{
          id: "DEV-001",
          severity: "HIGH",
          kind: "atomic_fix",
          type: "service_fix",
          description: "Fix inventory alert logic",
          files: ["src/services/inventory-alerts.ts:10-20"],
          post_conditions: [{
            id: "POST-TSC",
            type: "no_new_type_errors",
            severity: "FAIL",
            params: { command: "npm run typecheck" },
          }],
        }],
      }), "utf8");

      const generated = await runPiRuntime("prd.generate", {
        findingsPath,
        output: prdPath,
        title: "Inventory alerts",
        projectRoot: root,
      });
      assert.equal(generated.status, "success");

      const contract = await runPiRuntime("prd.contract_gate", { prdPath });
      assert.equal(contract.status, "success");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PRD contract gate blocks pending tasks without executable FAIL gates", () => {
    const baseTask = {
      id: "FEAT-AUTO-001",
      status: "pending",
      scope: { targets: [{ file: "src/pages/inventory-alerts.tsx" }] },
    };

    const manualOnly = inspectPrdContract({
      version: "2.0",
      tasks: [{
        ...baseTask,
        post_conditions: [{
          id: "POST-MANUAL",
          type: "acceptance_criteria",
          severity: "FAIL",
          params: { text: "manual review" },
        }],
      }],
    });
    assert.equal(manualOnly.blocks_execution, true);
    assert.ok(manualOnly.failures.some((failure) => failure.code === "TASK_MISSING_EXECUTABLE_FAIL_GATE"));

    const warnOnly = inspectPrdContract({
      version: "2.0",
      tasks: [{
        ...baseTask,
        post_conditions: [{
          id: "POST-FILE",
          type: "file_exists",
          severity: "WARN",
          params: { file: "src/pages/inventory-alerts.tsx" },
        }],
      }],
    });
    assert.equal(warnOnly.blocks_execution, true);
    assert.ok(warnOnly.failures.some((failure) => failure.code === "TASK_MISSING_EXECUTABLE_FAIL_GATE"));

    const executable = inspectPrdContract({
      version: "2.0",
      tasks: [{
        ...baseTask,
        post_conditions: [{
          id: "POST-FILE",
          type: "file_exists",
          severity: "FAIL",
          params: { file: "src/pages/inventory-alerts.tsx" },
        }],
      }],
    });
    assert.equal(executable.blocks_execution, false);
  });

  test("PRD contract gate requires executable FAIL gates to cover each scope target", () => {
    const baseTask = {
      id: "FEAT-AUTO-001",
      status: "pending",
      scope: {
        targets: [
          { file: "src/pages/inventory-alerts.tsx" },
          { file: "src/services/inventory-alerts.ts" },
        ],
      },
    };

    const genericOnly = inspectPrdContract({
      version: "2.0",
      tasks: [{
        ...baseTask,
        post_conditions: [{
          id: "POST-TSC",
          type: "no_new_type_errors",
          severity: "FAIL",
          params: { command: "npm run typecheck" },
        }],
      }],
    });
    assert.equal(genericOnly.blocks_execution, true);
    assert.ok(genericOnly.failures.some((failure) => failure.code === "TASK_TARGETS_MISSING_EXECUTABLE_COVERAGE"));

    const partial = inspectPrdContract({
      version: "2.0",
      tasks: [{
        ...baseTask,
        post_conditions: [{
          id: "POST-PAGE",
          type: "file_exists",
          severity: "FAIL",
          params: { file: "src/pages/inventory-alerts.tsx" },
        }],
      }],
    });
    assert.equal(partial.blocks_execution, true);
    assert.deepEqual(
      partial.failures.find((failure) => failure.code === "TASK_TARGETS_MISSING_EXECUTABLE_COVERAGE").missing_targets,
      ["src/services/inventory-alerts.ts"],
    );

    const covered = inspectPrdContract({
      version: "2.0",
      tasks: [{
        ...baseTask,
        post_conditions: [
          {
            id: "POST-PAGE",
            type: "file_exists",
            severity: "FAIL",
            params: { file: "src/pages/inventory-alerts.tsx" },
          },
          {
            id: "POST-SERVICE",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: "src/services/inventory-alerts.ts" },
          },
        ],
      }],
    });
    assert.equal(covered.blocks_execution, false);
  });

  test("PI contract gate returns target coverage migration advice for legacy PRDs", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-pi-contract-advice-"));
    try {
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, JSON.stringify({
        version: "2.0",
        id: "PRD-20260524-PASS",
        title: "Preflight passing PRD",
        project: { name: "test", language: "typescript" },
        generated_by: "yolo-review-agent",
        generated_at: "2026-05-24T00:00:00.000Z",
        base_commit: "abcdef0",
        requirements: [{ id: "REQ-AUTO-001", text: "Fix inventory alerts" }],
        designs: [{ id: "DES-AUTO-001", text: "Use executable target coverage gates." }],
        tasks: [{
          id: "FIX-AUTO-001",
          title: "Fix inventory alerts",
          priority: "P2",
          type: "bugfix",
          task_kind: "atomic_fix",
          status: "pending",
          scope: { targets: [{ file: "src/services/inventory-alerts.ts:10-20" }] },
          post_conditions: [{
            id: "POST-TESTS",
            type: "tests_pass",
            severity: "FAIL",
            params: { command: "npm test" },
          }],
        }],
      }), "utf8");

      const result = await runPiRuntime("prd.contract_gate", { prdPath });

      assert.equal(result.status, "error");
      assert.equal(result.code, "PI_PRD_CONTRACT_FAILED");
      assert.equal(result.migration.available, true);
      assert.equal(result.migration.would_fix_contract, true);
      assert.equal(result.migration.added_count, 1);
      assert.ok(result.migration.dry_run_command.includes("yolo-prd-migrate-gates"));
      assert.ok(result.next_actions.some((action) => action.includes("--apply")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PRD preflight report combines schema, contract, migration, and runner readiness", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-prd-preflight-"));
    try {
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, JSON.stringify({
        version: "2.0",
        id: "PRD-20260524-PREFLIGHT",
        title: "Preflight blocked PRD",
        project: { name: "test", language: "typescript" },
        generated_by: "yolo-review-agent",
        generated_at: "2026-05-24T00:00:00.000Z",
        base_commit: "abcdef0",
        requirements: [{ id: "REQ-AUTO-001", text: "Fix inventory alerts" }],
        designs: [{ id: "DES-AUTO-001", text: "Use executable target coverage gates." }],
        tasks: [{
          id: "FIX-AUTO-001",
          title: "Fix inventory alerts",
          priority: "P2",
          type: "bugfix",
          task_kind: "atomic_fix",
          status: "pending",
          requirement_ids: ["REQ-AUTO-001"],
          design_ids: ["DES-AUTO-001"],
          scope: { targets: [{ file: "src/services/inventory-alerts.ts" }] },
          post_conditions: [{
            id: "POST-TSC",
            type: "no_new_type_errors",
            severity: "FAIL",
            params: { command: "npm run typecheck" },
          }],
        }],
      }), "utf8");

      const report = preflightPrd(prdPath);

      assert.equal(report.status, "blocked");
      assert.equal(report.schema.ok, true);
      assert.equal(report.contract.blocks_execution, true);
      assert.equal(report.migration.available, true);
      assert.equal(report.migration.would_fix_contract, true);
      assert.equal(report.runner_readiness.can_execute, false);
      assert.ok(report.blocked_reasons.some((reason) => reason.code === "TASK_TARGETS_MISSING_EXECUTABLE_COVERAGE"));
      assert.ok(report.runner_readiness.next_actions.some((action) => action.includes("--apply")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PRD preflight passes runner readiness for strict executable target gates", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-prd-preflight-pass-"));
    try {
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, JSON.stringify({
        version: "2.0",
        id: "PRD-20260524-PASS",
        title: "Preflight passing PRD",
        project: { name: "test", language: "typescript" },
        generated_by: "yolo-review-agent",
        generated_at: "2026-05-24T00:00:00.000Z",
        base_commit: "abcdef0",
        requirements: [{ id: "REQ-AUTO-001", text: "Fix inventory alerts" }],
        designs: [{ id: "DES-AUTO-001", text: "Use executable target coverage gates." }],
        tasks: [{
          id: "FIX-AUTO-001",
          title: "Fix inventory alerts",
          priority: "P2",
          type: "bugfix",
          task_kind: "atomic_fix",
          status: "pending",
          requirement_ids: ["REQ-AUTO-001"],
          design_ids: ["DES-AUTO-001"],
          scope: { targets: [{ file: "src/services/inventory-alerts.ts" }] },
          post_conditions: [{
            id: "POST-TARGET",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: "src/services/inventory-alerts.ts" },
          }],
        }],
      }), "utf8");

      const report = preflightPrd(prdPath);

      assert.equal(report.status, "pass");
      assert.equal(report.ok, true);
      assert.equal(report.spec_governance.blocks_execution, false);
      assert.equal(report.runner_readiness.can_execute, true);
      assert.equal(report.runner_readiness.tasks.pending, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PRD preflight blocks weak spec governance before runner execution", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-prd-preflight-spec-"));
    try {
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, JSON.stringify({
        version: "2.0",
        id: "PRD-20260524-SPEC-BLOCK",
        title: "Spec governance blocked PRD",
        project: { name: "test", language: "typescript" },
        generated_by: "yolo-review-agent",
        generated_at: "2026-05-24T00:00:00.000Z",
        base_commit: "abcdef0",
        tasks: [{
          id: "FIX-SPEC-001",
          title: "Fix inventory alerts",
          priority: "P2",
          type: "bugfix",
          task_kind: "atomic_fix",
          status: "pending",
          scope: { targets: [{ file: "src/services/inventory-alerts.ts" }] },
          post_conditions: [{
            id: "POST-TARGET",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: "src/services/inventory-alerts.ts" },
          }],
        }],
      }), "utf8");

      const report = preflightPrd(prdPath);

      assert.equal(report.status, "blocked");
      assert.equal(report.contract.blocks_execution, false);
      assert.equal(report.spec_governance.blocks_execution, true);
      assert.equal(report.runner_readiness.can_execute, false);
      assert.deepEqual(report.blocked_reasons.filter((reason) => reason.source === "spec").map((reason) => reason.code), [
        "MISSING_REQUIREMENT_TRACE",
        "MISSING_DESIGN_TRACE",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runner runtime reports spec governance blocks separately from contract blocks", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-runner-spec-"));
    try {
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, JSON.stringify({
        version: "2.0",
        id: "PRD-20260524-RUNNER-SPEC",
        title: "Runner spec blocked PRD",
        project: { name: "test", language: "typescript" },
        generated_by: "yolo-review-agent",
        generated_at: "2026-05-24T00:00:00.000Z",
        base_commit: "abcdef0",
        tasks: [{
          id: "FIX-SPEC-002",
          title: "Fix inventory alerts",
          priority: "P2",
          type: "bugfix",
          task_kind: "atomic_fix",
          status: "pending",
          scope: { targets: [{ file: "src/services/inventory-alerts.ts" }] },
          post_conditions: [{
            id: "POST-TARGET",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: "src/services/inventory-alerts.ts" },
          }],
        }],
      }), "utf8");

      const result = await runRunnerRuntime({ prdPath });

      assert.equal(result.status, "error");
      assert.equal(result.code, "PRD_SPEC_GOVERNANCE_BLOCKED");
      assert.equal(result.spec_governance.blocks_execution, true);
      assert.equal(result.remediation_plan.action, "AUTO_REMEDIATE");
      assert.ok(result.next_actions.some((action) => action.includes("requirement_ids")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PRD gate migration adds target coverage without mutating the input PRD", () => {
    const prd = {
      version: "2.0",
      tasks: [
        {
          id: "FIX-AUTO-001",
          type: "bugfix",
          task_kind: "atomic_fix",
          status: "pending",
          scope: { targets: [{ file: "./src/services/inventory-alerts.ts:10-20" }] },
          post_conditions: [{
            id: "POST-TSC",
            type: "no_new_type_errors",
            severity: "FAIL",
            params: { command: "npm run typecheck" },
          }],
        },
        {
          id: "DONE-001",
          type: "bugfix",
          task_kind: "atomic_fix",
          status: "completed",
          scope: { targets: [{ file: "src/services/done.ts" }] },
          post_conditions: [],
        },
      ],
    };
    const original = JSON.stringify(prd);

    const result = migratePrdGates(prd);
    const advice = createPrdMigrationAdvice(prd, "prd.json");

    assert.equal(JSON.stringify(prd), original);
    assert.equal(result.changed, true);
    assert.equal(result.added_count, 1);
    assert.deepEqual(result.tasks_changed[0].missing_targets, ["src/services/inventory-alerts.ts"]);
    assert.equal(result.tasks_changed[0].added[0].type, "target_file_modified");
    assert.equal(result.prd.tasks[1].post_conditions.length, 0);
    assert.equal(inspectPrdContract(result.prd).blocks_execution, false);
    assert.equal(advice.would_fix_contract, true);
    assert.ok(advice.apply_command.includes("--apply"));
  });

  test("PRD gate migration file API dry-runs by default and applies explicitly", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-prd-migrate-"));
    try {
      const prdPath = join(root, "prd.json");
      const prd = {
        version: "2.0",
        tasks: [{
          id: "FEAT-AUTO-001",
          type: "feature",
          task_kind: "atomic_feature",
          status: "pending",
          scope: { targets: [{ file: "src/pages/inventory-alerts.tsx" }] },
          post_conditions: [{
            id: "POST-TESTS",
            type: "tests_pass",
            severity: "FAIL",
            params: { command: "npm test" },
          }],
        }],
      };
      const original = `${JSON.stringify(prd, null, 2)}\n`;
      writeFileSync(prdPath, original, "utf8");

      const dryRun = migratePrdFile(prdPath);
      assert.equal(dryRun.changed, true);
      assert.equal(dryRun.applied, false);
      assert.equal(readFileSync(prdPath, "utf8"), original);

      const applied = migratePrdFile(prdPath, { apply: true });
      assert.equal(applied.applied, true);

      const migrated = JSON.parse(readFileSync(prdPath, "utf8"));
      assert.equal(migrated.tasks[0].post_conditions.at(-1).type, "file_exists");
      assert.equal(inspectPrdContract(migrated).blocks_execution, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runner module is import-safe for SDK runtime use", () => {
    const output = execFileSync(process.execPath, [
      "-e",
      "import('./dist/runner.js').then((m)=>console.log(typeof m.run))",
    ], { cwd: YOLO_DIR, encoding: "utf8" }).trim();

    assert.equal(output, "function");
  });

  test("PM, PRD conversion, PRD preflight, and PRD validator modules are import-safe", () => {
    const output = execFileSync(process.execPath, [
      "-e",
      [
        "Promise.all([import('./dist/src/pm/index.js'), import('./dist/src/prd/audit-to-prd.js'), import('./dist/src/prd/validate.js'), import('./dist/src/prd/migration.js'), import('./dist/src/prd/preflight.js')])",
        ".then(([pm,audit,validate,migrate,preflight])=>console.log([typeof pm.generateFindingsFromRequirement, typeof audit.convertAuditToPrd, typeof validate.validatePrdPath, typeof migrate.migratePrdGates, typeof migrate.createPrdMigrationAdvice, typeof preflight.preflightPrd].join(',')))",
      ].join(""),
    ], { cwd: YOLO_DIR, encoding: "utf8" }).trim();

    assert.equal(output, "function,function,function,function,function,function");
  });

  test("PI agent execute mode stops at the first failed action", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-pi-agent-"));
    try {
      const seen = [];
      const result = await runPiAgent({
        prdPath: "prd.json",
      }, {
        yoloRoot: root,
        projectRoot: root,
        execute: true,
        executor: async (action) => {
          seen.push(action.id);
          return {
            status: action.id === "pi.execute.runner" ? "error" : "success",
            summary: action.id,
          };
        },
      });

      assert.equal(result.status, "error");
      assert.equal(result.stop_condition, "first_failed_action");
      assert.ok(seen.includes("pi.execute.runner"));
      assert.ok(!seen.includes("pi.review.scan"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PI CLI accepts --prd value form and skips requirement generation", () => {
    const output = execFileSync(process.execPath, [
      join(YOLO_DIR, "dist/bin/yolo-pi.js"),
      "--prd",
      "data/prd/current/prd-yolo-p40-progress-dashboard.json",
      "--json",
    ], { cwd: YOLO_DIR, encoding: "utf8" });
    const result = JSON.parse(output);

    assert.equal(result.plan.input_source, "prd");
    assert.ok(!result.plan.actions.some((action) => action.id === "pi.findings.generate"));
    assert.ok(result.plan.actions.some((action) => action.id === "pi.execute.runner"));
  });

  test("loads SDK config from an explicit config path", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-sdk-config-"));
    try {
      const configPath = join(root, "yolo.config.yaml");
      writeFileSync(configPath, [
        'version: "2.0"',
        "project:",
        '  name: "ExternalProject"',
        '  root: "."',
        '  source_roots: ["app"]',
        '  framework: "generic"',
        "build:",
        '  test: "echo custom-test"',
      ].join("\n"), "utf8");

      const sdk = createYoloSdk({
        configPath,
        forceConfigReload: true,
        yoloRoot: root,
        projectRoot: root,
      });

      assert.equal(sdk.config.project.name, "ExternalProject");
      assert.deepEqual(sdk.config.project.source_roots, ["app"]);
      assert.equal(sdk.config.build.test, "echo custom-test");
    } finally {
      loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scans a generic temporary project without miniprogram-only findings", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-sdk-generic-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/index.ts"), [
        "console.log('debug');",
        "window.location.href = '/x';",
      ].join("\n"), "utf8");

      const result = scanProject({
        root,
        sourceRoots: ["src"],
        framework: "generic",
        includeExternalChecks: false,
      });

      assert.equal(result.scanned_files, 1);
      assert.ok(result.findings.some((finding) => finding.scanner_id === "debug-console-log" && finding.fix_type === "AUTO_FIX"));
      assert.ok(!result.findings.some((finding) => finding.scanner_id === "window-document"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scanner preserves fix_type and excludes rule literals from tests and scanner definitions", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-sdk-scanner-rules-"));
    try {
      mkdirSync(join(root, "src/review"), { recursive: true });
      mkdirSync(join(root, "__tests__"), { recursive: true });
      writeFileSync(join(root, "src/review/scanner.ts"), [
        "const rule = /(?:innerHTML|dangerouslySetInnerHTML)/g;",
        "const injection = /(?:\\beval\\s*\\(|new\\s+Function\\s*\\()/g;",
        "const secret = /(?:api[_-]?key|password|secret)/gi;",
      ].join("\n"), "utf8");
      writeFileSync(join(root, "__tests__/fixture.test.ts"), [
        "const html = 'innerHTML';",
        "const fn = 'eval(';",
      ].join("\n"), "utf8");
      writeFileSync(join(root, "src/app.ts"), "const x = value as any;\n", "utf8");

      const result = scanProject({
        root,
        sourceRoots: ["src", "__tests__"],
        includeExternalChecks: false,
      });

      assert.ok(result.findings.some((finding) => finding.scanner_id === "R6-as-any" && finding.fix_type === "CLAUDE_FIX"));
      assert.ok(!result.findings.some((finding) => finding.file === "src/review/scanner.ts"));
      assert.ok(!result.findings.some((finding) => finding.file === "__tests__/fixture.test.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scoped review scans only requested files and skips full-project external checks", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-sdk-scoped-review-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/target.ts"), `${"// legacy line\n".repeat(180)}console.log('scoped');\n`, "utf8");
      writeFileSync(join(root, "src/noise.ts"), "debugger;\n", "utf8");

      const result = scanProject({
        root,
        files: ["src/target.ts"],
        sourceRoots: ["src"],
        framework: "generic",
      });

      assert.equal(result.scanned_files, 1);
      assert.deepEqual([...new Set(result.findings.map((finding) => finding.file))], ["src/target.ts"]);
      assert.ok(result.findings.some((finding) => finding.scanner_id === "debug-console-log"));
      assert.ok(!result.findings.some((finding) => finding.scanner_id === "R9-file-length"));
      assert.ok(!result.findings.some((finding) => finding.file === "src/noise.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SDK contract evaluates supplied tasks programmatically", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-sdk-contract-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/sale.ts"), [
        "export function createSale(input) {",
        "  return runTransaction(input.quantity);",
        "}",
      ].join("\n"), "utf8");

      const sdk = createYoloSdk({ projectRoot: root });
      const result = sdk.contract.evaluatePostConditions({
        id: "FIX-SDK-001",
        scope: { targets: [{ file: "src/sale.ts" }], expected_zero_business_code: true },
        post_conditions: [
          {
            id: "POST-FN",
            type: "function_contains_call",
            severity: "FAIL",
            params: { file: "src/sale.ts", function: "createSale", callee: "runTransaction" },
          },
        ],
      }, { version: "2.0", tasks: [] });

      assert.equal(result.allPass, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SDK contract evaluators keep project roots scoped per SDK instance", () => {
    const rootA = mkdtempSync(join(tmpdir(), "yolo-sdk-root-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "yolo-sdk-root-b-"));
    try {
      mkdirSync(join(rootA, "src"), { recursive: true });
      mkdirSync(join(rootB, "src"), { recursive: true });
      writeFileSync(join(rootA, "src/value.ts"), "export const value = 'alphaOnly';\n", "utf8");
      writeFileSync(join(rootB, "src/value.ts"), "export const value = 'betaOnly';\n", "utf8");

      const sdkA = createYoloSdk({ projectRoot: rootA });
      const sdkB = createYoloSdk({ projectRoot: rootB });

      const taskA = {
        id: "FIX-SDK-ROOT-001",
        scope: { targets: [{ file: "src/value.ts" }], expected_zero_business_code: true },
        post_conditions: [{
          id: "POST-ROOT-A",
          type: "code_contains",
          severity: "FAIL",
          params: { file: "src/value.ts", text: "alphaOnly" },
        }],
      };
      const taskB = {
        id: "FIX-SDK-ROOT-002",
        scope: { targets: [{ file: "src/value.ts" }], expected_zero_business_code: true },
        post_conditions: [{
          id: "POST-ROOT-B",
          type: "code_contains",
          severity: "FAIL",
          params: { file: "src/value.ts", text: "betaOnly" },
        }],
      };

      assert.equal(sdkA.contract.evaluatePostConditions(taskA, { version: "2.0", tasks: [] }).allPass, true);
      assert.equal(sdkB.contract.evaluatePostConditions(taskB, { version: "2.0", tasks: [] }).allPass, true);
      assert.equal(sdkA.contract.evaluatePostConditions(taskB, { version: "2.0", tasks: [] }).allPass, false);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });
});
