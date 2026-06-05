#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWorkflowSkillInstallPlan,
  installWorkflowSkills,
} from "../src/workflows/install.js";
import {
  getYoloCommand,
  listYoloBridgeWorkflowIds,
  listYoloCommandNames,
  listYoloCommands,
  renderYoloCommandUsage,
} from "../src/workflows/command-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_YOLO_ROOT = resolve(__dirname, "..");
const BRIDGE_START = "<!-- yolo-agent-bridge:start -->";
const BRIDGE_END = "<!-- yolo-agent-bridge:end -->";
const DEFAULT_WORKFLOWS = listYoloBridgeWorkflowIds();
const DEFAULT_COMMANDS = listYoloCommandNames();
const CODEX_DIRECT_SLASH_COMMANDS = [];

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
    "> /yolo 你的需求，先只生成计划，不要改代码。",
    "",
    "When the user asks for YOLO, yolo流程, 从需求到落地, 自动开发, PRD落地, review/fix, 高质量迭代, or sends text starting with `/yolo`:",
    "",
    "1. Treat this chat as the user interface. Do not ask the user to memorize terminal commands.",
    "2. Read YOLO docs first when needed: `docs/agent-chat-usage.md`, `docs/non-technical-user-guide.md`, and `docs/public-sdk-contract.md` under the YOLO root.",
    "3. If the user invokes `/yolo ...`, route it yourself: choose brainstorm, interview, discovery, discussion, planning, PRD, check, run, review, accept, ship, learn, doctor, or install from the user's words.",
    "4. Treat `/yolo-demand` as the single demand-stage entry and user-facing demand interview host. Route brainstorm, interview, discovery, discussion, evidence dispatch, and PRD-readiness questions inside that demand stage.",
    "5. Default `/yolo-demand` to one-question mode: when required slots are missing, ask exactly one `next_question` in plain language and stop. Do not output long recommendation lists, do not enter PRD, and do not edit code.",
    "6. Keep audiences separated: this user-facing chat prompt must not include evidence agent JSON role contracts. Evidence dispatch prompts are only for provider sub-agents spawned by `yolo demand dispatch`.",
    "7. If the user invokes a legacy demand subcommand such as `/yolo-brainstorm`, `/yolo-interview`, `/yolo-discover`, or `/yolo-discuss`, treat it as a compatibility alias for `/yolo-demand --stage <stage>` and enforce the same demand-stage protocol.",
    "8. If the user invokes a post-demand explicit stage command such as `/yolo-plan`, `/yolo-prd`, `/yolo-check`, or `/yolo-run`, honor that stage and enforce its safety rules.",
    "9. A stage command is terminal for the current turn unless it is `/yolo-run` or `/yolo-fix`: finish only that stage, report artifacts/blockers, and suggest the next `/yolo-*` command.",
    "10. For `/yolo-demand`, demand aliases, `/yolo-plan`, `/yolo-prd`, and `/yolo-check`, do not continue into downstream stages in the same response, even if the user says the result looks good.",
    "11. User approval of a demand discussion, plan, PRD, or check means permission to move to the next stage, not permission to edit code. 批准最后: demand approval comes after slots are concrete, and execution approval remains separate.",
    "12. When unsure, run `/yolo-next` first and follow the lifecycle guard recommendation instead of choosing a downstream stage yourself.",
    "13. Before real edits, verify the project is initialized, `/yolo-check` passed through the lifecycle guard, and the user explicitly approved execution.",
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

function codexSkillRootFor({ baseDir, scope }) {
  return join(baseDir, scope === "user" ? ".agents/skills" : ".codex/skills");
}

function codexBackupRootFor({ baseDir, scope }) {
  return join(baseDir, scope === "user" ? ".agents/yolo-menu-backups" : ".codex/yolo-menu-backups");
}

function asScopes(options = {}) {
  if (Array.isArray(options.scopes)) return options.scopes;
  return normalizeInstallScopes(options.scope || options.installScope || options.install_scope || "project");
}

function commandDefinitions() {
  return listYoloCommands();
}

function renderCommandUsage(commandInput) {
  return renderYoloCommandUsage(commandInput);
}

function codexMenuDescription(command = {}) {
  const descriptions = {
    yolo: "不确定该走哪一步时用：自动判断需求挖掘、计划、PRD、检查、执行、review、验收或交付；默认不改代码。",
    "yolo-demand": "统一需求访谈主持入口：缺槽位时 one-question 只问一个 next_question；不输出大段建议、不进 PRD、不改代码。",
    "yolo-brainstorm": "兼容别名：等同于 /yolo-demand --stage brainstorm；想法很早期时用，不改代码。",
    "yolo-interview": "兼容别名：等同于 /yolo-demand --stage interview；沿用 one-question/next_question 访谈主持规则，不改代码。",
    "yolo-discover": "兼容别名：等同于 /yolo-demand --stage discover；需求模糊时用，不改代码。",
    "yolo-discuss": "兼容别名：等同于 /yolo-demand --stage discuss；需求需要深入讨论时用，不改代码。",
    "yolo-init": "第一次接入项目时用：生成 .yolo 记忆、生命周期、state 和 specs 骨架；不改业务代码。",
    "yolo-setup": "一键安全接入项目时用：判断新项目/半开发/已初始化状态，安装 YOLO 骨架和 agent 入口，并跑 doctor；不补录业务现状。",
    "yolo-plan": "需求已基本清楚时用：生成执行计划和任务拆解；不改代码。",
    "yolo-prd": "计划/需求已确认时用：编译可执行 prd.json/spec；不改代码。",
    "yolo-check": "执行前用：检查 PRD、范围、gate、adapter、证据计划是否可执行；不改代码。",
    "yolo-next": "不知道下一步时用：读取 lifecycle 状态，只报告当前唯一安全的下一步；不改代码。",
    "yolo-run": "明确确认执行时用：运行已通过检查的 PRD；可能改代码，必须有批准。",
    "yolo-review": "实现后或有 diff 时用：审查质量、风险、回归和缺失测试；默认不改代码。",
    "yolo-fix": "review 有已批准阻塞项时用：按 fix 任务修复并重跑 gate；可能改代码。",
    "yolo-accept": "功能做完后用：收集产品、运行、UI 和证据验收结果；不改代码。",
    "yolo-ui-review": "前端界面验收时用：检查 UI 状态、可访问性、错误和截图证据；默认不改代码。",
    "yolo-eval": "评估 YOLO 自身质量时用：跑 benchmark/rubric；不改业务代码。",
    "yolo-ship": "交付前用：判断是否可交付，列出阻塞、证据和回滚说明；不发布。",
    "yolo-learn": "交付或踩坑后用：把可复用经验写入记忆；不改业务代码。",
    "yolo-doctor": "不知道项目是否装好时用：只读检查 YOLO 初始化、集成和状态；不改代码。",
    "yolo-install": "需要安装/更新集成时用：写 AGENTS/CLAUDE/skills/commands；执行前说明文件。",
  };
  return descriptions[command.name] || command.description || "";
}

function isDemandCompatibilityAlias(command = {}) {
  return command.alias_for === "yolo-demand" && command.visibility === "compatibility_alias";
}

function demandAliasRoute(command = {}) {
  return isDemandCompatibilityAlias(command)
    ? `/yolo-demand --stage ${command.demand_stage || command.mode}`
    : "";
}

function isWriteCommand(command = {}) {
  return command.writes_code === true
    || command.name === "yolo-run"
    || command.name === "yolo-fix"
    || command.name === "yolo-init"
    || command.name === "yolo-setup"
    || command.name === "yolo-install";
}

function allowedToolsForCommand(command = {}) {
  const tools = ["Read", "Bash", "Glob", "Grep"];
  if (isWriteCommand(command)) {
    tools.push("Edit", "Write");
  }
  return tools.map((tool) => `  - ${tool}`);
}

function stageStopRule(command = {}) {
  if (command.name === "yolo") {
    return "- `/yolo` may route to the safest current stage, but it must still stop at that stage unless the user explicitly invoked `/yolo-run` or `/yolo-fix` with a checked PRD.";
  }
  if (command.name === "yolo-demand") {
    return "- `/yolo-demand` is the unified demand-stage interview host. Route internally between brainstorm, interview, discover, discuss, status, evidence dispatch, and PRD-readiness. If slots are missing, ask exactly one `next_question` and stop; do not enter `/yolo-prd` in the same response.";
  }
  if (isDemandCompatibilityAlias(command)) {
    return `- Compatibility alias: treat this command as \`${demandAliasRoute(command)}\` and use the unified /yolo-demand protocol. Finish only that demand sub-stage; if slots are missing, ask one \`next_question\` and stop with handoff state.`;
  }
  if (isWriteCommand(command)) {
    return "- This is a write-capable stage. Start only after explicit user approval, a checked PRD/fix scope, and passing gates; stop on the first blocker.";
  }
  return "- Stage stop: complete only this command's stage, then stop with artifacts, blockers, and the next recommended `/yolo-*` command. Do not advance to plan, PRD, check, run, fix, or source-code edits in the same response.";
}

function demandHostRules(command = {}) {
  if (command.name !== "yolo-demand" && !isDemandCompatibilityAlias(command)) return [];
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
      ? `- This command is a compatibility alias for \`${demandAliasRoute(command)}\`; use the unified demand-stage protocol.`
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

export function buildYoloNativeSkill({ agent = "codex", yoloRoot = DEFAULT_YOLO_ROOT } = {}) {
  const label = agent === "claude" ? "Claude Code" : "Codex";
  const recommendedCommands = listYoloCommands({ recommended: true });
  const demandAliases = listYoloCommands({ compatibilityAliases: true });
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
    "> /yolo 你的需求，先只生成计划，不要改代码。",
    "",
    "Codex fallback when slash routing is not active:",
    "",
    "> 使用 yolo skill 执行 /yolo：你的需求，先只生成计划，不要改代码。",
    "",
    "If the user asks to talk through a requirement, use `/yolo-demand` as the single demand-stage entry instead of asking them to choose brainstorm/interview/discover/discuss.",
    "",
    "`/yolo-demand` defaults to one-question mode: when slots are missing, ask exactly one `next_question`, do not output long recommendation lists, do not enter PRD, and do not edit code. 批准最后; execution approval is separate.",
    "",
    "Recommended user commands:",
    "",
    ...recommendedCommands.map((command) =>
      `- \`/${command.name}\`: ${codexMenuDescription(command)}`
    ),
    "",
    "Compatibility aliases for older demand-stage commands:",
    "",
    ...demandAliases.map((command) =>
      `- \`/${command.name}\` -> \`${demandAliasRoute(command)}\`: ${codexMenuDescription(command)}`
    ),
    "",
    "## Execution Contract",
    "",
    "- Treat chat as the UI. The user describes goals; the agent invokes YOLO.",
    "- Read project instructions and YOLO docs before acting when context is missing.",
    "- Stage commands are stop points: after `/yolo-demand`, any demand compatibility alias, `/yolo-plan`, `/yolo-prd`, or `/yolo-check`, report artifacts and ask for the next stage instead of continuing automatically.",
    "- `/yolo-brainstorm`, `/yolo-interview`, `/yolo-discover`, and `/yolo-discuss` are compatibility aliases; apply the same one-question, next_question, evidence, assumption, verification, and stage-stop rules as `/yolo-demand`.",
    "- Keep audience separation: user-facing demand chat must not include evidence agent JSON role contracts; evidence dispatch prompts are only for provider sub-agents spawned by `yolo demand dispatch`.",
    "- When unsure, use `/yolo-next` to read lifecycle state and follow the guard recommendation before selecting any downstream command.",
    "- Confirming a brainstorm, discussion, plan, PRD, or check is not permission to edit code; execution still requires `/yolo-run` or `/yolo-fix` with a checked PRD/fix scope.",
    "- Keep all changes scoped to the user's target project, not the YOLO package root.",
    "- Require explicit confirmation before code edits or user-level installs.",
    "- Fail closed on weak PRD, unclear file scope, unavailable provider, failing gate, or missing verification.",
    "- Explain results in business language and include artifact paths.",
    "",
  ].join("\n");
}

function buildGenericCommandMarkdown(commandName, { yoloRoot = DEFAULT_YOLO_ROOT } = {}) {
  const command = getYoloCommand(commandName);
  return [
    "---",
    `name: ${commandName}`,
    `description: ${command.description}`,
    `argument-hint: "${command.argumentHint}"`,
    "uses:",
    "  - yolo",
    "outputs:",
    "  - YOLO workflow result or blocking gate report",
    "---",
    "",
    `# /${commandName}`,
    "",
    `YOLO root: ${resolve(yoloRoot)}`,
    "",
    command.objective,
    "",
    "## Rules",
    "",
    "- Use the `yolo` skill and installed workflow skills.",
    "- Do not ask the user to run terminal commands manually.",
    isDemandCompatibilityAlias(command)
      ? `- This command is a compatibility alias for \`${demandAliasRoute(command)}\`; use the unified demand-stage protocol.`
      : "- Follow this command's declared stage and lifecycle boundary.",
    ...demandHostRules(command),
    stageStopRule(command),
    executionApprovalRule(command),
    "- Start plan-only unless this command explicitly requires checking or execution.",
    `- ${command.safety}`,
    "- Stop and report blockers when a gate cannot pass.",
    "",
  ].join("\n");
}

export function buildCodexSourceCommandSkill(commandName, { yoloRoot = DEFAULT_YOLO_ROOT } = {}) {
  const command = getYoloCommand(commandName);
  const aliases = commandName === "yolo"
    ? "`/yolo`, `/yolo plan`, `/yolo check`, `/yolo run`, or `/yolo review`"
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
    "- If this is `/yolo` with freeform arguments, run `/yolo-next` when the safe stage is unclear; otherwise dispatch to `/yolo-demand`, `/yolo-plan`, `/yolo-prd`, `/yolo-check`, `/yolo-run`, `/yolo-review`, `/yolo-accept`, `/yolo-ship`, `/yolo-learn`, `/yolo-doctor`, or `/yolo-install` by intent.",
    "- When routing to `/yolo-demand`, act as a demand interview host: if slots are missing, ask one `next_question`, do not output long recommendation lists, do not enter PRD, and do not edit code.",
    "- If this is a legacy demand subcommand (`/yolo-brainstorm`, `/yolo-interview`, `/yolo-discover`, `/yolo-discuss`), treat it as `/yolo-demand --stage <stage>`.",
    "- Keep user-facing demand chat separate from evidence dispatch: evidence agent JSON role contracts belong only in provider sub-agent prompts spawned by `yolo demand dispatch`.",
    "- If this is another explicit `/yolo-*` command, honor that stage and enforce that command's safety rules.",
    ...demandHostRules(command),
    stageStopRule(command),
    executionApprovalRule(command),
    "- Default to plan-only, or `/yolo-next` when lifecycle state is unclear, when the user intent is ambiguous.",
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
        ? `- Treat this as a compatibility alias for \`${demandAliasRoute(command)}\`; use the unified demand-stage protocol.`
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

function commandFilesFor({ projectRoot, homeDir, target, scope, yoloRoot }) {
  const baseDir = scope === "user" ? homeDir : projectRoot;
  if (target === "claude") {
    return DEFAULT_COMMANDS.map((command) => {
      const path = join(baseDir, ".claude/commands", `${command}.md`);
      return {
        target,
        scope,
        path,
        relative_path: displayRelativePath(baseDir, path, scope),
        role: "claude_slash_command",
        command,
        host_support: "native_claude_code_slash_command",
        content: buildClaudeSlashCommand(command, { yoloRoot }),
      };
    });
  }

  const commandDir = scope === "user"
    ? ".agents/skills/yolo/commands"
    : ".codex/skills/yolo/commands";
  return DEFAULT_COMMANDS.map((command) => {
    const path = join(baseDir, commandDir, `${command}.md`);
    return {
      target,
      scope,
      path,
      relative_path: displayRelativePath(baseDir, path, scope),
      role: "codex_skill_command_doc",
      command,
      host_support: "skill_discovery_command_alias",
      content: buildGenericCommandMarkdown(command, { yoloRoot }),
    };
  });
}

function codexSourceCommandFilesFor({ projectRoot, homeDir, scope, yoloRoot }) {
  const baseDir = scope === "user" ? homeDir : projectRoot;
  const targetDir = scope === "user" ? ".agents/skills" : ".codex/skills";
  return ["yolo"].map((command) => {
    const path = join(baseDir, targetDir, `source-command-${command}`, "SKILL.md");
    return {
      target: "codex",
      scope,
      path,
      relative_path: displayRelativePath(baseDir, path, scope),
      role: "codex_source_command_skill",
      command,
      host_support: "codex_source_command_skill",
      content: buildCodexSourceCommandSkill(command, { yoloRoot }),
    };
  });
}

function legacyCodexCleanupFilesFor({ projectRoot, homeDir, scope }) {
  const baseDir = scope === "user" ? homeDir : projectRoot;
  const targetDir = scope === "user" ? ".agents/skills" : ".codex/skills";
  const backupRoot = codexBackupRootFor({ baseDir, scope });
  return DEFAULT_COMMANDS
    .filter((command) => command !== "yolo")
    .map((command) => {
      const relativePath = join(targetDir, `source-command-${command}`);
      return {
        target: "codex",
        scope,
        path: join(baseDir, relativePath),
        relative_path: displayRelativePath(baseDir, join(baseDir, relativePath), scope),
        backup_root: backupRoot,
        backup_kind: "legacy-source-commands",
        role: "legacy_codex_source_command_skill",
        command,
        cleanup: "archive",
        reason: "Only source-command-yolo should remain visible; per-stage source-command-yolo-* skills are legacy menu noise.",
      };
    });
}

function legacyCodexWorkflowSkillMarkdownFilesFor({ projectRoot, homeDir, scope }) {
  const baseDir = scope === "user" ? homeDir : projectRoot;
  const targetDir = scope === "user" ? ".agents/skills/yolo/workflows" : ".codex/skills";
  const backupRoot = codexBackupRootFor({ baseDir, scope });
  return DEFAULT_WORKFLOWS.map((workflow) => {
    const relativePath = join(targetDir, `yolo.${workflow}`, "SKILL.md");
    return {
      target: "codex",
      scope,
      path: join(baseDir, relativePath),
      relative_path: displayRelativePath(baseDir, join(baseDir, relativePath), scope),
      backup_root: backupRoot,
      backup_kind: "legacy-workflow-skill-markdown",
      backup_name: `yolo.${workflow}-SKILL.md`,
      role: "legacy_codex_workflow_skill_markdown",
      workflow,
      cleanup: "archive",
      reason: "Internal yolo.* workflow descriptors must use WORKFLOW.md, not top-level SKILL.md that appears in Codex menus.",
    };
  });
}

function legacyCodexDirectSlashSkillFilesFor({ projectRoot, homeDir, scope }) {
  const baseDir = scope === "user" ? homeDir : projectRoot;
  const targetDir = scope === "user" ? ".agents/skills" : ".codex/skills";
  const backupRoot = codexBackupRootFor({ baseDir, scope });
  const directCommands = DEFAULT_COMMANDS.filter((command) =>
    command !== "yolo" && !CODEX_DIRECT_SLASH_COMMANDS.includes(command)
  );
  return directCommands.map((command) => {
    const relativePath = join(targetDir, command);
    return {
      target: "codex",
      scope,
      path: join(baseDir, relativePath),
      relative_path: displayRelativePath(baseDir, join(baseDir, relativePath), scope),
      backup_root: backupRoot,
      backup_kind: "legacy-direct-slash-skills",
      role: "legacy_codex_direct_slash_skill",
      command,
      cleanup: "archive",
      reason: "Codex should expose YOLO as one visible /yolo entry; per-stage yolo-* top-level skills are legacy menu noise.",
    };
  });
}

function legacyCodexSkillRootBackupDirectoriesFor({ projectRoot, homeDir, scope }) {
  const baseDir = scope === "user" ? homeDir : projectRoot;
  const skillRoot = codexSkillRootFor({ baseDir, scope });
  if (!existsSync(skillRoot)) return [];
  return readdirSync(skillRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(".yolo-menu-backup-"))
    .map((entry) => {
      const path = join(skillRoot, entry.name);
      return {
        target: "codex",
        scope,
        path,
        relative_path: displayRelativePath(baseDir, path, scope),
        backup_root: codexBackupRootFor({ baseDir, scope }),
        backup_kind: "skills-root-backups",
        backup_name: entry.name,
        role: "legacy_codex_skill_root_backup",
        cleanup: "archive",
        reason: "Backups inside a skills root can still be discovered as menu commands; move them outside the scanned root.",
      };
    });
}

function codexSlashCommandFilesFor({ projectRoot, homeDir, scope, yoloRoot }) {
  const baseDir = scope === "user" ? homeDir : projectRoot;
  const targetDir = scope === "user" ? ".agents/skills" : ".codex/skills";
  return CODEX_DIRECT_SLASH_COMMANDS.map((command) => {
    const path = join(baseDir, targetDir, command, "SKILL.md");
    return {
      target: "codex",
      scope,
      path,
      relative_path: displayRelativePath(baseDir, path, scope),
      role: "codex_slash_command_skill",
      command,
      host_support: "codex_direct_skill_slash_command",
      content: buildCodexSlashCommandSkill(command, { yoloRoot }),
    };
  });
}

function workflowSkillPlanFor({ projectRoot, homeDir, target, scope }) {
  const skillMarkdownFile = target === "codex" ? "WORKFLOW.md" : "SKILL.md";
  if (scope === "user") {
    const userRoot = resolve(homeDir);
    const targetDir = target === "claude"
      ? join(userRoot, ".claude/skills/yolo/workflows")
      : join(userRoot, ".agents/skills/yolo/workflows");
    return {
      ...buildWorkflowSkillInstallPlan({
        projectRoot: userRoot,
        target: target === "claude" ? "claude" : "agents",
        targetDir,
        workflows: DEFAULT_WORKFLOWS,
        agent: target,
        skillMarkdownFile,
      }),
      scope,
      agent_target: target,
    };
  }

  return {
    ...buildWorkflowSkillInstallPlan({
      projectRoot,
      target,
      workflows: DEFAULT_WORKFLOWS,
      agent: target,
      skillMarkdownFile,
    }),
    scope,
    agent_target: target,
  };
}

export function buildAgentBridgeInstallPlan(options = {}) {
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const yoloRoot = resolve(options.yoloRoot || DEFAULT_YOLO_ROOT);
  const homeDir = resolve(options.homeDir || options.home_dir || homedir());
  const targets = normalizeAgentTargets(options.targets || "both");
  const scopes = asScopes(options);
  const wantsProject = scopes.includes("project");
  const wantsCommands = options.commands !== false && options.installCommands !== false;
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
  const command_files = wantsCommands
    ? scopes.flatMap((scope) => targets.flatMap((target) =>
      commandFilesFor({ projectRoot, homeDir, target, scope, yoloRoot })
    ))
    : [];
  const source_command_files = wantsCommands && targets.includes("codex")
    ? scopes.flatMap((scope) => codexSourceCommandFilesFor({ projectRoot, homeDir, scope, yoloRoot }))
    : [];
  const legacy_cleanup_files = wantsCommands && targets.includes("codex")
    ? scopes.flatMap((scope) => legacyCodexCleanupFilesFor({ projectRoot, homeDir, scope }))
      .concat(scopes.flatMap((scope) => legacyCodexWorkflowSkillMarkdownFilesFor({ projectRoot, homeDir, scope })))
      .concat(scopes.flatMap((scope) => legacyCodexDirectSlashSkillFilesFor({ projectRoot, homeDir, scope })))
      .concat(scopes.flatMap((scope) => legacyCodexSkillRootBackupDirectoriesFor({ projectRoot, homeDir, scope })))
    : [];
  const codex_slash_command_files = wantsCommands && targets.includes("codex")
    ? scopes.flatMap((scope) => codexSlashCommandFilesFor({ projectRoot, homeDir, scope, yoloRoot }))
    : [];
  const skill_plans = scopes.flatMap((scope) =>
    targets.map((target) => workflowSkillPlanFor({ projectRoot, homeDir, target, scope }))
  );

  return {
    schema: "yolo.agent_bridge_install_plan.v1",
    project_root: projectRoot,
    home_dir: homeDir,
    yolo_root: yoloRoot,
    targets,
    scopes,
    commands: wantsCommands ? commandDefinitions() : [],
    files,
    native_skill_files,
    command_files,
    source_command_files,
    legacy_cleanup_files,
    codex_slash_command_files,
    skill_plans,
    writes_workspace: wantsProject,
    writes_user_home: scopes.includes("user"),
    publishes: false,
    reads_credentials: false,
    executes_provider: false,
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

function archiveLegacyArtifact({ file, dryRun, cleanupStamp, legacyCleanupPlanned, legacyArchived }) {
  if (!existsSync(file.path)) return;
  if (dryRun) {
    legacyCleanupPlanned.push(file.relative_path);
    return;
  }
  const backupRoot = join(file.backup_root || dirname(file.path), `.yolo-menu-backup-${cleanupStamp}`, file.backup_kind || "legacy-artifacts");
  let backupPath = join(backupRoot, file.backup_name || basename(file.path));
  let suffix = 2;
  while (existsSync(backupPath)) {
    backupPath = join(backupRoot, `${basename(file.path)}-${suffix}`);
    suffix += 1;
  }
  mkdirSync(dirname(backupPath), { recursive: true });
  renameSync(file.path, backupPath);
  legacyArchived.push({
    relative_path: file.relative_path,
    backup_path: backupPath,
    reason: file.reason,
  });
}

function collectSkillMarkdownFiles(rootPath) {
  if (!existsSync(rootPath)) return [];
  let entries;
  try {
    entries = readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return basename(rootPath) === "SKILL.md" ? [rootPath] : [];
  }

  return entries.flatMap((entry) => {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) return collectSkillMarkdownFiles(entryPath);
    return entry.name === "SKILL.md" ? [entryPath] : [];
  });
}

function archivedSkillMarkdownPath(filePath) {
  let candidate = `${filePath}.archived`;
  let suffix = 2;
  while (existsSync(candidate)) {
    candidate = `${filePath}.archived-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function quarantineCodexBackupSkillMarkdown({ projectRoot, homeDir, scopes, dryRun, legacyCleanupPlanned, legacyArchived }) {
  for (const scope of scopes) {
    const baseDir = scope === "user" ? homeDir : projectRoot;
    const backupRoot = codexBackupRootFor({ baseDir, scope });
    for (const skillMarkdownPath of collectSkillMarkdownFiles(backupRoot)) {
      const relativePath = displayRelativePath(baseDir, skillMarkdownPath, scope);
      if (dryRun) {
        legacyCleanupPlanned.push(relativePath);
        continue;
      }
      const archivedPath = archivedSkillMarkdownPath(skillMarkdownPath);
      renameSync(skillMarkdownPath, archivedPath);
      legacyArchived.push({
        relative_path: relativePath,
        backup_path: archivedPath,
        reason: "Archived backups must not retain SKILL.md filenames because broad host discovery can treat them as live menu commands.",
      });
    }
  }
}

export function installAgentBridge(options = {}) {
  const plan = buildAgentBridgeInstallPlan(options);
  const dryRun = options.dryRun === true || options.dry_run === true;
  const force = options.force === true;
  const cleanupStamp = clean(options.cleanupStamp || options.cleanup_stamp || options.now || new Date().toISOString())
    .replace(/[^0-9A-Za-z_-]+/g, "")
    .slice(0, 32) || "manual";
  const written = [];
  const planned = [];
  const skipped = [];
  const overwritten = [];
  const legacyCleanupPlanned = [];
  const legacyArchived = [];

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

  for (const file of [...plan.native_skill_files, ...plan.command_files, ...plan.source_command_files, ...plan.codex_slash_command_files]) {
    writePlainArtifact({ file, dryRun, force, written, planned, overwritten, skipped });
  }

  for (const file of plan.legacy_cleanup_files || []) {
    archiveLegacyArtifact({ file, dryRun, cleanupStamp, legacyCleanupPlanned, legacyArchived });
  }

  if (plan.targets.includes("codex") && (plan.commands || []).length > 0) {
    quarantineCodexBackupSkillMarkdown({
      projectRoot: plan.project_root,
      homeDir: plan.home_dir,
      scopes: plan.scopes,
      dryRun,
      legacyCleanupPlanned,
      legacyArchived,
    });
  }

  const skillInstalls = [];
  for (const skillPlan of plan.skill_plans) {
    if (dryRun) {
      skillInstalls.push({
        target: skillPlan.agent_target,
        install_target: skillPlan.target,
        scope: skillPlan.scope,
        target_dir: skillPlan.target_dir,
        status: "planned",
        created: [],
        skipped: skillPlan.files.map((file) => file.path),
      });
      continue;
    }

    const result = installWorkflowSkills({
      projectRoot: skillPlan.project_root,
      target: skillPlan.target,
      targetDir: skillPlan.target_dir,
      workflows: DEFAULT_WORKFLOWS,
      agent: skillPlan.agent_target,
      skillMarkdownFile: skillPlan.skill_markdown_file,
      force,
    });
    skillInstalls.push({
      ...result,
      scope: skillPlan.scope,
      agent_target: skillPlan.agent_target,
    });
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
    legacy_cleanup_planned: legacyCleanupPlanned,
    legacy_archived: legacyArchived,
    skill_installs: skillInstalls,
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
    },
    next_actions: [
      "Restart Codex or Claude Code if the host discovers skills only at startup.",
      "In Claude Code, run /yolo <你的需求>.",
      "In Codex, start a new session, then use /yolo <你的需求>; describe demand discussion, PRD, check, or run intent in that one entry. If the host has not refreshed, ask to use source-command-yolo or the yolo skill.",
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
    "作用：安装 AGENTS.md / CLAUDE.md、Codex/Claude skills、Claude slash commands、Codex 单一 /yolo 兜底入口，并清理旧的 Codex 菜单噪音。",
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
