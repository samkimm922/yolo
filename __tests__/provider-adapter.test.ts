import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProviderInvocation,
  classifyProviderFailure,
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

    assert.deepEqual(classifyProviderFailure({ stderr: "network error" }), {
      terminal: false,
      status: "failed",
      reason: null,
      detail: "",
    });
  });
});
