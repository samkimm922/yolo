import { existsSync as defaultExistsSync, readFileSync as defaultReadFileSync } from "node:fs";
import { spawn as defaultSpawn } from "node:child_process";
import { join, resolve } from "node:path";
import { normalizeAgentProvider } from "../adapters/agent-contract.js";

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

export function buildProviderInvocation({
  provider,
  config,
  workDir,
  rootDir,
  runtimeDir,
  now = Date.now,
  random = Math.random,
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
  if (cleanString(ai.settings)) {
    args.push("--settings", resolve(rootDir, ai.settings));
  }
  const maxBudgetUsd = Number(ai.max_budget_usd);
  if (Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(maxBudgetUsd));
  }
  return {
    provider: "claude",
    command: "claude",
    args,
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
} = {}) {
  if (!config?.ai) throw new Error("spawnProviderPrompt requires config.ai");
  if (!rootDir) throw new Error("spawnProviderPrompt requires rootDir");
  if (!runtimeDir) throw new Error("spawnProviderPrompt requires runtimeDir");
  const workDir = cwd || rootDir;
  const provider = selectedProvider(detectModelProvider ? detectModelProvider() : "claude");
  const invocation = buildProviderInvocation({ provider, config, workDir, rootDir, runtimeDir });

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
