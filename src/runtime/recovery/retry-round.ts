import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Append `items` to `target`, omitting ids already present (in either the
 * existing target or the items added so far). Mutates and returns `target`.
 */
export function appendUniqueIds(target: string[], items: string[] = []) {
  const seen = new Set(target);
  for (const item of items) {
    if (!seen.has(item)) {
      target.push(item);
      seen.add(item);
    }
  }
}

/**
 * Remove every id in `items` from `target`, preserving order of the rest.
 * Mutates `target` in place (compacts via a write index).
 */
export function removeIds(target: string[], items: string[] = []) {
  const removing = new Set(items);
  let writeIndex = 0;
  for (const item of target) {
    if (!removing.has(item)) {
      target[writeIndex++] = item;
    }
  }
  target.length = writeIndex;
}

/** Task ids / per-task outcome collections shared across retry rounds. */
interface TaskResultSets {
  completed?: string[];
  failed?: string[];
  skipped?: string[];
  blocked?: string[];
  contractReview?: string[];
  stop_reason?: string;
}
/** A task definition as read from a PRD or expanded-task snapshot. */
interface RetryTask {
  id: string;
  status?: unknown;
  task_kind?: unknown;
  source?: unknown;
  [key: string]: unknown;
}

/** A PRD document (subset of fields recovery reads/writes). */
interface RetryPrd {
  id?: unknown;
  title?: unknown;
  generated_by?: unknown;
  tasks?: RetryTask[];
  source_prd?: unknown;
  retry_of?: unknown;
  retry_round?: unknown;
  parent_run_id?: unknown;
  [key: string]: unknown;
}

export function loadExpandedTasksForRetryFile(expandedTasksFile: string): RetryTask[] {
  if (!existsSync(expandedTasksFile)) return [];
  try {
    const data = JSON.parse(readFileSync(expandedTasksFile, "utf8"));
    return Array.isArray(data.tasks) ? data.tasks : [];
  } catch {
    return [];
  }
}

export function findRetryTaskById(
  id: string,
  prd: RetryPrd = {},
  expandedTasks: RetryTask[] = [],
): RetryTask | null {
  return (prd.tasks || []).find((task) => task.id === id) ||
    expandedTasks.find((task) => task.id === id) ||
    null;
}

export function prepareRetryTasks({
  failedIds = [],
  prd = {},
  expandedTasks = [],
}: {
  failedIds?: string[];
  prd?: RetryPrd;
  expandedTasks?: RetryTask[];
}) {
  const missingRetryTaskIds: string[] = [];
  const retryTasks = failedIds
    .map((id) => {
      const original = findRetryTaskById(id, prd, expandedTasks);
      if (!original) {
        missingRetryTaskIds.push(id);
        return null;
      }
      return { ...original, status: "pending" };
    })
    .filter(Boolean) as RetryTask[];

  return { retryTasks, missingRetryTaskIds };
}

export function buildRetryPrd({
  prd,
  prdPath,
  retryTasks,
  round,
  parentRunId,
  normalizePrdPath = (value) => value,
}: {
  prd: RetryPrd;
  prdPath: string;
  retryTasks: RetryTask[];
  round: number;
  parentRunId: unknown;
  normalizePrdPath?: (value: string) => string;
}) {
  return {
    ...prd,
    title: `${prd.title} — 重试第${round}轮`,
    source_prd: normalizePrdPath(prdPath).replace(/^scripts\/yolo\//, ""),
    retry_of: prd.id || normalizePrdPath(prdPath),
    retry_round: round,
    parent_run_id: parentRunId,
    generated_by: prd.generated_by || "other",
    tasks: retryTasks,
  };
}

export function writeRetryPrdFile({
  yoloRoot,
  retryPrd,
  round,
  nowMs = Date.now(),
}: {
  yoloRoot: string;
  retryPrd: RetryPrd;
  round: number;
  nowMs?: number;
}) {
  const filePath = join(yoloRoot, "data", `retry-round${round}-${nowMs}.json`);
  writeFileSync(filePath, JSON.stringify(retryPrd, null, 2));
  return filePath;
}

export function buildRetryCompletedSet({
  resumeCompleted = new Set<string>(),
  completed = [],
  skipped = [],
}: {
  resumeCompleted?: Set<string>;
  completed?: string[];
  skipped?: string[];
}) {
  return new Set<string>([
    ...resumeCompleted,
    ...completed,
    ...skipped,
  ]);
}

export function retryBlockedFailureIds(retryResults: TaskResultSets = {}) {
  const contractReview = new Set(retryResults.contractReview || []);
  return (retryResults.blocked || []).filter((id) => !contractReview.has(id));
}

export function syncRetryCompletions({
  retryResults = {},
  prd = {},
  taskResults,
  taskPostconditionsPass,
  updateTaskStatus,
  log = (..._args: unknown[]) => {},
}: {
  retryResults?: TaskResultSets;
  prd?: RetryPrd;
  taskResults: TaskResultSets & { completed: string[]; failed: string[]; skipped: string[] };
  taskPostconditionsPass: (task: RetryTask, prd: RetryPrd) => { passed: boolean; failed: string[] };
  updateTaskStatus: (id: string, update: Record<string, unknown>) => void;
  log?: (...args: unknown[]) => void;
}) {
  const synced: string[] = [];
  const blocked: { id: string; failed: string[] }[] = [];

  for (const id of retryResults.completed || []) {
    const originalTask = (prd.tasks || []).find((task) => task.id === id);
    if (!originalTask) continue;
    if (originalTask.task_kind === "dry_run_artifact") {
      const post = taskPostconditionsPass(originalTask, prd);
      if (!post.passed) {
        appendUniqueIds(taskResults.failed, [id]);
        blocked.push({ id, failed: post.failed });
        log("RETRY", "BLOCKED", `${id} retry 声称完成，但主工作区 post_conditions 未满足: ${post.failed.join("; ")}`);
        continue;
      }
    }
    updateTaskStatus(id, {
      status: "done",
      phase: "done",
      completedViaRetry: true,
      failReason: undefined,
    });
    synced.push(id);
  }

  return { synced, blocked };
}

export function mergeRetryRoundResults({
  taskResults,
  retryResults,
}: {
  taskResults: TaskResultSets & { completed: string[]; failed: string[]; skipped: string[] };
  retryResults: TaskResultSets;
}) {
  appendUniqueIds(taskResults.completed, retryResults.completed || []);
  appendUniqueIds(taskResults.failed, retryResults.failed || []);
  appendUniqueIds(taskResults.failed, retryBlockedFailureIds(retryResults));
  appendUniqueIds(taskResults.skipped, retryResults.skipped || []);
  removeIds(taskResults.failed, [
    ...(retryResults.completed || []),
    ...(retryResults.skipped || []),
  ]);
  return taskResults;
}

export function cleanupRetryPrdFile(filePath: string) {
  try {
    unlinkSync(filePath);
    return { deleted: true };
  } catch (error) {
    return { deleted: false, error };
  }
}
