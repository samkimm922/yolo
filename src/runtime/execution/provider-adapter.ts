import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from "node:fs";
import { spawn as defaultSpawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectAgentAdapterContract, normalizeAgentProvider } from "../adapters/agent-contract.js";
import { parseCommandToArgv } from "../../lib/security/command-guard.js";
import { commandExistsSync } from "../../lib/security/safe-exec.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function findPackageRoot(startDir) {
  let dir = resolve(startDir);
  const root = resolve("/");
  while (dir !== root) {
    if (defaultExistsSync(join(dir, "package.json"))) {
      // The build copies package.json into dist/; the real package root is its parent.
      if (basename(dir) === "dist") {
        const parent = dirname(dir);
        if (defaultExistsSync(join(parent, "package.json"))) return parent;
      }
      return dir;
    }
    dir = dirname(dir);
  }
  return resolve(MODULE_DIR, "../../..");
}

export const YOLO_PACKAGE_ROOT = findPackageRoot(MODULE_DIR);
export const DEFAULT_CLAUDE_SETTINGS_FILE = "settings-minimal.json";
export const DEFAULT_CLAUDE_SETTINGS_PATH = resolve(YOLO_PACKAGE_ROOT, DEFAULT_CLAUDE_SETTINGS_FILE);

function selectedProvider(value) {
  const provider = typeof value === "string" ? value : value?.selected;
  return normalizeAgentProvider(provider) || "claude";
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function isNonEmptyOutput(value) {
  return cleanString(value).length > 0;
}

function isoFromMs(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function providerRunReason(status, verification = null) {
  if (status === "timed_out") return "provider_timed_out";
  if (status === "killed") return "provider_killed";
  if (status === "no_output") return "provider_no_output";
  if (status === "verification_failed") return verification?.reason || "provider_verification_failed";
  if (status === "failed") return "provider_exit_failed";
  return null;
}

function defaultCommandExists(command) {
  const executable = cleanString(command);
  if (!executable) return false;
  // P12.I1: PATH walk via fs.accessSync — no sh -c, no injection surface.
  return commandExistsSync(executable);
}

function preflightReason(blockers = []) {
  const codes = blockers.map((blocker) => blocker.code);
  if (codes.includes("CLAUDE_SETTINGS_FILE_MISSING")) return "claude_settings_missing";
  if (codes.includes("AGENT_COMMAND_MISSING")) return "agent_command_missing";
  if (codes.includes("AGENT_COMMAND_UNAVAILABLE")) return "agent_command_unavailable";
  if (codes.includes("PROVIDER_INVOCATION_COMMAND_UNAVAILABLE")) return "provider_command_unavailable";
  if (codes.includes("AGENT_PERMISSION_UNSAFE")) return "agent_permission_unsafe";
  if (codes.includes("AGENT_SANDBOX_UNSAFE")) return "agent_sandbox_unsafe";
  if (codes.includes("AGENT_BUDGET_NOT_ENFORCEABLE")) return "agent_budget_not_enforceable";
  if (codes.includes("AGENT_ALLOWED_ROOTS_MISSING") || codes.includes("AGENT_ROOT_POLICY_MISSING")) return "agent_root_policy_missing";
  if (codes.includes("PROVIDER_INVOCATION_BUILD_FAILED")) return "provider_invocation_build_failed";
  return "provider_preflight_blocked";
}

function blockedProviderRun({
  provider,
  command = null,
  blockers = [],
  inspection = null,
  preflight = null,
} = Object()) {
  const nowMs = Date.now();
  const detail = blockers.map((blocker) => blocker.message || blocker.code).filter(Boolean).join("\n");
  const run = Object.assign(Object(), {
    success: false,
    status: "blocked",
    provider,
    command,
    exitCode: null,
    signal: null,
    stdout: "",
    stderr: detail,
    timedOut: false,
    blocked: true,
    reason: preflightReason(blockers),
    adapter_contract_inspection: inspection,
    preflight,
    startedAtMs: nowMs,
    endedAtMs: nowMs,
    durationMs: 0,
  });
  run.attempt_ledger = [buildProviderAttemptLedgerEntry(run)];
  return run;
}

export function classifyProviderRunStatus({
  exitCode = null,
  signal = null,
  timedOut = false,
  stdout = "",
  verification = null,
  commandSucceeded = null,
} = Object()) {
  if (timedOut) return "timed_out";
  if (signal) return "killed";
  if (verification?.status === "failed") return "verification_failed";
  if (exitCode !== null && exitCode !== undefined && exitCode !== 0) return "failed";
  if (commandSucceeded === false) return "failed";
  if (!isNonEmptyOutput(stdout)) return "no_output";
  return "completed";
}

export function buildProviderAttemptLedgerEntry(providerRun = Object(), {
  attempt = null,
  taskId = null,
  runId = null,
} = Object()) {
  const verification = providerRun.output_verification || providerRun.outputVerification || null;
  const status = providerRun.status || classifyProviderRunStatus({
    exitCode: providerRun.exitCode ?? null,
    signal: providerRun.signal || null,
    timedOut: providerRun.timedOut === true,
    stdout: providerRun.stdout || "",
    verification,
    commandSucceeded: providerRun.success,
  });
  return {
    run_id: runId,
    task_id: taskId,
    attempt,
    provider: providerRun.provider || "provider",
    command: providerRun.command || null,
    status,
    reason: providerRun.reason || providerRunReason(status, verification),
    exit_code: providerRun.exitCode ?? null,
    signal: providerRun.signal || null,
    timed_out: providerRun.timedOut === true,
    stdout_bytes: byteLength(providerRun.stdout || ""),
    stderr_bytes: byteLength(providerRun.stderr || ""),
    started_at: providerRun.started_at || isoFromMs(providerRun.startedAtMs),
    ended_at: providerRun.ended_at || isoFromMs(providerRun.endedAtMs),
    duration_ms: Number.isFinite(providerRun.durationMs) ? providerRun.durationMs : null,
  };
}

function buildProviderRunResult({
  provider,
  command,
  stdout = "",
  stderr = "",
  terminal = Object(),
  commandSucceeded = null,
  startedAtMs = null,
  endedAtMs = Date.now(),
  outputVerification = null,
} = Object()) {
  const exitCode = Number.isInteger(terminal.exitCode) ? terminal.exitCode : null;
  const signal = terminal.signal || null;
  const timedOut = !!terminal.timedOut;
  const status = classifyProviderRunStatus({
    exitCode,
    signal,
    timedOut,
    stdout,
    verification: outputVerification,
    commandSucceeded,
  });
  const reason = providerRunReason(status, outputVerification);
  const run = Object.assign(Object(), {
    success: status === "completed",
    status,
    reason,
    provider,
    command,
    exitCode,
    signal,
    stdout: cleanString(stdout),
    stderr: cleanString(stderr),
    timedOut,
    startedAtMs,
    endedAtMs,
    durationMs: Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs) ? endedAtMs - startedAtMs : null,
  });
  if (outputVerification) run.output_verification = outputVerification;
  run.attempt_ledger = [buildProviderAttemptLedgerEntry(run)];
  return run;
}

function modelValue(ai = Object()) {
  const model = cleanString(ai.model);
  return model && model !== "auto" ? model : "";
}

function renderCustomCommand(command, ai = Object()) {
  const model = modelValue(ai);
  if (model && !parseCommandToArgv(model).ok) {
    throw new Error(`ai.model contains shell metacharacters, refusing to substitute into custom_command: ${model}`);
  }
  return cleanString(command).replaceAll("${model}", model);
}

function inlineSettings(settings) {
  return settings.startsWith("{") || settings.startsWith("[");
}

export function resolveClaudeSettings(rootDir, value, { packageRoot = YOLO_PACKAGE_ROOT } = Object()) {
  const settings = cleanString(value);
  if (!settings) return {
    raw: "",
    value: "",
    type: "none",
    path: null,
    default_settings: false,
  };
  if (inlineSettings(settings)) return {
    raw: settings,
    value: settings,
    type: "inline",
    path: null,
    default_settings: false,
  };
  const isDefaultSettings = settings === DEFAULT_CLAUDE_SETTINGS_FILE;
  if (isDefaultSettings) {
    // Dynamically generate settings with absolute hook path so the hook
    // works regardless of the target project's cwd or tsx availability.
    const templatePath = resolve(packageRoot, DEFAULT_CLAUDE_SETTINGS_FILE);
    const template = JSON.parse(defaultReadFileSync(templatePath, "utf8"));
    const hookJs = resolve(packageRoot, "dist", "hooks", "pre-tool-block-yolo-write.js");
    if (template.hooks?.PreToolUse) {
      for (const hook of template.hooks.PreToolUse) {
        if (hook.command && hook.command.includes("pre-tool-block-yolo-write")) {
          hook.command = `node "${hookJs}"`;
        }
      }
    }
    return {
      raw: settings,
      value: JSON.stringify(template),
      type: "inline",
      path: null,
      default_settings: true,
    };
  }
  const settingsPath = isAbsolute(settings) ? settings : resolve(rootDir, settings);
  return {
    raw: settings,
    value: settingsPath,
    type: "file",
    path: settingsPath,
    default_settings: false,
  };
}

function settingsValue(rootDir, value, options = Object()) {
  return resolveClaudeSettings(rootDir, value, options).value;
}

export function inspectProviderInvocationPreflight(invocation = Object(), {
  existsSync = defaultExistsSync,
  commandExists = null,
} = Object()) {
  const blockers = [];
  if (invocation.command && typeof commandExists === "function") {
    const exists = commandExists(invocation.command);
    if (exists === false) {
      blockers.push({
        code: "PROVIDER_INVOCATION_COMMAND_UNAVAILABLE",
        provider: invocation.provider,
        command: invocation.command,
        message: "provider invocation command is not available",
      });
    }
  }
  if (invocation.provider === "claude" && invocation.settingsFile) {
    if (!existsSync(invocation.settingsFile)) {
      blockers.push({
        code: "CLAUDE_SETTINGS_FILE_MISSING",
        provider: "claude",
        settings_file: invocation.settingsFile,
        message: `Claude settings file not found: ${invocation.settingsFile}`,
      });
    }
  }
  return {
    status: blockers.length > 0 ? "blocked" : "pass",
    blocks_execution: blockers.length > 0,
    blockers,
    warnings: [],
  };
}

export function buildProviderInvocation({
  provider,
  config,
  workDir,
  rootDir,
  runtimeDir,
  now = Date.now,
  random = Math.random,
  packageRoot = YOLO_PACKAGE_ROOT,
} = Object()) {
  if (!config?.ai) throw new Error("buildProviderInvocation requires config.ai");
  const selected = selectedProvider(provider);
  const ai = config.ai || {};
  if (selected === "codex") {
    const outputFile = join(runtimeDir, `codex-output-${now()}-${random().toString(16).slice(2)}.txt`);
    const args = [
      "exec",
      "--cd", workDir,
      "--sandbox", ai.codex_sandbox || "workspace-write",
      "-c", `approval_policy="${ai.codex_approval || "never"}"`,
      "--output-last-message", outputFile,
      "-",
    ];
    const codexModel = cleanString(ai.codex_model) || modelValue(ai);
    if (codexModel) args.splice(1, 0, "--model", codexModel);
    return {
      provider: selected,
      command: "codex",
      args,
      outputFile,
    };
  }

  if (selected === "custom") {
    const customCommand = renderCustomCommand(ai.custom_command || ai.command, ai);
    if (!customCommand) {
      throw new Error("buildProviderInvocation custom provider requires config.ai.custom_command");
    }
    // P12.I1: prefer argv form when customCommand parses cleanly (no shell
    // metacharacters) so spawnSync runs without shell:true. If the operator's
    // config uses shell features (pipes, redirects, env vars), keep the
    // explicit sh -c opt-in — the operator has chosen shell semantics.
    const parsedCustom = parseCommandToArgv(customCommand);
    if (parsedCustom.ok && parsedCustom.argv && parsedCustom.argv.length > 0) {
      return {
        provider: "custom",
        command: parsedCustom.argv[0],
        args: parsedCustom.argv.slice(1),
        customCommand,
        outputFile: null,
      };
    }
    return {
      provider: "custom",
      command: "sh",
      args: ["-c", customCommand],
      customCommand,
      outputFile: null,
    };
  }

  const args = ["-p"];
  const claudeModel = modelValue(ai);
  if (claudeModel) args.push("--model", claudeModel);
  args.push("--permission-mode", ai.claude_permission_mode || "default");
  const claudeSettings = resolveClaudeSettings(rootDir, ai.settings, { packageRoot });
  if (cleanString(ai.settings)) {
    args.push("--settings", settingsValue(rootDir, ai.settings, { packageRoot }));
  }
  if (cleanString(ai.claude_tools)) {
    args.push("--tools", cleanString(ai.claude_tools));
  }
  if (cleanString(ai.claude_allowed_tools)) {
    args.push("--allowedTools", cleanString(ai.claude_allowed_tools));
  }
  if (cleanString(ai.claude_disallowed_tools)) {
    args.push("--disallowedTools", cleanString(ai.claude_disallowed_tools));
  }
  if (ai.claude_disable_slash_commands === true) {
    args.push("--disable-slash-commands");
  }
  if (ai.claude_no_session_persistence === true) {
    args.push("--no-session-persistence");
  }
  const maxBudgetUsd = Number(ai.max_budget_usd);
  if (Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(maxBudgetUsd));
  }
  return {
    provider: "claude",
    command: "claude",
    args,
    settingsFile: claudeSettings.type === "file" ? claudeSettings.path : null,
    settings: claudeSettings,
    outputFile: null,
  };
}

export function spawnProviderPrompt(prompt, {
  timeout = 0,
  cwd,
  config,
  rootDir,
  runtimeDir,
  detectModelProvider,
  killTree,
  spawnImpl = defaultSpawn,
  commandExists = defaultCommandExists,
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
  packageRoot = YOLO_PACKAGE_ROOT,
} = Object()) {
  if (!config?.ai) throw new Error("spawnProviderPrompt requires config.ai");
  if (!rootDir) throw new Error("spawnProviderPrompt requires rootDir");
  if (!runtimeDir) throw new Error("spawnProviderPrompt requires runtimeDir");
  const workDir = cwd || rootDir;
  const providerDetection = detectModelProvider ? detectModelProvider() : null;
  const provider = selectedProvider(providerDetection || config.ai?.executor || config.ai?.provider || "claude");
  const inspection = inspectAgentAdapterContract({
    config,
    provider,
    providerDetection: providerDetection && typeof providerDetection === "object" ? providerDetection : undefined,
    commandExists,
    rootDir,
    workDir,
    runtimeDir,
    timeoutMs: timeout,
  });
  let invocation;
  try {
    invocation = buildProviderInvocation({ provider, config, workDir, rootDir, runtimeDir, packageRoot });
  } catch (error) {
    return Promise.resolve(blockedProviderRun({
      provider,
      command: inspection.contract?.command || null,
      blockers: [
        ...(inspection.blockers || []),
        {
          code: "PROVIDER_INVOCATION_BUILD_FAILED",
          provider,
          message: error?.message || String(error),
        },
      ],
      inspection,
      preflight: {
        status: "blocked",
        blocks_execution: true,
        blockers: [{
          code: "PROVIDER_INVOCATION_BUILD_FAILED",
          provider,
          message: error?.message || String(error),
        }],
        warnings: [],
      },
    }));
  }
  const preflight = inspectProviderInvocationPreflight(invocation, { existsSync, commandExists });
  const blockers = [
    ...(inspection.blockers || []),
    ...(preflight.blockers || []),
  ];
  if (inspection.blocks_execution || preflight.blocks_execution) {
    return Promise.resolve(blockedProviderRun({
      provider,
      command: invocation.command,
      blockers,
      inspection,
      preflight,
    }));
  }

  return new Promise((resolveRun) => {
    let done = false;
    let timeoutTriggered = false;
    const startedAtMs = Date.now();
    const child = spawnImpl(
      invocation.command,
      invocation.args,
      { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";

    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.stdin.write(prompt);
    child.stdin.end();

    const timer = timeout > 0
      ? setTimeout(() => {
          timeoutTriggered = true;
          if (killTree) killTree(child.pid);
          setTimeout(() => {
            if (!done) {
              done = true;
              resolveRun(buildProviderRunResult({
                provider,
                command: invocation.command,
                stdout: out.trim(),
                stderr: err.trim(),
                terminal: { exitCode: null, signal: "TIMEOUT", timedOut: true },
                commandSucceeded: false,
                startedAtMs,
                endedAtMs: Date.now(),
              }));
            }
          }, 5000);
        }, timeout)
      : null;

    const finish = (success, stdout, stderr, terminal = Object()) => {
      if (timer) clearTimeout(timer);
      if (done) return;
      done = true;
      const endedAtMs = Date.now();
      let finalStdout = (stdout || "").trim();
      let outputVerification = null;
      if (provider === "codex" && invocation.outputFile && existsSync(invocation.outputFile)) {
        try {
          const lastMessage = readFileSync(invocation.outputFile, "utf8").trim();
          outputVerification = {
            type: "output_last_message_file",
            path: invocation.outputFile,
            exists: true,
            non_empty: isNonEmptyOutput(lastMessage),
            status: isNonEmptyOutput(lastMessage) ? "pass" : "failed",
            reason: isNonEmptyOutput(lastMessage) ? null : "codex_output_empty",
          };
          if (lastMessage) finalStdout = lastMessage;
        } catch (error) {
          outputVerification = {
            type: "output_last_message_file",
            path: invocation.outputFile,
            exists: true,
            non_empty: false,
            status: "failed",
            reason: "codex_output_unreadable",
            error: error.message,
          };
        }
      } else if (provider === "codex" && invocation.outputFile) {
        outputVerification = {
          type: "output_last_message_file",
          path: invocation.outputFile,
          exists: false,
          non_empty: false,
          status: "failed",
          reason: "codex_output_missing",
        };
      }
      resolveRun(buildProviderRunResult({
        provider,
        command: invocation.command,
        stdout: finalStdout,
        stderr,
        terminal,
        commandSucceeded: success,
        startedAtMs,
        endedAtMs,
        outputVerification,
      }));
    };

    child.on("close", (code, signal) => {
      if (signal) err += `\n[signal:${signal}]`;
      finish(code === 0, out, err, { exitCode: code, signal, timedOut: timeoutTriggered });
    });
    child.on("error", (error) => {
      finish(false, "", error.message, { exitCode: null, signal: null, timedOut: false });
    });
  });
}

export function classifyProviderFailure(providerRun = Object()) {
  const combined = `${providerRun.stdout || ""}\n${providerRun.stderr || ""}`;
  if (providerRun.blocked === true && providerRun.reason) {
    return {
      terminal: true,
      status: "blocked",
      reason: providerRun.reason,
      detail: combined.trim().slice(0, 500),
    };
  }
  if (/CLAUDE_SETTINGS_FILE_MISSING|Claude settings file not found/i.test(combined)) {
    return {
      terminal: true,
      status: "blocked",
      reason: "claude_settings_missing",
      detail: combined.trim().slice(0, 500),
    };
  }
  if (/Exceeded USD budget|exceeded .*budget|max[- ]budget|budget exceeded/i.test(combined)) {
    return {
      terminal: true,
      status: "blocked",
      reason: "provider_budget_exceeded",
      detail: combined.trim().slice(0, 500),
    };
  }
  if (providerRun.timedOut === true) {
    return {
      terminal: false,
      status: "timed_out",
      reason: "provider_timed_out",
      detail: combined.trim().slice(0, 500),
    };
  }
  if (providerRun.signal) {
    return {
      terminal: false,
      status: "killed",
      reason: "provider_killed",
      detail: combined.trim().slice(0, 500),
    };
  }
  if ((providerRun.output_verification || providerRun.outputVerification)?.status === "failed") {
    const verification = providerRun.output_verification || providerRun.outputVerification;
    return {
      terminal: false,
      status: "verification_failed",
      reason: verification.reason || "provider_verification_failed",
      detail: combined.trim().slice(0, 500),
    };
  }
  if (providerRun.success === true && !isNonEmptyOutput(providerRun.stdout || "")) {
    return {
      terminal: false,
      status: "no_output",
      reason: "provider_no_output",
      detail: "",
    };
  }
  if (providerRun.status && providerRun.status !== "completed" && providerRun.status !== "blocked") {
    return {
      terminal: false,
      status: providerRun.status,
      reason: providerRun.reason || providerRunReason(providerRun.status, providerRun.output_verification || null),
      detail: combined.trim().slice(0, 500),
    };
  }
  return { terminal: false, status: "failed", reason: null, detail: "" };
}
