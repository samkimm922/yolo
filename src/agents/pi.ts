import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDiscoveryReadiness } from "../discovery/gate.js";
import { createLifecycleStateSnapshot } from "../lifecycle/schema.js";
import { inspectLifecycleGuard } from "../lifecycle/guard.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS } from "../lib/toolchain.js";
import { buildTeamDispatchPlan } from "./team-contracts.js";

const DEFAULT_YOLO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

type PiInput = Record<string, unknown>;
type PiContext = Record<string, unknown>;
type PiParams = Record<string, unknown>;

interface PiCommandActionInput {
  id: unknown;
  phase: unknown;
  summary: unknown;
  command: unknown;
  args?: unknown;
  cwd?: unknown;
  stdin?: unknown;
  creates?: unknown;
  timeout_ms?: unknown;
}

interface PiRuntimeActionInput {
  id: unknown;
  phase: unknown;
  summary: unknown;
  runtime: unknown;
  params?: unknown;
  timeout_ms?: unknown;
}

interface PiObserveActionInput {
  id: unknown;
  phase: unknown;
  summary: unknown;
  artifacts?: unknown;
  next_actions?: unknown;
}

export interface PiAction {
  id: unknown;
  phase: unknown;
  kind: string;
  status: string;
  summary: unknown;
  command?: unknown;
  args?: string[];
  cwd?: string | null;
  stdin?: string | null;
  creates?: string[];
  timeout_ms?: number;
  runtime?: string;
  params?: PiParams;
  artifacts?: string[];
  next_actions?: string[];
}

export interface PiObservation {
  action_id: unknown;
  status: string;
  summary: unknown;
  code?: string;
  artifacts?: string[];
  next_actions: string[];
  dry_run?: boolean;
  dryRun?: boolean;
  lifecycle_guard?: unknown;
  blockers?: unknown[];
  [key: string]: unknown;
}

export interface PiExecutorContext {
  plan?: Record<string, unknown>;
  input?: PiInput;
  options?: Record<string, unknown>;
}

export interface PiRunOptions {
  executor?: (action: PiAction, context: PiExecutorContext) => Promise<Record<string, unknown>>;
  execute?: boolean;
  [key: string]: unknown;
}

export interface PiArtifacts {
  yoloRoot: string;
  projectRoot: string;
  stateRoot: string;
  runId: string;
  outputDir: string;
  findingsPath: string;
  prdPath: string;
  requirementFile: string | null;
  discoveryPath: string;
  statePath: string;
}

function nowStamp() {
  return new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
}

function asAbs(path: unknown, base: string): string | null {
  if (!path) return null;
  const value = String(path);
  return isAbsolute(value) ? value : resolve(base, value);
}

function tail(text = "", max = 4000) {
  const value = String(text || "");
  return value.length > max ? value.slice(-max) : value;
}

function script(yoloRoot: string, name: string): string {
  return join(yoloRoot, name);
}

// H6: allowlist of executables a non-runtime PI command action may spawn. The
// PI executor must not run an arbitrary binary from a (possibly tampered) plan;
// only the trusted yolo CLI entrypoints and `node` on yolo-rooted scripts are
// permitted. Anything else is rejected fail-closed by defaultPiExecutor.
const ALLOWED_PI_COMMAND_BASENAMES = new Set([
  "yolo", "yolo.js", "yolo.mjs", "yolo.cjs",
  "yolo-gate", "yolo-gate.js",
  "yolo-pi", "yolo-pi.js",
  "yolo-prompt", "yolo-prompt.js",
  "yolo-prd-preflight", "yolo-prd-preflight.js",
  "yolo-prd-migrate-gates", "yolo-prd-migrate-gates.js",
  "node", "nodejs",
  "npx",
]);

function isAllowedPiCommand(command: string): boolean {
  const trimmed = String(command || "").trim();
  if (!trimmed) return false;
  // Bare command (no path): must be an allowlisted basename.
  if (!trimmed.includes("/")) {
    return ALLOWED_PI_COMMAND_BASENAMES.has(trimmed);
  }
  // Path-prefixed: the basename must be allowlisted.
  const segments = trimmed.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  return ALLOWED_PI_COMMAND_BASENAMES.has(last);
}

function commandAction({
  id,
  phase,
  summary,
  command,
  args = [],
  cwd,
  stdin,
  creates = [],
  timeout_ms = DEFAULT_EXECUTOR_TIMEOUT_MS,
}: PiCommandActionInput): PiAction {
  return {
    id,
    phase,
    kind: "command",
    status: "pending",
    summary,
    command,
    args: (args as string[]) || [],
    cwd: cwd === undefined ? undefined : String(cwd),
    stdin: stdin === undefined ? undefined : String(stdin),
    creates: (creates as string[]) || [],
    timeout_ms: timeout_ms === undefined ? DEFAULT_EXECUTOR_TIMEOUT_MS : Number(timeout_ms),
  };
}

function runtimeAction({
  id,
  phase,
  summary,
  runtime,
  params = {},
  timeout_ms = DEFAULT_EXECUTOR_TIMEOUT_MS,
}: PiRuntimeActionInput): PiAction {
  return {
    id,
    phase,
    kind: "runtime",
    status: "pending",
    summary,
    runtime: String(runtime),
    params: (params as PiParams) || {},
    artifacts: [],
    next_actions: [],
    timeout_ms: timeout_ms === undefined ? DEFAULT_EXECUTOR_TIMEOUT_MS : Number(timeout_ms),
  };
}

function observeAction({
  id,
  phase,
  summary,
  artifacts = [],
  next_actions = [],
}: PiObserveActionInput): PiAction {
  return {
    id,
    phase,
    kind: "observe",
    status: "pending",
    summary,
    artifacts: (artifacts as string[]) || [],
    next_actions: (next_actions as string[]) || [],
  };
}

function resolvePiArtifacts(input: PiInput = {}, context: PiContext = {}): PiArtifacts {
  const yoloRoot = resolve(String(context.yoloRoot || DEFAULT_YOLO_ROOT));
  const projectRoot = resolve(String(context.projectRoot || resolve(yoloRoot, "../..")));
  const stateRoot = resolve(String(context.stateRoot || context.state_root || yoloRoot));
  const runId = String(input.runId || input.run_id || `pi-run-${nowStamp()}`);
  const outputDirRaw = asAbs(input.outputDir || input.output_dir || join("data", "pi", runId), stateRoot);
  const outputDir = outputDirRaw ?? join(stateRoot, "data", "pi", runId);
  const findingsPath = asAbs(input.findingsPath || input.findings_path, stateRoot) || join(outputDir, "findings.json");
  const prdPath = asAbs(input.prdPath || input.prd_path, stateRoot) || join(outputDir, "prd.json");
  const requirementFile = asAbs(input.requirementFile || input.requirement_file, projectRoot);

  return {
    yoloRoot,
    projectRoot,
    stateRoot,
    runId,
    outputDir,
    findingsPath,
    prdPath,
    requirementFile,
    discoveryPath: join(outputDir, "discovery.json"),
    statePath: join(stateRoot, "state", "pi", `${runId}.json`),
  };
}

function readRequirementForDiscovery(requirement: unknown, requirementFile: string | null): string {
  if (requirement != null && String(requirement).trim()) return String(requirement);
  if (requirementFile && existsSync(requirementFile)) return readFileSync(requirementFile, "utf8");
  return "";
}

function discoveryInputForPi(input: PiInput = {}, artifacts: PiArtifacts, requirement = "") {
  const sourceRequirement = readRequirementForDiscovery(requirement, artifacts.requirementFile);
  return {
    requirement: sourceRequirement,
    idea: input.idea || input.objective || sourceRequirement,
    problem: input.problem,
    target_users: input.target_users || input.targetUsers || input.users || input.user,
    success_criteria: input.success_criteria || input.successCriteria || input.success || input.acceptance,
    constraints: input.constraints || input.constraint,
    non_goals: input.non_goals || input.nonGoals || input.non_goal || input.nonGoal,
    target_files: input.target_files || input.targetFiles || input.target || input.file || input.files,
    open_questions: input.open_questions || input.openQuestions || input.question || input.questions,
    risks: input.risks || input.risk,
    research: input.research,
    source: "pi-agent",
  };
}

function executionConfigForPi(input: PiInput = {}) {
  const model = input.model;
  const agentCommand = input.agentCommand || input.agent_command || input.customCommand || input.custom_command;
  const executor = input.executor || input.provider || (agentCommand ? "custom" : null);
  const provider = input.provider || input.executor || (agentCommand ? "custom" : null);
  const runReviewLoop = input.runReviewLoop ?? input.run_review_loop;
  const startProgressServer = input.startProgressServer ?? input.start_progress_server;
  return {
    ...(executor ? { executor } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(agentCommand ? { agentCommand } : {}),
    ...(runReviewLoop !== undefined ? { runReviewLoop } : {}),
    ...(startProgressServer !== undefined ? { startProgressServer } : {}),
    ...(input.dryRun === true || input.dry_run === true ? { dryRun: true } : {}),
    ...(input.collectEvidence === true || input.collect_evidence === true ? { collectEvidence: true } : {}),
    ...(input.executeAdapter === true || input.execute_adapter === true ? { executeAdapter: true } : {}),
    ...(input.allowAdapterCommands === true || input.allow_adapter_commands === true ? { allowAdapterCommands: true } : {}),
  };
}

function adapterEvidenceConfigForPi(input: PiInput = {}) {
  return {
    ...(input.collectEvidence === true || input.collect_evidence === true ? { collectEvidence: true } : {}),
    ...(input.executeAdapter === true || input.execute_adapter === true ? { executeAdapter: true } : {}),
    ...(input.allowAdapterCommands === true || input.allow_adapter_commands === true ? { allowAdapterCommands: true } : {}),
  };
}

export function createPiRunPlan(input: PiInput = {}, context: PiContext = {}) {
  const artifacts = resolvePiArtifacts(input, context);
  const mode = String(input.mode || "dev");
  const title = String(input.title || "PI implementation");
  const requirement = String(input.requirement || "");
  const sourcePrdPath = asAbs(input.prdPath || input.prd_path, artifacts.stateRoot);
  const sourceFindingsPath = asAbs(input.findingsPath || input.findings_path, artifacts.stateRoot);
  const hasRequirement = Boolean(requirement.trim() || artifacts.requirementFile);
  const hasPrd = Boolean(sourcePrdPath);
  const hasFindings = Boolean(sourceFindingsPath);
  const executionConfig = executionConfigForPi(input);
  const adapterEvidenceConfig = adapterEvidenceConfigForPi(input);

  if (!hasRequirement && !hasPrd && !hasFindings) {
    return {
      status: "error",
      summary: "PI agent needs one input source: requirement, requirementFile, findingsPath, or prdPath.",
      next_actions: ["Provide a requirement for full PI flow, or pass an existing PRD path for execution flow."],
      artifacts,
      actions: [],
      stop_condition: "missing_input",
    };
  }

  const executablePrdPath = hasPrd ? sourcePrdPath : artifacts.prdPath;
  const executableFindingsPath = hasFindings ? sourceFindingsPath : artifacts.findingsPath;
  const lifecycleStage = hasPrd ? "check" : hasFindings ? "prd" : "discovery";
  const lifecycle = createLifecycleStateSnapshot({
    projectName: title,
    currentStage: lifecycleStage,
  });
  const team = buildTeamDispatchPlan({
    objective: title,
    currentStage: lifecycleStage,
  });
  const actions = [
    observeAction({
      id: "pi.intake",
      phase: "intake",
      summary: hasPrd
        ? `Use existing PRD: ${executablePrdPath}`
        : hasFindings
          ? `Use existing findings: ${executableFindingsPath}`
          : "Turn requirement into atomic findings.",
      artifacts: [artifacts.requirementFile, sourceFindingsPath, sourcePrdPath].filter(Boolean),
    }),
  ];

  const discoveryInput = hasRequirement && !hasFindings && !hasPrd
    ? discoveryInputForPi(input, artifacts, requirement)
    : null;
  const discovery = discoveryInput
    ? inspectDiscoveryReadiness(discoveryInput)
    : null;

  if (discovery && discovery.ready_for_plan !== true) {
    actions.push(observeAction({
      id: "pi.discovery.required",
      phase: "discovery",
      summary: "Requirement is not ready for planning or PRD generation; discovery is required first.",
      artifacts: [artifacts.discoveryPath],
      next_actions: discovery.next_actions,
    }));
    return {
      status: "blocked",
      summary: "PI stopped before planning because discovery readiness failed.",
      next_actions: discovery.next_actions,
      artifacts: {
        ...artifacts,
        prdPath: executablePrdPath,
        findingsPath: executableFindingsPath,
      },
      input_source: "requirement",
      mode,
      lifecycle,
      team,
      discovery,
      actions,
      stop_condition: "needs_discovery",
    };
  }

  if (discovery) {
    actions.push(runtimeAction({
      id: "pi.discovery.write",
      phase: "discovery",
      summary: `Write discovery artifact before planning; readiness is ${discovery.status}.`,
      runtime: "discovery.write",
      params: {
        ...discoveryInput,
        outputFile: artifacts.discoveryPath,
        projectRoot: artifacts.projectRoot,
        stateRoot: artifacts.stateRoot,
        writeLifecycle: true,
      },
      timeout_ms: context.discoveryTimeoutMs || 30000,
    }));
  }

  if (hasRequirement && !hasFindings && !hasPrd) {
    actions.push(runtimeAction({
      id: "pi.findings.generate",
      phase: "prd_contract",
      summary: "Generate atomic findings from product requirement.",
      runtime: "pm.findings",
      params: {
        requirement,
        requirementFile: artifacts.requirementFile,
        outputFile: artifacts.findingsPath,
        projectRoot: artifacts.projectRoot,
        stateRoot: artifacts.stateRoot,
        writeLifecycle: true,
      },
      timeout_ms: context.pmTimeoutMs || 300000,
    }));
  }

  if (!hasPrd) {
    actions.push(runtimeAction({
      id: "pi.prd.generate",
      phase: "prd_contract",
      summary: "Convert findings into draft PRD; executable only after preflight.",
      runtime: "prd.generate",
      params: {
        findingsPath: executableFindingsPath,
        output: artifacts.prdPath,
        title,
        projectRoot: artifacts.projectRoot,
        stateRoot: artifacts.stateRoot,
        writeLifecycle: true,
      },
      timeout_ms: context.prdTimeoutMs || DEFAULT_EXECUTOR_TIMEOUT_MS,
    }));
  }

  actions.push(
    runtimeAction({
      id: "pi.prd.preflight",
      phase: "prd_contract",
      summary: "Validate PRD schema, contract, migration advice, and runner readiness before implementation.",
      runtime: "prd.preflight",
      params: {
        prdPath: executablePrdPath,
        projectRoot: artifacts.projectRoot,
        stateRoot: artifacts.stateRoot,
        writeLifecycle: true,
      },
      timeout_ms: context.preflightTimeoutMs || context.schemaTimeoutMs || 30000,
    }),
    runtimeAction({
      id: "pi.execute.runner",
      phase: "implementation",
      summary: "Run YOLO implementation loop with retries, gates, review, and fix loop.",
      runtime: "runner",
      params: {
        prdPath: executablePrdPath,
        mode,
        projectRoot: artifacts.projectRoot,
        stateRoot: artifacts.stateRoot,
        writeLifecycle: true,
        ...executionConfig,
      },
      timeout_ms: context.runnerTimeoutMs || 4 * 60 * 60 * 1000,
    }),
    runtimeAction({
      id: "pi.review.scan",
      phase: "review",
      summary: "Run deterministic review scanner after implementation loop.",
      runtime: "review.scan",
      params: {
        projectRoot: artifacts.projectRoot,
        stateRoot: artifacts.stateRoot,
        writeLifecycle: true,
      },
      timeout_ms: context.reviewTimeoutMs || DEFAULT_EXECUTOR_TIMEOUT_MS,
    }),
    runtimeAction({
      id: "pi.final.schema_gate",
      phase: "final_gate",
      summary: "Validate final PRD state after implementation.",
      runtime: "prd.schema_gate",
      params: { prdPath: executablePrdPath },
      timeout_ms: context.schemaTimeoutMs || 30000,
    }),
    runtimeAction({
      id: "pi.acceptance",
      phase: "acceptance",
      summary: "Collect acceptance evidence and fail closed on unresolved runtime, review, or UI blockers.",
      runtime: "acceptance",
      params: {
        prdPath: executablePrdPath,
        projectRoot: artifacts.projectRoot,
        stateRoot: artifacts.stateRoot,
        writeLifecycle: true,
        ...adapterEvidenceConfig,
      },
      timeout_ms: context.acceptanceTimeoutMs || DEFAULT_EXECUTOR_TIMEOUT_MS,
    }),
    runtimeAction({
      id: "pi.delivery.ship",
      phase: "delivery",
      summary: "Produce a ship/no-ship delivery verdict from acceptance evidence.",
      runtime: "ship",
      params: {
        prdPath: executablePrdPath,
        projectRoot: artifacts.projectRoot,
        stateRoot: artifacts.stateRoot,
        writeLifecycle: true,
      },
      timeout_ms: context.shipTimeoutMs || 30000,
    }),
    runtimeAction({
      id: "pi.learn.record",
      phase: "learn",
      summary: "Record bounded lifecycle learning after delivery gate completion.",
      runtime: "learn",
      params: {
        prdPath: executablePrdPath,
        projectRoot: artifacts.projectRoot,
        stateRoot: artifacts.stateRoot,
        writeLifecycle: true,
      },
      timeout_ms: context.learnTimeoutMs || 30000,
    }),
  );

  return {
    status: "success",
    summary: `PI plan ready for ${hasPrd ? "existing PRD" : hasFindings ? "existing findings" : "requirement"} flow.`,
    next_actions: [
      "Review the generated action list.",
      "Run with execute=true only when the project workspace is ready for model-driven edits.",
    ],
    artifacts: {
      ...artifacts,
      prdPath: executablePrdPath,
      findingsPath: executableFindingsPath,
    },
    input_source: hasPrd ? "prd" : hasFindings ? "findings" : "requirement",
    mode,
    lifecycle,
    team,
    discovery,
    actions,
    stop_condition: "first_failed_action",
  };
}

export async function defaultPiExecutor(action: PiAction, context: PiExecutorContext = {}): Promise<Record<string, unknown>> {
  if (action.kind === "runtime") {
    const { runPiRuntime } = await import("../runtime/pi-runtimes.js");
    const artifacts = (context.plan?.artifacts as Record<string, unknown>) || {};
    return runPiRuntime(String(action.runtime), (action.params as PiParams) || {}, {
      timeout_ms: action.timeout_ms,
      projectRoot: artifacts.projectRoot,
      stateRoot: artifacts.stateRoot,
      yoloRoot: artifacts.yoloRoot,
    });
  }

  // H6: non-runtime actions execute a command via spawnSync. The command must be
  // on the allowlist of trusted yolo CLI entrypoints — a malformed/tampered plan
  // must not be able to spawn an arbitrary binary. Reject anything else
  // fail-closed rather than executing it.
  const command = String(action.command || "");
  if (!isAllowedPiCommand(command)) {
    return {
      status: "error",
      summary: `${action.id} rejected: command "${command.slice(0, 80)}" is not an allowed PI executor entrypoint.`,
      exit_code: null as unknown as number,
      code: "PI_EXECUTOR_COMMAND_NOT_ALLOWED",
      command,
    };
  }

  for (const file of (action.creates as string[]) || []) {
    mkdirSync(dirname(file), { recursive: true });
  }

  const result = spawnSync(command, (action.args as string[]) || [], {
    cwd: (action.cwd as string) || undefined,
    input: (action.stdin as string) || undefined,
    encoding: "utf8",
    timeout: action.timeout_ms,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    status: result.status === 0 ? "success" : "error",
    summary: result.status === 0
      ? `${action.id} completed`
      : `${action.id} failed with exit ${result.status ?? result.signal ?? "unknown"}`,
    exit_code: result.status,
    signal: result.signal,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr),
    artifacts: (action.creates as string[]) || [],
    next_actions: result.status === 0
      ? []
      : ["Inspect stderr/stdout tail, fix the root cause, then resume from the failed phase."],
  };
}

function isDryRunObservation(observation: Record<string, unknown> = {}) {
  return observation.dry_run === true ||
    observation.dryRun === true ||
    observation.code === "RUNNER_DRY_RUN_READY";
}

export async function runPiAgent(input: PiInput = {}, options: PiRunOptions = {}) {
  const plan = createPiRunPlan(input, options);
  if (plan.status !== "success") return plan;

  if (options.execute !== true) {
    return {
      status: "not_run",
      code: "PI_PLAN_NOT_EXECUTED",
      exit_code: 2,
      summary: "PI plan created; execution was not started.",
      next_actions: ["Pass execute=true or use yolo-pi --execute to run the plan."],
      artifacts: plan.artifacts,
      plan,
      observations: [] as PiObservation[],
    };
  }

  mkdirSync(dirname(plan.artifacts.statePath), { recursive: true });
  const executor = options.executor || defaultPiExecutor;
  const observations: PiObservation[] = [];
  const writeState = (status: string, summary: unknown) => {
    writeFileSync(plan.artifacts.statePath, JSON.stringify({
      status,
      summary,
      updated_at: new Date().toISOString(),
      plan,
      observations,
    }, null, 2), "utf8");
  };
  writeState("running", "PI execution started.");

  for (const action of (plan.actions as PiAction[])) {
    // BUG-C3: lifecycle gate must fire for EVERY runtime execute action
    // (pi.execute.*), not just pi.execute.runner. Otherwise a blocked check
    // still permits other write-capable execute actions (installer, etc.)
    // to run. Observe actions are read-only and bypass the gate.
    if (action.kind === "runtime" && String(action.id ?? "").startsWith("pi.execute.")) {
      const guard = inspectLifecycleGuard({
        command: "yolo-run",
        projectRoot: plan.artifacts.projectRoot,
        stateRoot: plan.artifacts.stateRoot,
        prdPath: (action.params as PiParams)?.prdPath || plan.artifacts.prdPath,
      });
      if (guard.status !== "pass") {
        const observation: PiObservation = {
          action_id: action.id,
          status: "error",
          summary: guard.summary,
          code: guard.code || "LIFECYCLE_GUARD_BLOCKED",
          lifecycle_guard: guard,
          blockers: (guard.blockers as unknown[]) || [],
          next_actions: (guard.next_actions as string[]) || ["Run /yolo-next before starting implementation."],
        };
        observations.push(observation);
        writeState("error", observation.summary);
        return {
          status: "error",
          summary: `PI stopped before ${action.id} because lifecycle prerequisites failed.`,
          code: observation.code,
          next_actions: observation.next_actions,
          artifacts: plan.artifacts,
          plan,
          observations,
          lifecycle_guard: guard,
          stop_condition: "lifecycle_guard_blocked",
        };
      }
    }

    if (action.kind === "observe") {
      observations.push({
        action_id: action.id,
        status: "success",
        summary: action.summary,
        artifacts: (action.artifacts as string[]) || [],
        next_actions: (action.next_actions as string[]) || [],
      } as PiObservation);
      writeState("running", action.summary);
      continue;
    }

    const observation = await executor(action, { plan, input, options });
    observations.push({ action_id: action.id, ...observation } as PiObservation);
    if (isDryRunObservation(observation as Record<string, unknown>)) {
      writeState("dry_run", `PI dry-run stopped at ${action.id}.`);
      return {
        status: "dry_run",
        summary: `PI dry-run stopped at ${action.id}.`,
        code: "PI_DRY_RUN_READY",
        exit_code: 2,
        next_actions: (observation.next_actions as string[]) || ["Run without dryRun to continue execution."],
        artifacts: plan.artifacts,
        plan,
        observations,
        stop_condition: action.id === "pi.execute.runner" ? "dry_run_after_runner" : "dry_run_action",
        dry_run: true,
      };
    }
    writeState((observation.status as string) === "success" ? "running" : "error", observation.summary);
    if ((observation.status as string) !== "success") {
      return {
        status: "error",
        summary: `PI stopped at ${action.id}.`,
        code: (observation.code as string) || "PI_ACTION_FAILED",
        next_actions: (observation.next_actions as string[]) || ["Fix the failed action, then rerun PI from a stable PRD/findings artifact."],
        artifacts: plan.artifacts,
        plan,
        observations,
        stop_condition: "first_failed_action",
      };
    }
  }

  writeState("success", "PI execution completed all planned phases.");
  return {
    status: "success",
    summary: "PI execution completed all planned phases.",
    next_actions: ["Review delivery and learning artifacts before any external release action."],
    artifacts: plan.artifacts,
    plan,
    observations,
  };
}

export function createPiAgent(context: PiContext = {}) {
  return {
    id: "pi",
    label: "Product Implementation Agent",
    createPlan: (input: PiInput = {}) => createPiRunPlan(input, context),
    run: (input: PiInput = {}, options: PiRunOptions = {}) => runPiAgent(input, { ...context, ...options }),
  };
}
