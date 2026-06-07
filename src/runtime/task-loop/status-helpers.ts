export function mergedSourceTaskIds(task = {}) {
  return Array.isArray(task.merged_from) ? task.merged_from.filter((id) => id && id !== task.id) : [];
}

export function updateMergedSourceTasks({ task, update = {}, updateTaskStatus, now = new Date().toISOString() }) {
  const ids = mergedSourceTaskIds(task);
  if (ids.length === 0) return [];
  for (const id of ids) {
    updateTaskStatus(id, {
      ...update,
      merged_into: task.id,
      updatedAt: now,
    });
  }
  return ids;
}

export function deriveParentTaskId(taskId) {
  if (!taskId) return taskId;
  return taskId
    .replace(/(-[A-Z]-\d+)$/, "")
    .replace(/(-[A-Z])$/, "")
    .replace(/(-P\d+)$/, "");
}

export function buildChildTaskMap(tasks = []) {
  const childMap = new Map();
  for (const task of tasks) {
    const parentId = deriveParentTaskId(task.id);
    if (!parentId || parentId === task.id) continue;
    if (!childMap.has(parentId)) childMap.set(parentId, new Set());
    childMap.get(parentId).add(task.id);
  }
  return childMap;
}

export function completeParentIfAllChildrenDone({
  task,
  childMap,
  completedIds,
  updateTaskStatus,
  log = () => {},
  now = new Date().toISOString(),
}) {
  const parentId = deriveParentTaskId(task.id);
  if (!parentId || parentId === task.id || !childMap.has(parentId)) return false;

  const childIds = [...childMap.get(parentId)];
  const allChildrenDone = childIds.every((childId) => completedIds.has(childId));
  if (!allChildrenDone || completedIds.has(parentId)) return false;

  completedIds.add(parentId);
  updateTaskStatus(parentId, {
    status: "done",
    completedByChildren: childIds,
    completedAt: now,
  });
  log(parentId, "parent-done", `全部子任务完成: ${childIds.join(", ")}`);
  return true;
}

export function blockParentForChildFailure({
  task,
  childMap,
  reason,
  updateTaskStatus,
  log = () => {},
  now = new Date().toISOString(),
}) {
  const parentId = deriveParentTaskId(task.id);
  if (!parentId || parentId === task.id || !childMap.has(parentId)) return false;

  updateTaskStatus(parentId, {
    status: "blocked",
    blockedByChild: task.id,
    blockedReason: reason || "child_failed",
    updatedAt: now,
  });
  log(parentId, "parent-blocked", `子任务失败: ${task.id}`);
  return true;
}

export function dependencyBlockers({ task, completedIds, tasks = [], taskCountsAsCompleted }) {
  const dependencies = [...new Set([
    ...(task.depends_on || []),
    ...(task.dependencies || []),
  ].filter(Boolean))];
  return dependencies.filter((dependencyId) => {
    if (completedIds.has(dependencyId)) return false;
    const dependencyTask = tasks.find((candidate) => candidate.id === dependencyId);
    return !taskCountsAsCompleted(dependencyTask);
  });
}
