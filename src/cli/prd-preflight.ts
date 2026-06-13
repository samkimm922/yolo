import { preflightAllPrds, preflightPrd } from "../prd/preflight.js";

export function usage() {
  return [
    "用法:",
    "  yolo-prd-preflight <prd.json> [--json]",
    "  yolo-prd-preflight --check-all [--json] [--dir <path>...]",
    "",
    "Preflight 会汇总 schema、contract、migration advice 和 runner readiness，不修改 PRD。",
  ].join("\n");
}

function formatSingle(result) {
  const lines = [`[prd-preflight] ${result.status} file=${result.file}`];
  lines.push(`  schema=${result.schema?.ok ? "pass" : "fail"} contract=${result.contract?.status || "unknown"} spec=${result.spec_governance?.status || "unknown"} can_execute=${result.runner_readiness.can_execute}`);
  if (result.runner_readiness.tasks.total > 0) {
    const tasks = result.runner_readiness.tasks;
    lines.push(`  tasks total=${tasks.total} pending=${tasks.pending} completed=${tasks.completed} blocked=${tasks.blocked} failed=${tasks.failed}`);
  }
  for (const reason of result.blocked_reasons.slice(0, 8)) {
    lines.push(`  blocked ${reason.source}:${reason.code}${reason.task_id ? ` task=${reason.task_id}` : ""}: ${reason.detail}`);
  }
  for (const action of result.runner_readiness.next_actions) {
    lines.push(`  next: ${action}`);
  }
  return lines.join("\n");
}

function formatAll(result) {
  const lines = [`[prd-preflight] ${result.status} files=${result.file_count} pass=${result.pass_count} warning=${result.warning_count} blocked=${result.blocked_count}`];
  for (const reason of (result.blocked_reasons || []).slice(0, 3)) {
    lines.push(`  blocked ${reason.source}:${reason.code}: ${reason.detail}`);
  }
  for (const item of result.results.filter((entry) => entry.status !== "pass")) {
    lines.push(`  ${item.status} ${item.file}`);
    for (const reason of item.blocked_reasons.slice(0, 3)) {
      lines.push(`    ${reason.source}:${reason.code}${reason.task_id ? ` task=${reason.task_id}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function runPrdPreflightCli(argv = process.argv.slice(2), io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const json = argv.includes("--json");
  const checkAll = argv.includes("--check-all");
  const options = Object();
  let fileArg = "";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--mode" || arg.startsWith("--mode=")) {
      options.mode = arg.includes("=") ? arg.split("=").slice(1).join("=") : argv[++index];
    } else if (arg === "--dir" || arg === "--dirs" || arg.startsWith("--dir=") || arg.startsWith("--dirs=")) {
      const value = arg.includes("=") ? arg.split("=").slice(1).join("=") : argv[++index];
      const dirs = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
      if (dirs.length > 0) options.dirs = [...(options.dirs || []), ...dirs];
    } else if (arg === "--strict") {
      options.mode = "strict";
      options.strictExecution = true;
      options.strictWarnings = true;
    } else if (arg === "--release") {
      options.mode = "release";
      options.strictExecution = true;
      options.strictWarnings = true;
    } else if (arg === "--verify") {
      options.mode = "verify";
      options.strictWarnings = true;
    } else if (!arg.startsWith("--") && !fileArg) {
      fileArg = arg;
    }
  }

  try {
    if (checkAll) {
      const result = preflightAllPrds(options);
      stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${formatAll(result)}\n`);
      return result.status === "pass" ? 0 : result.status === "warning" ? 2 : 1;
    }

    if (!fileArg) {
      stderr.write(`${usage()}\n`);
      return 2;
    }

    const result = preflightPrd(fileArg, options);
    stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${formatSingle(result)}\n`);
    return result.status === "pass" ? 0 : result.status === "warning" ? 2 : 1;
  } catch (error) {
    const payload = { status: "error", error: error.message };
    stderr.write(json ? `${JSON.stringify(payload, null, 2)}\n` : `[prd-preflight] ${error.message}\n`);
    return 1;
  }
}
