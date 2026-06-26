import { existsSync as defaultExistsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { detectModelProvider } from "./provider-doctor.js";
import {
  buildProviderInvocation,
  inspectProviderInvocationPreflight,
  YOLO_PACKAGE_ROOT,
} from "../execution/provider-adapter.js";
import { inspectAgentAdapterContract, normalizeAgentProvider } from "./agent-contract.js";

export const PROVIDER_RUNTIME_MATRIX_SCHEMA_VERSION = "1.0";
export const PROVIDER_CLI_DRY_RUN_MATRIX_SCHEMA_VERSION = "1.0";
export const DEFAULT_PROVIDER_RUNTIME_MATRIX_PROVIDERS = ["claude", "codex", "custom"];

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

function withTrailingSeparator(pathValue: string): string {
  return pathValue.endsWith(sep) ? pathValue : `${pathValue}${sep}`;
}

function pathInside(child: string, parent: string): boolean {
  const resolvedChild = resolve(child);
  const resolvedParent = resolve(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(withTrailingSeparator(resolvedParent));
}

function providerOverrides(options: Record<string, unknown> = Object(), provider: string): Record<string, unknown> {
  const camel = (options.providerConfigs as Record<string, unknown> | undefined) || {};
  const snake = (options.provider_configs as Record<string, unknown> | undefined) || {};
  return {
    ...((camel[provider] as Record<string, unknown>) || {}),
    ...((snake[provider] as Record<string, unknown>) || {}),
  };
}

function providerConfig(baseConfig: Record<string, unknown> = Object(), provider: string, options: Record<string, unknown> = Object()): Record<string, unknown> {
  const override = providerOverrides(options, provider);
  const overrideAi = (override.ai as Record<string, unknown>) || {};
  const ai: Record<string, unknown> = {
    ...((baseConfig.ai as Record<string, unknown>) || {}),
    executor: provider,
    provider,
    ...overrideAi,
  };

  if (provider === "custom" && !cleanString(ai.custom_command || ai.command)) {
    ai.custom_command = "cat";
  }
  if (provider === "claude" && !cleanString(ai.model)) {
    ai.model = "claude-sonnet-4";
  }
  if (provider === "claude" && !cleanString(ai.settings)) {
    ai.settings = "settings-minimal.json";
  }
  if (provider === "codex" && !cleanString(ai.codex_model || ai.model)) {
    ai.codex_model = "gpt-5";
  }

  return {
    ...baseConfig,
    ...override,
    ai,
  };
}

function providerList(providers: unknown): string[] {
  const list = (providers as unknown[] | undefined) || DEFAULT_PROVIDER_RUNTIME_MATRIX_PROVIDERS;
  return list
    .map((provider) => normalizeAgentProvider(provider))
    .filter((provider): provider is string => Boolean(provider));
}

function serializeInvocation(invocation: ReturnType<typeof buildProviderInvocation> | null) {
  if (!invocation) return null;
  const inv = invocation as {
    provider?: string;
    command?: string;
    args?: string[];
    settingsFile?: string | null;
    settings?: unknown;
    outputFile?: string | null;
    customCommand?: string | null;
  };
  return {
    provider: inv.provider,
    command: inv.command,
    args: inv.args ?? [],
    settings_file: inv.settingsFile || null,
    settings: inv.settings || null,
    output_file: inv.outputFile || null,
    custom_command: inv.customCommand || null,
  };
}

function cliArgsInclude(args: unknown[] = [], value: unknown): boolean {
  return Array.isArray(args) && args.includes(value);
}

export interface MatrixBlocker {
  code: string;
  provider?: string;
  message: string;
  [key: string]: unknown;
}

export function buildProviderRuntimeMatrix(options: Record<string, unknown> = Object()) {
  const config = (options.config as Record<string, unknown>) || {};
  const projectRoot = resolve(String(options.projectRoot || options.project_root || process.cwd()));
  const stateRoot = resolve(String(options.stateRoot || options.state_root || join(projectRoot, ".yolo")));
  const runtimeDir = resolve(String(options.runtimeDir || options.runtime_dir || join(stateRoot, "state", "runtime")));
  const gateLogDir = resolve(String(options.gateLogDir || options.gate_log_dir || runtimeDir));
  const workDir = resolve(String(options.workDir || options.work_dir || projectRoot));
  const rootDir = resolve(String(options.rootDir || options.root_dir || projectRoot));
  const commandExists = (options.commandExists as ((command: unknown) => unknown) | undefined) || (() => null);
  const existsSync = (options.existsSync as ((path: string) => boolean) | undefined) || defaultExistsSync;
  const packageRoot = resolve(String(options.packageRoot || options.package_root || YOLO_PACKAGE_ROOT));

  const entries = providerList(options.providers).map((provider) => {
    const entryConfig = providerConfig(config, provider, options);
    const detection = detectModelProvider({ config: entryConfig, commandExists });
    const inspection = inspectAgentAdapterContract({
      config: entryConfig,
      provider,
      providerDetection: detection,
      commandExists,
      rootDir,
      workDir,
      runtimeDir,
    });
    let invocation: ReturnType<typeof buildProviderInvocation> | null = null;
    let invocationError: string | null = null;
    let invocationPreflight: ReturnType<typeof inspectProviderInvocationPreflight> = {
      status: "pass",
      blocks_execution: false,
      blockers: [],
      warnings: [],
    };
    try {
      invocation = buildProviderInvocation({
        provider,
        config: entryConfig,
        workDir,
        rootDir,
        runtimeDir,
        now: options.now,
        random: options.random,
        packageRoot,
      });
      invocationPreflight = inspectProviderInvocationPreflight(invocation, { existsSync, commandExists });
    } catch (error) {
      invocationError = (error as { message?: string })?.message || String(error);
    }
    const blockers = [
      ...(inspection.blockers || []),
      ...(invocationPreflight.blockers || []),
    ];
    const warnings = [
      ...(inspection.warnings || []),
      ...(invocationPreflight.warnings || []),
    ];

    return {
      provider,
      selected_provider: detection.selected,
      requested_provider: detection.requested,
      detection_reason: detection.reason,
      available: detection.available,
      status: invocationError || invocationPreflight.blocks_execution ? "blocked" : inspection.status,
      blocks_execution: Boolean(invocationError || inspection.blocks_execution || invocationPreflight.blocks_execution),
      contract: inspection.contract,
      invocation: serializeInvocation(invocation),
      invocation_error: invocationError,
      invocation_preflight: invocationPreflight,
      blockers,
      warnings,
    };
  });

  return {
    schema_version: PROVIDER_RUNTIME_MATRIX_SCHEMA_VERSION,
    schema: "yolo.runtime.provider_runtime_matrix.v1",
    project_root: projectRoot,
    state_root: stateRoot,
    runtime_dir: runtimeDir,
    gate_log_dir: gateLogDir,
    package_root: packageRoot,
    runner_runtime: {
      project_root: projectRoot,
      state_root: stateRoot,
      start_progress_server: false,
      initialize_baselines: false,
      gate_log_dir: gateLogDir,
    },
    providers: entries,
  };
}

export function inspectProviderRuntimeMatrix(options: Record<string, unknown> = Object()) {
  const matrix = buildProviderRuntimeMatrix(options);
  const blockers: MatrixBlocker[] = [];
  const warnings: MatrixBlocker[] = [];

  if (matrix.gate_log_dir !== matrix.runtime_dir) {
    blockers.push({
      code: "PROVIDER_MATRIX_GATE_LOG_DIR_MISMATCH",
      message: "gate log-dir must point at the SDK stateRoot runtime directory",
      gate_log_dir: matrix.gate_log_dir,
      runtime_dir: matrix.runtime_dir,
    });
  }

  for (const entry of matrix.providers) {
    if (entry.selected_provider !== entry.provider) {
      blockers.push({
        code: "PROVIDER_MATRIX_SELECTION_MISMATCH",
        provider: entry.provider,
        selected_provider: entry.selected_provider,
        requested_provider: entry.requested_provider,
        message: "provider detection did not select the requested matrix provider",
      });
    }
    for (const blocker of entry.blockers || []) {
      blockers.push({
        code: blocker.code || "PROVIDER_MATRIX_ENTRY_BLOCKED",
        provider: entry.provider,
        message: blocker.message || "provider matrix entry is blocked",
      });
    }
    if (entry.invocation_error) {
      blockers.push({
        code: "PROVIDER_MATRIX_INVOCATION_ERROR",
        provider: entry.provider,
        message: entry.invocation_error,
      });
    }
    if (entry.provider === "codex" && !pathInside(String(entry.invocation?.output_file || ""), matrix.runtime_dir)) {
      blockers.push({
        code: "PROVIDER_MATRIX_CODEX_OUTPUT_OUTSIDE_RUNTIME",
        provider: entry.provider,
        output_file: entry.invocation?.output_file || null,
        runtime_dir: matrix.runtime_dir,
        message: "codex last-message output must stay under the SDK runtime directory",
      });
    }
    for (const warning of entry.warnings || []) {
      warnings.push({
        code: warning.code || "PROVIDER_MATRIX_ENTRY_WARNING",
        provider: entry.provider,
        message: warning.message || "provider matrix entry has a warning",
      });
    }
  }

  return {
    status: blockers.length > 0 ? "blocked" : (warnings.length > 0 ? "warning" : "pass"),
    blocks_execution: blockers.length > 0,
    matrix,
    blockers,
    warnings,
  };
}

export function buildProviderCliDryRunMatrix(options: Record<string, unknown> = Object()) {
  const runtimeMatrix = buildProviderRuntimeMatrix(options);
  const requireExplicitBudget = options.requireExplicitBudget === true || options.require_explicit_budget === true;
  const workDir = resolve(String(options.workDir || options.work_dir || runtimeMatrix.project_root));

  const providers = runtimeMatrix.providers.map((entry) => {
    const contract = (entry.contract || {}) as Record<string, unknown>;
    const capabilities = (contract.capabilities || {}) as Record<string, unknown>;
    const invocation = (entry.invocation || {}) as Record<string, unknown>;
    const args = (invocation.args as unknown[]) || [];
    const budget = (contract.budget as Record<string, unknown>) || {};
    const sandbox = (contract.sandbox as Record<string, unknown>) || {};
    return {
      provider: entry.provider,
      status: entry.status,
      dry_run: true,
      execution_allowed: false,
      will_spawn: false,
      cwd: workDir,
      command: invocation.command || contract.command || null,
      args,
      stdin: {
        mode: capabilities.stdin_prompt ? "prompt" : "none",
        required: Boolean(capabilities.stdin_prompt),
      },
      output_capture: {
        enabled: Boolean(capabilities.output_capture),
        mode: capabilities.output_capture_mode || "stdout",
        output_file: invocation.output_file || null,
      },
      budget: {
        required: requireExplicitBudget,
        max_usd: budget.max_usd ?? null,
        enforceable: budget.enforceable === true,
        present_in_cli: entry.provider === "claude"
          ? cliArgsInclude(args, "--max-budget-usd")
          : false,
      },
      sandbox: {
        mode: sandbox.mode || null,
        approval_policy: sandbox.approval_policy || null,
        file_write: sandbox.file_write ?? null,
        shell_exec: sandbox.shell_exec ?? null,
      },
      command_available: (entry.available as Record<string, unknown> | undefined)?.[entry.provider] ?? null,
      selected_provider: entry.selected_provider,
      requested_provider: entry.requested_provider,
      invocation_error: entry.invocation_error,
      blockers: entry.blockers || [],
      warnings: entry.warnings || [],
      stop_conditions: [
        "real provider execution requested",
        "provider credentials or account state required",
        "budget or sandbox contract cannot be verified in dry-run",
      ],
    };
  });

  return {
    schema_version: PROVIDER_CLI_DRY_RUN_MATRIX_SCHEMA_VERSION,
    schema: "yolo.runtime.provider_cli_dry_run_matrix.v1",
    dry_run: true,
    execution_allowed: false,
    project_root: runtimeMatrix.project_root,
    state_root: runtimeMatrix.state_root,
    runtime_dir: runtimeMatrix.runtime_dir,
    gate_log_dir: runtimeMatrix.gate_log_dir,
    runtime_matrix_schema: runtimeMatrix.schema,
    require_explicit_budget: requireExplicitBudget,
    providers,
    stop_conditions: [
      "do not spawn model provider CLIs from this matrix",
      "stop before credentials, external network calls, or billable model execution",
      "ask the caller before changing from dry-run contract to real execution",
    ],
  };
}

export function inspectProviderCliDryRunMatrix(options: Record<string, unknown> = Object()) {
  const runtimeInspection = options.matrix ? null : inspectProviderRuntimeMatrix(options);
  const matrix = (options.matrix as ReturnType<typeof buildProviderCliDryRunMatrix>) || buildProviderCliDryRunMatrix(options);
  const blockers: MatrixBlocker[] = [];
  const warnings: MatrixBlocker[] = [];

  if (runtimeInspection) {
    blockers.push(...runtimeInspection.blockers.map((blocker) => ({
      ...blocker,
      code: `CLI_DRY_RUN_${blocker.code}`,
    })));
    warnings.push(...runtimeInspection.warnings.map((warning) => ({
      ...warning,
      code: `CLI_DRY_RUN_${warning.code}`,
    })));
  }

  if (matrix.dry_run !== true) {
    blockers.push({
      code: "CLI_DRY_RUN_DISABLED",
      message: "provider CLI matrix must remain a dry-run contract",
    });
  }
  if (matrix.execution_allowed !== false) {
    blockers.push({
      code: "CLI_DRY_RUN_EXECUTION_ALLOWED",
      message: "provider CLI dry-run matrix must not allow execution",
    });
  }

  for (const entry of matrix.providers || []) {
    if (entry.dry_run !== true || entry.execution_allowed !== false || entry.will_spawn !== false) {
      blockers.push({
        code: "CLI_DRY_RUN_WOULD_EXECUTE",
        provider: entry.provider,
        message: "provider CLI dry-run entries must not spawn commands",
      });
    }
    if (!cleanString(entry.command)) {
      blockers.push({
        code: "CLI_DRY_RUN_COMMAND_MISSING",
        provider: entry.provider,
        message: "provider CLI dry-run entry must include the command that would be used",
      });
    }
    if (entry.stdin?.required !== true || entry.stdin?.mode !== "prompt") {
      blockers.push({
        code: "CLI_DRY_RUN_STDIN_CONTRACT_MISSING",
        provider: entry.provider,
        message: "provider CLI dry-run entry must document prompt-over-stdin execution",
      });
    }
    if (entry.output_capture?.output_file && !pathInside(String(entry.output_capture.output_file), matrix.runtime_dir)) {
      blockers.push({
        code: "CLI_DRY_RUN_OUTPUT_OUTSIDE_RUNTIME",
        provider: entry.provider,
        output_file: entry.output_capture.output_file,
        runtime_dir: matrix.runtime_dir,
        message: "provider CLI dry-run output files must stay under the SDK runtime directory",
      });
    }
    if (entry.provider === "claude" && entry.budget?.required === true) {
      if (entry.budget.enforceable !== true || entry.budget.present_in_cli !== true || entry.budget.max_usd === null) {
        blockers.push({
          code: "CLI_DRY_RUN_CLAUDE_BUDGET_REQUIRED",
          provider: entry.provider,
          message: "claude real-model dry-run requires an explicit CLI budget guard before execution can be considered",
        });
      }
    }
    if (entry.provider === "custom") {
      warnings.push({
        code: "CLI_DRY_RUN_CUSTOM_ADAPTER_EXTERNAL",
        provider: entry.provider,
        message: "custom provider dry-run can describe the command, but external sandbox and credentials remain caller-owned",
      });
    }
  }

  return {
    status: blockers.length > 0 ? "blocked" : (warnings.length > 0 ? "warning" : "pass"),
    blocks_execution: blockers.length > 0,
    matrix,
    blockers,
    warnings,
  };
}
