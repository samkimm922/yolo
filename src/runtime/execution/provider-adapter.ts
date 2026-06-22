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
export const DEFAULT_CLAUDE_PERMISSION_MODE = "acceptEdits";
const DEFAULT_PROVIDER_TIMEOUT_MS = 480000;
// Provider stdout/stderr are collected into memory for the run result. Without a cap a
// runaway provider (infinite logging, binary dump, loop) can grow the buffer without bound
// and OOM or stall the runner. These defaults bound each stream at 10MB; reaching the hard
// limit (maxBytes * killMultiplier) kills the child and reports OUTPUT_LIMIT_EXCEEDED.
const DEFAULT_PROVIDER_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_PROVIDER_OUTPUT_KILL_MULTIPLIER = 5;

// Bounded collector for a provider child's stdout or stderr. Accumulates bytes into a string
// until maxBytes is reached, then stops appending (keeping the captured prefix) and records
// how many bytes were dropped. This caps resident memory regardless of how much the child emits.
class BoundedOutputCollector {
  maxBytes;
  buffer;
  bytes;
  droppedBytes;
  truncated;
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.buffer = "";
    this.bytes = 0;
    this.droppedBytes = 0;
    this.truncated = false;
  }

  // Chunk may be a string or a Buffer; byte accounting uses utf8 length so the cap reflects
  // real resident memory rather than UTF-16 code-unit counts.
  push(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    const chunkBytes = Buffer.byteLength(text, "utf8");
    this.bytes += chunkBytes;
    if (this.buffer.length >= this.maxBytes) {
      // Already capped: keep the prefix, just account for what we discarded.
      this.droppedBytes += chunkBytes;
      this.truncated = true;
      return;
    }
    if (this.buffer.length + text.length <= this.maxBytes) {
      this.buffer += text;
      return;
    }
    // Partial append: keep up to the byte cap, drop the overflow tail.
    const remaining = this.maxBytes - this.buffer.length;
    this.buffer += text.slice(0, remaining);
    this.droppedBytes += Buffer.byteLength(text.slice(remaining), "utf8");
    this.truncated = true;
  }

  toString() {
    return this.buffer;
  }

  // Summary attached to the run result when the cap was hit, so callers can tell a truncated
  // stream apart from a complete one without guessing from length.
  toSummary() {
    return {
      truncated: this.truncated,
      captured_bytes: Buffer.byteLength(this.buffer, "utf8"),
      dropped_bytes: this.droppedBytes,
      max_bytes: this.maxBytes,
    };
  }
}

function resolveOutputLimit(configValue, defaultValue) {
  const value = Number(configValue);
  if (!Number.isFinite(value) || value <= 0) return defaultValue;
  return Math.floor(value);
}

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
  if (codes.includes("PROVIDER_TIMEOUT_INVALID")) return "provider_timeout_invalid";
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
  outputLimits = null,
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
  if (outputLimits) run.output_limits = outputLimits;
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

function resolveProviderStubPath(value, { rootDir } = Object()) {
  const stub = cleanString(value);
  if (!stub) return "";
  return isAbsolute(stub) ? resolve(stub) : resolve(rootDir || process.cwd(), stub);
}

function buildProviderStubInvocation(stubPath) {
  return {
    provider: "stub",
    command: process.execPath,
    args: [stubPath],
    outputFile: null,
    stubPath,
  };
}

function inspectProviderStubPreflight(invocation = Object(), {
  existsSync = defaultExistsSync,
  commandExists = null,
} = Object()) {
  const blockers = [];
  if (!existsSync(invocation.stubPath)) {
    blockers.push({
      code: "PROVIDER_STUB_MISSING",
      provider: "stub",
      path: invocation.stubPath,
      message: `Provider stub file not found: ${invocation.stubPath}`,
    });
  }
  if (typeof commandExists === "function" && commandExists(invocation.command) === false) {
    blockers.push({
      code: "PROVIDER_STUB_NODE_UNAVAILABLE",
      provider: "stub",
      command: invocation.command,
      message: "provider stub node executable is not available",
    });
  }
  return {
    status: blockers.length > 0 ? "blocked" : "pass",
    blocks_execution: blockers.length > 0,
    blockers,
    warnings: [],
  };
}

function providerStubInspection(invocation = Object(), { rootDir, workDir, runtimeDir, timeout } = Object()) {
  return {
    status: "pass",
    blocks_execution: false,
    selected_provider: "stub",
    requested_provider: "stub",
    available: { stub: true },
    contract: {
      provider: "stub",
      command: invocation.command,
      capabilities: {
        provider: "stub",
        command: invocation.command,
        stdin_prompt: true,
        output_capture: true,
        output_capture_mode: "stdout",
        model_selection: false,
        budget_limit: false,
        sandbox: false,
        sandbox_mode: "test_stub",
        approval_policy: "test_stub",
        file_write: true,
        shell_exec: false,
      },
      timeout: {
        required: true,
        max_ms: timeout,
        enforceable: true,
        failure_code: "AGENT_TIMEOUT",
      },
      root_policy: {
        root_dir: rootDir,
        work_dir: workDir,
        runtime_dir: runtimeDir,
        allowed_roots: [rootDir, workDir, runtimeDir].filter(Boolean).map((path) => resolve(path)),
        require_allowed_root: true,
        fail_closed: true,
      },
    },
    blockers: [],
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
  args.push("--permission-mode", cleanString(ai.claude_permission_mode) || DEFAULT_CLAUDE_PERMISSION_MODE);
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
  timeout = DEFAULT_PROVIDER_TIMEOUT_MS,
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
  maxOutputBytes,
  outputKillMultiplier,
} = Object()) {
  if (!config?.ai) throw new Error("spawnProviderPrompt requires config.ai");
  if (!rootDir) throw new Error("spawnProviderPrompt requires rootDir");
  if (!runtimeDir) throw new Error("spawnProviderPrompt requires runtimeDir");
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return Promise.resolve(blockedProviderRun({
      provider: "unknown",
      command: null,
      blockers: [{
        code: "PROVIDER_TIMEOUT_INVALID",
        message: `Provider timeout must be a positive finite number (got ${timeout})`,
      }],
      inspection: null,
      preflight: {
        status: "blocked",
        blocks_execution: true,
        blockers: [{
          code: "PROVIDER_TIMEOUT_INVALID",
          message: `Provider timeout must be a positive finite number (got ${timeout})`,
        }],
        warnings: [],
      },
    }));
  }
  const workDir = cwd || rootDir;
  const stubPath = resolveProviderStubPath(process.env.YOLO_PROVIDER_STUB, { rootDir });
  const stubEnabled = Boolean(stubPath);
  const providerDetection = stubEnabled ? null : (detectModelProvider ? detectModelProvider() : null);
  const provider = stubEnabled ? "stub" : selectedProvider(providerDetection || config.ai?.executor || config.ai?.provider || "claude");
  let invocation;
  try {
    invocation = stubEnabled
      ? buildProviderStubInvocation(stubPath)
      : buildProviderInvocation({ provider, config, workDir, rootDir, runtimeDir, packageRoot });
  } catch (error) {
    return Promise.resolve(blockedProviderRun({
      provider,
      command: null,
      blockers: [
        {
          code: "PROVIDER_INVOCATION_BUILD_FAILED",
          provider,
          message: error?.message || String(error),
        },
      ],
      inspection: null,
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
  const inspection = stubEnabled
    ? providerStubInspection(invocation, { rootDir, workDir, runtimeDir, timeout })
    : inspectAgentAdapterContract({
        config,
        provider,
        providerDetection: providerDetection && typeof providerDetection === "object" ? providerDetection : undefined,
        commandExists,
        rootDir,
        workDir,
        runtimeDir,
        timeoutMs: timeout,
      });
  const preflight = stubEnabled
    ? inspectProviderStubPreflight(invocation, { existsSync, commandExists })
    : inspectProviderInvocationPreflight(invocation, { existsSync, commandExists });
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
    // Resolve per-stream caps from explicit options or config.ai. Both streams share the same
    // limit; a runaway either side should trip the cap. killBytes is the hard ceiling past
    // which we kill the child to stop the flood, reported as OUTPUT_LIMIT_EXCEEDED.
    const maxBytes = resolveOutputLimit(maxOutputBytes ?? config?.ai?.provider_max_output_bytes, DEFAULT_PROVIDER_MAX_OUTPUT_BYTES);
    const killMultiplier = resolveOutputLimit(outputKillMultiplier ?? config?.ai?.provider_output_kill_multiplier, DEFAULT_PROVIDER_OUTPUT_KILL_MULTIPLIER);
    const killBytes = maxBytes * Math.max(1, Math.floor(killMultiplier || DEFAULT_PROVIDER_OUTPUT_KILL_MULTIPLIER));
    const outCollector = new BoundedOutputCollector(maxBytes);
    const errCollector = new BoundedOutputCollector(maxBytes);
    let outputLimitExceeded = false;

    const tryKillOnOutputFlood = () => {
      // Once either stream passes the hard ceiling, kill the child once so it cannot keep
      // filling the OS pipe buffer (and our accounting) indefinitely. The captured prefix and
      // dropped-byte counts are preserved on the collectors.
      if (outputLimitExceeded) return;
      if (outCollector.bytes < killBytes && errCollector.bytes < killBytes) return;
      outputLimitExceeded = true;
      try {
        if (typeof child.kill === "function") child.kill("SIGKILL");
        if (killTree) killTree(child.pid);
      } catch {
        // Best-effort kill; the close handler will still resolve the run.
      }
    };

    child.stdout.on("data", (chunk) => {
      outCollector.push(chunk);
      tryKillOnOutputFlood();
    });
    child.stderr.on("data", (chunk) => {
      errCollector.push(chunk);
      tryKillOnOutputFlood();
    });
    child.stdin.write(prompt);
    child.stdin.end();

    // Builds the output_limits metadata attached to the result. Present whenever a cap was
    // hit or the child was killed for flooding, so callers can distinguish truncation from a
    // clean capture.
    const buildOutputLimits = () => {
      if (!outputLimitExceeded && !outCollector.truncated && !errCollector.truncated) {
        return null;
      }
      return {
        stdout: outCollector.toSummary(),
        stderr: errCollector.toSummary(),
        kill_triggered: outputLimitExceeded,
        kill_bytes: killBytes,
        reason: outputLimitExceeded ? "OUTPUT_LIMIT_EXCEEDED" : "OUTPUT_TRUNCATED",
      };
    };

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
                stdout: outCollector.toString().trim(),
                stderr: errCollector.toString().trim(),
                terminal: { exitCode: null, signal: "TIMEOUT", timedOut: true },
                commandSucceeded: false,
                startedAtMs,
                endedAtMs: Date.now(),
                outputLimits: buildOutputLimits(),
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
        outputLimits: buildOutputLimits(),
      }));
    };

    child.on("close", (code, signal) => {
      const effectiveSignal = signal || (outputLimitExceeded ? "SIGKILL" : null);
      if (effectiveSignal) errCollector.push(`\n[signal:${effectiveSignal}]`);
      // An output-flood kill is not a normal provider completion: surface it as killed so the
      // run does not report success on a truncated/partial result.
      const success = outputLimitExceeded ? false : code === 0;
      finish(success, outCollector.toString(), errCollector.toString(), {
        exitCode: code,
        signal: effectiveSignal,
        timedOut: timeoutTriggered,
      });
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
