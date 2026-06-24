#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPrdContract } from "../runtime/gates/prd-contract-doctor.js";
import { createPrdMigrationAdvice, findPrdFiles } from "./migration.js";
import { inspectSpecGovernanceGate, specGovernancePolicy } from "../runtime/gates/spec-governance-gate.js";
import { validatePrdObject, validatePrdPath } from "./validate.js";
import { asRecord, errorMessage, isRecord, type PrdDocument, type PrdTask, type UnknownRecord } from "./condition-catalog.js";


const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

type PreflightOptions = UnknownRecord & {
  checkAll?: boolean;
  dirs?: string[];
  executionMode?: string;
  execution_mode?: string;
  file?: string;
  json?: boolean;
  mode?: string;
  prdPath?: string;
  prd_path?: string;
  projectRoot?: string;
  project_root?: string;
  requireDemandContract?: boolean;
  require_demand_contract?: boolean;
  schemaOptions?: UnknownRecord;
  specGovernance?: UnknownRecord;
  strictExecution?: boolean;
  strictWarnings?: boolean;
  strict_execution?: boolean;
};

type ReadPrdResult = {
  ok: boolean;
  file: string;
  prd?: unknown;
  error?: string;
};

type NormalizedWarning = {
  source: string;
  code: string;
  detail: string;
  message: string;
  task_id?: unknown;
  condition_id?: unknown;
  condition_type?: unknown;
  severity?: unknown;
  human_needed?: unknown;
};

type BlockedReason = {
  source: string;
  code: string;
  detail: string;
  message?: string;
  summary?: unknown;
  task_id?: unknown;
  condition_id?: unknown;
  warning_source?: unknown;
  human_needed?: boolean;
};

type TaskStats = {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  blocked: number;
  by_status: Record<string, number>;
  [statusKey: string]: number | Record<string, number>;
};

type RunnerReadiness = {
  can_execute: boolean;
  reason: string;
  execution_mode: unknown;
  tasks: TaskStats;
  next_actions: string[];
};

type WarningCarrier = UnknownRecord & {
  warnings?: unknown[];
};

type PreflightResult = UnknownRecord & {
  status: string;
  ok: boolean;
  generated_at: string;
  file: string;
  schema: WarningCarrier;
  contract: WarningCarrier | null;
  spec_governance: WarningCarrier | null;
  migration: UnknownRecord | null;
  runner_readiness: RunnerReadiness;
  blocked_count: number;
  warning_count: number;
  advisory_warning_count: number;
  blocking_warning_count: number;
  warnings: NormalizedWarning[];
  advisory_warnings: NormalizedWarning[];
  blocking_warnings: NormalizedWarning[];
  blocked_reasons: BlockedReason[];
};

type PreflightAllResult = {
  status: string;
  code?: string;
  generated_at: string;
  file_count: number;
  pass_count: number;
  warning_count: number;
  blocked_count: number;
  advisory_warning_count: number;
  blocking_warning_count: number;
  blocked_reasons?: BlockedReason[];
  results: PreflightResult[];
};

type ReadinessInput = {
  read: ReadPrdResult;
  schema: unknown;
  contract: unknown;
  migration: unknown;
  specGovernance: unknown;
  blockedReasons: BlockedReason[];
  blockingWarnings?: NormalizedWarning[];
};


function nowIso() {
  return new Date().toISOString();
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null || value === "") return [];
  return [value];
}

function preflightMode(options: PreflightOptions = {}): string {
  return clean(options.mode || options.executionMode || options.execution_mode || "verify").toLowerCase();
}



function schemaWarningCode(warning: unknown): string {
  const text = clean(warning);
  if (/ajv/i.test(text)) return "PRD_SCHEMA_VALIDATOR_SKIPPED";
  if (/未知条件类型/.test(text)) return "PRD_SCHEMA_UNKNOWN_CONDITION_TYPE";
  if (/ID 格式/.test(text)) return "PRD_SCHEMA_TASK_ID_FORMAT";
  if (/priority/.test(text)) return "PRD_SCHEMA_PRIORITY_FORMAT";
  return "PRD_SCHEMA_WARNING";
}

function normalizeWarning(source: string, warning: unknown): NormalizedWarning {
  if (typeof warning === "string") {
    return {
      source,
      code: source === "schema" ? schemaWarningCode(warning) : `${source.toUpperCase()}_WARNING`,
      detail: warning,
      message: warning,
    };
  }
  const warningRecord = asRecord(warning);
  {
    const warning = warningRecord;
    return {
      source,
      code: clean(warning.code || `${source.toUpperCase()}_WARNING`),
      detail: clean(warning.detail || warning.message || "PRD preflight warning."),
      message: clean(warning.message || warning.detail || "PRD preflight warning."),
      task_id: warning.task_id || null,
      condition_id: warning.condition_id || null,
      condition_type: warning.condition_type || null,
      severity: warning.severity || "WARN",
      human_needed: warning.human_needed || undefined,
    };
  }
}

function collectWarnings({ schema, contract, specGovernance }: { schema: unknown; contract: unknown; specGovernance: unknown }): NormalizedWarning[] {
  const schemaRecord = asRecord(schema);
  const contractRecord = asRecord(contract);
  const specGovernanceRecord = asRecord(specGovernance);
  return [
    ...asArray(schemaRecord.warnings).map((warning) => normalizeWarning("schema", warning)),
    ...asArray(contractRecord.warnings).map((warning) => normalizeWarning("contract", warning)),
    ...asArray(specGovernanceRecord.warnings).map((entry) => normalizeWarning("spec", entry)),
  ];
}

function warningBlockedReason(warning: NormalizedWarning): BlockedReason {
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

function readPrd(path: string): ReadPrdResult {
  const resolved = resolve(process.cwd(), path);
  if (!existsSync(resolved)) {
    return { ok: false, file: resolved, error: `PRD not found: ${path}` };
  }
  try {
    return {
      ok: true,
      file: resolved,
      prd: JSON.parse(readFileSync(resolved, "utf8")) as unknown,
    };
  } catch (error) {
    return { ok: false, file: resolved, error: `PRD JSON parse failed: ${errorMessage(error)}` };
  }
}

function taskStats(prd: unknown): TaskStats {
  const prdRecord = asRecord(prd);
  const tasks = Array.isArray(prdRecord.tasks) ? prdRecord.tasks as PrdTask[] : [];
  const byStatus: Record<string, number> = {};
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

function schemaBlockedReason(schema: unknown): BlockedReason | null {
  const schemaRecord = asRecord(schema);
  if (schemaRecord.ok) return null;
  return {
    source: "schema",
    code: "PRD_SCHEMA_FAILED",
    detail: clean(schemaRecord.error || "PRD schema validation failed"),
    summary: schemaRecord.summary || null,
  };
}

function contractBlockedReasons(contract: unknown): BlockedReason[] {
  const contractRecord = asRecord(contract);
  if (!contractRecord.blocks_execution) return [];
  return asArray(contractRecord.failures).map((failure) => {
    const failureRecord = asRecord(failure);
    return {
    source: "contract",
      code: clean(failureRecord.code || "PRD_CONTRACT_FAILURE"),
      detail: clean(failureRecord.detail),
      task_id: failureRecord.task_id || null,
      condition_id: failureRecord.condition_id || null,
    };
  });
}

function specBlockedReasons(specGovernance: unknown): BlockedReason[] {
  const specRecord = asRecord(specGovernance);
  if (!specRecord.blocks_execution) return [];
  return asArray(specRecord.blockers).map((blocker) => {
    const blockerRecord = asRecord(blocker);
    return {
    source: "spec",
      code: clean(blockerRecord.code || "SPEC_GOVERNANCE_FAILURE"),
      detail: clean(blockerRecord.message),
      task_id: blockerRecord.task_id || null,
    };
  });
}

function nextActions({ read, schema, contract, migration, specGovernance, blockingWarnings = [] }: Omit<ReadinessInput, "blockedReasons">) {
  const actions: string[] = [];
  const schemaRecord = asRecord(schema);
  const contractRecord = asRecord(contract);
  const migrationRecord = asRecord(migration);
  const specGovernanceRecord = asRecord(specGovernance);
  if (!read.ok) {
    actions.push("Fix the PRD file path or JSON syntax before running YOLO.");
    return actions;
  }
  if (!schemaRecord.ok) {
    actions.push("Fix PRD schema errors before running YOLO.");
  }
  if (contractRecord.blocks_execution) {
    if (Array.isArray(migrationRecord.next_actions) && migrationRecord.next_actions.length) actions.push(...migrationRecord.next_actions.map(String));
    else actions.push("Fix PRD contract failures before running YOLO.");
  }
  if (specGovernanceRecord.blocks_execution) {
    actions.push("Add requirement_ids, design_ids, and terminal evidence trace before running YOLO.");
  }
  if (blockingWarnings.length > 0) {
    actions.push("Resolve or explicitly approve blocking PRD warnings before running YOLO.");
  }
  if (schemaRecord.ok && !contractRecord.blocks_execution && !specGovernanceRecord.blocks_execution && blockingWarnings.length === 0) {
    actions.push("PRD preflight passed; runner can start.");
  }
  return [...new Set(actions)];
}

function buildRunnerReadiness({ read, schema, contract, migration, specGovernance, blockedReasons, blockingWarnings = [] }: ReadinessInput): RunnerReadiness {
  const stats = read.ok ? taskStats(read.prd) : taskStats(null);
  const canExecute = blockedReasons.length === 0;
  const prdRecord = asRecord(read.prd);
  return {
    can_execute: canExecute,
    reason: canExecute ? "ready" : "blocked",
    execution_mode: read.ok ? prdRecord.execution_mode || "default" : null,
    tasks: stats,
    next_actions: nextActions({ read, schema, contract, migration, specGovernance, blockingWarnings }),
  };
}

export function defaultSpecGovernancePolicy(options: PreflightOptions = {}) {
  return specGovernancePolicy(options);
}

function inspectPreflightReadiness(read: ReadPrdResult, schema: unknown, options: PreflightOptions = {}): PreflightResult {
  const schemaRecord = asRecord(schema);
  let contract: UnknownRecord | null = null;
  let migration: UnknownRecord | null = null;
  let specGovernance: UnknownRecord | null = null;

  // The PRD JSON parsed (read.ok), but contract/migration/spec evaluation
  // assume read.prd is a plain object. A valid-JSON but non-object value
  // (null, an array, or a scalar) would crash those evaluators; the schema
  // check above already marks such input as PRD_SCHEMA_FAILED, so omit the
  // downstream evaluators entirely for non-object values only. (Contract/spec
  // still run for plain-object PRDs that fail schema — they produce the
  // specific blockers like TASK_MISSING_FILES that downstream tests rely on,
  // and are hardened against malformed array fields separately.)
  const prdIsPlainObject = read.ok && read.prd && typeof read.prd === "object" && !Array.isArray(read.prd);
  if (prdIsPlainObject) {
    const requireDemandContract = options.requireDemandContract ?? options.require_demand_contract ?? true;
    const strictExecution = options.strictExecution ?? options.strict_execution ?? true;
    const inspectedContract = inspectPrdContract(read.prd as PrdDocument, {
      mode: options.mode || options.executionMode || options.execution_mode || "verify",
      strictExecution,
      requireDemandContract,
      projectRoot: options.projectRoot || options.project_root || dirname(read.file),
    });
    contract = isRecord(inspectedContract) ? inspectedContract : null;
    const migrationAdvice = createPrdMigrationAdvice(read.prd as PrdDocument, read.file);
    migration = isRecord(migrationAdvice) ? migrationAdvice : null;
    const specInspection = asRecord(inspectSpecGovernanceGate({
      prd: read.prd as PrdDocument,
      policyOptions: options.specGovernance || {},
    }));
    specGovernance = isRecord(specInspection.result) ? specInspection.result : null;
  }

  const warnings = collectWarnings({ schema: schemaRecord, contract, specGovernance });
  const blockedReasons = [
    schemaBlockedReason(schemaRecord),
    ...contractBlockedReasons(contract),
    ...specBlockedReasons(specGovernance),
    ...warnings.map(warningBlockedReason),
  ].filter((reason): reason is BlockedReason => Boolean(reason));
  const warningCount = warnings.length;
  const runnerReadiness = buildRunnerReadiness({ read, schema: schemaRecord, contract, migration, specGovernance, blockedReasons, blockingWarnings: warnings });

  return {
    status: blockedReasons.length > 0 ? "blocked" : warningCount > 0 ? "warning" : "pass",
    ok: runnerReadiness.can_execute,
    generated_at: nowIso(),
    file: read.file,
    schema: schemaRecord,
    contract,
    spec_governance: specGovernance,
    migration,
    runner_readiness: runnerReadiness,
    blocked_count: blockedReasons.length,
    warning_count: warningCount,
    advisory_warning_count: 0,
    blocking_warning_count: warningCount,
    warnings,
    advisory_warnings: [],
    blocking_warnings: warnings,
    warning_policy: {
      mode: preflightMode(options),
      fail_closed: true,
      advisory_warning_count: 0,
      blocking_warning_count: warningCount,
    },
    blocked_reasons: blockedReasons,
  };
}

export function preflightPrdDocument(prd: PrdDocument, options: PreflightOptions = {}) {
  const file = options.file || options.prdPath || options.prd_path || "<memory>";
  const read = {
    ok: true,
    file,
    prd,
  };
  const schema = validatePrdObject(prd, options.schemaOptions || {});
  return inspectPreflightReadiness(read, schema, options);
}

export function preflightPrd(prdPath: string, options: PreflightOptions = {}) {
  const read = readPrd(prdPath);
  const schema = validatePrdPath(prdPath, options.schemaOptions || {});
  return inspectPreflightReadiness(read, schema, options);
}

export function preflightAllPrds(options: PreflightOptions = {}): PreflightAllResult {
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

function printSingle(result: PreflightResult) {
  const schema = asRecord(result.schema);
  const contract = asRecord(result.contract);
  const specGovernance = asRecord(result.spec_governance);
  console.log(`[prd-preflight] ${result.status} file=${result.file}`);
  console.log(`  schema=${schema.ok ? "pass" : "fail"} contract=${contract.status || "unknown"} spec=${specGovernance.status || "unknown"} can_execute=${result.runner_readiness.can_execute}`);
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

function printAll(result: PreflightAllResult) {
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

function parseCliArgs(argv: string[] = process.argv.slice(2)): { options: PreflightOptions; fileArg: string } {
  const options: PreflightOptions = { mode: "verify" };
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
    const payload = { status: "error", error: errorMessage(error) };
    if (json) console.error(JSON.stringify(payload, null, 2));
    else console.error(`[prd-preflight] ${errorMessage(error)}`);
    process.exit(1);
  }
}

if (isMain) main();
