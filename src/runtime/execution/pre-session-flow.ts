import { buildAtomicDoctorBlockOutcome } from "./atomic-doctor-outcome.js";
import { completeDryRunArtifactTask } from "./dry-run-artifact.js";
import { tryDeterministicAutoFixTask } from "./deterministic-auto-fix.js";
import { buildEngineSelfModificationBlockOutcome } from "./engine-scope-outcome.js";
import {
  buildPrecheckValidSkipOutcome,
  precheckErrorMessage,
  precheckInvalidSkipMessage,
  precheckRequestedSkip,
} from "./precheck-outcome.js";
import { inspectPostPrecheckSkip } from "./post-precheck.js";
import { runAtomicTaskDoctorGate } from "./session-validation.js";
import {
  failTaskTransition,
  passTaskTransition,
} from "../task-state/transitions.js";

export async function handlePreSessionFlow({
  task,
  prdPath,
  attempt = 0,
  taskRoute = Object(),
  config = Object(),
  yoloRoot,
  projectRoot,
  execNode,
  execSync,
  loadPRD,
  shouldRunPrecheck = () => false,
  skippedTaskPostconditionsPass,
  taskPostconditionsPass,
  commitTask,
  recordTaskTransition,
  writeTaskResult,
  updatePrdTaskStatus,
  applySplitSuggestionsToPrd,
  isBusinessFile,
  logProgress = (..._args) => {},
  logTaskBash = (..._args) => {},
  logTaskDone = (..._args) => {},
  nowMs = () => Date.now(),
  engineBlockBuilder = buildEngineSelfModificationBlockOutcome,
  dryRunTaskCompleter = completeDryRunArtifactTask,
  deterministicAutoFix = tryDeterministicAutoFixTask,
  atomicDoctorGate = runAtomicTaskDoctorGate,
  atomicDoctorBlockBuilder = buildAtomicDoctorBlockOutcome,
  postPrecheckInspector = inspectPostPrecheckSkip,
} = Object()) {
  if (attempt === 0 && shouldRunPrecheck(task)) {
    const precheckScript = "src/runtime/execution/precheck.js";
    const precheckArgs = [
      `--task=${task.id}`,
      `--prd=${prdPath}`,
    ];
    if (projectRoot) precheckArgs.push(`--cwd=${projectRoot}`);
    const precheck = execNode(precheckScript, precheckArgs);
    logTaskBash(task.id, `node ${precheckScript}`, precheck.ok ? "pass" : "fail", precheck.stdout?.slice(0, 200));
    if (precheckRequestedSkip(precheck)) {
      const prdForCheck = loadPRD(prdPath);
      const post = skippedTaskPostconditionsPass(task, prdForCheck);
      if (post.passed) {
        const precheckSkip = buildPrecheckValidSkipOutcome({ task });
        logProgress(task.id, "--", precheckSkip.logMessage);
        recordTaskTransition(precheckSkip.transition);
        return { action: "return", result: precheckSkip.result };
      }
      logProgress(task.id, "--", precheckInvalidSkipMessage(post));
    }
    const precheckError = precheckErrorMessage(precheck);
    if (precheckError) {
      logProgress(task.id, "--", precheckError);
    }
  }

  const engineBlock = engineBlockBuilder({ task });
  if (engineBlock.shouldBlock) {
    logProgress(task.id, "[SKIP]", engineBlock.logMessage);
    recordTaskTransition(engineBlock.transition);
    logTaskDone(task.id, engineBlock.doneStatus, 0, engineBlock.doneReason);
    return { action: "return", result: engineBlock.result };
  }

  if (task.task_kind === "dry_run_artifact" && config.runner?.deterministic_dry_run_artifacts !== false) {
    const result = dryRunTaskCompleter({
      task,
      prdPath,
      startedAtMs: nowMs(),
      yoloRoot,
      projectRoot,
      loadPRD,
      taskPostconditionsPass,
      recordTaskTransition: (_path, transition) => recordTaskTransition(transition),
      logTaskDone,
      logProgress,
    });
    return { action: "return", result };
  }

  if (task.task_kind === "deterministic_check" || taskRoute.route === "deterministic_check") {
    const prdForPostCheck = loadPRD(prdPath);
    const post = taskPostconditionsPass(task, prdForPostCheck, projectRoot);
    if (!post.passed) {
      const reason = `deterministic_check postconditions failed: ${post.failed.join("; ")}`;
      recordTaskTransition(failTaskTransition({
        taskId: task.id,
        reason,
        result: { deterministic_check: true },
        prdUpdate: { phase: "deterministic_check" },
      }));
      logTaskDone(task.id, "failed", nowMs(), reason);
      return { action: "return", result: { status: "failed", reason } };
    }
    recordTaskTransition(passTaskTransition({
      taskId: task.id,
      result: {
        deterministic_check: true,
        files_changed_total: 0,
        files_changed_business: 0,
        files_changed_metadata: 0,
      },
      prdUpdate: {
        phaseDetail: "deterministic_check",
        completedAt: new Date().toISOString(),
      },
    }));
    logTaskDone(task.id, "completed", nowMs(), "deterministic_check");
    return { action: "return", result: { status: "completed", deterministic_check: true } };
  }

  if (taskRoute.route === "auto_fix") {
    const autoFixResult = await deterministicAutoFix({
      task,
      prdPath,
      startedAtMs: nowMs(),
      projectRoot,
      loadPRD,
      taskPostconditionsPass,
      commitTask,
      recordTaskTransition: (_path, transition) => recordTaskTransition(transition),
      logProgress,
      logTaskBash,
      logTaskDone,
      isBusinessFile,
    });
    if (autoFixResult) return { action: "return", result: autoFixResult };
  }

  const atomicGate = atomicDoctorGate({
    task,
    prdPath,
    config,
    yoloRoot,
    logTaskBash,
  });
  if (!atomicGate.ok) {
    const doctor = atomicGate.result || {};
    const splitResult = doctor.mode === "must_split"
      ? applySplitSuggestionsToPrd(prdPath, task, doctor)
      : { applied: false, childIds: [] };
    const atomicBlock = atomicDoctorBlockBuilder({ task, doctor, splitResult });
    logProgress(task.id, atomicBlock.logMarker, atomicBlock.failReason);
    writeTaskResult(atomicBlock.taskResult);
    if (atomicBlock.prdUpdate) {
      updatePrdTaskStatus(task.id, atomicBlock.prdUpdate);
    }
    logTaskDone(task.id, atomicBlock.doneStatus, 0, atomicBlock.doneReason);
    return { action: "return", result: atomicBlock.result };
  }

  if (attempt > 0) {
    const postPrecheck = postPrecheckInspector({
      task,
      rootDir: projectRoot,
      typeCheckCommand: config.build?.type_check,
      config,
      execSync,
    });
    if (postPrecheck.logMessage) {
      logProgress(task.id, "--", postPrecheck.logMessage);
    }
    if (postPrecheck.shouldSkip) {
      recordTaskTransition(postPrecheck.transition);
      return { action: "return", result: postPrecheck.result };
    }
  }

  return { action: "continue" };
}
