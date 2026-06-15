import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentAdapterCapabilities,
  buildAgentAdapterContract,
  inspectAgentAdapterContract,
  normalizeAgentProvider,
} from "../src/runtime/adapters/agent-contract.js";
import { createYoloSdk } from "../sdk.js";

const baseConfig = {
  ai: {
    provider: "claude",
    model: "claude-sonnet-4-6",
    claude_permission_mode: "acceptEdits",
    max_budget_usd: 3,
    codex_model: "gpt-5-codex",
    codex_sandbox: "workspace-write",
    codex_approval: "never",
  },
};

describe("agent adapter contract", () => {
  test("normalizes provider aliases without binding the SDK to one model", () => {
    assert.equal(normalizeAgentProvider("anthropic"), "claude");
    assert.equal(normalizeAgentProvider("openai"), "codex");
    assert.equal(normalizeAgentProvider("shell"), "custom");
    assert.equal(normalizeAgentProvider("auto"), null);
  });

  test("buildAgentAdapterContract describes claude budget and permission policy", () => {
    const contract = buildAgentAdapterContract({
      provider: "claude",
      config: baseConfig,
      available: { claude: true },
    });

    assert.equal(contract.schema, "yolo.runtime.agent_adapter_contract.v1");
    assert.equal(contract.schema_version, "1.1");
    assert.equal(contract.provider, "claude");
    assert.equal(contract.command, "claude");
    assert.equal(contract.budget.enforceable, true);
    assert.equal(contract.budget.max_usd, 3);
    assert.equal(contract.sandbox.approval_policy, "acceptEdits");
    assert.equal(contract.capabilities.stdin_prompt, true);
    assert.equal(contract.capabilities.output_capture_mode, "stdout");
    assert.equal(contract.timeout.required, true);
    assert.equal(contract.retry_policy.fail_closed, true);
    assert.equal(contract.output_schema.schema, "yolo.runtime.provider_run_result.v1");
    assert.ok(contract.failure_codes.includes("AGENT_PERMISSION_UNSAFE"));
    assert.ok(contract.allowed_roots.length > 0);
    assert.equal(contract.permission_policy.fail_closed, true);
  });

  test("buildAgentAdapterCapabilities captures codex sandbox and approval policy", () => {
    const capabilities = buildAgentAdapterCapabilities("codex", baseConfig);

    assert.deepEqual({
      provider: capabilities.provider,
      command: capabilities.command,
      output_capture_mode: capabilities.output_capture_mode,
      sandbox_mode: capabilities.sandbox_mode,
      approval_policy: capabilities.approval_policy,
      file_write: capabilities.file_write,
    }, {
      provider: "codex",
      command: "codex",
      output_capture_mode: "last_message_file",
      sandbox_mode: "workspace-write",
      approval_policy: "never",
      file_write: true,
    });
  });

  test("inspectAgentAdapterContract blocks unavailable and unsafe adapters", () => {
    const unavailable = inspectAgentAdapterContract({
      provider: "codex",
      config: baseConfig,
      commandExists: () => false,
    });
    assert.equal(unavailable.status, "blocked");
    assert.ok(unavailable.blockers.some((blocker) => blocker.code === "AGENT_COMMAND_UNAVAILABLE"));
    assert.ok(unavailable.blockers.some((blocker) => blocker.code === "AGENT_BUDGET_NOT_ENFORCEABLE"));

    const unsafeClaude = inspectAgentAdapterContract({
      provider: "claude",
      config: { ai: { ...baseConfig.ai, claude_permission_mode: "dangerously-skip-permissions" } },
      commandExists: () => true,
    });
    assert.equal(unsafeClaude.status, "blocked");
    assert.ok(unsafeClaude.blockers.some((blocker) => blocker.code === "AGENT_PERMISSION_UNSAFE"));

    const unsafeCodex = inspectAgentAdapterContract({
      provider: "codex",
      config: { ai: { ...baseConfig.ai, codex_sandbox: "danger-full-access" } },
      commandExists: () => true,
    });
    assert.equal(unsafeCodex.status, "blocked");
    assert.ok(unsafeCodex.blockers.some((blocker) => blocker.code === "AGENT_SANDBOX_UNSAFE"));
  });

  test("inspectAgentAdapterContract blocks when configured budget is not enforceable", () => {
    const result = inspectAgentAdapterContract({
      provider: "codex",
      config: baseConfig,
      commandExists: () => true,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blocks_execution, true);
    assert.deepEqual(result.blockers.map((blocker) => blocker.code), ["AGENT_BUDGET_NOT_ENFORCEABLE"]);
  });

  test("custom adapters require explicit command verification", () => {
    const result = inspectAgentAdapterContract({
      provider: "custom",
      config: { ai: { custom_command: "node ./agent.js", custom_sandbox: "workspace-write" } },
      commandExists: (command) => command === "node",
    });

    assert.equal(result.status, "warning");
    assert.equal(result.contract.command, "node ./agent.js");
    assert.deepEqual(result.warnings.map((warning) => warning.code), ["AGENT_CUSTOM_ADAPTER_UNVERIFIED"]);
  });

  test("createYoloSdk exposes provider adapter contract helpers", () => {
    const sdk = createYoloSdk();

    assert.equal(typeof sdk.provider.detectModelProvider, "function");
    assert.equal(typeof sdk.provider.buildAgentAdapterContract, "function");
    assert.equal(typeof sdk.provider.inspectAgentAdapterContract, "function");
    assert.equal(typeof sdk.provider.inspectProviderRuntimeMatrix, "function");
    assert.equal(typeof sdk.provider.normalizeAgentProvider, "function");
  });
});
