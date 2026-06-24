// yolo demand/discuss/brainstorm subcommand runtimes.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

// YOLO subcommand runtime entry points (the `runYolo*Cli` functions).
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

import { join, resolve } from "node:path";
import { initProject } from "../../core/bootstrap.js";
import { runProjectSetup } from "../../core/setup.js";
import { resolvePrdPath } from "../../core/paths.js";
import { runYoloDoctorCli } from "../../devtools/doctor.js";
import { buildAcceptanceReport, formatAcceptanceReportText } from "../../runtime/acceptance/report.js";
import { runYoloBenchmarkCli } from "../../eval/benchmark.js";
import { preflightAllPrds } from "../../prd/preflight.js";
import { buildProgressDashboardUiEvidence } from "../../runtime/progress/ui-evidence.js";
import { refreshMemoryCenter } from "../../runtime/memory/center.js";
import { runRunnerRuntime } from "../../runtime/runner-runtime.js";
import { runPiRuntime } from "../../runtime/pi-runtimes.js";
import { runPiAgent, createPiRunPlan } from "../../agents/pi.js";
import { scanProject } from "../../review/scanner.js";
import {
  runDiscoveryPlanRuntime,
  runDiscoveryPrdRuntime,
  runDiscoveryRuntime,
} from "../../discovery/runtime.js";
import {
  runDemandBrainstormRuntime,
  runDemandApprovedRuntime,
  runDemandDiscussRuntime,
  runDemandOfficeHoursRuntime,
  runDemandTaskRuntime,
  runDemandPrdRuntime,
  runDemandStatusRuntime,
} from "../../demand/runtime.js";
import { runDemandEvidenceDispatchRuntime } from "../../demand/evidence-dispatch.js";
import { demandInterviewToDemandInput } from "../../demand/interview.js";
import { buildUnderstandingPlayback } from "../../demand/understanding-playback.js";
import { nextLifecycleAction } from "../../lifecycle/guard.js";
import { writeSourceSnapshot } from "../../lifecycle/source-snapshot.js";
import { installAgentBridge } from "../../../tools/install-agent-bridge.js";
import { formatYoloCheckText, inspectYoloCheck } from "../../runtime/gates/check-report.js";

import {
  cleanCliText,
  defaultYoloRoot,
  isBlockingWorkflowStatus,
  isDryRunReadyResult,
  normalizeDemandStage,
  normalizeDryRunReadyExitCode,
  usage,
  workflowExitCode,
} from "./shared.js";
import { DEFAULT_YOLO_PUBLIC_COMMAND_NAMES } from "../../workflows/command-registry.js";
import {
  emitCliParseError,
  isCliParseError,
} from "./parse-helpers.js";
import {
  parseYoloAcceptArgs,
  parseYoloArgs,
  parseYoloAutoArgs,
  parseYoloCheckArgs,
  parseYoloInitArgs,
  parseYoloInterviewArgs,
  parseYoloMemoryArgs,
  parseYoloProgressUiEvidenceArgs,
  parseYoloReleaseCandidateArgs,
  parseYoloSetupArgs,
  parseYoloWorkflowArgs,
} from "./parse-args.js";
import { inferDefaultCliPrdPath } from "./prd-discovery.js";
import {
  formatDemandDispatchText,
  formatDemandRuntimeText,
  formatDemandStatusText,
  formatDiscoveryRuntimeText,
  formatInitText,
  formatInstallText,
  formatMemoryText,
  formatPiRuntimeText,
  formatRunnerText,
  formatSetupText,
  formatWorkflowPlanText,
  formatYoloNextText,
  formatInterviewText,
} from "./text-format.js";
import {
  buildScopedReviewScanReport,
  reviewScopeFilesFromInput,
} from "./review-scope.js";
import { guardBlocked, inspectCliGuard } from "./lifecycle-guard.js";
import {
  cloneReleaseCandidateGates,
  buildDefaultReleaseCandidateReports,
  formatReleaseCandidateText,
  normalizeReleaseCandidateResult,
  releaseCandidateErrorResult,
  releaseCandidateExitCode,
  runDefaultReleaseCandidateRunner,
} from "./release-candidate.js";
import {
  answerDemandInterviewQuestion,
  cloneJson,
  createInterviewState,
  decorateInterviewState,
  interviewResult,
  readInterviewState,
  resolveInterviewQuestionId,
  writeInterviewAnswerLedger,
  writeInterviewDecisionLedger,
  writeJsonFile,
} from "./interview-helpers.js";
import { runYoloInterviewCli } from "./commands-interview.js";

export async function runYoloBrainstormCli(argv = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const { input, options } = parseYoloWorkflowArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  let result = runDemandBrainstormRuntime({
    ...input,
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
    objective: input.objective,
    writeArtifacts: options.writeLifecycle,
  });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatDemandRuntimeText("brainstorm", result)}\n`);
  return workflowExitCode(result);
}

async function runYoloDemandStageCli(stage: string, input: Record<string, unknown> = {}, options: Record<string, unknown> = {}, io: { stdout?: { write: (data: string) => void }; stderr?: { write: (data: string) => void }; cwd?: string } = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const projectRoot = resolve((input.cwd as string | undefined) || io.cwd || process.cwd());
  const stateRoot = join(projectRoot, ".yolo");
  const stageLabel = normalizeDemandStage(stage);

  if (stageLabel === "office-hours") {
    let result = runDemandOfficeHoursRuntime({
      ...input,
      projectRoot,
      stateRoot,
      objective: input.objective,
      writeArtifacts: options.writeLifecycle,
    });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatDemandRuntimeText("office-hours", result)}\n`);
    return workflowExitCode(result);
  }

  if (stageLabel === "brainstorm") {
    let result = runDemandBrainstormRuntime({
      ...input,
      projectRoot,
      stateRoot,
      objective: input.objective,
      writeArtifacts: options.writeLifecycle,
    });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatDemandRuntimeText("brainstorm", result)}\n`);
    return workflowExitCode(result);
  }

  if (stageLabel === "interview") {
    const interviewArgs = ["start"];
    if (input.objective) interviewArgs.push(input.objective as string);
    if (input.cwd) interviewArgs.push(`--cwd=${input.cwd}`);
    if (options.json) interviewArgs.push("--json");
    if (options.writeLifecycle === false) interviewArgs.push("--no-write");
    return runYoloInterviewCli(interviewArgs, io);
  }

  if (stageLabel === "discover") {
    let result = runDiscoveryRuntime({
      ...input,
      projectRoot,
      stateRoot,
      objective: input.objective,
      writeArtifacts: options.writeLifecycle,
      writeLifecycle: options.writeLifecycle,
      source: "yolo-demand:discover",
    });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatDiscoveryRuntimeText("discover", result)}\n`);
    return workflowExitCode(result);
  }

  if (stageLabel === "discuss") {
    let result = runDemandDiscussRuntime({
      ...input,
      projectRoot,
      stateRoot,
      objective: input.objective,
      writeArtifacts: options.writeLifecycle,
    });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatDemandRuntimeText("discuss", result)}\n`);
    return workflowExitCode(result);
  }

  if (stageLabel === "prd") {
    const demandRef = input.demandPath || input.demand_path || "<session.json|dir>";
    const result = {
      status: "blocked",
      code: "DEMAND_STAGE_PRD_DEPRECATED",
      summary: "Demand stage stops at approved demand artifacts; executable PRD generation belongs to yolo spec.",
      blockers: [{
        code: "USE_SPEC_FOR_EXECUTABLE_PRD",
        message: "Do not generate executable prd.json from yolo demand.",
      }],
      artifacts: [],
      next_action: `yolo spec --demand ${demandRef}`,
      next_actions: [`yolo spec --demand ${demandRef}`],
    };
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatDemandRuntimeText("prd", result)}\n`);
    return workflowExitCode(result);
  }

  const result = {
    status: "error",
    code: "UNKNOWN_DEMAND_STAGE",
    summary: `Unknown demand stage: ${stage}`,
    next_actions: ["Use --stage brainstorm, interview, discover, discuss, prd, status, or dispatch."],
  };
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatDemandStatusText(result)}\n`);
  return 2;
}

export async function runYoloDemandCli(argv = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const commandNames = new Set(["status", "dispatch", "evidence"]);
  const stageNames = new Set(["brainstorm", "interview", "office-hours", "office_hours", "office", "discover", "discovery", "discuss", "discussion", "prd"]);
  const first = argv[0] && !argv[0].startsWith("--") ? normalizeDemandStage(argv[0]) : "";
  let command = commandNames.has(first) ? first : "status";
  let args = commandNames.has(first) ? argv.slice(1) : argv;
  if (stageNames.has(first)) args = ["--stage", first, ...argv.slice(1)];
  const { input, options } = parseYoloWorkflowArgs(args);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const stage = normalizeDemandStage(input.stage as string);
  const profile = cleanCliText(input.profile).toLowerCase();
  const demandMode = cleanCliText(input.mode).toLowerCase();
  if (!stage && (
    ["office-hours", "office_hours", "office", "startup", "builder"].includes(profile)
    || ["office-hours", "office_hours", "office", "startup", "builder"].includes(demandMode)
  )) {
    return runYoloDemandStageCli("office-hours", input, options, io);
  }
  if (commandNames.has(stage)) {
    command = stage;
  } else if (stage) {
    return runYoloDemandStageCli(stage, input, options, io);
  }

  // Non-technical onboarding: a bare `yolo demand "<idea>"` (no --stage, no
  // status/dispatch subcommand, no existing session) used to dump a blocked
  // demand-intake-blocked snapshot and a free-text question with no runnable
  // next step. Route it into the interview stage so the user gets a session
  // path and a copy-pasteable `yolo interview answer ...` next action.
  const bareIdeaText = cleanCliText(input.objective || input.idea || input.text || input.requirement);
  const hasExplicitSession = Boolean(
    input.demandPath || input.demand_path || input.sessionPath || input.session_path,
  );
  if (
    command === "status"
    && !commandNames.has(first)
    && !stageNames.has(first)
    && bareIdeaText
    && !hasExplicitSession
  ) {
    return runYoloDemandStageCli("interview", input, options, io);
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  if (command === "dispatch" || command === "evidence") {
    const result = await runDemandEvidenceDispatchRuntime({
      ...input,
      executeAgents: options.executeAgents,
      allowAgentDispatch: options.allowAgentDispatch,
      projectRoot,
      stateRoot: join(projectRoot, ".yolo"),
      objective: input.objective,
    });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatDemandDispatchText(result)}\n`);
    return workflowExitCode(result);
  }
  const result = runDemandStatusRuntime({
    ...input,
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
    objective: input.objective,
  });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatDemandStatusText({ ...result })}\n`);
  return workflowExitCode(result);
}

export async function runYoloDiscussCli(argv = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const { input, options } = parseYoloWorkflowArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  let result = runDemandDiscussRuntime({
    ...input,
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
    objective: input.objective,
    writeArtifacts: options.writeLifecycle,
  });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatDemandRuntimeText("discuss", result)}\n`);
  return workflowExitCode(result);
}
