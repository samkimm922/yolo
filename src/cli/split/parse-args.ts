// YOLO subcommand argument parsers.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

import { resolve } from "node:path";
import { existingJsonPath } from "./shared.js";
import {
  readArgValue,
  readOptionalBooleanArgValue,
  throwUnknownFlags,
} from "./parse-helpers.js";

export function parseYoloInitArgs(argv = []) {
  const input = Object();
  const options = { json: false, help: false, force: false, dryRun: false };
  const unknownFlags = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (arg === "--home-dir" || arg.startsWith("--home-dir=")) {
      const read = readArgValue(argv, i, "--home-dir");
      input.homeDir = read.value;
      i += read.consumed;
    } else if (arg === "--name" || arg.startsWith("--name=")) {
      const read = readArgValue(argv, i, "--name");
      input.projectName = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && !input.cwd) {
      input.cwd = arg;
    } else if (arg.startsWith("--")) {
      unknownFlags.push(`--${arg.replace(/^--?/, "").split("=")[0]}`);
    }
  }

  throwUnknownFlags(unknownFlags);
  return { input, options };
}

export function parseYoloSetupArgs(argv = []) {
  const input = Object();
  const options = {
    json: false,
    help: false,
    force: false,
    dryRun: false,
    target: "both",
    scope: "project",
  };
  const unknownFlags = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--target" || arg.startsWith("--target=")) {
      const read = readArgValue(argv, i, "--target");
      options.target = read.value;
      i += read.consumed;
    } else if (arg === "--scope" || arg.startsWith("--scope=")) {
      const read = readArgValue(argv, i, "--scope");
      options.scope = read.value;
      i += read.consumed;
    } else if (arg === "--install-scope" || arg.startsWith("--install-scope=")) {
      const read = readArgValue(argv, i, "--install-scope");
      options.scope = read.value;
      i += read.consumed;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (arg === "--home-dir" || arg.startsWith("--home-dir=")) {
      const read = readArgValue(argv, i, "--home-dir");
      input.homeDir = read.value;
      i += read.consumed;
    } else if (arg === "--name" || arg.startsWith("--name=")) {
      const read = readArgValue(argv, i, "--name");
      input.projectName = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && !input.cwd) {
      input.cwd = arg;
    } else if (arg.startsWith("--")) {
      unknownFlags.push(`--${arg.replace(/^--?/, "").split("=")[0]}`);
    }
  }

  throwUnknownFlags(unknownFlags);
  return { input, options };
}

export function parseYoloMemoryArgs(argv = []) {
  const input = Object();
  const options = Object.assign(Object(), {
    json: false,
    help: false,
    dryRun: false,
    writeLegacyPointers: false,
    applyRetention: true,
    migrateLearning: true,
    pruneGeneratedArchives: true,
  });

  const unknownFlags = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "refresh") {
      continue;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--legacy-pointers") {
      options.writeLegacyPointers = true;
    } else if (arg === "--no-retention") {
      options.applyRetention = false;
    } else if (arg === "--no-learning-migration") {
      options.migrateLearning = false;
    } else if (arg === "--no-prune-generated-archives") {
      options.pruneGeneratedArchives = false;
    } else if (arg.startsWith("--max-")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      const key = arg.replace(/^--/, "").split("=")[0].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = Number(read.value);
      i += read.consumed;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && !input.cwd) {
      input.cwd = arg;
    } else if (arg.startsWith("--")) {
      unknownFlags.push(`--${arg.replace(/^--?/, "").split("=")[0]}`);
    }
  }

  throwUnknownFlags(unknownFlags);
  return { input, options };
}

export function parseYoloReleaseCandidateArgs(argv = []) {
  const input = Object();
  const options = {
    json: false,
    help: false,
    dryRun: false,
    allowUntracked: false,
    allowUnknown: false,
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
    } else if (arg === "--allow-untracked" || arg === "--allow-unknown") {
      // Removed: untracked/unknown files must never bypass release provenance checks.
      // These flags are accepted but ignored to avoid breaking existing scripts.
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const read = readArgValue(argv, i, "--mode");
      input.mode = read.value;
      i += read.consumed;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && !input.scope) {
      input.scope = arg;
    } else if (arg.startsWith("--")) {
      unknownFlags.push(`--${arg.replace(/^--?/, "").split("=")[0]}`);
    }
  }

  throwUnknownFlags(unknownFlags);
  input.mode = input.mode || "rc";
  return { input, options };
}

export function parseYoloProgressUiEvidenceArgs(argv = []) {
  const input = Object();
  const options = { json: false, help: false, writeArtifacts: true };
  const unknownFlags = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--no-write") {
      options.writeArtifacts = false;
    } else if (arg === "--output" || arg.startsWith("--output=")) {
      const read = readArgValue(argv, i, "--output");
      input.outputPath = read.value;
      i += read.consumed;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && !input.cwd) {
      input.cwd = arg;
    } else if (arg.startsWith("--")) {
      unknownFlags.push(`--${arg.replace(/^--?/, "").split("=")[0]}`);
    }
  }

  throwUnknownFlags(unknownFlags);
  return { input, options };
}

export function parseYoloCheckArgs(argv = []) {
  const input = Object();
  const options = { json: false, help: false, writeLifecycle: true, collectEvidence: false, executeAdapter: false, allowAdapterCommands: false };
  const unknownFlags = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--no-write") {
      options.writeLifecycle = false;
    } else if (arg === "--collect-evidence") {
      options.collectEvidence = true;
    } else if (arg === "--execute-adapter") {
      options.executeAdapter = true;
    } else if (arg === "--allow-adapter-commands") {
      options.allowAdapterCommands = true;
    } else if (arg === "--strict") {
      input.mode = "strict";
      input.strictExecution = true;
    } else if (arg === "--release") {
      input.mode = "release";
      input.strictExecution = true;
    } else if (arg === "--ship") {
      input.mode = "ship";
    } else if (arg === "--verify") {
      input.mode = "verify";
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const read = readArgValue(argv, i, "--mode");
      input.mode = read.value;
      i += read.consumed;
    } else if (arg === "--approval-artifact" || arg.startsWith("--approval-artifact=") || arg === "--approval" || arg.startsWith("--approval=")) {
      const read = readArgValue(argv, i, arg.startsWith("--approval=") ? "--approval" : "--approval-artifact");
      input.approvalArtifact = read.value;
      i += read.consumed;
    } else if (arg === "--run-report" || arg.startsWith("--run-report=") || arg === "--run-report-path" || arg.startsWith("--run-report-path=")) {
      const read = readArgValue(argv, i, arg.startsWith("--run-report-path") ? "--run-report-path" : "--run-report");
      input.runReportPath = read.value;
      i += read.consumed;
    } else if (arg === "--review-report" || arg.startsWith("--review-report=") || arg === "--review-report-path" || arg.startsWith("--review-report-path=")) {
      const read = readArgValue(argv, i, arg.startsWith("--review-report-path") ? "--review-report-path" : "--review-report");
      input.reviewReportPath = read.value;
      i += read.consumed;
    } else if (arg === "--prd" || arg.startsWith("--prd=")) {
      const read = readArgValue(argv, i, "--prd");
      input.prdPath = read.value;
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
  return { input, options };
}

export function parseYoloAcceptArgs(argv = []) {
  return parseYoloCheckArgs(argv);
}

// Re-export the workflow/interview parsers split into a sibling module.
export { parseYoloInterviewArgs, parseYoloWorkflowArgs } from "./parse-args-workflow.js";
// Re-export the run/auto parsers split into a sibling module.
export { parseYoloArgs, parseYoloAutoArgs } from "./parse-args-run.js";
