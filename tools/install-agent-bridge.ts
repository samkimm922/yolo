#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getYoloCommand,
  listYoloCommands,
  renderYoloCommandUsage,
} from "../src/workflows/command-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_YOLO_ROOT = resolve(__dirname, "..");
const BRIDGE_START = "<!-- yolo-agent-bridge:start -->";
const BRIDGE_END = "<!-- yolo-agent-bridge:end -->";

function unique(values) {
  return [...new Set(values)];
}

function clean(value) {
  return String(value ?? "").trim();
}

function parseList(value) {
  return clean(value).split(",").map((item) => clean(item).toLowerCase()).filter(Boolean);
}

export function normalizeAgentTargets(value = "both") {
  const targets = parseList(value || "both");
  const expanded = targets.flatMap((target) => target === "both" ? ["codex", "claude"] : [target]);
  const normalized = unique(expanded);
  const invalid = normalized.filter((target) => !["codex", "claude"].includes(target));
  if (invalid.length > 0) {
    throw new Error(`Unknown agent target: ${invalid.join(", ")}. Use codex, claude, or both.`);
  }
  return normalized.length > 0 ? normalized : ["codex", "claude"];
}

export function normalizeInstallScopes(value = "project") {
  const scopes = parseList(value || "project");
  const expanded = scopes.flatMap((scope) => scope === "both" ? ["project", "user"] : [scope]);
  const normalized = unique(expanded);
  const invalid = normalized.filter((scope) => !["project", "user", "none"].includes(scope));
  if (invalid.length > 0) {
    throw new Error(`Unknown install scope: ${invalid.join(", ")}. Use project, user, both, or none.`);
  }
  if (normalized.includes("none")) return [];
  return normalized.length > 0 ? normalized : ["project"];
}

function readArgValue(argv, index, prefix) {
  const arg = argv[index];
  if (arg.includes("=")) return { value: arg.slice(prefix.length + 1), consumed: 0 };
  return { value: argv[index + 1], consumed: 1 };
}

export function parseAgentBridgeArgs(argv = process.argv.slice(2)) {
  const options = {
    projectRoot: null,
    yoloRoot: DEFAULT_YOLO_ROOT,
    homeDir: homedir(),
    targets: ["codex", "claude"],
    scopes: ["project"],
    commands: true,
    dryRun: false,
    force: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--no-commands") {
      options.commands = false;
    } else if (arg === "--project-root" || arg.startsWith("--project-root=")) {
      const read = readArgValue(argv, index, "--project-root");
      options.projectRoot = read.value;
      index += read.consumed;
    } else if (arg === "--home-dir" || arg.startsWith("--home-dir=")) {
      const read = readArgValue(argv, index, "--home-dir");
      options.homeDir = read.value;
      index += read.consumed;
    } else if (arg === "--yolo-root" || arg.startsWith("--yolo-root=")) {
      const read = readArgValue(argv, index, "--yolo-root");
      options.yoloRoot = read.value;
      index += read.consumed;
    } else if (arg === "--target" || arg.startsWith("--target=")) {
      const read = readArgValue(argv, index, "--target");
      options.targets = normalizeAgentTargets(read.value);
      index += read.consumed;
    } else if (arg === "--scope" || arg.startsWith("--scope=") || arg === "--install-scope" || arg.startsWith("--install-scope=")) {
      const prefix = arg.startsWith("--install-scope") ? "--install-scope" : "--scope";
      const read = readArgValue(argv, index, prefix);
      options.scopes = normalizeInstallScopes(read.value);
      index += read.consumed;
    } else if (!arg.startsWith("--") && !options.projectRoot) {
      options.projectRoot = arg;
    }
  }

  options.projectRoot = resolve(options.projectRoot || process.cwd());
  options.yoloRoot = resolve(options.yoloRoot || DEFAULT_YOLO_ROOT);
  options.homeDir = resolve(options.homeDir || homedir());
  return options;
}

export function buildAgentBridgeBlock({ agent, yoloRoot = DEFAULT_YOLO_ROOT } = {}) {
  const label = agent === "claude" ? "Claude Code" : "Codex";
  return [
    BRIDGE_START,
    `## YOLO Agent Bridge for ${label}`,
    "",
    `YOLO root: ${resolve(yoloRoot)}`,
    "",
    "Primary fallback entrypoint when the user is unsure:",
    "",
    "> /yolo 你的需求，先读状态并选择安全阶段，不要改代码。",
    "",
    "When the user asks for YOLO, yolo流程, 从需求到落地, 自动开发, PRD落地, review/fix, 高质量迭代, or sends text starting with `/yolo`:",
    "",
    "1. Treat this chat as the user interface. Do not ask the user to memorize terminal commands.",
    "2. Read YOLO docs first when needed: `docs/agent-chat-usage.md`, `docs/non-technical-user-guide.md`, and `docs/public-sdk-contract.md` under the YOLO root.",
    "3. If the user invokes `/yolo ...`, route it yourself through the command surface: demand, auto, ship, or status. Route internally to spec, tasks, run, check, review, or release as needed.",
    "4. Treat `/yolo-demand` as the single demand-stage entry and user-facing demand interview host. Route brainstorm, interview, discovery, discussion, office-hours, evidence dispatch, and spec-readiness questions inside that demand stage.",
    "5. Default `/yolo-demand` to one-question mode: when required slots are missing, ask exactly one `next_question` in plain language and stop. Do not output long recommendation lists, do not enter PRD, and do not edit code.",
    "6. Keep audiences separated: this user-facing chat prompt must not include evidence agent JSON role contracts. Evidence dispatch prompts are only for provider sub-agents spawned by `yolo demand dispatch`.",
    "7. If the user invokes a legacy demand subcommand such as `/yolo-brainstorm`, `/yolo-interview`, `/yolo-discover`, `/yolo-discuss`, or `/office-hours`, treat it as a hidden compatibility alias for `/yolo-demand --stage <stage>` or `yolo demand --mode office-hours` and enforce the same demand-stage protocol.",
    "8. If the user invokes a legacy post-demand command such as `/yolo-plan`, `/yolo-prd`, `/yolo-accept`, or `/yolo-ship`, route it to the matching stable command (`/yolo-auto` or `/yolo-ship`) and enforce that stage's safety rules.",
    "9. A stage command is terminal for the current turn unless it is `/yolo-auto` or `/yolo-run`: finish only that stage, report artifacts/blockers, and suggest the next `/yolo-*` command.",
    "10. For `/yolo-demand`, demand aliases, `/yolo-tasks`, `/yolo-spec`, and `/yolo-check`, do not continue into downstream stages in the same response, even if the user says the result looks good.",
    "11. User approval of a demand discussion, plan, PRD, or check means permission to move to the next stage, not permission to edit code. 批准最后: demand approval comes after slots are concrete, and execution approval remains separate.",
    "12. When unsure, run `/yolo-status` first and follow the lifecycle guard recommendation instead of choosing a downstream stage yourself.",
    "13. Before real edits, verify the project is initialized, `/yolo-check` passed through the lifecycle guard, and the user explicitly approved `/yolo-run` execution.",
    "14. Use the YOLO CLI/SDK yourself from the YOLO root only for the currently selected stage; the user should only describe the goal in chat.",
    "15. If the host still exposes legacy internal names such as `/Yolo.brainstorm` or `yolo.brainstorm`, treat them only as compatibility aliases for the matching demand stage and apply the same stage-stop rules.",
    "16. Do not expose internal workflow names such as `yolo.pi` or `yolo.prd` as choices for the user.",
    "17. Fail closed on weak PRD, missing targets, missing tests, dirty risky workspace, provider unavailability, lifecycle guard block, or gate failure.",
    "18. Report results in plain language with the generated report paths and remaining blockers.",
    "",
    "Execution requires explicit user confirmation:",
    "",
    "> 我确认，用 YOLO 执行这个已经检查通过的 PRD。",
    BRIDGE_END,
    "",
  ].join("\n");
}

export function mergeAgentBridgeBlock(existing = "", block = "") {
  if (!existing.trim()) return `${block.trimEnd()}\n`;
  const start = existing.indexOf(BRIDGE_START);
  const end = existing.indexOf(BRIDGE_END);
  if (start >= 0 && end > start) {
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(end + BRIDGE_END.length).trimStart();
    return [before, block.trimEnd(), after].filter(Boolean).join("\n\n") + "\n";
  }
  return `${existing.trimEnd()}\n\n${block.trimEnd()}\n`;
}

function instructionFileFor(projectRoot, target) {
  return join(projectRoot, target === "claude" ? "CLAUDE.md" : "AGENTS.md");
}

function relativeToProject(projectRoot, path) {
  return path.startsWith(projectRoot) ? path.slice(projectRoot.length + 1) : path;
}

function relativeToBase(baseDir, path) {
  return path.startsWith(baseDir) ? path.slice(baseDir.length + 1) : path;
}

function displayRelativePath(baseDir, path, scope) {
  const relativePath = relativeToBase(baseDir, path);
  return scope === "user" ? `~/${relativePath}` : relativePath;
}

function asScopes(options = {}) {
  if (Array.isArray(options.scopes)) return options.scopes;
  return normalizeInstallScopes(options.scope || options.installScope || options.install_scope || "project");
}

function commandDefinitions() {
  return listYoloCommands({ recommended: true });
}

function renderCommandUsage(commandInput) {
  return renderYoloCommandUsage(commandInput);
}

function primarySlashNameForCommand(command = {}) {
  if (command.stability === "stable") return `yolo-${command.name}`;
  if (String(command.name || "").startsWith("yolo-")) return command.name;
  return `yolo-${command.name}`;
}

function isDemandCompatibilityAlias(command = {}) {
  return command.alias_for === "demand"
    && command.stability === "compat"
    && Boolean(command.demand_stage || command.demand_mode);
}

function isDemandHostCommand(command = {}) {
  return command.name === "demand" || isDemandCompatibilityAlias(command);
}

function demandAliasSlashRoute(command = {}) {
  if (!isDemandCompatibilityAlias(command)) return "";
  if (command.demand_mode) return `/yolo-demand --mode ${command.demand_mode}`;
  return `/yolo-demand --stage ${command.demand_stage || command.mode}`;
}

function demandAliasRoute(command = {}) {
  if (!isDemandCompatibilityAlias(command)) return "";
  if (command.demand_mode) return `yolo demand --mode ${command.demand_mode}`;
  return `yolo demand --stage ${command.demand_stage || command.mode}`;
}

function compatibilityAliasRoute(command = {}) {
  if (isDemandCompatibilityAlias(command)) return demandAliasRoute(command);
  return command.usage || "";
}

function isWriteCommand(command = {}) {
  return command.writes_code === true
    || ["run", "fix", "runner", "init", "setup", "install"].includes(command.name)
    || ["run", "fix", "runner", "init", "setup", "install"].includes(command.mode);
}

function allowedToolsForCommand(command = {}) {
  const tools = ["Read", "Bash", "Glob", "Grep"];
  if (isWriteCommand(command)) {
    tools.push("Edit", "Write");
  }
  return tools.map((tool) => `  - ${tool}`);
}

function stageStopRule(command = {}) {
  if (command.name === "demand") {
    return "- `/yolo-demand` is the unified demand-stage interview host. Route internally between brainstorm, interview, discover, discuss, office-hours, status, evidence dispatch, and spec-readiness. If slots are missing, ask exactly one `next_question` and stop; do not enter `/yolo-spec` in the same response.";
  }
  if (isDemandCompatibilityAlias(command)) {
    return `- Compatibility alias: treat this command as \`${demandAliasSlashRoute(command)}\` (CLI: \`${demandAliasRoute(command)}\`) and use the unified /yolo-demand protocol. Finish only that demand sub-stage; if slots are missing, ask one \`next_question\` and stop with handoff state.`;
  }
  if (["init", "setup", "install"].includes(command.name) || ["init", "setup", "install"].includes(command.mode)) {
    return "- This setup/install stage may write YOLO scaffolding or agent bridge files. Start only after explicit user approval for the target scope; do not modify business source code.";
  }
  if (isWriteCommand(command)) {
    return "- This is a write-capable stage. Start only after explicit user approval, a checked PRD/fix scope, and passing gates; stop on the first blocker.";
  }
  return "- Stage stop: complete only this command's stage, then stop with artifacts, blockers, and the next recommended `/yolo-*` command. Do not advance to tasks, spec, check, run, fix, or source-code edits in the same response.";
}

function demandHostRules(command = {}) {
  if (!isDemandHostCommand(command)) return [];
  return [
    "- Demand host default: run one-question mode. If required slots are missing, return exactly one `next_question` and wait for the user's answer.",
    "- Do not output long recommendation lists, do not compile or enter PRD, and do not edit code during demand-stage conversation.",
    "- 批准最后: ask for demand approval only after required slots are concrete; approval to continue is not execution authorization.",
    "- Audience separation: user-facing demand chat must not include evidence agent JSON role contracts. Evidence dispatch prompt content is only for provider sub-agents spawned by `yolo demand dispatch`.",
  ];
}

function executionApprovalRule(command = {}) {
  if (isWriteCommand(command)) {
    return "- Execution approval must be current and specific to this run/fix scope.";
  }
  return "- User confirmation that this stage output looks good is not execution approval. It only authorizes the next no-code stage unless the user later invokes `/yolo-run` or `/yolo-fix` after checks pass.";
}

export function buildClaudeSlashCommand(commandName, { yoloRoot = DEFAULT_YOLO_ROOT } = {}) {
  const command = getYoloCommand(commandName);

  return [
    "---",
    `name: ${commandName}`,
    `description: ${command.description}`,
    `argument-hint: "${command.argumentHint}"`,
    "allowed-tools:",
    ...allowedToolsForCommand(command),
    "---",
    "",
    `# /${commandName}`,
    "",
    "**Input**: $ARGUMENTS",
    "",
    `YOLO root: ${resolve(yoloRoot)}`,
    `Mode: ${command.mode}`,
    "",
    "## Objective",
    "",
    command.objective,
    "",
    "## Operating Rules",
    "",
    "- Treat Claude Code chat as the user interface; do not ask the user to memorize terminal commands.",
    "- Read project `CLAUDE.md`/`AGENTS.md` and YOLO docs when context is missing.",
    "- Use YOLO CLI/SDK yourself from the YOLO root only for this command's permitted stage.",
    "- Keep requirement, PRD/spec, tasks, review findings, fixes, gates, and evidence traceable.",
    isDemandCompatibilityAlias(command)
      ? `- This command is a compatibility alias for \`${demandAliasSlashRoute(command)}\` (CLI: \`${demandAliasRoute(command)}\`); use the unified demand-stage protocol.`
      : "- Follow this command's declared stage and lifecycle boundary.",
    ...demandHostRules(command),
    stageStopRule(command),
    executionApprovalRule(command),
    `- Safety: ${command.safety}`,
    "- Fail closed on missing PRD, unclear scope, dirty risky workspace, broken tests, provider failure, or gate failure.",
    "- Report generated files, gate results, and remaining blockers in plain language.",
    "",
    "## Example",
    "",
    "```text",
    renderCommandUsage({ name: commandName }),
    "```",
    "",
  ].join("\n");
}

function codexMenuDescription(command = {}) {
  const descriptions = {
    demand: "统一需求访谈主持入口：缺槽位时 one-question 只问一个 next_question；不输出大段建议、不进 PRD、不改代码。",
    auto: "全自动执行 YOLO 流水线：需求澄清 \u2192 spec \u2192 check \u2192 实现 \u2192 review \u2192 交付；各阶段独立 gate。",
    ship: "交付判断：在 spec、gate、证据和 review 全部通过前，fail closed 阻止发布。",
    status: "读取 YOLO 项目状态和唯一安全下一步；不改代码。",
    spec: "把已批准的需求、发现或任务材料编译成可执行 spec/PRD；不改代码。",
    tasks: "把澄清后的需求拆成可执行任务和计划；不改代码。",
    run: "执行已批准且已检查通过的 PRD/任务；可能改代码，必须有明确批准。",
    check: "执行前检查 spec、范围、gate、adapter 和证据计划；不改代码。",
    review: "审查实现质量、风险、回归和缺失测试；默认不改代码。",
    release: "运行验收、打包、dogfood 和 release-candidate gate；不发布。",
  };
  return descriptions[command.name] || command.description || "";
}

export function buildYoloNativeSkill({ agent = "codex", yoloRoot = DEFAULT_YOLO_ROOT } = {}) {
  const label = agent === "claude" ? "Claude Code" : "Codex";
  const recommendedCommands = listYoloCommands({ recommended: true });
  const demandAliases = listYoloCommands({ compatibilityAliases: true })
    .filter((command) => isDemandCompatibilityAlias(command));
  return [
    "---",
    "name: yolo",
    "description: Use when the user wants YOLO to take a requirement or PRD through planning, PRD checks, gated implementation, review, fixes, and final evidence without memorizing CLI commands.",
    "---",
    "",
    `# YOLO Native Skill for ${label}`,
    "",
    `YOLO root: ${resolve(yoloRoot)}`,
    "",
    "## When To Use",
    "",
    "- The user says YOLO, yolo流程, PRD落地, 自动开发, 高质量迭代, review/fix, gate, or wants a requirement executed end-to-end.",
    "- The user uses command-like text starting with `/yolo`, including `/yolo` itself or an explicit `/yolo-*` stage command.",
    "",
    "## How To Choose",
    "",
    "If the user is not sure which stage to use, start here:",
    "",
    "> /yolo 你的需求，先读状态并选择安全阶段，不要改代码。",
    "",
    "Codex fallback when slash routing is not active:",
    "",
    "> 使用 yolo skill 执行 /yolo：你的需求，先读状态并选择安全阶段，不要改代码。",
    "",
    "If the user asks to talk through a requirement, use `/yolo-demand` as the single demand-stage entry instead of asking them to choose brainstorm/interview/discover/discuss.",
    "",
    "`/yolo-demand` defaults to one-question mode: when slots are missing, ask exactly one `next_question`, do not output long recommendation lists, do not enter PRD, and do not edit code. 批准最后; execution approval is separate.",
    "",
    "Recommended user commands:",
    "",
    ...recommendedCommands.map((command) =>
      `- \`/${primarySlashNameForCommand(command)}\`: ${codexMenuDescription(command)}`
    ),
    "",
    "Hidden demand compatibility aliases (not installed as default command files):",
    "",
    ...demandAliases.map((command) =>
      `- \`/${primarySlashNameForCommand(command)}\` -> \`${compatibilityAliasRoute(command)}\`: ${codexMenuDescription(command)}`
    ),
    "",
    "## Execution Contract",
    "",
    "- Treat chat as the UI. The user describes goals; the agent invokes YOLO.",
    "- Read project instructions and YOLO docs before acting when context is missing.",
    "- Stage commands are stop points: after `/yolo-demand`, any demand compatibility alias, `/yolo-tasks`, `/yolo-spec`, or `/yolo-check`, report artifacts and ask for the next stage instead of continuing automatically.",
    "- `/yolo-brainstorm`, `/yolo-interview`, `/yolo-discover`, and `/yolo-discuss` are compatibility aliases; apply the same one-question, next_question, evidence, assumption, verification, and stage-stop rules as `/yolo-demand`.",
    "- `/office-hours` is a hidden compatibility shim for `yolo demand --mode office-hours`; do not present it as a separate top-level command.",
    "- If the host still exposes legacy non-demand aliases such as `/yolo-plan`, `/yolo-prd`, `/yolo-accept`, or `/yolo-ship`, route them to the matching stable command without presenting them as menu choices.",
    "- Keep audience separation: user-facing demand chat must not include evidence agent JSON role contracts; evidence dispatch prompts are only for provider sub-agents spawned by `yolo demand dispatch`.",
    "- When unsure, use `/yolo-status` to read lifecycle state and follow the guard recommendation before selecting any downstream command.",
    "- Confirming a brainstorm, discussion, plan, PRD, or check is not permission to edit code; execution still requires `/yolo-run` or `/yolo-fix` with a checked PRD/fix scope.",
    "- Keep all changes scoped to the user's target project, not the YOLO package root.",
    "- Require explicit confirmation before code edits or user-level installs.",
    "- Fail closed on weak PRD, unclear file scope, unavailable provider, failing gate, or missing verification.",
    "- Explain results in business language and include artifact paths.",
    "",
  ].join("\n");
}

export function buildCodexSourceCommandSkill(commandName, { yoloRoot = DEFAULT_YOLO_ROOT } = {}) {
  const command = getYoloCommand(commandName);
  const aliases = commandName === "yolo"
    ? "`/yolo`, `/yolo status`, `/yolo demand`, `/yolo tasks`, `/yolo check`, `/yolo run`, or `/yolo review`"
    : `\`/${commandName}\``;

  return [
    "---",
    `name: "source-command-${commandName}"`,
    `description: "${command.description}"`,
    "---",
    "",
    `# source-command-${commandName}`,
    "",
    `Use this skill when the user invokes ${aliases}.`,
    "",
    "## Command Template",
    "",
    `# /${commandName}`,
    "",
    `YOLO root: ${resolve(yoloRoot)}`,
    `Mode: ${command.mode}`,
    "",
    "## Objective",
    "",
    command.objective,
    "",
    "## Rules",
    "",
    "- Treat Codex chat as the user interface; do not ask the user to memorize terminal commands.",
    "- Use the `yolo` skill and installed YOLO workflow descriptors when they are available.",
    "- If this is `/yolo` with freeform arguments, run `/yolo-status` when the safe stage is unclear; otherwise dispatch to `/yolo-demand`, `/yolo-spec`, `/yolo-tasks`, `/yolo-check`, `/yolo-run`, `/yolo-review`, or `/yolo-release` by intent.",
    "- When routing to `/yolo-demand`, act as a demand interview host: if slots are missing, ask one `next_question`, do not output long recommendation lists, do not enter PRD, and do not edit code.",
    "- If this is a legacy demand subcommand (`/yolo-brainstorm`, `/yolo-interview`, `/yolo-discover`, `/yolo-discuss`, or `/office-hours`), treat it as `/yolo-demand --stage <stage>` or `yolo demand --mode office-hours`.",
    "- Keep user-facing demand chat separate from evidence dispatch: evidence agent JSON role contracts belong only in provider sub-agent prompts spawned by `yolo demand dispatch`.",
    "- If this is another explicit `/yolo-*` command, honor that stage and enforce that command's safety rules.",
    ...demandHostRules(command),
    stageStopRule(command),
    executionApprovalRule(command),
    "- Default to `/yolo-status` or a no-code demand/tasks stage when lifecycle state or user intent is ambiguous.",
    `- Safety: ${command.safety}`,
    "- Require explicit user confirmation before code edits, user-level installs, publishing, credentials, or billable provider execution.",
    "- Stop and report blockers when PRD, scope, tests, provider, or gates are weak or unavailable.",
    "",
    "## Example",
    "",
    "```text",
    renderCommandUsage({ name: commandName }),
    "```",
    "",
  ].join("\n");
}

export function buildCodexSlashCommandSkill(commandName, { yoloRoot = DEFAULT_YOLO_ROOT } = {}) {
  const command = getYoloCommand(commandName);
  return [
    "---",
    `name: ${commandName}`,
    `description: "${codexMenuDescription(command)}"`,
    `argument-hint: "${command.argumentHint}"`,
    "allowed-tools:",
    ...allowedToolsForCommand(command),
    "---",
    "",
    `# /${commandName}`,
    "",
    `Use this skill when the user invokes \`/${commandName}\` in Codex.`,
    "",
    "## Command Template",
    "",
    `# /${commandName}`,
    "",
    `YOLO root: ${resolve(yoloRoot)}`,
    `Mode: ${command.mode}`,
    "",
    "## Objective",
    "",
    command.objective,
    "",
    "## Rules",
    "",
    "- Treat Codex chat as the user interface; do not ask the user to memorize terminal commands.",
    "- Use the YOLO CLI/SDK from the YOLO root only for this command's permitted stage.",
    "- Keep requirement, PRD/spec, tasks, review findings, fixes, gates, and evidence traceable.",
    commandName === "yolo"
      ? "- Treat `/yolo ...` as the fallback router when the user is not sure which stage to choose."
      : isDemandCompatibilityAlias(command)
        ? `- Treat this as a compatibility alias for \`${demandAliasSlashRoute(command)}\` (CLI: \`${demandAliasRoute(command)}\`); use the unified demand-stage protocol.`
        : "- Treat this as an explicit stage command; explain the stage boundary before taking action.",
    ...demandHostRules(command),
    stageStopRule(command),
    executionApprovalRule(command),
    "- Default to no-code demand discovery or planning when intent is ambiguous.",
    `- Safety: ${command.safety}`,
    "- Require explicit user confirmation before code edits, user-level installs, publishing, credentials, or billable provider execution.",
    "- Stop and report blockers when PRD, scope, tests, provider, or gates are weak or unavailable.",
    "",
    "## Example",
    "",
    "```text",
    renderCommandUsage({ name: commandName }),
    "```",
    "",
  ].join("\n");
}

function nativeSkillFile({ projectRoot, homeDir, target, scope, yoloRoot }) {
  const baseDir = scope === "user" ? homeDir : projectRoot;
  const path = target === "claude"
    ? join(baseDir, scope === "user" ? ".claude/skills/yolo/SKILL.md" : ".claude/skills/yolo/SKILL.md")
    : join(baseDir, scope === "user" ? ".agents/skills/yolo/SKILL.md" : ".codex/skills/yolo/SKILL.md");
  return {
    target,
    scope,
    path,
    relative_path: displayRelativePath(baseDir, path, scope),
    role: "native_yolo_skill",
    content: buildYoloNativeSkill({ agent: target, yoloRoot }),
  };
}

function writePlainArtifact({ file, dryRun, force, written, planned, overwritten, skipped }) {
  if (dryRun) {
    planned.push(file.relative_path);
    return;
  }

  const exists = existsSync(file.path);
  if (exists && !force) {
    skipped.push(file.relative_path);
    return;
  }

  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.content, "utf8");
  if (exists) overwritten.push(file.relative_path);
  else written.push(file.relative_path);
}

const MAX_INSTALL_FILE_COUNT = 12;

export function buildAgentBridgeInstallPlan(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const yoloRoot = resolve(options.yoloRoot || DEFAULT_YOLO_ROOT);
  const homeDir = resolve(options.homeDir || options.home_dir || homedir());
  const targets = normalizeAgentTargets(options.targets || "both");
  const scopes = asScopes(options);
  const wantsProject = scopes.includes("project");

  const files = wantsProject ? targets.map((target) => ({
    target,
    scope: "project",
    path: instructionFileFor(projectRoot, target),
    relative_path: relativeToProject(projectRoot, instructionFileFor(projectRoot, target)),
    role: target === "claude" ? "claude_project_memory" : "codex_project_instructions",
    content: buildAgentBridgeBlock({ agent: target, yoloRoot }),
  })) : [];

  const native_skill_files = scopes.flatMap((scope) =>
    targets.map((target) => nativeSkillFile({ projectRoot, homeDir, target, scope, yoloRoot }))
  );

  const claude_slash_commands = targets.includes("claude")
    ? scopes.flatMap((scope) => {
        const baseDir = scope === "user" ? homeDir : projectRoot;
        return listYoloCommands({ recommended: true }).map((command) => {
          const commandName = primarySlashNameForCommand(command);
          const path = join(baseDir, ".claude/commands", `${commandName}.md`);
          return {
            target: "claude",
            scope,
            path,
            relative_path: displayRelativePath(baseDir, path, scope),
            role: "claude_slash_command",
            command: commandName,
            content: buildClaudeSlashCommand(commandName, { yoloRoot }),
          };
        });
      })
    : [];

  const allFiles = [...files, ...native_skill_files, ...claude_slash_commands];

  return {
    schema: "yolo.agent_bridge_install_plan.v1",
    project_root: projectRoot,
    home_dir: homeDir,
    yolo_root: yoloRoot,
    targets,
    scopes,
    commands: commandDefinitions(),
    files,
    native_skill_files,
    claude_slash_commands,
    total_file_count: allFiles.length,
    within_budget: allFiles.length <= MAX_INSTALL_FILE_COUNT,
    writes_workspace: wantsProject,
    writes_user_home: scopes.includes("user"),
    publishes: false,
    reads_credentials: false,
    executes_provider: false,
  };
}

export function installAgentBridge(options = {}) {
  const plan = buildAgentBridgeInstallPlan(options);
  const dryRun = options.dryRun === true || options.dry_run === true;
  const force = options.force === true;
  const written = [];
  const planned = [];
  const skipped = [];
  const overwritten = [];

  for (const file of plan.files) {
    const existing = existsSync(file.path) ? readFileSync(file.path, "utf8") : "";
    const next = mergeAgentBridgeBlock(existing, file.content);
    if (dryRun) {
      planned.push(file.relative_path);
    } else {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, next, "utf8");
      if (existing) overwritten.push(file.relative_path);
      else written.push(file.relative_path);
    }
  }

  for (const file of [...plan.native_skill_files, ...plan.claude_slash_commands]) {
    writePlainArtifact({ file, dryRun, force, written, planned, overwritten, skipped });
  }

  return {
    schema: "yolo.agent_bridge_install_result.v1",
    status: "success",
    project_root: plan.project_root,
    home_dir: plan.home_dir,
    yolo_root: plan.yolo_root,
    targets: plan.targets,
    scopes: plan.scopes,
    writes_workspace: plan.writes_workspace,
    writes_user_home: plan.writes_user_home,
    dry_run: dryRun,
    planned,
    written,
    overwritten,
    skipped,
    total_file_count: plan.total_file_count,
    within_budget: plan.within_budget,
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
    },
    next_actions: [
      "Restart Codex or Claude Code if the host discovers skills only at startup.",
      "In Claude Code, run /yolo <你的需求>.",
      "In Codex, start a new session, then use /yolo <你的需求>; describe demand discussion, PRD, check, or run intent in that one entry.",
    ],
  };
}

function usage() {
  return [
    "用法:",
    "  node tools/install-agent-bridge.js /path/to/project",
    "  node tools/install-agent-bridge.js --project-root /path/to/project --target codex|claude|both",
    "  node tools/install-agent-bridge.js /path/to/project --scope project|user|both",
    "",
    "作用：安装 AGENTS.md / CLAUDE.md、Codex/Claude yolo skill、Claude slash commands（4 动词路由）。",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseAgentBridgeArgs();
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    const result = installAgentBridge(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
