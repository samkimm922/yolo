import { findPrdFiles, migratePrdFile } from "../prd/migration.js";

export function usage() {
  return [
    "用法:",
    "  yolo-prd-migrate-gates <prd.json> [--apply] [--json]",
    "  yolo-prd-migrate-gates --check-all [--json]",
    "",
    "默认 dry-run，只报告会补哪些 target coverage gates；加 --apply 才写回单个 PRD。",
  ].join("\n");
}

function publicResult(result) {
  const { prd, ...rest } = result;
  return rest;
}

function formatResult(result) {
  const mode = result.dry_run ? "dry-run" : "apply";
  const lines = [`[prd-migrate-gates] ${mode} changed=${result.changed} added=${result.added_count} blocked=${result.blocked_count}`];
  if (result.file) lines.push(`  file: ${result.file}`);
  for (const task of result.tasks_changed) {
    lines.push(`  ${task.task_id}: +${task.added_count} gates (${task.missing_targets.join(", ")})`);
  }
  for (const issue of result.issues) {
    lines.push(`  blocked ${issue.code}${issue.task_id ? ` task=${issue.task_id}` : ""}: ${issue.detail}`);
  }
  return lines.join("\n");
}

export function runPrdMigrateGatesCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const json = argv.includes("--json");
  const apply = argv.includes("--apply");
  const checkAll = argv.includes("--check-all");
  const fileArg = argv.find((arg) => !arg.startsWith("--"));

  try {
    if (checkAll) {
      if (apply) throw new Error("--check-all is dry-run only; migrate one PRD at a time with --apply");
      const results = findPrdFiles().map((file) => migratePrdFile(file));
      const summary = {
        status: "success",
        mode: "dry-run",
        file_count: results.length,
        changed_count: results.filter((result) => result.changed).length,
        added_count: results.reduce((sum, result) => sum + result.added_count, 0),
        blocked_count: results.reduce((sum, result) => sum + result.blocked_count, 0),
        results: results.map(publicResult),
      };
      if (json) {
        stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } else {
        const lines = [`[prd-migrate-gates] check-all files=${summary.file_count} changed=${summary.changed_count} added=${summary.added_count} blocked=${summary.blocked_count}`];
        for (const result of summary.results.filter((item) => item.changed || item.blocked_count > 0)) {
          lines.push(formatResult(result));
        }
        stdout.write(`${lines.join("\n")}\n`);
      }
      return summary.blocked_count > 0 ? 1 : 0;
    }

    if (!fileArg) {
      stderr.write(`${usage()}\n`);
      return 2;
    }

    const result = migratePrdFile(fileArg, { apply });
    const payload = { status: result.blocked_count > 0 ? "blocked" : "success", ...publicResult(result) };
    stdout.write(json ? `${JSON.stringify(payload, null, 2)}\n` : `${formatResult(result)}\n`);
    return result.blocked_count > 0 ? 1 : 0;
  } catch (error) {
    const payload = { status: "error", error: error.message };
    stderr.write(json ? `${JSON.stringify(payload, null, 2)}\n` : `[prd-migrate-gates] ${error.message}\n`);
    return 2;
  }
}
