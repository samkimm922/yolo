import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { preflightPrd } from "../prd/preflight.js";
import { writeLifecycleStageReport } from "../lifecycle/progress.js";
import { inspectLifecycleGuard } from "../lifecycle/guard.js";
import { inspectYoloCheck } from "./gates/check-report.js";
import { buildGateRemediationPlan } from "./gates/remediation-plan.js";
import { runAdapterEvidenceCollector } from "./adapters/evidence-collector.js";
import { appendStateEvent } from "./evidence/ledger.js";
import { uiTasks } from "./gates/readiness-policy.js";
import { buildRunFinalVerdict } from "./run-lifecycle/finalize.js";

function normalizeRunnerError(error) {
  return {
    status: "error",
    summary: error?.message || "runner failed",
    exit_code: error?.exitCode || 1,
    code: error?.code || "RUNNER_ERROR",
    artifacts: [],
    next_actions: [
      "Inspect the runner error, fix the failed gate or PRD contract issue, then resume from the same PRD.",
    ],
  };
}

function readJsonMaybe(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function wantsAdapterEvidence(input = {}, options = {}) {
  return input.collectEvidence === true
    || input.collect_evidence === true
    || options.collectEvidence === true
    || options.collect_evidence === true;
}

function attachAdapterEvidence(response, evidence) {
  if (!evidence) return response;
  response.adapter_evidence = evidence;
  if (evidence.artifact_path) response.artifacts.push(evidence.artifact_path);
  if (Array.isArray(evidence.artifacts)) response.artifacts.push(...evidence.artifacts);
  response.artifacts = [...new Set(response.artifacts.filter(Boolean))];
  if (["blocked", "failed", "error"].includes(evidence.status)) {
    response.status = "error";
    response.exit_code = 1;
    response.code = evidence.code || "ADAPTER_EVIDENCE_BLOCKED";
    response.next_actions = [
      "Fix UI/UX adapter evidence blockers, then rerun yolo run with evidence collection.",
      ...(response.next_actions || []),
    ];
  }
  return response;
}

function collectAdapterEvidenceForRun({ prd, projectRoot, stateRoot, runId, input = {}, options = {} } = {}) {
  if (!wantsAdapterEvidence(input, options)) return null;
  const requiresAcceptanceAdapter = uiTasks(prd).length > 0;
  if (!requiresAcceptanceAdapter) return null;
  const evidence = runAdapterEvidenceCollector({
    projectRoot,
    stateRoot,
    prd,
    requiresAcceptanceAdapter,
    execute: input.executeAdapter === true || input.execute_adapter === true || options.executeAdapter === true || options.execute_adapter === true,
    allowAdapterCommands: input.allowAdapterCommands === true || input.allow_adapter_commands === true || options.allowAdapterCommands === true || options.allow_adapter_commands === true,
  });
  try {
    appendStateEvent(join(stateRoot, "state"), "ui.evidence", {
      run_id: runId || null,
      status: evidence.status,
      code: evidence.code,
      adapter_id: evidence.adapter?.id || null,
      artifact_file: evidence.artifact_file || null,
    }, { source: "runner-runtime" });
  } catch {
    // Preserve the adapter result even when optional ledger writing is unavailable.
  }
  return evidence;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function runnerResultReport(result = {}) {
  return result.run_report || result.runReport || result.report || null;
}

function runnerResultFinalAnswer(result = {}) {
  return result.final_answer || result.finalAnswer || null;
}

function runnerResultExitCode(result = {}, verdict = {}) {
  const exitCode = numberOrNull(result.exit_code ?? result.exitCode);
  if (exitCode != null && exitCode !== 0) return exitCode;
  return verdict.status === "success" ? 0 : 1;
}

function normalizeRunnerResult(result = {}) {
  const finalVerdict = buildRunFinalVerdict({
    taskResults: {
      ...result,
      contractReview: result.contractReview || result.contract_review || [],
    },
    runReportResult: {
      report: runnerResultReport(result),
      final_answer: runnerResultFinalAnswer(result),
      error: result.run_report_error || result.runReportError || result.report_error,
      errors: result.run_report_errors || result.runReportErrors || result.report_errors,
    },
    failOnSkippedIssues: true,
  });
  const exitCode = runnerResultExitCode(result, finalVerdict);
  const status = exitCode === 0 && finalVerdict.status === "success" ? "success" : "error";
  return {
    status,
    exit_code: status === "success" ? 0 : exitCode || 1,
    summary: status === "success"
      ? (result.summary || finalVerdict.summary)
      : (finalVerdict.issues.length > 0 ? finalVerdict.summary : result.summary || "runner completed with errors"),
    final_verdict: finalVerdict,
  };
}

function lifecycleGuardRuntimeBlock(guard, prdPath) {
  return {
    status: "error",
    summary: guard.summary || "YOLO lifecycle guard blocked runner execution.",
    exit_code: 2,
    code: guard.code || "LIFECYCLE_GUARD_BLOCKED",
    artifacts: [prdPath].filter(Boolean),
    lifecycle_guard: guard,
    blockers: guard.blockers || [],
    warnings: guard.warnings || [],
    next_actions: guard.next_actions || ["Run /yolo-next before starting implementation."],
  };
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

function inferProjectRootFromPrdPath(prdPath) {
  const marker = `${sep}.yolo${sep}`;
  const index = prdPath.indexOf(marker);
  if (index > 0) return prdPath.slice(0, index);
  return dirname(prdPath);
}

export async function runRunnerRuntime(input = {}, options = {}) {
  const prdPath = input.prdPath || input.prd_path;
  const dryRun = input.dryRun === true || input.dry_run === true || options.dryRun === true || options.dry_run === true;
  if (!prdPath) {
    return {
      status: "error",
      summary: "runner runtime requires prdPath",
      exit_code: 2,
      code: "MISSING_PRD_PATH",
      artifacts: [],
      next_actions: ["Pass a PRD path before starting implementation."],
    };
  }

  try {
    const resolvedPrdPath = resolve(prdPath);
    const projectRoot = resolve(input.projectRoot || input.project_root || options.projectRoot || options.project_root || inferProjectRootFromPrdPath(resolvedPrdPath));
    const stateRoot = resolve(input.stateRoot || input.state_root || options.stateRoot || options.state_root || join(projectRoot, ".yolo"));
    const writeLifecycle = input.writeLifecycle ?? input.write_lifecycle ?? options.writeLifecycle ?? options.write_lifecycle ?? true;
    const guard = inspectLifecycleGuard({
      ...input,
      command: "yolo-run",
      projectRoot,
      stateRoot,
      prdPath: resolvedPrdPath,
    }, options);
    if (guard.status !== "pass") return lifecycleGuardRuntimeBlock(guard, resolvedPrdPath);

    const prd = readJsonMaybe(resolvedPrdPath);
    const preflight = preflightPrd(resolvedPrdPath);
    if (!preflight.runner_readiness.can_execute) {
      const hasContractBlock = preflight.blocked_reasons.some((reason) => reason.source === "contract");
      const hasSpecBlock = preflight.blocked_reasons.some((reason) => reason.source === "spec");
      const remediationPlan = buildGateRemediationPlan({
        source: "runner-preflight",
        blockers: preflight.blocked_reasons,
        summary: "Strict runner preflight found remediation work before implementation can start.",
      });
      return {
        status: "error",
        summary: `runner preflight blocked PRD execution (${preflight.blocked_count} blocker(s)).`,
        exit_code: 1,
        code: hasContractBlock ? "PRD_CONTRACT_BLOCKED" : hasSpecBlock ? "PRD_SPEC_GOVERNANCE_BLOCKED" : "PRD_PREFLIGHT_BLOCKED",
        artifacts: [resolvedPrdPath],
        preflight,
        contract: preflight.contract,
        spec_governance: preflight.spec_governance,
        migration: preflight.migration,
        remediation_plan: remediationPlan,
        next_actions: preflight.runner_readiness.next_actions,
      };
    }

    const check = inspectYoloCheck({
      prdPath: resolvedPrdPath,
      projectRoot,
      stateRoot,
      writeLifecycle,
    }, { learnFailures: true });
    if (check.status === "blocked" || check.status === "error") {
      return {
        status: "error",
        summary: check.summary,
        exit_code: 1,
        code: check.code || "YOLO_CHECK_BLOCKED",
        artifacts: check.artifacts || [resolvedPrdPath],
        preflight,
        check: summarizeCheckReport(check),
        remediation_plan: check.remediation_plan,
        next_actions: check.next_actions || ["Fix /yolo-check blockers before running."],
      };
    }

    if (dryRun) {
      const response = {
        status: "success",
        summary: "runner dry-run preflight passed",
        exit_code: 0,
        code: "RUNNER_DRY_RUN_READY",
        dry_run: true,
        artifacts: [resolvedPrdPath],
        preflight,
        check: summarizeCheckReport(check),
        runner_readiness: preflight.runner_readiness,
        next_actions: ["Run without dryRun to start implementation."],
      };
      return attachAdapterEvidence(response, collectAdapterEvidenceForRun({
        prd,
        projectRoot,
        stateRoot,
        runId: input.runId || input.run_id || options.runId || options.run_id || null,
        input,
        options,
      }));
    }

    const runner = input.runner || input.runnerModule || options.runner || options.runnerModule || await import("./runner-core.js");
    const runRunner = typeof runner === "function" ? runner : runner.run;
    const result = await runRunner(resolvedPrdPath, {
      mode: input.mode || options.mode || "fix",
      runId: input.runId || input.run_id || options.runId || options.run_id,
      projectRoot,
      stateRoot,
      executor: input.executor || input.provider || options.executor || options.provider,
      provider: input.provider || options.provider,
      model: input.model || options.model,
      agentCommand: input.agentCommand || input.agent_command || input.customCommand || input.custom_command || options.agentCommand || options.agent_command || options.customCommand || options.custom_command,
      startProgressServer: input.startProgressServer ?? input.start_progress_server ?? options.startProgressServer ?? options.start_progress_server,
      initializeBaselines: input.initializeBaselines ?? input.initialize_baselines ?? options.initializeBaselines ?? options.initialize_baselines,
      exitOnComplete: false,
    });
    const normalizedResult = normalizeRunnerResult(result);

    const response = {
      status: normalizedResult.status,
      summary: normalizedResult.summary,
      exit_code: normalizedResult.exit_code,
      run_id: result.run_id,
      artifacts: [result.prd].filter(Boolean),
      completed: result.completed || [],
      failed: result.failed || [],
      skipped: result.skipped || [],
      blocked: result.blocked || [],
      contract_review: result.contract_review || result.contractReview || [],
      remediation: result.remediation || [],
      final_verdict: normalizedResult.final_verdict,
      next_actions: normalizedResult.status === "success"
        ? []
        : ["Review failed/blocked task IDs and rerun PI after fixing the root cause."],
    };
    attachAdapterEvidence(response, collectAdapterEvidenceForRun({
      prd,
      projectRoot,
      stateRoot,
      runId: response.run_id,
      input,
      options,
    }));
    if (writeLifecycle) {
      response.lifecycle_write = writeLifecycleStageReport("run", {
        ...response,
        preflight,
        check,
      }, {
        projectRoot,
        stateRoot,
        source: "runner-runtime",
        learnFailures: true,
      });
      response.artifacts.push(response.lifecycle_write.artifact_path);
    }
    return response;
  } catch (error) {
    return normalizeRunnerError(error);
  }
}
