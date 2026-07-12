import { blockedTaskTransition } from "../task-state/transitions.js";

export const DEFAULT_ENGINE_PATHS = ["scripts/yolo/", ".yolo-backup/", ".claude/"];

export function isAllowedDryRunArtifactTarget(task = Object(), file = "") {
  return task.task_kind === "dry_run_artifact" && String(file || "").startsWith("scripts/yolo/state/dry-run/");
}

// Recovery guidance keyed by enginePath. This is policy (what the operator should do
// for each protected engine path), not a file list — the file list comes from the
// task's own targets. Each entry gives the concrete alternative workflow so the block
// never leaves the operator at a dead end.
const ENGINE_PATH_REMEDIATIONS = {
  "scripts/yolo/": (files) => [
    `Move the change to ${files.join(", ")} into a separately reviewed engine PR (engine_self_modify_blocked): engine source under scripts/yolo/ must ship through the reviewed engine workflow, not this task.`,
    "If this task only needs to refresh generated state, route it as a deterministic_check or dry_run_artifact instead of editing engine source directly.",
  ],
  ".yolo-backup/": (files) => [
    `Do not edit ${files.join(", ")} directly (engine_self_modify_blocked): .yolo-backup/ is restored by the engine. Regenerate backups via the engine's own backup workflow rather than hand-editing them.`,
  ],
  ".claude/": (files) => [
    `Maintain ${files.join(", ")} via 'yolo init' or the project setup workflow (engine_self_modify_blocked): agent/settings files under .claude/ must be updated through setup so they stay consistent across the engine.`,
  ],
};

function remediationForEnginePath(enginePath, files) {
  const build = ENGINE_PATH_REMEDIATIONS[enginePath];
  if (build) return build(files);
  // Generic fallback for any enginePath without an explicit recipe — still actionable,
  // never just "blocked". Points the operator at the reviewed engine workflow.
  return [
    `Move the change to ${files.join(", ")} into a separately reviewed engine PR (engine_self_modify_blocked): '${enginePath}' is a protected engine path and cannot be edited by this task.`,
  ];
}

export function buildEngineSelfModificationRemediation(matchedPaths = [], matchedEnginePaths = []) {
  const nextActions = [];
  for (const enginePath of matchedEnginePaths) {
    const filesForPath = matchedPaths.filter((file) => String(file).startsWith(enginePath));
    nextActions.push(...remediationForEnginePath(enginePath, filesForPath));
  }
  if (nextActions.length === 0) {
    // Defensive: should never happen because a block implies at least one matched path,
    // but keep the outcome actionable rather than empty if it ever does.
    nextActions.push("Route this change through a separately reviewed engine PR instead of the current task (engine_self_modify_blocked).");
  }
  return { next_actions: nextActions };
}

// Collects the specific files (and which enginePath each matched) that trigger the
// engine self-modification block. Returns empty lists when nothing matches. Order
// follows the task's target declaration order, deduplicated.
export function findEngineSelfModificationMatches(task = Object(), enginePaths = DEFAULT_ENGINE_PATHS) {
  const targets = task.scope?.targets || [];
  const matchedPaths = [];
  const matchedEnginePaths = [];
  const seenPaths = new Set();
  const seenEnginePaths = new Set();
  for (const target of targets) {
    const file = String(target?.file || "");
    if (!file) continue;
    if (isAllowedDryRunArtifactTarget(task, file)) continue;
    const enginePath = enginePaths.find((candidate) => file.startsWith(candidate));
    if (!enginePath) continue;
    if (!seenPaths.has(file)) {
      seenPaths.add(file);
      matchedPaths.push(file);
    }
    if (!seenEnginePaths.has(enginePath)) {
      seenEnginePaths.add(enginePath);
      matchedEnginePaths.push(enginePath);
    }
  }
  return { matchedPaths, matchedEnginePaths };
}

export function taskTargetsEngineFiles(task = Object(), enginePaths = DEFAULT_ENGINE_PATHS) {
  const { matchedPaths } = findEngineSelfModificationMatches(task, enginePaths);
  return matchedPaths.length > 0;
}

export function buildEngineSelfModificationBlockOutcome({
  task = Object(),
  reason = "engine_self_modify_blocked",
} = Object()) {
  const { matchedPaths, matchedEnginePaths } = findEngineSelfModificationMatches(task);
  if (matchedPaths.length === 0) {
    return { shouldBlock: false };
  }
  const remediation = buildEngineSelfModificationRemediation(matchedPaths, matchedEnginePaths);
  const logMessage = [
    `engine self-modification blocked (${reason})`,
    `matched: ${matchedPaths.join(", ")}`,
    `engine paths: ${matchedEnginePaths.join(", ")}`,
    `recovery: ${remediation.next_actions.join(" | ")}`,
  ].join(" — ");

  return {
    shouldBlock: true,
    logMessage,
    matched_paths: matchedPaths,
    matched_engine_paths: matchedEnginePaths,
    remediation,
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
    result: {
      status: "blocked",
      skip_kind: "blocked_skip_missing_evidence",
      reason,
      matched_paths: matchedPaths,
      matched_engine_paths: matchedEnginePaths,
      remediation,
    },
  };
}
