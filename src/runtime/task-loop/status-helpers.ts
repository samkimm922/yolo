type LogFn = (...args: unknown[]) => void;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export function mergedSourceTaskIds(task: unknown = Object()): string[] {
  const rec = asRecord(task);
  const merged = rec.merged_from;
  const ownId = rec.id;
  if (!Array.isArray(merged)) return [];
  return merged.filter((id): id is string => Boolean(id) && id !== ownId && typeof id === "string");
}

export function updateMergedSourceTasks({
  task,
  update = Object(),
  updateTaskStatus,
  now = new Date().toISOString(),
}: {
  task: unknown;
  update?: Record<string, unknown>;
  updateTaskStatus: (id: string, update: Record<string, unknown>) => void;
  now?: string;
}): string[] {
  const ids = mergedSourceTaskIds(task);
  if (ids.length === 0) return [];
  const taskRec = asRecord(task);
  for (const id of ids) {
    updateTaskStatus(id, {
      ...update,
      merged_into: taskRec.id,
      updatedAt: now,
    });
  }
  return ids;
}

export function deriveParentTaskId(taskId: unknown): string {
  const id = asString(taskId);
  if (!id) return id;
  return id
    .replace(/(-[A-Z]-\d+)$/, "")
    .replace(/(-[A-Z])$/, "")
    .replace(/(-P\d+)$/, "");
}

export function buildChildTaskMap(tasks: unknown = []): Map<string, Set<string>> {
  const childMap = new Map<string, Set<string>>();
  for (const task of asArray<unknown>(tasks)) {
    const rec = asRecord(task);
    const taskId = asString(rec.id);
    const parentId = deriveParentTaskId(taskId);
    if (!parentId || parentId === taskId) continue;
    if (!childMap.has(parentId)) childMap.set(parentId, new Set());
    childMap.get(parentId)!.add(taskId);
  }
  return childMap;
}

export function completeParentIfAllChildrenDone({
  task,
  childMap,
  completedIds,
  updateTaskStatus,
  log = (..._args: unknown[]) => {},
  now = new Date().toISOString(),
}: {
  task: unknown;
  childMap: Map<string, Set<string>>;
  completedIds: Set<string>;
  updateTaskStatus: (id: string, update: Record<string, unknown>) => void;
  log?: LogFn;
  now?: string;
}): boolean {
  const rec = asRecord(task);
  const taskId = asString(rec.id);
  const parentId = deriveParentTaskId(taskId);
  if (!parentId || parentId === taskId || !childMap.has(parentId)) return false;

  const childIds = [...childMap.get(parentId)!];
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
  log = (..._args: unknown[]) => {},
  now = new Date().toISOString(),
}: {
  task: unknown;
  childMap: Map<string, Set<string>>;
  reason: unknown;
  updateTaskStatus: (id: string, update: Record<string, unknown>) => void;
  log?: LogFn;
  now?: string;
}): boolean {
  const rec = asRecord(task);
  const taskId = asString(rec.id);
  const parentId = deriveParentTaskId(taskId);
  if (!parentId || parentId === taskId || !childMap.has(parentId)) return false;

  updateTaskStatus(parentId, {
    status: "blocked",
    blockedByChild: taskId,
    blockedReason: asString(reason) || "child_failed",
    updatedAt: now,
  });
  log(parentId, "parent-blocked", `子任务失败: ${taskId}`);
  return true;
}

export function dependencyBlockers({
  task,
  completedIds,
  tasks = [],
  taskCountsAsCompleted,
}: {
  task: unknown;
  completedIds: Set<string>;
  tasks?: unknown;
  taskCountsAsCompleted: (task: Record<string, unknown> | undefined) => boolean;
}): string[] {
  const rec = asRecord(task);
  const dependencies = [...new Set([
    ...asArray<unknown>(rec.depends_on),
    ...asArray<unknown>(rec.dependencies),
  ].filter(Boolean).map((id) => String(id)))];
  return dependencies.filter((dependencyId) => {
    if (completedIds.has(dependencyId)) return false;
    const dependencyTask = asArray<unknown>(tasks).find(
      (candidate) => asRecord(candidate).id === dependencyId,
    );
    return !taskCountsAsCompleted(dependencyTask === undefined ? undefined : asRecord(dependencyTask));
  });
}
