import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { initProject, buildProjectBootstrapPlan } from "./bootstrap.js";
import {
  buildSpecLifecyclePackage,
  inspectSpecLifecyclePackage,
  specLifecycleToPrd,
} from "../spec/lifecycle.js";
import { preflightPrd } from "../prd/preflight.js";
import { runRunnerRuntime } from "../runtime/runner-runtime.js";
import { inspectYoloCheck } from "../runtime/gates/check-report.js";
import { writeLifecycleStageReport } from "../lifecycle/progress.js";
import { initLifecycleState } from "../lifecycle/state.js";
import { loadProjectToolchainConfig, resolveBuildCommand } from "../lib/toolchain.js";

export const INIT_TO_FIRST_PRD_SMOKE_SCHEMA_VERSION = "1.0";

export interface InitToFirstPrdSmokeOptions {
  projectRoot?: string;
  project_root?: string;
  cwd?: string;
  projectName?: unknown;
  project_name?: unknown;
  name?: unknown;
  prdPath?: string;
  prd_path?: string;
  targetFile?: unknown;
  target_file?: unknown;
  specId?: unknown;
  spec_id?: unknown;
  title?: unknown;
  prdId?: unknown;
  prd_id?: unknown;
  generatedAt?: unknown;
  generated_at?: unknown;
  language?: unknown;
  framework?: unknown;
  packageManager?: unknown;
  package_manager?: unknown;
  baseCommit?: unknown;
  base_commit?: unknown;
  mode?: unknown;
  now?: string | number | Date;
  specPackage?: unknown;
  force?: unknown;
  dryRun?: unknown;
  dry_run?: unknown;
}

function cleanString(value: unknown, fallback: string = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function projectRelative(projectRoot: string, filePath: string): string {
  const absolute = isAbsolute(filePath) ? filePath : join(projectRoot, filePath);
  const rel = relative(projectRoot, absolute);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replaceAll("\\", "/") : absolute;
}

function demandQualityReport(): {
  schema_version: string;
  schema: string;
  status: string;
  total_score: number;
  dimensions: unknown[];
} {
  return {
    schema_version: "1.0",
    schema: "yolo.demand.quality.v1",
    status: "pass",
    total_score: 100,
    dimensions: [],
  };
}

type SmokePrd = ReturnType<typeof specLifecycleToPrd>;

function demandFieldsForSmoke(prd: SmokePrd, targetFile: string) {
  const quality = demandQualityReport();
  const targetFiles = [...new Set([
    targetFile,
    ...((prd.tasks || []).flatMap((task) => {
      const scope = task.scope as Record<string, unknown> | undefined;
      const targets = (scope?.targets || []) as Array<Record<string, unknown>>;
      return targets.map((target) => target.file).filter(Boolean);
    })),
  ].filter(Boolean))];
  return {
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: "DEMAND-FIRST-PRD-SMOKE",
      source: "init_to_first_prd_smoke",
      approval: { approved: true, effective_for_prd: true },
      project_facts: {
        target_files: targetFiles.map((file) => ({ file, status: "verified" })),
        assumptions: [] as unknown[],
      },
      quality_report: quality,
    },
    execution_readiness: {
      level: "L3",
      afk_ready: true,
      quality_status: "pass",
      quality_report: quality,
    },
    requirements: (prd.requirements || []).map((requirement) => {
      const requirementRec = requirement as Record<string, unknown>;
      return {
        ...requirement,
        demand_trace: requirementRec.demand_trace || {
          source: "init_to_first_prd_smoke",
          evidence: targetFiles,
        },
      };
    }),
  };
}

function defaultSmokeSpec(options: InitToFirstPrdSmokeOptions = Object()) {
  const projectRoot = resolve(options.projectRoot || options.cwd || process.cwd());
  const buildConfig = loadProjectToolchainConfig(projectRoot, {
    config: (options as Record<string, unknown>).config,
    configPath: (options as Record<string, unknown>).configPath as string | undefined,
  });
  const targetFile = cleanString(options.targetFile || options.target_file, "specs/tasks.md");
  return buildSpecLifecyclePackage({
    id: cleanString(options.specId || options.spec_id, "SPEC-FIRST-PRD-SMOKE"),
    title: cleanString(options.title, "Init to first PRD smoke"),
    requirements: [{
      id: "REQ-SMOKE-001",
      title: "Bootstrap a YOLO project",
      text: "A new project can initialize YOLO files and produce its first executable PRD.",
      success_criteria: [
        "Project bootstrap files exist.",
        "Spec lifecycle artifacts stay traceable.",
        "The generated PRD passes preflight without invoking a provider.",
      ],
    }],
    designs: [{
      id: "DES-SMOKE-001",
      requirement_ids: ["REQ-SMOKE-001"],
      approach: "Use yolo init templates, spec lifecycle helpers, PRD preflight, and runner dry-run readiness.",
      alternatives: ["Manual PRD creation without bootstrap"],
      risks: ["Smoke must not mutate application source or call a model provider."],
      rollback: "Delete generated .yolo/smoke artifacts and rerun init with force only when intended.",
    }],
    tasks: [{
      id: "TASK-SMOKE-001",
      title: "Verify first PRD execution path",
      type: "feature",
      priority: "P3",
      status: "pending",
      requirement_ids: ["REQ-SMOKE-001"],
      design_ids: ["DES-SMOKE-001"],
      scope: {
        targets: [{ file: targetFile }],
        allow_new_files: false,
        max_files: 1,
        max_lines_per_file: 200,
      },
      post_conditions: [{
        id: "POST-SMOKE-TARGET",
        type: "target_file_modified",
        severity: "FAIL",
        params: { file: targetFile },
      }, {
        id: "POST-SMOKE-TYPECHECK",
        type: "no_new_type_errors",
        severity: "FAIL",
        params: { command: resolveBuildCommand("type_check", buildConfig, projectRoot) },
      }],
      acceptance_criteria: [
        "PRD schema validation passes.",
        "PRD contract gate passes.",
        "Spec governance gate passes.",
        "Runner dry-run readiness passes without importing provider execution.",
      ],
    }],
  });
}

export function buildInitToFirstPrdSmokePlan(options: InitToFirstPrdSmokeOptions = Object()) {
  const projectRoot = resolve(options.projectRoot || options.cwd || process.cwd());
  const projectName = cleanString(options.projectName || options.name, projectRoot.split(/[\\/]/).filter(Boolean).at(-1) || "project");
  const prdPath = projectRelative(projectRoot, options.prdPath || options.prd_path || ".yolo/smoke/first-prd.json");
  const targetFile = cleanString(options.targetFile || options.target_file, "specs/tasks.md");
  const specPackage = options.specPackage || defaultSmokeSpec({ ...options, targetFile });
  const specInspection = inspectSpecLifecyclePackage(specPackage);
  const basePrd = specLifecycleToPrd(specPackage, {
    id: cleanString(options.prdId || options.prd_id, "PRD-20260524-FIRST-SMOKE"),
    title: cleanString(options.title, "Init to first PRD smoke"),
    generated_at: options.generatedAt || options.generated_at || "2026-05-24T00:00:00.000Z",
  });
  const prd = {
    ...basePrd,
    ...demandFieldsForSmoke(basePrd, targetFile),
    project: {
      name: projectName,
      language: cleanString(options.language, "other"),
      framework: cleanString(options.framework, "generic"),
      package_manager: cleanString(options.packageManager || options.package_manager, "other"),
    },
    generated_by: "yolo-review-agent",
    base_commit: cleanString(options.baseCommit || options.base_commit, "0000000"),
    execution_mode: "dry_run",
    review_policy: { mode: "disabled" },
    tasks: (basePrd.tasks || []).map((task) => ({ ...task, status: "pending" })),
  };

  return {
    schema_version: INIT_TO_FIRST_PRD_SMOKE_SCHEMA_VERSION,
    schema: "yolo.project.init_to_first_prd_smoke_plan.v1",
    project_root: projectRoot,
    project_name: projectName,
    prd_path: prdPath,
    target_file: targetFile,
    bootstrap_plan: buildProjectBootstrapPlan({ projectRoot, projectName }),
    spec_package: specPackage,
    spec_inspection: specInspection,
    prd,
    runner_dry_run: {
      mode: cleanString(options.mode, "dev"),
      dry_run: true,
      expected_code: "RUNNER_DRY_RUN_READY",
    },
  };
}

export async function runInitToFirstPrdSmoke(options: InitToFirstPrdSmokeOptions = Object()) {
  const plan = buildInitToFirstPrdSmokePlan(options);
  const dryRun = options.dryRun === true || options.dry_run === true;
  const projectRoot = plan.project_root;
  const prdAbsolutePath = isAbsolute(plan.prd_path) ? plan.prd_path : join(plan.project_root, plan.prd_path);
  const bootstrap = initProject({
    projectRoot: plan.project_root,
    projectName: plan.project_name,
    force: options.force === true,
    dryRun,
  });

  if (plan.spec_inspection.blocks_execution) {
    return {
      status: "blocked",
      summary: "init-to-first-PRD smoke blocked by invalid spec lifecycle",
      exit_code: 1,
      dry_run: dryRun,
      plan,
      bootstrap,
      spec_inspection: plan.spec_inspection,
      artifacts: bootstrap.artifacts,
      next_actions: ["Fix spec lifecycle blockers before generating the first PRD."],
    };
  }

  if (dryRun) {
    return {
      status: "success",
      summary: "planned init-to-first-PRD smoke",
      exit_code: 0,
      dry_run: true,
      plan,
      bootstrap,
      artifacts: [...bootstrap.artifacts, plan.prd_path],
      next_actions: ["Run without dryRun to write the first PRD and execute preflight smoke."],
    };
  }

  mkdirSync(dirname(prdAbsolutePath), { recursive: true });
  writeFileSync(prdAbsolutePath, stableJson(plan.prd), "utf8");
  // Write lifecycle reports to a temporary state root to avoid polluting real project state
  const smokeStateRoot = join(projectRoot, ".yolo", "smoke");
  initLifecycleState({ projectRoot, stateRoot: smokeStateRoot });
  writeLifecycleStageReport("discovery", {
    status: "success",
    summary: "Init-to-first-PRD smoke captured bootstrap discovery.",
    artifacts: bootstrap.artifacts,
  }, { projectRoot, stateRoot: smokeStateRoot, source: "init-smoke", writeSessionMemory: false });
  writeLifecycleStageReport("roadmap", {
    status: "success",
    summary: "Init-to-first-PRD smoke generated a traceable first PRD plan.",
    artifacts: [plan.prd_path],
  }, { projectRoot, stateRoot: smokeStateRoot, source: "init-smoke", writeSessionMemory: false });
  writeLifecycleStageReport("prd", {
    status: "success",
    summary: "Init-to-first-PRD smoke wrote the first executable PRD.",
    prd_path: prdAbsolutePath,
    artifacts: [prdAbsolutePath],
  }, { projectRoot, stateRoot: smokeStateRoot, source: "init-smoke", writeSessionMemory: false });
  const preflight = preflightPrd(prdAbsolutePath);
  const stateRoot = join(projectRoot, ".yolo");
  const check = inspectYoloCheck({
    prdPath: prdAbsolutePath,
    projectRoot,
    stateRoot: smokeStateRoot,
    writeLifecycle: true,
  }, { learnFailures: true });
  const runner = await runRunnerRuntime({
    prdPath: prdAbsolutePath,
    projectRoot,
    stateRoot: smokeStateRoot,
    mode: plan.runner_dry_run.mode,
    dryRun: true,
  });
  const runnerDryRunReady = runner.status === "dry_run" && runner.code === "RUNNER_DRY_RUN_READY";
  const status = preflight.runner_readiness?.can_execute && check.status !== "blocked" && runnerDryRunReady ? "success" : "blocked";

  return {
    status,
    summary: status === "success"
      ? "init-to-first-PRD smoke passed"
      : "init-to-first-PRD smoke blocked before runner execution",
    exit_code: status === "success" ? 0 : 1,
    dry_run: false,
    plan,
    bootstrap,
    prd_path: prdAbsolutePath,
    preflight,
    check,
    runner,
    artifacts: [...bootstrap.artifacts, plan.prd_path],
    next_actions: status === "success"
      ? ["Use the generated PRD as the first executable project smoke artifact."]
      : ["Fix preflight blockers before allowing runner execution."],
  };
}
