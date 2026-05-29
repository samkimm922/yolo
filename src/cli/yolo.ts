import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../core/bootstrap.js";
import { prdSearchDirs, resolvePrdPath } from "../core/paths.js";
import { runYoloDoctorCli } from "../runtime/devtools/doctor.js";
import { buildAcceptanceReport, formatAcceptanceReportText } from "../runtime/acceptance/report.js";
import { runYoloBenchmarkCli } from "../eval/benchmark.js";
import { formatYoloCheckText, inspectYoloCheck } from "../runtime/gates/check-report.js";
import { refreshMemoryCenter } from "../runtime/memory/center.js";
import { buildProgressDashboardUiEvidence } from "../runtime/progress/ui-evidence.js";
import { runRunnerRuntime } from "../runtime/runner-runtime.js";
import { runPiRuntime } from "../runtime/pi-runtimes.js";
import { runPiAgent } from "../agents/pi.js";
import {
  runDiscoveryPlanRuntime,
  runDiscoveryPrdRuntime,
  runDiscoveryRuntime,
} from "../discovery/runtime.js";
import {
  runDemandBrainstormRuntime,
  runDemandDiscussRuntime,
  runDemandPrdRuntime,
} from "../demand/runtime.js";
import {
  answerDemandInterviewQuestion,
  createDemandInterviewSession,
  demandInterviewToDemandInput,
  inspectDemandInterviewCoverage,
} from "../demand/interview.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultYoloRoot = resolve(__dirname, "../..");

export function usage() {
  return [
    "用法:",
    "  yolo init [path] [--name <name>] [--force] [--dry-run] [--json]",
    "  yolo brainstorm [idea] [--user <user>] [--status-quo <text>] [--evidence <text>] [--json]",
    "  yolo interview start|answer|status|to-demand [options]",
    "  yolo interview start [idea] [--cwd <dir>] [--id <id>] [--title <title>] [--json] [--no-write]",
    "  yolo interview answer --session <path|dir> --question <id> --answer <text> [--json] [--no-write]",
    "  yolo interview status --session <path|dir> [--json]",
    "  yolo interview to-demand --session <path|dir> [--approve] [--json] [--no-write]",
    "  yolo discover [text-or-path] [--success <criteria>] [--target <file>] [--json]",
    "  yolo discuss [idea] [--decision <text>] [--approve] [--json]",
    "  yolo plan [--discovery <discovery.json>] [--json]",
    "  yolo prd [--discovery <discovery.json>|--demand <session.json|dir>] [--output <prd.json>] [--json]",
    "  yolo doctor [path] [--target codex|claude|both] [--scope project|user|both] [--json]",
    "  yolo check <prd.json> [--json] [--no-write]",
    "  yolo review [path] [--json]",
    "  yolo accept <prd.json> [--json] [--no-write] [--collect-evidence] [--execute-adapter] [--allow-adapter-commands]",
    "  yolo ship <prd.json> [--json]",
    "  yolo learn [lesson] [--json]",
    "  yolo run <prd.json> [--json] [--dry-run] [--executor claude|codex|custom|auto] [--model <model>] [--agent-command <cmd>]",
    "  yolo runner <prd.json> [--json] [--dry-run] [--engine-only]",
    "  yolo progress-ui-evidence [path] [--json] [--output <file>] [--no-write]",
    "  yolo eval [--results <benchmark-results.json>] [--baseline <report.json>] [--min-score 80] [--json] [--no-write]",
    "  yolo memory refresh [path] [--dry-run] [--json] [--no-retention] [--no-learning-migration]",
    "  yolo [prd.json] [--mode=dev|fix] [--json]",
    "  yolo --prd <prd.json> [--mode=dev|fix] [--json]",
    "",
    "`yolo init` 会在目标项目生成 .yolo/、.yolo/memory/、.yolo/state/*.jsonl 和 specs/ 基础结构。",
    "`yolo brainstorm/discuss` 会生成需求端 VISION/REFLECTION/INVESTIGATION/REQUIREMENTS/CONTEXT/ROADMAP/APPROVAL 产物，不改业务代码。",
    "`yolo interview` 会用一问一答收集非技术需求，默认状态写入 .yolo/demand-interviews/<id>/interview.json，可转换为 demand session 后继续 prd。",
    "`yolo discover/plan/prd` 会生成 discovery、plan、PRD 产物；discover/plan 不改业务代码，prd 只写 PRD JSON。",
    "`yolo doctor` 会只读检查 .yolo/lifecycle、命令注册表和 Codex/Claude agent 集成状态。",
    "`yolo check` 会在改代码前检查 PRD、产品准备度、UI 验收准备度、任务原子性、adapter 和 evidence plan。",
    "`yolo run` 会走 PI 主线执行 PRD，并在 runner 阶段用 --executor 选择 claude -p、codex exec 或 custom shell agent。",
    "`yolo runner` / `yolo run --engine-only` 是底层 runner 调试入口；普通 Claude/Codex/GUI 集成应使用 `yolo run`。",
    "`yolo progress-ui-evidence` 会生成 progress dashboard 的 UI/UX evidence，可被 yolo run/accept 的 adapter bridge 消费。",
    "`yolo accept` 会在交付前检查功能、运行、review、UI 和证据完整度；需要真实 adapter 采集时显式加 --collect-evidence --execute-adapter --allow-adapter-commands。",
    "`yolo ship` 会基于 acceptance report 给出 ship/no-ship verdict；不会发布。",
    "`yolo learn` 会把一次交付或人工 lesson 写入有界学习账本。",
    "`yolo eval` 会用固定 benchmark fixture 和 rubric 评估 discovery/PRD/UI acceptance/agent command 质量；缺真实结果时 fail closed。",
    "`yolo memory refresh` 会刷新记忆中心，迁移旧学习经验，并先把超限 ledger 归档到 state/archive/jsonl/YYYY-MM/；关键生命周期命令成功写入时会自动刷新项目记忆体。",
    "未传 PRD 时，只会在当前 YOLO state root 的 data/prd/current、data/prd/archive 和 data 中寻找 PRD JSON。",
  ].join("\n");
}

function summarizeMemoryRefresh(result = {}) {
  return {
    status: result.status,
    memory_dir: result.memory_dir,
    written: Array.isArray(result.written) ? result.written.map((item) => item.path || item).filter(Boolean) : [],
    audit_summary: result.audit_summary,
    retention: result.retention ? {
      archived_record_count: result.retention.archived_record_count,
      pruned_generated_snapshots: result.retention.pruned_generated_archives?.deleted_count || 0,
    } : null,
  };
}

function withMemoryRefresh(result = {}, params = {}) {
  const options = params.options || {};
  const projectRoot = params.projectRoot ? resolve(params.projectRoot) : null;
  const writeEnabled = params.write !== false && options.writeLifecycle !== false && options.writeArtifacts !== false;
  const dryRun = options.dryRun === true || options.dry_run === true;
  if (!projectRoot || !writeEnabled || dryRun) return result;
  try {
    const memory = refreshMemoryCenter({
      projectRoot,
      source: params.source || "yolo-cli",
    });
    return {
      ...result,
      memory_refresh: summarizeMemoryRefresh(memory),
    };
  } catch (error) {
    return {
      ...result,
      memory_refresh: {
        status: "warning",
        code: "MEMORY_REFRESH_FAILED",
        error: error.message,
      },
    };
  }
}

function appendMemoryRefreshText(lines, result = {}) {
  if (!result.memory_refresh) return;
  if (result.memory_refresh.status === "ok") {
    lines.push(`memory: refreshed ${result.memory_refresh.written?.length || 0} docs at ${result.memory_refresh.memory_dir}`);
  } else {
    lines.push(`memory: ${result.memory_refresh.status} ${result.memory_refresh.error || ""}`.trimEnd());
  }
}

function readArgValue(argv, index, name) {
  const arg = argv[index];
  if (arg.includes("=")) return { value: arg.split("=").slice(1).join("="), consumed: 0 };
  return { value: argv[index + 1], consumed: 1 };
}

export function parseYoloArgs(argv = process.argv.slice(2)) {
  const input = {};
  const options = {
    json: false,
    help: false,
    dryRun: false,
    engineOnly: false,
    writeLifecycle: true,
    collectEvidence: false,
    executeAdapter: false,
    allowAdapterCommands: false,
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

export function parseYoloInitArgs(argv = []) {
  const input = {};
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
  const input = {};
  const options = {
    json: false,
    help: false,
    dryRun: false,
    writeLegacyPointers: false,
    applyRetention: true,
    migrateLearning: true,
    pruneGeneratedArchives: true,
  };

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

export function parseYoloProgressUiEvidenceArgs(argv = []) {
  const input = {};
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
  const input = {};
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
  const input = { command, ideaParts: [] };
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
    } else if (arg === "--approve" || arg === "--approved") {
      input.approve = true;
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
    } else if (!arg.startsWith("--") && command === "start") {
      input.ideaParts.push(arg);
    }
  }

  input.idea = input.ideaParts.join(" ").trim();
  return { input, options };
}

export function parseYoloWorkflowArgs(argv = []) {
  const input = { objectiveParts: [] };
  const options = { json: false, help: false, writeLifecycle: true };

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
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
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
    } else if (arg === "--approve" || arg === "--approved") {
      input.approve = true;
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
  appendMemoryRefreshText(lines, result);

  return lines.join("\n");
}

export function formatWorkflowPlanText(result = {}) {
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
  appendMemoryRefreshText(lines, result);
  return lines.join("\n");
}

export function formatDiscoveryRuntimeText(label, result = {}) {
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
  appendMemoryRefreshText(lines, result);
  return lines.join("\n");
}

export function formatDemandRuntimeText(label, result = {}) {
  const lines = [`[yolo ${label}] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  if (result.demand_id) lines.push(`demand: ${result.demand_id}`);
  if (result.demand_dir) lines.push(`demand_dir: ${result.demand_dir}`);
  if (result.prd?.id) lines.push(`prd: ${result.prd.id}`);
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
  appendMemoryRefreshText(lines, result);
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

function decorateInterviewState(state = {}) {
  const questions = Array.isArray(state.questions) ? state.questions : [];
  const coverage = inspectDemandInterviewCoverage({ ...state, questions });
  const missingIds = new Set((coverage.missing || []).map((item) => item.question_id));
  const next = questions.find((question) => missingIds.has(question.id)) || null;
  return {
    ...state,
    questions,
    status: coverage.ready_for_prd_intake ? "complete" : "in_progress",
    readiness: coverage.readiness,
    next_question: next ? {
      id: next.id,
      text: next.plain_language_prompt || next.text || next.id,
      category: next.category,
      why_it_matters: next.why_it_matters,
    } : null,
    coverage,
  };
}

function createInterviewState(input = {}, projectRoot, stateRoot) {
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

function resolveInterviewQuestionId(state = {}, value) {
  const questions = state.questions || [];
  const clean = cleanCliText(value);
  if (/^\d+$/.test(clean)) return questions[Number(clean) - 1]?.id || clean;
  const qMatch = clean.toUpperCase().match(/^Q0*(\d+)$/);
  if (qMatch) return questions[Number(qMatch[1]) - 1]?.id || clean;
  return questions.find((question) => question.id === clean)?.id
    || questions.find((question) => question.id?.toLowerCase() === clean.toLowerCase())?.id
    || clean;
}

function coverageCounts(coverage = {}, state = {}) {
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

function coverageForCli(coverage = {}, state = {}) {
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

function writeInterviewAnswerLedger(state = {}, question = {}, answer = "") {
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

function writeInterviewDecisionLedger(state = {}, demandResult = {}) {
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

function interviewNextActions(state = {}, extra = {}) {
  const path = state.interview_path;
  const actions = [];
  if (state.next_question) {
    actions.push(`Answer ${state.next_question.id}: yolo interview answer --session ${path} --question ${state.next_question.id} --answer "<answer>"`);
    actions.push(`Check progress: yolo interview status --session ${path}`);
    return actions;
  }
  if (!extra.demand_dir) actions.push(`Create demand artifacts: yolo interview to-demand --session ${path} --approve`);
  if (extra.demand_dir) actions.push(`Continue to PRD when ready: yolo prd --demand ${extra.demand_dir}`);
  for (const action of extra.runtime_next_actions || []) {
    if (!actions.includes(action)) actions.push(action);
  }
  return actions;
}

function interviewResult(command, state = {}, extra = {}) {
  const decorated = decorateInterviewState(state);
  const result = {
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
    demand_result: extra.demand_result,
  };
  result.next_actions = extra.next_actions || interviewNextActions(decorated, extra);
  return result;
}

function formatInterviewText(label, result = {}) {
  const lines = [`[yolo interview ${label}] ${result.status}: ${result.summary}`];
  if (result.session_path) lines.push(`session: ${result.session_path}`);
  if (result.demand_dir) lines.push(`demand_dir: ${result.demand_dir}`);
  if (result.next_question) lines.push(`next_question: ${result.next_question.id} ${result.next_question.text}`);
  else lines.push("next_question: none");
  if (result.coverage) {
    const counts = coverageCounts(result.coverage, result.interview);
    lines.push(`coverage: ${counts.answered}/${counts.total} (${counts.percent}%)`);
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

export function formatPiRuntimeText(label, result = {}) {
  const lines = [`[yolo ${label}] ${result.status}: ${result.summary}`];
  if (result.code) lines.push(`code: ${result.code}`);
  const artifacts = artifactList(result.artifacts);
  if (artifacts.length) lines.push(`artifacts: ${artifacts.join(", ")}`);
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  appendMemoryRefreshText(lines, result);
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
  appendMemoryRefreshText(lines, result);
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

export async function runYoloInitCli(argv = [], io = {}) {
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
    result = withMemoryRefresh(result, { projectRoot, options, source: "yolo-init" });
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

export async function runYoloMemoryCli(argv = [], io = {}) {
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

export async function runYoloCheckCli(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { input, options } = parseYoloCheckArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const prdPath = input.prdPath
    ? resolvePrdPath(input.prdPath, io.yoloRoot || defaultYoloRoot, { cwd: projectRoot })
    : input.prdPath;
  let report = inspectYoloCheck({
    prdPath,
    projectRoot,
    writeLifecycle: options.writeLifecycle,
  }, { learnFailures: true });
  report = withMemoryRefresh(report, { projectRoot, options, source: "yolo-check" });
  if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else (report.status === "error" ? stderr : stdout).write(`${formatYoloCheckText(report)}\n`);
  return report.status === "blocked" || report.status === "error" ? 1 : 0;
}

export async function runYoloProgressUiEvidenceCli(argv = [], io = {}) {
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
  report = withMemoryRefresh(report, { projectRoot, options, source: "yolo-progress-ui-evidence" });
  if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else stdout.write(`[yolo progress-ui-evidence] ${report.status}: ${report.summary}\n`);
  return report.status === "pass" ? 0 : 1;
}

export async function runYoloInterviewCli(argv = [], io = {}) {
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

    if (command === "to-demand") {
      if (!input.sessionPath) return error("to-demand", "MISSING_INTERVIEW_SESSION", "Missing --session <path|dir>.");
      const read = readInterviewState(input.sessionPath, projectRoot);
      if (!read.ok) return error("to-demand", "INTERVIEW_SESSION_MISSING", read.error, 1);
      const stateForDemand = cloneJson(read.state);
      if (input.approve === true) {
        answerDemandInterviewQuestion(stateForDemand, {
          questionId: "execution_approval",
          answer: "批准，按这个范围进入 PRD。",
        });
      }
      const demandInput = demandInterviewToDemandInput(stateForDemand);
      const demandResult = runDemandDiscussRuntime({
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
          demand_path: demandResult.artifacts?.find((path) => path.endsWith("session.json")) || null,
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
      return emit("to-demand", interviewResult("to-demand", state, {
        status: "success",
        code: "INTERVIEW_DEMAND_CREATED",
        summary: writeArtifacts ? "Demand artifacts generated from interview." : "Demand artifact preview generated from interview.",
        artifacts,
        outputs: demandResult.outputs || [],
        demand_dir: demandResult.demand_dir,
        demand_result: demandResult,
        runtime_next_actions: demandResult.next_actions || [],
      }));
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

export async function runYoloBrainstormCli(argv = [], io = {}) {
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
  result = withMemoryRefresh(result, { projectRoot, options, source: "yolo-brainstorm" });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatDemandRuntimeText("brainstorm", result)}\n`);
  return result.status === "blocked" ? 1 : 0;
}

export async function runYoloDiscussCli(argv = [], io = {}) {
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
  result = withMemoryRefresh(result, { projectRoot, options, source: "yolo-discuss" });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatDemandRuntimeText("discuss", result)}\n`);
  return result.status === "blocked" ? 1 : 0;
}

export async function runYoloAcceptCli(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const { input, options } = parseYoloAcceptArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const prdPath = input.prdPath
    ? resolvePrdPath(input.prdPath, io.yoloRoot || defaultYoloRoot, { cwd: projectRoot })
    : input.prdPath;
  let report = buildAcceptanceReport({
    prdPath,
    projectRoot,
    writeLifecycle: options.writeLifecycle,
    collectEvidence: options.collectEvidence,
    executeAdapter: options.executeAdapter,
    allowAdapterCommands: options.allowAdapterCommands,
  }, { learnFailures: true });
  report = withMemoryRefresh(report, { projectRoot, options, source: "yolo-accept" });
  if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else stdout.write(`${formatAcceptanceReportText(report)}\n`);
  return report.status === "blocked" ? 1 : 0;
}

export async function runYoloDiscoverCli(argv = [], io = {}) {
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
  result = withMemoryRefresh(result, { projectRoot, options, source: "yolo-discover" });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatDiscoveryRuntimeText("discover", result)}\n`);
  return result.status === "blocked" ? 1 : 0;
}

export async function runYoloPlanCli(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const { input, options } = parseYoloWorkflowArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  let result = runDiscoveryPlanRuntime({
    ...input,
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
    objective: input.objective,
    writeArtifacts: options.writeLifecycle,
    writeLifecycle: options.writeLifecycle,
    source: "yolo-plan",
  });
  result = withMemoryRefresh(result, { projectRoot, options, source: "yolo-plan" });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatDiscoveryRuntimeText("plan", result)}\n`);
  return result.status === "blocked" ? 1 : 0;
}

export async function runYoloPrdCli(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const { input, options } = parseYoloWorkflowArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  if (input.demandPath) {
    let result = runDemandPrdRuntime({
      ...input,
      projectRoot,
      stateRoot: join(projectRoot, ".yolo"),
      writeArtifacts: options.writeLifecycle,
    });
    result = withMemoryRefresh(result, { projectRoot, options, source: "yolo-prd" });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatDemandRuntimeText("prd", result)}\n`);
    return result.status === "blocked" ? 1 : 0;
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
  result = withMemoryRefresh(result, { projectRoot, options, source: "yolo-prd" });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatDiscoveryRuntimeText("prd", result)}\n`);
  return result.status === "blocked" ? 1 : 0;
}

export async function runYoloWorkflowPlanCli(workflow, argv = [], io = {}) {
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

export async function runYoloReviewCli(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const { input, options } = parseYoloWorkflowArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const projectRoot = resolve(input.cwd || input.objective || io.cwd || process.cwd());
  let result = await runPiRuntime("review.scan", {
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
    writeLifecycle: options.writeLifecycle,
  });
  result = withMemoryRefresh(result, { projectRoot, options, source: "yolo-review" });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatPiRuntimeText("review", result)}\n`);
  return result.status === "success" ? 0 : 1;
}

export async function runYoloShipCli(argv = [], io = {}) {
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
  let result = await runPiRuntime("ship", {
    prdPath,
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
    writeLifecycle: options.writeLifecycle,
  });
  result = withMemoryRefresh(result, { projectRoot, options, source: "yolo-ship" });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatPiRuntimeText("ship", result)}\n`);
  return result.status === "success" ? 0 : 1;
}

export async function runYoloLearnCli(argv = [], io = {}) {
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
  result = withMemoryRefresh(result, { projectRoot, options, source: "yolo-learn" });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatPiRuntimeText("learn", result)}\n`);
  return result.status === "success" ? 0 : 1;
}

export async function runYoloCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const yoloRoot = io.yoloRoot || defaultYoloRoot;
  if (argv[0] === "init") {
    return runYoloInitCli(argv.slice(1), io);
  }
  if (argv[0] === "doctor") {
    return runYoloDoctorCli(argv.slice(1), io);
  }
  if (argv[0] === "brainstorm" || argv[0] === "office-hours") return runYoloBrainstormCli(argv.slice(1), io);
  if (argv[0] === "interview") return runYoloInterviewCli(argv.slice(1), io);
  if (argv[0] === "discover") return runYoloDiscoverCli(argv.slice(1), io);
  if (argv[0] === "discuss") return runYoloDiscussCli(argv.slice(1), io);
  if (argv[0] === "plan") return runYoloPlanCli(argv.slice(1), io);
  if (argv[0] === "prd") return runYoloPrdCli(argv.slice(1), io);
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
    return runYoloAcceptCli(argv.slice(1), io);
  }
  if (argv[0] === "eval") {
    return runYoloBenchmarkCli(argv.slice(1), io);
  }
  if (argv[0] === "memory") {
    return runYoloMemoryCli(argv.slice(1), io);
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

  const { input, options } = parseYoloArgs(argv);

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const cliProjectRoot = resolve(input.cwd || io.cwd || process.cwd());
  const prdPath = input.prdPath
    ? resolvePrdPath(input.prdPath, yoloRoot, { cwd: cliProjectRoot })
    : findLatestPrd(yoloRoot);

  if (!prdPath) {
    const result = {
      status: "error",
      summary: "missing PRD path",
      exit_code: 2,
      code: "MISSING_PRD_PATH",
      artifacts: [],
      next_actions: ["Pass a PRD path with --prd or create a runnable PRD under data/prd/current."],
    };
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stderr.write(`${usage()}\n`);
    return result.exit_code;
  }

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
    }, {
      yoloRoot,
      projectRoot: cliProjectRoot,
      stateRoot: join(cliProjectRoot, ".yolo"),
      execute: true,
    });
    result = withMemoryRefresh(result, { projectRoot: cliProjectRoot, options, source: "yolo-run" });
    if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else stdout.write(`${formatPiRuntimeText("run", result)}\n`);
    return result.status === "success" ? 0 : 1;
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
    executor,
    provider,
    model: input.model,
    agentCommand: input.agentCommand,
  });
  result = withMemoryRefresh(result, { projectRoot: cliProjectRoot, options, source: "yolo-runner" });
  if (options.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatRunnerText(result)}\n`);

  return result.exit_code ?? (result.status === "success" ? 0 : 1);
}
