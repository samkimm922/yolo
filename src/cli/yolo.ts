import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../core/bootstrap.js";
import { formatProjectSetupText, runProjectSetup } from "../core/setup.js";
import { prdSearchDirs, resolvePrdPath } from "../core/paths.js";
import { runYoloDoctorCli } from "../devtools/doctor.js";
import { buildAcceptanceReport, formatAcceptanceReportText } from "../runtime/acceptance/report.js";
import { runYoloBenchmarkCli } from "../eval/benchmark.js";
import { buildDogfoodMatrixReport } from "../release/dogfood-matrix.js";
import { runReleaseCandidateGate } from "../release/decision-gate.js";
import { preflightAllPrds } from "../prd/preflight.js";
import { readReleaseCandidateChangeManifest } from "../release/change-provenance.js";
import { runCleanEnvironmentVerify } from "../release/clean-environment-verify.js";
import { formatYoloCheckText, inferDefaultYoloCheckPrdPath, inspectYoloCheck } from "../runtime/gates/check-report.js";
import { refreshMemoryCenter } from "../runtime/memory/center.js";
import { buildProgressDashboardUiEvidence } from "../runtime/progress/ui-evidence.js";
import { runRunnerRuntime } from "../runtime/runner-runtime.js";
import { runPiRuntime } from "../runtime/pi-runtimes.js";
import { runPiAgent, createPiRunPlan } from "../agents/pi.js";
import { DEFAULT_YOLO_PUBLIC_COMMAND_NAMES, getYoloCommand } from "../workflows/command-registry.js";
import { scanProject } from "../review/scanner.js";
import {
  runDiscoveryPlanRuntime,
  runDiscoveryPrdRuntime,
  runDiscoveryRuntime,
} from "../discovery/runtime.js";
import {
  runDemandBrainstormRuntime,
  runDemandApprovedRuntime,
  runDemandDiscussRuntime,
  runDemandOfficeHoursRuntime,
  runDemandTaskRuntime,
  runDemandPrdRuntime,
  runDemandStatusRuntime,
} from "../demand/runtime.js";
import { runDemandEvidenceDispatchRuntime } from "../demand/evidence-dispatch.js";
import {
  answerDemandInterviewQuestion,
  createDemandInterviewSession,
  demandInterviewToDemandInput,
  inspectDemandInterviewCoverage,
  selectDemandInterviewNextQuestion,
} from "../demand/interview.js";
import { buildUnderstandingPlayback } from "../demand/understanding-playback.js";
import {
  formatLifecycleGuardText,
  inspectLifecycleGuard,
  nextLifecycleAction,
} from "../lifecycle/guard.js";
import { writeLifecycleStageReport } from "../lifecycle/progress.js";
import { writeSourceSnapshot } from "../lifecycle/source-snapshot.js";
import { installAgentBridge } from "../../tools/install-agent-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultYoloRoot = resolve(__dirname, "../..");

export function usage() {
  const publicCommands = DEFAULT_YOLO_PUBLIC_COMMAND_NAMES.map((name) => {
    const command = getYoloCommand(name);
    return `  ${command.usage}\n    下一步执行 ${command.usage}`;
  });
  const publicNames = DEFAULT_YOLO_PUBLIC_COMMAND_NAMES.join("、");
  return [
    "用法:",
    ...publicCommands,
    "",
    "`yolo status` 会读取 .yolo/lifecycle/status.json，告诉 agent 当前唯一安全的下一步。",
    "`yolo demand` 是需求阶段只读/访谈入口，会输出 context_type、route、evidence_policy、missing_slots、blockers、assumptions、needed_evidence_agents、prd_intake_ready、executable_prd_ready 和 next_action。",
    "`yolo demand dispatch` 会把 evidence agent 协议接到实际 agent provider；默认 dry-run，只有同时传 --execute-agents 和 --allow-agent-dispatch 才执行。",
    "`yolo demand --mode office-hours` 是精简 office-hours profile；`yolo office-hours` 仅保留为隐藏兼容 shim。",
    "`yolo spec` 会生成 PRD/spec 产物；只写 spec JSON，不改业务代码。",
    "`yolo tasks` 会生成 discovery/plan/task-breakdown 产物；不改业务代码。",
    "`yolo check` 会在改代码前检查 PRD、产品准备度、UI 验收准备度、任务原子性、adapter 和 evidence plan。",
    "`yolo run` 会走 PI 主线执行 PRD，并在 runner 阶段用 --executor 选择 claude -p、codex exec 或 custom shell agent。",
    "`yolo release` 是 acceptance/ship/release-candidate 的稳定入口，不是 Trello replay；默认 fail closed，只输出可解析 gate contract。",
    `普通 Claude/Codex/GUI 集成只展示 ${DEFAULT_YOLO_PUBLIC_COMMAND_NAMES.length} 个稳定入口：${publicNames}。`,
    "未传 PRD 时，只会在目标项目 .yolo/data/prd/current、.yolo/data/prd/archive 和 .yolo/data 中寻找 PRD JSON。",
  ].join("\n");
}

function cliParseError(name) {
  return Object.assign(new Error(`${name} requires a value.`), {
    name: "YoloCliParseError",
    code: "CLI_PARSE_ERROR",
    flag: name,
    exit_code: 2,
  });
}

function isCliParseError(error) {
  return error?.name === "YoloCliParseError" || error?.code === "CLI_PARSE_ERROR";
}

function cliParseErrorResult(error, command = "yolo") {
  return {
    schema: "yolo.cli.parse_error.v1",
    status: "error",
    code: error.code || "CLI_PARSE_ERROR",
    command,
    flag: error.flag || null,
    summary: error.message || "CLI argument parse error.",
    exit_code: error.exit_code || 2,
    next_actions: error.flag
      ? [`Provide a value for ${error.flag}, or remove that flag.`]
      : ["Fix the CLI arguments and rerun the command."],
  };
}

function emitCliParseError(error, argv = [], io = Object(), command = "yolo") {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const result = cliParseErrorResult(error, command);
  if (argv.includes("--json")) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stderr.write(`${result.summary}\n${result.next_actions.join("\n")}\n`);
  return result.exit_code;
}

function readArgValue(argv, index, name) {
  const arg = argv[index];
  if (arg.includes("=")) {
    const value = arg.split("=").slice(1).join("=");
    if (!value) throw cliParseError(name);
    return { value, consumed: 0 };
  }
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) throw cliParseError(name);
  return { value: next, consumed: 1 };
}

export function parseYoloArgs(argv = process.argv.slice(2)) {
  const input = Object();
  const options = {
    json: false,
    help: false,
    dryRun: false,
    engineOnly: false,
    writeLifecycle: true,
    collectEvidence: false,
    executeAdapter: false,
    allowAdapterCommands: false,
    startProgressServer: undefined,
    runReviewLoop: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--engine-only" || arg === "--runner-only") {
      options.engineOnly = true;
    } else if (arg === "--no-write") {
      options.writeLifecycle = false;
    } else if (arg === "--collect-evidence") {
      options.collectEvidence = true;
    } else if (arg === "--execute-adapter") {
      options.executeAdapter = true;
    } else if (arg === "--allow-adapter-commands") {
      options.allowAdapterCommands = true;
    } else if (arg === "--no-progress-server") {
      options.startProgressServer = false;
    } else if (arg === "--no-review-loop") {
      options.runReviewLoop = false;
    } else if (arg === "--prd" || arg.startsWith("--prd=")) {
      const read = readArgValue(argv, i, "--prd");
      input.prdPath = read.value;
      i += read.consumed;
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const read = readArgValue(argv, i, "--mode");
      input.mode = read.value;
      i += read.consumed;
    } else if (arg === "--executor" || arg.startsWith("--executor=")) {
      const read = readArgValue(argv, i, "--executor");
      input.executor = read.value;
      i += read.consumed;
    } else if (arg === "--provider" || arg.startsWith("--provider=")) {
      const read = readArgValue(argv, i, "--provider");
      input.provider = read.value;
      i += read.consumed;
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      const read = readArgValue(argv, i, "--model");
      input.model = read.value;
      i += read.consumed;
    } else if (arg === "--agent-command" || arg.startsWith("--agent-command=") || arg === "--custom-command" || arg.startsWith("--custom-command=")) {
      const prefix = arg.startsWith("--custom-command") ? "--custom-command" : "--agent-command";
      const read = readArgValue(argv, i, prefix);
      input.agentCommand = read.value;
      i += read.consumed;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && !input.prdPath) {
      input.prdPath = arg;
    }
  }

  input.mode = input.mode || "fix";
  return { input, options };
}

function existingJsonPath(value, cwd = process.cwd()) {
  const text = String(value || "").trim();
  if (!text.endsWith(".json")) return "";
  const absolute = isAbsolute(text) ? text : resolve(cwd, text);
  return existsSync(absolute) ? text : "";
}

export function parseYoloAutoArgs(argv = [], context = Object()) {
  const input = Object();
  const options = {
    json: false,
    help: false,
    dryRun: false,
    writeLifecycle: true,
    collectEvidence: false,
    executeAdapter: false,
    allowAdapterCommands: false,
    startProgressServer: undefined,
    runReviewLoop: undefined,
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--no-write") {
      options.writeLifecycle = false;
    } else if (arg === "--collect-evidence") {
      options.collectEvidence = true;
    } else if (arg === "--execute-adapter") {
      options.executeAdapter = true;
    } else if (arg === "--allow-adapter-commands") {
      options.allowAdapterCommands = true;
    } else if (arg === "--no-progress-server") {
      options.startProgressServer = false;
    } else if (arg === "--no-review-loop") {
      options.runReviewLoop = false;
    } else if (arg === "--prd" || arg.startsWith("--prd=")) {
      const read = readArgValue(argv, i, "--prd");
      input.prdPath = read.value;
      i += read.consumed;
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const read = readArgValue(argv, i, "--mode");
      input.mode = read.value;
      i += read.consumed;
    } else if (arg === "--executor" || arg.startsWith("--executor=")) {
      const read = readArgValue(argv, i, "--executor");
      input.executor = read.value;
      i += read.consumed;
    } else if (arg === "--provider" || arg.startsWith("--provider=")) {
      const read = readArgValue(argv, i, "--provider");
      input.provider = read.value;
      i += read.consumed;
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      const read = readArgValue(argv, i, "--model");
      input.model = read.value;
      i += read.consumed;
    } else if (arg === "--agent-command" || arg.startsWith("--agent-command=") || arg === "--custom-command" || arg.startsWith("--custom-command=")) {
      const prefix = arg.startsWith("--custom-command") ? "--custom-command" : "--agent-command";
      const read = readArgValue(argv, i, prefix);
      input.agentCommand = read.value;
      i += read.consumed;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--")) {
      positionals.push(arg);
    }
  }

  const projectRoot = resolve(input.cwd || context.cwd || process.cwd());
  if (!input.prdPath && positionals.length === 1) {
    const prdPath = existingJsonPath(positionals[0], projectRoot);
    if (prdPath) input.prdPath = prdPath;
  }
  if (!input.prdPath && positionals.length > 0) {
    input.requirement = positionals.join(" ");
    input.objective = input.objective || input.requirement;
  }

  input.mode = input.mode || "fix";
  return { input, options };
}

export function parseYoloInitArgs(argv = []) {
  const input = Object();
  const options = { json: false, help: false, force: false, dryRun: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (arg === "--home-dir" || arg.startsWith("--home-dir=")) {
      const read = readArgValue(argv, i, "--home-dir");
      input.homeDir = read.value;
      i += read.consumed;
    } else if (arg === "--name" || arg.startsWith("--name=")) {
      const read = readArgValue(argv, i, "--name");
      input.projectName = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && !input.cwd) {
      input.cwd = arg;
    }
  }

  return { input, options };
}

export function parseYoloSetupArgs(argv = []) {
  const input = Object();
  const options = {
    json: false,
    help: false,
    force: false,
    dryRun: false,
    target: "both",
    scope: "project",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--target" || arg.startsWith("--target=")) {
      const read = readArgValue(argv, i, "--target");
      options.target = read.value;
      i += read.consumed;
    } else if (arg === "--scope" || arg.startsWith("--scope=")) {
      const read = readArgValue(argv, i, "--scope");
      options.scope = read.value;
      i += read.consumed;
    } else if (arg === "--install-scope" || arg.startsWith("--install-scope=")) {
      const read = readArgValue(argv, i, "--install-scope");
      options.scope = read.value;
      i += read.consumed;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (arg === "--home-dir" || arg.startsWith("--home-dir=")) {
      const read = readArgValue(argv, i, "--home-dir");
      input.homeDir = read.value;
      i += read.consumed;
    } else if (arg === "--name" || arg.startsWith("--name=")) {
      const read = readArgValue(argv, i, "--name");
      input.projectName = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && !input.cwd) {
      input.cwd = arg;
    }
  }

  return { input, options };
}

export function parseYoloMemoryArgs(argv = []) {
  const input = Object();
  const options = Object.assign(Object(), {
    json: false,
    help: false,
    dryRun: false,
    writeLegacyPointers: false,
    applyRetention: true,
    migrateLearning: true,
    pruneGeneratedArchives: true,
  });

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "refresh") {
      continue;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--legacy-pointers") {
      options.writeLegacyPointers = true;
    } else if (arg === "--no-retention") {
      options.applyRetention = false;
    } else if (arg === "--no-learning-migration") {
      options.migrateLearning = false;
    } else if (arg === "--no-prune-generated-archives") {
      options.pruneGeneratedArchives = false;
    } else if (arg.startsWith("--max-")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      const key = arg.replace(/^--/, "").split("=")[0].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = Number(read.value);
      i += read.consumed;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && !input.cwd) {
      input.cwd = arg;
    }
  }

  return { input, options };
}

export function parseYoloReleaseCandidateArgs(argv = []) {
  const input = Object();
  const options = {
    json: false,
    help: false,
    dryRun: false,
    allowUntracked: false,
    allowUnknown: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--allow-untracked" || arg === "--allow-unknown") {
      // Removed: untracked/unknown files must never bypass release provenance checks.
      // These flags are accepted but ignored to avoid breaking existing scripts.
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const read = readArgValue(argv, i, "--mode");
      input.mode = read.value;
      i += read.consumed;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && !input.scope) {
      input.scope = arg;
    }
  }

  input.mode = input.mode || "rc";
  return { input, options };
}

export function parseYoloProgressUiEvidenceArgs(argv = []) {
  const input = Object();
  const options = { json: false, help: false, writeArtifacts: true };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--no-write") {
      options.writeArtifacts = false;
    } else if (arg === "--output" || arg.startsWith("--output=")) {
      const read = readArgValue(argv, i, "--output");
      input.outputPath = read.value;
      i += read.consumed;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && !input.cwd) {
      input.cwd = arg;
    }
  }

  return { input, options };
}

export function parseYoloCheckArgs(argv = []) {
  const input = Object();
  const options = { json: false, help: false, writeLifecycle: true, collectEvidence: false, executeAdapter: false, allowAdapterCommands: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--no-write") {
      options.writeLifecycle = false;
    } else if (arg === "--collect-evidence") {
      options.collectEvidence = true;
    } else if (arg === "--execute-adapter") {
      options.executeAdapter = true;
    } else if (arg === "--allow-adapter-commands") {
      options.allowAdapterCommands = true;
    } else if (arg === "--strict") {
      input.mode = "strict";
      input.strictExecution = true;
    } else if (arg === "--release") {
      input.mode = "release";
      input.strictExecution = true;
    } else if (arg === "--ship") {
      input.mode = "ship";
    } else if (arg === "--verify") {
      input.mode = "verify";
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const read = readArgValue(argv, i, "--mode");
      input.mode = read.value;
      i += read.consumed;
    } else if (arg === "--approval-artifact" || arg.startsWith("--approval-artifact=") || arg === "--approval" || arg.startsWith("--approval=")) {
      const read = readArgValue(argv, i, arg.startsWith("--approval=") ? "--approval" : "--approval-artifact");
      input.approvalArtifact = read.value;
      i += read.consumed;
    } else if (arg === "--run-report" || arg.startsWith("--run-report=") || arg === "--run-report-path" || arg.startsWith("--run-report-path=")) {
      const read = readArgValue(argv, i, arg.startsWith("--run-report-path") ? "--run-report-path" : "--run-report");
      input.runReportPath = read.value;
      i += read.consumed;
    } else if (arg === "--review-report" || arg.startsWith("--review-report=") || arg === "--review-report-path" || arg.startsWith("--review-report-path=")) {
      const read = readArgValue(argv, i, arg.startsWith("--review-report-path") ? "--review-report-path" : "--review-report");
      input.reviewReportPath = read.value;
      i += read.consumed;
    } else if (arg === "--prd" || arg.startsWith("--prd=")) {
      const read = readArgValue(argv, i, "--prd");
      input.prdPath = read.value;
      i += read.consumed;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && !input.prdPath) {
      input.prdPath = arg;
    }
  }

  return { input, options };
}

export function parseYoloAcceptArgs(argv = []) {
  return parseYoloCheckArgs(argv);
}

export function parseYoloInterviewArgs(argv = []) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "";
  const input = Object.assign(Object(), { command, ideaParts: [] });
  const options = { json: false, help: false, writeArtifacts: true };
  const args = command ? argv.slice(1) : argv;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--no-write") {
      options.writeArtifacts = false;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(args, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (arg === "--id" || arg.startsWith("--id=")) {
      const read = readArgValue(args, i, "--id");
      input.id = read.value;
      i += read.consumed;
    } else if (arg === "--title" || arg.startsWith("--title=")) {
      const read = readArgValue(args, i, "--title");
      input.title = read.value;
      i += read.consumed;
    } else if (arg === "--session" || arg.startsWith("--session=")) {
      const read = readArgValue(args, i, "--session");
      input.sessionPath = read.value;
      i += read.consumed;
    } else if (arg === "--question" || arg.startsWith("--question=")) {
      const read = readArgValue(args, i, "--question");
      input.questionId = read.value;
      i += read.consumed;
    } else if (arg === "--answer" || arg.startsWith("--answer=")) {
      const read = readArgValue(args, i, "--answer");
      input.answer = read.value;
      i += read.consumed;
    } else if (arg === "--confirm" || arg.startsWith("--confirm=")) {
      const read = readArgValue(args, i, "--confirm");
      input.confirm = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && command === "start") {
      input.ideaParts.push(arg);
    }
  }

  input.idea = input.ideaParts.join(" ").trim();
  return { input, options };
}

export function parseYoloWorkflowArgs(argv = []) {
  const input = Object.assign(Object(), { objectiveParts: [] });
  const options = {
    json: false,
    help: false,
    writeLifecycle: true,
    executeAgents: false,
    allowAgentDispatch: false,
  };

  function pushList(key, value) {
    if (!input[key]) input[key] = [];
    input[key].push(value);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--no-write") {
      options.writeLifecycle = false;
    } else if (arg === "--execute-agents" || arg === "--execute-agent-dispatch") {
      options.executeAgents = true;
    } else if (arg === "--allow-agent-dispatch") {
      options.allowAgentDispatch = true;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (arg === "--provider" || arg === "--executor" || arg.startsWith("--provider=") || arg.startsWith("--executor=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      input.provider = read.value;
      i += read.consumed;
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const read = readArgValue(argv, i, "--mode");
      input.mode = read.value;
      i += read.consumed;
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      const read = readArgValue(argv, i, "--model");
      input.model = read.value;
      i += read.consumed;
    } else if (arg === "--agent-command" || arg === "--custom-command" || arg.startsWith("--agent-command=") || arg.startsWith("--custom-command=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      input.agentCommand = read.value;
      i += read.consumed;
    } else if (arg === "--timeout-ms" || arg.startsWith("--timeout-ms=")) {
      const read = readArgValue(argv, i, "--timeout-ms");
      input.timeout_ms = read.value;
      i += read.consumed;
    } else if (arg === "--max-budget-usd" || arg.startsWith("--max-budget-usd=")) {
      const read = readArgValue(argv, i, "--max-budget-usd");
      input.max_budget_usd = read.value;
      i += read.consumed;
    } else if (arg === "--agent-tool-profile" || arg === "--tool-profile" || arg.startsWith("--agent-tool-profile=") || arg.startsWith("--tool-profile=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      input.agent_tool_profile = read.value;
      i += read.consumed;
    } else if (arg === "--allow-full-agent-tools") {
      input.allowFullAgentTools = true;
    } else if (arg === "--stage" || arg.startsWith("--stage=")) {
      const read = readArgValue(argv, i, "--stage");
      input.stage = read.value;
      i += read.consumed;
    } else if (arg === "--profile" || arg.startsWith("--profile=")) {
      const read = readArgValue(argv, i, "--profile");
      input.profile = read.value;
      i += read.consumed;
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const read = readArgValue(argv, i, "--mode");
      input.mode = read.value;
      i += read.consumed;
    } else if (arg === "--choice" || arg === "--choose" || arg === "--selection" || arg.startsWith("--choice=") || arg.startsWith("--choose=") || arg.startsWith("--selection=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      input.choice = read.value;
      i += read.consumed;
    } else if (arg === "--boundary-mutation-probe" || arg.startsWith("--boundary-mutation-probe=")) {
      const read = readArgValue(argv, i, "--boundary-mutation-probe");
      input.boundary_mutation_probe = read.value;
      i += read.consumed;
    } else if (arg === "--prd" || arg.startsWith("--prd=")) {
      const read = readArgValue(argv, i, "--prd");
      input.prdPath = read.value;
      i += read.consumed;
    } else if (arg === "--discovery" || arg.startsWith("--discovery=")) {
      const read = readArgValue(argv, i, "--discovery");
      input.discoveryPath = read.value;
      i += read.consumed;
    } else if (arg === "--demand" || arg.startsWith("--demand=")) {
      const read = readArgValue(argv, i, "--demand");
      input.demandPath = read.value;
      i += read.consumed;
    } else if (arg === "--output" || arg.startsWith("--output=")) {
      const read = readArgValue(argv, i, "--output");
      input.outputFile = read.value;
      i += read.consumed;
    } else if (arg === "--approval" || arg.startsWith("--approval=")) {
      const read = readArgValue(argv, i, "--approval");
      input.approval = read.value;
      i += read.consumed;
    } else if (arg === "--id" || arg.startsWith("--id=")) {
      const read = readArgValue(argv, i, "--id");
      input.id = read.value;
      i += read.consumed;
    } else if (arg === "--title" || arg.startsWith("--title=")) {
      const read = readArgValue(argv, i, "--title");
      input.title = read.value;
      i += read.consumed;
    } else if (arg === "--problem" || arg.startsWith("--problem=")) {
      const read = readArgValue(argv, i, "--problem");
      input.problem = read.value;
      i += read.consumed;
    } else if (arg === "--user" || arg === "--users" || arg === "--target-user" || arg.startsWith("--user=") || arg.startsWith("--users=") || arg.startsWith("--target-user=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("target_users", read.value);
      i += read.consumed;
    } else if (arg === "--success" || arg === "--success-criteria" || arg === "--acceptance" || arg.startsWith("--success=") || arg.startsWith("--success-criteria=") || arg.startsWith("--acceptance=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("success_criteria", read.value);
      i += read.consumed;
    } else if (arg === "--constraint" || arg === "--constraints" || arg.startsWith("--constraint=") || arg.startsWith("--constraints=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("constraints", read.value);
      i += read.consumed;
    } else if (arg === "--status-quo" || arg === "--current" || arg.startsWith("--status-quo=") || arg.startsWith("--current=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("status_quo", read.value);
      i += read.consumed;
    } else if (arg === "--evidence" || arg.startsWith("--evidence=")) {
      const read = readArgValue(argv, i, "--evidence");
      pushList("evidence", read.value);
      i += read.consumed;
    } else if (arg === "--assumption" || arg === "--assumptions" || arg.startsWith("--assumption=") || arg.startsWith("--assumptions=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("assumptions", read.value);
      i += read.consumed;
    } else if (arg === "--alternative" || arg === "--alternatives" || arg.startsWith("--alternative=") || arg.startsWith("--alternatives=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("alternatives", read.value);
      i += read.consumed;
    } else if (arg === "--decision" || arg === "--decisions" || arg.startsWith("--decision=") || arg.startsWith("--decisions=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("decisions", read.value);
      i += read.consumed;
    } else if (arg === "--roadmap" || arg === "--mvp" || arg.startsWith("--roadmap=") || arg.startsWith("--mvp=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("roadmap", read.value);
      i += read.consumed;
    } else if (arg === "--non-goal" || arg === "--non-goals" || arg.startsWith("--non-goal=") || arg.startsWith("--non-goals=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("non_goals", read.value);
      i += read.consumed;
    } else if (arg === "--target" || arg === "--file" || arg === "--files" || arg.startsWith("--target=") || arg.startsWith("--file=") || arg.startsWith("--files=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("target_files", read.value);
      i += read.consumed;
    } else if (arg === "--risk" || arg === "--risks" || arg.startsWith("--risk=") || arg.startsWith("--risks=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("risks", read.value);
      i += read.consumed;
    } else if (arg === "--question" || arg === "--open-question" || arg.startsWith("--question=") || arg.startsWith("--open-question=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("open_questions", read.value);
      i += read.consumed;
    } else if (arg === "--research" || arg.startsWith("--research=")) {
      const read = arg.includes("=") ? readArgValue(argv, i, "--research") : { value: "research", consumed: 0 };
      input.research = read.value;
      i += read.consumed;
    } else if (arg === "--lesson" || arg.startsWith("--lesson=")) {
      const read = readArgValue(argv, i, "--lesson");
      input.lesson = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--")) {
      if (!input.prdPath && arg.endsWith(".json")) input.prdPath = arg;
      else input.objectiveParts.push(arg);
    }
  }

  input.objective = input.objectiveParts.join(" ").trim();
  return { input, options };
}

export function findLatestPrd(yoloRoot = defaultYoloRoot) {
  try {
    const files = [];
    for (const dir of prdSearchDirs(yoloRoot)) {
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json") || file === "package.json" || file === "tsconfig.json" || file.startsWith("retry-")) {
          continue;
        }
        const candidate = join(dir, file);
        files.push({ path: candidate, mtime: statSync(candidate).mtimeMs });
      }
    }

    files.sort((a, b) => b.mtime - a.mtime);
    for (const file of files) {
      try {
        const parsed = JSON.parse(readFileSync(file.path, "utf8"));
        if (Array.isArray(parsed.tasks) && parsed.tasks.length > 0 && parsed.tasks[0].id && parsed.tasks[0].priority) {
          return file.path;
        }
      } catch {
        // Ignore invalid JSON files while searching for a runnable PRD.
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function formatRunnerText(result) {
  const lines = [`[yolo] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  if (result.run_id) lines.push(`run_id: ${result.run_id}`);
  if (result.artifacts?.length) lines.push(`artifacts: ${result.artifacts.join(", ")}`);

  for (const key of ["completed", "failed", "skipped", "blocked"]) {
    if (Array.isArray(result[key]) && result[key].length > 0) {
      lines.push(`${key}: ${result[key].join(", ")}`);
    }
  }

  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }

  return lines.join("\n");
}

export function formatWorkflowPlanText(result = Object()) {
  const lines = [`[yolo ${result.workflow}] ${result.status}: ${result.summary}`];
  if (result.plan?.steps?.length) {
    lines.push(`steps: ${result.plan.steps.length}`);
    for (const step of result.plan.steps) {
      lines.push(`  - ${step.id} ${step.verification || "manual"}`);
    }
  }
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatDiscoveryRuntimeText(label, result = Object()) {
  const lines = [`[yolo ${label}] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  if (result.discovery?.id) lines.push(`discovery: ${result.discovery.id}`);
  if (result.plan?.id) lines.push(`plan: ${result.plan.id}`);
  if (result.prd?.id) lines.push(`prd: ${result.prd.id}`);
  if (result.artifacts?.length) lines.push(`artifacts: ${result.artifacts.join(", ")}`);
  if (Array.isArray(result.blockers) && result.blockers.length) {
    lines.push("blockers:");
    for (const blocker of result.blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.detail || ""}`.trimEnd());
  }
  if (Array.isArray(result.warnings) && result.warnings.length) {
    lines.push("warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning.code || "WARNING"} ${warning.message || warning.detail || ""}`.trimEnd());
  }
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatDemandRuntimeText(label, result = Object()) {
  const lines = [`[yolo ${label}] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  if (result.profile) lines.push(`profile: ${result.profile}`);
  if (result.mode) lines.push(`mode: ${result.mode}`);
  if (result.demand_id) lines.push(`demand: ${result.demand_id}`);
  if (result.demand_dir) lines.push(`demand_dir: ${result.demand_dir}`);
  if (result.prd?.id) lines.push(`prd: ${result.prd.id}`);
  if (result.draft_brief?.id) lines.push(`draft_brief: ${result.draft_brief.id}`);
  if (result.next_question?.text) lines.push(`next_question: ${result.next_question.text}`);
  if (result.readiness?.readiness_level) {
    lines.push(`readiness: ${result.readiness.readiness_level} score=${result.readiness.quality_score}`);
  }
  if (result.artifacts?.length) lines.push(`artifacts: ${result.artifacts.join(", ")}`);
  if (Array.isArray(result.blockers) && result.blockers.length) {
    lines.push("blockers:");
    for (const blocker of result.blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.detail || ""}`.trimEnd());
  }
  if (Array.isArray(result.warnings) && result.warnings.length) {
    lines.push("warnings:");
    for (const warning of result.warnings) lines.push(`  - ${warning.code || "WARNING"} ${warning.message || warning.detail || ""}`.trimEnd());
  }
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatDemandStatusText(result = Object()) {
  const state = result.state || {};
  const nextQuestion = result.next_question || state.next_question;
  const lines = [`[yolo demand status] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  if (state.stage) lines.push(`stage: ${state.stage}`);
  lines.push(`context_type: ${state.context_type || result.triage?.context_type || "unknown"}`);
  lines.push(`route: ${state.route || result.triage?.route || "fast"}`);
  lines.push(`evidence_policy: ${state.evidence_policy || result.triage?.evidence_policy || "none"}`);
  lines.push(`reason_codes: ${(state.reason_codes || result.triage?.reason_codes || []).join(", ") || "none"}`);
  lines.push(`prd_intake_ready: ${state.prd_intake_ready === true}`);
  lines.push(`executable_prd_ready: ${state.executable_prd_ready === true}`);
  let printedQuestion = false;
  if (nextQuestion) {
    const label = nextQuestion.slot || nextQuestion.id || nextQuestion.question_id || "next";
    const text = nextQuestion.text || nextQuestion.plain_language_prompt || nextQuestion.message || nextQuestion.question;
    if (text) {
      printedQuestion = true;
      lines.push(`next_question: ${label} ${text}`);
    }
  }
  if (printedQuestion && Array.isArray(state.missing_slots) && state.missing_slots.length) {
    lines.push(`remaining_slots: ${state.missing_slots.length}`);
  } else if (Array.isArray(state.missing_slots) && state.missing_slots.length) {
    lines.push(`missing_slots: ${state.missing_slots.join(", ")}`);
  }
  if (Array.isArray(state.assumptions) && state.assumptions.length) {
    lines.push("assumptions:");
    for (const assumption of state.assumptions) lines.push(`  - ${assumption}`);
  }
  if (!printedQuestion && Array.isArray(state.blockers) && state.blockers.length) {
    lines.push("blockers:");
    for (const blocker of state.blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.slot || ""}`.trimEnd());
  }
  if (!printedQuestion && Array.isArray(state.needed_evidence_agents) && state.needed_evidence_agents.length) {
    lines.push(`needed_evidence_agents: ${state.needed_evidence_agents.join(", ")}`);
  }
  if (state.evidence_requirement_summary?.total > 0) {
    lines.push(`evidence_requirements: pending=${state.evidence_requirement_summary.pending || 0} satisfied=${state.evidence_requirement_summary.satisfied || 0}`);
    for (const item of state.evidence_requirement_summary.pending_items || []) {
      lines.push(`  - ${item.id} ${item.kind}: ${item.topic}`);
    }
  }
  if (Array.isArray(state.next_actions) && state.next_actions.length > 0) {
    lines.push("next_actions:");
    for (const action of state.next_actions) lines.push(`  - ${action}`);
  }
  if (state.next_action) lines.push(`next_action: ${state.next_action}`);
  return lines.join("\n");
}

export function formatDemandDispatchText(result = Object()) {
  const lines = [`[yolo demand dispatch] ${result.status}: ${result.summary}`];
  lines.push(`mode: ${result.mode || "dry_run"}`);
  lines.push(`actions: ${(result.actions || []).map((action) => action.role).join(", ") || "none"}`);
  if (result.code) lines.push(`code: ${result.code}`);
  if (Array.isArray(result.agent_results) && result.agent_results.length) {
    lines.push("agent_results:");
    for (const item of result.agent_results) {
      lines.push(`  - ${item.role || "agent"} ${item.status || "unknown"} ${item.recommendation || ""}`.trimEnd());
    }
  }
  if (result.readiness) {
    lines.push(`prd_intake_ready: ${result.readiness.prd_intake_ready === true}`);
    lines.push(`executable_prd_ready: ${result.readiness.executable_prd_ready === true}`);
    if (Array.isArray(result.readiness.blockers) && result.readiness.blockers.length) {
      lines.push("blockers:");
      for (const blocker of result.readiness.blockers) {
        lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.slot || ""}`.trimEnd());
      }
    }
  }
  if (Array.isArray(result.artifacts) && result.artifacts.length) {
    lines.push(`artifacts: ${result.artifacts.join(", ")}`);
  }
  return lines.join("\n");
}

function cleanCliText(value) {
  return String(value ?? "").trim();
}

function slugForPath(value, fallback = "interview") {
  const slug = cleanCliText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return slug || fallback;
}

function demandIdFromInterview(id) {
  const cleanId = cleanCliText(id);
  if (/^DEMAND-/i.test(cleanId)) return cleanId;
  return `DEMAND-${slugForPath(cleanId, "interview").toUpperCase()}`;
}

function defaultInterviewPath(stateRoot, id) {
  return join(stateRoot, "demand-interviews", id, "interview.json");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableJson(value), "utf8");
  return path;
}

function appendJsonlFile(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return path;
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function resolveInterviewPath(pathOrDir, cwd = process.cwd()) {
  const resolved = resolve(cwd, cleanCliText(pathOrDir));
  if (existsSync(resolved)) {
    try {
      if (statSync(resolved).isDirectory()) return join(resolved, "interview.json");
    } catch {
      return join(resolved, "interview.json");
    }
  }
  return resolved.endsWith(".json") ? resolved : join(resolved, "interview.json");
}

function decorateInterviewState(state = Object()) {
  const questions = Array.isArray(state.questions) ? state.questions : [];
  const coverage = inspectDemandInterviewCoverage({ ...state, questions });
  const next = selectDemandInterviewNextQuestion({ ...state, questions }, coverage);
  return {
    ...state,
    questions,
    status: coverage.ready_for_prd_intake ? "complete" : "in_progress",
    readiness: coverage.readiness,
    next_question: next ? {
      id: next.id,
      question_id: next.question_id || next.id,
      slot: next.slot,
      text: next.plain_language_prompt || next.text || next.id,
      category: next.category,
      why_it_matters: next.why_it_matters,
      follow_up: next.follow_up === true,
      follow_up_id: next.follow_up_id,
      follow_up_code: next.follow_up_code,
      follow_up_reason: next.follow_up_reason,
      original_prompt: next.original_prompt,
    } : null,
    coverage,
  };
}

function createInterviewState(input = Object(), projectRoot, stateRoot) {
  const session = createDemandInterviewSession({
    projectRoot,
    stateRoot,
    id: input.id,
    demand_id: input.id ? demandIdFromInterview(input.id) : undefined,
    title: input.title,
    idea: input.idea || input.title,
    source: "yolo-interview",
  });
  return decorateInterviewState({
    ...session,
    interview_path: defaultInterviewPath(stateRoot, session.id),
  });
}

function readInterviewState(pathOrDir, cwd = process.cwd()) {
  const path = resolveInterviewPath(pathOrDir, cwd);
  if (!existsSync(path)) {
    return { ok: false, path, error: `Interview session not found: ${path}` };
  }
  try {
    const state = decorateInterviewState({ ...readJsonFile(path), interview_path: path });
    return { ok: true, path, dir: dirname(path), state };
  } catch (error) {
    return { ok: false, path, error: `Interview session JSON parse failed: ${error.message}` };
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function resolveInterviewQuestionId(state = Object(), value) {
  const questions = state.questions || [];
  const clean = cleanCliText(value);
  if (/^\d+$/.test(clean)) return questions[Number(clean) - 1]?.id || clean;
  const qMatch = clean.toUpperCase().match(/^Q0*(\d+)$/);
  if (qMatch) return questions[Number(qMatch[1]) - 1]?.id || clean;
  return questions.find((question) => question.id === clean)?.id
    || questions.find((question) => question.id?.toLowerCase() === clean.toLowerCase())?.id
    || clean;
}

function coverageCounts(coverage = Object(), state = Object()) {
  const answered = Array.isArray(coverage.answered) ? coverage.answered.length : Number(coverage.answered || 0);
  const missing = Array.isArray(coverage.missing) ? coverage.missing.length : 0;
  const total = Array.isArray(state.questions) && state.questions.length
    ? state.questions.length
    : answered + missing;
  return {
    answered,
    total,
    percent: total > 0 ? Math.round((answered / total) * 100) : 100,
  };
}

function coverageForCli(coverage = Object(), state = Object()) {
  const counts = coverageCounts(coverage, state);
  return {
    ...coverage,
    answered_questions: coverage.answered || [],
    missing: (coverage.missing || []).map((item) => ({
      id: item.question_id || item.id,
      slot: item.slot,
      text: item.plain_language_prompt || item.text || item.slot,
      category: item.category,
    })),
    answered: counts.answered,
    total: counts.total,
    percent: counts.percent,
    complete: coverage.ready_for_prd_intake === true,
  };
}

function writeInterviewAnswerLedger(state = Object(), question = Object(), answer = "") {
  const stateRoot = state.stateRoot || state.state_root;
  if (!stateRoot) return null;
  return appendJsonlFile(join(stateRoot, "state", "questions.jsonl"), {
    ts: new Date().toISOString(),
    type: "demand_interview_answer",
    source: "yolo-interview",
    interview_id: state.id,
    demand_id: state.demand_id,
    question_id: question.id,
    slot: question.slot,
    category: question.category,
    question: question.plain_language_prompt || question.text || question.id,
    answer,
  });
}

function writeInterviewDecisionLedger(state = Object(), demandResult = Object()) {
  const stateRoot = state.stateRoot || state.state_root;
  if (!stateRoot) return null;
  return appendJsonlFile(join(stateRoot, "state", "decisions.jsonl"), {
    ts: new Date().toISOString(),
    type: "demand_interview_to_demand",
    source: "yolo-interview",
    interview_id: state.id,
    demand_id: demandResult.demand_id || state.demand_id,
    approved: state.coverage?.approval?.approved === true,
    demand_dir: demandResult.demand_dir,
    readiness_level: demandResult.readiness?.readiness_level,
  });
}

function interviewNextActions(state = Object(), extra = Object()) {
  const path = state.interview_path;
  const actions = [];
  if (state.next_question) {
    actions.push(`Answer ${state.next_question.id}: yolo interview answer --session ${path} --question ${state.next_question.id} --answer "<answer>"`);
    actions.push(`Check progress: yolo interview status --session ${path}`);
    return actions;
  }
  if (state.playback?.confirmed !== true) {
    actions.push(`Confirm understanding: yolo interview playback --session ${path}`);
    if (!extra.demand_dir) actions.push(`Then create demand artifacts: yolo interview to-demand --session ${path}`);
    return actions;
  }
  if (!extra.demand_dir) actions.push(`Create demand artifacts: yolo interview to-demand --session ${path}`);
  if (extra.demand_dir) {
    actions.push(`yolo spec --demand ${extra.demand_path || extra.demand_dir}`);
  }
  for (const action of extra.runtime_next_actions || []) {
    if (actions.length >= 3) break;
    if (!actions.includes(action)) actions.push(action);
  }
  return actions;
}

function interviewResult(command, state = Object(), extra = Object()) {
  const decorated = decorateInterviewState(state);
  const result = Object.assign(Object(), {
    status: extra.status || "success",
    code: extra.code || "INTERVIEW_OK",
    command,
    summary: extra.summary || "Interview state updated.",
    session_path: decorated.interview_path,
    interview: decorated,
    next_question: decorated.next_question,
    coverage: coverageForCli(decorated.coverage, decorated),
    coverage_detail: decorated.coverage,
    artifacts: extra.artifacts || [],
    outputs: extra.outputs || [],
    demand_dir: extra.demand_dir,
    demand_path: extra.demand_path,
    demand_result: extra.demand_result,
  });
  result.next_actions = extra.next_actions || interviewNextActions(decorated, extra);
  result.next_action = extra.next_action || result.next_actions?.[0] || null;
  if (extra.blockers) result.blockers = extra.blockers;
  return result;
}

function formatInterviewText(label, result = Object()) {
  const lines = [`[yolo interview ${label}] ${result.status}: ${result.summary}`];
  if (result.session_path) lines.push(`session: ${result.session_path}`);
  if (result.demand_dir) lines.push(`demand_dir: ${result.demand_dir}`);
  if (result.demand_path) lines.push(`demand_path: ${result.demand_path}`);
  if (result.next_question) lines.push(`next_question: ${result.next_question.id} ${result.next_question.text}`);
  else lines.push("next_question: none");
  if (result.coverage) {
    const counts = coverageCounts(result.coverage, result.interview);
    lines.push(`coverage: ${counts.answered}/${counts.total} (${counts.percent}%)`);
    const answerQualityScore = result.coverage.answer_quality_score
      ?? result.coverage.quality?.score
      ?? result.coverage_detail?.quality?.score
      ?? result.coverage_detail?.readiness?.answer_quality_score;
    if (answerQualityScore != null) {
      lines.push(`answer_quality: ${answerQualityScore}`);
    }
  }
  const followUps = result.coverage_detail?.follow_up_questions || result.coverage?.follow_up_questions || [];
  if (followUps.length) {
    lines.push("follow_up:");
    for (const followUp of followUps.slice(0, 3)) {
      lines.push(`  - ${followUp.slot || followUp.question_id}: ${followUp.plain_language_prompt || followUp.text || followUp.message}`);
    }
  }
  if (Array.isArray(result.blockers) && result.blockers.length) {
    lines.push("blockers:");
    for (const blocker of result.blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || blocker.slot || ""}`.trimEnd());
  }
  if (result.artifacts?.length) lines.push(`artifacts: ${result.artifacts.join(", ")}`);
  if (result.next_actions?.length) {
    lines.push("next_actions:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

function artifactList(artifacts) {
  if (Array.isArray(artifacts)) return artifacts.filter(Boolean);
  return Object.entries(artifacts || {})
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}: ${value}`);
}

export function formatPiRuntimeText(label, result = Object()) {
  const lines = [`[yolo ${label}] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  const artifacts = artifactList(result.artifacts);
  if (artifacts.length) lines.push(`artifacts: ${artifacts.join(", ")}`);
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

function emitLifecycleGuard(result = Object(), options = Object(), io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else (result.status === "blocked" || result.status === "error" ? stderr : stdout).write(`${formatLifecycleGuardText(result)}\n`);
  return result.status === "blocked" || result.status === "error" ? 2 : 0;
}

function inspectCliGuard(command, input = Object(), options = Object(), projectRoot) {
  return inspectLifecycleGuard({
    ...input,
    command,
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
  }, options);
}

function guardBlocked(command, input = Object(), options = Object(), projectRoot, io = Object()) {
  const guard = inspectCliGuard(command, input, options, projectRoot);
  if (guard.status !== "pass") return emitLifecycleGuard(guard, options, io);
  return 0;
}

export function formatYoloNextText(result = Object()) {
  const lines = [`[yolo next] ${result.status}: ${result.summary}`];
  if (result.current_stage) lines.push(`current_stage: ${result.current_stage}`);
  if (result.recommended_command) lines.push(`recommended: ${result.recommended_command}`);
  if (result.reason) lines.push(`reason: ${result.reason}`);
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatInitText(result) {
  const lines = [`[yolo init] ${result.status}: ${result.summary}`, `root: ${result.project_root}`];
  for (const [label, values] of [
    ["created", result.created],
    ["overwritten", result.overwritten],
    ["skipped", result.skipped],
  ]) {
    if (values?.length) {
      lines.push(`${label}:`);
      for (const value of values) lines.push(`  - ${value}`);
    }
  }
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatSetupText(result = Object()) {
  return formatProjectSetupText(result);
}

export function formatInstallText(result = Object()) {
  const changed = (result.written?.length || 0) + (result.overwritten?.length || 0);
  const lines = [
    `[yolo install] ${result.status}: ${result.dry_run ? "planned YOLO agent bridge install" : "installed YOLO agent bridge"}`,
    `root: ${result.project_root}`,
    `targets: ${(result.targets || []).join(",") || "none"}`,
    `scopes: ${(result.scopes || []).join(",") || "none"}`,
    `changed: ${changed}`,
    `planned: ${result.planned?.length || 0}`,
    `skipped: ${result.skipped?.length || 0}`,
  ];
  if (result.total_file_count != null) lines.push(`total files: ${result.total_file_count}`);
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function formatMemoryText(result) {
  const lines = [`[yolo memory] ${result.status}: refreshed ${result.written?.length || 0} docs`, `memory: ${result.memory_dir}`];
  if (result.audit_summary) {
    lines.push(`audited: ${result.audit_summary.document_count} docs/jsonl`);
    lines.push(`delete candidates: ${result.audit_summary.deletion_candidate_count}`);
    lines.push(`stale mirrors: ${result.audit_summary.stale_mirror_count}`);
  }
  if (result.retention) {
    lines.push(`archived records: ${result.retention.archived_record_count}`);
    lines.push(`pruned generated snapshots: ${result.retention.pruned_generated_archives?.deleted_count || 0}`);
  }
  if (result.learning_migration) {
    lines.push(`learning records: ${result.learning_migration.total_count}`);
  }
  return lines.join("\n");
}

export const RELEASE_CANDIDATE_RESULT_SCHEMA = "yolo.release_candidate_cli_result.v1";
export const RELEASE_CANDIDATE_REQUIRED_GATES = [
  {
    id: "verify",
    label: "verify",
    required: true,
    status: "pending",
    command: "npm run verify",
    description: "Run the project verify suite before any release claim.",
  },
  {
    id: "prd-preflight",
    label: "prd preflight",
    required: true,
    status: "pending",
    command: "npm run preflight",
    description: "Run PRD dependency and contract preflight.",
  },
  {
    id: "clean-env",
    label: "clean env",
    required: true,
    status: "pending",
    description: "Prove the candidate in a clean environment or clean clone.",
  },
  {
    id: "dogfood-matrix",
    label: "dogfood matrix",
    required: true,
    status: "pending",
    description: "Run the required dogfood matrix and capture evidence.",
  },
  {
    id: "change-provenance",
    label: "change provenance",
    required: true,
    status: "pending",
    description: "Account for release-relevant changes and artifact provenance.",
  },
];

const RELEASE_CANDIDATE_REPORT_BY_GATE = {
  verify: "verify",
  "prd-preflight": "prdPreflight",
  "clean-env": "cleanEnvironment",
  "dogfood-matrix": "dogfoodMatrix",
  "change-provenance": "changeManifest",
};

function cloneReleaseCandidateGates() {
  return RELEASE_CANDIDATE_REQUIRED_GATES.map((gate) => ({ ...gate }));
}

function normalizeReleaseCandidateStatus(status) {
  const normalized = cleanCliText(status).toLowerCase();
  if (normalized === "pass" || normalized === "success") return "pass";
  if (["warning", "draft", "dry_run", "not_run", "indeterminate", "ready", "ready_for_operator"].includes(normalized)) return normalized;
  if (normalized === "error" || normalized === "failed") return "error";
  return "blocked";
}

function releaseCandidateExitCode(result = Object()) {
  const status = normalizeReleaseCandidateStatus(result.status);
  if (status === "pass") return 0;
  if (["warning", "draft", "dry_run", "not_run", "indeterminate", "ready", "ready_for_operator"].includes(status)) return 2;
  return 1;
}

function releaseCandidateBaseResult({ command, input = Object(), options = Object(), projectRoot }) {
  return {
    schema: RELEASE_CANDIDATE_RESULT_SCHEMA,
    status: "blocked",
    code: "RELEASE_CANDIDATE_GATE_NOT_EXECUTED",
    command,
    mode: input.mode || "rc",
    dry_run: options.dryRun === true,
    fail_closed: true,
    project_root: projectRoot,
    scope: input.scope || "workspace",
    allowances: {
      untracked: options.allowUntracked === true,
      unknown: options.allowUnknown === true,
    },
    gate_kind: "generic_rc_gate",
    not_trello_replay: true,
    summary: "Generic release-candidate gate contract is exposed, but no concrete gate runner was provided.",
    gates: cloneReleaseCandidateGates(),
    blockers: [{
      code: "RELEASE_CANDIDATE_RUNNER_MISSING",
      message: "No releaseCandidateRunner was injected, so the command fails closed instead of claiming RC readiness.",
    }],
    next_actions: [
      "Run the generic RC gate; do not use Trello replay as the next release step.",
      "Provide a releaseCandidateRunner implementation that executes verify, PRD preflight, package smoke, clean env, dogfood matrix, change provenance, and review findings.",
    ],
  };
}

function releaseCandidateReport(report = Object()) {
  const { status = "blocked", source, blockerCode, blockerMessage, blockers = [], warnings = [], approvals = [], ...extra } = report;
  const normalizedBlockers = blockerCode
    ? [{ code: blockerCode, message: blockerMessage || blockerCode }, ...blockers]
    : blockers;
  return {
    status,
    provenance: { source, id: `${source}-local` },
    blockers: normalizedBlockers,
    warnings,
    approvals,
    ...extra,
  };
}

export function buildDefaultReleaseCandidateReports(input = Object()) {
  const yoloRoot = resolve(input.yoloRoot || input.yolo_root || input.projectRoot || process.cwd());
  const projectRoot = resolve(input.projectRoot || yoloRoot);

  // verify: actually run npm run verify in the project root
  let verifyReport;
  try {
    const startedAt = new Date().toISOString();
    execSync("npm run verify", {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 300000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    verifyReport = releaseCandidateReport({
      status: "pass",
      source: "verify",
      commands: [{ command: "npm run verify", exit_code: 0, status: "pass", started_at: startedAt, finished_at: new Date().toISOString() }],
    });
  } catch (err) {
    verifyReport = releaseCandidateReport({
      source: "verify",
      blockerCode: "RELEASE_VERIFY_FAILED",
      blockerMessage: `npm run verify failed: ${err.message || err}`,
      commands: [{ command: "npm run verify", exit_code: err.status || 1, status: "fail" }],
    });
  }

  // prdPreflight: actually run PRD preflight
  let prdPreflightReport;
  try {
    const prdDirs = [resolve(projectRoot, "data/prd/current"), resolve(projectRoot, "data/prd/archive")];
    const preflight = preflightAllPrds({ dirs: prdDirs });
    const pfStatus = preflight.status === "pass" ? "pass" : "block";
    prdPreflightReport = releaseCandidateReport({
      status: pfStatus,
      source: "prd-preflight",
      commands: [{ command: "preflightAllPrds", exit_code: pfStatus === "pass" ? 0 : 1, status: pfStatus }],
      blocked_reasons: preflight.blocked_reasons || [],
      results: preflight.results || [],
      file_count: preflight.file_count,
    });
  } catch (err) {
    prdPreflightReport = releaseCandidateReport({
      source: "prd-preflight",
      blockerCode: "RELEASE_PRD_PREFLIGHT_FAILED",
      blockerMessage: `PRD preflight failed: ${err.message || err}`,
    });
  }

  const cleanEnvironment = runCleanEnvironmentVerify({ yoloRoot, dryRun: true });
  const dogfoodMatrix = buildDogfoodMatrixReport({ yoloRoot, projectRoot });
  const changeManifest = readReleaseCandidateChangeManifest({
    rootDir: yoloRoot,
    allowUntracked: input.allowUntracked === true,
    allowUnknown: input.allowUnknown === true,
    currentRoundFiles: input.currentRoundFiles || null,
  });

  return {
    verify: verifyReport,
    prdPreflight: prdPreflightReport,
    cleanEnvironment: releaseCandidateReport({
      source: "clean-environment",
      blockerCode: "RELEASE_CLEAN_ENVIRONMENT_NOT_EXECUTED",
      blockerMessage: "Clean environment verification must execute before release readiness can pass; dry-run only produced a plan.",
      plan: cleanEnvironment.plan,
      dry_run: cleanEnvironment,
    }),
    dogfoodMatrix: releaseCandidateReport({
      source: "dogfood-matrix",
      status: dogfoodMatrix.status,
      blockers: dogfoodMatrix.blocked_reasons || [],
      warnings: dogfoodMatrix.warnings || [],
      scenarios: dogfoodMatrix.scenarios || [],
      report: dogfoodMatrix,
    }),
    changeManifest: releaseCandidateReport({
      source: "change-manifest",
      status: changeManifest.status,
      blockers: changeManifest.blockers || [],
      warnings: changeManifest.contains_possible_non_round_changes ? [{
        code: "CHANGE_MANIFEST_POSSIBLE_NON_ROUND_CHANGES",
        message: "Change manifest contains files not bound to the current release-candidate round.",
      }] : [],
      manifest: changeManifest,
    }),
  };
}

export async function runDefaultReleaseCandidateRunner(input = Object()) {
  const yoloRoot = resolve(input.yoloRoot || input.yolo_root || input.projectRoot || process.cwd());
  const projectRoot = resolve(input.projectRoot || yoloRoot);
  const reports = input.reports || buildDefaultReleaseCandidateReports({
    yoloRoot,
    projectRoot,
    allowUntracked: input.allowUntracked,
    allowUnknown: input.allowUnknown,
    currentRoundFiles: input.currentRoundFiles,
  });
  const gate = runReleaseCandidateGate({
    mode: input.mode || "rc",
    reports,
    now: input.now,
  });
  const gateReports = gate.reports || {};
  const gates = (input.requiredGates || cloneReleaseCandidateGates()).map((gateItem) => {
    const reportName = RELEASE_CANDIDATE_REPORT_BY_GATE[gateItem.id];
    const report = reportName ? gateReports[reportName] : null;
    return {
      ...gateItem,
      status: report?.status || "blocked",
      blocker_count: report?.blocker_count ?? 0,
      warning_count: report?.warning_count ?? 0,
    };
  });
  const status = normalizeReleaseCandidateStatus(gate.status);
  return {
    schema: RELEASE_CANDIDATE_RESULT_SCHEMA,
    status,
    code: status === "pass" ? "RELEASE_CANDIDATE_GATE_PASS" : "RELEASE_CANDIDATE_GATE_BLOCKED",
    command: input.command || "release-candidate",
    mode: input.mode || "rc",
    dry_run: input.dryRun === true,
    fail_closed: true,
    yolo_root: yoloRoot,
    project_root: projectRoot,
    scope: input.scope || "workspace",
    allowances: {
      untracked: input.allowUntracked === true,
      unknown: input.allowUnknown === true,
    },
    gate_kind: "generic_rc_gate",
    not_trello_replay: true,
    summary: status === "pass"
      ? "Generic release-candidate gate passed."
      : "Generic release-candidate gate blocked missing, failed, or untrusted release evidence.",
    gates,
    blockers: gate.blockers || [],
    warnings: gate.warnings || [],
    issue_codes: gate.issue_codes || [],
    reports: gate.reports || {},
    gate_result: gate,
    next_actions: status === "pass"
      ? ["Proceed to human release authorization; publishing remains a separate controlled operation."]
      : ["Provide passing evidence for verify, PRD preflight, package smoke, clean env, dogfood matrix, change provenance, and review findings."],
  };
}

function normalizeReleaseCandidateResult(raw = Object(), context = Object()) {
  const base = releaseCandidateBaseResult(context);
  const merged = {
    ...base,
    ...raw,
    schema: raw.schema || base.schema,
    command: raw.command || base.command,
    mode: raw.mode || base.mode,
    dry_run: raw.dry_run ?? base.dry_run,
    fail_closed: true,
    project_root: raw.project_root || base.project_root,
    allowances: raw.allowances || base.allowances,
    gate_kind: raw.gate_kind || base.gate_kind,
    not_trello_replay: raw.not_trello_replay ?? true,
    gates: Array.isArray(raw.gates) ? raw.gates : base.gates,
    blockers: Array.isArray(raw.blockers) ? raw.blockers : base.blockers,
    next_actions: Array.isArray(raw.next_actions) ? raw.next_actions : base.next_actions,
  };
  merged.status = normalizeReleaseCandidateStatus(merged.status);
  const consistencyBlockers = merged.status === "pass"
    ? releaseCandidateConsistencyBlockers(merged)
    : [];
  if (consistencyBlockers.length > 0) {
    merged.status = "blocked";
    merged.code = "RELEASE_CANDIDATE_RESULT_INCONSISTENT";
    merged.blockers = [
      ...merged.blockers,
      ...consistencyBlockers.filter((blocker) =>
        !merged.blockers.some((existing) => existing.code === blocker.code)
      ),
    ];
    merged.issue_codes = [...new Set([
      ...(Array.isArray(merged.issue_codes) ? merged.issue_codes : []),
      ...merged.blockers.map((blocker) => blocker.code).filter(Boolean),
    ])];
    merged.summary = "Release candidate runner returned an internally inconsistent pass result.";
    merged.next_actions = [
      "Fix the release candidate runner so blockers, gates, dry-run state, and aggregate gate_result agree before claiming pass.",
    ];
  }
  return merged;
}

function releaseCandidateErrorResult(error, context = Object(), code = "RELEASE_CANDIDATE_GATE_ERROR") {
  const base = releaseCandidateBaseResult(context);
  return {
    ...base,
    status: "error",
    code,
    summary: "Generic release-candidate gate failed before producing a passable result.",
    error: error?.message || String(error),
    blockers: [{
      code,
      message: error?.message || String(error),
    }],
    next_actions: ["Inspect the RC gate runner error, fix the failing contract, then rerun yolo release-candidate --json."],
  };
}

function releaseCandidateConsistencyBlockers(result = Object()) {
  const blockers = [];
  if (Array.isArray(result.blockers) && result.blockers.length > 0) {
    blockers.push({
      code: "RELEASE_CANDIDATE_BLOCKERS_PRESENT",
      message: "release candidate runner cannot pass while blockers are present",
    });
  }
  if (result.dry_run === true) {
    blockers.push({
      code: "RELEASE_CANDIDATE_DRY_RUN_RESULT",
      message: "dry-run release candidate output cannot be promoted as passing release evidence",
    });
  }
  const requiredGates = Array.isArray(result.gates)
    ? result.gates.filter((gate) => gate.required !== false)
    : [];
  const nonPassingGate = requiredGates.find((gate) => normalizeReleaseCandidateStatus(gate.status) !== "pass");
  if (requiredGates.length === 0 || nonPassingGate) {
    blockers.push({
      code: "RELEASE_CANDIDATE_GATE_NOT_PASSING",
      message: "every required release candidate gate must be present and passing",
      gate_id: nonPassingGate?.id || null,
      gate_status: nonPassingGate?.status || null,
    });
  }
  const gateResult = result.gate_result || result.gateResult;
  if (!gateResult || typeof gateResult !== "object") {
    blockers.push({
      code: "RELEASE_CANDIDATE_GATE_RESULT_MISSING",
      message: "passing release candidate results must include the aggregate release candidate gate_result",
    });
  } else if (
    gateResult.schema !== "yolo.release.release_candidate_gate_result.v1"
    || normalizeReleaseCandidateStatus(gateResult.status) !== "pass"
    || (Array.isArray(gateResult.blockers) && gateResult.blockers.length > 0)
  ) {
    blockers.push({
      code: "RELEASE_CANDIDATE_GATE_RESULT_NOT_PASSING",
      message: "aggregate release candidate gate_result must be schema-valid, passing, and blocker-free",
      gate_result_status: gateResult.status || null,
    });
  }
  return blockers;
}

export function formatReleaseCandidateText(result = Object()) {
  const lines = [`[yolo ${result.command || "release-candidate"}] ${result.status}: ${result.summary}`];
  lines.push(`mode: ${result.mode || "rc"}`);
  lines.push(`gate: ${result.gate_kind || "generic_rc_gate"} (not Trello replay)`);
  lines.push(`fail_closed: ${result.fail_closed === true}`);
  lines.push(`allow_untracked: ${result.allowances?.untracked === true}`);
  lines.push(`allow_unknown: ${result.allowances?.unknown === true}`);
  if (Array.isArray(result.gates) && result.gates.length) {
    lines.push("gates:");
    for (const gate of result.gates) lines.push(`  - ${gate.id} ${gate.status || "pending"}`);
  }
  if (Array.isArray(result.blockers) && result.blockers.length) {
    lines.push("blockers:");
    for (const blocker of result.blockers) lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || ""}`.trimEnd());
  }
  if (Array.isArray(result.issue_codes) && result.issue_codes.length) {
    lines.push(`issue_codes: ${result.issue_codes.join(", ")}`);
  }
  if (Array.isArray(result.next_actions) && result.next_actions.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

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

export async function runYoloReleaseCandidateCli(argv = [], io = Object()) {
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

  function emit(result) {
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
    : inferDefaultYoloCheckPrdPath({ projectRoot, stateRoot: join(projectRoot, ".yolo") });
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
  if (options.writeLifecycle && report.status !== "error") {
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
    allowed_commands: guard.allowed_commands || [],
    guard,
    next_actions: [`Run ${next.command}: ${next.description}.`],
  };
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatYoloNextText(result)}\n`);
  return 0;
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

export async function runYoloInterviewCli(argv = [], io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { input, options } = parseYoloInterviewArgs(argv);
  const command = input.command;

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  function emit(label, result, exitCode = 0) {
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else (result.status === "error" ? stderr : stdout).write(`${formatInterviewText(label, result)}\n`);
    return exitCode;
  }

  function error(label, code, summary, exitCode = 2) {
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
    const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
    const stateRoot = join(projectRoot, ".yolo");
    const writeArtifacts = options.writeArtifacts !== false;

    if (command === "start") {
      const state = createInterviewState(input, projectRoot, stateRoot);
      const artifacts = writeArtifacts ? [writeJsonFile(state.interview_path, state)] : [];
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
      if (!read.ok) return error("answer", "INTERVIEW_SESSION_MISSING", read.error, 1);
      const questionId = resolveInterviewQuestionId(read.state, input.questionId);
      const question = (read.state.questions || []).find((item) => item.id === questionId);
      if (!question) return error("answer", "INTERVIEW_QUESTION_UNKNOWN", `Question not found: ${input.questionId}`, 1);
      const state = decorateInterviewState(answerDemandInterviewQuestion(cloneJson(read.state), {
        questionId,
        answer: cleanCliText(input.answer),
      }));
      const artifacts = writeArtifacts ? [
        writeJsonFile(state.interview_path, state),
        writeInterviewAnswerLedger(state, question, cleanCliText(input.answer)),
      ].filter(Boolean) : [];
      return emit("answer", interviewResult("answer", state, {
        summary: writeArtifacts ? "Interview answer recorded." : "Interview answer preview generated.",
        artifacts,
        outputs: artifacts.map((artifactPath) => ({ path: artifactPath, type: artifactPath.endsWith(".jsonl") ? "interview_ledger" : "interview_state" })),
      }));
    }

    if (command === "status") {
      if (!input.sessionPath) return error("status", "MISSING_INTERVIEW_SESSION", "Missing --session <path|dir>.");
      const read = readInterviewState(input.sessionPath, projectRoot);
      if (!read.ok) return error("status", "INTERVIEW_SESSION_MISSING", read.error, 1);
      return emit("status", interviewResult("status", read.state, {
        summary: "Interview session loaded.",
      }));
    }

    if (command === "playback") {
      if (!input.sessionPath) return error("playback", "MISSING_INTERVIEW_SESSION", "Missing --session <path|dir>.");
      const read = readInterviewState(input.sessionPath, projectRoot);
      if (!read.ok) return error("playback", "INTERVIEW_SESSION_MISSING", read.error, 1);
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
        if (writeArtifacts) writeJsonFile(state.interview_path, state);
        return emit("playback", interviewResult("playback", state, {
          status: "success",
          code: "PLAYBACK_CONFIRMED",
          summary: "Understanding playback confirmed by user.",
          artifacts: writeArtifacts ? [state.interview_path] : [],
          outputs: [{ playback: state.playback }],
          runtime_next_actions: [`Create demand artifacts: yolo interview to-demand --session ${state.interview_path}`],
        }));
      }
      return emit("playback", interviewResult("playback", state, {
        status: "ready",
        code: "PLAYBACK_GENERATED",
        summary: "Understanding playback generated. Review it, then confirm with --confirm '<your words>'.",
        artifacts: [],
        outputs: [{ playback: generated }],
        runtime_next_actions: [
          `Confirm understanding: yolo interview playback --session ${state.interview_path} --confirm "<your confirmation>"`,
        ],
      }));
    }

    if (command === "to-demand") {
      if (!input.sessionPath) return error("to-demand", "MISSING_INTERVIEW_SESSION", "Missing --session <path|dir>.");
      const read = readInterviewState(input.sessionPath, projectRoot);
      if (!read.ok) return error("to-demand", "INTERVIEW_SESSION_MISSING", read.error, 1);
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
      const interviewArtifact = writeArtifacts ? writeJsonFile(state.interview_path, state) : null;
      const decisionLedger = writeArtifacts ? writeInterviewDecisionLedger(state, demandResult) : null;
      const artifacts = [
        interviewArtifact,
        decisionLedger,
        ...(demandResult.artifacts || []),
      ].filter(Boolean);
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
      summary: err.message,
      next_question: null,
      coverage: null,
      artifacts: [],
      next_actions: ["Inspect the interview session path and retry the command."],
    }, 1);
  }
}

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

function normalizeDemandStage(value = "") {
  const stage = cleanCliText(value).toLowerCase();
  if (!stage) return "";
  if (stage === "discovery") return "discover";
  if (stage === "discussion") return "discuss";
  if (stage === "office" || stage === "office-hours" || stage === "office_hours") return "office-hours";
  if (stage === "evidence-dispatch") return "dispatch";
  return stage;
}

function isBlockingWorkflowStatus(status = "") {
  return ["blocked", "error", "warning", "draft"].includes(cleanCliText(status).toLowerCase());
}

function workflowExitCode(result = Object()) {
  const status = cleanCliText(result.status).toLowerCase();
  if (status === "pass" || status === "success") return 0;
  if (status === "warning" || status === "draft" || status === "dry_run" || status === "not_run" || status === "indeterminate" || status === "ready" || status === "ready_for_operator") return 2;
  return isBlockingWorkflowStatus(status) ? 1 : 1;
}

async function runYoloDemandStageCli(stage, input = Object(), options = Object(), io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
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
    if (input.objective) interviewArgs.push(input.objective);
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

  const stage = normalizeDemandStage(input.stage);
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
  else stdout.write(`${formatDemandStatusText(result)}\n`);
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

export async function runYoloAcceptCli(argv = [], io = Object()) {
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

export async function runYoloDiscoverCli(argv = [], io = Object()) {
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

export async function runYoloPlanCli(argv = [], io = Object()) {
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

export async function runYoloPrdCli(argv = [], io = Object()) {
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

export async function runYoloWorkflowPlanCli(workflow, argv = [], io = Object()) {
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

const REVIEW_SCOPE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

function splitCliListValues(values = []) {
  return values
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function projectRelativePath(projectRoot, path) {
  const rel = relative(projectRoot, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replaceAll("\\", "/") : path;
}

function looksLikeReviewScope(value, projectRoot) {
  const clean = cleanCliText(value);
  if (!clean) return false;
  if (existsSync(resolve(projectRoot, clean))) return true;
  return /(^\.{1,2}[\\/]|[\\/]|\.([cm]?[jt]sx?|json|md|css|scss|html)$)/i.test(clean);
}

function collectReviewScopeFiles(projectRoot, path) {
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
  if (!existsSync(absolutePath)) return [projectRelativePath(projectRoot, absolutePath)];

  const stat = statSync(absolutePath);
  if (stat.isFile()) return [projectRelativePath(projectRoot, absolutePath)];
  if (!stat.isDirectory()) return [];

  const files = [];
  for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const child = join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectReviewScopeFiles(projectRoot, child));
    } else if (REVIEW_SCOPE_EXTENSIONS.has(entry.name.match(/\.[^.]+$/)?.[0] || "")) {
      files.push(projectRelativePath(projectRoot, child));
    }
  }
  return files;
}

function reviewScopeFilesFromInput(input = Object(), projectRoot) {
  const explicit = splitCliListValues(input.target_files || []);
  const positional = (input.objectiveParts || []).filter((part) => looksLikeReviewScope(part, projectRoot));
  const seen = new Set();
  const files = [];
  for (const item of [...explicit, ...positional]) {
    for (const file of collectReviewScopeFiles(projectRoot, item)) {
      if (seen.has(file)) continue;
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

function buildScopedReviewScanReport({ scan, projectRoot, stateRoot, reviewScopeFiles, writeLifecycle }) {
  const hasHigh = scan.findings.some((finding) =>
    finding.severity === "HIGH" || finding.severity === "CRITICAL" || finding.must_fix_before_ship === true
  );
  const report = Object.assign(Object(), {
    status: hasHigh ? "warning" : "success",
    summary: `Review scan found ${scan.total_findings} finding(s).`,
    project_root: projectRoot,
    review_scope: reviewScopeFiles,
    artifacts: [],
    next_actions: hasHigh ? ["Review HIGH/CRITICAL findings before shipping."] : [],
    scan,
    findings: scan.findings,
  });
  if (writeLifecycle !== false && stateRoot) {
    report.lifecycle_write = writeLifecycleStageReport("review-fix", report, {
      projectRoot,
      stateRoot,
      source: "yolo-review",
      learnFailures: true,
      skipSequenceCheck: true,
    });
    report.artifacts.push(report.lifecycle_write.artifact_path);
  }
  return report;
}

export async function runYoloReviewCli(argv = [], io = Object()) {
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

export async function runYoloShipCli(argv = [], io = Object()) {
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

export async function runYoloLearnCli(argv = [], io = Object()) {
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

export async function runYoloReleaseCli(argv = [], io = Object()) {
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

export async function runYoloAutoCli(argv = [], io = Object()) {
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

export const KNOWN_YOLO_COMMAND_WORDS = new Set([
  ...DEFAULT_YOLO_PUBLIC_COMMAND_NAMES,
  "status", "demand", "auto", "ship",
  "spec", "tasks", "run", "runner", "check", "review", "release", "init", "setup", "install", "doctor", "eval",
  "progress-ui-evidence", "memory", "learn",
  "candidate", "gate", "rc", "publish",
  "ui-evidence",
]);

async function runYoloCliInner(argv = process.argv.slice(2), io = Object()) {
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
  if (argv[0] === "office-hours") {
    stderr.write(`yolo office-hours is no longer a standalone command. Use: yolo demand --mode office-hours\n`);
    return 2;
  }
  if (argv[0] === "brainstorm") {
    stderr.write(`yolo brainstorm is no longer a standalone command. Use: yolo demand --stage brainstorm\n`);
    return 2;
  }
  if (argv[0] === "demand") return runYoloDemandCli(argv.slice(1), io);
  if (argv[0] === "interview") return runYoloInterviewCli(argv.slice(1), io);
  if (argv[0] === "discover") {
    stderr.write(`yolo discover is no longer a standalone command. Use: yolo demand --stage discover\n`);
    return 2;
  }
  if (argv[0] === "discuss") {
    stderr.write(`yolo discuss is no longer a standalone command. Use: yolo demand --stage discuss\n`);
    return 2;
  }
  if (argv[0] === "plan") {
    stderr.write(`yolo plan is no longer a standalone command. Use: yolo tasks\n`);
    return 2;
  }
  if (argv[0] === "prd") {
    stderr.write(`yolo prd is no longer a standalone command. Use: yolo spec\n`);
    return 2;
  }
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
    : findLatestPrd(join(cliProjectRoot, ".yolo"));

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
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatRunnerText(result)}\n`);

  return result.exit_code ?? (result.status === "success" ? 0 : 1);
}

export async function runYoloCli(argv = process.argv.slice(2), io = Object()) {
  try {
    return await runYoloCliInner(argv, io);
  } catch (error) {
    if (isCliParseError(error)) return emitCliParseError(error, argv, io, "yolo");
    throw error;
  }
}
