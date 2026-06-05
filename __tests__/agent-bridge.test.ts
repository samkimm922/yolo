import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildAgentBridgeBlock,
  buildAgentBridgeInstallPlan,
  buildCodexSlashCommandSkill,
  buildCodexSourceCommandSkill,
  buildClaudeSlashCommand,
  buildYoloNativeSkill,
  installAgentBridge,
  mergeAgentBridgeBlock,
  normalizeAgentTargets,
  normalizeInstallScopes,
  parseAgentBridgeArgs,
} from "../tools/install-agent-bridge.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-agent-bridge-"));
}

function allowedTools(markdown) {
  const frontmatter = markdown.match(/^---\n(?<frontmatter>[\s\S]*?)\n---/)?.groups?.frontmatter ?? "";
  const lines = frontmatter.split("\n");
  const start = lines.indexOf("allowed-tools:");
  if (start < 0) return [];
  return lines
    .slice(start + 1)
    .filter((line) => line.startsWith("  - "))
    .map((line) => line.replace(/^  - /, ""));
}

describe("agent bridge installer", () => {
  test("normalizes codex and claude targets", () => {
    assert.deepEqual(normalizeAgentTargets("both"), ["codex", "claude"]);
    assert.deepEqual(normalizeAgentTargets("codex,claude"), ["codex", "claude"]);
    assert.deepEqual(normalizeAgentTargets("claude"), ["claude"]);
    assert.throws(() => normalizeAgentTargets("wat"), /Unknown agent target/);
  });

  test("normalizes project and user install scopes", () => {
    assert.deepEqual(normalizeInstallScopes("project"), ["project"]);
    assert.deepEqual(normalizeInstallScopes("user"), ["user"]);
    assert.deepEqual(normalizeInstallScopes("both"), ["project", "user"]);
    assert.deepEqual(normalizeInstallScopes("none"), []);
    assert.throws(() => normalizeInstallScopes("wat"), /Unknown install scope/);
  });

  test("parseAgentBridgeArgs accepts project root and target", () => {
    const args = parseAgentBridgeArgs(["/tmp/project", "--target", "codex", "--scope", "user", "--dry-run"]);
    assert.equal(args.projectRoot, "/tmp/project");
    assert.deepEqual(args.targets, ["codex"]);
    assert.deepEqual(args.scopes, ["user"]);
    assert.equal(args.dryRun, true);
  });

  test("buildAgentBridgeBlock tells agents that chat is the UI", () => {
    const block = buildAgentBridgeBlock({ agent: "codex", yoloRoot: "/tmp/yolo" });

    assert.match(block, /YOLO root: \/tmp\/yolo/);
    assert.match(block, /Primary fallback entrypoint/);
    assert.match(block, /single demand-stage entry/);
    assert.match(block, /one-question mode/);
    assert.match(block, /next_question/);
    assert.match(block, /do not enter PRD/);
    assert.match(block, /do not edit code/);
    assert.match(block, /批准最后/);
    assert.match(block, /Evidence dispatch prompts are only for provider sub-agents/);
    assert.match(block, /must not include evidence agent JSON role contracts/);
    assert.doesNotMatch(block, /Your protocol:/);
    assert.doesNotMatch(block, /Return one JSON object only to stdout/);
    assert.match(block, /compatibility alias for `\/yolo-demand --stage <stage>`/);
    assert.match(block, /honor that stage and enforce its safety rules/);
    assert.match(block, /A stage command is terminal for the current turn/);
    assert.match(block, /User approval of a demand discussion, plan, PRD, or check means permission to move to the next stage, not permission to edit code/);
    assert.match(block, /legacy internal names such as `\/Yolo\.brainstorm`/);
    assert.match(block, /Treat this chat as the user interface/);
    assert.match(block, /先只生成计划，不要改代码/);
  });

  test("mergeAgentBridgeBlock appends or replaces the managed block", () => {
    const block = buildAgentBridgeBlock({ agent: "claude", yoloRoot: "/tmp/yolo" });
    const first = mergeAgentBridgeBlock("# Existing\n", block);
    const second = mergeAgentBridgeBlock(first, buildAgentBridgeBlock({ agent: "claude", yoloRoot: "/tmp/yolo2" }));

    assert.match(first, /# Existing/);
    assert.match(first, /YOLO root: \/tmp\/yolo/);
    assert.match(second, /YOLO root: \/tmp\/yolo2/);
    assert.doesNotMatch(second, /YOLO root: \/tmp\/yolo\n/);
  });

  test("buildClaudeSlashCommand renders a real Claude Code slash command contract", () => {
    const command = buildClaudeSlashCommand("yolo-plan", { yoloRoot: "/tmp/yolo" });

    assert.match(command, /^---\nname: yolo-plan/m);
    assert.match(command, /# \/yolo-plan/);
    assert.match(command, /YOLO root: \/tmp\/yolo/);
    assert.match(command, /Plan-only\. Stop after plan artifacts/);
    assert.match(command, /not execution approval/);
  });

  test("demand slash command contract enforces interview-host behavior", () => {
    const command = buildClaudeSlashCommand("yolo-demand", { yoloRoot: "/tmp/yolo" });

    assert.match(command, /one-question mode/);
    assert.match(command, /next_question/);
    assert.match(command, /Do not output long recommendation lists/);
    assert.match(command, /do not compile or enter PRD/);
    assert.match(command, /do not edit code/);
    assert.match(command, /批准最后/);
    assert.match(command, /Evidence dispatch prompt content is only for provider sub-agents/);
  });

  test("Claude slash command tools are read-only for no-code stages and writable for execution/setup stages", () => {
    assert.deepEqual(allowedTools(buildClaudeSlashCommand("yolo-plan", { yoloRoot: "/tmp/yolo" })), [
      "Read",
      "Bash",
      "Glob",
      "Grep",
    ]);
    assert.deepEqual(allowedTools(buildClaudeSlashCommand("yolo-run", { yoloRoot: "/tmp/yolo" })), [
      "Read",
      "Bash",
      "Glob",
      "Grep",
      "Edit",
      "Write",
    ]);
    assert.deepEqual(allowedTools(buildClaudeSlashCommand("yolo-install", { yoloRoot: "/tmp/yolo" })), [
      "Read",
      "Bash",
      "Glob",
      "Grep",
      "Edit",
      "Write",
    ]);
  });

  test("buildYoloNativeSkill documents command aliases for Codex skill discovery", () => {
    const skill = buildYoloNativeSkill({ agent: "codex", yoloRoot: "/tmp/yolo" });

    assert.match(skill, /^---\nname: yolo/m);
    assert.match(skill, /How To Choose/);
    assert.match(skill, /Recommended user commands/);
    assert.match(skill, /Compatibility aliases for older demand-stage commands/);
    assert.match(skill, /\/yolo-demand/);
    assert.match(skill, /\/yolo-plan/);
    assert.match(skill, /\/yolo-interview/);
    assert.match(skill, /\/yolo-discover/);
    assert.match(skill, /\/yolo-discuss/);
    assert.match(skill, /\/yolo-doctor/);
    assert.match(skill, /one-question mode/);
    assert.match(skill, /next_question/);
    assert.match(skill, /do not output long recommendation lists/);
    assert.match(skill, /do not enter PRD/);
    assert.match(skill, /批准最后/);
    assert.match(skill, /evidence dispatch prompts are only for provider sub-agents/);
    assert.match(skill, /Stage commands are stop points/);
    assert.match(skill, /Confirming a brainstorm, discussion, plan, PRD, or check is not permission to edit code/);
    assert.match(skill, /Require explicit confirmation before code edits/);
  });

  test("buildCodexSourceCommandSkill follows local Codex source-command convention", () => {
    const skill = buildCodexSourceCommandSkill("yolo", { yoloRoot: "/tmp/yolo" });

    assert.match(skill, /^---\nname: "source-command-yolo"/m);
    assert.match(skill, /\/yolo plan/);
    assert.match(skill, /YOLO root: \/tmp\/yolo/);
    assert.match(skill, /legacy demand subcommand/);
    assert.match(skill, /ask one `next_question`/);
    assert.match(skill, /do not output long recommendation lists/);
    assert.match(skill, /do not enter PRD/);
    assert.match(skill, /do not edit code/);
    assert.match(skill, /evidence agent JSON role contracts belong only in provider sub-agent prompts/);
    assert.match(skill, /another explicit `\/yolo-\*` command/);
    assert.match(skill, /must still stop at that stage/);
    assert.match(skill, /not execution approval/);
    assert.match(skill, /Default to plan-only/);
  });

  test("buildCodexSlashCommandSkill follows direct Codex slash skill convention", () => {
    const skill = buildCodexSlashCommandSkill("yolo-brainstorm", { yoloRoot: "/tmp/yolo" });

    assert.match(skill, /^---\nname: yolo-brainstorm/m);
    assert.match(skill, /# \/yolo-brainstorm/);
    assert.match(skill, /YOLO root: \/tmp\/yolo/);
    assert.match(skill, /compatibility alias for `\/yolo-demand --stage brainstorm`/);
    assert.match(skill, /use the unified demand-stage protocol/);
    assert.match(skill, /one-question mode/);
    assert.match(skill, /next_question/);
    assert.match(skill, /批准最后/);
    assert.match(skill, /Evidence dispatch prompt content is only for provider sub-agents/);
    assert.match(skill, /Brainstorm-only/);
    assert.doesNotMatch(skill, /when execution is needed/);
  });

  test("Codex slash command tools are read-only for no-code stages and writable for execution/setup stages", () => {
    const noCode = buildCodexSlashCommandSkill("yolo-check", { yoloRoot: "/tmp/yolo" });
    const run = buildCodexSlashCommandSkill("yolo-run", { yoloRoot: "/tmp/yolo" });
    const init = buildCodexSlashCommandSkill("yolo-init", { yoloRoot: "/tmp/yolo" });

    assert.deepEqual(allowedTools(noCode), ["Read", "Bash", "Glob", "Grep"]);
    assert.doesNotMatch(noCode, /^  - Write$/m);
    assert.doesNotMatch(noCode, /^  - Edit$/m);
    assert.deepEqual(allowedTools(run), ["Read", "Bash", "Glob", "Grep", "Edit", "Write"]);
    assert.deepEqual(allowedTools(init), ["Read", "Bash", "Glob", "Grep", "Edit", "Write"]);
    assert.match(noCode, /Stage stop: complete only this command's stage/);
    assert.match(noCode, /not execution approval/);
  });

  test("buildAgentBridgeInstallPlan plans AGENTS, CLAUDE, and workflow skill targets without writing", () => {
    const projectRoot = tempProject();
    const plan = buildAgentBridgeInstallPlan({ projectRoot, yoloRoot: "/tmp/yolo", targets: "both" });

    assert.equal(plan.schema, "yolo.agent_bridge_install_plan.v1");
    assert.deepEqual(plan.targets, ["codex", "claude"]);
    assert.deepEqual(plan.files.map((file) => file.relative_path), ["AGENTS.md", "CLAUDE.md"]);
    assert.deepEqual(plan.native_skill_files.map((file) => file.relative_path), [
      ".codex/skills/yolo/SKILL.md",
      ".claude/skills/yolo/SKILL.md",
    ]);
    assert.equal(plan.command_files.some((file) => file.relative_path === ".claude/commands/yolo-plan.md"), true);
    assert.equal(plan.command_files.some((file) => file.relative_path === ".claude/commands/yolo-interview.md"), true);
    assert.equal(plan.command_files.some((file) => file.relative_path === ".claude/commands/yolo-discuss.md"), true);
    assert.equal(plan.command_files.some((file) => file.relative_path === ".claude/commands/yolo-discover.md"), true);
    assert.equal(plan.command_files.some((file) => file.relative_path === ".claude/commands/yolo-doctor.md"), true);
    assert.equal(plan.command_files.some((file) => file.relative_path === ".codex/skills/yolo/commands/yolo-plan.md"), true);
    assert.equal(plan.command_files.some((file) => file.relative_path === ".codex/skills/yolo/commands/yolo-prd.md"), true);
    assert.deepEqual(plan.source_command_files.map((file) => file.relative_path), [".codex/skills/source-command-yolo/SKILL.md"]);
    assert.equal(plan.legacy_cleanup_files.some((file) => file.relative_path === ".codex/skills/source-command-yolo-plan"), true);
    assert.equal(plan.legacy_cleanup_files.some((file) => file.relative_path === ".codex/skills/source-command-yolo"), false);
    assert.equal(plan.legacy_cleanup_files.some((file) => file.relative_path === ".codex/skills/yolo.pi/SKILL.md"), true);
    assert.deepEqual(plan.codex_slash_command_files, []);
    assert.equal(plan.legacy_cleanup_files.some((file) => file.relative_path === ".codex/skills/yolo-plan"), true);
    assert.equal(plan.legacy_cleanup_files.some((file) => file.relative_path === ".codex/skills/yolo-demand"), true);
    assert.equal(plan.skill_plans.find((item) => item.agent_target === "codex")?.files.some((file) => file.path === ".codex/skills/yolo.pi/WORKFLOW.md"), true);
    assert.equal(plan.skill_plans.find((item) => item.agent_target === "codex")?.files.some((file) => file.path === ".codex/skills/yolo.pi/SKILL.md"), false);
    assert.deepEqual(plan.skill_plans.map((item) => item.target_dir), [".codex/skills", ".claude/skills"]);
    assert.equal(existsSync(join(projectRoot, "AGENTS.md")), false);
  });

  test("installAgentBridge writes project instructions, skills, and command aliases", () => {
    const projectRoot = tempProject();
    writeFileSync(join(projectRoot, "AGENTS.md"), "# Existing Agent Rules\n", "utf8");
    mkdirSync(join(projectRoot, ".codex/skills/source-command-yolo-plan"), { recursive: true });
    writeFileSync(join(projectRoot, ".codex/skills/source-command-yolo-plan/SKILL.md"), "# stale\n", "utf8");
    mkdirSync(join(projectRoot, ".codex/skills/yolo.pi"), { recursive: true });
    writeFileSync(join(projectRoot, ".codex/skills/yolo.pi/SKILL.md"), "# stale workflow\n", "utf8");
    mkdirSync(join(projectRoot, ".codex/skills/yolo-plan"), { recursive: true });
    writeFileSync(join(projectRoot, ".codex/skills/yolo-plan/SKILL.md"), "# stale direct slash\n", "utf8");
    mkdirSync(join(projectRoot, ".codex/skills/.yolo-menu-backup-old/legacy-source-commands/source-command-yolo-run"), { recursive: true });
    writeFileSync(join(projectRoot, ".codex/skills/.yolo-menu-backup-old/legacy-source-commands/source-command-yolo-run/SKILL.md"), "# stale backup\n", "utf8");
    mkdirSync(join(projectRoot, ".codex/yolo-menu-backups/existing/source-command-yolo-prd"), { recursive: true });
    writeFileSync(join(projectRoot, ".codex/yolo-menu-backups/existing/source-command-yolo-prd/SKILL.md"), "# existing archived skill\n", "utf8");
    const result = installAgentBridge({ projectRoot, yoloRoot: "/tmp/yolo", targets: "both" });

    assert.equal(result.status, "success");
    assert.equal(result.overwritten.includes("AGENTS.md"), true);
    assert.equal(result.written.includes("CLAUDE.md"), true);
    assert.equal(result.written.includes(".claude/commands/yolo-plan.md"), true);
    assert.equal(result.written.includes(".claude/commands/yolo-interview.md"), true);
    assert.equal(result.written.includes(".claude/commands/yolo-doctor.md"), true);
    assert.equal(result.written.includes(".codex/skills/yolo/SKILL.md"), true);
    assert.equal(result.written.includes(".codex/skills/source-command-yolo/SKILL.md"), true);
    assert.equal(result.written.includes(".codex/skills/source-command-yolo-plan/SKILL.md"), false);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/source-command-yolo-plan")), false);
    const sourceArchive = result.legacy_archived.find((item) => item.relative_path === ".codex/skills/source-command-yolo-plan");
    assert.equal(Boolean(sourceArchive), true);
    assert.equal(sourceArchive.backup_path.includes(".codex/skills/"), false);
    assert.equal(existsSync(join(sourceArchive.backup_path, "SKILL.md")), false);
    assert.equal(existsSync(join(sourceArchive.backup_path, "SKILL.md.archived")), true);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/yolo.pi/SKILL.md")), false);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/yolo.pi/WORKFLOW.md")), true);
    assert.equal(result.legacy_archived.some((item) => item.relative_path === ".codex/skills/yolo.pi/SKILL.md"), true);
    assert.equal(result.written.includes(".codex/skills/yolo-brainstorm/SKILL.md"), false);
    assert.equal(result.written.includes(".codex/skills/yolo-interview/SKILL.md"), false);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/yolo-plan/SKILL.md")), false);
    assert.equal(result.legacy_archived.some((item) => item.relative_path === ".codex/skills/yolo-plan"), true);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/.yolo-menu-backup-old")), false);
    assert.equal(result.legacy_archived.some((item) => item.relative_path === ".codex/skills/.yolo-menu-backup-old"), true);
    const movedSkillRootBackup = result.legacy_archived.find((item) => item.relative_path === ".codex/skills/.yolo-menu-backup-old");
    assert.equal(existsSync(join(movedSkillRootBackup.backup_path, "legacy-source-commands/source-command-yolo-run/SKILL.md")), false);
    assert.equal(existsSync(join(movedSkillRootBackup.backup_path, "legacy-source-commands/source-command-yolo-run/SKILL.md.archived")), true);
    assert.equal(existsSync(join(projectRoot, ".codex/yolo-menu-backups/existing/source-command-yolo-prd/SKILL.md")), false);
    assert.equal(existsSync(join(projectRoot, ".codex/yolo-menu-backups/existing/source-command-yolo-prd/SKILL.md.archived")), true);
    assert.equal(result.legacy_archived.some((item) => item.relative_path === ".codex/yolo-menu-backups/existing/source-command-yolo-prd/SKILL.md"), true);
    assert.match(readFileSync(join(projectRoot, ".codex/skills/yolo/SKILL.md"), "utf8"), /YOLO Native Skill for Codex/);
    assert.match(readFileSync(join(projectRoot, "AGENTS.md"), "utf8"), /# Existing Agent Rules/);
    assert.match(readFileSync(join(projectRoot, "AGENTS.md"), "utf8"), /YOLO Agent Bridge for Codex/);
    assert.match(readFileSync(join(projectRoot, "CLAUDE.md"), "utf8"), /YOLO Agent Bridge for Claude Code/);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/RULES.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/yolo.pi/WORKFLOW.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/yolo.interview/WORKFLOW.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/yolo.discover/WORKFLOW.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/yolo.doctor/WORKFLOW.md")), true);
    assert.match(readFileSync(join(projectRoot, ".codex/skills/yolo.brainstorm/WORKFLOW.md"), "utf8"), /not permission to advance to downstream workflows automatically/);
    assert.match(readFileSync(join(projectRoot, ".codex/skills/RULES.md"), "utf8"), /A selected workflow is terminal for the current turn/);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/yolo.pi/SKILL.md")), false);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/yolo/SKILL.md")), true);
    assert.equal(existsSync(join(projectRoot, ".claude/skills/triggers.json")), true);
    assert.equal(existsSync(join(projectRoot, ".claude/commands/yolo-run.md")), true);
  });

  test("dry-run reports planned files without writing", () => {
    const projectRoot = tempProject();
    mkdirSync(join(projectRoot, ".codex/skills/source-command-yolo-check"), { recursive: true });
    writeFileSync(join(projectRoot, ".codex/skills/source-command-yolo-check/SKILL.md"), "# stale\n", "utf8");
    mkdirSync(join(projectRoot, ".codex/skills/yolo.pi"), { recursive: true });
    writeFileSync(join(projectRoot, ".codex/skills/yolo.pi/SKILL.md"), "# stale workflow\n", "utf8");
    mkdirSync(join(projectRoot, ".codex/skills/yolo-check"), { recursive: true });
    writeFileSync(join(projectRoot, ".codex/skills/yolo-check/SKILL.md"), "# stale direct slash\n", "utf8");
    const result = installAgentBridge({ projectRoot, yoloRoot: "/tmp/yolo", targets: "codex", dryRun: true });

    assert.equal(result.dry_run, true);
    assert.equal(result.planned.includes("AGENTS.md"), true);
    assert.equal(result.planned.includes(".codex/skills/yolo/SKILL.md"), true);
    assert.equal(result.planned.includes(".codex/skills/yolo/commands/yolo-run.md"), true);
    assert.equal(result.planned.includes(".codex/skills/yolo/commands/yolo-doctor.md"), true);
    assert.equal(result.planned.includes(".codex/skills/source-command-yolo/SKILL.md"), true);
    assert.equal(result.planned.includes(".codex/skills/source-command-yolo-check/SKILL.md"), false);
    assert.equal(result.legacy_cleanup_planned.includes(".codex/skills/source-command-yolo-check"), true);
    assert.equal(result.legacy_cleanup_planned.includes(".codex/skills/yolo.pi/SKILL.md"), true);
    assert.equal(result.legacy_cleanup_planned.includes(".codex/skills/yolo-check"), true);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/source-command-yolo-check/SKILL.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/yolo.pi/SKILL.md")), true);
    assert.equal(result.planned.includes(".codex/skills/yolo-brainstorm/SKILL.md"), false);
    assert.equal(result.planned.includes(".codex/skills/yolo-interview/SKILL.md"), false);
    assert.equal(result.skill_installs[0].skipped.includes(".codex/skills/yolo.pi/WORKFLOW.md"), true);
    assert.equal(result.skill_installs[0].skipped.includes(".codex/skills/yolo.interview/WORKFLOW.md"), true);
    assert.equal(result.skill_installs[0].skipped.includes(".codex/skills/yolo.pi/SKILL.md"), false);
    assert.deepEqual(result.written, []);
    assert.equal(existsSync(join(projectRoot, "AGENTS.md")), false);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/source-command-yolo/SKILL.md")), false);
  });

  test("user scope installs global Codex skill and Claude slash commands under supplied home", () => {
    const projectRoot = tempProject();
    const homeDir = tempProject();
    const result = installAgentBridge({
      projectRoot,
      homeDir,
      yoloRoot: "/tmp/yolo",
      targets: "both",
      scope: "user",
    });

    assert.equal(result.writes_workspace, false);
    assert.equal(result.writes_user_home, true);
    assert.deepEqual(result.scopes, ["user"]);
    assert.equal(existsSync(join(projectRoot, "AGENTS.md")), false);
    assert.equal(existsSync(join(homeDir, ".agents/skills/yolo/SKILL.md")), true);
    assert.equal(existsSync(join(homeDir, ".agents/skills/yolo/commands/yolo-plan.md")), true);
    assert.equal(existsSync(join(homeDir, ".agents/skills/yolo/commands/yolo-doctor.md")), true);
    assert.equal(existsSync(join(homeDir, ".agents/skills/source-command-yolo/SKILL.md")), true);
    assert.equal(existsSync(join(homeDir, ".agents/skills/source-command-yolo-run/SKILL.md")), false);
    assert.equal(existsSync(join(homeDir, ".agents/skills/yolo-brainstorm/SKILL.md")), false);
    assert.equal(existsSync(join(homeDir, ".agents/skills/yolo-interview/SKILL.md")), false);
    assert.equal(existsSync(join(homeDir, ".agents/skills/yolo-doctor/SKILL.md")), false);
    assert.equal(existsSync(join(homeDir, ".agents/skills/yolo/workflows/RULES.md")), true);
    assert.equal(existsSync(join(homeDir, ".agents/skills/yolo/workflows/yolo.pi/WORKFLOW.md")), true);
    assert.equal(existsSync(join(homeDir, ".agents/skills/yolo/workflows/yolo.interview/WORKFLOW.md")), true);
    assert.equal(existsSync(join(homeDir, ".agents/skills/yolo/workflows/yolo.pi/SKILL.md")), false);
    assert.equal(existsSync(join(homeDir, ".claude/skills/yolo/SKILL.md")), true);
    assert.equal(existsSync(join(homeDir, ".claude/commands/yolo.md")), true);
    assert.match(readFileSync(join(homeDir, ".claude/commands/yolo-run.md"), "utf8"), /Requires explicit user confirmation/);
  });
});
