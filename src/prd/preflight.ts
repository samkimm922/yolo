#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPrdContract } from "../runtime/gates/prd-contract-doctor.js";
import { createPrdMigrationAdvice, findPrdFiles } from "./migration.js";
import { inspectSpecGovernanceGate, specGovernancePolicy } from "../runtime/gates/spec-governance-gate.js";
import { validatePrdObject, validatePrdPath } from "./validate.js";

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
const STRICT_WARNING_MODES = new Set(["verify", "runner", "release", "strict", "ship"]);

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null || value === "") return [];
  return [value];
}

function preflightMode(options = {}) {
  return clean(options.mode || options.executionMode || options.execution_mode || "verify").toLowerCase();
}

function strictWarningPolicy(options = {}) {
  if (options.failClosedWarnings === false || options.fail_closed_warnings === false) return false;
  if (options.strictWarnings === true || options.strict_warnings === true) return true;
  if (options.strictExecution === true || options.strict_execution === true) return true;
  return STRICT_WARNING_MODES.has(preflightMode(options));
}

function schemaWarningCode(warning) {
  const text = clean(warning);
  if (/ajv/i.test(text)) return "PRD_SCHEMA_VALIDATOR_SKIPPED";
  if (/未知条件类型/.test(text)) return "PRD_SCHEMA_UNKNOWN_CONDITION_TYPE";
  if (/ID 格式/.test(text)) return "PRD_SCHEMA_TASK_ID_FORMAT";
  if (/priority/.test(text)) return "PRD_SCHEMA_PRIORITY_FORMAT";
  return "PRD_SCHEMA_WARNING";
}

function normalizeWarning(source, warning) {
  if (typeof warning === "string") {
    return {
      source,
      code: source === "schema" ? schemaWarningCode(warning) : `${source.toUpperCase()}_WARNING`,
      detail: warning,
      message: warning,
    };
  }
  return {
    source,
    code: warning?.code || `${source.toUpperCase()}_WARNING`,
    detail: warning?.detail || warning?.message || "PRD preflight warning.",
    message: warning?.message || warning?.detail || "PRD preflight warning.",
    task_id: warning?.task_id || null,
    condition_id: warning?.condition_id || null,
    condition_type: warning?.condition_type || null,
    severity: warning?.severity || "WARN",
    human_needed: warning?.human_needed || undefined,
  };
}

function collectWarnings({ schema, contract, specGovernance }) {
  return [
    ...asArray(schema?.warnings).map((warning) => normalizeWarning("schema", warning)),
    ...asArray(contract?.warnings).map((warning) => normalizeWarning("contract", warning)),
    ...asArray(specGovernance?.warnings).map((warning) => normalizeWarning("spec", warning)),
  ];
}

function warningBlockedReason(warning) {
  return {
    source: "warning_policy",
    code: warning.code || "PRD_PREFLIGHT_WARNING",
    detail: warning.detail || warning.message || "PRD preflight warning blocks strict verification.",
    message: warning.message || warning.detail || "PRD preflight warning blocks strict verification.",
    warning_source: warning.source || null,
    task_id: warning.task_id || null,
    condition_id: warning.condition_id || null,
    human_needed: true,
  };
}

function readPrd(path) {
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) {
    return { ok: false, file: resolved, error: `PRD not found: ${path}` };
  }
  try {
    return {
      ok: true,
      file: resolved,
      prd: JSON.parse(readFileSync(resolved, "utf8")),
    };
  } catch (error) {
    return { ok: false, file: resolved, error: `PRD JSON parse failed: ${error.message}` };
  }
}

function taskStats(prd) {
  const tasks = Array.isArray(prd?.tasks) ? prd.tasks : [];
  const byStatus = {};
  for (const task of tasks) {
    const status = task?.status || "unknown";
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return {
    total: tasks.length,
    pending: byStatus.pending || 0,
    running: byStatus.running || 0,
    completed: (byStatus.completed || 0) + (byStatus.done || 0),
    failed: byStatus.failed || 0,
    blocked: byStatus.blocked || 0,
    skipped: byStatus.skipped || 0,
    by_status: byStatus,
  };
}

function schemaBlockedReason(schema) {
  if (schema?.ok) return null;
  return {
    source: "schema",
    code: "PRD_SCHEMA_FAILED",
    detail: schema?.error || "PRD schema validation failed",
    summary: schema?.summary || null,
  };
}

function contractBlockedReasons(contract) {
  if (!contract?.blocks_execution) return [];
  return (contract.failures || []).map((failure) => ({
    source: "contract",
    code: failure.code || "PRD_CONTRACT_FAILURE",
    detail: failure.detail,
    task_id: failure.task_id || null,
    condition_id: failure.condition_id || null,
  }));
}

function specBlockedReasons(specGovernance) {
  if (!specGovernance?.blocks_execution) return [];
  return (specGovernance.blockers || []).map((blocker) => ({
    source: "spec",
    code: blocker.code || "SPEC_GOVERNANCE_FAILURE",
    detail: blocker.message,
    task_id: blocker.task_id || null,
  }));
}

function nextActions({ read, schema, contract, migration, specGovernance, blockingWarnings = [] }) {
  const actions = [];
  if (!read.ok) {
    actions.push("Fix the PRD file path or JSON syntax before running YOLO.");
    return actions;
  }
  if (!schema?.ok) {
    actions.push("Fix PRD schema errors before running YOLO.");
  }
  if (contract?.blocks_execution) {
    if (migration?.next_actions?.length) actions.push(...migration.next_actions);
    else actions.push("Fix PRD contract failures before running YOLO.");
  }
  if (specGovernance?.blocks_execution) {
    actions.push("Add requirement_ids, design_ids, and terminal evidence trace before running YOLO.");
  }
  if (blockingWarnings.length > 0) {
    actions.push("Resolve or explicitly approve blocking PRD warnings before running YOLO.");
  }
  if (schema?.ok && !contract?.blocks_execution && !specGovernance?.blocks_execution && blockingWarnings.length === 0) {
    actions.push("PRD preflight passed; runner can start.");
  }
  return [...new Set(actions)];
}

function buildRunnerReadiness({ read, schema, contract, migration, specGovernance, blockedReasons, blockingWarnings = [] }) {
  const stats = read.ok ? taskStats(read.prd) : taskStats(null);
  const canExecute = blockedReasons.length === 0;
  return {
    can_execute: canExecute,
    reason: canExecute ? "ready" : "blocked",
    execution_mode: read.ok ? read.prd?.execution_mode || "default" : null,
    tasks: stats,
    next_actions: nextActions({ read, schema, contract, migration, specGovernance, blockingWarnings }),
  };
}

export function defaultSpecGovernancePolicy(options = {}) {
  return specGovernancePolicy(options);
}

function inspectPreflightReadiness(read, schema, options = {}) {
  let contract = null;
  let migration = null;
  let specGovernance = null;

  if (read.ok) {
    const requireDemandContract = options.requireDemandContract ?? options.require_demand_contract ?? true;
    const strictExecution = options.strictExecution ?? options.strict_execution ?? true;
    contract = inspectPrdContract(read.prd, {
      mode: options.mode || options.executionMode || options.execution_mode || "verify",
      strictExecution,
      requireDemandContract,
      projectRoot: options.projectRoot || options.project_root || dirname(read.file),
    });
    migration = createPrdMigrationAdvice(read.prd, read.file);
    specGovernance = inspectSpecGovernanceGate({
      prd: read.prd,
      policyOptions: options.specGovernance || {},
    }).result;
  }

  const warnings = collectWarnings({ schema, contract, specGovernance });
  const failClosedWarnings = strictWarningPolicy(options);
  const advisoryWarnings = failClosedWarnings ? [] : warnings;
  const blockingWarnings = failClosedWarnings ? warnings : [];
  const blockedReasons = [
    schemaBlockedReason(schema),
    ...contractBlockedReasons(contract),
    ...specBlockedReasons(specGovernance),
    ...blockingWarnings.map(warningBlockedReason),
  ].filter(Boolean);
  const warningCount = warnings.length;
  const runnerReadiness = buildRunnerReadiness({ read, schema, contract, migration, specGovernance, blockedReasons, blockingWarnings });

  return {
    status: blockedReasons.length > 0 ? "blocked" : warningCount > 0 ? "warning" : "pass",
    ok: runnerReadiness.can_execute,
    generated_at: nowIso(),
    file: read.file,
    schema,
    contract,
    spec_governance: specGovernance,
    migration,
    runner_readiness: runnerReadiness,
    blocked_count: blockedReasons.length,
    warning_count: warningCount,
    advisory_warning_count: advisoryWarnings.length,
    blocking_warning_count: blockingWarnings.length,
    warnings,
    advisory_warnings: advisoryWarnings,
    blocking_warnings: blockingWarnings,
    warning_policy: {
      mode: preflightMode(options),
      fail_closed: failClosedWarnings,
      advisory_warning_count: advisoryWarnings.length,
      blocking_warning_count: blockingWarnings.length,
    },
    blocked_reasons: blockedReasons,
  };
}

export function preflightPrdDocument(prd, options = {}) {
  const file = options.file || options.prdPath || options.prd_path || "<memory>";
  const read = {
    ok: true,
    file,
    prd,
  };
  const schema = validatePrdObject(prd, options.schemaOptions || {});
  return inspectPreflightReadiness(read, schema, options);
}

export function preflightPrd(prdPath, options = {}) {
  const read = readPrd(prdPath);
  const schema = validatePrdPath(prdPath, options.schemaOptions || {});
  return inspectPreflightReadiness(read, schema, options);
}

export function preflightAllPrds(options = {}) {
  const files = findPrdFiles(options.dirs);
  const results = files.map((file) => preflightPrd(file, options));
  if (files.length === 0) {
    return {
      status: "blocked",
      code: "PRD_PREFLIGHT_NO_FILES",
      generated_at: nowIso(),
      file_count: 0,
      pass_count: 0,
      warning_count: 0,
      blocked_count: 1,
      advisory_warning_count: 0,
      blocking_warning_count: 0,
      blocked_reasons: [{
        source: "prd-preflight",
        code: "PRD_PREFLIGHT_NO_FILES",
        detail: "No PRD JSON files were found; preflight cannot pass without validating at least one PRD.",
      }],
      results,
    };
  }
  return {
    status: results.some((result) => result.status === "blocked") ? "blocked" : results.some((result) => result.status === "warning") ? "warning" : "pass",
    generated_at: nowIso(),
    file_count: results.length,
    pass_count: results.filter((result) => result.status === "pass").length,
    warning_count: results.filter((result) => result.status === "warning").length,
    blocked_count: results.filter((result) => result.status === "blocked").length,
    advisory_warning_count: results.reduce((sum, result) => sum + (result.advisory_warning_count || 0), 0),
    blocking_warning_count: results.reduce((sum, result) => sum + (result.blocking_warning_count || 0), 0),
    results,
  };
}

function usage() {
  return [
    "用法:",
    "  yolo-prd-preflight <prd.json> [--json] [--verify|--strict|--release]",
    "  yolo-prd-preflight --check-all [--json] [--verify|--strict|--release] [--dir <path>...]",
    "",
    "Preflight 会汇总 schema、contract、migration advice 和 runner readiness，不修改 PRD。",
  ].join("\n");
}

function printSingle(result) {
  console.log(`[prd-preflight] ${result.status} file=${result.file}`);
  console.log(`  schema=${result.schema?.ok ? "pass" : "fail"} contract=${result.contract?.status || "unknown"} spec=${result.spec_governance?.status || "unknown"} can_execute=${result.runner_readiness.can_execute}`);
  if (result.runner_readiness.tasks.total > 0) {
    const tasks = result.runner_readiness.tasks;
    console.log(`  tasks total=${tasks.total} pending=${tasks.pending} completed=${tasks.completed} blocked=${tasks.blocked} failed=${tasks.failed}`);
  }
  for (const reason of result.blocked_reasons.slice(0, 8)) {
    console.log(`  blocked ${reason.source}:${reason.code}${reason.task_id ? ` task=${reason.task_id}` : ""}: ${reason.detail}`);
  }
  for (const warning of result.advisory_warnings.slice(0, 8)) {
    console.log(`  advisory ${warning.source}:${warning.code}${warning.task_id ? ` task=${warning.task_id}` : ""}: ${warning.detail}`);
  }
  for (const action of result.runner_readiness.next_actions) {
    console.log(`  next: ${action}`);
  }
}

function printAll(result) {
  console.log(`[prd-preflight] ${result.status} files=${result.file_count} pass=${result.pass_count} warning=${result.warning_count} blocked=${result.blocked_count}`);
  for (const reason of (result.blocked_reasons || []).slice(0, 3)) {
    console.log(`  blocked ${reason.source}:${reason.code}: ${reason.detail}`);
  }
  for (const item of result.results.filter((entry) => entry.status !== "pass")) {
    console.log(`  ${item.status} ${item.file}`);
    for (const reason of item.blocked_reasons.slice(0, 3)) {
      console.log(`    ${reason.source}:${reason.code}${reason.task_id ? ` task=${reason.task_id}` : ""}`);
    }
  }
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const options = { mode: "verify" };
  let fileArg = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--check-all") options.checkAll = true;
    else if (arg === "--dir" || arg === "--dirs" || arg.startsWith("--dir=") || arg.startsWith("--dirs=")) {
      const value = arg.includes("=") ? arg.split("=").slice(1).join("=") : argv[++i];
      const dirs = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
      if (dirs.length > 0) options.dirs = [...(options.dirs || []), ...dirs];
    }
    else if (arg === "--strict") {
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
    } else if (arg === "--mode" || arg.startsWith("--mode=")) {
      const value = arg.includes("=") ? arg.split("=").slice(1).join("=") : argv[++i];
      options.mode = value || "verify";
    } else if (!arg.startsWith("--") && !fileArg) {
      fileArg = arg;
    }
  }
  return { options, fileArg };
}

function main() {
  const { options, fileArg } = parseCliArgs();
  const json = options.json;
  const checkAll = options.checkAll;

  try {
    if (checkAll) {
      const result = preflightAllPrds(options);
      if (json) console.log(JSON.stringify(result, null, 2));
      else printAll(result);
      process.exit(result.status === "pass" ? 0 : result.status === "warning" ? 2 : 1);
    }

    if (!fileArg) {
      console.error(usage());
      process.exit(2);
    }

    const result = preflightPrd(fileArg, options);
    if (json) console.log(JSON.stringify(result, null, 2));
    else printSingle(result);
    process.exit(result.status === "pass" ? 0 : result.status === "warning" ? 2 : 1);
  } catch (error) {
    const payload = { status: "error", error: error.message };
    if (json) console.error(JSON.stringify(payload, null, 2));
    else console.error(`[prd-preflight] ${error.message}`);
    process.exit(1);
  }
}

if (isMain) main();
