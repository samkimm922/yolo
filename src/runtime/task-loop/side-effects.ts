import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

function result(error, fallback) {
  if (!error) return fallback;
  return { ...fallback, error };
}

export function buildExpandedTasksSnapshot({ source, tasks = [], completedIds = new Set(), now = new Date().toISOString() }) {
  return {
    source,
    updatedAt: now,
    tasks: tasks
      .filter((task) => !completedIds.has(task.id))
      .map((task) => ({
        ...task,
        status: task.status === "completed" ? "done" : task.status,
      })),
  };
}

export function writeExpandedTasksSnapshot({ filePath, source, tasks = [], completedIds = new Set(), now }) {
  try {
    const payload = buildExpandedTasksSnapshot({ source, tasks, completedIds, now });
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return { wrote: true, payload };
  } catch (error) {
    return result(error, { wrote: false, reason: "write_failed" });
  }
}

export function updateExpandedTaskSnapshot({ filePath, taskId, outcome, now = new Date().toISOString() }) {
  try {
    if (!existsSync(filePath)) return { wrote: false, reason: "snapshot_missing" };
    const payload = JSON.parse(readFileSync(filePath, "utf8"));
    const idx = (payload.tasks || []).findIndex((task) => task.id === taskId);
    if (idx < 0) return { wrote: false, reason: "task_not_found" };

    payload.tasks[idx].status = outcome.status === "completed" ? "done" : outcome.status;
    if (outcome.skip_kind) payload.tasks[idx].skip_kind = outcome.skip_kind;
    if (outcome.counts_as_completed != null) payload.tasks[idx].counts_as_completed = outcome.counts_as_completed;
    if (outcome.reason) payload.tasks[idx].failReason = outcome.reason;
    payload.tasks[idx].updatedAt = now;
    writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return { wrote: true, payload, task: payload.tasks[idx] };
  } catch (error) {
    return result(error, { wrote: false, reason: "update_failed" });
  }
}

export function writeProgressSnapshot({ stateDir, completedIds, failedIds, now = new Date().toISOString() }) {
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
    writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return { wrote: true, filePath, payload };
  } catch (error) {
    return result(error, { wrote: false, reason: "write_failed" });
  }
}

export function runLessonsAnalyzer({
  yoloRoot,
  nodeBin = process.execPath,
  timeout = 10000,
  execFile = execFileSync,
} = {}) {
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
