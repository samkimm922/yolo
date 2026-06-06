import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from "node:fs";
import { spawn as defaultSpawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeAgentProvider } from "../adapters/agent-contract.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const YOLO_PACKAGE_ROOT = resolve(MODULE_DIR, "../../..");
export const DEFAULT_CLAUDE_SETTINGS_FILE = "settings-minimal.json";
export const LEGACY_DEFAULT_CLAUDE_SETTINGS_FILE = "scripts/yolo/settings-minimal.json";
export const DEFAULT_CLAUDE_SETTINGS_PATH = resolve(YOLO_PACKAGE_ROOT, DEFAULT_CLAUDE_SETTINGS_FILE);

function selectedProvider(value) {
  const provider = typeof value === "string" ? value : value?.selected;
  return normalizeAgentProvider(provider) || "claude";
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function modelValue(ai = {}) {
  const model = cleanString(ai.model);
  return model && model !== "auto" ? model : "";
}

function renderCustomCommand(command, ai = {}) {
  const model = modelValue(ai);
  return cleanString(command).replaceAll("${model}", model);
}

function inlineSettings(settings) {
  return settings.startsWith("{") || settings.startsWith("[");
}

export function resolveClaudeSettings(rootDir, value, { packageRoot = YOLO_PACKAGE_ROOT } = {}) {
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
  const isDefaultSettings = settings === DEFAULT_CLAUDE_SETTINGS_FILE || settings === LEGACY_DEFAULT_CLAUDE_SETTINGS_FILE;
  const settingsPath = isDefaultSettings
    ? resolve(packageRoot, DEFAULT_CLAUDE_SETTINGS_FILE)
    : isAbsolute(settings) ? settings : resolve(rootDir, settings);
  return {
    raw: settings,
    value: settingsPath,
    type: "file",
    path: settingsPath,
    default_settings: isDefaultSettings,
  };
}

function settingsValue(rootDir, value, options = {}) {
  return resolveClaudeSettings(rootDir, value, options).value;
}

export function inspectProviderInvocationPreflight(invocation = {}, { existsSync = defaultExistsSync } = {}) {
  const blockers = [];
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
} = {}) {
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
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
  packageRoot = YOLO_PACKAGE_ROOT,
} = {}) {
  if (!config?.ai) throw new Error("spawnProviderPrompt requires config.ai");
  if (!rootDir) throw new Error("spawnProviderPrompt requires rootDir");
  if (!runtimeDir) throw new Error("spawnProviderPrompt requires runtimeDir");
  const workDir = cwd || rootDir;
  const provider = selectedProvider(detectModelProvider ? detectModelProvider() : "claude");
  const invocation = buildProviderInvocation({ provider, config, workDir, rootDir, runtimeDir, packageRoot });
  const preflight = inspectProviderInvocationPreflight(invocation, { existsSync });
  if (preflight.blocks_execution) {
    const detail = preflight.blockers.map((blocker) => blocker.message).join("\n");
    return Promise.resolve({
      success: false,
      provider,
      command: invocation.command,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: detail,
      timedOut: false,
      blocked: true,
      reason: "claude_settings_missing",
      preflight,
    });
  }

  return new Promise((resolveRun) => {
    let done = false;
    let timeoutTriggered = false;
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
              resolveRun({
                success: false,
                provider,
                command: invocation.command,
                exitCode: null,
                signal: "TIMEOUT",
                stdout: out.trim(),
                stderr: err.trim(),
                timedOut: true,
              });
            }
          }, 5000);
        }, timeout)
      : null;

    const finish = (success, stdout, stderr, terminal = {}) => {
      if (timer) clearTimeout(timer);
      if (done) return;
      done = true;
      let finalStdout = (stdout || "").trim();
      if (provider === "codex" && invocation.outputFile && existsSync(invocation.outputFile)) {
        try {
          const lastMessage = readFileSync(invocation.outputFile, "utf8").trim();
          if (lastMessage) finalStdout = lastMessage;
        } catch {}
      }
      resolveRun({
        success,
        provider,
        command: invocation.command,
        exitCode: Number.isInteger(terminal.exitCode) ? terminal.exitCode : null,
        signal: terminal.signal || null,
        stdout: finalStdout,
        stderr: (stderr || "").trim(),
        timedOut: !!terminal.timedOut,
      });
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

export function classifyProviderFailure(providerRun = {}) {
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
  return { terminal: false, status: "failed", reason: null, detail: "" };
}
