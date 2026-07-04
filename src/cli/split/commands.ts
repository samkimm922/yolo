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

export async function runYoloInitCli(argv = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { input, options } = parseYoloInitArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  try {
    const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
    let result = initProject({
      projectRoot,
      projectName: input.projectName,
      force: options.force,
      dryRun: options.dryRun,
    });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatInitText(result)}\n`);
    return result.exit_code;
  } catch (error) {
    const result = {
      status: "error",
      summary: "failed to initialize YOLO project",
      exit_code: 1,
      code: "INIT_FAILED",
      error: error.message,
    };
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stderr.write(`[yolo init] error: ${error.message}\n`);
    return result.exit_code;
  }
}

export async function runYoloSetupCli(argv = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { input, options } = parseYoloSetupArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  try {
    const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
    const result = runProjectSetup({
      projectRoot,
      projectName: input.projectName,
      yoloRoot: io.yoloRoot || defaultYoloRoot,
      homeDir: input.homeDir,
      target: options.target,
      scope: options.scope,
      force: options.force,
      dryRun: options.dryRun,
    });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else (result.status === "blocked" ? stderr : stdout).write(`${formatSetupText(result)}\n`);
    return result.exit_code;
  } catch (error) {
    const result = {
      status: "error",
      summary: "failed to run YOLO project setup",
      exit_code: 1,
      code: "SETUP_FAILED",
      error: error.message,
    };
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stderr.write(`[yolo setup] error: ${error.message}\n`);
    return result.exit_code;
  }
}

export async function runYoloInstallCli(argv = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { input, options } = parseYoloSetupArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  try {
    const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
    const result = installAgentBridge({
      projectRoot,
      yoloRoot: io.yoloRoot || defaultYoloRoot,
      homeDir: input.homeDir,
      targets: options.target,
      scope: options.scope,
      force: options.force,
      dryRun: options.dryRun,
    });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatInstallText(result)}\n`);
    return 0;
  } catch (error) {
    const result = {
      status: "error",
      summary: "failed to install YOLO agent bridge",
      exit_code: 1,
      code: "INSTALL_FAILED",
      error: error.message,
    };
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stderr.write(`[yolo install] error: ${error.message}\n`);
    return result.exit_code;
  }
}

export async function runYoloMemoryCli(argv = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { input, options } = parseYoloMemoryArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  try {
    const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
    const result = refreshMemoryCenter({
      projectRoot,
      dryRun: options.dryRun,
      writeLegacyPointers: options.writeLegacyPointers,
      applyRetention: options.applyRetention,
      migrateLearning: options.migrateLearning,
      pruneGeneratedArchives: options.pruneGeneratedArchives,
      maxChanges: options.maxChanges,
      maxEvents: options.maxEvents,
      maxRuns: options.maxRuns,
      maxReviewLog: options.maxReviewLog,
      maxSessionMemory: options.maxSessionMemory,
      maxLearning: options.maxLearning,
    });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatMemoryText(result)}\n`);
    return 0;
  } catch (error) {
    const result = {
      status: "error",
      summary: "failed to refresh YOLO memory center",
      exit_code: 1,
      code: "MEMORY_REFRESH_FAILED",
      error: error.message,
    };
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stderr.write(`[yolo memory] error: ${error.message}\n`);
    return result.exit_code;
  }
}

export async function runYoloCheckCli(argv = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let parsed;
  try {
    parsed = parseYoloCheckArgs(argv);
  } catch (error) {
    if (isCliParseError(error)) return emitCliParseError(error, argv, { stdout, stderr }, "yolo check");
    throw error;
  }
  const { input, options } = parsed;

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const prdPath = input.prdPath
    ? resolvePrdPath(input.prdPath, io.yoloRoot || defaultYoloRoot, { cwd: projectRoot })
    : inferDefaultCliPrdPath({ projectRoot, stateRoot: join(projectRoot, ".yolo") });
  const guarded = guardBlocked("yolo-check", { ...input, prdPath }, options, projectRoot, { stdout, stderr });
  if (guarded !== 0) return guarded;
  let report = inspectYoloCheck({
    prdPath,
    projectRoot,
    mode: input.mode,
    strictExecution: input.strictExecution,
    writeLifecycle: options.writeLifecycle,
  }, { learnFailures: true });
  // BUG-C2: stamp the worktree signature whenever the check writes its
  // lifecycle artifact, so the next guard call can detect out-of-band edits.
  if (options.writeLifecycle && report.status === "pass") {
    try {
      writeSourceSnapshot({ projectRoot, stateRoot: join(projectRoot, ".yolo") });
    } catch {
      // Snapshot is non-blocking telemetry; never fail the check on it.
    }
  }
  if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else (report.status === "error" ? stderr : stdout).write(`${formatYoloCheckText(report)}\n`);
  return report.status === "pass" ? 0 : report.status === "warning" ? 2 : 1;
}

export async function runYoloNextCli(argv = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const { input, options } = parseYoloWorkflowArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const guard = inspectCliGuard("yolo-next", input, options, projectRoot);
  const next = nextLifecycleAction({ projectRoot, stateRoot: join(projectRoot, ".yolo") });
  const previewCommand = guardCommandForRecommended(next.command);
  const previewGuard = inspectCliGuard(previewCommand, input, options, projectRoot);
  if (previewGuard.status !== "pass") {
    const recoveryCommand = recommendedRecoveryCommand(previewGuard);
    const result = {
      status: "blocked",
      code: "YOLO_NEXT_BLOCKED_BY_GUARD",
      summary: `Next lifecycle command is blocked by guard: ${next.command}.`,
      project_root: projectRoot,
      current_stage: previewGuard.current_stage || guard.current_stage,
      recommended_command: recoveryCommand,
      recovery_command: recoveryCommand,
      blocked_recommended_command: next.command,
      target_stage: next.stage,
      reason: next.reason,
      description: next.description,
      allowed_commands: [...new Set([recoveryCommand, "yolo status", ...(Array.isArray(previewGuard.allowed_commands) ? previewGuard.allowed_commands : [])])],
      guard: previewGuard,
      guard_blockers: previewGuard.blockers || [],
      next_actions: [
        `Run ${recoveryCommand} to inspect lifecycle blockers before retrying ${next.command}.`,
      ],
    };
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatYoloNextText(result)}\n`);
    return 2;
  }
  const result = {
    status: "success",
    code: "YOLO_NEXT_READY",
    summary: `Next safe YOLO stage is ${next.command}.`,
    project_root: projectRoot,
    current_stage: guard.current_stage,
    recommended_command: next.command,
    target_stage: next.stage,
    reason: next.reason,
    description: next.description,
    allowed_commands: [...new Set([next.command, ...(Array.isArray(previewGuard.allowed_commands) ? previewGuard.allowed_commands : guard.allowed_commands || [])])],
    guard: previewGuard,
    next_actions: [`Run ${next.command}: ${next.description}.`],
  };
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatYoloNextText(result)}\n`);
  return 0;
}

function guardCommandForRecommended(command) {
  const normalized = cleanCliText(command).replace(/\s+/g, " ");
  if (normalized.startsWith("yolo spec ")) return "yolo-prd";
  if (normalized.startsWith("yolo demand --stage interview")) return "yolo-interview";
  if (normalized.startsWith("yolo demand --stage brainstorm")) return "yolo-brainstorm";
  if (normalized.startsWith("yolo demand --stage discover")) return "yolo-discover";
  if (normalized.startsWith("yolo demand --stage discuss")) return "yolo-discuss";
  const aliases = new Map([
    ["yolo init", "yolo-init"],
    ["yolo setup", "yolo-setup"],
    ["yolo install", "yolo-install"],
    ["yolo doctor", "yolo-doctor"],
    ["yolo tasks", "yolo-plan"],
    ["yolo spec", "yolo-prd"],
    ["yolo check", "yolo-check"],
    ["yolo run", "yolo-run"],
    ["yolo review", "yolo-review"],
    ["yolo release accept", "yolo-accept"],
    ["yolo ship", "yolo-ship"],
    ["yolo learn", "yolo-learn"],
  ]);
  return aliases.get(normalized) || normalized.replace(/^yolo\s+/, "yolo-").replace(/\s+/g, "-");
}

function recommendedRecoveryCommand(guard = Object()) {
  const allowed = Array.isArray(guard.allowed_commands) ? guard.allowed_commands.map(String) : [];
  const directRecovery = allowed.find((command) => command.startsWith("yolo ") && command !== "yolo status" && command !== "yolo doctor");
  if (directRecovery) return directRecovery;
  if (allowed.includes("yolo doctor")) return "yolo doctor";
  return allowed.find((command) => command === "yolo status" || command.startsWith("yolo ")) || "yolo doctor";
}

export async function runYoloProgressUiEvidenceCli(argv = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const { input, options } = parseYoloProgressUiEvidenceArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const stateRoot = join(projectRoot, ".yolo");
  let report = buildProgressDashboardUiEvidence({
    projectRoot,
    stateRoot,
    outputPath: input.outputPath,
    writeArtifacts: options.writeArtifacts,
  });
  if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else stdout.write(`[yolo progress-ui-evidence] ${report.status}: ${report.summary}\n`);
  return report.status === "pass" ? 0 : 1;
}

// Re-export the subcommand runtimes split into sibling modules so the public
// barrel (src/cli/yolo.ts) and the dispatcher can reach them via ./commands.js.
// Pure structural relocation — no behavior change.
export { runYoloInterviewCli } from "./commands-interview.js";
export {
  runYoloBrainstormCli,
  runYoloDemandCli,
  runYoloDiscussCli,
} from "./commands-demand.js";
export {
  runYoloReleaseCandidateCli,
  runYoloReleaseCli,
  runYoloAutoCli,
} from "./commands-release.js";
export {
  runYoloAcceptCli,
  runYoloDiscoverCli,
  runYoloPlanCli,
  runYoloPrdCli,
  runYoloWorkflowPlanCli,
  runYoloReviewCli,
  runYoloShipCli,
  runYoloLearnCli,
} from "./commands-spec.js";
export { runYoloCliInner } from "./dispatch.js";
