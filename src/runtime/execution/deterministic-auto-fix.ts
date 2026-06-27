import { applyAutoFixTasks as defaultApplyAutoFixTasks } from "../../lib/auto-fix.js";
import {
  failTaskTransition,
  passTaskTransition,
} from "../task-state/transitions.js";

type AutoFixFinding = {
  file?: string;
  scanner_id?: string;
  rule_id?: string;
  [key: string]: unknown;
};

type AutoFixTask = {
  id?: string;
  fix_rule?: string;
  fix_type?: string;
  fix_findings?: AutoFixFinding[];
  source_findings?: AutoFixFinding[];
  scope?: { targets?: Array<{ file?: string }> };
  [key: string]: unknown;
};

type AutoFixTaskWithId = AutoFixTask & { id: string };

type IsBusinessFileFn = (file: string) => boolean;
type LogFn = (...args: unknown[]) => void;

interface BuildDeterministicAutoFixResultRecordArgs {
  task?: AutoFixTask;
  modifiedFiles?: string[];
  startedAtMs: number;
  nowMs?: number;
  isBusinessFile?: IsBusinessFileFn;
}

interface TryDeterministicAutoFixTaskArgs {
  task: AutoFixTaskWithId;
  prdPath: string;
  startedAtMs: number;
  projectRoot: string;
  applyAutoFixTasks?: typeof defaultApplyAutoFixTasks;
  loadPRD: (prdPath: string) => unknown;
  taskPostconditionsPass: (task: AutoFixTask, prd: unknown, projectRoot?: string) => { passed: boolean; failed: string[] };
  commitTask: (task: AutoFixTask, prdPath: string, files: string[]) => Promise<{ committed?: boolean; skippedCommit?: boolean; [key: string]: unknown }>;
  recordTaskTransition: (prdPath: string, transition: unknown) => unknown;
  logProgress?: LogFn;
  logTaskBash?: LogFn;
  logTaskDone?: LogFn;
  isBusinessFile?: IsBusinessFileFn;
}

export function normalizeAutoFixTask(task: AutoFixTask = Object()): AutoFixTask {
  const findings: AutoFixFinding[] = task.fix_findings || task.source_findings || [];
  const firstRule = task.fix_rule || findings[0]?.scanner_id || findings[0]?.rule_id || "";
  return {
    ...task,
    fix_type: "AUTO_FIX",
    fix_rule: firstRule,
    fix_findings: findings.map((finding: AutoFixFinding) => ({
      ...finding,
      file: finding.file || task.scope?.targets?.[0]?.file,
      scanner_id: finding.scanner_id || finding.rule_id || firstRule,
    })),
  };
}

export function buildDeterministicAutoFixResultRecord({
  task = Object(),
  modifiedFiles = [],
  startedAtMs,
  nowMs = Date.now(),
  isBusinessFile = () => false,
}: BuildDeterministicAutoFixResultRecordArgs = Object()) {
  const targetFiles = (task.scope?.targets || []).map((target: { file?: string }) => target.file).filter(Boolean);
  return {
    deterministic_auto_fix: true,
    duration_sec: ((nowMs - startedAtMs) / 1000).toFixed(1),
    files_changed_total: modifiedFiles.length,
    files_changed_business: modifiedFiles.filter((file: string) => isBusinessFile(file)).length,
    files_changed_metadata: modifiedFiles.filter((file: string) => !isBusinessFile(file)).length,
    scope_targets_touched: targetFiles.filter((file) => modifiedFiles.includes(file as string)),
    scope_targets_missed: targetFiles.filter((file) => !modifiedFiles.includes(file as string)),
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
  logProgress = (..._args: unknown[]) => {},
  logTaskBash = (..._args: unknown[]) => {},
  logTaskDone = (..._args: unknown[]) => {},
  isBusinessFile = () => false,
}: TryDeterministicAutoFixTaskArgs = Object()) {
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
