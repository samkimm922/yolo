const PROVIDER_ALIASES = {
  anthropic: "claude",
  claude: "claude",
  codex: "codex",
  openai: "codex",
  custom: "custom",
  shell: "custom",
  local: "custom",
};

const PROVIDER_COMMANDS = {
  claude: "claude",
  codex: "codex",
  custom: null,
};

function cleanString(value) {
  return String(value ?? "").trim();
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function commandForProvider(provider, config = {}) {
  if (provider === "custom") return cleanString(config.ai?.custom_command || config.ai?.command) || null;
  return PROVIDER_COMMANDS[provider] || provider;
}

function commandExecutable(command) {
  const value = cleanString(command);
  if (!value) return null;
  return value.split(/\s+/)[0] || null;
}

export function normalizeAgentProvider(value) {
  const provider = cleanString(typeof value === "object" ? value?.selected || value?.provider : value).toLowerCase();
  if (!provider || provider === "auto") return null;
  return PROVIDER_ALIASES[provider] || provider;
}

export function buildAgentAdapterCapabilities(provider, config = {}) {
  const normalized = normalizeAgentProvider(provider) || "claude";
  const ai = config.ai || {};
  const codexSandbox = cleanString(ai.codex_sandbox || "workspace-write");
  const claudePermissionMode = cleanString(ai.claude_permission_mode || "default");
  const customMode = cleanString(ai.custom_sandbox || "external");

  if (normalized === "codex") {
    return {
      provider: "codex",
      command: commandForProvider("codex", config),
      stdin_prompt: true,
      output_capture: true,
      output_capture_mode: "last_message_file",
      model_selection: Boolean(ai.codex_model || ai.model),
      budget_limit: false,
      sandbox: true,
      sandbox_mode: codexSandbox,
      approval_policy: cleanString(ai.codex_approval || "never"),
      file_write: codexSandbox !== "read-only",
      shell_exec: codexSandbox !== "read-only",
    };
  }

  if (normalized === "custom") {
    return {
      provider: "custom",
      command: commandForProvider("custom", config),
      stdin_prompt: true,
      output_capture: true,
      output_capture_mode: "stdout",
      model_selection: Boolean(ai.model),
      budget_limit: false,
      sandbox: customMode !== "external" && customMode !== "unknown",
      sandbox_mode: customMode || "external",
      approval_policy: cleanString(ai.custom_approval || "external"),
      file_write: customMode !== "read-only",
      shell_exec: customMode !== "read-only",
    };
  }

  return {
    provider: "claude",
    command: commandForProvider("claude", config),
    stdin_prompt: true,
    output_capture: true,
    output_capture_mode: "stdout",
    model_selection: Boolean(ai.model),
    budget_limit: positiveNumber(ai.max_budget_usd) !== null,
    sandbox: false,
    sandbox_mode: "permission-mode",
    approval_policy: claudePermissionMode,
    file_write: claudePermissionMode !== "read-only",
    shell_exec: claudePermissionMode !== "read-only",
  };
}

export function buildAgentAdapterContract(options = {}) {
  const config = options.config || {};
  const requested = normalizeAgentProvider(options.requested || options.provider || config.ai?.executor || config.ai?.provider);
  const selected = normalizeAgentProvider(options.selected || options.providerDetection?.selected || requested || "claude") || "claude";
  const command = commandForProvider(selected, config);
  const capabilities = buildAgentAdapterCapabilities(selected, config);
  const budgetUsd = positiveNumber(config.ai?.max_budget_usd);

  return {
    schema_version: "1.0",
    schema: "yolo.runtime.agent_adapter_contract.v1",
    provider: selected,
    requested_provider: requested,
    command,
    available: options.available?.[selected] ?? null,
    capabilities,
    budget: {
      max_usd: budgetUsd,
      enforceable: selected === "claude" && budgetUsd !== null,
      reason: selected === "claude"
        ? (budgetUsd === null ? "no_max_budget_configured" : "claude_cli_budget_guard")
        : (budgetUsd === null ? "no_max_budget_configured" : "provider_budget_guard_not_supported"),
    },
    sandbox: {
      mode: capabilities.sandbox_mode,
      supported: capabilities.sandbox,
      approval_policy: capabilities.approval_policy,
      file_write: capabilities.file_write,
      shell_exec: capabilities.shell_exec,
    },
  };
}

function defaultCommandExists() {
  return null;
}

export function inspectAgentAdapterContract(options = {}) {
  const providerDetection = options.providerDetection || {};
  const config = options.config || {};
  const requested = normalizeAgentProvider(options.requested || providerDetection.requested || config.ai?.executor || config.ai?.provider);
  const selected = normalizeAgentProvider(options.provider || providerDetection.selected || requested || "claude") || "claude";
  const command = commandForProvider(selected, config);
  const executable = selected === "custom" ? commandExecutable(command) : command;
  const commandExists = options.commandExists || defaultCommandExists;
  const available = {
    ...(providerDetection.available || {}),
  };
  if (available[selected] == null && executable) {
    const exists = commandExists(executable);
    if (exists !== null && exists !== undefined) available[selected] = Boolean(exists);
  }

  const contract = buildAgentAdapterContract({
    config,
    requested,
    selected,
    available,
    providerDetection,
  });
  const blockers = [];
  const warnings = [];

  if (!command) {
    blockers.push({
      code: "AGENT_COMMAND_MISSING",
      provider: selected,
      message: "agent adapter has no command",
    });
  }

  if (available[selected] === false) {
    blockers.push({
      code: "AGENT_COMMAND_UNAVAILABLE",
      provider: selected,
      command,
      message: "selected agent command is not available",
    });
  }

  if (selected === "claude" && contract.sandbox.approval_policy === "dangerously-skip-permissions") {
    blockers.push({
      code: "AGENT_PERMISSION_UNSAFE",
      provider: selected,
      approval_policy: contract.sandbox.approval_policy,
      message: "claude dangerously-skip-permissions is not allowed by the public SDK contract",
    });
  }

  if (selected === "codex" && contract.sandbox.mode === "danger-full-access") {
    blockers.push({
      code: "AGENT_SANDBOX_UNSAFE",
      provider: selected,
      sandbox_mode: contract.sandbox.mode,
      message: "codex danger-full-access is not allowed by the public SDK contract",
    });
  }

  if (contract.budget.max_usd !== null && contract.budget.enforceable !== true) {
    warnings.push({
      code: "AGENT_BUDGET_NOT_ENFORCEABLE",
      provider: selected,
      max_usd: contract.budget.max_usd,
      message: "configured budget is not enforceable by this provider adapter",
    });
  }

  if (selected === "custom") {
    warnings.push({
      code: "AGENT_CUSTOM_ADAPTER_UNVERIFIED",
      provider: selected,
      message: "custom adapters require external command and sandbox verification",
    });
  }

  return {
    status: blockers.length > 0 ? "blocked" : (warnings.length > 0 ? "warning" : "pass"),
    blocks_execution: blockers.length > 0,
    selected_provider: selected,
    requested_provider: requested,
    available,
    contract,
    blockers,
    warnings,
  };
}
