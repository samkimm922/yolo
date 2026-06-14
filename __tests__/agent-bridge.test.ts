import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    assert.match(block, /route it to the matching stable command/);
    assert.match(block, /A stage command is terminal for the current turn/);
    assert.match(block, /User approval of a demand discussion, plan, PRD, or check means permission to move to the next stage, not permission to edit code/);
    assert.match(block, /legacy internal names such as `\/Yolo\.brainstorm`/);
    assert.match(block, /Treat this chat as the user interface/);
    assert.match(block, /先读状态并选择安全阶段，不要改代码/);
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
    const command = buildClaudeSlashCommand("yolo-tasks", { yoloRoot: "/tmp/yolo" });

    assert.match(command, /^---\nname: yolo-tasks/m);
    assert.match(command, /# \/yolo-tasks/);
    assert.match(command, /YOLO root: \/tmp\/yolo/);
    assert.match(command, /Planning\/task-breakdown only/);
    assert.match(command, /yolo tasks --discovery/);
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
    assert.deepEqual(allowedTools(buildClaudeSlashCommand("yolo-tasks", { yoloRoot: "/tmp/yolo" })), [
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

  test("buildYoloNativeSkill documents the 4 stable command surface for Codex skill discovery", () => {
    const skill = buildYoloNativeSkill({ agent: "codex", yoloRoot: "/tmp/yolo" });

    assert.match(skill, /^---\nname: yolo/m);
    assert.match(skill, /How To Choose/);
    assert.match(skill, /Recommended user commands/);
    assert.match(skill, /Hidden demand compatibility aliases/);
    // 4 stable commands: demand, auto, ship, status
    assert.match(skill, /\/yolo-status/);
    assert.match(skill, /\/yolo-demand/);
    assert.match(skill, /\/yolo-auto/);
    assert.match(skill, /\/yolo-ship/);
    // Internal commands are not in the recommended surface
    assert.doesNotMatch(skill, /^- `\/yolo-spec`:/m);
    assert.doesNotMatch(skill, /^- `\/yolo-tasks`:/m);
    assert.doesNotMatch(skill, /^- `\/yolo-run`:/m);
    assert.doesNotMatch(skill, /^- `\/yolo-check`:/m);
    assert.doesNotMatch(skill, /^- `\/yolo-review`:/m);
    assert.doesNotMatch(skill, /^- `\/yolo-release`:/m);
    // Compat aliases are fully deleted; no compat entries in the skill
    assert.doesNotMatch(skill, /^- `\/yolo-interview` ->/m);
    assert.doesNotMatch(skill, /^- `\/yolo-discover` ->/m);
    assert.doesNotMatch(skill, /^- `\/yolo-discuss` ->/m);
    assert.doesNotMatch(skill, /^- `\/office-hours` ->/m);
    assert.doesNotMatch(skill, /^- `\/yolo-plan` ->/m);
    assert.doesNotMatch(skill, /^- `\/yolo-prd` ->/m);
    assert.doesNotMatch(skill, /^- `\/yolo-ship` ->/m);
    assert.doesNotMatch(skill, /\/yolo-doctor/);
    // Core protocol rules still present
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

  test("buildCodexSourceCommandSkill uses demand as the primary source-command entry", () => {
    const skill = buildCodexSourceCommandSkill("demand", { yoloRoot: "/tmp/yolo" });

    assert.match(skill, /^---\nname: "source-command-demand"/m);
    assert.match(skill, /\/yolo-demand/);
    assert.match(skill, /YOLO root: \/tmp\/yolo/);
    assert.match(skill, /legacy demand subcommand/);
    assert.match(skill, /ask one `next_question`/);
    assert.match(skill, /do not output long recommendation lists/);
    assert.match(skill, /do not enter PRD/);
    assert.match(skill, /do not edit code/);
    assert.match(skill, /evidence agent JSON role contracts belong only in provider sub-agent prompts/);
    assert.match(skill, /another explicit `\/yolo-\*` command/);
    assert.match(skill, /not execution approval/);
    assert.match(skill, /Default to `\/yolo-status` or a no-code demand\/tasks stage/);
  });

  test("buildCodexSlashCommandSkill renders a stable command skill without compat alias text", () => {
    const skill = buildCodexSlashCommandSkill("yolo-demand", { yoloRoot: "/tmp/yolo" });

    assert.match(skill, /^---\nname: yolo-demand/m);
    assert.match(skill, /# \/yolo-demand/);
    assert.match(skill, /YOLO root: \/tmp\/yolo/);
    assert.match(skill, /explicit stage command/);
    assert.match(skill, /one-question mode/);
    assert.match(skill, /next_question/);
    assert.match(skill, /批准最后/);
    assert.match(skill, /Evidence dispatch prompt content is only for provider sub-agents/);
    assert.doesNotMatch(skill, /when execution is needed/);
    // Compat alias phrasing must not appear for stable commands
    assert.doesNotMatch(skill, /compatibility alias/);
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

  test("buildAgentBridgeInstallPlan plans ≤12 files: project instructions, native yolo skill, and Claude slash commands", () => {
    const projectRoot = tempProject();
    const plan = buildAgentBridgeInstallPlan({ projectRoot, yoloRoot: "/tmp/yolo", targets: "both" });

    assert.equal(plan.schema, "yolo.agent_bridge_install_plan.v1");
    assert.deepEqual(plan.targets, ["codex", "claude"]);
    assert.equal(plan.within_budget, true);
    assert.ok(plan.total_file_count <= 12, `total_file_count ${plan.total_file_count} exceeds budget of 12`);

    // Project instructions: AGENTS.md + CLAUDE.md
    assert.deepEqual(plan.files.map((file) => file.relative_path), ["AGENTS.md", "CLAUDE.md"]);

    // Native yolo skill: one per target
    assert.deepEqual(plan.native_skill_files.map((file) => file.relative_path), [
      ".codex/skills/yolo/SKILL.md",
      ".claude/skills/yolo/SKILL.md",
    ]);

    // Claude slash commands: bare /yolo router + 4 stable verbs
    const claudeCommands = plan.claude_slash_commands.map((file) => file.relative_path);
    assert.equal(claudeCommands.includes(".claude/commands/yolo.md"), true);
    assert.equal(claudeCommands.includes(".claude/commands/yolo-demand.md"), true);
    assert.equal(claudeCommands.includes(".claude/commands/yolo-auto.md"), true);
    assert.equal(claudeCommands.includes(".claude/commands/yolo-ship.md"), true);
    assert.equal(claudeCommands.includes(".claude/commands/yolo-status.md"), true);
    assert.equal(claudeCommands.length, 5);

    // No per-command Codex docs, no source commands, no legacy cleanup, no workflow skills
    assert.equal(plan.hasOwnProperty("command_files"), false);
    assert.equal(plan.hasOwnProperty("source_command_files"), false);
    assert.equal(plan.hasOwnProperty("legacy_cleanup_files"), false);
    assert.equal(plan.hasOwnProperty("codex_slash_command_files"), false);
    assert.equal(plan.hasOwnProperty("skill_plans"), false);

    assert.equal(existsSync(join(projectRoot, "AGENTS.md")), false);
  });

  test("installAgentBridge writes project instructions, yolo skill, and Claude slash commands only", () => {
    const projectRoot = tempProject();
    writeFileSync(join(projectRoot, "AGENTS.md"), "# Existing Agent Rules\n", "utf8");
    const result = installAgentBridge({ projectRoot, yoloRoot: "/tmp/yolo", targets: "both" });

    assert.equal(result.status, "success");
    assert.equal(result.within_budget, true);
    assert.ok(result.total_file_count <= 12);

    // Project instructions
    assert.equal(result.overwritten.includes("AGENTS.md"), true);
    assert.equal(result.written.includes("CLAUDE.md"), true);

    // Native yolo skill
    assert.equal(result.written.includes(".codex/skills/yolo/SKILL.md"), true);
    assert.equal(result.written.includes(".claude/skills/yolo/SKILL.md"), true);

    // Claude slash commands: bare /yolo router + 4 stable verbs
    assert.equal(result.written.includes(".claude/commands/yolo.md"), true);
    assert.equal(result.written.includes(".claude/commands/yolo-demand.md"), true);
    assert.equal(result.written.includes(".claude/commands/yolo-auto.md"), true);
    assert.equal(result.written.includes(".claude/commands/yolo-ship.md"), true);
    assert.equal(result.written.includes(".claude/commands/yolo-status.md"), true);

    // Internal commands are NOT installed
    assert.equal(result.written.includes(".claude/commands/yolo-spec.md"), false);
    assert.equal(result.written.includes(".claude/commands/yolo-tasks.md"), false);
    assert.equal(result.written.includes(".claude/commands/yolo-run.md"), false);

    // No legacy cleanup, no skill installs
    assert.equal(result.hasOwnProperty("legacy_cleanup_planned"), false);
    assert.equal(result.hasOwnProperty("legacy_archived"), false);
    assert.equal(result.hasOwnProperty("skill_installs"), false);

    // Verify file contents
    assert.match(readFileSync(join(projectRoot, ".codex/skills/yolo/SKILL.md"), "utf8"), /YOLO Native Skill for Codex/);
    assert.match(readFileSync(join(projectRoot, "AGENTS.md"), "utf8"), /# Existing Agent Rules/);
    assert.match(readFileSync(join(projectRoot, "AGENTS.md"), "utf8"), /YOLO Agent Bridge for Codex/);
    assert.match(readFileSync(join(projectRoot, "CLAUDE.md"), "utf8"), /YOLO Agent Bridge for Claude Code/);
  });

  test("dry-run reports planned files without writing", () => {
    const projectRoot = tempProject();
    const result = installAgentBridge({ projectRoot, yoloRoot: "/tmp/yolo", targets: "codex", dryRun: true });

    assert.equal(result.dry_run, true);
    assert.equal(result.within_budget, true);
    assert.ok(result.total_file_count <= 12);

    // Project instructions
    assert.equal(result.planned.includes("AGENTS.md"), true);
    // Native yolo skill
    assert.equal(result.planned.includes(".codex/skills/yolo/SKILL.md"), true);
    // No Claude commands when only codex target
    assert.equal(result.planned.some((file) => file.startsWith(".claude/")), false);

    assert.deepEqual(result.written, []);
    assert.equal(existsSync(join(projectRoot, "AGENTS.md")), false);
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
    assert.equal(result.within_budget, true);
    assert.ok(result.total_file_count <= 12);

    // No project files written
    assert.equal(existsSync(join(projectRoot, "AGENTS.md")), false);

    // Native yolo skill
    assert.equal(existsSync(join(homeDir, ".agents/skills/yolo/SKILL.md")), true);
    assert.equal(existsSync(join(homeDir, ".claude/skills/yolo/SKILL.md")), true);

    // Claude slash commands: bare /yolo router + 4 stable verbs
    assert.equal(existsSync(join(homeDir, ".claude/commands/yolo.md")), true);
    assert.equal(existsSync(join(homeDir, ".claude/commands/yolo-demand.md")), true);
    assert.equal(existsSync(join(homeDir, ".claude/commands/yolo-auto.md")), true);
    assert.equal(existsSync(join(homeDir, ".claude/commands/yolo-ship.md")), true);
    assert.equal(existsSync(join(homeDir, ".claude/commands/yolo-status.md")), true);
    assert.equal(existsSync(join(homeDir, ".claude/commands/yolo-run.md")), false);

    // No legacy artifacts
    assert.match(readFileSync(join(homeDir, ".claude/commands/yolo-demand.md"), "utf8"), /one-question mode/);
  });

  test("project-scope install emits .claude/settings.json with lifecycle-gate PreToolUse hook", () => {
    const projectRoot = tempProject();
    try {
      const plan = buildAgentBridgeInstallPlan({ projectRoot, yoloRoot: "/tmp/yolo", targets: "claude" });
      assert.ok(plan.claude_project_hooks.length > 0, "project hooks must be planned for claude target");
      const hook = plan.claude_project_hooks[0];
      assert.equal(hook.role, "claude_project_settings");
      assert.equal(hook.relative_path, ".claude/settings.json");
      assert.match(hook.content, /PreToolUse/);
      assert.match(hook.content, /pre-tool-lifecycle-gate/);
      assert.match(hook.content, /Write\|Edit\|MultiEdit\|Bash/);

      const result = installAgentBridge({ projectRoot, yoloRoot: "/tmp/yolo", targets: "claude" });
      assert.equal(existsSync(join(projectRoot, ".claude/settings.json")), true);
      const settings = JSON.parse(readFileSync(join(projectRoot, ".claude/settings.json"), "utf8"));
      assert.ok(settings.hooks?.PreToolUse?.some((entry) => entry.command?.includes("pre-tool-lifecycle-gate")));
      assert.ok(result.written.includes(".claude/settings.json"));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("user-scope install does not emit project settings.json hook", () => {
    const projectRoot = tempProject();
    const homeDir = mkdtempSync(join(tmpdir(), "yolo-agent-bridge-home-"));
    try {
      const plan = buildAgentBridgeInstallPlan({ projectRoot, homeDir, yoloRoot: "/tmp/yolo", targets: "claude", scopes: ["user"] });
      assert.equal(plan.claude_project_hooks.length, 0, "user scope must not emit project settings.json");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  // BUG-3: manifest-based reconcile — clean up orphaned yolo entries on upgrade
  test("reconcile deletes orphaned yolo commands from previous manifest on upgrade", () => {
    const projectRoot = tempProject();
    try {
      // Simulate old install: write legacy yolo commands + manifest
      mkdirSync(join(projectRoot, ".claude/commands"), { recursive: true });
      mkdirSync(join(projectRoot, ".claude/skills/yolo"), { recursive: true });
      mkdirSync(join(projectRoot, ".codex/skills/yolo"), { recursive: true });

      // Old files that the new slim plan does NOT include
      writeFileSync(join(projectRoot, ".claude/commands/yolo-plan.md"), "# old plan\n", "utf8");
      writeFileSync(join(projectRoot, ".claude/commands/yolo-prd.md"), "# old prd\n", "utf8");
      writeFileSync(join(projectRoot, ".claude/commands/yolo-check.md"), "# old check\n", "utf8");

      // A non-yolo user file that must NEVER be deleted
      writeFileSync(join(projectRoot, ".claude/commands/my-custom.md"), "# my custom\n", "utf8");

      // Old manifest tracking these files
      const oldManifest = {
        schema: "yolo.bridge_manifest.v1",
        generated_at: "2025-01-01T00:00:00.000Z",
        entries: [
          ".claude/commands/yolo-plan.md",
          ".claude/commands/yolo-prd.md",
          ".claude/commands/yolo-check.md",
          ".claude/skills/yolo/SKILL.md",
        ],
      };
      writeFileSync(join(projectRoot, ".yolo-bridge-manifest.json"), JSON.stringify(oldManifest, null, 2), "utf8");

      // Run new slim install
      const result = installAgentBridge({ projectRoot, yoloRoot: "/tmp/yolo", targets: "claude", force: true });

      // Orphaned yolo commands deleted
      assert.equal(existsSync(join(projectRoot, ".claude/commands/yolo-plan.md")), false, "orphan yolo-plan.md must be deleted");
      assert.equal(existsSync(join(projectRoot, ".claude/commands/yolo-prd.md")), false, "orphan yolo-prd.md must be deleted");
      assert.equal(existsSync(join(projectRoot, ".claude/commands/yolo-check.md")), false, "orphan yolo-check.md must be deleted");

      // New slim commands present
      assert.equal(existsSync(join(projectRoot, ".claude/commands/yolo.md")), true);
      assert.equal(existsSync(join(projectRoot, ".claude/commands/yolo-demand.md")), true);
      assert.equal(existsSync(join(projectRoot, ".claude/commands/yolo-status.md")), true);

      // Non-yolo file untouched
      assert.equal(existsSync(join(projectRoot, ".claude/commands/my-custom.md")), true, "non-yolo file must not be deleted");

      // Reconciled list reports deleted entries
      assert.ok(result.reconciled.includes(".claude/commands/yolo-plan.md"));
      assert.ok(result.reconciled.includes(".claude/commands/yolo-prd.md"));
      assert.ok(result.reconciled.includes(".claude/commands/yolo-check.md"));

      // New manifest written with current entries
      const newManifest = JSON.parse(readFileSync(join(projectRoot, ".yolo-bridge-manifest.json"), "utf8"));
      assert.equal(newManifest.schema, "yolo.bridge_manifest.v1");
      assert.ok(newManifest.entries.includes(".claude/commands/yolo.md"));
      assert.ok(newManifest.entries.includes(".claude/commands/yolo-demand.md"));
      assert.ok(newManifest.entries.includes(".claude/skills/yolo/SKILL.md"));
      assert.equal(newManifest.entries.includes(".claude/commands/yolo-plan.md"), false, "old orphan must not be in new manifest");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("reconcile does NOT delete anything when no previous manifest exists", () => {
    const projectRoot = tempProject();
    try {
      // Write some yolo-looking files WITHOUT a manifest (e.g., manual setup)
      mkdirSync(join(projectRoot, ".claude/commands"), { recursive: true });
      writeFileSync(join(projectRoot, ".claude/commands/yolo-plan.md"), "# manual\n", "utf8");
      writeFileSync(join(projectRoot, ".claude/commands/my-custom.md"), "# my custom\n", "utf8");

      // No manifest file → must not delete anything
      assert.equal(existsSync(join(projectRoot, ".yolo-bridge-manifest.json")), false);

      const result = installAgentBridge({ projectRoot, yoloRoot: "/tmp/yolo", targets: "claude", force: true });

      // Nothing reconciled
      assert.deepEqual(result.reconciled, []);

      // Manual files untouched
      assert.equal(existsSync(join(projectRoot, ".claude/commands/yolo-plan.md")), true, "manual yolo file without manifest must not be deleted");
      assert.equal(existsSync(join(projectRoot, ".claude/commands/my-custom.md")), true);

      // Manifest is written after install
      assert.equal(existsSync(join(projectRoot, ".yolo-bridge-manifest.json")), true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("dry-run reports orphaned entries without deleting", () => {
    const projectRoot = tempProject();
    try {
      mkdirSync(join(projectRoot, ".claude/commands"), { recursive: true });
      writeFileSync(join(projectRoot, ".claude/commands/yolo-plan.md"), "# old\n", "utf8");

      const oldManifest = {
        schema: "yolo.bridge_manifest.v1",
        generated_at: "2025-01-01T00:00:00.000Z",
        entries: [".claude/commands/yolo-plan.md", ".claude/skills/yolo/SKILL.md"],
      };
      writeFileSync(join(projectRoot, ".yolo-bridge-manifest.json"), JSON.stringify(oldManifest, null, 2), "utf8");

      const result = installAgentBridge({ projectRoot, yoloRoot: "/tmp/yolo", targets: "claude", dryRun: true });

      // Dry-run: nothing actually deleted
      assert.equal(existsSync(join(projectRoot, ".claude/commands/yolo-plan.md")), true, "dry-run must not delete files");
      assert.deepEqual(result.reconciled, []);
      // Dry-run reports planned reconcile in planned array
      assert.ok(result.planned.some((p) => p.includes("yolo-plan.md")), "dry-run must report orphan in planned");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
