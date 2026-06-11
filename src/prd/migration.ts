#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPrdContract } from "../runtime/gates/prd-contract-doctor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

const TARGET_COVERAGE_CONDITION_TYPES = new Set([
  "ast_callback_uses_param",
  "ast_find_by_property",
  "code_contains",
  "code_matches",
  "code_not_contains",
  "dir_exists",
  "file_exists",
  "file_lines_max",
  "file_not_exists",
  "function_contains_call",
  "function_contains_text",
  "no_file_over_max_lines",
  "required_imports_present",
  "target_file_modified",
]);

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeTargetPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/:\d+(?:-\d+)?$/, "");
}

function collectConditionFiles(value, out = []) {
  if (!value) return out;
  if (typeof value === "string") {
    out.push(normalizeTargetPath(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectConditionFiles(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const key of ["file", "path", "target", "target_file", "file_path"]) {
      if (value[key]) collectConditionFiles(value[key], out);
    }
  }
  return out;
}

function conditionCoverageFiles(condition, targets = []) {
  if (condition?.severity !== "FAIL") return [];
  if (!TARGET_COVERAGE_CONDITION_TYPES.has(condition?.type)) return [];

  const params = condition.params || {};
  const files = [
    ...collectConditionFiles(params.file),
    ...collectConditionFiles(params.path),
    ...collectConditionFiles(params.target),
    ...collectConditionFiles(params.target_file),
    ...collectConditionFiles(params.file_path),
    ...collectConditionFiles(params.files),
    ...collectConditionFiles(params.paths),
    ...collectConditionFiles(params.targets),
    ...collectConditionFiles(condition.file),
    ...collectConditionFiles(condition.path),
    ...collectConditionFiles(condition.target_file),
  ].filter(Boolean);

  if (condition.type === "target_file_modified" && files.length === 0 && targets[0]?.file) {
    files.push(normalizeTargetPath(targets[0].file));
  }

  return files;
}

function targetCoverageFiles(conditions = [], targets = []) {
  const files = new Set();
  for (const condition of conditions) {
    for (const file of conditionCoverageFiles(condition, targets)) files.add(file);
  }
  return files;
}

function isFeatureTask(task) {
  return task?.task_kind === "atomic_feature" || task?.type === "feature";
}

function makeUniqueConditionId(existingIds, base) {
  if (!existingIds.has(base)) {
    existingIds.add(base);
    return base;
  }

  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  const id = `${base}-${suffix}`;
  existingIds.add(id);
  return id;
}

function addIssue(issues, task, code, detail, extra = Object()) {
  issues.push({
    task_id: task?.id || null,
    code,
    detail,
    ...extra,
  });
}

function buildTargetCoverageCondition(task, file, targetIndex, existingIds) {
  const feature = isFeatureTask(task);
  return {
    id: makeUniqueConditionId(existingIds, `POST-${task.id}-TARGET-${targetIndex + 1}`),
    type: feature ? "file_exists" : "target_file_modified",
    severity: "FAIL",
    params: { file },
    message: feature ? `目标文件必须存在: ${file}` : `目标文件必须被修改: ${file}`,
  };
}

function quoteShellArg(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:@=-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function summarizeContract(result) {
  if (!result) return null;
  return {
    status: result.status,
    blocks_execution: result.blocks_execution,
    failure_count: result.failure_count,
    warning_count: result.warning_count,
    failures: (result.failures || []).slice(0, 8),
  };
}

export function migratePrdGates(inputPrd, options = Object()) {
  const prd = deepClone(inputPrd || {});
  const issues = [];
  const tasksChanged = [];
  let addedCount = 0;

  const tasks = Array.isArray(prd.tasks) ? prd.tasks : [];
  if (!tasks.length) {
    return {
      changed: false,
      added_count: 0,
      blocked_count: 1,
      tasks_changed: [],
      issues: [{
        task_id: null,
        code: "NO_TASKS",
        detail: "PRD must contain tasks before target coverage gates can be migrated",
      }],
      prd,
    };
  }

  for (const [taskIndex, task] of tasks.entries()) {
    if (task?.status !== "pending") continue;

    if (!task.id) {
      addIssue(issues, task, "TASK_MISSING_ID", "pending task needs a stable id before gate migration", {
        task_index: taskIndex,
      });
      continue;
    }

    const targets = Array.isArray(task.scope?.targets) ? task.scope.targets : [];
    if (!targets.length) {
      addIssue(issues, task, "TASK_MISSING_TARGETS", "pending task has no scope.targets; target coverage cannot be inferred");
      continue;
    }

    if (task.post_conditions !== undefined && !Array.isArray(task.post_conditions)) {
      addIssue(issues, task, "TASK_POST_CONDITIONS_NOT_ARRAY", "post_conditions must be an array before gate migration");
      continue;
    }

    const targetFiles = [];
    for (const [targetIndex, target] of targets.entries()) {
      const file = normalizeTargetPath(target?.file);
      if (!file) {
        addIssue(issues, task, "TASK_TARGET_MISSING_FILE", "scope target is missing file", {
          target_index: targetIndex,
        });
        continue;
      }
      if (!targetFiles.some((entry) => entry.file === file)) targetFiles.push({ file, targetIndex });
    }

    if (!targetFiles.length) continue;

    const postConditions = task.post_conditions || [];
    const covered = targetCoverageFiles(postConditions, targets);
    const missing = targetFiles.filter(({ file }) => !covered.has(file));
    if (!missing.length) continue;

    const existingIds = new Set(postConditions.map((condition) => condition?.id).filter(Boolean));
    const added = missing.map(({ file, targetIndex }) => buildTargetCoverageCondition(task, file, targetIndex, existingIds));

    task.post_conditions = [...postConditions, ...added];
    addedCount += added.length;
    tasksChanged.push({
      task_id: task.id,
      added_count: added.length,
      missing_targets: missing.map(({ file }) => file),
      added,
    });
  }

  return {
    changed: addedCount > 0,
    added_count: addedCount,
    blocked_count: issues.length,
    tasks_changed: tasksChanged,
    issues,
    prd,
    dry_run: options.dryRun !== false,
  };
}

export function createPrdMigrationAdvice(inputPrd, prdPath = "prd.json") {
  const migration = migratePrdGates(inputPrd, { dryRun: true });
  const contractAfterMigration = migration.changed ? inspectPrdContract(migration.prd) : null;
  const dryRunCommand = `yolo-prd-migrate-gates ${quoteShellArg(prdPath)} --json`;
  const applyCommand = `yolo-prd-migrate-gates ${quoteShellArg(prdPath)} --apply`;
  const nextActions = [];

  if (migration.changed) {
    nextActions.push(`Review gate migration dry-run: ${dryRunCommand}`);
    nextActions.push(`Apply target coverage gates after review: ${applyCommand}`);
  }

  if (!migration.changed) {
    nextActions.push("Fix PRD contract failures manually; no safe target coverage migration was inferred.");
  } else if (contractAfterMigration?.blocks_execution) {
    nextActions.push("After applying migration, fix remaining PRD contract failures manually.");
  } else {
    nextActions.push("Rerun contract gate after applying migration.");
  }

  return {
    available: migration.changed,
    would_fix_contract: Boolean(migration.changed && contractAfterMigration && !contractAfterMigration.blocks_execution),
    added_count: migration.added_count,
    blocked_count: migration.blocked_count,
    tasks_changed: migration.tasks_changed.map((task) => ({
      task_id: task.task_id,
      added_count: task.added_count,
      missing_targets: task.missing_targets,
    })),
    issues: migration.issues,
    dry_run_command: dryRunCommand,
    apply_command: applyCommand,
    contract_after_migration: summarizeContract(contractAfterMigration),
    next_actions: nextActions,
  };
}

export function migratePrdFile(path, options = Object()) {
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) throw new Error(`PRD not found: ${path}`);

  const original = readFileSync(resolved, "utf8");
  const prd = JSON.parse(original);
  const result = migratePrdGates(prd, { dryRun: !options.apply });
  const canApply = Boolean(options.apply) && result.blocked_count === 0;

  if (canApply && result.changed) {
    writeFileSync(resolved, `${JSON.stringify(result.prd, null, 2)}\n`, "utf8");
  }

  return {
    ...result,
    file: resolved,
    applied: canApply && result.changed,
    dry_run: !options.apply,
  };
}

function collectPrdFiles(dir, files) {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    const path = resolve(dir, file);
    try {
      if (statSync(path).isDirectory()) {
        if (file.includes("node_modules") || file.startsWith(".")) continue;
        collectPrdFiles(path, files);
        continue;
      }
    } catch {
      continue;
    }
    if (!file.endsWith(".json")) continue;
    if (file.includes("baseline") || file.includes("learn") || file.includes("settings") || file === "package.json") continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(data?.tasks)) files.push(path);
    } catch {
      // Non-JSON or transient files are not PRD migration candidates.
    }
  }
}

function defaultPrdDirs() {
  const cwd = resolve(process.cwd());
  const roots = [cwd];
  if (PACKAGE_ROOT !== cwd) roots.push(PACKAGE_ROOT);
  return roots.flatMap((root) => [
    join(root, "data/prd/current"),
    join(root, "data/prd/archive"),
    join(root, "data"),
  ]);
}

export function findPrdFiles(dirs = defaultPrdDirs()) {
  const files = [];
  for (const dir of dirs) {
    collectPrdFiles(dir, files);
  }
  return [...new Set(files)].sort();
}

function usage() {
  return [
    "用法:",
    "  yolo-prd-migrate-gates <prd.json> [--apply] [--json]",
    "  yolo-prd-migrate-gates --check-all [--json]",
    "",
    "默认 dry-run，只报告会补哪些 target coverage gates；加 --apply 才写回单个 PRD。",
  ].join("\n");
}

function printResult(result) {
  const mode = result.dry_run ? "dry-run" : "apply";
  console.log(`[prd-migrate-gates] ${mode} changed=${result.changed} added=${result.added_count} blocked=${result.blocked_count}`);
  if (result.file) console.log(`  file: ${result.file}`);
  for (const task of result.tasks_changed) {
    console.log(`  ${task.task_id}: +${task.added_count} gates (${task.missing_targets.join(", ")})`);
  }
  for (const issue of result.issues) {
    console.log(`  blocked ${issue.code}${issue.task_id ? ` task=${issue.task_id}` : ""}: ${issue.detail}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const apply = args.includes("--apply");
  const checkAll = args.includes("--check-all");
  const fileArg = args.find((arg) => !arg.startsWith("--"));

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
        results: results.map(({ prd, ...result }) => result),
      };
      if (json) console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(`[prd-migrate-gates] check-all files=${summary.file_count} changed=${summary.changed_count} added=${summary.added_count} blocked=${summary.blocked_count}`);
        for (const result of summary.results.filter((item) => item.changed || item.blocked_count > 0)) printResult(result);
      }
      process.exit(0);
    }

    if (!fileArg) {
      console.error(usage());
      process.exit(2);
    }

    const result = migratePrdFile(fileArg, { apply });
    if (json) console.log(JSON.stringify({ status: result.blocked_count > 0 ? "blocked" : "success", ...result }, null, 2));
    else printResult(result);
    process.exit(result.blocked_count > 0 && apply ? 1 : 0);
  } catch (error) {
    const payload = { status: "error", error: error.message };
    if (json) console.error(JSON.stringify(payload, null, 2));
    else console.error(`[prd-migrate-gates] ${error.message}`);
    process.exit(2);
  }
}

if (isMain) main();
