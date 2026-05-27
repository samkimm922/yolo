import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { preflightPrd } from "../prd/preflight.js";
import { writeLifecycleStageReport } from "../lifecycle/progress.js";
import { inspectYoloCheck } from "./gates/check-report.js";
import { buildGateRemediationPlan } from "./gates/remediation-plan.js";
import { runAdapterEvidenceCollector } from "./adapters/evidence-collector.js";
import { appendStateEvent } from "./evidence/ledger.js";
import { uiTasks } from "./gates/readiness-policy.js";

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

export async function runRunnerRuntime(input = {}, options = {}) {
  const prdPath = input.prdPath || input.prd_path;
  const dryRun = input.dryRun === true || input.dry_run === true || options.dryRun === true || options.dry_run === true;
  const projectRoot = input.projectRoot || input.project_root || options.projectRoot || options.project_root;
  const stateRoot = input.stateRoot || input.state_root || options.stateRoot || options.state_root || (projectRoot ? join(resolve(projectRoot), ".yolo") : undefined);
  const writeLifecycle = input.writeLifecycle ?? input.write_lifecycle ?? options.writeLifecycle ?? options.write_lifecycle ?? Boolean(projectRoot || stateRoot);
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
        check,
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
        check,
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

    const runner = await import("./runner-core.js");
    const result = await runner.run(resolvedPrdPath, {
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

    const response = {
      status: result.exit_code === 0 ? "success" : "error",
      summary: result.summary || "runner completed",
      exit_code: result.exit_code,
      run_id: result.run_id,
      artifacts: [result.prd].filter(Boolean),
      completed: result.completed || [],
      failed: result.failed || [],
      skipped: result.skipped || [],
      blocked: result.blocked || [],
      remediation: result.remediation || [],
      next_actions: result.exit_code === 0
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
