import { resolve } from "node:path";

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

export const AGENT_ADAPTER_CONTRACT_SCHEMA_VERSION = "1.1";
export const AGENT_ADAPTER_CONTRACT_SCHEMA = "yolo.runtime.agent_adapter_contract.v1";
export const DEFAULT_CLAUDE_PERMISSION_MODE = "acceptEdits";

function cleanString(value) {
  return String(value ?? "").trim();
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function commandForProvider(provider, config = Object()) {
  if (provider === "custom") return cleanString(config.ai?.custom_command || config.ai?.command) || null;
  return PROVIDER_COMMANDS[provider] || provider;
}

function commandExecutable(command) {
  const value = cleanString(command);
  if (!value) return null;
  return value.split(/\s+/)[0] || null;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function positiveMilliseconds(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function uniqueResolved(paths = []) {
  return [...new Set(paths.map(cleanString).filter(Boolean).map((path) => resolve(path)))];
}

function adapterAllowedRoots({ options = Object(), config = Object() } = Object()) {
  const explicit = options.allowedRoots || options.allowed_roots || config.ai?.allowed_roots || config.ai?.allowedRoots;
  const roots = Array.isArray(explicit) ? explicit : (explicit ? [explicit] : []);
  roots.push(options.rootDir || options.root_dir || options.projectRoot || options.project_root);
  roots.push(options.workDir || options.work_dir);
  roots.push(options.runtimeDir || options.runtime_dir);
  const resolved = uniqueResolved(roots);
  return resolved.length > 0 ? resolved : [resolve(process.cwd())];
}

function timeoutPolicy(options = Object(), config = Object()) {
  const ai = config.ai || {};
  const maxMs = positiveMilliseconds(
    options.timeoutMs || options.timeout_ms || options.timeout || ai.timeout_ms || ai.timeoutMs,
    480000,
  );
  return {
    required: true,
    max_ms: maxMs,
    enforceable: true,
    failure_code: "AGENT_TIMEOUT",
  };
}

function retryPolicy(options = Object(), config = Object()) {
  const ai = config.ai || {};
  return {
    max_attempts: positiveInteger(
      options.maxAttempts || options.max_attempts || options.retryAttempts || options.retry_attempts || ai.retry_attempts || ai.max_attempts,
      0,
    ),
    retryable_failure_codes: [
      "provider_timed_out",
      "provider_killed",
      "provider_no_output",
      "provider_verification_failed",
    ],
    backoff_ms: positiveMilliseconds(options.retryBackoffMs || options.retry_backoff_ms || ai.retry_backoff_ms, 0),
    fail_closed: true,
  };
}

function outputSchemaFor(capabilities = Object()) {
  return {
    schema: "yolo.runtime.provider_run_result.v1",
    required: true,
    capture_mode: capabilities.output_capture_mode || "stdout",
    required_fields: ["success", "status", "provider", "command", "stdout", "stderr", "attempt_ledger"],
    evidence_artifacts: capabilities.output_capture_mode === "last_message_file"
      ? ["output_last_message_file"]
      : ["stdout"],
  };
}

function rootPolicy(options = Object(), allowedRoots = []) {
  return {
    root_dir: options.rootDir || options.root_dir || options.projectRoot || options.project_root || null,
    work_dir: options.workDir || options.work_dir || null,
    runtime_dir: options.runtimeDir || options.runtime_dir || null,
    allowed_roots: allowedRoots,
    require_allowed_root: true,
    fail_closed: true,
  };
}

export function normalizeAgentProvider(value) {
  const provider = cleanString(typeof value === "object" ? value?.selected || value?.provider : value).toLowerCase();
  if (!provider || provider === "auto") return null;
  return PROVIDER_ALIASES[provider] || provider;
}

export function buildAgentAdapterCapabilities(provider, config = Object()) {
  const normalized = normalizeAgentProvider(provider) || "claude";
  const ai = config.ai || {};
  const codexSandbox = cleanString(ai.codex_sandbox || "workspace-write");
  const claudePermissionMode = cleanString(ai.claude_permission_mode || DEFAULT_CLAUDE_PERMISSION_MODE);
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

export function buildAgentAdapterContract(options = Object()) {
  const config = options.config || {};
  const requested = normalizeAgentProvider(options.requested || options.provider || config.ai?.executor || config.ai?.provider);
  const selected = normalizeAgentProvider(options.selected || options.providerDetection?.selected || requested || "claude") || "claude";
  const command = commandForProvider(selected, config);
  const capabilities = buildAgentAdapterCapabilities(selected, config);
  const budgetUsd = positiveNumber(config.ai?.max_budget_usd);
  const allowedRoots = adapterAllowedRoots({ options, config });

  return {
    schema_version: AGENT_ADAPTER_CONTRACT_SCHEMA_VERSION,
    schema: AGENT_ADAPTER_CONTRACT_SCHEMA,
    provider: selected,
    requested_provider: requested,
    command,
    available: options.available?.[selected] ?? null,
    capabilities,
    timeout: timeoutPolicy(options, config),
    retry_policy: retryPolicy(options, config),
    budget: {
      max_usd: budgetUsd,
      enforceable: selected === "claude" && budgetUsd !== null,
      required: budgetUsd !== null,
      failure_code: "AGENT_BUDGET_NOT_ENFORCEABLE",
      reason: selected === "claude"
        ? (budgetUsd === null ? "no_max_budget_configured" : "claude_cli_budget_guard")
        : (budgetUsd === null ? "no_max_budget_configured" : "provider_budget_guard_not_supported"),
    },
    output_schema: outputSchemaFor(capabilities),
    evidence_schema: outputSchemaFor(capabilities),
    failure_codes: [
      "AGENT_COMMAND_MISSING",
      "AGENT_COMMAND_UNAVAILABLE",
      "AGENT_PERMISSION_UNSAFE",
      "AGENT_SANDBOX_UNSAFE",
      "AGENT_BUDGET_NOT_ENFORCEABLE",
      "AGENT_ALLOWED_ROOTS_MISSING",
      "AGENT_ROOT_POLICY_MISSING",
    ],
    allowed_roots: allowedRoots,
    root_policy: rootPolicy(options, allowedRoots),
    permission_policy: {
      provider: selected,
      sandbox_mode: capabilities.sandbox_mode,
      approval_policy: capabilities.approval_policy,
      file_write: capabilities.file_write,
      shell_exec: capabilities.shell_exec,
      allowed_tools: cleanString(config.ai?.claude_allowed_tools || config.ai?.allowed_tools || ""),
      disallowed_tools: cleanString(config.ai?.claude_disallowed_tools || config.ai?.disallowed_tools || ""),
      fail_closed: true,
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

export function inspectAgentAdapterContract(options = Object()) {
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
    allowedRoots: options.allowedRoots || options.allowed_roots,
    rootDir: options.rootDir || options.root_dir,
    workDir: options.workDir || options.work_dir,
    runtimeDir: options.runtimeDir || options.runtime_dir,
    projectRoot: options.projectRoot || options.project_root,
    timeoutMs: options.timeoutMs || options.timeout_ms || options.timeout,
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

  if (selected === "claude" && ["dangerously-skip-permissions", "bypasspermissions"].includes(cleanString(contract.sandbox.approval_policy).toLowerCase())) {
    blockers.push({
      code: "AGENT_PERMISSION_UNSAFE",
      provider: selected,
      approval_policy: contract.sandbox.approval_policy,
      message: "claude bypass permissions mode is not allowed by the public SDK contract",
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
    blockers.push({
      code: "AGENT_BUDGET_NOT_ENFORCEABLE",
      provider: selected,
      max_usd: contract.budget.max_usd,
      message: "configured budget is not enforceable by this provider adapter",
    });
  }

  if (!Array.isArray(contract.allowed_roots) || contract.allowed_roots.length === 0) {
    blockers.push({
      code: "AGENT_ALLOWED_ROOTS_MISSING",
      provider: selected,
      message: "agent adapter contract must declare allowed roots",
    });
  }

  if (!contract.root_policy?.require_allowed_root) {
    blockers.push({
      code: "AGENT_ROOT_POLICY_MISSING",
      provider: selected,
      message: "agent adapter contract must declare a fail-closed root policy",
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
