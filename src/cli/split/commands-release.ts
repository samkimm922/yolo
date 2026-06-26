// yolo release/release-candidate/auto subcommand runtimes.
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
import { runYoloAcceptCli, runYoloShipCli } from "./commands-spec.js";

export async function runYoloReleaseCandidateCli(argv: string[] = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { input, options } = parseYoloReleaseCandidateArgs(argv);
  const command = io.releaseCandidateCommand || "release-candidate";
  const stage = io.releaseCandidateStage || io.release_candidate_stage || (command === "release" ? "release-candidate" : command);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const mode = cleanCliText(input.mode || "rc").toLowerCase();
  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const yoloRoot = resolve(io.yoloRoot || defaultYoloRoot);
  const context = {
    command,
    input: { ...input, mode, stage },
    options,
    projectRoot,
    yoloRoot,
  };

  function emit(result: Record<string, unknown>) {
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else (result.status === "pass" ? stdout : stderr).write(`${formatReleaseCandidateText(result)}\n`);
    return releaseCandidateExitCode(result);
  }

  if (!["rc", "publish"].includes(mode)) {
    return emit(releaseCandidateErrorResult(
      new Error(`Invalid release-candidate mode "${input.mode}". Expected rc or publish.`),
      context,
      "INVALID_RELEASE_CANDIDATE_MODE",
    ));
  }

  try {
    const runner = typeof io.releaseCandidateRunner === "function"
      ? io.releaseCandidateRunner
      : runDefaultReleaseCandidateRunner;
    const raw = await runner({
      projectRoot,
      stateRoot: join(projectRoot, ".yolo"),
      yoloRoot,
      command,
      stage,
      gateId: stage,
      internal_gate_id: stage,
      mode,
      dryRun: options.dryRun,
      allowUntracked: options.allowUntracked,
      allowUnknown: options.allowUnknown,
      failClosed: true,
      gateKind: "generic_rc_gate",
      notTrelloReplay: true,
      requiredGates: cloneReleaseCandidateGates(),
      scope: input.scope || "workspace",
    });
    return emit(normalizeReleaseCandidateResult(raw, context));
  } catch (error) {
    return emit(releaseCandidateErrorResult(error, context));
  }
}

export async function runYoloReleaseCli(argv: string[] = [], io = Object()) {
  const first = argv[0] && !argv[0].startsWith("--") ? cleanCliText(argv[0]).toLowerCase() : "";
  if (first === "accept" || first === "ui-review") {
    return runYoloAcceptCli(argv.slice(1), io);
  }
  if (first === "ship") {
    return runYoloShipCli(argv.slice(1), io);
  }
  if (first === "candidate" || first === "gate" || first === "release-candidate" || first === "release-gate") {
    const releaseCandidateStage = first === "gate" || first === "release-gate" ? "release-gate" : "release-candidate";
    return runYoloReleaseCandidateCli(argv.slice(1), { ...io, releaseCandidateCommand: "release", releaseCandidateStage });
  }
  if (first === "rc" || first === "publish") {
    return runYoloReleaseCandidateCli(["--mode", first, ...argv.slice(1)], { ...io, releaseCandidateCommand: "release", releaseCandidateStage: "release-candidate" });
  }
  return runYoloReleaseCandidateCli(argv, { ...io, releaseCandidateCommand: "release", releaseCandidateStage: "release-candidate" });
}

export async function runYoloAutoCli(argv: string[] = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const yoloRoot = io.yoloRoot || defaultYoloRoot;
  let parsed;
  try {
    parsed = parseYoloAutoArgs(argv, { cwd: io.cwd });
  } catch (error) {
    if (isCliParseError(error)) return emitCliParseError(error, argv, { stdout, stderr }, "yolo auto");
    throw error;
  }
  const { input, options } = parsed;
  const cliProjectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const requirement = input.idea || input.requirement || input.objective || "";

  if (options.help) {
    stdout.write([
      "yolo auto <idea or requirement> [--dry-run] [--json] [--cwd <dir>]",
      "",
      "Auto-run the full YOLO pipeline: clarify → spec → check → implement → review → deliver.",
      "Each stage is independently gated by the lifecycle guard.",
    ].join("\n") + "\n");
    return 0;
  }

  if (!requirement.trim() && !input.prdPath) {
    const result = {
      status: "error",
      summary: "yolo auto requires an idea or requirement.",
      exit_code: 2,
      code: "AUTO_MISSING_REQUIREMENT",
      next_actions: ["Provide a requirement, e.g. yolo auto \"Add low-stock alerts to inventory dashboard\"."],
    };
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stderr.write(`${result.summary}\n${(result.next_actions || []).join("\n")}\n`);
    return result.exit_code;
  }

  const planInput = requirement.trim() ? { ...input, requirement } : { ...input };
  const plan = createPiRunPlan(planInput, {
    yoloRoot,
    projectRoot: cliProjectRoot,
    stateRoot: join(cliProjectRoot, ".yolo"),
  });

  if (options.dryRun) {
    const result = {
      status: "dry_run",
      code: "AUTO_PLAN_READY",
      summary: "Auto plan created; execution was not started.",
      exit_code: 2,
      next_actions: plan.next_actions || ["Review the plan, then run without --dry-run to execute."],
      artifacts: plan.artifacts,
      plan,
    };
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatPiRuntimeText("auto", result)}\n`);
    return result.exit_code;
  }

  const result = await runPiAgent(planInput, {
    yoloRoot,
    projectRoot: cliProjectRoot,
    stateRoot: join(cliProjectRoot, ".yolo"),
    execute: true,
  });

  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatPiRuntimeText("auto", result)}\n`);
  const dynamicResult = Object.assign(Object(), result);
  return dynamicResult.exit_code ?? (dynamicResult.status === "success" ? 0 : 2);
}

// The inner run dispatcher. Exported so the barrel can wrap it with parse-error handling.

// Re-export the subcommand runtimes that were split into sibling modules so the
// public barrel (src/cli/yolo.ts) and other internal callers can still reach them
// via ./commands.js as before. Pure structural relocation — no behavior change.
export { runYoloInterviewCli } from "./commands-interview.js";
export {
  runYoloBrainstormCli,
  runYoloDemandCli,
  runYoloDiscussCli,
} from "./commands-demand.js";
export { runYoloCliInner } from "./dispatch.js";
