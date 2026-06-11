#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectAtomicTask } from "../execution/atomic-task-doctor.js";

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

const BEHAVIOR_VERIFICATION_CONDITION_TYPES = new Set([
  "build_pass",
  "no_new_lint_errors",
  "no_new_type_errors",
  "test_file_passes",
  "tests_pass",
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

const STRICT_EXECUTION_MODES = new Set(["runner", "release"]);

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function strictExecutionPolicy(prd, options = Object()) {
  if (options.strictExecution === false || options.strict_execution === false) return false;
  if (options.requireDemandContract === false || options.require_demand_contract === false) return false;
  if (options.strictExecution === true || options.strict_execution === true) return true;
  if (options.requireDemandContract === true || options.require_demand_contract === true) return true;

  const mode = cleanString(options.mode || options.executionMode || options.execution_mode || "compatibility").toLowerCase();
  return STRICT_EXECUTION_MODES.has(mode) ||
    prd?.execution_readiness?.afk_ready === true ||
    prd?.execution_readiness?.level === "L3";
}

function taskDependencyIds(task = Object()) {
  return [...new Set([
    ...asArray(task.depends_on),
    ...asArray(task.dependencies),
  ].map(String).filter(Boolean))];
}

function normalizeTaskTargets(task = Object()) {
  const scopeTargets = asArray(task.scope?.targets)
    .map((target) => typeof target === "string" ? { file: target } : target)
    .filter((target) => cleanString(target?.file || target?.path || target).length > 0)
    .map((target) => ({
      ...target,
      file: target.file || target.path || target,
    }));
  if (scopeTargets.length > 0) return scopeTargets;
  return asArray(task.files)
    .map((file) => ({ file }))
    .filter((target) => cleanString(target.file).length > 0);
}

function hasTaskAcceptance(task = Object()) {
  return asArray(task.acceptance_criteria).length > 0 ||
    cleanString(task.acceptance).length > 0 ||
    cleanString(task.success_criteria).length > 0 ||
    asArray(task.post_conditions).length > 0;
}

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

function conditionVerifyCommand(condition = Object()) {
  return cleanString(condition.verify_command || condition.verifyCommand || condition.params?.verify_command || condition.params?.verifyCommand);
}

function isBehaviorVerificationGate(condition) {
  const normalized = normalizeCondition(condition);
  if (normalized.severity !== "FAIL" || !SUPPORTED_CONDITION_TYPES.has(normalized.type)) return false;
  if (BEHAVIOR_VERIFICATION_CONDITION_TYPES.has(normalized.type)) return true;
  return conditionVerifyCommand(condition).length > 0;
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

function addFinding(list, task, condition, code, detail, extra = Object()) {
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

export function inspectPrdContract(prd, options = Object()) {
  const failures = [];
  const warnings = [];
  const tasks = Array.isArray(prd?.tasks) ? prd.tasks : [];
  const taskIds = new Set(tasks.map((task) => task?.id).filter(Boolean));
  const strictExecution = strictExecutionPolicy(prd, options);
  const projectRoot = resolve(options.projectRoot || options.project_root || process.cwd());

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

  if (strictExecution || prd?.demand_contract_required === true || prd?.source === "approved_demand") {
    const demand = prd?.demand || null;
    if (!demand) {
      failures.push({
        task_id: null,
        condition_id: null,
        condition_type: null,
        severity: "FAIL",
        code: "DEMAND_CONTRACT_MISSING",
        detail: "runner/release PRDs must include an approved demand contract",
        human_needed: true,
      });
    } else if (!demand.id) {
      failures.push({
        task_id: null,
        condition_id: null,
        condition_type: null,
        severity: "FAIL",
        code: "DEMAND_SOURCE_MISSING",
        detail: "approved-demand PRD must reference demand.id",
      });
    }
    if (demand && demand.approval?.approved !== true) {
      failures.push({
        task_id: null,
        condition_id: null,
        condition_type: null,
        severity: "FAIL",
        code: "DEMAND_APPROVAL_MISSING",
        detail: "approved-demand PRD must include approved demand approval",
      });
    } else if (demand && demand.approval?.effective_for_prd !== true) {
      failures.push({
        task_id: null,
        condition_id: null,
        condition_type: null,
        severity: "FAIL",
        code: "DEMAND_APPROVAL_NOT_EFFECTIVE_FOR_PRD",
        detail: "approved-demand PRD approval must be explicitly effective for PRD execution",
        human_needed: true,
      });
    }
    if (prd?.execution_readiness?.level !== "L3" || prd?.execution_readiness?.afk_ready !== true) {
      failures.push({
        task_id: null,
        condition_id: null,
        condition_type: null,
        severity: "FAIL",
        code: "DEMAND_EXECUTION_READINESS_MISSING",
        detail: "approved-demand PRD must declare L3 AFK-ready execution readiness",
      });
    }
    const qualityReports = [
      prd?.execution_readiness?.quality_report,
      demand?.quality_report,
      demand?.execution_readiness?.quality_report,
    ].filter(Boolean);
    const qualityStatuses = [
      prd?.execution_readiness?.quality_status,
      demand?.execution_readiness?.quality_status,
      ...qualityReports.map((report) => report.status),
    ].filter(Boolean);
    if (qualityStatuses.includes("blocked")) {
      failures.push({
        task_id: null,
        condition_id: null,
        condition_type: null,
        severity: "FAIL",
        code: "DEMAND_QUALITY_BLOCKED",
        detail: "approved-demand PRD quality report must not be blocked",
      });
    } else if (qualityStatuses.includes("warning")) {
      (strictExecution ? failures : warnings).push({
        task_id: null,
        condition_id: null,
        condition_type: null,
        severity: strictExecution ? "FAIL" : "WARN",
        code: "DEMAND_QUALITY_WARNING",
        detail: strictExecution
          ? "runner/release PRD demand quality warnings require human review before execution"
          : "approved-demand PRD quality report has warnings",
        human_needed: strictExecution || undefined,
      });
    } else if (qualityReports.length === 0) {
      (strictExecution ? failures : warnings).push({
        task_id: null,
        condition_id: null,
        condition_type: null,
        severity: strictExecution ? "FAIL" : "WARN",
        code: "DEMAND_QUALITY_REPORT_MISSING",
        detail: strictExecution
          ? "runner/release PRD must include a demand quality report"
          : "approved-demand PRD should include demand quality report",
        human_needed: strictExecution || undefined,
      });
    }
    const projectFacts = demand?.project_facts || null;
    if (!projectFacts) {
      failures.push({
        task_id: null,
        condition_id: null,
        condition_type: null,
        severity: "FAIL",
        code: "DEMAND_PROJECT_FACTS_MISSING",
        detail: "runner/release PRD must include verified demand project facts",
        human_needed: true,
      });
    } else {
      const unresolvedTargetFacts = asArray(projectFacts.target_files)
        .filter((fact) => ["candidate", "needs_verification", "contradicted", "invalid_scope"].includes(fact?.status));
      const unresolvedAssumptions = asArray(projectFacts.assumptions)
        .filter((fact) => ["needs_verification", "contradicted"].includes(fact?.status));
      if (unresolvedTargetFacts.length > 0) {
        failures.push({
          task_id: null,
          condition_id: null,
          condition_type: null,
          severity: "FAIL",
          code: "DEMAND_PROJECT_TARGET_FACTS_UNRESOLVED",
          detail: "approved-demand PRD must not carry candidate, unverified, or contradicted target-file facts",
        });
      }
      if (unresolvedAssumptions.length > 0) {
        failures.push({
          task_id: null,
          condition_id: null,
          condition_type: null,
          severity: "FAIL",
          code: "DEMAND_PROJECT_ASSUMPTIONS_UNRESOLVED",
          detail: "approved-demand PRD must not carry unverified or contradicted project assumptions",
        });
      }
    }
    for (const requirement of asArray(prd.requirements)) {
      if (!requirement.demand_trace) {
        failures.push({
          task_id: null,
          condition_id: null,
          condition_type: null,
          severity: "FAIL",
          code: "REQUIREMENT_DEMAND_TRACE_MISSING",
          detail: "runner/release PRD requirements must trace back to demand evidence or decisions",
          requirement_id: requirement.id || null,
          human_needed: true,
        });
      }
    }
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
    const targets = normalizeTaskTargets(task);
    const postConditions = asArray(task?.post_conditions);

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

    for (const dependencyId of taskDependencyIds(task)) {
      if (!taskIds.has(dependencyId)) {
        addFinding(
          failures,
          task,
          null,
          "TASK_DEPENDENCY_MISSING",
          `task depends_on references missing task id: ${dependencyId}`,
          { dependency_id: dependencyId },
        );
      }
    }

    if (strictExecution && task.status === "pending") {
      const inspection = inspectAtomicTask(task, {
        root: projectRoot,
        projectRoot,
        writeEvidence: false,
      });
      if (inspection.mode === "must_split") {
        addFinding(
          failures,
          task,
          null,
          "ATOMICITY_MUST_SPLIT",
          "runner/release task is too broad and must be split before execution",
          { atomicity: inspection },
        );
      } else if (inspection.mode === "investigate_then_patch") {
        addFinding(
          failures,
          task,
          null,
          "ATOMICITY_INVESTIGATE_FIRST",
          "runner/release task requires investigation before patching and cannot run as an automatic warning",
          { atomicity: inspection, human_needed: true },
        );
      } else if (inspection.mode === "research_only") {
        addFinding(
          failures,
          task,
          null,
          "ATOMICITY_RESEARCH_ONLY",
          "runner/release task is research-only and cannot be patched by runner",
          { atomicity: inspection, human_needed: true },
        );
      }
    }

    if (!targets.length && task.status === "pending") {
      addFinding(
        failures,
        task,
        null,
        "TASK_MISSING_FILES",
        "pending task must define files through scope.targets or task.files",
        { human_needed: true },
      );
      addFinding(failures, task, null, "TASK_MISSING_TARGETS", "pending task must define scope.targets");
    }

    if (task.status === "pending" && !hasTaskAcceptance(task)) {
      addFinding(
        failures,
        task,
        null,
        "TASK_MISSING_ACCEPTANCE",
        "pending task must define acceptance criteria, success criteria, or post_conditions",
        { human_needed: true },
      );
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

    if (task.status === "pending" && !postConditions.some(isBehaviorVerificationGate)) {
      addFinding(
        failures,
        task,
        null,
        "TASK_MISSING_BEHAVIOR_VERIFICATION",
        "pending task must define at least one behavior verification gate: tests_pass, build_pass, no_new_type_errors, no_new_lint_errors, test_file_passes, or a FAIL condition with verify_command; file_exists and target_file_modified only prove target coverage",
        {
          suggestion: {
            post_condition_examples: [
              { id: "POST-TESTS", type: "tests_pass", severity: "FAIL", params: { command: "npm test" } },
              { id: "POST-BUILD", type: "build_pass", severity: "FAIL", params: { command: "npm run build" } },
              { id: "POST-TYPECHECK", type: "no_new_type_errors", severity: "FAIL", params: { command: "npm run typecheck" } },
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
      if (normalized.severity === "FAIL" && normalized.type === "acceptance_criteria" && !conditionVerifyCommand(condition)) {
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
