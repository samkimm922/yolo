// yolo run/auto argument parsers.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

// YOLO subcommand argument parsers.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

import { resolve } from "node:path";
import { existingJsonPath } from "./shared.js";
import {
  readArgValue,
  readOptionalBooleanArgValue,
  throwUnknownFlags,
} from "./parse-helpers.js";

export function parseYoloArgs(argv = process.argv.slice(2)) {
  const input = Object();
  const options = {
    json: false,
    help: false,
    dryRun: false,
    engineOnly: false,
    writeLifecycle: true,
    collectEvidence: false,
    executeAdapter: false,
    allowAdapterCommands: false,
    startProgressServer: undefined,
    runReviewLoop: undefined,
  };
  const unknownFlags = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--engine-only" || arg === "--runner-only") {
      options.engineOnly = true;
    } else if (arg === "--no-write") {
      options.writeLifecycle = false;
    } else if (arg === "--collect-evidence") {
      options.collectEvidence = true;
    } else if (arg === "--execute-adapter") {
      options.executeAdapter = true;
    } else if (arg === "--allow-adapter-commands") {
      options.allowAdapterCommands = true;
    } else if (arg === "--no-progress-server") {
      options.startProgressServer = false;
    } else if (arg === "--no-review-loop") {
      options.runReviewLoop = false;
    } else if (arg === "--prd" || arg.startsWith("--prd=")) {
      const read = readArgValue(argv, i, "--prd");
      input.prdPath = read.value;
      i += read.consumed;
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const read = readArgValue(argv, i, "--mode");
      input.mode = read.value;
      i += read.consumed;
    } else if (arg === "--executor" || arg.startsWith("--executor=")) {
      const read = readArgValue(argv, i, "--executor");
      input.executor = read.value;
      i += read.consumed;
    } else if (arg === "--provider" || arg.startsWith("--provider=")) {
      const read = readArgValue(argv, i, "--provider");
      input.provider = read.value;
      i += read.consumed;
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      const read = readArgValue(argv, i, "--model");
      input.model = read.value;
      i += read.consumed;
    } else if (arg === "--agent-command" || arg.startsWith("--agent-command=") || arg === "--custom-command" || arg.startsWith("--custom-command=")) {
      const prefix = arg.startsWith("--custom-command") ? "--custom-command" : "--agent-command";
      const read = readArgValue(argv, i, prefix);
      input.agentCommand = read.value;
      i += read.consumed;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && !input.prdPath) {
      input.prdPath = arg;
    } else if (arg.startsWith("--")) {
      unknownFlags.push(`--${arg.replace(/^--?/, "").split("=")[0]}`);
    }
  }

  throwUnknownFlags(unknownFlags);
  input.mode = input.mode || "fix";
  return { input, options };
}

export function parseYoloAutoArgs(argv = [], context = Object()) {
  const input = Object();
  const options = {
    json: false,
    help: false,
    dryRun: false,
    writeLifecycle: true,
    collectEvidence: false,
    executeAdapter: false,
    allowAdapterCommands: false,
    startProgressServer: undefined,
    runReviewLoop: undefined,
  };
  const positionals: string[] = [];
  const unknownFlags: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--no-write") {
      options.writeLifecycle = false;
    } else if (arg === "--collect-evidence") {
      options.collectEvidence = true;
    } else if (arg === "--execute-adapter") {
      options.executeAdapter = true;
    } else if (arg === "--allow-adapter-commands") {
      options.allowAdapterCommands = true;
    } else if (arg === "--no-progress-server") {
      options.startProgressServer = false;
    } else if (arg === "--no-review-loop") {
      options.runReviewLoop = false;
    } else if (arg === "--prd" || arg.startsWith("--prd=")) {
      const read = readArgValue(argv, i, "--prd");
      input.prdPath = read.value;
      i += read.consumed;
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const read = readArgValue(argv, i, "--mode");
      input.mode = read.value;
      i += read.consumed;
    } else if (arg === "--executor" || arg.startsWith("--executor=")) {
      const read = readArgValue(argv, i, "--executor");
      input.executor = read.value;
      i += read.consumed;
    } else if (arg === "--provider" || arg.startsWith("--provider=")) {
      const read = readArgValue(argv, i, "--provider");
      input.provider = read.value;
      i += read.consumed;
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      const read = readArgValue(argv, i, "--model");
      input.model = read.value;
      i += read.consumed;
    } else if (arg === "--agent-command" || arg.startsWith("--agent-command=") || arg === "--custom-command" || arg.startsWith("--custom-command=")) {
      const prefix = arg.startsWith("--custom-command") ? "--custom-command" : "--agent-command";
      const read = readArgValue(argv, i, prefix);
      input.agentCommand = read.value;
      i += read.consumed;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--")) {
      positionals.push(arg);
    } else if (arg.startsWith("--")) {
      unknownFlags.push(`--${arg.replace(/^--?/, "").split("=")[0]}`);
    }
  }

  throwUnknownFlags(unknownFlags);

  const projectRoot = resolve(input.cwd || context.cwd || process.cwd());
  if (!input.prdPath && positionals.length === 1) {
    const prdPath = existingJsonPath(positionals[0], projectRoot);
    if (prdPath) input.prdPath = prdPath;
  }
  if (!input.prdPath && positionals.length > 0) {
    input.requirement = positionals.join(" ");
    input.objective = input.objective || input.requirement;
  }

  input.mode = input.mode || "fix";
  return { input, options };
}
