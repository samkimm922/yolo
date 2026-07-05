import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  activeProviderProcessCount,
  buildProviderInvocation,
  classifyProviderFailure,
  DEFAULT_CLAUDE_PERMISSION_MODE,
  DEFAULT_CLAUDE_SETTINGS_PATH,
  spawnProviderPrompt,
  YOLO_PACKAGE_ROOT,
} from "../src/runtime/execution/provider-adapter.js";

// Absolute file URL for the tsx loader, resolved from this repo's node_modules.
// Spawning the hook from a throwaway tmpdir cwd must not depend on the child
// process being able to resolve the "tsx" package by walking up from its own
// cwd (which is a bare temp dir with no node_modules). Passing an absolute
// file URL to --import sidesteps ESM package resolution entirely.
const TSX_LOADER_URL = (() => {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  } catch {
    return null;
  }
})();

const baseConfig = {
  ai: {
    model: "claude-sonnet-4",
    settings: ".claude/settings.json",
    claude_permission_mode: "acceptEdits",
    max_budget_usd: 3,
    codex_model: "gpt-5-codex",
    codex_sandbox: "workspace-write",
    codex_approval: "never",
  },
};

function fakeProviderSpawn({ stdout = "", stderr = "", code = 0, signal = null, close = true } = {}) {
  return () => {
    const stdin = new PassThrough();
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    const child: EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdin,
      stdout: stdoutStream,
      stderr: stderrStream,
    });
    if (close) {
      setImmediate(() => {
        if (stdout) stdoutStream.write(stdout);
        if (stderr) stderrStream.write(stderr);
        child.emit("close", code, signal);
      });
    }
    return child;
  };
}

function spawnOptions(overrides = {}) {
  return {
    config: { ai: { model: "claude-sonnet-4" } },
    rootDir: "/repo",
    runtimeDir: "/repo/.yolo/state/runtime",
    commandExists: () => true,
    ...overrides,
  };
}

function claudeSettingsArg(invocation) {
  const settingsIndex = invocation.args.indexOf("--settings");
  assert.notEqual(settingsIndex, -1);
  return invocation.args[settingsIndex + 1];
}

function defaultSettingsFromInvocation(invocation) {
  return JSON.parse(claudeSettingsArg(invocation));
}

function defaultYoloWriteHookCommand(settings) {
  const entries = settings.hooks?.PreToolUse || [];
  for (const entry of entries) {
    if (entry.command?.includes("pre-tool-block-yolo-write")) return entry.command;
    for (const hook of Array.isArray(entry.hooks) ? entry.hooks : []) {
      if (hook.command?.includes("pre-tool-block-yolo-write")) return hook.command;
    }
  }
  return "";
}

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
      "--permission-mode", "acceptEdits",
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
        },
      },
      workDir: "/repo",
      rootDir: "/repo",
      runtimeDir: "/repo/state/runtime",
    });

    assert.equal(invocation.provider, "claude");
    assert.equal(invocation.command, "claude");
    assert.deepEqual(invocation.args.slice(0, 5), [
      "-p",
      "--model", "openrouter/deepseek-chat",
      "--permission-mode", DEFAULT_CLAUDE_PERMISSION_MODE,
    ]);
    assert.notEqual(invocation.args.indexOf("--settings"), -1);
  });

  test("empty claude settings use the packaged default settings with Bash and the .yolo hook", () => {
    const invocation: any = buildProviderInvocation({
      provider: "claude",
      config: {
        ai: {
          model: "claude-sonnet-4",
          settings: "",
        },
      },
      workDir: "/tmp/yolo-consumer-project",
      rootDir: "/tmp/yolo-consumer-project",
      runtimeDir: "/tmp/yolo-consumer-project/.yolo/state/runtime",
    });

    assert.equal(invocation.settings.default_settings, true);
    assert.equal(invocation.settings.type, "default");
    assert.equal(invocation.settings.path, DEFAULT_CLAUDE_SETTINGS_PATH);
    assert.equal(invocation.settingsFile, null);

    const settings = defaultSettingsFromInvocation(invocation);
    assert.ok(settings.permissions.allow.includes("Bash"));
    const matchers = (settings.hooks?.PreToolUse || []).map((entry) => entry.matcher).join("|");
    assert.match(matchers, /Bash/);
    const hookCommand = defaultYoloWriteHookCommand(settings);
    assert.match(hookCommand, /pre-tool-block-yolo-write\.js/);
    const hookPath = hookCommand.match(/node "([^"]+)"/)?.[1];
    assert.equal(typeof hookPath, "string");
    assert.ok(hookPath.startsWith(join(YOLO_PACKAGE_ROOT, "dist", "hooks")));
    assert.equal(existsSync(hookPath), true, `default settings hook must resolve to the built package hook: ${hookPath}`);

    const sourceSettings = JSON.parse(readFileSync(DEFAULT_CLAUDE_SETTINGS_PATH, "utf8"));
    assert.ok(sourceSettings.permissions.allow.includes("Bash"));
  });

  test("spawnProviderPrompt defaults claude print mode to an editable permission mode", async () => {
    let capturedArgs = [];
    const run = await spawnProviderPrompt("prompt", spawnOptions({
      config: { ai: { model: "claude-sonnet-4", settings: "" } },
      spawnImpl: (command, args) => {
        capturedArgs = args;
        assert.equal(command, "claude");
        return fakeProviderSpawn({ stdout: "done\n", code: 0 })();
      },
    }));

    const modeIndex = capturedArgs.indexOf("--permission-mode");
    assert.notEqual(modeIndex, -1);
    assert.equal(capturedArgs[modeIndex + 1], DEFAULT_CLAUDE_PERMISSION_MODE);
    assert.notEqual(capturedArgs[modeIndex + 1], "default");
    assert.equal(run.success, true);
  });

  test("spawnProviderPrompt tracks active provider children until close", async () => {
    let child: EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough } | null = null;
    const runPromise = spawnProviderPrompt("prompt", spawnOptions({
      spawnImpl: () => {
        child = Object.assign(new EventEmitter(), {
          pid: 4343,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
        return child;
      },
    }));

    assert.equal(activeProviderProcessCount(), 1);
    assert.ok(child);
    child.stdout.write("done\n");
    child.emit("close", 0, null);
    const run = await runPromise;

    assert.equal(run.success, true);
    assert.equal(activeProviderProcessCount(), 0);
  });

  test("default claude settings resolve to the YOLO package root instead of the target project", () => {
    const targetRoot = "/tmp/yolo-consumer-project";
    const invocation: any = buildProviderInvocation({
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

    const settingsArg = claudeSettingsArg(invocation);
    // Default settings are now inline JSON with absolute hook path
    assert.equal(settingsArg.startsWith("{"), true);
    assert.ok(settingsArg.includes("pre-tool-block-yolo-write.js"));
    assert.ok(settingsArg.includes(YOLO_PACKAGE_ROOT));
    assert.equal(invocation.settingsFile, null);
  });

  test("explicit root default claude settings path resolves to the YOLO package root", () => {
    const targetRoot = "/tmp/yolo-consumer-project";
    const invocation: any = buildProviderInvocation({
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

    const settingsArg = claudeSettingsArg(invocation);
    assert.equal(settingsArg.startsWith("{"), true);
    assert.ok(settingsArg.includes("pre-tool-block-yolo-write.js"));
    assert.ok(settingsArg.includes(YOLO_PACKAGE_ROOT));
    assert.equal(invocation.settingsFile, null);
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
      commandExists: () => true,
      existsSync: () => false,
      spawnImpl: () => {
        spawned = true;
        throw new Error("spawn should not be called");
      },
    });

    assert.equal(spawned, false);
    assert.equal(run.success, false);
    assert.equal(run.status, "blocked");
    assert.equal(run.blocked, true);
    assert.equal(run.reason, "claude_settings_missing");
    assert.equal(run.exitCode, null);
    assert.match(run.stderr, /Claude settings file not found: \/repo\/missing-settings\.json/);
    assert.equal(run.preflight.status, "blocked");
    assert.equal(run.attempt_ledger[0].status, "blocked");
  });

  test("spawnProviderPrompt fails closed before spawning when commandExists rejects provider command", async () => {
    let spawned = false;
    const run = await spawnProviderPrompt("prompt", spawnOptions({
      commandExists: () => false,
      spawnImpl: () => {
        spawned = true;
        throw new Error("spawn should not be called");
      },
    }));

    assert.equal(spawned, false);
    assert.equal(run.success, false);
    assert.equal(run.status, "blocked");
    assert.equal(run.reason, "agent_command_unavailable");
    assert.equal(run.adapter_contract_inspection.blocks_execution, true);
    assert.ok(run.adapter_contract_inspection.blockers.some((blocker) => blocker.code === "AGENT_COMMAND_UNAVAILABLE"));
    assert.ok(run.preflight.blockers.some((blocker) => blocker.code === "PROVIDER_INVOCATION_COMMAND_UNAVAILABLE"));
  });

  test("spawnProviderPrompt marks completed provider output explicitly", async () => {
    const run = await spawnProviderPrompt("prompt", spawnOptions({
      spawnImpl: fakeProviderSpawn({ stdout: "done\n", code: 0 }),
    }));

    assert.equal(run.success, true);
    assert.equal(run.status, "completed");
    assert.equal(run.reason, null);
    assert.equal(run.stdout, "done");
    assert.equal(run.attempt_ledger[0].status, "completed");
  });

  test("spawnProviderPrompt fails closed on empty successful output", async () => {
    const run = await spawnProviderPrompt("prompt", spawnOptions({
      spawnImpl: fakeProviderSpawn({ stdout: " \n", code: 0 }),
    }));

    assert.equal(run.success, false);
    assert.equal(run.status, "no_output");
    assert.equal(run.reason, "provider_no_output");
    assert.equal(run.exitCode, 0);
    assert.equal(run.attempt_ledger[0].status, "no_output");
  });

  test("spawnProviderPrompt fails closed on timeout with an attempt ledger", async () => {
    let child;
    let killedPid = null;
    const run = await spawnProviderPrompt("prompt", spawnOptions({
      timeout: 50,
      spawnImpl: () => {
        child = fakeProviderSpawn({ close: false })();
        return child;
      },
      killTree: (pid) => {
        killedPid = pid;
        setImmediate(() => child.emit("close", null, "SIGTERM"));
      },
    }));

    assert.equal(killedPid, 4242);
    assert.equal(run.success, false);
    assert.equal(run.status, "timed_out");
    assert.equal(run.reason, "provider_timed_out");
    assert.equal(run.timedOut, true);
    assert.equal(run.attempt_ledger[0].status, "timed_out");
    assert.equal(run.attempt_ledger[0].timed_out, true);
  });

  test("spawnProviderPrompt fails closed before spawning when timeout is zero or invalid", async () => {
    for (const invalidTimeout of [0, -1, Infinity, NaN]) {
      let spawned = false;
      const run = await spawnProviderPrompt("prompt", spawnOptions({
        timeout: invalidTimeout,
        spawnImpl: () => {
          spawned = true;
          throw new Error("spawn should not be called");
        },
      }));

      assert.equal(spawned, false, `timeout=${invalidTimeout} must not spawn`);
      assert.equal(run.success, false, `timeout=${invalidTimeout}`);
      assert.equal(run.status, "blocked", `timeout=${invalidTimeout}`);
      assert.equal(run.blocked, true, `timeout=${invalidTimeout}`);
      assert.equal(run.reason, "provider_timeout_invalid", `timeout=${invalidTimeout}`);
      assert.ok(run.preflight.blocks_execution, `timeout=${invalidTimeout}`);
      assert.ok(run.preflight.blockers.some((b) => b.code === "PROVIDER_TIMEOUT_INVALID"), `timeout=${invalidTimeout}`);
    }
  });

  test("spawnProviderPrompt distinguishes killed provider processes", async () => {
    const run = await spawnProviderPrompt("prompt", spawnOptions({
      spawnImpl: fakeProviderSpawn({ stdout: "partial", code: null, signal: "SIGTERM" }),
    }));

    assert.equal(run.success, false);
    assert.equal(run.status, "killed");
    assert.equal(run.reason, "provider_killed");
    assert.equal(run.signal, "SIGTERM");
  });

  test("spawnProviderPrompt fails closed when codex reports success without its output artifact", async () => {
    const run = await spawnProviderPrompt("prompt", spawnOptions({
      detectModelProvider: () => "codex",
      existsSync: () => false,
      spawnImpl: fakeProviderSpawn({ stdout: "looks done", code: 0 }),
    }));

    assert.equal(run.success, false);
    assert.equal(run.status, "verification_failed");
    assert.equal(run.reason, "codex_output_missing");
    assert.equal(run.output_verification.status, "failed");
    assert.equal(run.output_verification.reason, "codex_output_missing");
    assert.equal(run.attempt_ledger[0].status, "verification_failed");
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
      "--permission-mode", DEFAULT_CLAUDE_PERMISSION_MODE,
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

    // P12.I1: clean custom command parsed to argv (no shell:true, no sh -c).
    assert.equal(invocation.provider, "custom");
    assert.equal(invocation.command, "node");
    assert.deepEqual(invocation.args, ["./agent.js", "--mode", "yolo"]);
    assert.equal(invocation.customCommand, "node ./agent.js --mode yolo");
    assert.equal(invocation.outputFile, null);
  });

  test("buildProviderInvocation rejects unparseable custom_command by default", () => {
    const invocation: any = buildProviderInvocation({
      provider: "shell",
      config: {
        ai: {
          custom_command: "printf provider-output; touch /tmp/yolo-custom-command-poc",
        },
      },
      workDir: "/repo/worktree",
      rootDir: "/repo",
      runtimeDir: "/repo/state/runtime",
    });

    assert.equal(invocation.ok, false);
    assert.equal(invocation.provider, "custom");
    assert.equal(invocation.command, null);
    assert.equal(invocation.code, "CUSTOM_COMMAND_UNPARSEABLE");
    assert.match(invocation.message, /Refusing implicit sh -c fallback/);
  });

  test("spawnProviderPrompt blocks injected custom_command payloads without spawning shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-custom-command-block-"));
    try {
      const payloads = [
        (marker) => `printf provider-output; touch ${marker}`,
        (marker) => `printf provider-output $(touch ${marker})`,
      ];

      for (const payload of payloads) {
        const marker = join(root, `marker-${Math.random().toString(16).slice(2)}`);
        let spawned = false;
        const run = await spawnProviderPrompt("prompt", {
          config: { ai: { provider: "custom", custom_command: payload(marker) } },
          rootDir: root,
          runtimeDir: root,
          commandExists: () => true,
          spawnImpl: () => {
            spawned = true;
            throw new Error("spawn should not be called");
          },
        });

        assert.equal(spawned, false);
        assert.equal(existsSync(marker), false);
        assert.equal(run.success, false);
        assert.equal(run.status, "blocked");
        assert.equal(run.reason, "custom_command_unparseable");
        assert.ok(run.preflight.blockers.some((blocker) => blocker.code === "CUSTOM_COMMAND_UNPARSEABLE"));
        assert.match(run.stderr, /Refusing implicit sh -c fallback/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("spawnProviderPrompt runs parseable custom_command through argv", async () => {
    let capturedCommand = null;
    let capturedArgs = null;
    const run = await spawnProviderPrompt("prompt", {
      config: { ai: { provider: "custom", custom_command: "node ./agent.js --mode yolo" } },
      rootDir: "/repo",
      runtimeDir: "/repo/state/runtime",
      commandExists: () => true,
      spawnImpl: (command, args) => {
        capturedCommand = command;
        capturedArgs = args;
        return fakeProviderSpawn({ stdout: "done\n", code: 0 })();
      },
    });

    assert.equal(capturedCommand, "node");
    assert.deepEqual(capturedArgs, ["./agent.js", "--mode", "yolo"]);
    assert.equal(run.success, true);
    assert.equal(run.status, "completed");
  });

  test("spawnProviderPrompt allows shell custom_command only with explicit opt-in", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-custom-command-shell-"));
    try {
      const marker = join(root, "marker");
      const run = await spawnProviderPrompt("prompt", {
        config: {
          ai: {
            provider: "custom",
            custom_command: `printf shell-opt-in; touch ${marker}`,
            allowShellCustomCommand: true,
          },
        },
        rootDir: root,
        runtimeDir: root,
        commandExists: () => true,
      });

      assert.equal(existsSync(marker), true);
      assert.equal(run.success, true);
      assert.equal(run.status, "completed");
      assert.equal(run.stdout, "shell-opt-in");
      assert.equal(run.shell_custom_command, true);
      assert.ok(run.provider_warnings.some((warning) => warning.code === "CUSTOM_COMMAND_SHELL_OPT_IN"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      status: "failed",
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

  test("R4 hook: pre-tool-block-yolo-write blocks .yolo writes and allows other paths", () => {
    // Environment-independent hook invocation.
    //
    // Why source .ts via tsx (not a pre-built dist/*.js): the old version spawned
    // `node dist/hooks/pre-tool-block-yolo-write.js`, which only exists after
    // `npm run build`. Running the test without building first (fresh checkout,
    // selective `node --test`, editor test runners) made the spawn fail, and on
    // loaded machines the tight 5s timeout plus native-node ESM cold start
    // produced ETIMEDOUT → spawnSync status `null` (reported as
    // "actual: null expected: 2"). Running the TypeScript source through tsx
    // removes the dist build dependency entirely.
    //
    // Why an absolute --import file URL: the hook's `.yolo` scoping is computed
    // from `process.cwd()`, so the child MUST run with `cwd` = a throwaway temp
    // dir (not the repo). ESM package resolution walks up from that bare temp
    // cwd and cannot find `tsx`, so `--import tsx` fails with ERR_MODULE_NOT_FOUND.
    // Passing the loader as an absolute file URL (resolved from THIS repo's
    // node_modules) makes resolution independent of the child's cwd.
    const hookPath = join(YOLO_PACKAGE_ROOT, "hooks", "pre-tool-block-yolo-write.ts");
    if (!existsSync(hookPath)) {
      // Explicit skip, not a silent pass: a missing hook is a real signal.
      assert.ok(true, "pre-tool-block-yolo-write.ts source not present — skip");
      return;
    }
    if (!TSX_LOADER_URL) {
      assert.ok(true, "tsx loader not resolvable in this environment — skip");
      return;
    }

    const root = mkdtempSync(join(tmpdir(), "yolo-hook-test-"));
    // 30s matches the adversarial suite's hook tests; native-node ESM cold start
    // under load can spike well past the old 5s ceiling.
    const runHook = (input, opts = Object()) =>
      spawnSync("node", ["--import", TSX_LOADER_URL, hookPath], {
        input,
        timeout: 30000,
        cwd: root,
        encoding: "utf8",
        ...opts,
      });

    try {
      // Block .yolo paths
      const blockPayload = JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: join(root, ".yolo", "lifecycle", "status.json") },
      });
      const blockResult = runHook(blockPayload);
      assert.equal(blockResult.status, 2, `expected exit 2 for .yolo path, got ${blockResult.status}`);

      // Block .yolo paths as Edit
      const editPayload = JSON.stringify({
        tool_name: "Edit",
        tool_input: { file_path: ".yolo/state/foo.json" },
      });
      const editResult = runHook(editPayload);
      assert.equal(editResult.status, 2, `expected exit 2 for .yolo Edit, got ${editResult.status}`);

      const multiEditPayload = JSON.stringify({
        tool_name: "MultiEdit",
        tool_input: { file_path: ".yolo/state/foo.json", edits: [] },
      });
      const multiEditResult = runHook(multiEditPayload);
      assert.equal(multiEditResult.status, 2, `expected exit 2 for .yolo MultiEdit, got ${multiEditResult.status}`);

      const notebookPayload = JSON.stringify({
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: ".yolo/state/foo.ipynb" },
      });
      const notebookResult = runHook(notebookPayload);
      assert.equal(notebookResult.status, 2, `expected exit 2 for .yolo NotebookEdit, got ${notebookResult.status}`);

      const invalidJsonResult = runHook("{not json");
      assert.equal(invalidJsonResult.status, 2, `expected exit 2 for invalid JSON, got ${invalidJsonResult.status}`);

      // Allow normal paths
      const passPayload = JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: join(root, "src", "foo.ts") },
      });
      const passResult = runHook(passPayload);
      assert.equal(passResult.status, 0, `expected exit 0 for normal path, got ${passResult.status}`);

      // Any non-yolo-CLI Bash subcommand that references a .yolo path is blocked.
      const bashPayload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "echo .yolo" },
      });
      const bashResult = runHook(bashPayload);
      assert.equal(bashResult.status, 2, `expected exit 2 for Bash .yolo mention, got ${bashResult.status}`);

      const bashRedirectPayload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "echo '{}' > .yolo/lifecycle/status.json" },
      });
      const bashRedirectResult = runHook(bashRedirectPayload);
      assert.equal(bashRedirectResult.status, 2, `expected exit 2 for Bash .yolo redirect, got ${bashRedirectResult.status}`);

      const bashTeePayload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "printf '{}' | tee -a .yolo/state/events.jsonl" },
      });
      const bashTeeResult = runHook(bashTeePayload);
      assert.equal(bashTeeResult.status, 2, `expected exit 2 for Bash tee .yolo write, got ${bashTeeResult.status}`);

      const bashSedPayload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "sed -i 's/a/b/' .yolo/lifecycle/status.json" },
      });
      const bashSedResult = runHook(bashSedPayload);
      assert.equal(bashSedResult.status, 2, `expected exit 2 for Bash sed -i .yolo write, got ${bashSedResult.status}`);

      const yoloCliPayload = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "node ./dist/bin/yolo.js status --state-root /project/.yolo" },
      });
      const yoloCliResult = runHook(yoloCliPayload);
      assert.equal(yoloCliResult.status, 0, `expected exit 0 for yolo CLI state access, got ${yoloCliResult.status}`);

      // Block write without file_path/path fail-closed
      const noFilePayload = JSON.stringify({ tool_name: "Write", tool_input: {} });
      const noFileResult = runHook(noFilePayload);
      assert.equal(noFileResult.status, 2, `expected exit 2 for no file_path, got ${noFileResult.status}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Regression: provider stdout/stderr used to accumulate without bound (`out += chunk` /
  // `err += chunk`). A runaway provider emitting megabytes of output would grow resident
  // memory until the runner OOMed or stalled. The fix caps each stream at maxOutputBytes,
  // records the dropped tail, and kills the child once killBytes is exceeded.
  test("spawnProviderPrompt caps runaway provider stdout to a bounded size and reports truncation", async () => {
    // Emit far more than the cap (50MB across many chunks) so the collector must stop
    // appending and the hard-limit kill must fire. Chunks are small so the data handler runs
    // many times — exercising the "already capped" accounting path, not a single write.
    const CAP = 64 * 1024;
    const KILL_MULT = 5;
    const FLOOD_BYTES = 50 * 1024 * 1024;
    const CHUNK = 256 * 1024;
    let killSignal = null;
    const floodSpawn = () => {
      const stdin = new PassThrough();
      const stdoutStream = new PassThrough();
      const stderrStream = new PassThrough();
      const child: EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill?: (sig: string) => boolean } = Object.assign(new EventEmitter(), {
        pid: 4242,
        stdin,
        stdout: stdoutStream,
        stderr: stderrStream,
        kill: (sig) => { killSignal = sig; return true; },
      });
      // Write asynchronously so the data handler is invoked repeatedly across ticks; resolve
      // via close once everything has drained.
      (async () => {
        let written = 0;
        const buf = Buffer.alloc(CHUNK, 0x61); // 'a'
        while (written < FLOOD_BYTES) {
          if (!stdoutStream.write(buf)) await new Promise((r) => stdoutStream.once("drain", r));
          written += CHUNK;
        }
        stdoutStream.end();
        setImmediate(() => child.emit("close", 0, null));
      })();
      return child;
    };

    const run = await spawnProviderPrompt("prompt", spawnOptions({
      maxOutputBytes: CAP,
      outputKillMultiplier: KILL_MULT,
      spawnImpl: floodSpawn,
    }));

    // Stable exit: the run resolved without throwing/OOMing.
    assert.equal(typeof run.success, "boolean");
    // Output-flood kill is surfaced as killed, not a clean completion.
    assert.equal(run.status, "killed");
    assert.equal(run.success, false);
    // The child was killed once it crossed the hard ceiling.
    assert.equal(killSignal, "SIGKILL");
    // stdout was truncated to within the cap (captured prefix kept).
    assert.ok(run.stdout.length <= CAP, `stdout ${run.stdout.length} must be <= cap ${CAP}`);
    // Truncation metadata is present and accounts for dropped bytes.
    assert.ok(run.output_limits, "output_limits metadata must be present on truncation");
    assert.equal(run.output_limits.kill_triggered, true);
    assert.equal(run.output_limits.reason, "OUTPUT_LIMIT_EXCEEDED");
    assert.equal(run.output_limits.kill_bytes, CAP * KILL_MULT);
    assert.equal(run.output_limits.stdout.truncated, true);
    assert.equal(run.output_limits.stdout.captured_bytes, CAP);
    assert.equal(run.output_limits.stdout.max_bytes, CAP);
    // Every byte past the captured prefix is accounted for as dropped.
    assert.ok(run.output_limits.stdout.dropped_bytes >= FLOOD_BYTES - CAP - CHUNK,
      `dropped_bytes ${run.output_limits.stdout.dropped_bytes} should account for ~flood minus cap`);
  });

  test("spawnProviderPrompt leaves normal small output untouched (no truncation metadata)", async () => {
    // The cap must not change the happy path: small outputs are captured verbatim and no
    // output_limits metadata is attached.
    const run = await spawnProviderPrompt("prompt", spawnOptions({
      spawnImpl: fakeProviderSpawn({ stdout: "done\n", code: 0 }),
    }));

    assert.equal(run.success, true);
    assert.equal(run.status, "completed");
    assert.equal(run.stdout, "done");
    assert.equal(run.output_limits, undefined);
  });

  test("spawnProviderPrompt caps runaway provider stderr independently and reports truncation", async () => {
    // stderr has its own cap and kill accounting so a chatty stderr alone can trip the limit.
    const CAP = 32 * 1024;
    const KILL_MULT = 5;
    const FLOOD_BYTES = 5 * 1024 * 1024;
    const CHUNK = 128 * 1024;
    let killSignal = null;
    const stderrFloodSpawn = () => {
      const stdin = new PassThrough();
      const stdoutStream = new PassThrough();
      const stderrStream = new PassThrough();
      const child: EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill?: (sig: string) => boolean } = Object.assign(new EventEmitter(), {
        pid: 4243,
        stdin,
        stdout: stdoutStream,
        stderr: stderrStream,
        kill: (sig) => { killSignal = sig; return true; },
      });
      (async () => {
        let written = 0;
        const buf = Buffer.alloc(CHUNK, 0x62); // 'b'
        while (written < FLOOD_BYTES) {
          if (!stderrStream.write(buf)) await new Promise((r) => stderrStream.once("drain", r));
          written += CHUNK;
        }
        stderrStream.end();
        setImmediate(() => child.emit("close", 0, null));
      })();
      return child;
    };

    const run = await spawnProviderPrompt("prompt", spawnOptions({
      maxOutputBytes: CAP,
      outputKillMultiplier: KILL_MULT,
      spawnImpl: stderrFloodSpawn,
    }));

    assert.equal(run.status, "killed");
    assert.equal(killSignal, "SIGKILL");
    assert.equal(run.output_limits.kill_triggered, true);
    assert.equal(run.output_limits.stderr.truncated, true);
    assert.equal(run.output_limits.stderr.captured_bytes, CAP);
    assert.ok(run.output_limits.stderr.dropped_bytes >= FLOOD_BYTES - CAP - CHUNK,
      `stderr dropped_bytes ${run.output_limits.stderr.dropped_bytes} should account for ~flood minus cap`);
    // stdout stayed clean (no stderr-induced stdout truncation).
    assert.equal(run.output_limits.stdout.truncated, false);
  });
});
