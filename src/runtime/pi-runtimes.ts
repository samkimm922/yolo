import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { convertAuditToPrd } from "../prd/audit-to-prd.js";
import { inspectPrdContract } from "./gates/prd-contract-doctor.js";
import { scanProject } from "../review/scanner.js";
import { validatePrdPath } from "../prd/validate.js";
import { generateFindingsFromRequirement } from "../demand/findings-generator.js";
import { runRunnerRuntime } from "./runner-runtime.js";
import { createPrdMigrationAdvice } from "../prd/migration.js";
import { preflightPrd } from "../prd/preflight.js";
import { buildAcceptanceReport } from "./acceptance/report.js";
import { writeLifecycleStageReport } from "../lifecycle/progress.js";
import { appendLearningRecord } from "./learning/center.js";
import { runDiscoveryRuntime } from "../discovery/runtime.js";
import { inspectYoloCheck } from "./gates/check-report.js";
import { inspectLifecycleGuard } from "../lifecycle/guard.js";

function ok(summary, extra = Object()) {
  return { status: "success", summary, artifacts: [], next_actions: [], ...extra };
}

function fail(summary, extra = Object()) {
  return {
    status: "error",
    summary,
    artifacts: [],
    next_actions: ["Fix the failed PI runtime step, then resume from the generated artifact."],
    ...extra,
  };
}

function lifecycleWrite(stageId, report = Object(), params = Object(), source = "pi-runtime") {
  if (params.writeLifecycle === false || params.write_lifecycle === false || !params.stateRoot) return null;
  return writeLifecycleStageReport(stageId, report, {
    projectRoot: params.projectRoot,
    stateRoot: params.stateRoot,
    source,
    learnFailures: true,
    skipSequenceCheck: true,
  });
}

function summarizeCheckReport(report) {
  if (!report) return null;
  return {
    schema_version: report.schema_version,
    schema: report.schema,
    status: report.status,
    code: report.code,
    summary: report.summary,
    prd_path: report.prd_path,
    blocker_count: report.blockers?.length || 0,
    warning_count: report.warnings?.length || 0,
    checks: (report.checks || []).map((check) => ({
      name: check.name,
      status: check.status,
      summary: check.summary,
    })),
    blockers: (report.blockers || []).slice(0, 20),
    warnings: (report.warnings || []).slice(0, 20),
    artifacts: report.artifacts || [],
    lifecycle_write: report.lifecycle_write
      ? {
        stage: report.lifecycle_write.stage,
        stage_status: report.lifecycle_write.stage_status,
        artifact_path: report.lifecycle_write.artifact_path,
        status_path: report.lifecycle_write.status_path,
      }
      : null,
    next_actions: report.next_actions || [],
  };
}

async function runFindingsRuntime(params = Object()) {
  const requirement = params.requirementFile
    ? readFileSync(resolve(params.requirementFile), "utf8")
    : params.requirement;

  const result = await generateFindingsFromRequirement(requirement, {
    outputFile: params.outputFile,
    projectRoot: params.projectRoot,
    timeout_ms: params.timeout_ms,
    model: params.model,
    settings: params.settings,
  });

  if (!result.ok) {
    return fail(`PM findings generation failed: ${result.error}`, {
      code: "PI_FINDINGS_FAILED",
      raw: result.raw,
    });
  }

  const report = ok(`Generated ${result.data.findings.length} finding(s).`, {
    artifacts: [result.output_file].filter(Boolean),
    findings_count: result.data.findings.length,
  });
  const lifecycle = lifecycleWrite("roadmap", report, params, "pi-findings");
  if (lifecycle) {
    report.lifecycle_write = lifecycle;
    report.artifacts.push(lifecycle.artifact_path);
  }
  return report;
}

function runPrdGenerateRuntime(params = Object()) {
  const output = resolve(params.output);
  mkdirSync(dirname(output), { recursive: true });
  const result = convertAuditToPrd(params.findingsPath, {
    output,
    title: params.title,
    cwd: params.projectRoot,
    approvedDemandContract: params.approvedDemandContract
      || params.approved_demand_contract
      || params.demandContract
      || params.demand_contract,
  });

  if (!result.ok) {
    return fail(`PRD generation failed: ${result.error}`, { code: "PI_PRD_GENERATION_FAILED" });
  }

  const report = ok(`Generated PRD with ${result.counts.tasks} task(s).`, {
    artifacts: [output],
    counts: result.counts,
    prd_path: output,
  });
  const lifecycle = lifecycleWrite("prd", report, params, "pi-prd-generate");
  if (lifecycle) {
    report.lifecycle_write = lifecycle;
    report.artifacts.push(lifecycle.artifact_path);
  }
  return report;
}

function runSchemaGateRuntime(params = Object()) {
  const result = Object.assign(Object(), validatePrdPath(params.prdPath));
  if (!result.ok) {
    return fail(`PRD schema gate failed: ${result.error}`, {
      code: "PI_PRD_SCHEMA_FAILED",
      validation: result,
      artifacts: [params.prdPath].filter(Boolean),
    });
  }
  return ok("PRD schema gate passed.", {
    artifacts: [params.prdPath].filter(Boolean),
    warnings: result.warnings || [],
  });
}

function runPrdPreflightRuntime(params = Object()) {
  const result = preflightPrd(params.prdPath);
  const check = params.stateRoot
    ? inspectYoloCheck({
      prdPath: params.prdPath,
      projectRoot: params.projectRoot,
      stateRoot: params.stateRoot,
      writeLifecycle: params.writeLifecycle !== false,
    }, { learnFailures: true })
    : null;
  if (!result.runner_readiness.can_execute) {
    return fail(`PRD preflight blocked execution with ${result.blocked_count} blocker(s).`, {
      code: "PI_PRD_PREFLIGHT_BLOCKED",
      preflight: result,
      check: summarizeCheckReport(check),
      contract: result.contract,
      migration: result.migration,
      artifacts: [params.prdPath].filter(Boolean),
      next_actions: result.runner_readiness.next_actions,
    });
  }
  if (check && (check.status === "blocked" || check.status === "error")) {
    return fail(check.summary, {
      code: check.code || "PI_YOLO_CHECK_BLOCKED",
      preflight: result,
      check: summarizeCheckReport(check),
      artifacts: check.artifacts || [params.prdPath].filter(Boolean),
      next_actions: check.next_actions,
    });
  }
  return ok(`PRD preflight ${result.status}.`, {
    artifacts: [params.prdPath].filter(Boolean),
    preflight: result,
    check: summarizeCheckReport(check),
    warnings: [
      ...(result.schema?.warnings || []),
      ...(result.contract?.warnings || []),
      ...(result.spec_governance?.warnings || []),
      ...(check?.warnings || []),
    ],
  });
}

function runContractGateRuntime(params = Object()) {
  const prd = JSON.parse(readFileSync(resolve(params.prdPath), "utf8"));
  const result = inspectPrdContract(prd);
  if (result.blocks_execution) {
    const migration = createPrdMigrationAdvice(prd, params.prdPath);
    return fail(`PRD contract gate failed with ${result.failure_count} failure(s).`, {
      code: "PI_PRD_CONTRACT_FAILED",
      contract: result,
      migration,
      artifacts: [params.prdPath].filter(Boolean),
      next_actions: migration.next_actions,
    });
  }
  return ok(`PRD contract gate ${result.warning_count > 0 ? "passed with warnings" : "passed"}.`, {
    artifacts: [params.prdPath].filter(Boolean),
    contract: result,
  });
}

function runReviewScanRuntime(params = Object()) {
  const result = scanProject({
    root: params.projectRoot,
    config: params.config,
    includeExternalChecks: params.includeExternalChecks !== false,
  });

  const hasHigh = result.findings.some((finding) => finding.severity === "HIGH" || finding.severity === "CRITICAL" || finding.must_fix_before_ship === true);
  const report = Object.assign(Object(), {
    status: hasHigh ? "warning" : "success",
    summary: `Review scan found ${result.total_findings} finding(s).`,
    artifacts: [],
    next_actions: hasHigh ? ["Review HIGH/CRITICAL findings before shipping."] : [],
    scan: result,
    findings: result.findings,
  });
  if (params.writeLifecycle !== false && params.stateRoot) {
    report.lifecycle_write = writeLifecycleStageReport("review-fix", report, {
      projectRoot: params.projectRoot,
      stateRoot: params.stateRoot,
      source: "pi-review-scan",
      learnFailures: true,
      skipSequenceCheck: true,
    });
    report.artifacts.push(report.lifecycle_write.artifact_path);
  }
  return report;
}

function runAcceptanceRuntime(params = Object()) {
  const report = buildAcceptanceReport({
    prdPath: params.prdPath,
    projectRoot: params.projectRoot,
    stateRoot: params.stateRoot,
    writeLifecycle: params.writeLifecycle !== false,
    collectEvidence: params.collectEvidence,
    executeAdapter: params.executeAdapter,
    allowAdapterCommands: params.allowAdapterCommands,
  }, { learnFailures: true });

  if (report.status === "pass") {
    return ok("Acceptance passed.", {
      artifacts: report.artifacts || [],
      acceptance: report,
    });
  }
  return {
    status: report.status === "warning" ? "warning" : "error",
    summary: report.summary,
    code: report.code || "PI_ACCEPTANCE_BLOCKED",
    artifacts: report.artifacts || [],
    next_actions: report.next_actions || [],
    acceptance: report,
  };
}

function readJsonMaybe(path) {
  try {
    return path ? JSON.parse(readFileSync(resolve(path), "utf8")) : null;
  } catch {
    return null;
  }
}

function runShipRuntime(params = Object()) {
  const expectedPrd = params.prdPath ? resolve(params.prdPath) : "";
  const projectRoot = resolve(params.projectRoot || params.project_root || (expectedPrd ? dirname(expectedPrd) : process.cwd()));
  const stateRoot = resolve(params.stateRoot || params.state_root || join(projectRoot, ".yolo"));
  const acceptancePath = params.acceptanceReportPath
    || params.acceptance_report_path
    || resolve(stateRoot, "lifecycle", "acceptance-report.json");
  const guard = inspectLifecycleGuard({
    ...params,
    command: "yolo-ship",
    projectRoot,
    stateRoot,
    prdPath: expectedPrd,
  });
  if (guard.status !== "pass") {
    return fail(guard.summary || "Ship gate blocked by YOLO lifecycle guard.", {
      code: guard.code || "LIFECYCLE_GUARD_BLOCKED",
      exit_code: 2,
      artifacts: [acceptancePath].filter(Boolean),
      blockers: guard.blockers || [],
      lifecycle_guard: guard,
      next_actions: guard.next_actions || ["Run /yolo-next before delivery."],
    });
  }
  const acceptanceReport = params.acceptanceReport || params.acceptance_report || readJsonMaybe(acceptancePath);
  const acceptanceStatus = acceptanceReport?.report?.status || acceptanceReport?.status;
  const blockers = [];
  if (!acceptanceReport) {
    blockers.push({ code: "ACCEPTANCE_REPORT_MISSING", message: "Ship requires an acceptance report." });
  } else if (acceptanceStatus !== "pass") {
    blockers.push({
      code: "ACCEPTANCE_NOT_PASSING",
      message: `Acceptance status is ${acceptanceStatus || "unknown"}.`,
    });
  }
  const acceptancePrd = acceptanceReport?.report?.prd_path || acceptanceReport?.prd_path || "";
  if (expectedPrd && acceptancePrd && resolve(acceptancePrd) !== expectedPrd) {
    blockers.push({
      code: "ACCEPTANCE_PRD_MISMATCH",
      message: "Acceptance report belongs to a different PRD.",
      expected_prd: expectedPrd,
      actual_prd: resolve(acceptancePrd),
    });
  }

  const status = blockers.length > 0 ? "blocked" : "success";
  const report = Object.assign(Object(), {
    status,
    code: status === "success" ? "SHIP_READY" : "SHIP_BLOCKED",
    summary: status === "success" ? "Ship gate passed; delivery is ready." : "Ship gate blocked by missing or failing evidence.",
    prd_path: expectedPrd,
    acceptance_report_path: acceptancePath ? resolve(acceptancePath) : "",
    blockers,
    artifacts: [acceptancePath && acceptanceReport ? resolve(acceptancePath) : null].filter(Boolean),
    next_actions: status === "success"
      ? ["Prepare operator handoff and release notes."]
      : ["Fix ship blockers, then rerun PI or yolo ship."],
  });
  if (params.writeLifecycle !== false && stateRoot) {
    report.lifecycle_write = writeLifecycleStageReport("delivery", report, {
      projectRoot: params.projectRoot,
      stateRoot,
      source: "pi-ship",
      learnFailures: true,
      skipSequenceCheck: true,
    });
    report.artifacts.push(report.lifecycle_write.artifact_path);
  }

  return status === "success"
    ? ok(report.summary, { artifacts: report.artifacts, ship: report })
    : fail(report.summary, { code: report.code, artifacts: report.artifacts, blockers, ship: report, next_actions: report.next_actions });
}

function runLearnRuntime(params = Object()) {
  const stateRoot = params.stateRoot ? resolve(params.stateRoot) : undefined;
  const projectRoot = resolve(params.projectRoot || params.project_root || (params.prdPath ? dirname(resolve(params.prdPath)) : process.cwd()));
  if (stateRoot) {
    const guard = inspectLifecycleGuard({
      ...params,
      command: "yolo-learn",
      projectRoot,
      stateRoot,
      prdPath: params.prdPath ? resolve(params.prdPath) : undefined,
    });
    if (guard.status !== "pass") {
      return fail(guard.summary || "Learn gate blocked by YOLO lifecycle guard.", {
        code: guard.code || "LIFECYCLE_GUARD_BLOCKED",
        exit_code: 2,
        blockers: guard.blockers || [],
        lifecycle_guard: guard,
        next_actions: guard.next_actions || ["Run /yolo-next before learning."],
      });
    }
  }

  const lesson = params.lesson || "PI lifecycle completed through delivery gate.";
  const record = appendLearningRecord({
    type: "retrospective",
    source: "pi-agent",
    gate: "learn",
    lesson,
    prevention: params.prevention || "Reuse the PI lifecycle path for similar work.",
    evidence_refs: [
      params.prdPath,
      stateRoot ? resolve(stateRoot, "lifecycle", "run-report.json") : null,
      stateRoot ? resolve(stateRoot, "lifecycle", "review-report.json") : null,
      stateRoot ? resolve(stateRoot, "lifecycle", "acceptance-report.json") : null,
      stateRoot ? resolve(stateRoot, "lifecycle", "delivery-report.json") : null,
    ].filter(Boolean),
    tags: ["pi", "lifecycle", "learn"],
  }, {
    projectRoot,
    stateRoot,
  });

  const report = Object.assign(Object(), {
    status: "success",
    code: "LEARN_RECORDED",
    summary: "Learning record captured for the PI lifecycle.",
    artifacts: [record.file].filter(Boolean),
    learning: record,
    next_actions: [],
  });
  if (params.writeLifecycle !== false && stateRoot) {
    report.lifecycle_write = writeLifecycleStageReport("learn", report, {
      projectRoot: params.projectRoot,
      stateRoot,
      source: "pi-learn",
      skipSequenceCheck: true,
    });
    report.artifacts.push(report.lifecycle_write.artifact_path);
  }
  return ok(report.summary, {
    artifacts: report.artifacts,
    learning: record,
    retrospective: report,
  });
}

export async function runPiRuntime(runtime, params = Object(), context = Object()) {
  switch (runtime) {
    case "discovery.write":
    case "discovery.inspect":
      return runDiscoveryRuntime({ ...params, ...context });
    case "pm.findings":
      return runFindingsRuntime({ ...params, ...context });
    case "prd.generate":
      return runPrdGenerateRuntime({ ...params, ...context });
    case "prd.schema_gate":
      return runSchemaGateRuntime({ ...params, ...context });
    case "prd.preflight":
      return runPrdPreflightRuntime({ ...params, ...context });
    case "prd.contract_gate":
      return runContractGateRuntime({ ...params, ...context });
    case "runner":
      return runRunnerRuntime({ ...params }, context);
    case "review.scan":
      return runReviewScanRuntime({ ...params, ...context });
    case "acceptance":
      return runAcceptanceRuntime({ ...params, ...context });
    case "ship":
      return runShipRuntime({ ...params, ...context });
    case "learn":
      return runLearnRuntime({ ...params, ...context });
    default:
      return fail(`Unknown PI runtime action: ${runtime}`, {
        code: "UNKNOWN_PI_RUNTIME",
        next_actions: ["Use one of: discovery.write, pm.findings, prd.generate, prd.preflight, prd.schema_gate, prd.contract_gate, runner, review.scan, acceptance, ship, learn."],
      });
  }
}
