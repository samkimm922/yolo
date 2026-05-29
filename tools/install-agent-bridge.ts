#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    "When the user asks for YOLO, yolo流程, 从需求到落地, 自动开发, PRD落地, review/fix, or 高质量迭代:",
    "",
    "1. Treat this chat as the user interface. Do not ask the user to memorize terminal commands.",
    "2. Read YOLO docs first when needed: `docs/agent-chat-usage.md`, `docs/non-technical-user-guide.md`, and `docs/public-sdk-contract.md` under the YOLO root.",
    "3. Default to a no-code-change plan first. Generate or inspect a plan before executing.",
    "4. Before real edits, verify the project is initialized, the PRD/preflight is clean, and the user explicitly approved execution.",
    "5. Use the YOLO CLI/SDK yourself from the YOLO root when execution is needed; the user should only describe the goal in chat.",
    "6. Fail closed on weak PRD, missing targets, missing tests, dirty risky workspace, provider unavailability, or gate failure.",
    "7. Report results in plain language with the generated report paths and remaining blockers.",
    "",
    "Safe default user phrase:",
    "",
    "> 使用 YOLO 处理这个需求：先只生成计划，不要改代码。",
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
  return listYoloCommands();
}

function renderCommandUsage(commandInput) {
  return renderYoloCommandUsage(commandInput);
}

export function buildClaudeSlashCommand(commandName, { yoloRoot = DEFAULT_YOLO_ROOT } = {}) {
  const command = getYoloCommand(commandName);

  return [
    "---",
    `name: ${commandName}`,
    `description: ${command.description}`,
    `argument-hint: "${command.argumentHint}"`,
    "allowed-tools:",
    "  - Read",
    "  - Bash",
    "  - Glob",
    "  - Grep",
    "  - Edit",
    "  - Write",
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
    "- Use YOLO CLI/SDK yourself from the YOLO root when execution is needed.",
    "- Keep requirement, PRD/spec, tasks, review findings, fixes, gates, and evidence traceable.",
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
    "- The user uses command-like text such as `/yolo`, `/yolo-brainstorm`, `/yolo-discuss`, `/yolo-discover`, `/yolo-plan`, `/yolo-prd`, `/yolo-check`, `/yolo-run`, `/yolo-review`, `/yolo-accept`, `/yolo-eval`, `/yolo-ship`, `/yolo-learn`, or `/yolo-doctor`.",
    "",
    "## Command Aliases",
    "",
    "One-sentence non-technical entry:",
    "",
    "> /yolo 你的需求，先只生成计划，不要改代码。",
    "",
    "Codex fallback when slash routing is not active:",
    "",
    "> 使用 yolo skill 执行 /yolo：你的需求，先只生成计划，不要改代码。",
    "",
    ...listYoloCommands().map((command) =>
      `- \`/${command.name}\`: ${command.description} ${command.writes_code ? "Can edit code only after explicit confirmation." : "Does not edit code by default."}`
    ),
    "",
    "## Execution Contract",
    "",
    "- Treat chat as the UI. The user describes goals; the agent invokes YOLO.",
    "- Read project instructions and YOLO docs before acting when context is missing.",
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
    "- If this is `/yolo` with freeform arguments, dispatch to plan/check/run/review/install by intent.",
    "- Default to plan-only when the user intent is ambiguous.",
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
    `description: "${command.description}"`,
    `argument-hint: "${command.argumentHint}"`,
    "allowed-tools:",
    "  - Read",
    "  - Bash",
    "  - Glob",
    "  - Grep",
    "  - Write",
    "  - Edit",
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
    "- Use the YOLO CLI/SDK from the YOLO root when execution is needed.",
    "- Keep requirement, PRD/spec, tasks, review findings, fixes, gates, and evidence traceable.",
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
  return DEFAULT_COMMANDS.map((command) => {
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

function codexSlashCommandFilesFor({ projectRoot, homeDir, scope, yoloRoot }) {
  const baseDir = scope === "user" ? homeDir : projectRoot;
  const targetDir = scope === "user" ? ".agents/skills" : ".codex/skills";
  return DEFAULT_COMMANDS.map((command) => {
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

  for (const file of [...plan.native_skill_files, ...plan.command_files, ...plan.source_command_files, ...plan.codex_slash_command_files]) {
    writePlainArtifact({ file, dryRun, force, written, planned, overwritten, skipped });
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
    skill_installs: skillInstalls,
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
    },
    next_actions: [
      "Restart Codex or Claude Code if the host discovers skills only at startup.",
      "In Claude Code, run /yolo <你的需求>.",
      "In Codex, start a new session, then try /yolo, /yolo-brainstorm, or /yolo-discuss; if the host has not refreshed, ask to use source-command-yolo or the yolo skill.",
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
    "作用：安装 AGENTS.md / CLAUDE.md、Codex/Claude skills、Claude slash commands，以及 Codex direct slash skills / source-command aliases。",
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
