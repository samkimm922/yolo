// Top-level yolo command dispatcher (runYoloCliInner).
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
import {
  runYoloInitCli,
  runYoloSetupCli,
  runYoloInstallCli,
  runYoloMemoryCli,
  runYoloReleaseCandidateCli,
  runYoloCheckCli,
  runYoloNextCli,
  runYoloProgressUiEvidenceCli,
  runYoloAcceptCli,
  runYoloDiscoverCli,
  runYoloPlanCli,
  runYoloPrdCli,
  runYoloWorkflowPlanCli,
  runYoloReviewCli,
  runYoloShipCli,
  runYoloLearnCli,
  runYoloReleaseCli,
  runYoloAutoCli,
} from "./commands.js";
import { runYoloInterviewCli } from "./commands-interview.js";
import {
  runYoloBrainstormCli,
  runYoloDemandCli,
  runYoloDiscussCli,
} from "./commands-demand.js";

export async function runYoloCliInner(argv = process.argv.slice(2), io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const yoloRoot = io.yoloRoot || defaultYoloRoot;
  if (argv[0] === "status") {
    return runYoloNextCli(argv.slice(1), io);
  }
  if (argv[0] === "spec") {
    return runYoloPrdCli(argv.slice(1), io);
  }
  if (argv[0] === "tasks") {
    return runYoloPlanCli(argv.slice(1), io);
  }
  if (argv[0] === "release") {
    return runYoloReleaseCli(argv.slice(1), io);
  }
  if (argv[0] === "init") {
    return runYoloInitCli(argv.slice(1), io);
  }
  if (argv[0] === "setup") {
    return runYoloSetupCli(argv.slice(1), io);
  }
  if (argv[0] === "install") {
    return runYoloInstallCli(argv.slice(1), io);
  }
  if (argv[0] === "doctor") {
    return runYoloDoctorCli(argv.slice(1), io);
  }
  if (argv[0] === "auto") {
    return runYoloAutoCli(argv.slice(1), io);
  }
  if (argv[0] === "demand") return runYoloDemandCli(argv.slice(1), io);
  if (argv[0] === "interview") return runYoloInterviewCli(argv.slice(1), io);
  if (argv[0] === "check") {
    return runYoloCheckCli(argv.slice(1), io);
  }
  if (argv[0] === "review") {
    return runYoloReviewCli(argv.slice(1), io);
  }
  if (argv[0] === "progress-ui-evidence" || argv[0] === "ui-evidence") {
    return runYoloProgressUiEvidenceCli(argv.slice(1), io);
  }
  if (argv[0] === "accept" || argv[0] === "ui-review") {
    stderr.write(`yolo ${argv[0]} is no longer a standalone command. Use: yolo release accept\n`);
    return 2;
  }
  if (argv[0] === "eval") {
    return runYoloBenchmarkCli(argv.slice(1), io);
  }
  if (argv[0] === "release-candidate" || argv[0] === "release-gate") {
    stderr.write(`yolo ${argv[0]} is no longer a standalone command. Use: yolo release candidate or yolo release gate\n`);
    return 2;
  }
  if (argv[0] === "memory") {
    return runYoloMemoryCli(argv.slice(1), io);
  }
  if (argv[0] === "next") {
    stderr.write(`yolo next is no longer a standalone command. Use: yolo status\n`);
    return 2;
  }
  if (argv[0] === "ship") {
    return runYoloShipCli(argv.slice(1), io);
  }
  if (argv[0] === "learn") {
    return runYoloLearnCli(argv.slice(1), io);
  }

  if (argv[0] === "runner") {
    argv = [...argv.slice(1), "--engine-only"];
  } else if (argv[0] === "run") {
    argv = argv.slice(1);
  }

  const firstArg = argv[0];
  if (firstArg && !firstArg.startsWith("-")) {
    const looksLikePath = firstArg.includes("/") || firstArg.includes(".") || firstArg.includes("\\");
    if (!looksLikePath) {
      stderr.write(`Unknown command: yolo ${firstArg}\n`);
      stderr.write(`Available commands: ${DEFAULT_YOLO_PUBLIC_COMMAND_NAMES.map((c) => `yolo ${c}`).join(", ")}\n`);
      stderr.write(`下一步执行 yolo ${DEFAULT_YOLO_PUBLIC_COMMAND_NAMES[0]}\n`);
      return 2;
    }
  }

  let parsed;
  try {
    parsed = parseYoloArgs(argv);
  } catch (error) {
    if (isCliParseError(error)) return emitCliParseError(error, argv, { stdout, stderr }, "yolo run");
    throw error;
  }
  const { input, options } = parsed;

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const cliProjectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const prdPath = input.prdPath
    ? resolvePrdPath(input.prdPath, yoloRoot, { cwd: cliProjectRoot })
    : inferDefaultCliPrdPath({ projectRoot: cliProjectRoot, stateRoot: join(cliProjectRoot, ".yolo") });

  if (!prdPath) {
    const result = {
      status: "error",
      summary: "missing PRD path",
      exit_code: 2,
      code: "MISSING_PRD_PATH",
      artifacts: [],
      next_actions: ["Pass a PRD path with --prd or create a runnable PRD under the target project's .yolo/data/prd/current."],
    };
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stderr.write(`${usage()}\n`);
    return result.exit_code;
  }

  const guarded = guardBlocked("yolo-run", { ...input, prdPath }, options, cliProjectRoot, { stdout, stderr });
  if (guarded !== 0) return guarded;

  if (!options.engineOnly) {
    const executor = input.executor || input.provider || (input.agentCommand ? "custom" : undefined);
    const provider = input.provider || input.executor || (input.agentCommand ? "custom" : undefined);
    let result = await runPiAgent({
      prdPath,
      mode: input.mode,
      executor,
      provider,
      model: input.model,
      agentCommand: input.agentCommand,
      dryRun: options.dryRun,
      collectEvidence: options.collectEvidence,
      executeAdapter: options.executeAdapter,
      allowAdapterCommands: options.allowAdapterCommands,
      startProgressServer: options.startProgressServer,
      runReviewLoop: options.runReviewLoop,
    }, {
      yoloRoot,
      projectRoot: cliProjectRoot,
      stateRoot: join(cliProjectRoot, ".yolo"),
      execute: true,
    });
    result = normalizeDryRunReadyExitCode(result);
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatPiRuntimeText("run", result)}\n`);
    return workflowExitCode(result);
  }

  const executor = input.executor || input.provider || (input.agentCommand ? "custom" : undefined);
  const provider = input.provider || input.executor || (input.agentCommand ? "custom" : undefined);
  let result = await runRunnerRuntime({
    prdPath,
    mode: input.mode,
    projectRoot: cliProjectRoot,
    stateRoot: join(cliProjectRoot, ".yolo"),
    dryRun: options.dryRun,
    writeLifecycle: options.writeLifecycle,
    collectEvidence: options.collectEvidence,
    executeAdapter: options.executeAdapter,
    allowAdapterCommands: options.allowAdapterCommands,
    startProgressServer: options.startProgressServer,
    runReviewLoop: options.runReviewLoop,
    executor,
    provider,
    model: input.model,
    agentCommand: input.agentCommand,
  });
  result = normalizeDryRunReadyExitCode(result);
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatRunnerText(result)}\n`);

  return isDryRunReadyResult(result) ? 0 : result.exit_code ?? (result.status === "success" ? 0 : 1);
}
