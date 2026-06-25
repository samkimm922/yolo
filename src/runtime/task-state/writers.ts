import { appendFileSync } from "node:fs";
import { redactDeep } from "../../lib/security/redact.js";
import { writeStateAtomic } from "../persist/atomic-state.js";
import { readJsonFileBounded } from "../../lib/bounded-read.js";

type TaskStateRecord = Record<string, unknown>;

type TaskResultRecord = TaskStateRecord & {
  id?: unknown;
  task_id?: unknown;
  taskId?: unknown;
  run_id?: unknown;
  runId?: unknown;
  workspace_root?: unknown;
  workspaceRoot?: unknown;
  attempt_id?: unknown;
  attemptId?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  attempt?: unknown;
  retries?: unknown;
  timestamp?: unknown;
};

type TaskResultOptions = TaskStateRecord & {
  now?: unknown;
  task_id?: unknown;
  taskId?: unknown;
  run_id?: unknown;
  runId?: unknown;
  workspace_root?: unknown;
  workspaceRoot?: unknown;
  attempt_id?: unknown;
  attemptId?: unknown;
  attempt?: unknown;
  retries?: unknown;
  allowInitialAttempt?: unknown;
  allow_initial_attempt?: unknown;
};

type NormalizeAttemptIdInput = {
  taskId?: unknown;
  record?: TaskResultRecord;
  options?: TaskResultOptions;
};

type PrdTaskRecord = TaskStateRecord & {
  id?: unknown;
};

type PrdDocument = TaskStateRecord & {
  tasks?: Array<PrdTaskRecord | null | string | number | boolean>;
};

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : value;
}

function firstPresent(...values: unknown[]) {
  return values.find((value) => clean(value) !== undefined && clean(value) !== null && clean(value) !== "");
}

function taskResultError(field: string, reason = "missing") {
  return new Error(`Invalid task result: ${field} ${reason}`);
}

function normalizeAttemptId({ taskId, record = Object(), options = Object() }: NormalizeAttemptIdInput = Object()) {
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

export function normalizeTaskResultRecord(record: TaskResultRecord = Object(), options: TaskResultOptions = Object()) {
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

export function appendTaskResult(resultsFile: Parameters<typeof appendFileSync>[0], record: TaskResultRecord, options: TaskResultOptions = Object()) {
  const payload = normalizeTaskResultRecord(record, options);
  const safe = redactDeep(payload);
  appendFileSync(resultsFile, `${JSON.stringify(safe)}\n`, "utf8");
  return payload;
}

export function updatePrdTaskStatusFile(prdPath: string, taskId: string, update: TaskStateRecord) {
  try {
    const prd = readJsonFileBounded<PrdDocument>(prdPath, { errorCode: "PRD_JSON_SIZE_LIMIT_EXCEEDED" });
    // Guard: legacy/migrated PRDs may contain null/non-object entries inside `tasks`.
    // Without this, `.find((item) => item.id === taskId)` throws TypeError on null
    // entries, which is caught by the outer try/catch and silently reported as
    // `write_failed` — dropping the status update for an otherwise-valid task.
    const task = (Array.isArray(prd.tasks) ? prd.tasks : []).find(
      (item) => item && typeof item === "object" && item.id === taskId,
    );
    if (!task) return { wrote: false, reason: "task_not_found" };

    Object.assign(task, update);
    writeStateAtomic(prdPath, prd);
    return { wrote: true, task, prd };
  } catch (error) {
    return { wrote: false, reason: "write_failed", error };
  }
}
