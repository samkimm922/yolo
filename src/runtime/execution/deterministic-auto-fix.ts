import { applyAutoFixTasks as defaultApplyAutoFixTasks } from "../../../lib/auto-fix.js";
import {
  failTaskTransition,
  passTaskTransition,
} from "../task-state/transitions.js";

export function normalizeAutoFixTask(task = {}) {
  const findings = task.fix_findings || task.source_findings || [];
  const firstRule = task.fix_rule || findings[0]?.scanner_id || findings[0]?.rule_id || "";
  return {
    ...task,
    fix_type: "AUTO_FIX",
    fix_rule: firstRule,
    fix_findings: findings.map((finding) => ({
      ...finding,
      file: finding.file || task.scope?.targets?.[0]?.file,
      scanner_id: finding.scanner_id || finding.rule_id || firstRule,
    })),
  };
}

export function buildDeterministicAutoFixResultRecord({
  task = {},
  modifiedFiles = [],
  startedAtMs,
  nowMs = Date.now(),
  isBusinessFile = () => false,
} = {}) {
  const targetFiles = (task.scope?.targets || []).map((target) => target.file).filter(Boolean);
  return {
    deterministic_auto_fix: true,
    duration_sec: ((nowMs - startedAtMs) / 1000).toFixed(1),
    files_changed_total: modifiedFiles.length,
    files_changed_business: modifiedFiles.filter(isBusinessFile).length,
    files_changed_metadata: modifiedFiles.filter((file) => !isBusinessFile(file)).length,
    scope_targets_touched: targetFiles.filter((file) => modifiedFiles.includes(file)),
    scope_targets_missed: targetFiles.filter((file) => !modifiedFiles.includes(file)),
    out_of_scope_files: [],
  };
}

export async function tryDeterministicAutoFixTask({
  task,
  prdPath,
  startedAtMs,
  projectRoot,
  applyAutoFixTasks = defaultApplyAutoFixTasks,
  loadPRD,
  taskPostconditionsPass,
  commitTask,
  recordTaskTransition,
  logProgress = () => {},
  logTaskBash = () => {},
  logTaskDone = () => {},
  isBusinessFile = () => false,
} = {}) {
  const result = await applyAutoFixTasks([normalizeAutoFixTask(task)], projectRoot, { logP: logProgress });
  const modifiedFiles = result.modifiedFiles || [];

  logTaskBash(task.id, "deterministic-auto-fix", result.success ? "pass" : "fail", JSON.stringify({
    stats: result.stats,
    modifiedFiles,
    escalated: result.escalatedTasks?.length || 0,
  }).slice(0, 500));

  if (!result.success || modifiedFiles.length === 0) {
    logProgress(task.id, "auto", `deterministic auto-fix 未完成，回退 provider: escalated=${result.escalatedTasks?.length || 0}`);
    return null;
  }

  const prdForPostCheck = loadPRD(prdPath);
  const post = taskPostconditionsPass(task, prdForPostCheck, projectRoot);
  if (!post.passed) {
    const reason = `deterministic auto-fix postconditions failed: ${post.failed.join("; ")}`;
    logProgress(task.id, "!!", reason);
    recordTaskTransition(prdPath, failTaskTransition({
      taskId: task.id,
      reason,
      prdUpdate: { phase: "auto_fix" },
    }));
    return { status: "failed", reason };
  }

  const commitResult = await commitTask(task, prdPath, modifiedFiles);
  if (!commitResult.committed && !commitResult.skippedCommit) {
    return { status: "failed", reason: "deterministic_auto_fix_commit_failed" };
  }

  recordTaskTransition(prdPath, passTaskTransition({
    taskId: task.id,
    result: buildDeterministicAutoFixResultRecord({
      task,
      modifiedFiles,
      startedAtMs,
      isBusinessFile,
    }),
    prdUpdate: {
      phaseDetail: "deterministic_auto_fix",
      completedAt: new Date().toISOString(),
    },
  }));
  logTaskDone(task.id, "completed", Date.now() - startedAtMs, "deterministic_auto_fix");
  return { status: "completed", deterministic_auto_fix: true };
}
