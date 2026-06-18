#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectStoryAtomicityFromPrd } from "../../demand/story-atomicity.js";
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

function prdJsonErrorReport({ prdPath, projectRoot, stateRoot, error, writeLifecycle, learnFailures }) {
  const resolvedPrdPath = resolve(prdPath);
  const report = Object.assign(Object(), {
    schema_version: YOLO_CHECK_REPORT_SCHEMA_VERSION,
    schema: YOLO_CHECK_REPORT_SCHEMA,
    status: "error",
    code: "PRD_JSON_INVALID",
    summary: "PRD JSON could not be parsed.",
    generated_at: nowIso(),
    prd_path: resolvedPrdPath,
    project_root: projectRoot,
    state_root: stateRoot,
    checks: [],
    blockers: [{
      code: "PRD_JSON_INVALID",
      message: error?.message || "PRD file is not valid JSON.",
      gate: "prd_parse",
    }],
    warnings: [],
    advisory_warnings: [],
    blocking_warnings: [],
    artifacts: [resolvedPrdPath],
    next_actions: ["Fix the PRD JSON syntax, then rerun /yolo-check."],
  });
  if (writeLifecycle) {
    report.lifecycle_write = writeLifecycleStageReport("check", report, {
      projectRoot,
      stateRoot,
      source: "yolo-check",
      learnFailures,
      skipSequenceCheck: true,
    });
    report.artifacts.push(report.lifecycle_write.artifact_path);
  }
  return report;
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

function checkExitCode(status) {
  if (status === "pass") return 0;
  if (status === "warning") return 2;
  return 1;
}

function checkRecord(name, status, summary, details = Object()) {
  return {
    name,
    status,
    summary,
    ...details,
  };
}

function cleanString(value) {
  return String(value ?? "").trim();
}

const STRICT_EXECUTION_MODES = new Set(["runner", "release", "strict"]);
const ADVISORY_WARNING_CODES = new Set([
  "ADAPTER_MANIFEST_MISSING",
  "RESOLVER_UNKNOWN_CONTEXT",
  "STORY_ATOMICITY_CAPABILITY_NOUN",
]);

function executionMode(input = Object(), options = Object()) {
  return cleanString(
    input.executionMode ||
    input.execution_mode ||
    input.mode ||
    options.executionMode ||
    options.execution_mode ||
    options.mode ||
    "runner",
  ).toLowerCase();
}

function strictExecutionPolicy({ prd, input = Object(), options = Object() } = Object()) {
  if (input.strictExecution === false || input.strict_execution === false || options.strictExecution === false || options.strict_execution === false) return false;
  if (input.requireDemandContract === false || input.require_demand_contract === false || options.requireDemandContract === false || options.require_demand_contract === false) return false;
  if (input.strictExecution === true || input.strict_execution === true || options.strictExecution === true || options.strict_execution === true) return true;
  if (input.requireDemandContract === true || input.require_demand_contract === true || options.requireDemandContract === true || options.require_demand_contract === true) return true;

  const mode = executionMode(input, options);
  return STRICT_EXECUTION_MODES.has(mode) ||
    prd?.execution_readiness?.afk_ready === true ||
    prd?.execution_readiness?.level === "L3";
}

function strictWarningPolicy({ strictExecution, mode }) {
  return strictExecution || STRICT_EXECUTION_MODES.has(cleanString(mode).toLowerCase());
}

function isAdvisoryWarning(warning = Object()) {
  return warning.advisory === true || ADVISORY_WARNING_CODES.has(warning.code);
}

function warningMessage(warning = Object()) {
  return warning.message || warning.detail || warning.summary || "Warning blocks strict execution.";
}

function warningBlocker(warning = Object(), check = Object()) {
  return {
    code: warning.code || "STRICT_WARNING",
    gate: check.name || warning.gate || "warning_policy",
    source: warning.source || check.name || "warning_policy",
    task_id: warning.task_id || null,
    message: warningMessage(warning),
    warning_policy: "execution_blocking",
    original_level: "warning",
    human_needed: true,
  };
}

function applyWarningPolicy(check = Object(), context = Object()) {
  const warnings = asArray(check.warnings);
  const existingAdvisories = asArray(check.advisories);
  const advisoryWarnings = [
    ...existingAdvisories,
    ...warnings.filter(isAdvisoryWarning).map((warning) => ({ ...warning, advisory: true })),
  ];
  const executionWarnings = warnings.filter((warning) => !isAdvisoryWarning(warning));
  const blockingWarnings = context.failClosed ? executionWarnings : [];
  const nextWarnings = context.failClosed ? [] : executionWarnings;
  const blockers = [
    ...asArray(check.blockers),
    ...blockingWarnings.map((warning) => warningBlocker(warning, check)),
  ];
  return {
    ...check,
    status: blockers.length > 0 ? "blocked" : nextWarnings.length > 0 ? "warning" : "pass",
    blockers,
    warnings: nextWarnings,
    advisories: advisoryWarnings,
    warning_policy: {
      fail_closed: context.failClosed,
      advisory_warning_count: advisoryWarnings.length,
      blocking_warning_count: blockingWarnings.length,
    },
  };
}

function pathInsideProject(projectRoot, file) {
  const root = resolve(projectRoot);
  const target = cleanString(file);
  if (!target) return false;
  const path = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const rel = relative(root, path);
  return Boolean(rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function collectPathValues(value, out = []) {
  if (!value) return out;
  if (typeof value === "string") {
    out.push(normalizeFileForContainment(value));
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

function normalizeFileForContainment(value) {
  return cleanString(value).replace(/\\/g, "/").replace(/^\.\//, "").replace(/:\d+(?:-\d+)?$/, "");
}

function taskPathReferences(task = Object()) {
  const refs = taskFiles(task).map((file) => ({ file, source: "task_scope", condition_id: null }));
  for (const condition of asArray(task.post_conditions)) {
    const files = [
      ...collectPathValues(condition?.file),
      ...collectPathValues(condition?.path),
      ...collectPathValues(condition?.files),
      ...collectPathValues(condition?.params?.file),
      ...collectPathValues(condition?.params?.path),
      ...collectPathValues(condition?.params?.files),
    ].filter(Boolean);
    for (const file of files) {
      refs.push({
        file,
        source: "post_condition",
        condition_id: condition?.id || null,
      });
    }
  }
  return refs;
}

function taskPathContainmentBlockers(task, projectRoot) {
  return taskPathReferences(task)
    .filter((ref) => !pathInsideProject(projectRoot, ref.file))
    .map((ref) => ({
      code: "TASK_TARGET_OUTSIDE_ROOT",
      task_id: task.id || null,
      condition_id: ref.condition_id || null,
      path: ref.file,
      source: ref.source,
      message: `Task target path must stay inside the project root: ${ref.file}`,
      human_needed: true,
    }));
}

function productReadiness({ prd, discovery, projectRoot }) {
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
    blockers.push(...taskPathContainmentBlockers(task, projectRoot));
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

function demandContractReadiness({ prd, projectRoot, strictExecution }) {
  const blockers = [];
  const warnings = [];
  const demandRequired = strictExecution || prd?.demand_contract_required === true || prd?.source === "approved_demand";
  const demand = prd?.demand || null;
  const executionReadiness = prd?.execution_readiness || {};
  const projectFacts = demand?.project_facts || null;

  if (!demandRequired && !demand) {
    warnings.push({
      code: "DEMAND_CONTRACT_MISSING",
      message: "PRD has no approved demand source; legacy PRDs can continue, but new executable PRDs should be compiled from approved demand artifacts.",
    });
  }

  if (demandRequired) {
    if (!demand) {
      blockers.push({
        code: "DEMAND_CONTRACT_MISSING",
        message: "Runner/release execution requires an approved demand contract.",
        human_needed: true,
      });
    } else if (!demand.id) {
      blockers.push({ code: "DEMAND_SOURCE_MISSING", message: "Executable PRD must reference its approved demand session." });
    }
    if (demand && demand.approval?.approved !== true) {
      blockers.push({ code: "DEMAND_APPROVAL_MISSING", message: "Executable PRD must include explicit demand approval." });
    } else if (demand && demand.approval?.effective_for_prd !== true) {
      blockers.push({
        code: "DEMAND_APPROVAL_NOT_EFFECTIVE_FOR_PRD",
        message: "Executable PRD demand approval must be explicitly effective for PRD execution.",
        human_needed: true,
      });
    }
    if (executionReadiness.level !== "L3" || executionReadiness.afk_ready !== true) {
      blockers.push({ code: "DEMAND_NOT_L3_EXECUTABLE", message: "Executable PRD must declare L3 AFK-ready demand readiness." });
    }
    const qualityReports = [
      executionReadiness.quality_report,
      demand?.quality_report,
      demand?.execution_readiness?.quality_report,
    ].filter(Boolean);
    const qualityStatuses = [
      executionReadiness.quality_status,
      demand?.execution_readiness?.quality_status,
      ...qualityReports.map((report) => report.status),
    ].filter(Boolean);
    if (qualityStatuses.includes("blocked")) {
      blockers.push({ code: "DEMAND_QUALITY_BLOCKED", message: "Executable PRD demand quality report must not be blocked." });
    } else if (qualityStatuses.includes("warning")) {
      (strictExecution ? blockers : warnings).push({
        code: "DEMAND_QUALITY_WARNING",
        message: strictExecution
          ? "Runner/release demand quality warnings require human review before execution."
          : "Executable PRD demand quality report has warnings that should be reviewed.",
        human_needed: strictExecution || undefined,
      });
    }
    if (demandRequired && qualityReports.length === 0) {
      (strictExecution ? blockers : warnings).push({
        code: "DEMAND_QUALITY_REPORT_MISSING",
        message: strictExecution
          ? "Runner/release demand PRD must include a demand quality report."
          : "Executable demand PRD should include a demand quality report.",
        human_needed: strictExecution || undefined,
      });
    }
    if (!projectFacts) {
      blockers.push({
        code: "DEMAND_PROJECT_FACTS_MISSING",
        message: "Runner/release demand PRD must include structured project facts.",
        human_needed: true,
      });
    } else {
      const unresolvedTargetFacts = asArray(projectFacts.target_files)
        .filter((fact) => ["candidate", "needs_verification", "contradicted", "invalid_scope"].includes(fact?.status)
          || !pathInsideProject(projectRoot, fact?.file));
      const unresolvedAssumptions = asArray(projectFacts.assumptions)
        .filter((fact) => ["needs_verification", "contradicted"].includes(fact?.status));
      if (unresolvedTargetFacts.length > 0) {
        blockers.push({
          code: "DEMAND_PROJECT_TARGET_FACTS_UNRESOLVED",
          message: "Executable PRD must not carry candidate, unverified, contradicted, or out-of-project target-file facts.",
          facts: unresolvedTargetFacts.map((fact) => ({ file: fact.file || null, status: fact.status || null })),
        });
      }
      if (unresolvedAssumptions.length > 0) {
        blockers.push({
          code: "DEMAND_PROJECT_ASSUMPTIONS_UNRESOLVED",
          message: "Executable PRD must not carry unverified or contradicted project assumptions.",
          assumptions: unresolvedAssumptions.map((fact) => ({ id: fact.id || null, status: fact.status || null })),
        });
      }
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

function atomicityReadiness({ prd, projectRoot, strictExecution }) {
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
      (strictExecution ? blockers : warnings).push({
        code: "ATOMICITY_INVESTIGATE_FIRST",
        task_id: task.id,
        message: strictExecution
          ? "Runner/release task requires investigation before patching and cannot continue as a warning."
          : "Task should force investigation before patching.",
        score: inspection.score,
        human_needed: strictExecution || undefined,
      });
    } else if (inspection.mode === "research_only") {
      blockers.push({
        code: "ATOMICITY_RESEARCH_ONLY",
        task_id: task.id,
        message: "Task is research-only and cannot be patched by runner.",
        score: inspection.score,
        human_needed: true,
      });
    }
  }
  const status = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "pass";
  return checkRecord("atomicity", status, "Atomic task scoring completed.", {
    inspections,
    blockers,
    warnings,
  });
}

function storyAtomicityReadiness({ prd }) {
  const inspection = inspectStoryAtomicityFromPrd(prd);
  const blockers = asArray(inspection.blockers).map((blocker) => ({
    code: blocker.code || "STORY_ATOMICITY_MULTI_STORY",
    task_id: blocker.task_id || null,
    requirement_id: blocker.requirement_id || null,
    scenario_id: blocker.scenario_id || null,
    item_id: blocker.item_id || null,
    kind: blocker.kind || "story",
    message: blocker.message || "Requirement, scenario, or task mixes multiple independent user stories.",
    story_count: blocker.story_count || null,
    story_signatures: blocker.story_signatures || [],
    split_suggestions: blocker.split_suggestions || [],
  }));
  const warnItems = asArray(inspection.warnings).map((warn) => ({
    code: warn.code || "STORY_ATOMICITY_CAPABILITY_NOUN",
    task_id: warn.task_id || null,
    requirement_id: warn.requirement_id || null,
    scenario_id: warn.scenario_id || null,
    item_id: warn.item_id || null,
    kind: warn.kind || "story",
    message: warn.message || "",
    capability_nouns: warn.capability_nouns || [],
  }));
  const status = blockers.length > 0 ? "blocked" : warnItems.length > 0 ? "warning" : "pass";
  const summary = status === "blocked"
    ? "Story atomicity found multi-story slices."
    : status === "warning"
      ? "Story atomicity detected capability nouns with single verb — investigate before direct execution."
      : "Story atomicity passed.";
  return checkRecord("story_atomicity", status, summary, {
    inspection,
    blockers,
    warnings: warnItems,
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
    return checkRecord("adapter_readiness", "pass", "No adapter manifest found; continuing for non-UI tasks.", {
      blockers: [],
      warnings: [],
      advisories: [{ code: "ADAPTER_MANIFEST_MISSING", message: "Adapter manifest is missing; non-UI tasks may continue as advisory.", advisory: true }],
      ui_task_count: uiTaskCount,
      adapter_present: false,
      resolver_status: resolver?.status || "unknown",
    });
  }
  return checkRecord("adapter_readiness", "pass", "Adapter readiness passed.", {
    blockers: [],
    warnings: [],
    advisories: [],
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
    human_needed: reason.human_needed || undefined,
    warning_policy: reason.source === "warning_policy" ? "execution_blocking" : undefined,
    original_level: reason.source === "warning_policy" ? "warning" : undefined,
  }));
  const warnings = asArray(preflight.warnings).map((warning) => ({
    code: warning.code || "PRD_PREFLIGHT_WARNING",
    source: warning.source || "preflight",
    task_id: warning.task_id || null,
    message: warning.message || warning.detail || "PRD preflight warning.",
  }));
  const advisories = asArray(preflight.advisory_warnings).map((warning) => ({
    code: warning.code || "PRD_PREFLIGHT_ADVISORY",
    source: warning.source || "preflight",
    task_id: warning.task_id || null,
    message: warning.message || warning.detail || "PRD preflight advisory.",
    advisory: true,
  }));
  return checkRecord("prd_preflight", preflight.status === "blocked" ? "blocked" : preflight.status === "warning" ? "warning" : "pass", "PRD preflight completed.", {
    blockers,
    warnings: preflight.status === "warning" ? warnings : [],
    advisories,
    preflight,
  });
}

export function inspectYoloCheck(input = Object(), options = Object()) {
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
  let prd;
  try {
    prd = readPrd(resolvedPrdPath);
  } catch (error) {
    return prdJsonErrorReport({
      prdPath: resolvedPrdPath,
      projectRoot,
      stateRoot,
      error,
      writeLifecycle: input.writeLifecycle || input.write_lifecycle || options.writeLifecycle || options.write_lifecycle,
      learnFailures: options.learnFailures === true || input.learnFailures === true,
    });
  }
  const strictExecution = strictExecutionPolicy({ prd, input, options });
  const mode = executionMode(input, options);
  const failClosedWarnings = strictWarningPolicy({ strictExecution, mode });
  const preflight = preflightPrd(resolvedPrdPath, {
    mode,
    strictExecution,
    requireDemandContract: strictExecution,
    projectRoot,
  });
  const surfaceSummary = summarizeTaskSurfaces(prd, { acceptanceManifest, resolver: input.resolver || options.resolver });
  const resolver = input.resolver || options.resolver || resolveProjectContext({
    projectRoot,
    stateRoot,
    requiresAcceptanceAdapter: surfaceSummary.ui_task_count > 0,
  });
  const checks = [
    preflightReadiness(preflight),
    demandContractReadiness({ prd, projectRoot, strictExecution }),
    productReadiness({ prd, discovery, projectRoot }),
    resolverReadiness({ resolver }),
    uiReadiness({ prd, acceptanceManifest, resolver }),
    storyAtomicityReadiness({ prd }),
    atomicityReadiness({ prd, projectRoot, strictExecution }),
    adapterReadiness({ prd, acceptanceManifest, options: { ...options, ...input }, resolver }),
    evidencePlanReadiness({ prd }),
  ].map((check) => applyWarningPolicy(check, { failClosed: failClosedWarnings }))
    .sort((a, b) => severity(b.status) - severity(a.status));
  const status = aggregateStatus(checks);
  const blockers = checks.flatMap((check) => asArray(check.blockers).map((blocker) => ({ ...blocker, gate: check.name })));
  const warnings = checks.flatMap((check) => asArray(check.warnings).map((warning) => ({ ...warning, gate: check.name })));
  const advisoryWarnings = checks.flatMap((check) => asArray(check.advisories).map((warning) => ({ ...warning, gate: check.name, advisory: true })));
  const blockingWarnings = blockers.filter((blocker) => blocker.warning_policy === "execution_blocking");
  const remediationPlan = buildGateRemediationPlan({
    source: "yolo-check",
    blockers,
    warnings,
    summary: status === "blocked"
      ? "Strict check found remediation work; automation can continue only through the planned remediation route."
      : status === "warning"
        ? "Strict check produced warnings; automation is blocked until the warnings are reviewed or remediated."
        : "Strict check passed.",
  });
  const report = Object.assign(Object(), {
    schema_version: YOLO_CHECK_REPORT_SCHEMA_VERSION,
    schema: YOLO_CHECK_REPORT_SCHEMA,
    status,
    code: status === "blocked" ? "YOLO_CHECK_BLOCKED" : status === "warning" ? "YOLO_CHECK_WARNING" : "YOLO_CHECK_PASS",
    summary: status === "pass" ? "YOLO check passed; PRD is ready for gated execution." : status === "warning" ? "YOLO check blocked by warnings." : "YOLO check blocked execution.",
    generated_at: nowIso(),
    prd_path: resolvedPrdPath,
    project_root: projectRoot,
    state_root: stateRoot,
    execution_mode: mode,
    strict_execution: strictExecution,
    resolver,
    task_surface_summary: summarizeTaskSurfaces(prd, { acceptanceManifest, resolver }),
    checks,
    blockers,
    warnings,
    advisory_warnings: advisoryWarnings,
    blocking_warnings: blockingWarnings,
    warning_policy: {
      mode,
      fail_closed: failClosedWarnings,
      advisory_warning_count: advisoryWarnings.length,
      blocking_warning_count: blockingWarnings.length,
      advisory_codes: [...ADVISORY_WARNING_CODES],
    },
    execution_policy: {
      gate_strength: "strict",
      remediation_mode: "blocking_when_execution_unsafe",
      ship_gate: "fail_closed",
      automation_can_continue: status === "pass" ? remediationPlan.automation_can_continue : false,
      human_needed: status !== "pass" || remediationPlan.requires_human || blockers.some((blocker) => blocker.human_needed === true) || blockingWarnings.length > 0,
    },
    remediation_plan: remediationPlan,
    artifacts: [resolvedPrdPath],
    next_actions: blockers.length > 0
      ? remediationPlan.next_actions
      : status === "warning"
        ? ["Review or remediate warnings before continuing automation."]
        : ["Run /yolo-run only after user approval."],
  });

  if (input.writeLifecycle || input.write_lifecycle || options.writeLifecycle || options.write_lifecycle) {
    report.lifecycle_write = writeLifecycleStageReport("check", report, {
      projectRoot,
      stateRoot,
      source: "yolo-check",
      learnFailures: options.learnFailures === true || input.learnFailures === true,
      skipSequenceCheck: true,
    });
    report.artifacts.push(report.lifecycle_write.artifact_path);
  }

  return report;
}

export function formatYoloCheckText(report = Object()) {
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

function readCliArgValue(argv, index) {
  const arg = argv[index];
  if (arg.includes("=")) return { value: arg.split("=").slice(1).join("="), consumed: 0 };
  return { value: argv[index + 1], consumed: 1 };
}

export function runYoloCheckCli(argv = process.argv.slice(2), io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const json = argv.includes("--json");
  const modeIndex = argv.findIndex((arg) => arg === "--mode" || arg.startsWith("--mode="));
  const mode = argv.includes("--strict")
    ? "strict"
    : argv.includes("--release")
      ? "release"
      : modeIndex >= 0
        ? readCliArgValue(argv, modeIndex).value
        : undefined;
  const strictExecution = ["strict", "release"].includes(cleanString(mode).toLowerCase()) ? true : undefined;
  const valueFlags = new Set(["--mode"]);
  const prdPath = argv.find((arg, index) => !arg.startsWith("--") && !valueFlags.has(argv[index - 1]));
  const writeLifecycle = !argv.includes("--no-write");
  const report = inspectYoloCheck({ prdPath, projectRoot: io.cwd || process.cwd(), mode, strictExecution, writeLifecycle }, { learnFailures: true });
  if (json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else (report.status === "error" ? stderr : stdout).write(`${formatYoloCheckText(report)}\n`);
  return checkExitCode(report.status);
}

if (isMain) {
  const code = runYoloCheckCli();
  process.exit(code);
}
