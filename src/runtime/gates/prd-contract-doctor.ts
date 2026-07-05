#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BEHAVIOR_VERIFICATION_CONDITION_TYPES as BEHAVIOR_VERIFICATION_CONDITION_TYPE_LIST,
  CONDITION_TYPES,
  MANUAL_ONLY_CONDITION_TYPES as MANUAL_ONLY_CONDITION_TYPE_LIST,
  TARGET_COVERAGE_CONDITION_TYPES as TARGET_COVERAGE_CONDITION_TYPE_LIST,
} from "../../prd/condition-catalog.js";
import { loadProjectToolchainConfig, resolveBuildCommand } from "../../lib/toolchain.js";
import { resolveWithinRoot } from "../../lib/security/path-guard.js";
import { inspectAtomicTask } from "../execution/atomic-task-doctor.js";
import { orderTasksByDependencies } from "../task-loop/expansion.js";
import { shouldInspectAtomicity } from "./readiness-policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPPORTED_CONDITION_TYPES = new Set(CONDITION_TYPES);
const MANUAL_ONLY_CONDITION_TYPES = new Set(MANUAL_ONLY_CONDITION_TYPE_LIST);
const BEHAVIOR_VERIFICATION_CONDITION_TYPES = new Set(BEHAVIOR_VERIFICATION_CONDITION_TYPE_LIST);
const TARGET_COVERAGE_CONDITION_TYPES = new Set(TARGET_COVERAGE_CONDITION_TYPE_LIST);

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

function collectPathValues(value, out = []) {
  if (!value) return out;
  if (typeof value === "string") {
    out.push(normalizeTargetPath(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathValues(item, out);
    return out;
  }
  if (typeof value === "object") {
    collectPathValues(value.file, out);
    collectPathValues(value.path, out);
  }
  return out;
}

function taskPathReferences(targets = [], postConditions = []) {
  const refs = targets
    .map((target) => normalizeTargetPath(target.file))
    .filter(Boolean)
    .map((file) => ({ file, source: "task_scope", condition: null }));
  for (const condition of postConditions) {
    const files = [
      ...collectPathValues(condition?.file),
      ...collectPathValues(condition?.path),
      ...collectPathValues(condition?.files),
      ...collectPathValues(condition?.params?.file),
      ...collectPathValues(condition?.params?.path),
      ...collectPathValues(condition?.params?.files),
    ].filter(Boolean);
    for (const file of files) refs.push({ file, source: "post_condition", condition });
  }
  return refs;
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

function manualAcceptanceDeclaration(value, condition = Object()) {
  const declarations = [
    value?.manual_acceptance,
    value?.manualAcceptance,
    value?.params?.manual_acceptance,
    value?.params?.manualAcceptance,
  ].flatMap(asArray).filter(Boolean);
  if (declarations.includes(true)) return true;
  const conditionId = cleanString(condition?.id);
  return declarations.some((declaration) => {
    if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) return false;
    const enabled = declaration.required === true || declaration.allowed === true || declaration.enabled === true;
    const evidenceType = cleanString(declaration.evidence_type || declaration.evidenceType || declaration.type).toLowerCase();
    const signed = declaration.signed_evidence_required === true || declaration.signedEvidenceRequired === true || declaration.signature_required === true;
    const criteria = asArray(declaration.condition_ids || declaration.conditionIds || declaration.conditions || declaration.criteria)
      .map(cleanString)
      .filter(Boolean);
    const matchesCondition = criteria.length === 0 || !conditionId || criteria.includes(conditionId);
    return enabled && matchesCondition && (evidenceType === "manual_acceptance" || signed);
  });
}

function hasExplicitManualAcceptance(prd, task, condition) {
  return manualAcceptanceDeclaration(condition, condition)
    || manualAcceptanceDeclaration(task, condition)
    || manualAcceptanceDeclaration(prd, condition);
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
  const tasks = Array.isArray(prd?.tasks) ? prd.tasks.filter((task) => task && typeof task === "object") : [];
  const taskIds = new Set(tasks.map((task) => task?.id).filter(Boolean));
  const duplicateTaskIds = [];
  const seenTaskIds = new Set();
  const strictExecution = strictExecutionPolicy(prd, options);
  const projectRoot = resolve(options.projectRoot || options.project_root || process.cwd());
  const buildConfig = loadProjectToolchainConfig(projectRoot, {
    config: options.config,
    configPath: options.configPath || options.config_path,
  });
  const typecheckCommand = resolveBuildCommand("type_check", buildConfig, projectRoot);
  const testCommand = resolveBuildCommand("test", buildConfig, projectRoot);
  const buildCommand = resolveBuildCommand("build", buildConfig, projectRoot);

  for (const task of tasks) {
    const id = cleanString(task?.id);
    if (!id) continue;
    if (seenTaskIds.has(id)) {
      if (!duplicateTaskIds.includes(id)) duplicateTaskIds.push(id);
    } else {
      seenTaskIds.add(id);
    }
  }

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
    for (const requirement of asArray(prd?.requirements)) {
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

  for (const id of duplicateTaskIds) {
    failures.push({
      task_id: id,
      condition_id: null,
      condition_type: null,
      severity: "FAIL",
      code: "TASK_DUPLICATE_ID",
      detail: `task id must be unique across PRD tasks: ${id}`,
      duplicate_id: id,
      human_needed: true,
    });
  }

  const dependencyPreflight = orderTasksByDependencies(tasks).preflight;
  if (dependencyPreflight?.blocks_execution) {
    for (const blocker of dependencyPreflight.blockers || []) {
      failures.push({
        task_id: blocker.task_id || null,
        task_ids: blocker.task_ids || [],
        condition_id: null,
        condition_type: null,
        severity: "FAIL",
        code: blocker.code || "TASK_DEPENDENCY_GRAPH_BLOCKED",
        detail: blocker.message || "task dependency graph blocks execution",
        source: blocker.source || "task-loop-expansion",
        human_needed: true,
      });
    }
  }

  for (const task of tasks) {
    const targets = normalizeTaskTargets(task);
    const postConditions = asArray(task?.post_conditions);

    for (const ref of taskPathReferences(targets, postConditions)) {
      const guarded = resolveWithinRoot(projectRoot, ref.file);
      if (!guarded.ok) {
        addFinding(
          failures,
          task,
          ref.condition,
          "TASK_TARGET_OUTSIDE_ROOT",
          `task target path must stay inside the project root: ${ref.file}`,
          {
            path: ref.file,
            source: ref.source,
            reason: guarded.reason || null,
            guard_detail: guarded.detail || null,
            human_needed: true,
          },
        );
      }
    }

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

    if (strictExecution && shouldInspectAtomicity(task, "contract")) {
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
        if (inspection.no_executable_remediation) {
          addFinding(
            warnings,
            task,
            null,
            "ATOMICITY_NO_SPLIT_SUGGESTIONS",
            "doctor 无法给出拆分建议，任务降级为先调查再执行",
            { atomicity: inspection, severity: "WARN" },
          );
        } else {
          addFinding(
            failures,
            task,
            null,
            "ATOMICITY_INVESTIGATE_FIRST",
            "runner/release task requires investigation before patching and cannot run as an automatic warning",
            { atomicity: inspection, human_needed: true },
          );
        }
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
              { id: "POST-TSC", type: "no_new_type_errors", severity: "FAIL", params: { command: typecheckCommand } },
              { id: "POST-TESTS", type: "tests_pass", severity: "FAIL", params: { command: testCommand } },
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
              { id: "POST-TESTS", type: "tests_pass", severity: "FAIL", params: { command: testCommand } },
              { id: "POST-BUILD", type: "build_pass", severity: "FAIL", params: { command: buildCommand } },
              { id: "POST-TYPECHECK", type: "no_new_type_errors", severity: "FAIL", params: { command: typecheckCommand } },
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

    for (const condition of [...asArray(task.pre_conditions), ...postConditions]) {
      const normalized = normalizeCondition(condition);
      if (!condition?.id) {
        addFinding(failures, task, condition, "CONDITION_MISSING_ID", "condition must have stable id");
      }
      if (!SUPPORTED_CONDITION_TYPES.has(normalized.type)) {
        addFinding(failures, task, condition, "UNSUPPORTED_CONDITION_TYPE", `condition type is not implemented by contract.js: ${normalized.type}`, {
          suggestion: suggestionForUnsupported(condition),
        });
      }
      if (normalized.type === "acceptance_criteria" && !conditionVerifyCommand(condition) && !hasExplicitManualAcceptance(prd, task, condition)) {
        addFinding(
          failures,
          task,
          condition,
          "MANUAL_FAIL_CONDITION",
          "acceptance_criteria without verify_command is manual-review only and will fail runner unless PRD declares manual_acceptance evidence",
          { human_needed: true },
        );
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
  // H10: bound PRD reads (8MiB) so a hostile/oversized PRD cannot OOM the doctor.
  const PRD_MAX_BYTES = 8 * 1024 * 1024;
  const size = statSync(resolved).size;
  if (size > PRD_MAX_BYTES) {
    throw new Error(`PRD exceeds ${PRD_MAX_BYTES} byte limit (${size} bytes): ${path}`);
  }
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
