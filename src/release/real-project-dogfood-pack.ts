import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initProject } from "../core/bootstrap.js";
import { inspectDiscoveryReadiness } from "../discovery/gate.js";
import { compileDiscoveryPlanToSpec } from "../prd/spec-compiler.js";
import { buildAcceptanceReport } from "../runtime/acceptance/report.js";
import { inspectYoloCheck } from "../runtime/gates/check-report.js";
import {
  inspectParallelMergeGate,
  mergeParallelEvidence,
  planControlledParallelWaves,
} from "../runtime/parallel/wave-planner.js";
import { buildAgentBridgeInstallPlan, installAgentBridge } from "../../tools/install-agent-bridge.js";
import { REAL_PROJECT_DOGFOOD_V2_MODES, runRealProjectDogfoodGate } from "./real-project-dogfood.js";
import { buildDogfoodMatrixEvidence } from "./dogfood-matrix.js";
import { listYoloCommandNames } from "../workflows/command-registry.js";
import type { ReleaseCheck, ReleaseRecord } from "./readiness.js";

export const REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION = "1.0";

const DOGFOOD_MODES = REAL_PROJECT_DOGFOOD_V2_MODES;
const DOGFOOD_IDEA = "For operators, add a safe dogfood smoke marker so YOLO can prove idea-to-acceptance flow without editing production code or calling providers.";

export interface BridgeArtifact extends ReleaseRecord {
  target?: string;
  agent_target?: string;
  scope?: string;
  role?: string;
  kind?: string;
  command?: string;
  path?: string;
  relative_path?: string;
}

export interface BridgePlan extends ReleaseRecord {
  files?: BridgeArtifact[];
  native_skill_files?: BridgeArtifact[];
  claude_slash_commands?: BridgeArtifact[];
}

export interface BridgeDryRunResult extends ReleaseRecord {
  dry_run?: boolean;
  written?: unknown[];
  overwritten?: unknown[];
  planned?: unknown[];
}

export interface ExpectedBridgeArtifact extends ReleaseRecord {
  target: string | null;
  scope: string | null;
  role: string;
  command: string | null;
  path: string;
  relative_path: string;
}

export interface RealProjectDogfoodPackPlan extends ReleaseRecord {
  yolo_root: string;
  project_root: string;
  home_dir: string;
  targets: unknown;
  scope: string;
}

export interface DogfoodEvidenceRecord extends ReleaseRecord {
  status: string;
  mode: string;
  artifact_path: string;
  evidence_files: string[];
  payload: ReleaseRecord & {
    dogfood_prd_evidence?: DogfoodPrdEvidence;
  };
}

export type DogfoodEvidenceByMode = Record<string, DogfoodEvidenceRecord>;

export interface DogfoodEvidenceOptions {
  mode: string;
  projectRoot: string;
  now: string;
  payload?: ReleaseRecord;
  status?: string;
  linkedArtifacts?: string[];
}

export interface CompilerBlocker extends ReleaseRecord {
  code?: string;
  message?: string;
}

export interface CompiledValidation extends ReleaseRecord {
  status?: string;
  blocks_execution?: boolean;
  blockers?: CompilerBlocker[];
}

export interface CompiledPrdRequirement extends ReleaseRecord {
  demand_trace?: ReleaseRecord;
}

export interface CompiledPrdTask extends ReleaseRecord {
  id: string;
}

export interface CompiledPrd extends ReleaseRecord {
  tasks?: CompiledPrdTask[];
  requirements?: CompiledPrdRequirement[];
}

export interface CompiledResult extends ReleaseRecord {
  status?: string;
  blockers?: CompilerBlocker[];
  validation?: CompiledValidation;
  prd?: CompiledPrd | null;
  spec?: unknown;
}

export interface DogfoodPrdEvidence extends ReleaseRecord {
  status: string;
  compiler_status: unknown;
  validation_status: unknown;
  prd_generated: boolean;
  blocker_count: number;
  blockers: string[];
}

export interface BuildNoCodeDogfoodOptions {
  projectRoot: string;
  now: string;
  compiledRaw?: CompiledResult | null;
}

export interface RealProjectDogfoodPackOptions extends ReleaseRecord {
  plan?: RealProjectDogfoodPackPlan;
  yoloRoot?: string;
  cwd?: string;
  projectRoot?: string;
  project_root?: string;
  homeDir?: string;
  home_dir?: string;
  targets?: unknown;
  scope?: string;
  installScope?: string;
  install_scope?: string;
  now?: Date | string;
  compiledRaw?: CompiledResult | null;
  compiled_raw?: CompiledResult | null;
}

function normalizeNow(value: RealProjectDogfoodPackOptions["now"]): string {
  if (value instanceof Date) return value.toISOString();
  return value || new Date().toISOString();
}

function check(code: string, passed: boolean, message: string, extra: ReleaseRecord = Object()): ReleaseCheck {
  return { code, passed, message, ...extra };
}

function unique(values: unknown[] = []): string[] {
  return [...new Set(values.filter(Boolean).map(String))];
}

function plannedProjectRoot() {
  return join(tmpdir(), `yolo-real-project-dogfood-${Date.now()}`);
}

function writeJson(filePath: string, value: unknown): string {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

function expectedPlanPaths(plan: BridgePlan = Object()): ExpectedBridgeArtifact[] {
  const plainFiles = [
    ...(plan.files || []),
    ...(plan.native_skill_files || []),
    ...(plan.claude_slash_commands || []),
  ];
  return plainFiles.map((file) => ({
    target: file.target || file.agent_target || null,
    scope: file.scope || null,
    role: file.role || file.kind || "workflow_skill",
    command: file.command || null,
      path: file.path || "",
      relative_path: file.relative_path || file.path || "",
  }));
}

function plannedPathsFromDryRun(result: BridgeDryRunResult = Object()): string[] {
  return unique([
    ...(result.planned || []),
  ]);
}

function commandForMode(mode: string): string {
  if (mode === "idea") return "/yolo";
  if (mode === "discovery") return "/yolo-demand";
  if (mode === "plan") return "/yolo-tasks";
  if (mode === "prd") return "/yolo-spec";
  if (mode === "check") return "/yolo-check";
  if (mode === "review") return "/yolo-review";
  if (mode === "accept") return "/yolo-release";
  if (mode === "controlled_run") return "/yolo-run";
  return `/yolo-${mode.replace(/_/g, "-")}`;
}

export function inspectAgentBridgeDryRunDoctor({ plan = Object(), dryRunResult = Object() }: { plan?: BridgePlan; dryRunResult?: BridgeDryRunResult } = Object()) {
  const expected = expectedPlanPaths(plan);
  const planned = plannedPathsFromDryRun(dryRunResult);
  const plannedText = planned.join("\n");
  const commandSet = new Set(expected.map((item) => item.command).filter(Boolean));
  const roles = new Set(expected.map((item) => item.role).filter(Boolean));

  const requiredCommands = listYoloCommandNames().map((command) => `yolo-${command}`);
  const checks = [
    check(
      "AGENT_BRIDGE_DRY_RUN_DOCTOR_NO_WRITES",
      dryRunResult.dry_run === true
        && (dryRunResult.written || []).length === 0
        && (dryRunResult.overwritten || []).length === 0,
      "agent bridge dogfood pack must inspect dry-run output without installing skills or commands",
    ),
    check(
      "AGENT_BRIDGE_DRY_RUN_DOCTOR_NATIVE_SKILL",
      roles.has("native_yolo_skill"),
      "dry-run plan must include native YOLO skill artifacts",
    ),
    check(
      "AGENT_BRIDGE_DRY_RUN_DOCTOR_COMMANDS",
      requiredCommands.every((command) => commandSet.has(command)),
      "dry-run plan must include the full lifecycle /yolo command aliases",
      { commands: [...commandSet].sort() },
    ),
    check(
      "AGENT_BRIDGE_DRY_RUN_DOCTOR_WORKFLOW_SKILLS",
      expected.some((item) => item.role === "native_yolo_skill" || String(item.relative_path || "").includes("skills/yolo")),
      "dry-run plan must include native YOLO skill descriptors",
    ),
    check(
      "AGENT_BRIDGE_DRY_RUN_DOCTOR_PLANNED_PATHS",
      expected.length > 0 && expected.some((item) => plannedText.includes(item.relative_path) || plannedText.includes(item.path)),
      "dry-run result must report planned skill or command paths",
      { expected_count: expected.length, planned_count: planned.length },
    ),
  ];
  const blockers = checks.filter((item) => item.passed !== true);
  return {
    schema_version: REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
    schema: "yolo.release.agent_bridge_dry_run_doctor_result.v1",
    status: blockers.length === 0 ? "pass" : "blocked",
    checks,
    blockers,
    expected_artifact_count: expected.length,
    planned_artifact_count: planned.length,
    expected_artifacts: expected,
    planned_artifacts: planned,
    guarantees: {
      writes_workspace: false,
      writes_user_home: false,
      provider_execution: false,
      billable_provider_execution: false,
      credential_access: false,
    },
  };
}

export function buildRealProjectDogfoodPackPlan(options: RealProjectDogfoodPackOptions = Object()): RealProjectDogfoodPackPlan {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const projectRoot = resolve(options.projectRoot || options.project_root || plannedProjectRoot());
  const homeDir = resolve(options.homeDir || options.home_dir || join(projectRoot, ".home"));
  const targets = options.targets || ["codex", "claude"];
  const scope = options.scope || options.installScope || options.install_scope || "project";
  return {
    schema_version: REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
    schema: "yolo.release.real_project_dogfood_pack_plan.v1",
    yolo_root: yoloRoot,
    project_root: projectRoot,
    home_dir: homeDir,
    targets,
    scope,
    writes_yolo_package_root: false,
    writes_external_project_scaffold: true,
    agent_bridge_install_mode: "dry_run",
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    required_steps: [
      "create or use an isolated external project root",
      "run yolo init into that external project",
      "run agent bridge install in dry-run mode",
      "doctor the planned skill and command artifacts",
      "create idea/discovery/plan/PRD/check/review/accept/controlled-run no-code evidence and pass the real-project dogfood gate",
    ],
  };
}

function dogfoodEvidence({ mode, projectRoot, now, payload = Object(), status = "pass", linkedArtifacts = [] }: DogfoodEvidenceOptions): DogfoodEvidenceRecord {
  const command = commandForMode(mode);
  const artifactPath = join(projectRoot, ".yolo/state/reports/dogfood", `${mode}.json`);
  const artifact = {
    schema_version: REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
    schema: "yolo.release.real_project_dogfood_pack_command_evidence.v1",
    status,
    mode,
    command,
    created_at: now,
    summary: `${command} dogfood evidence generated in an isolated external project without code edits or provider execution.`,
    component_status: payload.status || status,
    linked_artifacts: unique(linkedArtifacts),
    payload,
    writes_workspace: false,
    mutates_workspace: false,
    edits_code: false,
    provider_execution: false,
    executes_provider: false,
    billable_provider_execution: false,
    executed_by_sdk: false,
  };
  writeJson(artifactPath, artifact);
  return {
    ...artifact,
    artifact_path: artifactPath,
    evidence_files: unique([artifactPath, ...linkedArtifacts]),
  };
}

function dogfoodPrdEvidencePayload(compiled: CompiledResult = Object()) {
  const blockers = unique([
    ...(compiled.blockers || []).map((blocker) => blocker.code || blocker.message || "SPEC_COMPILER_BLOCKER"),
    ...((compiled.validation?.blockers || []).map((blocker) => blocker.code || blocker.message || "SPEC_VALIDATION_BLOCKER")),
  ]);
  const validationStatus = compiled.validation?.status || (compiled.validation?.blocks_execution === false ? "pass" : null);
  const status = compiled.prd && validationStatus === "pass" && blockers.length === 0 ? "pass" : "blocked";
  return {
    ...compiled,
    dogfood_prd_evidence: {
      status,
      compiler_status: compiled.status || null,
      validation_status: validationStatus,
      prd_generated: Boolean(compiled.prd),
      blocker_count: blockers.length,
      blockers,
    },
  };
}

function buildNoCodeDogfoodArtifacts({ projectRoot, now, compiledRaw: injectedCompiledRaw = null }: BuildNoCodeDogfoodOptions) {
  const stateRoot = join(projectRoot, ".yolo");
  const discoveryInput = {
    id: "DISCOVERY-DOGFOOD-001",
    idea: DOGFOOD_IDEA,
    problem: "YOLO needs isolated real-project evidence before public beta claims.",
    target_users: ["operators", "non-technical project owners"],
    success_criteria: [
      "idea, discovery, plan, PRD, check, review, accept, and controlled run evidence are linked",
      "no provider, publish, credential, or billable execution occurs",
      "all artifacts stay under the external project .yolo directory",
    ],
    constraints: ["do not edit package root", "do not call providers", "do not publish"],
    non_goals: ["do not ship public release", "do not mutate real user code"],
    target_files: ["src/index.js"],
    ready_for_prd: true,
  };
  const discovery = inspectDiscoveryReadiness(discoveryInput);
  const fixtureTypecheckCommand = ["npm", "run", "typecheck"].join(" ");
  const plan = {
    schema_version: REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
    schema: "yolo.release.real_project_dogfood_pack_lifecycle_plan.v1",
    status: "pass",
    title: "Dogfood smoke marker lifecycle",
    approach: "Use the existing src/index.js marker as a no-code target and prove gates around it.",
    tasks: [
      {
        id: "DOGFOOD-TASK-001",
        title: "Verify dogfood smoke marker",
        scope: { targets: [{ file: "src/index.js" }] },
        acceptance_criteria: ["src/index.js exists as the no-code dogfood smoke target."],
        post_conditions: [
          {
            id: "POST-DOGFOOD-FILE",
            type: "file_exists",
            severity: "FAIL",
            params: { file: "src/index.js" },
          },
          {
            id: "POST-DOGFOOD-TYPECHECK",
            type: "no_new_type_errors",
            severity: "FAIL",
            params: { command: fixtureTypecheckCommand },
          },
        ],
        evidence_plan: ["PRD preflight", "yolo check", "review report", "acceptance report", "controlled parallel merge gate"],
      },
    ],
  };
  const compiledRaw: CompiledResult = injectedCompiledRaw || compileDiscoveryPlanToSpec({
    discovery: discovery.brief,
    plan,
  }, {
    id: "SPEC-DOGFOOD-V2",
    title: "Dogfood lifecycle v2",
    prdId: "PRD-20260525-DOGFOOD-V2",
    prdTitle: "Dogfood lifecycle v2",
    generated_at: now,
  });
  const demandQualityReport = {
    schema_version: "1.0",
    schema: "yolo.demand.quality.v1",
    phase: "prd",
    status: "pass",
    total_score: 100,
    pass_score: 85,
    block_score: 70,
    dimensions: [
      "requirement_clarity",
      "task_atomicity",
      "acceptance_evidence",
      "session_executability",
      "handoff_completeness",
    ].map((code) => ({
      code,
      label: code,
      status: "pass",
      score: 100,
      checks: [],
      failed_checks: [],
    })),
    blockers: [],
    warnings: [],
    next_actions: ["Synthetic dogfood demand quality is sufficient for release evidence."],
  };
  const compiled = {
    ...compiledRaw,
    prd: compiledRaw.prd
      ? {
          ...compiledRaw.prd,
          id: "PRD-20260525-DOGFOOD-V2",
          project: { name: "dogfood-target", language: "javascript" },
          generated_by: "yolo-review-agent",
          base_commit: "0000000",
          source: "approved_demand",
          demand_contract_required: true,
          demand: {
            id: "DEMAND-DOGFOOD-001",
            approval: {
              approved: true,
              approved_by: "real-project-dogfood-pack",
              approved_at: now,
              note: "Synthetic no-code dogfood demand approved for release evidence.",
              effective_for_prd: true,
            },
            readiness_level: "L3",
            quality_score: 100,
            quality_report: demandQualityReport,
            project_facts: {
              schema: "yolo.demand.project_facts.v1",
              target_files: [
                {
                  file: "src/index.js",
                  status: "verified",
                  source: "real-project-dogfood-pack fixture created and inspected this no-code smoke target",
                },
              ],
              candidate_target_files: [],
              assumptions: [
                {
                  id: "ASM-DOGFOOD-001",
                  text: "src/index.js is the isolated no-code dogfood smoke target.",
                  status: "verified",
                  evidence: ["src/index.js exists in the external fixture project."],
                },
              ],
            },
          },
          execution_readiness: {
            level: "L3",
            afk_ready: true,
            source: "real_project_dogfood_pack",
            quality_score: 100,
            quality_status: "pass",
            quality_report: demandQualityReport,
          },
          requirements: (compiledRaw.prd.requirements || []).map((requirement: CompiledPrdRequirement) => ({
            ...requirement,
            demand_trace: requirement.demand_trace || {
              demand_id: "DEMAND-DOGFOOD-001",
              evidence: ["EVID-DOGFOOD-001"],
              decisions: ["DEC-DOGFOOD-001"],
            },
          })),
        }
      : null,
  };
  const specPath = writeJson(join(projectRoot, ".yolo/lifecycle/spec.json"), compiled.spec);
  const ideaPath = writeJson(join(projectRoot, ".yolo/lifecycle/idea.json"), {
    schema_version: REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
    schema: "yolo.lifecycle.idea_dogfood.v1",
    status: "pass",
    idea: DOGFOOD_IDEA,
    created_at: now,
  });
  const discoveryPath = writeJson(join(projectRoot, ".yolo/lifecycle/discovery.json"), discovery);
  const planPath = writeJson(join(projectRoot, ".yolo/lifecycle/roadmap.json"), plan);
  const prdEvidencePayload = dogfoodPrdEvidencePayload(compiled);
  const prdReady = Boolean(compiled.prd && Array.isArray(compiled.prd.tasks));

  if (!prdReady) {
    const blockedPayload = {
      schema_version: REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
      status: "blocked",
      code: "DOGFOOD_PRD_NOT_EXECUTABLE",
      summary: "Dogfood PRD compilation did not produce an executable PRD; downstream check, acceptance, and controlled run were not executed.",
      blockers: prdEvidencePayload.dogfood_prd_evidence.blockers,
      compiler_status: compiled.status || null,
    };
    const checkReport = { ...blockedPayload, schema: "yolo.release.real_project_dogfood_pack_check_report.v1" };
    const reviewReport = { ...blockedPayload, schema: "yolo.release.real_project_dogfood_pack_review_report.v1" };
    const runReport = { ...blockedPayload, schema: "yolo.release.real_project_dogfood_pack_run_report.v1" };
    const acceptanceReport = { ...blockedPayload, schema: "yolo.release.real_project_dogfood_pack_acceptance_report.v1" };
    const controlledRun = {
      ...blockedPayload,
      schema: "yolo.release.real_project_dogfood_pack_controlled_run.v1",
      provider_execution: false,
      code_edited: false,
    };
    const checkPath = writeJson(join(projectRoot, ".yolo/lifecycle/check-report.json"), checkReport);
    const reviewPath = writeJson(join(projectRoot, ".yolo/lifecycle/review-report.json"), reviewReport);
    const runPath = writeJson(join(projectRoot, ".yolo/lifecycle/run-report.json"), runReport);
    const acceptPath = writeJson(join(projectRoot, ".yolo/lifecycle/acceptance-report.json"), acceptanceReport);
    const controlledRunPath = writeJson(join(projectRoot, ".yolo/lifecycle/controlled-run-report.json"), controlledRun);
    const evidence: DogfoodEvidenceByMode = {
      idea: dogfoodEvidence({ mode: "idea", projectRoot, now, payload: { status: "pass", idea: DOGFOOD_IDEA }, linkedArtifacts: [ideaPath] }),
      discovery: dogfoodEvidence({ mode: "discovery", projectRoot, now, payload: discovery, status: discovery.status === "blocked" ? "blocked" : "pass", linkedArtifacts: [discoveryPath] }),
      plan: dogfoodEvidence({ mode: "plan", projectRoot, now, payload: plan, linkedArtifacts: [planPath] }),
      prd: dogfoodEvidence({ mode: "prd", projectRoot, now, payload: prdEvidencePayload, status: prdEvidencePayload.dogfood_prd_evidence.status, linkedArtifacts: [specPath] }),
      check: dogfoodEvidence({ mode: "check", projectRoot, now, payload: checkReport, status: "blocked", linkedArtifacts: [checkPath] }),
      review: dogfoodEvidence({ mode: "review", projectRoot, now, payload: reviewReport, status: "blocked", linkedArtifacts: [reviewPath] }),
      accept: dogfoodEvidence({ mode: "accept", projectRoot, now, payload: acceptanceReport, status: "blocked", linkedArtifacts: [acceptPath] }),
      controlled_run: dogfoodEvidence({ mode: "controlled_run", projectRoot, now, payload: controlledRun, status: "blocked", linkedArtifacts: [controlledRunPath] }),
    };
    const dogfoodReportPath = writeJson(join(projectRoot, ".yolo/state/reports/dogfood/report.json"), {
      schema_version: REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
      schema: "yolo.release.real_project_dogfood_pack_report.v2",
      status: "blocked",
      modes: DOGFOOD_MODES,
      evidence_files: unique(Object.values(evidence).flatMap((item) => item.evidence_files)),
      guarantees: {
        code_edited: false,
        provider_execution: false,
        billable_provider_execution: false,
        package_root_mutated: false,
      },
    });
    return {
      discovery,
      plan,
      compiled,
      check_report: checkReport,
      review_report: reviewReport,
      run_report: runReport,
      acceptance_report: acceptanceReport,
      controlled_run: controlledRun,
      report_path: dogfoodReportPath,
      evidence,
    };
  }

  const executablePrd = compiled.prd as CompiledPrd;
  const prdPath = writeJson(join(projectRoot, ".yolo/lifecycle/prd.json"), executablePrd);

  const checkReport = inspectYoloCheck({
    prdPath,
    projectRoot,
    stateRoot,
    discovery: discovery.brief,
    acceptanceAdapter: { id: "filesystem-no-ui-dogfood" },
  });
  const checkPath = writeJson(join(projectRoot, ".yolo/lifecycle/check-report.json"), checkReport);
  const reviewReport = {
    schema_version: REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
    schema: "yolo.release.real_project_dogfood_pack_review_report.v1",
    status: "pass",
    findings: [],
    summary: "No-code dogfood review found no blocking issues.",
    provider_execution: false,
  };
  const reviewPath = writeJson(join(projectRoot, ".yolo/lifecycle/review-report.json"), reviewReport);
  const runReport = {
    schema_version: REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
    schema: "yolo.release.real_project_dogfood_pack_run_report.v1",
    status: "dry_run",
    mode: "controlled_run_plan_only",
    dry_run: true,
    summary: { completed: 1, failed: 0, blocked: 0 },
    task_results: [{ task_id: "DOGFOOD-TASK-001", status: "pass", evidence_refs: [prdPath, checkPath] }],
    provider_execution: false,
  };
  const runPath = writeJson(join(projectRoot, ".yolo/lifecycle/run-report.json"), runReport);
  const acceptanceReport = buildAcceptanceReport({
    prdPath,
    projectRoot,
    stateRoot,
    runReport,
    reviewReport,
    resolver: { status: "pass", selected: {}, blockers: [] },
  });
  const acceptPath = writeJson(join(projectRoot, ".yolo/lifecycle/acceptance-report.json"), acceptanceReport);

  const parallelPlan = planControlledParallelWaves({
    projectRoot,
    worktreeRoot: join(projectRoot, ".yolo/worktrees"),
    tasks: executablePrd.tasks,
  });
  const taskReports = (executablePrd.tasks || []).map((task) => ({
    task_id: task.id,
    status: "pass",
    gate_status: "pass",
    review_status: "pass",
    scope_merge_clean: true,
    evidence_refs: [prdPath, checkPath, reviewPath, acceptPath],
  }));
  const firstWave = parallelPlan.waves[0] || { id: "wave-01", task_ids: taskReports.map((report) => report.task_id), conflicts: [] };
  const mergeGate = inspectParallelMergeGate({ wave: firstWave, taskReports });
  const parallelEvidence = mergeParallelEvidence({ waves: parallelPlan.waves, taskReports });
  const controlledRun = {
    schema_version: REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
    schema: "yolo.release.real_project_dogfood_pack_controlled_run.v1",
    status: "blocked",
    code: "REAL_PROJECT_DOGFOOD_CONTROLLED_RUN_DRY_RUN_ONLY",
    summary: "Controlled run only planned dry-run evidence; real execution evidence is required before pass.",
    parallel_plan: parallelPlan,
    merge_gate: mergeGate,
    evidence_merge: parallelEvidence,
    provider_execution: false,
    code_edited: false,
  };
  const controlledRunPath = writeJson(join(projectRoot, ".yolo/lifecycle/controlled-run-report.json"), controlledRun);

  const evidence: DogfoodEvidenceByMode = {
    idea: dogfoodEvidence({ mode: "idea", projectRoot, now, payload: { status: "pass", idea: DOGFOOD_IDEA }, linkedArtifacts: [ideaPath] }),
    discovery: dogfoodEvidence({ mode: "discovery", projectRoot, now, payload: discovery, status: discovery.status === "blocked" ? "blocked" : "pass", linkedArtifacts: [discoveryPath] }),
    plan: dogfoodEvidence({ mode: "plan", projectRoot, now, payload: plan, linkedArtifacts: [planPath] }),
    prd: dogfoodEvidence({ mode: "prd", projectRoot, now, payload: prdEvidencePayload, status: prdEvidencePayload.dogfood_prd_evidence.status, linkedArtifacts: [specPath, prdPath] }),
    check: dogfoodEvidence({ mode: "check", projectRoot, now, payload: checkReport, status: checkReport.status === "pass" ? "pass" : "blocked", linkedArtifacts: [checkPath] }),
    review: dogfoodEvidence({ mode: "review", projectRoot, now, payload: reviewReport, linkedArtifacts: [reviewPath] }),
    accept: dogfoodEvidence({ mode: "accept", projectRoot, now, payload: acceptanceReport, status: acceptanceReport.status === "pass" ? "pass" : "blocked", linkedArtifacts: [acceptPath] }),
    controlled_run: dogfoodEvidence({ mode: "controlled_run", projectRoot, now, payload: controlledRun, status: controlledRun.status, linkedArtifacts: [controlledRunPath] }),
  };
  const dogfoodReportPath = writeJson(join(projectRoot, ".yolo/state/reports/dogfood/report.json"), {
    schema_version: REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
    schema: "yolo.release.real_project_dogfood_pack_report.v2",
    status: Object.values(evidence).every((item) => item.status === "pass") ? "pass" : "blocked",
    modes: DOGFOOD_MODES,
    evidence_files: unique(Object.values(evidence).flatMap((item) => item.evidence_files)),
    guarantees: {
      code_edited: false,
      provider_execution: false,
      billable_provider_execution: false,
      package_root_mutated: false,
    },
  });
  return {
    discovery,
    plan,
    compiled,
    check_report: checkReport,
    review_report: reviewReport,
    run_report: runReport,
    acceptance_report: acceptanceReport,
    controlled_run: controlledRun,
    report_path: dogfoodReportPath,
    evidence,
  };
}

export function runRealProjectDogfoodPack(options: RealProjectDogfoodPackOptions = Object()) {
  const plan = options.plan || buildRealProjectDogfoodPackPlan(options);
  const yoloRoot = resolve(plan.yolo_root);
  const projectRoot = resolve(plan.project_root);
  const homeDir = resolve(plan.home_dir);
  const now = normalizeNow(options.now);

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const packagePath = join(projectRoot, "package.json");
  if (!existsSync(packagePath)) {
    writeFileSync(packagePath, `${JSON.stringify({
      name: "yolo-real-project-dogfood-target",
      version: "0.0.0",
      private: true,
      type: "module",
    }, null, 2)}\n`, "utf8");
  }
  mkdirSync(join(projectRoot, "src"), { recursive: true });
  const indexPath = join(projectRoot, "src/index.js");
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, "export const dogfoodTarget = true;\n", "utf8");
  }

  const init = initProject({ projectRoot, projectName: "dogfood-target" });
  const bridgePlan = buildAgentBridgeInstallPlan({
    yoloRoot,
    projectRoot,
    homeDir,
    targets: plan.targets,
    scope: plan.scope,
  });
  const bridgeDryRun = installAgentBridge({
    yoloRoot,
    projectRoot,
    homeDir,
    targets: plan.targets,
    scope: plan.scope,
    dryRun: true,
  });
  const dryRunDoctor = inspectAgentBridgeDryRunDoctor({ plan: bridgePlan, dryRunResult: bridgeDryRun });
  const dogfoodLifecycle = buildNoCodeDogfoodArtifacts({
    projectRoot,
    now,
    compiledRaw: options.compiledRaw || options.compiled_raw || null,
  });
  const evidence = dogfoodLifecycle.evidence;
  const dogfoodGate = runRealProjectDogfoodGate({
    yoloRoot,
    projectRoot,
    modes: DOGFOOD_MODES,
    agentIntegration: dryRunDoctor,
    dogfoodEvidence: evidence,
    dogfoodMatrixEvidence: buildDogfoodMatrixEvidence(),
  });

  const checks = [
    check("REAL_PROJECT_DOGFOOD_PACK_INIT", init.status === "success", "yolo init must succeed in the isolated external project", { created: init.created || [] }),
    check("REAL_PROJECT_DOGFOOD_PACK_BRIDGE_DRY_RUN", bridgeDryRun.dry_run === true, "agent bridge install must run in dry-run mode"),
    check("REAL_PROJECT_DOGFOOD_PACK_DRY_RUN_DOCTOR", dryRunDoctor.status === "pass", "skill/command dry-run doctor must pass"),
    check("REAL_PROJECT_DOGFOOD_PACK_LIFECYCLE", Boolean(dogfoodLifecycle.report_path && Object.values(evidence).every((item) => item.status === "pass")), "idea/discovery/plan/PRD/check/review/accept/controlled-run evidence must pass"),
    check("REAL_PROJECT_DOGFOOD_PACK_CHECK", dogfoodLifecycle.check_report.status === "pass", "dogfood /yolo-check report must pass"),
    check("REAL_PROJECT_DOGFOOD_PACK_ACCEPTANCE", dogfoodLifecycle.acceptance_report.status === "pass", "dogfood /yolo-release acceptance report must pass"),
    check("REAL_PROJECT_DOGFOOD_PACK_CONTROLLED_RUN", dogfoodLifecycle.controlled_run.status === "pass", "controlled run must include real non-dry-run evidence before it can pass"),
    check("REAL_PROJECT_DOGFOOD_PACK_GATE", dogfoodGate.status === "pass", "full lifecycle dogfood gate must pass"),
  ];
  const blockers = checks.filter((item) => item.passed !== true);

  return {
    schema_version: REAL_PROJECT_DOGFOOD_PACK_SCHEMA_VERSION,
    schema: "yolo.release.real_project_dogfood_pack_result.v1",
    status: blockers.length === 0 ? "pass" : "blocked",
    yolo_root: yoloRoot,
    project_root: projectRoot,
    home_dir: homeDir,
    checks,
    blockers,
    components: {
      init,
      bridge_plan: bridgePlan,
      bridge_dry_run: bridgeDryRun,
      dry_run_doctor: dryRunDoctor,
      dogfood_lifecycle: dogfoodLifecycle,
      dogfood_gate: dogfoodGate,
    },
    evidence,
    guarantees: {
      yolo_package_root_mutated: false,
      agent_bridge_installed: false,
      agent_bridge_dry_run_only: true,
      code_edited: false,
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
    },
    next_actions: blockers.length === 0
      ? ["Use this isolated pack as non-billable real-project dogfood evidence; run real chat dogfood before public claims."]
      : ["Resolve blocked dogfood pack checks before promoting public beta evidence."],
    plan,
  };
}
