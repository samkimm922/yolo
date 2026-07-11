import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  buildDiscoveryArtifact,
  buildDiscoveryPlan,
  buildPrdFromDiscovery,
} from "./artifacts.js";
import type { DiscoveryArtifact } from "./artifacts.js";
import { writeLifecycleStageReport } from "../lifecycle/progress.js";
import type { ProgressOptions, StageReportEntry } from "../lifecycle/progress.js";
import { registerGeneratedArtifactIntegrity } from "../runtime/evidence/artifact-integrity.js";
import { resolveLedgerHmacKey } from "../runtime/evidence/ledger.js";

type ReadDiscoveryArtifactResult =
  | { ok: true; path: string; discovery: DiscoveryArtifact }
  | { ok: false; path: string; error: string };
type DiscoveryRuntimeRecord = Record<string, unknown>;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function arrayOfStrings(value: unknown | unknown[] | null | undefined): string[] {
  if (value == null) return [];
  const input = Array.isArray(value) ? value : [value];
  return input
    .flatMap((item) => String(item ?? "").split(/\r?\n/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function resolveRoot(value: unknown, fallback = process.cwd()): string {
  return resolve(clean(value) || fallback);
}

function resolveOutputPath(projectRoot: string, path: unknown): string {
  if (!path) return path as string;
  const outputPath = path as string;
  return isAbsolute(outputPath) ? outputPath : resolve(projectRoot, outputPath);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableJson(value), "utf8");
  return path;
}

function readTextFileIfPresent(projectRoot: string, path: unknown): string {
  const file = clean(path);
  if (!file) return "";
  const resolved = resolveOutputPath(projectRoot, file);
  if (!existsSync(resolved)) return "";
  return readFileSync(resolved, "utf8").trim();
}

function normalizeDiscoveryInput(input: DiscoveryRuntimeRecord = Object(), projectRoot: string): DiscoveryRuntimeRecord {
  const fileText = readTextFileIfPresent(projectRoot, input.requirementFile || input.requirement_file || input.inputFile || input.input_file);
  const objective = clean(input.objective || input.requirement || input.idea || input.text || fileText);
  return {
    ...input,
    idea: clean(input.idea || objective),
    requirement: clean(input.requirement || objective),
    problem: clean(input.problem),
    target_users: arrayOfStrings(input.target_users || input.targetUsers || input.users || input.user),
    success_criteria: arrayOfStrings(input.success_criteria || input.successCriteria || input.success || input.acceptance),
    constraints: arrayOfStrings(input.constraints || input.constraint),
    non_goals: arrayOfStrings(input.non_goals || input.nonGoals || input.non_goal || input.nonGoal),
    target_files: arrayOfStrings(input.target_files || input.targetFiles || input.target || input.file || input.files),
    open_questions: arrayOfStrings(input.open_questions || input.openQuestions || input.question || input.questions),
    risks: arrayOfStrings(input.risks || input.risk),
  };
}

function lifecycleFor(
  stageId: string,
  result: StageReportEntry | object,
  params: ProgressOptions = Object(),
): ReturnType<typeof writeLifecycleStageReport> | null {
  if (params.writeLifecycle === false || params.write_lifecycle === false) return null;
  return writeLifecycleStageReport(stageId, result, {
    projectRoot: params.projectRoot,
    stateRoot: params.stateRoot,
    source: params.source || `yolo-${stageId}`,
    writeSessionMemory: params.writeSessionMemory,
    skipSequenceCheck: true,
  });
}

export function discoveryStateDir(stateRoot: unknown): string {
  return join(resolveRoot(stateRoot, join(process.cwd(), ".yolo")), "discovery");
}

export function defaultDiscoveryPath(stateRoot: unknown): string {
  return join(discoveryStateDir(stateRoot), "discovery.json");
}

export function defaultDiscoveryPlanPath(stateRoot: unknown): string {
  return join(discoveryStateDir(stateRoot), "plan.json");
}

export function defaultDiscoveryPrdPath(stateRoot: unknown): string {
  return join(discoveryStateDir(stateRoot), "prd.json");
}

export function readDiscoveryArtifact(path: unknown): ReadDiscoveryArtifactResult {
  const resolved = resolve(path as string);
  if (!existsSync(resolved)) {
    return { ok: false, path: resolved, error: `Discovery artifact not found: ${resolved}` };
  }
  try {
    return { ok: true, path: resolved, discovery: readJson<DiscoveryArtifact>(resolved) };
  } catch (error) {
    return { ok: false, path: resolved, error: `Discovery artifact JSON parse failed: ${(error as Error).message}` };
  }
}

export function runDiscoveryRuntime(input: DiscoveryRuntimeRecord = Object(), options: DiscoveryRuntimeRecord = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = resolveRoot(input.stateRoot || input.state_root || options.stateRoot || options.state_root, join(projectRoot, ".yolo"));
  const discoveryInput = normalizeDiscoveryInput(input, projectRoot);
  const discovery = buildDiscoveryArtifact(discoveryInput, {
    projectRoot,
    now: input.now || options.now,
  });
  const outputFile = resolveOutputPath(projectRoot, input.outputFile || input.output_file || options.outputFile || defaultDiscoveryPath(stateRoot));
  const shouldWrite = input.writeArtifacts !== false && input.write_artifacts !== false && options.writeArtifacts !== false;
  const artifacts: string[] = [];
  if (shouldWrite) artifacts.push(writeJson(outputFile, discovery));

  const result = {
    status: discovery.ready_for_plan ? discovery.status === "warning" ? "warning" : "success" : "blocked",
    code: discovery.ready_for_plan ? "DISCOVERY_READY" : "DISCOVERY_BLOCKED",
    summary: discovery.ready_for_plan
      ? "Discovery artifact is ready for planning."
      : "Discovery artifact is blocked by missing product intent or scope.",
    project_root: projectRoot,
    state_root: stateRoot,
    discovery,
    readiness: discovery.readiness,
    blockers: discovery.readiness.blockers || [],
    warnings: discovery.readiness.warnings || [],
    artifacts,
    outputs: artifacts.map((path) => ({ path, type: "discovery_artifact" })),
    next_actions: discovery.ready_for_plan
      ? ["Use yolo tasks --discovery <artifact> to create the execution plan artifact."]
      : discovery.open_questions,
  };
  const lifecycle = shouldWrite ? lifecycleFor("discovery", result, {
    projectRoot,
    stateRoot,
    source: input.source || "yolo-discover",
    writeLifecycle: input.writeLifecycle ?? input.write_lifecycle ?? options.writeLifecycle,
  }) : null;
  return { ...result, lifecycle };
}

export function runDiscoveryPlanRuntime(input: DiscoveryRuntimeRecord = Object(), options: DiscoveryRuntimeRecord = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = resolveRoot(input.stateRoot || input.state_root || options.stateRoot || options.state_root, join(projectRoot, ".yolo"));
  const discoveryPath = resolveOutputPath(projectRoot, input.discoveryPath || input.discovery_path || input.discovery || defaultDiscoveryPath(stateRoot));
  const read = readDiscoveryArtifact(discoveryPath);
  if (read.ok !== true) {
    return {
      status: "blocked",
      code: "DISCOVERY_ARTIFACT_MISSING",
      summary: read.error,
      project_root: projectRoot,
      state_root: stateRoot,
      artifacts: [],
      blockers: [{ code: "DISCOVERY_ARTIFACT_MISSING", message: read.error }],
      next_actions: ["Run yolo demand --stage discover first, or pass --discovery <path> to an existing discovery artifact."],
    };
  }

  const plan = buildDiscoveryPlan(read.discovery, input, { now: input.now || options.now });
  const outputFile = resolveOutputPath(projectRoot, input.outputFile || input.output_file || options.outputFile || defaultDiscoveryPlanPath(stateRoot));
  const shouldWrite = input.writeArtifacts !== false && input.write_artifacts !== false && options.writeArtifacts !== false;
  const artifacts: string[] = [];
  if (shouldWrite) artifacts.push(writeJson(outputFile, plan));

  const result = {
    status: plan.status,
    code: plan.status === "blocked" ? "DISCOVERY_PLAN_BLOCKED" : "DISCOVERY_PLAN_READY",
    summary: plan.status === "blocked"
      ? "Discovery is not ready for execution planning."
      : "Discovery execution plan artifact created.",
    project_root: projectRoot,
    state_root: stateRoot,
    discovery_path: discoveryPath,
    plan,
    blockers: plan.blockers || [],
    warnings: plan.warnings || [],
    artifacts,
    outputs: artifacts.map((path) => ({ path, type: "discovery_plan" })),
    next_actions: plan.next_actions,
  };
  const lifecycle = shouldWrite ? lifecycleFor("roadmap", result, {
    projectRoot,
    stateRoot,
    source: input.source || "yolo-plan",
    writeLifecycle: input.writeLifecycle ?? input.write_lifecycle ?? options.writeLifecycle,
  }) : null;
  return { ...result, lifecycle };
}

export function runDiscoveryPrdRuntime(input: DiscoveryRuntimeRecord = Object(), options: DiscoveryRuntimeRecord = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = resolveRoot(input.stateRoot || input.state_root || options.stateRoot || options.state_root, join(projectRoot, ".yolo"));
  const discoveryPath = resolveOutputPath(projectRoot, input.discoveryPath || input.discovery_path || input.discovery || defaultDiscoveryPath(stateRoot));
  const read = readDiscoveryArtifact(discoveryPath);
  if (read.ok !== true) {
    return {
      status: "blocked",
      code: "DISCOVERY_ARTIFACT_MISSING",
      summary: read.error,
      project_root: projectRoot,
      state_root: stateRoot,
      artifacts: [],
      blockers: [{ code: "DISCOVERY_ARTIFACT_MISSING", message: read.error }],
      next_actions: ["Run yolo demand --stage discover first, or pass --discovery <path> to an existing discovery artifact."],
    };
  }

  const compiled = buildPrdFromDiscovery(read.discovery, input, {
    projectRoot,
    now: input.now || options.now,
  });
  const outputFile = resolveOutputPath(projectRoot, input.outputFile || input.output_file || input.prdPath || input.prd_path || options.outputFile || defaultDiscoveryPrdPath(stateRoot));
  const shouldWrite = input.writeArtifacts !== false && input.write_artifacts !== false && options.writeArtifacts !== false;
  const artifacts: string[] = [];
  if (shouldWrite && compiled.prd) {
    artifacts.push(writeJson(outputFile, compiled.prd));
    if (resolveLedgerHmacKey(stateRoot)) {
      registerGeneratedArtifactIntegrity([outputFile], {
        rootDir: projectRoot,
        stateRoot,
        source: input.source || "yolo-prd",
      });
    }
  }
  const compiledExecutable = compiled.executable;
  const executable = compiled.status === "success" || compiledExecutable === true;

  const result = {
    status: compiled.status,
    code: compiled.status === "blocked"
      ? "DISCOVERY_PRD_BLOCKED"
      : executable
        ? "DISCOVERY_PRD_READY"
        : "DISCOVERY_PRD_DRAFT",
    summary: compiled.status === "blocked"
      ? "Discovery is not ready for PRD compilation."
      : executable
        ? "Discovery PRD artifact compiled."
        : "Discovery draft PRD artifact compiled; it is not executable until approved demand and runner preflight pass.",
    project_root: projectRoot,
    state_root: stateRoot,
    discovery_path: discoveryPath,
    compiled,
    prd: executable ? compiled.prd : null,
    draft_prd: executable ? null : compiled.prd || null,
    executable,
    blockers: compiled.blockers || [],
    warnings: compiled.warnings || [],
    artifacts,
    outputs: artifacts.map((path) => ({ path, type: executable ? "prd" : "draft_prd" })),
    next_actions: compiled.next_actions || [],
  };
  const lifecycle = shouldWrite && executable ? lifecycleFor("prd", result, {
    projectRoot,
    stateRoot,
    source: input.source || "yolo-prd",
    writeLifecycle: input.writeLifecycle ?? input.write_lifecycle ?? options.writeLifecycle,
  }) : null;
  return { ...result, lifecycle };
}
