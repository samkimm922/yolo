import { preflightAllPrds, preflightPrd } from "../prd/preflight.js";

export function usage() {
  return [
    "用法:",
    "  yolo-prd-preflight <prd.json> [--json]",
    "  yolo-prd-preflight --check-all [--json]",
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
  for (const item of result.results.filter((entry) => entry.status !== "pass")) {
    lines.push(`  ${item.status} ${item.file}`);
    for (const reason of item.blocked_reasons.slice(0, 3)) {
      lines.push(`    ${reason.source}:${reason.code}${reason.task_id ? ` task=${reason.task_id}` : ""}`);
    }
  }
  return lines.join("\n");
}

export function runPrdPreflightCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const json = argv.includes("--json");
  const checkAll = argv.includes("--check-all");
  const fileArg = argv.find((arg) => !arg.startsWith("--"));

  try {
    if (checkAll) {
      const result = preflightAllPrds();
      stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${formatAll(result)}\n`);
      return result.status === "blocked" ? 1 : 0;
    }

    if (!fileArg) {
      stderr.write(`${usage()}\n`);
      return 2;
    }

    const result = preflightPrd(fileArg);
    stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${formatSingle(result)}\n`);
    return result.status === "blocked" ? 1 : 0;
  } catch (error) {
    const payload = { status: "error", error: error.message };
    stderr.write(json ? `${JSON.stringify(payload, null, 2)}\n` : `[prd-preflight] ${error.message}\n`);
    return 2;
  }
}
