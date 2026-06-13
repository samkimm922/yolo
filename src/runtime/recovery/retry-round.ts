import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function appendUniqueIds(target, items = []) {
  const seen = new Set(target);
  for (const item of items) {
    if (!seen.has(item)) {
      target.push(item);
      seen.add(item);
    }
  }
}

export function removeIds(target, items = []) {
  const removing = new Set(items);
  let writeIndex = 0;
  for (const item of target) {
    if (!removing.has(item)) {
      target[writeIndex++] = item;
    }
  }
  target.length = writeIndex;
}

export function loadExpandedTasksForRetryFile(expandedTasksFile) {
  if (!existsSync(expandedTasksFile)) return [];
  try {
    const data = JSON.parse(readFileSync(expandedTasksFile, "utf8"));
    return Array.isArray(data.tasks) ? data.tasks : [];
  } catch {
    return [];
  }
}

export function findRetryTaskById(id, prd = Object(), expandedTasks = []) {
  return (prd.tasks || []).find((task) => task.id === id) ||
    expandedTasks.find((task) => task.id === id) ||
    null;
}

export function prepareRetryTasks({ failedIds = [], prd = Object(), expandedTasks = [] }) {
  const missingRetryTaskIds = [];
  const retryTasks = failedIds
    .map((id) => {
      const original = findRetryTaskById(id, prd, expandedTasks);
      if (!original) {
        missingRetryTaskIds.push(id);
        return null;
      }
      return { ...original, status: "pending" };
    })
    .filter(Boolean);

  return { retryTasks, missingRetryTaskIds };
}

export function buildRetryPrd({
  prd,
  prdPath,
  retryTasks,
  round,
  parentRunId,
  normalizePrdPath = (value) => value,
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

export function writeRetryPrdFile({ yoloRoot, retryPrd, round, nowMs = Date.now() }) {
  const filePath = join(yoloRoot, "data", `retry-round${round}-${nowMs}.json`);
  writeFileSync(filePath, JSON.stringify(retryPrd, null, 2));
  return filePath;
}

export function buildRetryCompletedSet({ resumeCompleted = new Set(), completed = [], skipped = [] }) {
  return new Set([
    ...resumeCompleted,
    ...completed,
    ...skipped,
  ]);
}

export function retryBlockedFailureIds(retryResults = Object()) {
  const contractReview = new Set(retryResults.contractReview || []);
  return (retryResults.blocked || []).filter((id) => !contractReview.has(id));
}

export function syncRetryCompletions({
  retryResults = Object(),
  prd = Object(),
  taskResults,
  taskPostconditionsPass,
  updateTaskStatus,
  log = (..._args) => {},
}) {
  const synced = [];
  const blocked = [];

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

export function mergeRetryRoundResults({ taskResults, retryResults }) {
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

export function cleanupRetryPrdFile(filePath) {
  try {
    unlinkSync(filePath);
    return { deleted: true };
  } catch (error) {
    return { deleted: false, error };
  }
}
