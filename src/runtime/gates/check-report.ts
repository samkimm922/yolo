#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectDiscoveryReadiness } from "../../discovery/gate.js";
import { writeLifecycleStageReport } from "../../lifecycle/progress.js";
import { resolveProjectContext } from "../../packs/resolver.js";
import { preflightPrd } from "../../prd/preflight.js";
import { inspectAtomicTask } from "../execution/atomic-task-doctor.js";
import { buildGateRemediationPlan } from "./remediation-plan.js";
import {
  asArray,
  hasAcceptanceAdapter,
  hasEvidencePlan,
  hasStateMatrix,
  hasTaskAcceptance,
  selectedAcceptanceAdapter,
  summarizeTaskSurfaces,
  taskFiles,
  uiSurface,
  uiTasks,
} from "./readiness-policy.js";

export const YOLO_CHECK_REPORT_SCHEMA_VERSION = "1.0";
export const YOLO_CHECK_REPORT_SCHEMA = "yolo.check.report.v1";

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

function nowIso() {
  return new Date().toISOString();
}

function readPrd(prdPath) {
  const path = resolve(prdPath);
  return JSON.parse(readFileSync(path, "utf8"));
}

function severity(status) {
  if (status === "blocked") return 3;
  if (status === "warning") return 2;
  if (status === "pass") return 1;
  return 0;
}

function aggregateStatus(checks = []) {
  if (checks.some((check) => check.status === "blocked")) return "blocked";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "pass";
}

function checkRecord(name, status, summary, details = {}) {
  return {
    name,
    status,
    summary,
    ...details,
  };
}

function productReadiness({ prd, discovery }) {
  const blockers = [];
  const warnings = [];
  const tasks = asArray(prd.tasks);
  if (asArray(prd.requirements).length === 0) {
    blockers.push({ code: "PM_REQUIREMENTS_MISSING", message: "PRD must include at least one requirement." });
  }
  if (tasks.length === 0) {
    blockers.push({ code: "PM_TASKS_MISSING", message: "PRD must include at least one executable task." });
  }
  for (const task of tasks) {
    const files = taskFiles(task);
    if (files.length === 0) blockers.push({ code: "PM_TASK_SCOPE_MISSING", task_id: task.id || null, message: "Task must declare scope.targets." });
    if (!hasTaskAcceptance(task)) blockers.push({ code: "PM_TASK_ACCEPTANCE_MISSING", task_id: task.id || null, message: "Task must include acceptance criteria or post conditions." });
  }
  let discovery_readiness = null;
  if (discovery) {
    discovery_readiness = inspectDiscoveryReadiness(discovery);
    if (discovery_readiness.status === "blocked") {
      blockers.push(...discovery_readiness.blockers.map((blocker) => ({
        code: blocker.code,
        source: "discovery",
        message: blocker.message,
      })));
    }
    warnings.push(...discovery_readiness.warnings.map((warning) => ({
      code: warning.code,
      source: "discovery",
      message: warning.message,
    })));
  }
  const status = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "pass";
  return checkRecord("pm_readiness", status, status === "pass" ? "Product readiness passed." : "Product readiness has gaps.", {
    blockers,
    warnings,
    discovery_readiness,
  });
}

function demandContractReadiness({ prd }) {
  const blockers = [];
  const warnings = [];
  const demandRequired = prd?.demand_contract_required === true || prd?.source === "approved_demand";
  const demand = prd?.demand || null;
  const executionReadiness = prd?.execution_readiness || {};

  if (!demandRequired && !demand) {
    warnings.push({
      code: "DEMAND_CONTRACT_MISSING",
      message: "PRD has no approved demand source; legacy PRDs can continue, but new executable PRDs should be compiled from approved demand artifacts.",
    });
  }

  if (demandRequired) {
    if (!demand?.id) {
      blockers.push({ code: "DEMAND_SOURCE_MISSING", message: "Executable PRD must reference its approved demand session." });
    }
    if (demand?.approval?.approved !== true) {
      blockers.push({ code: "DEMAND_APPROVAL_MISSING", message: "Executable PRD must include explicit demand approval." });
    }
    if (executionReadiness.level !== "L3" || executionReadiness.afk_ready !== true) {
      blockers.push({ code: "DEMAND_NOT_L3_EXECUTABLE", message: "Executable PRD must declare L3 AFK-ready demand readiness." });
    }
    for (const requirement of asArray(prd.requirements)) {
      if (!requirement.demand_trace) {
        blockers.push({
          code: "REQUIREMENT_DEMAND_TRACE_MISSING",
          requirement_id: requirement.id || null,
          message: "Each requirement in an executable demand PRD must trace back to evidence or decisions.",
        });
      }
    }
  }

  const status = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "pass";
  return checkRecord("demand_contract", status, status === "pass" ? "Demand contract passed." : "Demand contract has gaps.", {
    blockers,
    warnings,
    demand_required: demandRequired,
    readiness_level: executionReadiness.level || null,
  });
}

function resolverReadiness({ resolver }) {
  const blockers = asArray(resolver?.blockers).map((blocker) => ({
    code: blocker.code || "RESOLVER_BLOCKED",
    message: blocker.message || "Resolver blocked project context.",
    manifest_id: blocker.manifest_id || null,
    path: blocker.path || null,
  }));
  const normalizedWarnings = asArray(resolver?.warnings).map((warning) => ({
    code: warning.code || "RESOLVER_WARNING",
    message: warning.message || "Resolver warning.",
    kind: warning.kind || null,
    manifest_id: warning.manifest_id || null,
  }));
  const warnings = normalizedWarnings.filter((warning) => warning.code !== "RESOLVER_UNKNOWN_CONTEXT");
  const advisories = normalizedWarnings.filter((warning) => warning.code === "RESOLVER_UNKNOWN_CONTEXT");
  const status = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "pass";
  return checkRecord("resolver_readiness", status, status === "pass" ? "Resolver context passed." : "Resolver context has gaps.", {
    blockers,
    warnings,
    advisories,
    selected_adapters: asArray(resolver?.selected_adapters).map((adapter) => ({
      id: adapter.id,
      kind: adapter.kind,
      status: adapter.status || "pass",
      source_path: adapter.source_path || "",
    })),
  });
}

function uiReadiness({ prd, acceptanceManifest, resolver }) {
  const blockers = [];
  const warnings = [];
  const tasks = uiTasks(prd, { acceptanceManifest, resolver });
  for (const task of tasks) {
    if (!uiSurface(task)) blockers.push({ code: "UI_SURFACE_MISSING", task_id: task.id || null, message: "UI task must identify a target surface." });
    if (!hasStateMatrix(task, prd, acceptanceManifest)) blockers.push({ code: "UI_STATE_MATRIX_MISSING", task_id: task.id || null, message: "UI task must include a state matrix before acceptance." });
    if (!hasEvidencePlan(task, prd, acceptanceManifest)) blockers.push({ code: "UI_EVIDENCE_PLAN_MISSING", task_id: task.id || null, message: "UI task must include screenshot/runtime/evidence plan." });
  }
  const status = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "pass";
  return checkRecord("ui_readiness", status, tasks.length ? "UI readiness inspected." : "No UI task detected.", {
    ui_task_count: tasks.length,
    blockers,
    warnings,
  });
}

function atomicityReadiness({ prd, projectRoot }) {
  const inspections = [];
  const blockers = [];
  const warnings = [];
  for (const task of asArray(prd.tasks)) {
    if (!task?.id) continue;
    const inspection = inspectAtomicTask(task, { root: projectRoot, writeEvidence: false });
    inspections.push(inspection);
    if (inspection.mode === "must_split") {
      blockers.push({ code: "ATOMICITY_MUST_SPLIT", task_id: task.id, message: "Task is too broad and must be split before execution.", score: inspection.score });
    } else if (inspection.mode === "investigate_then_patch") {
      warnings.push({ code: "ATOMICITY_INVESTIGATE_FIRST", task_id: task.id, message: "Task should force investigation before patching.", score: inspection.score });
    }
  }
  const status = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "pass";
  return checkRecord("atomicity", status, "Atomic task scoring completed.", {
    inspections,
    blockers,
    warnings,
  });
}

function adapterReadiness({ prd, acceptanceManifest, options, resolver }) {
  const uiTaskCount = uiTasks(prd, { acceptanceManifest, resolver }).length;
  const selectedAdapter = selectedAcceptanceAdapter(resolver);
  const adapterPresent = hasAcceptanceAdapter({ options, manifest: acceptanceManifest, resolver });
  if (uiTaskCount > 0 && !adapterPresent) {
    return checkRecord("adapter_readiness", "blocked", "UI acceptance requires an adapter manifest.", {
      blockers: [{ code: "ADAPTER_UI_ACCEPTANCE_MISSING", message: "UI tasks need an acceptance adapter before execution." }],
      warnings: [],
      ui_task_count: uiTaskCount,
      adapter_present: false,
      resolver_status: resolver?.status || "unknown",
    });
  }
  if (!adapterPresent) {
    return checkRecord("adapter_readiness", "warning", "No adapter manifest found; continuing for non-UI tasks.", {
      blockers: [],
      warnings: [{ code: "ADAPTER_MANIFEST_MISSING", message: "Adapter manifest is missing; non-UI tasks may continue with a warning." }],
      ui_task_count: uiTaskCount,
      adapter_present: false,
      resolver_status: resolver?.status || "unknown",
    });
  }
  return checkRecord("adapter_readiness", "pass", "Adapter readiness passed.", {
    blockers: [],
    warnings: [],
    ui_task_count: uiTaskCount,
    adapter_present: true,
    adapter_id: selectedAdapter?.id || options.acceptanceAdapter || options.acceptance_adapter || acceptanceManifest.acceptance_adapter || null,
    adapter_source: selectedAdapter?.source_path || "",
    resolver_status: resolver?.status || "unknown",
  });
}

function evidencePlanReadiness({ prd }) {
  const blockers = [];
  for (const task of asArray(prd.tasks)) {
    if (asArray(task.post_conditions).length === 0) {
      blockers.push({ code: "EVIDENCE_POST_CONDITIONS_MISSING", task_id: task.id || null, message: "Task must include executable post conditions for evidence." });
    }
  }
  const status = blockers.length > 0 ? "blocked" : "pass";
  return checkRecord("evidence_plan", status, status === "pass" ? "Evidence plan passed." : "Evidence plan is incomplete.", {
    blockers,
    warnings: [],
  });
}

function preflightReadiness(preflight) {
  const blockers = asArray(preflight.blocked_reasons).map((reason) => ({
    code: reason.code || "PRD_PREFLIGHT_BLOCKED",
    source: reason.source || "preflight",
    task_id: reason.task_id || null,
    message: reason.detail || reason.message || "PRD preflight blocked execution.",
  }));
  return checkRecord("prd_preflight", preflight.status === "blocked" ? "blocked" : preflight.status === "warning" ? "warning" : "pass", "PRD preflight completed.", {
    blockers,
    warnings: [],
    preflight,
  });
}

export function inspectYoloCheck(input = {}, options = {}) {
  const prdPath = input.prdPath || input.prd_path || options.prdPath || options.prd_path;
  if (!prdPath) {
    return {
      schema_version: YOLO_CHECK_REPORT_SCHEMA_VERSION,
      schema: YOLO_CHECK_REPORT_SCHEMA,
      status: "error",
      code: "MISSING_PRD_PATH",
      summary: "yolo check requires a PRD path.",
      checks: [],
      blockers: [{ code: "MISSING_PRD_PATH", message: "Pass a PRD path to run check." }],
      warnings: [],
      artifacts: [],
      next_actions: ["Pass a PRD path before running /yolo-check."],
    };
  }

  const resolvedPrdPath = resolve(prdPath);
  if (!existsSync(resolvedPrdPath)) {
    return {
      schema_version: YOLO_CHECK_REPORT_SCHEMA_VERSION,
      schema: YOLO_CHECK_REPORT_SCHEMA,
      status: "error",
      code: "PRD_NOT_FOUND",
      summary: `PRD not found: ${prdPath}`,
      checks: [],
      blockers: [{ code: "PRD_NOT_FOUND", message: `PRD not found: ${prdPath}` }],
      warnings: [],
      artifacts: [resolvedPrdPath],
      next_actions: ["Fix the PRD path or run /yolo-prd first."],
    };
  }

  const projectRoot = resolve(input.projectRoot || input.project_root || options.projectRoot || options.project_root || dirname(resolvedPrdPath));
  const stateRoot = resolve(input.stateRoot || input.state_root || options.stateRoot || options.state_root || `${projectRoot}/.yolo`);
  const acceptanceManifest = input.acceptanceManifest || input.acceptance_manifest || options.acceptanceManifest || options.acceptance_manifest || {};
  const discovery = input.discovery || input.discoveryBrief || input.discovery_brief || options.discovery || options.discoveryBrief || options.discovery_brief || null;
  const prd = readPrd(resolvedPrdPath);
  const preflight = preflightPrd(resolvedPrdPath);
  const surfaceSummary = summarizeTaskSurfaces(prd, { acceptanceManifest, resolver: input.resolver || options.resolver });
  const resolver = input.resolver || options.resolver || resolveProjectContext({
    projectRoot,
    stateRoot,
    requiresAcceptanceAdapter: surfaceSummary.ui_task_count > 0,
  });
  const checks = [
    preflightReadiness(preflight),
    demandContractReadiness({ prd }),
    productReadiness({ prd, discovery }),
    resolverReadiness({ resolver }),
    uiReadiness({ prd, acceptanceManifest, resolver }),
    atomicityReadiness({ prd, projectRoot }),
    adapterReadiness({ prd, acceptanceManifest, options: { ...options, ...input }, resolver }),
    evidencePlanReadiness({ prd }),
  ].sort((a, b) => severity(b.status) - severity(a.status));
  const status = aggregateStatus(checks);
  const blockers = checks.flatMap((check) => asArray(check.blockers).map((blocker) => ({ ...blocker, gate: check.name })));
  const warnings = checks.flatMap((check) => asArray(check.warnings).map((warning) => ({ ...warning, gate: check.name })));
  const remediationPlan = buildGateRemediationPlan({
    source: "yolo-check",
    blockers,
    warnings,
    summary: status === "blocked"
      ? "Strict check found remediation work; automation can continue only through the planned remediation route."
      : status === "warning"
        ? "Strict check passed with warnings; warnings are recorded but do not block automation."
        : "Strict check passed.",
  });
  const report = {
    schema_version: YOLO_CHECK_REPORT_SCHEMA_VERSION,
    schema: YOLO_CHECK_REPORT_SCHEMA,
    status,
    code: status === "blocked" ? "YOLO_CHECK_BLOCKED" : status === "warning" ? "YOLO_CHECK_WARNING" : "YOLO_CHECK_PASS",
    summary: status === "pass" ? "YOLO check passed; PRD is ready for gated execution." : status === "warning" ? "YOLO check passed with warnings." : "YOLO check blocked execution.",
    generated_at: nowIso(),
    prd_path: resolvedPrdPath,
    project_root: projectRoot,
    state_root: stateRoot,
    resolver,
    task_surface_summary: summarizeTaskSurfaces(prd, { acceptanceManifest, resolver }),
    checks,
    blockers,
    warnings,
    execution_policy: {
      gate_strength: "strict",
      remediation_mode: "non_blocking_when_schedulable",
      ship_gate: "fail_closed",
      automation_can_continue: remediationPlan.automation_can_continue,
    },
    remediation_plan: remediationPlan,
    artifacts: [resolvedPrdPath],
    next_actions: blockers.length > 0
      ? remediationPlan.next_actions
      : status === "warning"
        ? ["Review warnings, then continue only if the scope is still safe."]
        : ["Run /yolo-run only after user approval."],
  };

  if (input.writeLifecycle || input.write_lifecycle || options.writeLifecycle || options.write_lifecycle) {
    report.lifecycle_write = writeLifecycleStageReport("check", report, {
      projectRoot,
      stateRoot,
      source: "yolo-check",
      learnFailures: options.learnFailures === true || input.learnFailures === true,
    });
    report.artifacts.push(report.lifecycle_write.artifact_path);
  }

  return report;
}

export function formatYoloCheckText(report = {}) {
  const lines = [`[yolo check] ${report.status}: ${report.summary}`];
  if (report.code) lines.push(`code: ${report.code}`);
  if (report.prd_path) lines.push(`prd: ${report.prd_path}`);
  for (const check of report.checks || []) {
    lines.push(`- ${check.name}: ${check.status} (${check.summary})`);
  }
  if (report.blockers?.length) {
    lines.push("blockers:");
    for (const blocker of report.blockers.slice(0, 12)) {
      lines.push(`  - ${blocker.gate || blocker.source || "check"}:${blocker.code}${blocker.task_id ? ` task=${blocker.task_id}` : ""} ${blocker.message || ""}`.trim());
    }
  }
  if (report.remediation_plan) {
    lines.push(`remediation: ${report.remediation_plan.action} (${report.remediation_plan.status})`);
  }
  if (report.next_actions?.length) {
    lines.push("next:");
    for (const action of report.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function runYoloCheckCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const json = argv.includes("--json");
  const prdPath = argv.find((arg) => !arg.startsWith("--"));
  const writeLifecycle = !argv.includes("--no-write");
  const report = inspectYoloCheck({ prdPath, projectRoot: io.cwd || process.cwd(), writeLifecycle }, { learnFailures: true });
  if (json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else (report.status === "error" ? stderr : stdout).write(`${formatYoloCheckText(report)}\n`);
  return report.status === "blocked" || report.status === "error" ? 1 : 0;
}

if (isMain) {
  const code = runYoloCheckCli();
  process.exit(code);
}
