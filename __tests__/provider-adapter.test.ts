import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildProviderInvocation,
  classifyProviderFailure,
  DEFAULT_CLAUDE_SETTINGS_PATH,
  spawnProviderPrompt,
} from "../src/runtime/execution/provider-adapter.js";

const baseConfig = {
  ai: {
    model: "claude-sonnet-4",
    settings: ".claude/settings.json",
    claude_permission_mode: "default",
    max_budget_usd: 3,
    codex_model: "gpt-5-codex",
    codex_sandbox: "workspace-write",
    codex_approval: "never",
  },
};

describe("provider execution adapter", () => {
  test("buildProviderInvocation creates a claude stdin invocation with budget guard", () => {
    const invocation = buildProviderInvocation({
      provider: "claude",
      config: baseConfig,
      workDir: "/repo",
      rootDir: "/repo",
      runtimeDir: "/repo/state/runtime",
    });

    assert.equal(invocation.provider, "claude");
    assert.equal(invocation.command, "claude");
    assert.deepEqual(invocation.args, [
      "-p",
      "--model", "claude-sonnet-4",
      "--permission-mode", "default",
      "--settings", "/repo/.claude/settings.json",
      "--max-budget-usd", "3",
    ]);
    assert.equal(invocation.outputFile, null);
  });

  test("claude executor can pass a third-party model name without switching adapters", () => {
    const invocation = buildProviderInvocation({
      provider: "claude",
      config: {
        ai: {
          executor: "claude",
          model: "openrouter/deepseek-chat",
          claude_permission_mode: "default",
        },
      },
      workDir: "/repo",
      rootDir: "/repo",
      runtimeDir: "/repo/state/runtime",
    });

    assert.equal(invocation.provider, "claude");
    assert.equal(invocation.command, "claude");
    assert.deepEqual(invocation.args, [
      "-p",
      "--model", "openrouter/deepseek-chat",
      "--permission-mode", "default",
    ]);
  });

  test("default claude settings resolve to the YOLO package root instead of the target project", () => {
    const targetRoot = "/tmp/yolo-consumer-project";
    const invocation = buildProviderInvocation({
      provider: "claude",
      config: {
        ai: {
          model: "claude-sonnet-4",
          settings: "settings-minimal.json",
        },
      },
      workDir: targetRoot,
      rootDir: targetRoot,
      runtimeDir: join(targetRoot, ".yolo/state/runtime"),
    });

    const settingsIndex = invocation.args.indexOf("--settings");
    assert.notEqual(settingsIndex, -1);
    assert.equal(invocation.args[settingsIndex + 1], DEFAULT_CLAUDE_SETTINGS_PATH);
    assert.equal(invocation.settingsFile, DEFAULT_CLAUDE_SETTINGS_PATH);
    assert.notEqual(invocation.settingsFile, join(targetRoot, "settings-minimal.json"));
    assert.equal(existsSync(invocation.settingsFile), true);
  });

  test("legacy default claude settings path also resolves to the YOLO package root", () => {
    const targetRoot = "/tmp/yolo-consumer-project";
    const invocation = buildProviderInvocation({
      provider: "claude",
      config: {
        ai: {
          model: "claude-sonnet-4",
          settings: "scripts/yolo/settings-minimal.json",
        },
      },
      workDir: targetRoot,
      rootDir: targetRoot,
      runtimeDir: join(targetRoot, ".yolo/state/runtime"),
    });

    const settingsIndex = invocation.args.indexOf("--settings");
    assert.notEqual(settingsIndex, -1);
    assert.equal(invocation.args[settingsIndex + 1], DEFAULT_CLAUDE_SETTINGS_PATH);
    assert.equal(invocation.settingsFile, DEFAULT_CLAUDE_SETTINGS_PATH);
    assert.notEqual(invocation.settingsFile, join(targetRoot, "scripts/yolo/settings-minimal.json"));
  });

  test("spawnProviderPrompt fails closed before spawning when claude settings are missing", async () => {
    let spawned = false;
    const run = await spawnProviderPrompt("prompt", {
      config: {
        ai: {
          model: "claude-sonnet-4",
          settings: "missing-settings.json",
        },
      },
      rootDir: "/repo",
      runtimeDir: "/repo/.yolo/state/runtime",
      existsSync: () => false,
      spawnImpl: () => {
        spawned = true;
        throw new Error("spawn should not be called");
      },
    });

    assert.equal(spawned, false);
    assert.equal(run.success, false);
    assert.equal(run.blocked, true);
    assert.equal(run.reason, "claude_settings_missing");
    assert.equal(run.exitCode, null);
    assert.match(run.stderr, /Claude settings file not found: \/repo\/missing-settings\.json/);
    assert.equal(run.preflight.status, "blocked");
  });

  test("claude invocation supports read-only tool hardening flags", () => {
    const settings = JSON.stringify({
      permissions: {
        allow: ["Read", "Glob", "Grep"],
        deny: ["Write", "Edit", "Bash"],
      },
    });
    const invocation = buildProviderInvocation({
      provider: "claude",
      config: {
        ai: {
          model: "claude-sonnet-4-6",
          settings,
          claude_tools: "Read,Glob,Grep",
          claude_allowed_tools: "Read,Glob,Grep",
          claude_disallowed_tools: "Write,Edit,Bash",
          claude_disable_slash_commands: true,
          claude_no_session_persistence: true,
        },
      },
      workDir: "/repo",
      rootDir: "/repo",
      runtimeDir: "/repo/state/runtime",
    });

    assert.deepEqual(invocation.args, [
      "-p",
      "--model", "claude-sonnet-4-6",
      "--permission-mode", "default",
      "--settings", settings,
      "--tools", "Read,Glob,Grep",
      "--allowedTools", "Read,Glob,Grep",
      "--disallowedTools", "Write,Edit,Bash",
      "--disable-slash-commands",
      "--no-session-persistence",
    ]);
  });

  test("buildProviderInvocation creates a codex exec invocation with output capture", () => {
    const invocation = buildProviderInvocation({
      provider: "codex",
      config: baseConfig,
      workDir: "/repo/worktree",
      rootDir: "/repo",
      runtimeDir: "/repo/state/runtime",
      now: () => 123,
      random: () => 0.5,
    });

    assert.equal(invocation.provider, "codex");
    assert.equal(invocation.command, "codex");
    assert.deepEqual(invocation.args.slice(0, 6), [
      "exec",
      "--model", "gpt-5-codex",
      "--cd", "/repo/worktree",
      "--sandbox",
    ]);
    assert.ok(invocation.args.includes("--output-last-message"));
    assert.equal(invocation.args.at(-1), "-");
    assert.equal(invocation.outputFile, "/repo/state/runtime/codex-output-123-8.txt");
  });

  test("buildProviderInvocation wraps a custom stdin adapter command", () => {
    const invocation = buildProviderInvocation({
      provider: "shell",
      config: {
        ai: {
          custom_command: "node ./agent.js --mode yolo",
        },
      },
      workDir: "/repo/worktree",
      rootDir: "/repo",
      runtimeDir: "/repo/state/runtime",
    });

    assert.equal(invocation.provider, "custom");
    assert.equal(invocation.command, "sh");
    assert.deepEqual(invocation.args, ["-c", "node ./agent.js --mode yolo"]);
    assert.equal(invocation.customCommand, "node ./agent.js --mode yolo");
    assert.equal(invocation.outputFile, null);
  });

  test("classifyProviderFailure turns budget exhaustion into a terminal blocker", () => {
    assert.deepEqual(classifyProviderFailure({
      stdout: "",
      stderr: "Exceeded USD budget for this session",
    }), {
      terminal: true,
      status: "blocked",
      reason: "provider_budget_exceeded",
      detail: "Exceeded USD budget for this session",
    });

    assert.deepEqual(classifyProviderFailure({
      blocked: true,
      reason: "claude_settings_missing",
      stderr: "Claude settings file not found: /repo/missing-settings.json",
    }), {
      terminal: true,
      status: "blocked",
      reason: "claude_settings_missing",
      detail: "Claude settings file not found: /repo/missing-settings.json",
    });

    assert.deepEqual(classifyProviderFailure({ stderr: "network error" }), {
      terminal: false,
      status: "failed",
      reason: null,
      detail: "",
    });
  });
});
