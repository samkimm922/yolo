import { skipTaskTransition } from "../task-state/transitions.js";
import { taskForValidSkipPostconditions } from "./post-precheck.js";

export function precheckRequestedSkip(precheck = {}) {
  return String(precheck.stdout || "").includes("PRE-CHECK SKIP");
}

export function buildPrecheckValidSkipOutcome({ task = {} } = {}) {
  const skipTask = taskForValidSkipPostconditions(task);
  return {
    logMessage: "precheck: 已修复，post_conditions 已满足，跳过",
    transition: skipTaskTransition({
      taskId: task.id,
      reason: "precheck: 目标模式已不存在且 post_conditions 已满足",
      result: {
        skip_kind: "valid_skip_already_satisfied",
        counts_as_completed: true,
        postcondition_verified: true,
      },
      prdUpdate: {
        scope: skipTask.scope,
        skip_kind: "valid_skip_already_satisfied",
        counts_as_completed: true,
        phase: "done",
        phaseDetail: "precheck: 目标模式已不存在且 post_conditions 已满足",
      },
    }),
    result: {
      status: "skipped",
      skip_kind: "valid_skip_already_satisfied",
      counts_as_completed: true,
      reason: "precheck",
    },
  };
}

export function precheckInvalidSkipMessage(postResult = {}) {
  return `precheck 想跳过，但 post_conditions 未满足: ${(postResult.failed || []).join("; ")}，继续执行修复`;
}

export function precheckErrorMessage(precheck = {}) {
  if (precheck.ok) return null;
  return `precheck 错误: ${precheck.stderr || precheck.stdout?.slice(0, 100) || "unknown"}，继续执行`;
}
