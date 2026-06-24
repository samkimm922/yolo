// yolo interview/workflow argument parsers (large multi-flag parsers).
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

export function parseYoloInterviewArgs(argv: string[] = []) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "";
  const ideaParts: string[] = [];
  const input: Record<string, unknown> = { command, ideaParts };
  const options = { json: false, help: false, writeArtifacts: true };
  const args = command ? argv.slice(1) : argv;
  const unknownFlags: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--no-write") {
      options.writeArtifacts = false;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(args, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (arg === "--id" || arg.startsWith("--id=")) {
      const read = readArgValue(args, i, "--id");
      input.id = read.value;
      i += read.consumed;
    } else if (arg === "--title" || arg.startsWith("--title=")) {
      const read = readArgValue(args, i, "--title");
      input.title = read.value;
      i += read.consumed;
    } else if (arg === "--session" || arg.startsWith("--session=")) {
      const read = readArgValue(args, i, "--session");
      input.sessionPath = read.value;
      i += read.consumed;
    } else if (arg === "--question" || arg.startsWith("--question=")) {
      const read = readArgValue(args, i, "--question");
      input.questionId = read.value;
      i += read.consumed;
    } else if (arg === "--answer" || arg.startsWith("--answer=")) {
      const read = readArgValue(args, i, "--answer");
      input.answer = read.value;
      i += read.consumed;
    } else if (arg === "--confirm" || arg.startsWith("--confirm=")) {
      const read = readOptionalBooleanArgValue(args, i, "--confirm");
      input.confirm = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--") && command === "start") {
      ideaParts.push(arg);
    } else if (arg.startsWith("--")) {
      unknownFlags.push(`--${arg.replace(/^--?/, "").split("=")[0]}`);
    }
  }

  throwUnknownFlags(unknownFlags);
  input.idea = ideaParts.join(" ").trim();
  return { input, options };
}

export function parseYoloWorkflowArgs(argv: string[] = []) {
  const objectiveParts: string[] = [];
  const input: Record<string, unknown> = { objectiveParts };
  const options = {
    json: false,
    help: false,
    writeLifecycle: true,
    executeAgents: false,
    allowAgentDispatch: false,
  };
  const unknownFlags: string[] = [];

  function pushList(key: string, value: string) {
    if (!input[key]) input[key] = [];
    (input[key] as string[]).push(value);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--no-write") {
      options.writeLifecycle = false;
    } else if (arg === "--execute-agents" || arg === "--execute-agent-dispatch") {
      options.executeAgents = true;
    } else if (arg === "--allow-agent-dispatch") {
      options.allowAgentDispatch = true;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readArgValue(argv, i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (arg === "--provider" || arg === "--executor" || arg.startsWith("--provider=") || arg.startsWith("--executor=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      input.provider = read.value;
      i += read.consumed;
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const read = readArgValue(argv, i, "--mode");
      input.mode = read.value;
      i += read.consumed;
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      const read = readArgValue(argv, i, "--model");
      input.model = read.value;
      i += read.consumed;
    } else if (arg === "--agent-command" || arg === "--custom-command" || arg.startsWith("--agent-command=") || arg.startsWith("--custom-command=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      input.agentCommand = read.value;
      i += read.consumed;
    } else if (arg === "--timeout-ms" || arg.startsWith("--timeout-ms=")) {
      const read = readArgValue(argv, i, "--timeout-ms");
      input.timeout_ms = read.value;
      i += read.consumed;
    } else if (arg === "--max-budget-usd" || arg.startsWith("--max-budget-usd=")) {
      const read = readArgValue(argv, i, "--max-budget-usd");
      input.max_budget_usd = read.value;
      i += read.consumed;
    } else if (arg === "--agent-tool-profile" || arg === "--tool-profile" || arg.startsWith("--agent-tool-profile=") || arg.startsWith("--tool-profile=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      input.agent_tool_profile = read.value;
      i += read.consumed;
    } else if (arg === "--allow-full-agent-tools") {
      input.allowFullAgentTools = true;
    } else if (arg === "--stage" || arg.startsWith("--stage=")) {
      const read = readArgValue(argv, i, "--stage");
      input.stage = read.value;
      i += read.consumed;
    } else if (arg === "--profile" || arg.startsWith("--profile=")) {
      const read = readArgValue(argv, i, "--profile");
      input.profile = read.value;
      i += read.consumed;
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const read = readArgValue(argv, i, "--mode");
      input.mode = read.value;
      i += read.consumed;
    } else if (arg === "--choice" || arg === "--choose" || arg === "--selection" || arg.startsWith("--choice=") || arg.startsWith("--choose=") || arg.startsWith("--selection=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      input.choice = read.value;
      i += read.consumed;
    } else if (arg === "--boundary-mutation-probe" || arg.startsWith("--boundary-mutation-probe=")) {
      const read = readArgValue(argv, i, "--boundary-mutation-probe");
      input.boundary_mutation_probe = read.value;
      i += read.consumed;
    } else if (arg === "--prd" || arg.startsWith("--prd=")) {
      const read = readArgValue(argv, i, "--prd");
      input.prdPath = read.value;
      i += read.consumed;
    } else if (arg === "--discovery" || arg.startsWith("--discovery=")) {
      const read = readArgValue(argv, i, "--discovery");
      input.discoveryPath = read.value;
      i += read.consumed;
    } else if (arg === "--demand" || arg.startsWith("--demand=")) {
      const read = readArgValue(argv, i, "--demand");
      input.demandPath = read.value;
      i += read.consumed;
    } else if (arg === "--output" || arg.startsWith("--output=")) {
      const read = readArgValue(argv, i, "--output");
      input.outputFile = read.value;
      i += read.consumed;
    } else if (arg === "--approval" || arg.startsWith("--approval=")) {
      const read = readArgValue(argv, i, "--approval");
      input.approval = read.value;
      i += read.consumed;
    } else if (arg === "--id" || arg.startsWith("--id=")) {
      const read = readArgValue(argv, i, "--id");
      input.id = read.value;
      i += read.consumed;
    } else if (arg === "--title" || arg.startsWith("--title=")) {
      const read = readArgValue(argv, i, "--title");
      input.title = read.value;
      i += read.consumed;
    } else if (arg === "--problem" || arg.startsWith("--problem=")) {
      const read = readArgValue(argv, i, "--problem");
      input.problem = read.value;
      i += read.consumed;
    } else if (arg === "--user" || arg === "--users" || arg === "--target-user" || arg.startsWith("--user=") || arg.startsWith("--users=") || arg.startsWith("--target-user=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("target_users", read.value);
      i += read.consumed;
    } else if (arg === "--success" || arg === "--success-criteria" || arg === "--acceptance" || arg.startsWith("--success=") || arg.startsWith("--success-criteria=") || arg.startsWith("--acceptance=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("success_criteria", read.value);
      i += read.consumed;
    } else if (arg === "--constraint" || arg === "--constraints" || arg.startsWith("--constraint=") || arg.startsWith("--constraints=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("constraints", read.value);
      i += read.consumed;
    } else if (arg === "--status-quo" || arg === "--current" || arg.startsWith("--status-quo=") || arg.startsWith("--current=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("status_quo", read.value);
      i += read.consumed;
    } else if (arg === "--evidence" || arg.startsWith("--evidence=")) {
      const read = readArgValue(argv, i, "--evidence");
      pushList("evidence", read.value);
      i += read.consumed;
    } else if (arg === "--assumption" || arg === "--assumptions" || arg.startsWith("--assumption=") || arg.startsWith("--assumptions=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("assumptions", read.value);
      i += read.consumed;
    } else if (arg === "--alternative" || arg === "--alternatives" || arg.startsWith("--alternative=") || arg.startsWith("--alternatives=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("alternatives", read.value);
      i += read.consumed;
    } else if (arg === "--decision" || arg === "--decisions" || arg.startsWith("--decision=") || arg.startsWith("--decisions=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("decisions", read.value);
      i += read.consumed;
    } else if (arg === "--roadmap" || arg === "--mvp" || arg.startsWith("--roadmap=") || arg.startsWith("--mvp=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("roadmap", read.value);
      i += read.consumed;
    } else if (arg === "--non-goal" || arg === "--non-goals" || arg.startsWith("--non-goal=") || arg.startsWith("--non-goals=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("non_goals", read.value);
      i += read.consumed;
    } else if (arg === "--target" || arg === "--file" || arg === "--files" || arg.startsWith("--target=") || arg.startsWith("--file=") || arg.startsWith("--files=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("target_files", read.value);
      i += read.consumed;
    } else if (arg === "--risk" || arg === "--risks" || arg.startsWith("--risk=") || arg.startsWith("--risks=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("risks", read.value);
      i += read.consumed;
    } else if (arg === "--question" || arg === "--open-question" || arg.startsWith("--question=") || arg.startsWith("--open-question=")) {
      const read = readArgValue(argv, i, arg.split("=")[0]);
      pushList("open_questions", read.value);
      i += read.consumed;
    } else if (arg === "--research" || arg.startsWith("--research=")) {
      const read = arg.includes("=") ? readArgValue(argv, i, "--research") : { value: "research", consumed: 0 };
      input.research = read.value;
      i += read.consumed;
    } else if (arg === "--lesson" || arg.startsWith("--lesson=")) {
      const read = readArgValue(argv, i, "--lesson");
      input.lesson = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--")) {
      if (!input.prdPath && arg.endsWith(".json")) input.prdPath = arg;
      else objectiveParts.push(arg);
    } else if (arg.startsWith("--")) {
      unknownFlags.push(`--${arg.replace(/^--?/, "").split("=")[0]}`);
    }
  }

  throwUnknownFlags(unknownFlags);
  input.objective = objectiveParts.join(" ").trim();
  return { input, options };
}
