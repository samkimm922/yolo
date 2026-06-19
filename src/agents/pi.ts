import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDiscoveryReadiness } from "../discovery/gate.js";
import { createLifecycleStateSnapshot } from "../lifecycle/schema.js";
import { inspectLifecycleGuard } from "../lifecycle/guard.js";
import { buildTeamDispatchPlan } from "./team-contracts.js";

const DEFAULT_YOLO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function nowStamp() {
  return new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
}

function asAbs(path, base) {
  if (!path) return null;
  return isAbsolute(path) ? path : resolve(base, path);
}

function tail(text = "", max = 4000) {
  const value = String(text || "");
  return value.length > max ? value.slice(-max) : value;
}

function script(yoloRoot, name) {
  return join(yoloRoot, name);
}

function commandAction({ id, phase, summary, command, args = [], cwd, stdin, creates = [], timeout_ms = 120000 }) {
  return {
    id,
    phase,
    kind: "command",
    status: "pending",
    summary,
    command,
    args,
    cwd,
    stdin,
    creates,
    timeout_ms,
  };
}

function runtimeAction({ id, phase, summary, runtime, params = Object(), timeout_ms = 120000 }) {
  return {
    id,
    phase,
    kind: "runtime",
    status: "pending",
    summary,
    runtime,
    params,
    artifacts: [],
    next_actions: [],
    timeout_ms,
  };
}

function observeAction({ id, phase, summary, artifacts = [], next_actions = [] }) {
  return {
    id,
    phase,
    kind: "observe",
    status: "pending",
    summary,
    artifacts,
    next_actions,
  };
}

function resolvePiArtifacts(input = Object(), context = Object()) {
  const yoloRoot = resolve(context.yoloRoot || DEFAULT_YOLO_ROOT);
  const projectRoot = resolve(context.projectRoot || resolve(yoloRoot, "../.."));
  const stateRoot = resolve(context.stateRoot || context.state_root || yoloRoot);
  const runId = input.runId || input.run_id || `pi-run-${nowStamp()}`;
  const outputDir = asAbs(input.outputDir || input.output_dir || join("data", "pi", runId), stateRoot);
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

function readRequirementForDiscovery(requirement, requirementFile) {
  if (requirement?.trim()) return requirement;
  if (requirementFile && existsSync(requirementFile)) return readFileSync(requirementFile, "utf8");
  return "";
}

function discoveryInputForPi(input = Object(), artifacts = Object(), requirement = "") {
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

function executionConfigForPi(input = Object()) {
  const model = input.model;
  const agentCommand = input.agentCommand || input.agent_command || input.customCommand || input.custom_command;
  const executor = input.executor || input.provider || (agentCommand ? "custom" : null);
  const provider = input.provider || input.executor || (agentCommand ? "custom" : null);
  return {
    ...(executor ? { executor } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(agentCommand ? { agentCommand } : {}),
    ...(input.dryRun === true || input.dry_run === true ? { dryRun: true } : {}),
    ...(input.collectEvidence === true || input.collect_evidence === true ? { collectEvidence: true } : {}),
    ...(input.executeAdapter === true || input.execute_adapter === true ? { executeAdapter: true } : {}),
    ...(input.allowAdapterCommands === true || input.allow_adapter_commands === true ? { allowAdapterCommands: true } : {}),
  };
}

function adapterEvidenceConfigForPi(input = Object()) {
  return {
    ...(input.collectEvidence === true || input.collect_evidence === true ? { collectEvidence: true } : {}),
    ...(input.executeAdapter === true || input.execute_adapter === true ? { executeAdapter: true } : {}),
    ...(input.allowAdapterCommands === true || input.allow_adapter_commands === true ? { allowAdapterCommands: true } : {}),
  };
}

export function createPiRunPlan(input = Object(), context = Object()) {
  const artifacts = resolvePiArtifacts(input, context);
  const mode = input.mode || "dev";
  const title = input.title || "PI implementation";
  const requirement = input.requirement || "";
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
      timeout_ms: context.prdTimeoutMs || 120000,
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
      timeout_ms: context.reviewTimeoutMs || 120000,
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
      timeout_ms: context.acceptanceTimeoutMs || 120000,
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

export async function defaultPiExecutor(action, context = Object()) {
  if (action.kind === "runtime") {
    const { runPiRuntime } = await import("../runtime/pi-runtimes.js");
    return runPiRuntime(action.runtime, action.params || {}, {
      timeout_ms: action.timeout_ms,
      projectRoot: context.plan?.artifacts?.projectRoot,
      stateRoot: context.plan?.artifacts?.stateRoot,
      yoloRoot: context.plan?.artifacts?.yoloRoot,
    });
  }

  for (const file of action.creates || []) {
    mkdirSync(dirname(file), { recursive: true });
  }

  const result = spawnSync(action.command, action.args, {
    cwd: action.cwd,
    input: action.stdin,
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
    artifacts: action.creates || [],
    next_actions: result.status === 0
      ? []
      : ["Inspect stderr/stdout tail, fix the root cause, then resume from the failed phase."],
  };
}

function isDryRunObservation(observation = Object()) {
  return observation.dry_run === true ||
    observation.dryRun === true ||
    observation.code === "RUNNER_DRY_RUN_READY";
}

export async function runPiAgent(input = Object(), options = Object()) {
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
      observations: [],
    };
  }

  mkdirSync(dirname(plan.artifacts.statePath), { recursive: true });
  const executor = options.executor || defaultPiExecutor;
  const observations = [];
  const writeState = (status, summary) => {
    writeFileSync(plan.artifacts.statePath, JSON.stringify({
      status,
      summary,
      updated_at: new Date().toISOString(),
      plan,
      observations,
    }, null, 2), "utf8");
  };
  writeState("running", "PI execution started.");

  for (const action of plan.actions) {
    // BUG-C3: lifecycle gate must fire for EVERY runtime execute action
    // (pi.execute.*), not just pi.execute.runner. Otherwise a blocked check
    // still permits other write-capable execute actions (installer, etc.)
    // to run. Observe actions are read-only and bypass the gate.
    if (action.kind === "runtime" && action.id?.startsWith("pi.execute.")) {
      const guard = inspectLifecycleGuard({
        command: "yolo-run",
        projectRoot: plan.artifacts.projectRoot,
        stateRoot: plan.artifacts.stateRoot,
        prdPath: action.params?.prdPath || plan.artifacts.prdPath,
      });
      if (guard.status !== "pass") {
        const observation = {
          action_id: action.id,
          status: "error",
          summary: guard.summary,
          code: guard.code || "LIFECYCLE_GUARD_BLOCKED",
          lifecycle_guard: guard,
          blockers: guard.blockers || [],
          next_actions: guard.next_actions || ["Run /yolo-next before starting implementation."],
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
        artifacts: action.artifacts || [],
        next_actions: action.next_actions || [],
      });
      writeState("running", action.summary);
      continue;
    }

    const observation = await executor(action, { plan, input, options });
    observations.push({ action_id: action.id, ...observation });
    if (isDryRunObservation(observation)) {
      writeState("dry_run", `PI dry-run stopped at ${action.id}.`);
      return {
        status: "dry_run",
        summary: `PI dry-run stopped at ${action.id}.`,
        code: "PI_DRY_RUN_READY",
        exit_code: 2,
        next_actions: observation.next_actions || ["Run without dryRun to continue execution."],
        artifacts: plan.artifacts,
        plan,
        observations,
        stop_condition: action.id === "pi.execute.runner" ? "dry_run_after_runner" : "dry_run_action",
        dry_run: true,
      };
    }
    writeState(observation.status === "success" ? "running" : "error", observation.summary);
    if (observation.status !== "success") {
      return {
        status: "error",
        summary: `PI stopped at ${action.id}.`,
        code: observation.code || "PI_ACTION_FAILED",
        next_actions: observation.next_actions || ["Fix the failed action, then rerun PI from a stable PRD/findings artifact."],
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

export function createPiAgent(context = Object()) {
  return {
    id: "pi",
    label: "Product Implementation Agent",
    createPlan: (input = Object()) => createPiRunPlan(input, context),
    run: (input = Object(), options = Object()) => runPiAgent(input, { ...context, ...options }),
  };
}
