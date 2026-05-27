#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPPORTED_CONDITION_TYPES = new Set([
  "acceptance_criteria",
  "build_pass",
  "business_code_min",
  "code_contains",
  "code_matches",
  "code_not_contains",
  "dir_exists",
  "file_exists",
  "file_lines_max",
  "file_not_exists",
  "files_modified_max",
  "ast_callback_uses_param",
  "ast_find_by_property",
  "function_contains_call",
  "function_contains_text",
  "no_file_over_max_lines",
  "no_forbidden_patterns",
  "no_new_dead_code",
  "no_new_lint_errors",
  "no_new_type_errors",
  "required_imports_present",
  "target_file_modified",
  "type_errors_contain",
  "test_file_passes",
  "tests_pass",
]);

const MANUAL_ONLY_CONDITION_TYPES = new Set([
  "acceptance_criteria",
]);

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

function normalizeCondition(condition) {
  return {
    id: condition?.id || "UNKNOWN",
    type: condition?.type || "UNKNOWN",
    severity: condition?.severity || "FAIL",
    params: condition?.params || {},
  };
}

function normalizeTargetPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/:\d+(?:-\d+)?$/, "");
}

function isExecutableFailGate(condition) {
  const normalized = normalizeCondition(condition);
  return normalized.severity === "FAIL" &&
    SUPPORTED_CONDITION_TYPES.has(normalized.type) &&
    !MANUAL_ONLY_CONDITION_TYPES.has(normalized.type);
}

function collectParamFiles(value, out = []) {
  if (!value) return out;
  if (typeof value === "string") {
    out.push(normalizeTargetPath(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectParamFiles(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const key of ["file", "path", "target", "target_file", "file_path"]) {
      if (value[key]) collectParamFiles(value[key], out);
    }
  }
  return out;
}

function conditionCoveredTargets(condition, targets = []) {
  const normalized = normalizeCondition(condition);
  if (!isExecutableFailGate(condition) || !TARGET_COVERAGE_CONDITION_TYPES.has(normalized.type)) {
    return new Set();
  }

  const params = normalized.params || {};
  const files = [
    ...collectParamFiles(params.file),
    ...collectParamFiles(params.path),
    ...collectParamFiles(params.target),
    ...collectParamFiles(params.target_file),
    ...collectParamFiles(params.file_path),
    ...collectParamFiles(params.files),
    ...collectParamFiles(params.paths),
    ...collectParamFiles(params.targets),
    ...collectParamFiles(condition.file),
    ...collectParamFiles(condition.path),
    ...collectParamFiles(condition.target_file),
  ].filter(Boolean);

  if (normalized.type === "target_file_modified" && files.length === 0 && targets[0]?.file) {
    files.push(normalizeTargetPath(targets[0].file));
  }

  return new Set(files);
}

function suggestionForUnsupported(condition) {
  const normalized = normalizeCondition(condition);
  if (normalized.type === "test_file_passes") {
    return { ...condition, type: "tests_pass", params: { ...normalized.params } };
  }
  if (normalized.type === "type_errors_contain") {
    return { ...condition, type: "no_new_type_errors", severity: "WARN", params: { ...normalized.params } };
  }
  return null;
}

function addFinding(list, task, condition, code, detail, extra = {}) {
  list.push({
    task_id: task?.id || "UNKNOWN",
    condition_id: condition?.id || null,
    condition_type: condition?.type || null,
    severity: condition?.severity || "FAIL",
    code,
    detail,
    ...extra,
  });
}

export function inspectPrdContract(prd) {
  const failures = [];
  const warnings = [];
  const tasks = Array.isArray(prd?.tasks) ? prd.tasks : [];

  if (prd?.execution_mode === "planning_only") {
    failures.push({
      task_id: null,
      condition_id: null,
      condition_type: null,
      severity: "FAIL",
      code: "PLANNING_ONLY_PRD",
      detail: "planning_only PRD cannot be executed by runner",
    });
  }

  if (!tasks.length) {
    failures.push({
      task_id: null,
      condition_id: null,
      condition_type: null,
      severity: "FAIL",
      code: "NO_TASKS",
      detail: "PRD must contain at least one executable task",
    });
  }

  for (const task of tasks) {
    const targets = task?.scope?.targets || [];
    const postConditions = task?.post_conditions || [];

    if (!task?.id) {
      failures.push({
        task_id: null,
        condition_id: null,
        condition_type: null,
        severity: "FAIL",
        code: "TASK_MISSING_ID",
        detail: "task is missing id",
      });
      continue;
    }

    if (!targets.length && task.status === "pending") {
      addFinding(failures, task, null, "TASK_MISSING_TARGETS", "pending task must define scope.targets");
    }

    if (!postConditions.length && task.status === "pending") {
      addFinding(failures, task, null, "TASK_MISSING_POST_CONDITIONS", "pending task must define verifiable post_conditions");
    }

    if (task.status === "pending" && !postConditions.some(isExecutableFailGate)) {
      addFinding(
        failures,
        task,
        null,
        "TASK_MISSING_EXECUTABLE_FAIL_GATE",
        "pending task must define at least one executable FAIL post_condition; acceptance_criteria or WARN-only checks cannot block bad code",
        {
          suggestion: {
            post_condition_examples: [
              { id: "POST-FILE", type: "file_exists", severity: "FAIL", params: { file: targets[0]?.file || "src/path/to/file.ts" } },
              { id: "POST-TSC", type: "no_new_type_errors", severity: "FAIL", params: { command: "npm run typecheck" } },
              { id: "POST-TESTS", type: "tests_pass", severity: "FAIL", params: { command: "npm test" } },
            ],
          },
        },
      );
    }

    if (task.status === "pending" && targets.length > 0) {
      const coveredTargets = new Set();
      for (const condition of postConditions) {
        for (const file of conditionCoveredTargets(condition, targets)) {
          coveredTargets.add(normalizeTargetPath(file));
        }
      }

      const missingTargets = targets
        .map((target) => normalizeTargetPath(target.file))
        .filter(Boolean)
        .filter((file) => !coveredTargets.has(file));

      if (missingTargets.length > 0) {
        addFinding(
          failures,
          task,
          null,
          "TASK_TARGETS_MISSING_EXECUTABLE_COVERAGE",
          `pending task has scope targets without target-specific executable FAIL post_conditions: ${missingTargets.join(", ")}`,
          {
            missing_targets: missingTargets,
            suggestion: {
              post_condition_examples: missingTargets.map((file, index) => ({
                id: `POST-TARGET-${index + 1}`,
                type: "target_file_modified",
                severity: "FAIL",
                params: { file },
              })),
            },
          },
        );
      }
    }

    for (const condition of [...(task.pre_conditions || []), ...postConditions]) {
      const normalized = normalizeCondition(condition);
      if (!condition?.id) {
        addFinding(failures, task, condition, "CONDITION_MISSING_ID", "condition must have stable id");
      }
      if (!SUPPORTED_CONDITION_TYPES.has(normalized.type)) {
        addFinding(failures, task, condition, "UNSUPPORTED_CONDITION_TYPE", `condition type is not implemented by contract.js: ${normalized.type}`, {
          suggestion: suggestionForUnsupported(condition),
        });
      }
      if (normalized.severity === "FAIL" && normalized.type === "acceptance_criteria") {
        addFinding(warnings, task, condition, "MANUAL_FAIL_CONDITION", "acceptance_criteria is manual-review only; prefer executable condition for FAIL gates");
      }
    }
  }

  return {
    status: failures.length > 0 ? "fail" : warnings.length > 0 ? "warning" : "pass",
    blocks_execution: failures.length > 0,
    failure_count: failures.length,
    warning_count: warnings.length,
    failures,
    warnings,
  };
}

function readPrd(path) {
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) throw new Error(`PRD not found: ${path}`);
  return JSON.parse(readFileSync(resolved, "utf8"));
}

export function runPrdContractDoctorCli() {
  const prdArg = process.argv.find((arg) => arg.startsWith("--prd="));
  const json = process.argv.includes("--json");
  try {
    const prd = prdArg ? readPrd(prdArg.slice("--prd=".length)) : { version: "2.0", id: "PRD-CONTRACT-DOCTOR", tasks: [] };
    const result = inspectPrdContract(prd);
    console.log(json ? JSON.stringify(result, null, 2) : `[prd-contract-doctor] ${result.status} failures=${result.failure_count} warnings=${result.warning_count}`);
    process.exit(result.blocks_execution ? 1 : 0);
  } catch (error) {
    console.error(json ? JSON.stringify({ status: "error", error: error.message }, null, 2) : `[prd-contract-doctor] ${error.message}`);
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runPrdContractDoctorCli();
}
