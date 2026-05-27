import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildAgentBridgeBlock,
  buildAgentBridgeInstallPlan,
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
    assert.match(command, /Plan-only\. Do not modify source files/);
  });

  test("buildYoloNativeSkill documents command aliases for Codex skill discovery", () => {
    const skill = buildYoloNativeSkill({ agent: "codex", yoloRoot: "/tmp/yolo" });

    assert.match(skill, /^---\nname: yolo/m);
    assert.match(skill, /\/yolo-plan/);
    assert.match(skill, /\/yolo-discover/);
    assert.match(skill, /\/yolo-doctor/);
    assert.match(skill, /Require explicit confirmation before code edits/);
  });

  test("buildCodexSourceCommandSkill follows local Codex source-command convention", () => {
    const skill = buildCodexSourceCommandSkill("yolo", { yoloRoot: "/tmp/yolo" });

    assert.match(skill, /^---\nname: "source-command-yolo"/m);
    assert.match(skill, /\/yolo plan/);
    assert.match(skill, /YOLO root: \/tmp\/yolo/);
    assert.match(skill, /Default to plan-only/);
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
    assert.equal(plan.command_files.some((file) => file.relative_path === ".claude/commands/yolo-discover.md"), true);
    assert.equal(plan.command_files.some((file) => file.relative_path === ".claude/commands/yolo-doctor.md"), true);
    assert.equal(plan.command_files.some((file) => file.relative_path === ".codex/skills/yolo/commands/yolo-plan.md"), true);
    assert.equal(plan.command_files.some((file) => file.relative_path === ".codex/skills/yolo/commands/yolo-prd.md"), true);
    assert.equal(plan.source_command_files.some((file) => file.relative_path === ".codex/skills/source-command-yolo-plan/SKILL.md"), true);
    assert.equal(plan.source_command_files.some((file) => file.relative_path === ".codex/skills/source-command-yolo-doctor/SKILL.md"), true);
    assert.deepEqual(plan.skill_plans.map((item) => item.target_dir), [".codex/skills", ".claude/skills"]);
    assert.equal(existsSync(join(projectRoot, "AGENTS.md")), false);
  });

  test("installAgentBridge writes project instructions, skills, and command aliases", () => {
    const projectRoot = tempProject();
    writeFileSync(join(projectRoot, "AGENTS.md"), "# Existing Agent Rules\n", "utf8");
    const result = installAgentBridge({ projectRoot, yoloRoot: "/tmp/yolo", targets: "both" });

    assert.equal(result.status, "success");
    assert.equal(result.overwritten.includes("AGENTS.md"), true);
    assert.equal(result.written.includes("CLAUDE.md"), true);
    assert.equal(result.written.includes(".claude/commands/yolo-plan.md"), true);
    assert.equal(result.written.includes(".claude/commands/yolo-doctor.md"), true);
    assert.equal(result.written.includes(".codex/skills/yolo/SKILL.md"), true);
    assert.equal(result.written.includes(".codex/skills/source-command-yolo/SKILL.md"), true);
    assert.equal(result.written.includes(".codex/skills/source-command-yolo-plan/SKILL.md"), true);
    assert.equal(result.written.includes(".codex/skills/source-command-yolo-prd/SKILL.md"), true);
    assert.match(readFileSync(join(projectRoot, "AGENTS.md"), "utf8"), /# Existing Agent Rules/);
    assert.match(readFileSync(join(projectRoot, "AGENTS.md"), "utf8"), /YOLO Agent Bridge for Codex/);
    assert.match(readFileSync(join(projectRoot, "CLAUDE.md"), "utf8"), /YOLO Agent Bridge for Claude Code/);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/RULES.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/yolo.pi/SKILL.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/yolo.discover/SKILL.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/yolo.doctor/SKILL.md")), true);
    assert.equal(existsSync(join(projectRoot, ".codex/skills/yolo/SKILL.md")), true);
    assert.equal(existsSync(join(projectRoot, ".claude/skills/triggers.json")), true);
    assert.equal(existsSync(join(projectRoot, ".claude/commands/yolo-run.md")), true);
  });

  test("dry-run reports planned files without writing", () => {
    const projectRoot = tempProject();
    const result = installAgentBridge({ projectRoot, yoloRoot: "/tmp/yolo", targets: "codex", dryRun: true });

    assert.equal(result.dry_run, true);
    assert.equal(result.planned.includes("AGENTS.md"), true);
    assert.equal(result.planned.includes(".codex/skills/yolo/SKILL.md"), true);
    assert.equal(result.planned.includes(".codex/skills/yolo/commands/yolo-run.md"), true);
    assert.equal(result.planned.includes(".codex/skills/yolo/commands/yolo-doctor.md"), true);
    assert.equal(result.planned.includes(".codex/skills/source-command-yolo-check/SKILL.md"), true);
    assert.equal(result.planned.includes(".codex/skills/source-command-yolo-discover/SKILL.md"), true);
    assert.deepEqual(result.written, []);
    assert.equal(existsSync(join(projectRoot, "AGENTS.md")), false);
    assert.equal(existsSync(join(projectRoot, ".codex")), false);
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
    assert.equal(existsSync(join(homeDir, ".agents/skills/source-command-yolo-run/SKILL.md")), true);
    assert.equal(existsSync(join(homeDir, ".agents/skills/source-command-yolo-prd/SKILL.md")), true);
    assert.equal(existsSync(join(homeDir, ".agents/skills/yolo/workflows/RULES.md")), true);
    assert.equal(existsSync(join(homeDir, ".claude/skills/yolo/SKILL.md")), true);
    assert.equal(existsSync(join(homeDir, ".claude/commands/yolo.md")), true);
    assert.match(readFileSync(join(homeDir, ".claude/commands/yolo-run.md"), "utf8"), /Requires explicit user confirmation/);
  });
});
