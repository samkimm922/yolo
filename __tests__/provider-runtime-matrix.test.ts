import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { detectModelProvider } from "../src/runtime/adapters/provider-doctor.js";
import { DEFAULT_CLAUDE_SETTINGS_PATH } from "../src/runtime/execution/provider-adapter.js";
import { createYoloSdk } from "../sdk.js";
import {
  buildProviderCliDryRunMatrix,
  buildProviderRuntimeMatrix,
  inspectProviderCliDryRunMatrix,
  inspectProviderRuntimeMatrix,
} from "../src/runtime/adapters/provider-runtime-matrix.js";

const projectRoot = resolve("/tmp/yolo-provider-runtime-consumer");
const stateRoot = join(projectRoot, ".yolo");
const baseConfig = {
  ai: {
    model: "claude-sonnet-4",
    settings: "settings-minimal.json",
    max_budget_usd: 2,
    codex_model: "gpt-5-codex",
    codex_sandbox: "workspace-write",
    codex_approval: "never",
    custom_command: "node ./agent.js",
    custom_sandbox: "workspace-write",
  },
};

function commandExists(command) {
  return ["claude", "codex", "node"].includes(command);
}

describe("provider runtime matrix", () => {
  test("detectModelProvider can select a configured custom adapter", () => {
    const result = detectModelProvider({
      config: {
        ai: {
          provider: "custom",
          custom_command: "node ./agent.js",
        },
      },
      commandExists,
    });

    assert.equal(result.selected, "custom");
    assert.equal(result.requested, "custom");
    assert.equal(result.available.custom, true);
    assert.equal(result.reason, "configured_provider_available");
  });

  test("detectModelProvider treats executor as adapter choice and does not infer from model names", () => {
    const result = detectModelProvider({
      config: {
        ai: {
          executor: "claude",
          model: "openrouter/deepseek-chat",
        },
      },
      commandExists,
    });

    assert.equal(result.selected, "claude");
    assert.equal(result.requested, "claude");
    assert.equal(result.available.claude, true);
    assert.equal(result.reason, "configured_provider_available");
  });

  test("buildProviderRuntimeMatrix describes claude, codex, and custom runtime paths", () => {
    const matrix = buildProviderRuntimeMatrix({
      config: baseConfig,
      projectRoot,
      stateRoot,
      commandExists,
      now: () => 123,
      random: () => 0.5,
    });

    assert.equal(matrix.project_root, projectRoot);
    assert.equal(matrix.state_root, stateRoot);
    assert.equal(matrix.runtime_dir, join(stateRoot, "state", "runtime"));
    assert.equal(matrix.gate_log_dir, matrix.runtime_dir);
    assert.equal(matrix.runner_runtime.state_root, stateRoot);
    assert.deepEqual(matrix.providers.map((entry) => entry.provider), ["claude", "codex", "custom"]);
    assert.deepEqual(matrix.providers.map((entry) => entry.selected_provider), ["claude", "codex", "custom"]);

    const claude = matrix.providers.find((entry) => entry.provider === "claude");
    const settingsIndex = claude.invocation.args.indexOf("--settings");
    assert.notEqual(settingsIndex, -1);
    const settingsArg = claude.invocation.args[settingsIndex + 1];
    // Default settings are now inline JSON with absolute hook path
    assert.equal(settingsArg.startsWith("{"), true);
    assert.ok(settingsArg.includes("pre-tool-block-yolo-write.js"));
    assert.equal(claude.invocation.settings_file, null);

    const codex = matrix.providers.find((entry) => entry.provider === "codex");
    assert.equal(codex.invocation.command, "codex");
    assert.equal(codex.invocation.output_file, join(stateRoot, "state", "runtime", "codex-output-123-8.txt"));

    const custom = matrix.providers.find((entry) => entry.provider === "custom");
    assert.equal(custom.invocation.command, "sh");
    assert.deepEqual(custom.invocation.args, ["-c", "node ./agent.js"]);
  });

  test("inspectProviderRuntimeMatrix fails closed on unavailable providers and unsafe paths", () => {
    const blocked = inspectProviderRuntimeMatrix({
      config: baseConfig,
      projectRoot,
      stateRoot,
      gateLogDir: join(projectRoot, ".logs"),
      commandExists: (command) => command === "node",
    });

    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocks_execution, true);
    assert.ok(blocked.blockers.some((blocker) => blocker.code === "PROVIDER_MATRIX_GATE_LOG_DIR_MISMATCH"));
    assert.ok(blocked.blockers.some((blocker) => blocker.code === "PROVIDER_MATRIX_SELECTION_MISMATCH"));
    assert.ok(blocked.blockers.some((blocker) => blocker.code === "AGENT_COMMAND_UNAVAILABLE"));
  });

  test("inspectProviderRuntimeMatrix blocks missing claude settings before provider execution", () => {
    const result = inspectProviderRuntimeMatrix({
      config: {
        ai: {
          provider: "claude",
          model: "claude-sonnet-4",
          settings: "missing-settings.json",
        },
      },
      providers: ["claude"],
      projectRoot,
      stateRoot,
      commandExists,
      existsSync: () => false,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blocks_execution, true);
    assert.ok(result.blockers.some((blocker) => (
      blocker.code === "CLAUDE_SETTINGS_FILE_MISSING"
      && blocker.provider === "claude"
      && blocker.message.includes(join(projectRoot, "missing-settings.json"))
    )));
    const claude = result.matrix.providers[0];
    assert.equal(claude.status, "blocked");
    assert.equal(claude.invocation_preflight.status, "blocked");
  });

  test("buildProviderCliDryRunMatrix describes real provider CLI contracts without spawning", () => {
    const matrix = buildProviderCliDryRunMatrix({
      config: baseConfig,
      projectRoot,
      stateRoot,
      commandExists,
      now: () => 123,
      random: () => 0.5,
      requireExplicitBudget: true,
    });

    assert.equal(matrix.schema, "yolo.runtime.provider_cli_dry_run_matrix.v1");
    assert.equal(matrix.dry_run, true);
    assert.equal(matrix.execution_allowed, false);
    assert.deepEqual(matrix.providers.map((entry) => entry.provider), ["claude", "codex", "custom"]);
    assert.ok(matrix.providers.every((entry) => entry.will_spawn === false));
    assert.ok(matrix.providers.every((entry) => entry.stdin.mode === "prompt"));

    const claude = matrix.providers.find((entry) => entry.provider === "claude");
    assert.equal(claude.command, "claude");
    assert.equal(claude.budget.enforceable, true);
    assert.equal(claude.budget.present_in_cli, true);
    assert.ok(claude.args.includes("--max-budget-usd"));

    const codex = matrix.providers.find((entry) => entry.provider === "codex");
    assert.equal(codex.command, "codex");
    assert.equal(codex.output_capture.output_file, join(stateRoot, "state", "runtime", "codex-output-123-8.txt"));

    const custom = matrix.providers.find((entry) => entry.provider === "custom");
    assert.equal(custom.command, "sh");
    assert.deepEqual(custom.args, ["-c", "node ./agent.js"]);
  });

  test("inspectProviderCliDryRunMatrix fails closed before unsafe or executable provider calls", () => {
    const result = inspectProviderCliDryRunMatrix({
      config: {
        ai: {
          provider: "claude",
          model: "claude-sonnet-4",
          claude_permission_mode: "dangerously-skip-permissions",
        },
      },
      projectRoot,
      stateRoot,
      commandExists,
      requireExplicitBudget: true,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blocks_execution, true);
    assert.ok(result.blockers.some((blocker) => blocker.code === "CLI_DRY_RUN_AGENT_PERMISSION_UNSAFE"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "CLI_DRY_RUN_CLAUDE_BUDGET_REQUIRED"));

    const executable = inspectProviderCliDryRunMatrix({
      matrix: {
        schema: "yolo.runtime.provider_cli_dry_run_matrix.v1",
        dry_run: false,
        execution_allowed: true,
        runtime_dir: join(stateRoot, "state", "runtime"),
        providers: [{ provider: "claude", dry_run: false, execution_allowed: true, will_spawn: true, command: "claude", stdin: { mode: "prompt", required: true } }],
      },
    });
    assert.equal(executable.status, "blocked");
    assert.ok(executable.blockers.some((blocker) => blocker.code === "CLI_DRY_RUN_DISABLED"));
    assert.ok(executable.blockers.some((blocker) => blocker.code === "CLI_DRY_RUN_WOULD_EXECUTE"));
  });

  test("createYoloSdk exposes provider runtime matrix helpers bound to SDK roots", () => {
    const sdk = createYoloSdk({
      projectRoot,
      stateRoot,
      config: baseConfig,
    });
    const result = sdk.provider.inspectProviderRuntimeMatrix({
      commandExists,
      now: () => 456,
      random: () => 0.5,
    });

    assert.equal(result.blocks_execution, true);
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "AGENT_BUDGET_NOT_ENFORCEABLE" && blocker.provider === "codex"));
    assert.equal(result.matrix.state_root, stateRoot);
    assert.equal(result.matrix.gate_log_dir, join(stateRoot, "state", "runtime"));
    assert.equal(result.matrix.providers.length, 3);

    const dryRun = sdk.provider.inspectProviderCliDryRunMatrix({
      commandExists,
      now: () => 456,
      random: () => 0.5,
    });
    assert.equal(dryRun.blocks_execution, true);
    assert.ok(dryRun.blockers.some((blocker) => blocker.code === "CLI_DRY_RUN_AGENT_BUDGET_NOT_ENFORCEABLE" && blocker.provider === "codex"));
    assert.equal(dryRun.matrix.state_root, stateRoot);
    assert.equal(dryRun.matrix.providers.find((entry) => entry.provider === "codex").will_spawn, false);
  });
});
