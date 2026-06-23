// Shared CLI helpers used across multiple split modules.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_YOLO_PUBLIC_COMMAND_NAMES,
  getYoloCommand,
} from "../../workflows/command-registry.js";

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const defaultYoloRoot = resolve(__dirname, "../../..");

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
    "未传 PRD 时，会在目标项目 .yolo/demand/*/prd.json、.yolo/data/prd/current、.yolo/data/prd/archive 和 .yolo/data 中寻找 PRD JSON。",
  ].join("\n");
}

export const KNOWN_YOLO_COMMAND_WORDS = new Set([
  ...DEFAULT_YOLO_PUBLIC_COMMAND_NAMES,
  "status", "demand", "auto", "ship",
  "spec", "tasks", "run", "runner", "check", "review", "release", "init", "setup", "install", "doctor", "eval",
  "progress-ui-evidence", "memory", "learn",
  "candidate", "gate", "rc", "publish",
  "ui-evidence",
]);

export function cleanCliText(value) {
  return String(value ?? "").trim();
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableJson(value), "utf8");
  return path;
}

export function appendJsonlFile(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  return path;
}

export function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeDemandStage(value = "") {
  const stage = cleanCliText(value).toLowerCase();
  if (!stage) return "";
  if (stage === "discovery") return "discover";
  if (stage === "discussion") return "discuss";
  if (stage === "office" || stage === "office-hours" || stage === "office_hours") return "office-hours";
  if (stage === "evidence-dispatch") return "dispatch";
  return stage;
}

export function isBlockingWorkflowStatus(status = "") {
  return ["blocked", "error", "warning", "draft"].includes(cleanCliText(status).toLowerCase());
}

const DRY_RUN_READY_CODES = new Set(["PI_DRY_RUN_READY", "RUNNER_DRY_RUN_READY"]);

export function isDryRunReadyResult(result = Object()) {
  return cleanCliText(result.status).toLowerCase() === "dry_run" && (
    DRY_RUN_READY_CODES.has(cleanCliText(result.code)) ||
    result.dry_run === true ||
    result.dryRun === true
  );
}

export function normalizeDryRunReadyExitCode(result = Object()) {
  if (!isDryRunReadyResult(result)) return result;
  return { ...result, exit_code: 0 };
}

export function workflowExitCode(result = Object()) {
  const status = cleanCliText(result.status).toLowerCase();
  if (status === "pass" || status === "success") return 0;
  if (isDryRunReadyResult(result)) return 0;
  if (status === "warning" || status === "draft" || status === "dry_run" || status === "not_run" || status === "indeterminate" || status === "ready" || status === "ready_for_operator") return 2;
  return isBlockingWorkflowStatus(status) ? 1 : 1;
}

export function existingJsonPath(value, cwd = process.cwd()) {
  const text = String(value || "").trim();
  if (!text.endsWith(".json")) return "";
  const absolute = isAbsolute(text) ? text : resolve(cwd, text);
  return existsSync(absolute) ? text : "";
}
