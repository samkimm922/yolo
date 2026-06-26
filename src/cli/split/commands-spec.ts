// yolo accept/discover/plan/prd/workflow/review/ship/learn subcommand runtimes.
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
import { runYoloBrainstormCli, runYoloDiscussCli } from "./commands-demand.js";

export async function runYoloAcceptCli(argv: string[] = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { input, options } = parseYoloAcceptArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const prdPath = input.prdPath
    ? resolvePrdPath(input.prdPath, io.yoloRoot || defaultYoloRoot, { cwd: projectRoot })
    : input.prdPath;
  const guarded = guardBlocked("yolo-accept", { ...input, prdPath }, options, projectRoot, { stdout, stderr });
  if (guarded !== 0) return guarded;
  let report = buildAcceptanceReport({
    prdPath,
    projectRoot,
    mode: input.mode,
    approvalArtifact: input.approvalArtifact,
    runReportPath: input.runReportPath,
    reviewReportPath: input.reviewReportPath,
    writeLifecycle: options.writeLifecycle,
    collectEvidence: options.collectEvidence,
    executeAdapter: options.executeAdapter,
    allowAdapterCommands: options.allowAdapterCommands,
  }, { learnFailures: true });
  if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else stdout.write(`${formatAcceptanceReportText(report)}\n`);
  return workflowExitCode(report);
}

export async function runYoloDiscoverCli(argv: string[] = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const { input, options } = parseYoloWorkflowArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  let result = runDiscoveryRuntime({
    ...input,
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
    objective: input.objective,
    writeArtifacts: options.writeLifecycle,
    writeLifecycle: options.writeLifecycle,
    source: "yolo-discover",
  });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatDiscoveryRuntimeText("discover", result)}\n`);
  return workflowExitCode(result);
}

export async function runYoloPlanCli(argv: string[] = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { input, options } = parseYoloWorkflowArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const guarded = guardBlocked("yolo-plan", input, options, projectRoot, { stdout, stderr });
  if (guarded !== 0) return guarded;
  if (input.demandPath) {
    let result = runDemandTaskRuntime({
      ...input,
      projectRoot,
      stateRoot: join(projectRoot, ".yolo"),
      writeArtifacts: options.writeLifecycle,
    });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatDemandRuntimeText("tasks", result)}\n`);
    return workflowExitCode(result);
  }
  let result = runDiscoveryPlanRuntime({
    ...input,
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
    objective: input.objective,
    writeArtifacts: options.writeLifecycle,
    writeLifecycle: options.writeLifecycle,
    source: "yolo-plan",
  });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatDiscoveryRuntimeText("plan", result)}\n`);
  return workflowExitCode(result);
}

export async function runYoloPrdCli(argv: string[] = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { input, options } = parseYoloWorkflowArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const guarded = guardBlocked("yolo-prd", input, options, projectRoot, { stdout, stderr });
  if (guarded !== 0) return guarded;
  if (input.demandPath) {
    let result = runDemandPrdRuntime({
      ...input,
      projectRoot,
      stateRoot: join(projectRoot, ".yolo"),
      writeArtifacts: options.writeLifecycle,
    });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatDemandRuntimeText("prd", result)}\n`);
    return workflowExitCode(result);
  }

  let result = runDiscoveryPrdRuntime({
    ...input,
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
    objective: input.objective,
    writeArtifacts: options.writeLifecycle,
    writeLifecycle: options.writeLifecycle,
    source: "yolo-prd",
  });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatDiscoveryRuntimeText("prd", result)}\n`);
  return workflowExitCode(result);
}

export async function runYoloWorkflowPlanCli(workflow: string, argv: string[] = [], io: { stdout?: { write: (data: string) => void }; stderr?: { write: (data: string) => void } } = {}) {
  if (workflow === "brainstorm") return runYoloBrainstormCli(argv, io);
  if (workflow === "discover") return runYoloDiscoverCli(argv, io);
  if (workflow === "discuss") return runYoloDiscussCli(argv, io);
  if (workflow === "plan") return runYoloPlanCli(argv, io);
  if (workflow === "prd") return runYoloPrdCli(argv, io);
  const stdout = io.stdout || process.stdout;
  const result = {
    status: "error",
    code: "UNKNOWN_WORKFLOW",
    summary: `Unknown workflow: ${workflow}`,
    workflow,
    artifacts: [],
    next_actions: ["Use discover, plan, or prd."],
  };
  if (argv.includes("--json")) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatWorkflowPlanText(result)}\n`);
  return 2;
}

export async function runYoloReviewCli(argv: string[] = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { input, options } = parseYoloWorkflowArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const reviewScopeFiles = reviewScopeFilesFromInput(input, projectRoot);
  const guarded = guardBlocked("yolo-review", input, options, projectRoot, { stdout, stderr });
  if (guarded !== 0) return guarded;
  const stateRoot = join(projectRoot, ".yolo");
  let result = reviewScopeFiles.length > 0
    ? buildScopedReviewScanReport({
      scan: scanProject({ root: projectRoot, files: reviewScopeFiles }),
      projectRoot,
      stateRoot,
      reviewScopeFiles,
      writeLifecycle: options.writeLifecycle,
    })
    : await runPiRuntime("review.scan", {
      projectRoot,
      stateRoot,
      writeLifecycle: options.writeLifecycle,
    });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatPiRuntimeText("review", result)}\n`);
  return result.status === "success" ? 0 : 1;
}

export async function runYoloShipCli(argv: string[] = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { input, options } = parseYoloWorkflowArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const prdPath = input.prdPath
    ? resolvePrdPath(input.prdPath, io.yoloRoot || defaultYoloRoot, { cwd: projectRoot })
    : "";
  const guarded = guardBlocked("yolo-ship", { ...input, prdPath }, options, projectRoot, { stdout, stderr });
  if (guarded !== 0) return guarded;
  let result = await runPiRuntime("ship", {
    prdPath,
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
    writeLifecycle: options.writeLifecycle,
  });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatPiRuntimeText("ship", result)}\n`);
  return result.status === "success" ? 0 : 1;
}

export async function runYoloLearnCli(argv: string[] = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const { input, options } = parseYoloWorkflowArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const prdPath = input.prdPath
    ? resolvePrdPath(input.prdPath, io.yoloRoot || defaultYoloRoot, { cwd: projectRoot })
    : "";
  let result = await runPiRuntime("learn", {
    prdPath,
    lesson: input.lesson || input.objective,
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
    writeLifecycle: options.writeLifecycle,
  });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatPiRuntimeText("learn", result)}\n`);
  return result.status === "success" ? 0 : 1;
}
