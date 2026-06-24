#!/usr/bin/env node
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPrdContract } from "../runtime/gates/prd-contract-doctor.js";
import { readJsonFileBounded } from "../lib/bounded-read.js";
import {
  asRecord,
  errorMessage,
  isRecord,
  type PrdCondition,
  type PrdDocument,
  type PrdTarget,
  type PrdTask,
  type UnknownRecord,
} from "./condition-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

type MigrationOptions = UnknownRecord & {
  apply?: boolean;
  dryRun?: boolean;
};

type MigrationIssue = {
  task_id: string | null;
  code: string;
  detail: string;
  task_index?: number;
  target_index?: number;
};

type TargetFileEntry = {
  file: string;
  targetIndex: number;
};

type MigrationTaskChange = {
  task_id: string;
  added_count: number;
  missing_targets: string[];
  added: PrdCondition[];
};

type MigrationResult = {
  changed: boolean;
  added_count: number;
  blocked_count: number;
  tasks_changed: MigrationTaskChange[];
  issues: MigrationIssue[];
  prd: PrdDocument;
  dry_run?: boolean;
};

type MigrationFileResult = MigrationResult & {
  file: string;
  applied: boolean;
  dry_run: boolean;
};

type PrintableMigrationResult = {
  changed: boolean;
  added_count: number;
  blocked_count: number;
  dry_run?: boolean;
  file?: string;
  tasks_changed: MigrationTaskChange[];
  issues: MigrationIssue[];
};

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

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeTargetPath(value: unknown): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/:\d+(?:-\d+)?$/, "");
}

function collectConditionFiles(value: unknown, out: string[] = []): string[] {
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
      const record = asRecord(value);
      if (record[key]) collectConditionFiles(record[key], out);
    }
  }
  return out;
}

function conditionCoverageFiles(condition: PrdCondition, targets: PrdTarget[] = []): string[] {
  if (condition?.severity !== "FAIL") return [];
  if (!condition.type || !TARGET_COVERAGE_CONDITION_TYPES.has(condition.type)) return [];

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

function targetCoverageFiles(conditions: PrdCondition[] = [], targets: PrdTarget[] = []): Set<string> {
  const files = new Set<string>();
  for (const condition of conditions) {
    for (const file of conditionCoverageFiles(condition, targets)) files.add(file);
  }
  return files;
}

function isFeatureTask(task: PrdTask): boolean {
  return task?.task_kind === "atomic_feature" || task?.type === "feature";
}

function makeUniqueConditionId(existingIds: Set<string>, base: string): string {
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

function addIssue(issues: MigrationIssue[], task: PrdTask | null | undefined, code: string, detail: string, extra: Partial<MigrationIssue> = {}) {
  issues.push({
    task_id: task?.id || null,
    code,
    detail,
    ...extra,
  });
}

function buildTargetCoverageCondition(task: PrdTask, file: string, targetIndex: number, existingIds: Set<string>): PrdCondition {
  const feature = isFeatureTask(task);
  return {
    id: makeUniqueConditionId(existingIds, `POST-${task.id}-TARGET-${targetIndex + 1}`),
    type: feature ? "file_exists" : "target_file_modified",
    severity: "FAIL",
    params: { file },
    message: feature ? `目标文件必须存在: ${file}` : `目标文件必须被修改: ${file}`,
  };
}

function quoteShellArg(value: unknown): string {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:@=-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function summarizeContract(result: unknown) {
  if (!result) return null;
  const contract = asRecord(result);
  const failures = Array.isArray(contract.failures) ? contract.failures : [];
  return {
    status: contract.status,
    blocks_execution: contract.blocks_execution,
    failure_count: contract.failure_count,
    warning_count: contract.warning_count,
    failures: failures.slice(0, 8),
  };
}

export function migratePrdGates(inputPrd: PrdDocument, options: MigrationOptions = {}): MigrationResult {
  const prd = deepClone(inputPrd || {});
  const issues: MigrationIssue[] = [];
  const tasksChanged: MigrationTaskChange[] = [];
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

    const targetFiles: TargetFileEntry[] = [];
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

    const existingIds = new Set(postConditions.flatMap((condition) => condition?.id ? [condition.id] : []));
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

export function createPrdMigrationAdvice(inputPrd: PrdDocument, prdPath = "prd.json") {
  const migration = migratePrdGates(inputPrd, { dryRun: true });
  const inspectedContract = migration.changed ? inspectPrdContract(migration.prd) : null;
  const contractAfterMigration = isRecord(inspectedContract) ? inspectedContract : null;
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

export function migratePrdFile(path: string, options: MigrationOptions = {}): MigrationFileResult {
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) throw new Error(`PRD not found: ${path}`);

  const prd = readJsonFileBounded<PrdDocument>(resolved, { errorCode: "PRD_JSON_SIZE_LIMIT_EXCEEDED" });
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

function collectPrdFiles(dir: string, files: string[]) {
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
    try {
      const data = readJsonFileBounded<unknown>(path, { errorCode: "PRD_JSON_SIZE_LIMIT_EXCEEDED" });
      if (isPrdDocument(data)) files.push(path);
    } catch {
      // Non-JSON or transient files are not PRD migration candidates.
    }
  }
}

function isPrdDocument(data: unknown): data is PrdDocument {
  if (!isRecord(data)) return false;
  if (typeof data.id !== "string" || !Array.isArray(data.tasks)) return false;
  return data.tasks.every((task) => isRecord(task) && typeof task.id === "string");
}

function defaultPrdDirs(): string[] {
  const cwd = resolve(process.cwd());
  const roots = [cwd];
  if (PACKAGE_ROOT !== cwd) roots.push(PACKAGE_ROOT);
  return roots.flatMap((root) => [
    join(root, "data/prd/current"),
    join(root, "data/prd/archive"),
    join(root, "data"),
  ]);
}

export function findPrdFiles(dirs: string[] = defaultPrdDirs()) {
  const files: string[] = [];
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

function printResult(result: PrintableMigrationResult) {
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
    const payload = { status: "error", error: errorMessage(error) };
    if (json) console.error(JSON.stringify(payload, null, 2));
    else console.error(`[prd-migrate-gates] ${errorMessage(error)}`);
    process.exit(2);
  }
}

if (isMain) main();
