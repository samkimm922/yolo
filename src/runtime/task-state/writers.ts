import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

function clean(value) {
  return typeof value === "string" ? value.trim() : value;
}

function firstPresent(...values) {
  return values.find((value) => clean(value) !== undefined && clean(value) !== null && clean(value) !== "");
}

function taskResultError(field, reason = "missing") {
  return new Error(`Invalid task result: ${field} ${reason}`);
}

function normalizeAttemptId({ taskId, record = {}, options = {} } = {}) {
  const explicit = firstPresent(
    record.attempt_id,
    record.attemptId,
    options.attempt_id,
    options.attemptId,
    record.session_id,
    record.sessionId,
  );
  if (explicit !== undefined && explicit !== null && explicit !== "") return String(explicit);
  const attempt = firstPresent(record.attempt, record.retries, options.attempt, options.retries);
  if (attempt !== undefined && attempt !== null && attempt !== "") {
    return `${taskId}-attempt-${Number(attempt) || 0}`;
  }
  if (options.allowInitialAttempt === true || options.allow_initial_attempt === true) {
    return `${taskId}-attempt-0`;
  }
  return "";
}

export function normalizeTaskResultRecord(record = {}, options = {}) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw taskResultError("record", "must be an object");
  }
  const now = options.now || new Date().toISOString();
  const taskId = firstPresent(record.task_id, record.taskId, record.id, options.task_id, options.taskId);
  const runId = firstPresent(record.run_id, record.runId, options.run_id, options.runId);
  const workspaceRoot = firstPresent(record.workspace_root, record.workspaceRoot, options.workspace_root, options.workspaceRoot);
  if (!taskId) throw taskResultError("task_id");
  if (!runId) throw taskResultError("run_id");
  if (!workspaceRoot) throw taskResultError("workspace_root");
  const attemptId = normalizeAttemptId({ taskId, record, options });
  if (!attemptId) throw taskResultError("attempt_id");

  return {
    ...record,
    id: record.id || taskId,
    task_id: taskId,
    run_id: runId,
    attempt_id: attemptId,
    workspace_root: workspaceRoot,
    timestamp: record.timestamp || now,
  };
}

export function appendTaskResult(resultsFile, record, options = {}) {
  const payload = normalizeTaskResultRecord(record, options);
  appendFileSync(resultsFile, `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
}

export function updatePrdTaskStatusFile(prdPath, taskId, update) {
  try {
    const raw = readFileSync(prdPath, "utf8");
    const prd = JSON.parse(raw);
    const task = (prd.tasks || []).find((item) => item.id === taskId);
    if (!task) return { wrote: false, reason: "task_not_found" };

    Object.assign(task, update);
    const tmp = `${prdPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(prd, null, 2), "utf8");
    renameSync(tmp, prdPath);
    return { wrote: true, task, prd };
  } catch (error) {
    return { wrote: false, reason: "write_failed", error };
  }
}
