#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function defaultCommandExists(command) {
  const result = spawnSync("sh", ["-c", "command -v \"$1\"", "sh", command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0;
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function commandName(value) {
  const command = cleanString(value);
  if (!command) return null;
  return command.split(/\s+/)[0] || null;
}

function normalizeProvider(value) {
  const provider = cleanString(value).toLowerCase();
  if (["codex", "openai"].includes(provider)) return "codex";
  if (["claude", "anthropic"].includes(provider)) return "claude";
  if (["custom", "shell", "local"].includes(provider)) return "custom";
  return null;
}

export function detectModelProvider(options = Object()) {
  const config = options.config || {};
  const commandExists = options.commandExists || defaultCommandExists;
  const customCommand = commandName(config.ai?.custom_command || config.ai?.command);
  const available = {
    codex: Boolean(commandExists("codex")),
    claude: Boolean(commandExists("claude")),
    custom: customCommand ? Boolean(commandExists(customCommand)) : false,
  };

  const configured = normalizeProvider(config.ai?.executor || config.ai?.provider);
  const requested = configured;

  if (requested && available[requested]) {
    return { selected: requested, requested, available, reason: "configured_provider_available" };
  }

  if (requested && !available[requested]) {
    const fallback = available.codex ? "codex" : available.claude ? "claude" : available.custom ? "custom" : requested;
    return { selected: fallback, requested, available, reason: "configured_provider_unavailable" };
  }

  const selected = available.codex ? "codex" : available.claude ? "claude" : available.custom ? "custom" : "claude";
  return { selected, requested: null, available, reason: available[selected] ? "auto_detected" : "no_cli_detected" };
}

export function runProviderDoctorCli() {
  const result = detectModelProvider();
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else console.log(`[provider-doctor] selected=${result.selected} reason=${result.reason}`);
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runProviderDoctorCli();
}
