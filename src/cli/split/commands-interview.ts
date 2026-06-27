// yolo interview subcommand runtime.
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

type CliIo = {
  stdout?: { write: (data: string) => void };
  stderr?: { write: (data: string) => void };
  cwd?: string;
  logDir?: string;
};

export async function runYoloInterviewCli(argv: string[] = [], io: CliIo = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { input, options } = parseYoloInterviewArgs(argv);
  const command = typeof input.command === "string" ? input.command : "";

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  function emit(label: string, result: Record<string, unknown>, exitCode = 0) {
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else (result.status === "error" ? stderr : stdout).write(`${formatInterviewText(label, result)}\n`);
    return exitCode;
  }

  function error(label: string | undefined, code: string, summary: string, exitCode = 2) {
    return emit(label || "unknown", {
      status: "error",
      code,
      command: label,
      summary,
      next_question: null,
      coverage: null,
      artifacts: [],
      next_actions: ["Run yolo interview --help for supported commands."],
    }, exitCode);
  }

  try {
    const projectRoot = resolve((input.cwd as string | undefined) || io.cwd || process.cwd());
    const stateRoot = join(projectRoot, ".yolo");
    const writeArtifacts = options.writeArtifacts !== false;

    if (command === "start") {
      const state = createInterviewState(input, projectRoot, stateRoot);
      const interviewPath = state.interview_path || "";
      const artifacts = writeArtifacts ? [writeJsonFile(interviewPath, state)] : [];
      return emit("start", interviewResult("start", state, {
        summary: writeArtifacts ? "Interview session started." : "Interview session preview generated.",
        artifacts,
        outputs: artifacts.map((artifactPath) => ({ path: artifactPath, type: "interview_state" })),
      }));
    }

    if (command === "answer") {
      if (!input.sessionPath) return error("answer", "MISSING_INTERVIEW_SESSION", "Missing --session <path|dir>.");
      if (!input.questionId) return error("answer", "MISSING_INTERVIEW_QUESTION", "Missing --question <id>.");
      if (!cleanCliText(input.answer)) return error("answer", "MISSING_INTERVIEW_ANSWER", "Missing --answer <text>.");
      const read = readInterviewState(input.sessionPath, projectRoot);
      if (read.ok === false) return error("answer", "INTERVIEW_SESSION_MISSING", read.error, 1);
      const questionId = resolveInterviewQuestionId(read.state, input.questionId);
      const question = (read.state.questions || []).find((item) => item.id === questionId);
      if (!question) return error("answer", "INTERVIEW_QUESTION_UNKNOWN", `Question not found: ${input.questionId}`, 1);
      const state = decorateInterviewState(answerDemandInterviewQuestion(cloneJson(read.state), {
        questionId,
        answer: cleanCliText(input.answer),
      }));
      const interviewPath = state.interview_path || "";
      const artifacts = (writeArtifacts ? [
        writeJsonFile(interviewPath, state),
        writeInterviewAnswerLedger(state, question, cleanCliText(input.answer)),
      ] : []).filter((p): p is string => typeof p === "string");
      return emit("answer", interviewResult("answer", state, {
        summary: writeArtifacts ? "Interview answer recorded." : "Interview answer preview generated.",
        artifacts,
        outputs: artifacts.map((artifactPath) => ({ path: artifactPath, type: artifactPath.endsWith(".jsonl") ? "interview_ledger" : "interview_state" })),
      }));
    }

    if (command === "status") {
      if (!input.sessionPath) return error("status", "MISSING_INTERVIEW_SESSION", "Missing --session <path|dir>.");
      const read = readInterviewState(input.sessionPath, projectRoot);
      if (read.ok === false) return error("status", "INTERVIEW_SESSION_MISSING", read.error, 1);
      return emit("status", interviewResult("status", read.state, {
        summary: "Interview session loaded.",
      }));
    }

    if (command === "playback") {
      if (!input.sessionPath) return error("playback", "MISSING_INTERVIEW_SESSION", "Missing --session <path|dir>.");
      const read = readInterviewState(input.sessionPath, projectRoot);
      if (read.ok === false) return error("playback", "INTERVIEW_SESSION_MISSING", read.error, 1);
      const state = read.state;
      const generated = buildUnderstandingPlayback(state);
      const hasConfirm = cleanCliText(input.confirm).length > 0;
      if (hasConfirm) {
        const now = new Date().toISOString();
        state.playback = {
          ...generated,
          confirmed: true,
          confirmed_by: "user",
          answer: cleanCliText(input.confirm),
          confirmed_at: now,
        };
        const interviewPath = state.interview_path || "";
        if (writeArtifacts) writeJsonFile(interviewPath, state);
        return emit("playback", interviewResult("playback", state, {
          status: "success",
          code: "PLAYBACK_CONFIRMED",
          summary: "Understanding playback confirmed by user.",
          artifacts: writeArtifacts ? [interviewPath] : [],
          outputs: [{ playback: state.playback }],
          runtime_next_actions: [`Create demand artifacts: yolo interview to-demand --session ${interviewPath}`],
        }));
      }
      const confirmInterviewPath = state.interview_path || "";
      return emit("playback", interviewResult("playback", state, {
        status: "ready",
        code: "PLAYBACK_GENERATED",
        summary: "Understanding playback generated. Review it, then confirm with --confirm '<your words>'.",
        artifacts: [],
        outputs: [{ playback: generated }],
        runtime_next_actions: [
          `Confirm understanding: yolo interview playback --session ${confirmInterviewPath} --confirm "<your confirmation>"`,
        ],
      }));
    }

    if (command === "to-demand") {
      if (!input.sessionPath) return error("to-demand", "MISSING_INTERVIEW_SESSION", "Missing --session <path|dir>.");
      const read = readInterviewState(input.sessionPath, projectRoot);
      if (read.ok === false) return error("to-demand", "INTERVIEW_SESSION_MISSING", read.error, 1);
      const stateForDemand = decorateInterviewState(cloneJson(read.state));
      if (stateForDemand.playback?.confirmed !== true) {
        return error("to-demand", "PLAYBACK_UNCONFIRMED", "Understanding playback has not been confirmed by the user. Run playback confirmation before to-demand.", 2);
      }
      if (stateForDemand.coverage?.ready_for_prd_intake !== true) {
        const blockers = stateForDemand.coverage?.readiness?.blockers || [];
        const nextSlot = stateForDemand.next_question?.id || blockers[0]?.slot || "target_users";
        const nextActions = [
          `Missing demand fields/approvals: ${blockers.map((blocker) => blocker.slot || blocker.code).filter(Boolean).join(", ") || nextSlot}.`,
          `yolo interview answer --session ${stateForDemand.interview_path} --question ${nextSlot} --answer "<answer>"`,
        ];
        const result = interviewResult("to-demand", stateForDemand, {
          status: "blocked",
          code: "INTERVIEW_PRD_INTAKE_BLOCKED",
          summary: "Interview is not ready to create approved demand artifacts.",
          blockers,
          next_actions: nextActions,
          next_action: nextActions[0],
        });
        return emit("to-demand", result, workflowExitCode(result));
      }
      const demandInput = demandInterviewToDemandInput(stateForDemand);
      const demandResult = runDemandApprovedRuntime({
        ...demandInput,
        projectRoot: stateForDemand.projectRoot || stateForDemand.project_root || projectRoot,
        stateRoot: stateForDemand.stateRoot || stateForDemand.state_root || stateRoot,
        writeArtifacts,
      });
      const now = new Date().toISOString();
      const state = decorateInterviewState({
        ...stateForDemand,
        approved: demandInput.approve === true,
        updated_at: now,
        demand: {
          demand_id: demandResult.demand_id,
          demand_dir: demandResult.demand_dir,
          demand_path: demandResult.demand_path || demandResult.artifacts?.find((path) => path.endsWith("session.json")) || null,
          status: demandResult.status,
          readiness: demandResult.readiness,
          artifacts: demandResult.artifacts || [],
        },
      });
      const interviewPath = state.interview_path || "";
      const interviewArtifact = writeArtifacts ? writeJsonFile(interviewPath, state) : null;
      const decisionLedger = writeArtifacts ? writeInterviewDecisionLedger(state, demandResult) : null;
      const artifacts = [
        interviewArtifact,
        decisionLedger,
        ...((demandResult.artifacts as string[] | undefined) || []),
      ].filter((p): p is string => typeof p === "string");
      const blocked = isBlockingWorkflowStatus(demandResult.status);
      const status = demandResult.status === "warning" ? "warning" : blocked ? "blocked" : "success";
      const code = demandResult.status === "warning"
        ? "INTERVIEW_DEMAND_WARNING"
        : blocked
          ? "INTERVIEW_DEMAND_BLOCKED"
          : "INTERVIEW_DEMAND_CREATED";
      const result = interviewResult("to-demand", state, {
        status,
        code,
        summary: blocked
          ? "Approved demand handoff is blocked by missing interview fields or approval."
          : writeArtifacts ? "Approved demand artifacts generated from interview." : "Approved demand artifact preview generated from interview.",
        artifacts,
        outputs: demandResult.outputs || [],
        demand_dir: demandResult.demand_dir,
        demand_path: demandResult.demand_path,
        demand_result: demandResult,
        blockers: demandResult.blockers || [],
        next_action: demandResult.next_action,
        next_actions: demandResult.next_actions || [],
        runtime_next_actions: demandResult.next_actions || [],
      });
      return emit("to-demand", result, workflowExitCode(result));
    }

    return error(command, "UNKNOWN_INTERVIEW_COMMAND", `Unknown interview command: ${command || "(missing)"}`);
  } catch (err) {
    const label = command || "unknown";
    return emit(label, {
      status: "error",
      code: "INTERVIEW_FAILED",
      command: label,
      summary: (err as Error).message,
      next_question: null,
      coverage: null,
      artifacts: [],
      next_actions: ["Inspect the interview session path and retry the command."],
    }, 1);
  }
}
