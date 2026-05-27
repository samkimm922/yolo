import { blockedTaskTransition } from "../task-state/transitions.js";

export const DEFAULT_ENGINE_PATHS = ["scripts/yolo/", ".yolo-backup/", ".claude/"];

export function isAllowedDryRunArtifactTarget(task = {}, file = "") {
  return task.task_kind === "dry_run_artifact" && String(file || "").startsWith("scripts/yolo/state/dry-run/");
}

export function taskTargetsEngineFiles(task = {}, enginePaths = DEFAULT_ENGINE_PATHS) {
  return (task.scope?.targets || []).some((target) => {
    const file = target.file || "";
    return enginePaths.some((enginePath) => file.startsWith(enginePath)) && !isAllowedDryRunArtifactTarget(task, file);
  });
}

export function buildEngineSelfModificationBlockOutcome({
  task = {},
  reason = "engine_self_modify_blocked",
} = {}) {
  if (!taskTargetsEngineFiles(task)) {
    return { shouldBlock: false };
  }
  return {
    shouldBlock: true,
    logMessage: "targets engine files, blocked (engine_self_modify_blocked)",
    transition: blockedTaskTransition({
      taskId: task.id,
      reason,
      result: {
        skip_kind: "blocked_skip_missing_evidence",
        counts_as_completed: false,
      },
      prdUpdate: {
        phase: "blocked",
        phaseDetail: reason,
        skipReason: reason,
        skip_kind: "blocked_skip_missing_evidence",
        counts_as_completed: false,
      },
    }),
    doneStatus: "blocked",
    doneReason: reason,
    result: { status: "blocked", skip_kind: "blocked_skip_missing_evidence", reason },
  };
}
