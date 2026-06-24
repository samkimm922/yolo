import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildAgentBridgeBlock,
  buildClaudeSlashCommand,
  buildCodexSlashCommandSkill,
  buildCodexSourceCommandSkill,
  buildYoloNativeSkill,
} from "../../tools/install-agent-bridge.js";
import type { ReleaseCheck, ReleaseRecord } from "./readiness.js";

export const NONTECHNICAL_UX_DOCTOR_SCHEMA_VERSION = "1.0";

export const YOLO_ONE_SENTENCE_ENTRY = "/yolo 你的需求，先读状态并选择安全阶段，不要改代码。";
export const YOLO_CODEX_FALLBACK_ENTRY = "使用 yolo skill 执行 /yolo：你的需求，先读状态并选择安全阶段，不要改代码。";
export const YOLO_STAGE_COMMAND_CONTRACT = "If the user asks to talk through a requirement, use `/yolo-demand` as the single demand-stage entry instead of asking them to choose brainstorm/interview/discover/discuss.";

export interface NonTechnicalUxDoctorPlan extends ReleaseRecord {
  yolo_root: string;
  one_sentence_entry: string;
  codex_fallback_entry: string;
  docs: string[];
  writes_workspace: boolean;
  publishes: boolean;
  reads_credentials: boolean;
  spawns_provider: boolean;
  executes_billable_provider: boolean;
}

export interface NonTechnicalUxDoctorOptions extends ReleaseRecord {
  yoloRoot?: string;
  cwd?: string;
  plan?: NonTechnicalUxDoctorPlan;
}

export interface FileContainsResult {
  path: string;
  exists: boolean;
  contains: boolean;
}

function check(code: string, passed: boolean, message: string, extra: ReleaseRecord = Object()): ReleaseCheck {
  return { code, passed, message, ...extra };
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function fileContains(root: string, relativePath: string, needle: string): FileContainsResult {
  const filePath = join(root, relativePath);
  return {
    path: filePath,
    exists: existsSync(filePath),
    contains: readText(filePath).includes(needle),
  };
}

export function buildNonTechnicalUxDoctorPlan(options: NonTechnicalUxDoctorOptions = Object()): NonTechnicalUxDoctorPlan {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  return {
    schema_version: NONTECHNICAL_UX_DOCTOR_SCHEMA_VERSION,
    schema: "yolo.release.nontechnical_ux_doctor_plan.v1",
    yolo_root: yoloRoot,
    one_sentence_entry: YOLO_ONE_SENTENCE_ENTRY,
    codex_fallback_entry: YOLO_CODEX_FALLBACK_ENTRY,
    docs: [
      "README.md",
      "docs/agent-chat-usage.md",
      "docs/agent-native-integration.md",
      "docs/non-technical-user-guide.md",
    ],
    writes_workspace: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    required_evidence: [
      "public docs expose one memorable Codex/Claude Code entry sentence",
      "native YOLO skill exposes the same one-sentence usage",
      "Codex bridge exposes clear stage commands while hiding internal workflow names",
      "Claude slash command, Codex primary skill, and Codex source-command fallback tell agents not to ask users to memorize terminal commands",
      "doctor report returns plain-language next actions",
    ],
  };
}

export function runNonTechnicalUxDoctor(options: NonTechnicalUxDoctorOptions = Object()) {
  const plan = options.plan || buildNonTechnicalUxDoctorPlan(options);
  const yoloRoot = resolve(plan.yolo_root);
  const docs = Object.fromEntries(plan.docs.map((doc) => [doc, fileContains(yoloRoot, doc, plan.one_sentence_entry)]));
  const nativeSkill = buildYoloNativeSkill({ agent: "codex", yoloRoot });
  const claudeCommand = buildClaudeSlashCommand("yolo-status", { yoloRoot });
  const codexSlashCommand = buildCodexSlashCommandSkill("yolo-status", { yoloRoot });
  const codexCommand = buildCodexSourceCommandSkill("demand", { yoloRoot });
  const bridgeBlock = buildAgentBridgeBlock({ agent: "codex", yoloRoot });

  const checks = [
    check(
      "NONTECH_UX_NO_SIDE_EFFECTS",
      plan.writes_workspace === false
        && plan.publishes === false
        && plan.reads_credentials === false
        && plan.spawns_provider === false
        && plan.executes_billable_provider === false,
      "non-technical UX doctor must inspect only",
    ),
    check(
      "NONTECH_UX_DOCS_ONE_SENTENCE",
      Object.values(docs).every((entry) => entry.exists && entry.contains),
      "README and user docs must contain the same one-sentence Codex/Claude Code entry",
      { docs },
    ),
    check(
      "NONTECH_UX_NATIVE_SKILL_ENTRY",
      nativeSkill.includes(plan.one_sentence_entry)
        && nativeSkill.includes(plan.codex_fallback_entry)
        && nativeSkill.includes(YOLO_STAGE_COMMAND_CONTRACT),
      "native YOLO skill must include one-sentence usage, Codex fallback wording, and stage-command routing",
    ),
    check(
      "NONTECH_UX_STAGE_COMMANDS_CLEAR",
      bridgeBlock.includes("Primary fallback entrypoint")
        && bridgeBlock.includes("single demand-stage entry")
        && bridgeBlock.includes("compatibility alias for `/yolo-demand --stage <stage>`")
        && bridgeBlock.includes("Do not expose internal workflow names")
        && codexCommand.includes("explicit `/yolo-*` command")
        && codexSlashCommand.includes("唯一安全下一步"),
      "Codex bridge and command artifacts must make /yolo a fallback router and /yolo-* commands clear stage entries",
    ),
    check(
      "NONTECH_UX_COMMANDS_CHAT_FIRST",
      claudeCommand.includes("do not ask the user to memorize terminal commands")
        && codexCommand.includes("do not ask the user to memorize terminal commands")
        && bridgeBlock.includes("Treat this chat as the user interface"),
      "Claude/Codex entry artifacts must keep chat as the UI",
    ),
  ];
  const blockers = checks.filter((item) => item.passed !== true);
  return {
    schema_version: NONTECHNICAL_UX_DOCTOR_SCHEMA_VERSION,
    schema: "yolo.release.nontechnical_ux_doctor_result.v1",
    status: blockers.length === 0 ? "pass" : "blocked",
    yolo_root: yoloRoot,
    checks,
    blockers,
    report: {
      title: "YOLO non-technical entry",
      one_sentence_entry: plan.one_sentence_entry,
      codex_fallback_entry: plan.codex_fallback_entry,
      plain_language_summary: "In Codex or Claude Code, the user should describe the goal in one sentence; the agent invokes YOLO and reports blockers.",
      user_visible_next_step: plan.one_sentence_entry,
    },
    artifacts_sample: {
      native_skill_contains_entry: nativeSkill.includes(plan.one_sentence_entry),
      native_skill_stage_command_contract: nativeSkill.includes(YOLO_STAGE_COMMAND_CONTRACT),
      bridge_stage_commands_clear: bridgeBlock.includes("single demand-stage entry"),
      claude_command_chat_first: claudeCommand.includes("do not ask the user to memorize terminal commands"),
      codex_slash_command_chat_first: codexSlashCommand.includes("do not ask the user to memorize terminal commands"),
      codex_source_command_chat_first: codexCommand.includes("do not ask the user to memorize terminal commands"),
    },
    guarantees: {
      writes_workspace: false,
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
    },
    next_actions: blockers.length === 0
      ? [`Tell non-technical users exactly this: ${plan.one_sentence_entry}`]
      : ["Sync the one-sentence entry across README, docs, native skill, and command artifacts."],
    plan,
  };
}
