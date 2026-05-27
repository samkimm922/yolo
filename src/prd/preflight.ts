#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPrdContract } from "../runtime/gates/prd-contract-doctor.js";
import { createPrdMigrationAdvice, findPrdFiles } from "./migration.js";
import { inspectSpecGovernanceGate, specGovernancePolicy } from "../runtime/gates/spec-governance-gate.js";
import { validatePrdPath } from "./validate.js";

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

function nowIso() {
  return new Date().toISOString();
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

function nextActions({ read, schema, contract, migration, specGovernance }) {
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
  if (schema?.ok && !contract?.blocks_execution && !specGovernance?.blocks_execution) {
    actions.push("PRD preflight passed; runner can start.");
  }
  return [...new Set(actions)];
}

function buildRunnerReadiness({ read, schema, contract, migration, specGovernance, blockedReasons }) {
  const stats = read.ok ? taskStats(read.prd) : taskStats(null);
  const canExecute = blockedReasons.length === 0;
  return {
    can_execute: canExecute,
    reason: canExecute ? "ready" : "blocked",
    execution_mode: read.ok ? read.prd?.execution_mode || "default" : null,
    tasks: stats,
    next_actions: nextActions({ read, schema, contract, migration, specGovernance }),
  };
}

export function defaultSpecGovernancePolicy(options = {}) {
  return specGovernancePolicy(options);
}

export function preflightPrd(prdPath, options = {}) {
  const read = readPrd(prdPath);
  const schema = validatePrdPath(prdPath, options.schemaOptions || {});
  let contract = null;
  let migration = null;
  let specGovernance = null;

  if (read.ok) {
    contract = inspectPrdContract(read.prd);
    migration = createPrdMigrationAdvice(read.prd, prdPath);
    specGovernance = inspectSpecGovernanceGate({
      prd: read.prd,
      policyOptions: options.specGovernance || {},
    }).result;
  }

  const blockedReasons = [
    schemaBlockedReason(schema),
    ...contractBlockedReasons(contract),
    ...specBlockedReasons(specGovernance),
  ].filter(Boolean);
  const warningCount = (schema?.warnings?.length || 0) + (contract?.warning_count || 0) + (specGovernance?.warnings?.length || 0);
  const runnerReadiness = buildRunnerReadiness({ read, schema, contract, migration, specGovernance, blockedReasons });

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
    blocked_reasons: blockedReasons,
  };
}

export function preflightAllPrds(options = {}) {
  const files = findPrdFiles(options.dirs);
  const results = files.map((file) => preflightPrd(file, options));
  return {
    status: results.some((result) => result.status === "blocked") ? "blocked" : results.some((result) => result.status === "warning") ? "warning" : "pass",
    generated_at: nowIso(),
    file_count: results.length,
    pass_count: results.filter((result) => result.status === "pass").length,
    warning_count: results.filter((result) => result.status === "warning").length,
    blocked_count: results.filter((result) => result.status === "blocked").length,
    results,
  };
}

function usage() {
  return [
    "用法:",
    "  yolo-prd-preflight <prd.json> [--json]",
    "  yolo-prd-preflight --check-all [--json]",
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
  for (const action of result.runner_readiness.next_actions) {
    console.log(`  next: ${action}`);
  }
}

function printAll(result) {
  console.log(`[prd-preflight] ${result.status} files=${result.file_count} pass=${result.pass_count} warning=${result.warning_count} blocked=${result.blocked_count}`);
  for (const item of result.results.filter((entry) => entry.status !== "pass")) {
    console.log(`  ${item.status} ${item.file}`);
    for (const reason of item.blocked_reasons.slice(0, 3)) {
      console.log(`    ${reason.source}:${reason.code}${reason.task_id ? ` task=${reason.task_id}` : ""}`);
    }
  }
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const checkAll = args.includes("--check-all");
  const fileArg = args.find((arg) => !arg.startsWith("--"));

  try {
    if (checkAll) {
      const result = preflightAllPrds();
      if (json) console.log(JSON.stringify(result, null, 2));
      else printAll(result);
      process.exit(result.status === "blocked" ? 1 : 0);
    }

    if (!fileArg) {
      console.error(usage());
      process.exit(2);
    }

    const result = preflightPrd(fileArg);
    if (json) console.log(JSON.stringify(result, null, 2));
    else printSingle(result);
    process.exit(result.status === "blocked" ? 1 : 0);
  } catch (error) {
    const payload = { status: "error", error: error.message };
    if (json) console.error(JSON.stringify(payload, null, 2));
    else console.error(`[prd-preflight] ${error.message}`);
    process.exit(2);
  }
}

if (isMain) main();
