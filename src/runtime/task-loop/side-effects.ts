import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { writeStateAtomic } from "../persist/atomic-state.js";
import { redactDeep } from "../../lib/security/redact.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function result<T extends Record<string, unknown>>(error: unknown, fallback: T): T & { error?: unknown } {
  if (!error) return fallback;
  return { ...fallback, error };
}

interface WriteSnapshotResult {
  wrote: boolean;
  payload?: unknown;
  task?: Record<string, unknown>;
  reason?: string;
  error?: unknown;
  filePath?: string;
}

interface RunAnalyzerResult {
  ran: boolean;
  scriptPath?: string;
  reason?: string;
  error?: unknown;
}

export function buildExpandedTasksSnapshot({
  source,
  tasks = [],
  completedIds = new Set<string>(),
  now = new Date().toISOString(),
}: {
  source?: unknown;
  tasks?: unknown;
  completedIds?: Set<string>;
  now?: string;
} = Object()) {
  return {
    source,
    updatedAt: now,
    tasks: asArray<unknown>(tasks)
      .filter((task) => {
        const rec = asRecord(task);
        return !completedIds.has(asString(rec.id));
      })
      .map((task) => {
        const rec = asRecord(task);
        return {
          ...rec,
          status: rec.status === "completed" ? "done" : rec.status,
        };
      }),
  };
}

export function writeExpandedTasksSnapshot({
  filePath,
  source,
  tasks = [],
  completedIds = new Set<string>(),
  now = undefined,
}: {
  filePath: string;
  source?: unknown;
  tasks?: unknown;
  completedIds?: Set<string>;
  now?: string;
}): WriteSnapshotResult {
  try {
    const raw = buildExpandedTasksSnapshot({ source, tasks, completedIds, now });
    const payload = redactDeep(raw);
    mkdirSync(dirname(filePath), { recursive: true });
    writeStateAtomic(filePath, payload);
    return { wrote: true, payload };
  } catch (error) {
    return result(error, { wrote: false, reason: "write_failed" });
  }
}

export function updateExpandedTaskSnapshot({
  filePath,
  taskId,
  outcome,
  now = new Date().toISOString(),
}: {
  filePath: string;
  taskId: string;
  outcome: unknown;
  now?: string;
}): WriteSnapshotResult {
  try {
    if (!existsSync(filePath)) return { wrote: false, reason: "snapshot_missing" };
    const payload = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const tasksArr = asArray<Record<string, unknown>>(payload.tasks);
    const idx = tasksArr.findIndex((task) => asRecord(task).id === taskId);
    if (idx < 0) return { wrote: false, reason: "task_not_found" };

    const outcomeRec = asRecord(outcome);
    const taskRec = tasksArr[idx] as Record<string, unknown>;
    taskRec.status = outcomeRec.status === "completed" ? "done" : outcomeRec.status;
    if (outcomeRec.skip_kind) taskRec.skip_kind = outcomeRec.skip_kind;
    if (outcomeRec.counts_as_completed != null) taskRec.counts_as_completed = outcomeRec.counts_as_completed;
    if (outcomeRec.reason) taskRec.failReason = redactDeep(outcomeRec.reason);
    taskRec.updatedAt = now;
    payload.tasks = tasksArr;
    writeStateAtomic(filePath, payload);
    return { wrote: true, payload, task: taskRec };
  } catch (error) {
    return result(error, { wrote: false, reason: "update_failed" });
  }
}

export function writeProgressSnapshot({
  stateDir,
  completedIds,
  failedIds,
  now = new Date().toISOString(),
}: {
  stateDir: string;
  completedIds: Set<string> | Iterable<string> | undefined;
  failedIds: Set<string> | Iterable<string> | undefined;
  now?: string;
}): WriteSnapshotResult {
  try {
    const snapshotDir = join(stateDir, "runtime");
    mkdirSync(snapshotDir, { recursive: true });
    const completed = [...(completedIds || [])];
    const failed = [...(failedIds || [])];
    const payload = {
      ts: now,
      completed,
      failed,
      total: completed.length + failed.length,
    };
    const filePath = join(snapshotDir, "progress-snapshot.json");
    writeStateAtomic(filePath, payload);
    return { wrote: true, filePath, payload };
  } catch (error) {
    return result(error, { wrote: false, reason: "write_failed" });
  }
}

type ExecFileLike = (file: string, args: string[], options: Record<string, unknown>) => unknown;

const defaultExecFile: ExecFileLike = (file, args, options) =>
  execFileSync(file, args, options as Parameters<typeof execFileSync>[2]);

export function runLessonsAnalyzer({
  yoloRoot,
  nodeBin = process.execPath,
  timeout = 10000,
  execFile = defaultExecFile,
}: {
  yoloRoot: string;
  nodeBin?: string;
  timeout?: number;
  execFile?: ExecFileLike;
} = Object() as { yoloRoot: string }): RunAnalyzerResult {
  try {
    const scriptPath = join(yoloRoot, "lessons-analyzer.js");
    if (!existsSync(scriptPath)) return { ran: false, reason: "missing_script", scriptPath };
    execFile(nodeBin, [scriptPath], {
      cwd: yoloRoot,
      encoding: "utf8",
      timeout,
      stdio: "pipe",
    });
    return { ran: true, scriptPath };
  } catch (error) {
    return result(error, { ran: false, reason: "execution_failed" });
  }
}
