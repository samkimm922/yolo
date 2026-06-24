import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPiAgent } from "../agents/pi.js";
import { formatLifecycleGuardText, inspectLifecycleGuard } from "../lifecycle/guard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultYoloRoot = resolve(__dirname, "../..");

export function parsePiArgs(argv = process.argv.slice(2)) {
  const input = Object();
  const options = Object();
  let json = false;

  const readValue = (index: number, prefix: string) => {
    const arg = argv[index];
    if (arg.includes("=")) return { value: arg.slice(prefix.length + 1), consumed: 0 };
    return { value: argv[index + 1], consumed: 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") {
      options.execute = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--requirement" || arg.startsWith("--requirement=")) {
      const read = readValue(i, "--requirement");
      input.requirement = read.value;
      i += read.consumed;
    } else if (arg === "--requirement-file" || arg.startsWith("--requirement-file=")) {
      const read = readValue(i, "--requirement-file");
      input.requirementFile = read.value;
      i += read.consumed;
    } else if (arg === "--findings" || arg.startsWith("--findings=")) {
      const read = readValue(i, "--findings");
      input.findingsPath = read.value;
      i += read.consumed;
    } else if (arg === "--prd" || arg.startsWith("--prd=")) {
      const read = readValue(i, "--prd");
      input.prdPath = read.value;
      i += read.consumed;
    } else if (arg === "--output-dir" || arg.startsWith("--output-dir=")) {
      const read = readValue(i, "--output-dir");
      input.outputDir = read.value;
      i += read.consumed;
    } else if (arg === "--title" || arg.startsWith("--title=")) {
      const read = readValue(i, "--title");
      input.title = read.value;
      i += read.consumed;
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const read = readValue(i, "--mode");
      input.mode = read.value;
      i += read.consumed;
    } else if (arg === "--executor" || arg.startsWith("--executor=")) {
      const read = readValue(i, "--executor");
      input.executor = read.value;
      i += read.consumed;
    } else if (arg === "--provider" || arg.startsWith("--provider=")) {
      const read = readValue(i, "--provider");
      input.provider = read.value;
      i += read.consumed;
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      const read = readValue(i, "--model");
      input.model = read.value;
      i += read.consumed;
    } else if (arg === "--agent-command" || arg.startsWith("--agent-command=") || arg === "--custom-command" || arg.startsWith("--custom-command=")) {
      const prefix = arg.startsWith("--custom-command") ? "--custom-command" : "--agent-command";
      const read = readValue(i, prefix);
      input.agentCommand = read.value;
      i += read.consumed;
    } else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readValue(i, "--cwd");
      input.cwd = read.value;
      i += read.consumed;
    } else if (!arg.startsWith("--")) {
      const abs = resolve(arg);
      if (existsSync(abs)) input.requirementFile = abs;
      else input.requirement = [input.requirement, arg].filter(Boolean).join(" ");
    }
  }

  return { input, options, json };
}

export function formatPiText(result: Record<string, unknown>) {
  const lines = [`[pi-agent] ${result.status}: ${result.summary}`];
  const plan = result.plan as { actions?: Array<{ kind?: string; command?: string; args?: string[]; runtime?: string; params?: Record<string, unknown>; id?: string; phase?: string; summary?: string }> } | undefined;
  if (plan?.actions?.length) {
    lines.push(`actions: ${plan.actions.length}`);
    for (const action of plan.actions) {
      const detail = action.kind === "command"
        ? ` - ${[action.command, ...(action.args || [])].join(" ")}`
        : action.kind === "runtime"
          ? ` - runtime:${action.runtime} ${JSON.stringify(action.params || {})}`
          : "";
      lines.push(`  - ${action.id} [${action.phase}] ${action.summary}${detail}`);
    }
  }
  const nextActions = result.next_actions as string[] | undefined;
  if (nextActions?.length) {
    lines.push("next:");
    for (const next of nextActions) lines.push(`  - ${next}`);
  }
  return lines.join("\n");
}

export async function runPiCli(argv = process.argv.slice(2), io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const { input, options, json } = parsePiArgs(argv);
  const projectRoot = resolve(input.cwd || io.cwd || process.cwd());
  if (options.execute === true) {
    const guard = inspectLifecycleGuard({
      ...input,
      command: "yolo-run",
      projectRoot,
      stateRoot: join(projectRoot, ".yolo"),
      prdPath: input.prdPath ? resolve(projectRoot, input.prdPath) : input.prdPath,
    });
    if (guard.status !== "pass") {
      if (json) stdout.write(`${JSON.stringify(guard, null, 2)}\n`);
      else stderr.write(`${formatLifecycleGuardText(guard)}\n`);
      return 2;
    }
  }
  const result = await runPiAgent(input, {
    yoloRoot: io.yoloRoot || defaultYoloRoot,
    projectRoot,
    stateRoot: join(projectRoot, ".yolo"),
    ...options,
  });

  if (json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else stdout.write(`${formatPiText(result)}\n`);

  const dynamicResult = Object.assign(Object(), result);
  return dynamicResult.exit_code ?? (dynamicResult.status === "success" ? 0 : 1);
}
