import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { withRuntimeInvariantCode } from "../invariants.js";
import { deriveParentTaskId } from "./status-helpers.js";

type LogFn = (...args: unknown[]) => void;

// Loose shapes that mirror the implicit-any structure historically returned by
// these helpers. They preserve tests' nested property access (task.scope.targets,
// task.pre_conditions.map(...)) without introducing `any`. Index signatures keep
// the shape open to runtime extra fields, matching pre-typecheck behavior.
interface ConditionLike {
  [key: string]: unknown;
  id?: unknown;
  type?: unknown;
  params?: Record<string, unknown>;
}

interface ScopeLike {
  [key: string]: unknown;
  targets?: Array<Record<string, unknown>>;
  readonly_files?: unknown;
  allow_new_files?: unknown;
  expected_zero_business_code?: unknown;
  max_files?: unknown;
}

interface TaskLike {
  [key: string]: unknown;
  id?: unknown;
  status?: unknown;
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  scope?: ScopeLike;
  pre_conditions?: ConditionLike[];
  post_conditions?: ConditionLike[];
  acceptance_criteria?: unknown[];
  depends_on?: unknown;
  dependencies?: unknown;
  merged_from?: unknown;
  split_into?: unknown;
}

const SOURCE_FILE_PATTERN = /src\/[^\s,，、]+?\.(tsx?|jsx?|css)/g;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function sourceFileMentions(text: string = ""): string[] {
  return [...new Set([...text.matchAll(SOURCE_FILE_PATTERN)].map((match) => match[0]))];
}

export function taskLooksLikeSplitWork(task: unknown = Object()): boolean {
  const rec = asRecord(task);
  const desc = `${asString(rec.description)} ${asString(rec.title)}`.toLowerCase();
  return /拆分|split|提取/.test(desc) ||
    (desc.includes("超") && desc.includes("行")) ||
    (desc.includes("超过") && desc.includes("行"));
}

export function prepareTaskForExpansion(
  task: unknown,
  { completedIds = new Set<string>() }: { completedIds?: Set<string> } = Object(),
): TaskLike {
  const rec = asRecord(task) as TaskLike;
  if (completedIds.has(asString(rec.id))) return { ...rec, status: "completed" };
  const scope = asRecord(rec.scope);
  if (!scope.targets || scope.allow_new_files || !taskLooksLikeSplitWork(task)) {
    return rec;
  }
  return {
    ...rec,
    scope: {
      ...scope,
      allow_new_files: true,
      expected_zero_business_code: true,
    },
  };
}

function scopedRelativePath(rootDir: string, absolutePath: string): string {
  return relative(rootDir, absolutePath).replaceAll("\\", "/");
}

export function buildImportGraph(
  files: string[],
  {
    rootDir = process.cwd(),
    readFile = readFileSync,
  }: { rootDir?: string; readFile?: typeof readFileSync } = Object(),
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const file of files) {
    const absPath = join(rootDir, file);
    let content: string;
    try {
      content = readFile(absPath, "utf8") as string;
    } catch {
      graph.set(file, new Set());
      continue;
    }

    const imports = new Set<string>();
    const importRegex = /(?:import|require)\s*\(?['"](\.[^'"]+|@\/[^'"]+)['"]\)?/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      const rawPath = match[1].replace(/^@\//, "src/");
      const resolved = resolve(dirname(absPath), rawPath);
      for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const candidate = resolved + ext;
        const relPath = scopedRelativePath(rootDir, candidate);
        if (files.includes(relPath)) {
          imports.add(relPath);
          break;
        }
      }
    }
    graph.set(file, imports);
  }
  return graph;
}

export function groupByDependency(files: string[], graph: Map<string, Set<string>>): string[][] {
  const parent = new Map<string, string>(files.map((file) => [file, file]));
  function find(file: string): string {
    const current = parent.get(file);
    if (current === undefined) return file;
    if (current === file) return file;
    const root = find(current);
    parent.set(file, root);
    return root;
  }
  function union(a: string, b: string): void {
    parent.set(find(a), find(b));
  }

  for (const file of files) {
    const deps = graph.get(file) || new Set<string>();
    for (const dep of deps) {
      if (files.includes(dep)) union(file, dep);
    }
  }

  const groups = new Map<string, string[]>();
  for (const file of files) {
    const root = find(file);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(file);
  }
  return [...groups.values()];
}

export function splitTask(
  task: unknown,
  {
    mode = "fix",
    rootDir = process.cwd(),
    exists = existsSync,
    readFile = readFileSync,
    log = (..._args: unknown[]) => {},
  }: {
    mode?: string;
    rootDir?: string;
    exists?: typeof existsSync;
    readFile?: typeof readFileSync;
    log?: LogFn;
  } = Object(),
): TaskLike[] {
  const rec = asRecord(task) as TaskLike;
  if (mode === "dev") return [rec];
  if (/-P\d+$/.test(asString(rec.id))) return [rec];

  const desc = `${asString(rec.description)} ${asString(rec.title)}`;
  const scope = asRecord(rec.scope);
  const targets = Array.isArray(scope.targets) ? scope.targets : [];
  const firstTarget = asRecord(targets[0]);
  const target = asString(firstTarget.file);

  if (target && target.startsWith("src/")) {
    const absTarget = join(rootDir, target);
    const isNewFile = !exists(absTarget);

    if (isNewFile) {
      const mentionedFiles = sourceFileMentions(desc)
        .filter((file) => file !== target && exists(join(rootDir, file)));

      if (mentionedFiles.length > 0) {
        const baseId = asString(rec.id);
        const partA: TaskLike = {
          ...rec,
          id: `${baseId}-A`,
          title: `${asString(rec.title)}（创建文件）`,
          description: `${asString(rec.description)}\n\n本子任务只创建文件 ${target}，不修改任何已有文件。`,
          scope: { ...scope, targets: [{ file: target }], allow_new_files: true },
          depends_on: rec.depends_on || [],
        };
        const partB: TaskLike = {
          ...rec,
          id: `${baseId}-B`,
          title: `${asString(rec.title)}（修改调用方）`,
          description: `${asString(rec.description)}\n\n本子任务只修改已有文件: ${mentionedFiles.join("、")}。文件 ${target} 已由 ${baseId}-A 创建。`,
          scope: { ...scope, targets: [{ file: mentionedFiles[0] }] },
          depends_on: [`${baseId}-A`],
        };
        log(rec.id, "原子拆分", `新建 ${target} + 修改 ${mentionedFiles.join(",")} → ${baseId}-A, ${baseId}-B`);
        return [partA, partB];
      }
    }

    if (!isNewFile && taskLooksLikeSplitWork(task)) {
      return [{
        ...rec,
        scope: {
          ...scope,
          allow_new_files: true,
          expected_zero_business_code: true,
        },
      }];
    }
  }

  const files = sourceFileMentions(desc);
  if (files.length <= 4) return [rec];

  const graph = buildImportGraph(files, { rootDir, readFile });
  const depGroups = groupByDependency(files, graph);
  log(rec.id, "依赖分组", `${files.length} 个文件 → ${depGroups.length} 个依赖组: ${depGroups.map((group) => `[${group.join(",")}]`).join(" | ")}`);

  const finalGroups: string[][] = [];
  for (const group of depGroups) {
    if (group.length <= 3) {
      finalGroups.push(group);
    } else {
      log(rec.id, "依赖保留", `组 [${group.join(",")}] 有 ${group.length} 个文件但存在依赖，保持不拆`);
      finalGroups.push(group);
    }
  }

  if (finalGroups.length <= 1) return [rec];
  return finalGroups.map((group, index) => ({
    ...rec,
    id: `${asString(rec.id)}-P${index + 1}`,
    title: `${asString(rec.title)} (第${index + 1}部分)`,
    description: `修复以下文件的 TypeScript 编译错误:\n${group.map((file) => `- ${file}`).join("\n")}\n\n只修改以上文件，禁止改其他文件。`,
    scope: { ...scope, targets: group.map((file) => ({ file })) },
    depends_on: index > 0 ? [`${asString(rec.id)}-P${index}`] : rec.depends_on || [],
  }));
}

export function mergeOverlappingTasks(
  tasks: unknown,
  {
    taskCountsAsCompleted = () => false,
    taskIsSplitParent = () => false,
    log = (..._args: unknown[]) => {},
  }: {
    taskCountsAsCompleted?: (task: Record<string, unknown> | undefined) => boolean;
    taskIsSplitParent?: (task: Record<string, unknown>) => boolean;
    log?: LogFn;
  } = Object(),
): TaskLike[] {
  const tasksArr = Array.isArray(tasks) ? tasks : [];
  const merged: TaskLike[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < tasksArr.length; i++) {
    if (consumed.has(i)) continue;
    const task = tasksArr[i];
    // Tolerate null/non-object task entries (manual edits, migration residue,
    // retry PRDs constructed from already-corrupt state). Same family as #104.
    if (!task || typeof task !== "object") continue;
    const rec = task as TaskLike;
    const scope = asRecord(rec.scope);
    const targets = Array.isArray(scope.targets) ? scope.targets : [];
    const target = asString(asRecord(targets[0]).file);
    if (!target || taskCountsAsCompleted(rec) || taskIsSplitParent(rec)) {
      merged.push(rec);
      continue;
    }

    const preTexts = asArray<unknown>(rec.pre_conditions)
      .map((condition) => {
        if (!condition || typeof condition !== "object") return "";
        const params = asRecord((condition as Record<string, unknown>).params);
        return asString(params.text) || asString(params.pattern) || "";
      })
      .filter(Boolean);
    if (preTexts.length === 0) {
      merged.push(rec);
      continue;
    }

    const group: TaskLike[] = [rec];
    consumed.add(i);

    for (let j = i + 1; j < tasksArr.length; j++) {
      if (consumed.has(j)) continue;
      const candidate = tasksArr[j];
      if (!candidate || typeof candidate !== "object") continue;
      const candidateRec = candidate as TaskLike;
      const candidateScope = asRecord(candidateRec.scope);
      const candidateTargets = Array.isArray(candidateScope.targets) ? candidateScope.targets : [];
      const candidateTarget = asString(asRecord(candidateTargets[0]).file);
      if (candidateTarget !== target) continue;
      if (taskCountsAsCompleted(candidateRec) || taskIsSplitParent(candidateRec)) continue;

      const candidatePreTexts = asArray<unknown>(candidateRec.pre_conditions)
        .map((condition) => {
          if (!condition || typeof condition !== "object") return "";
          const params = asRecord((condition as Record<string, unknown>).params);
          return asString(params.text) || asString(params.pattern) || "";
        })
        .filter(Boolean);
      if (candidatePreTexts.length === 0) continue;

      const hasOverlap = preTexts.some((text) =>
        candidatePreTexts.some((candidateText) => text.includes(candidateText) || candidateText.includes(text))
      );
      if (hasOverlap) {
        group.push(candidateRec);
        consumed.add(j);
      }
    }

    if (group.length === 1) {
      merged.push(rec);
      continue;
    }

    const base: TaskLike = { ...group[0] };
    const allDescriptions = group.map((item) => `【${asString(item.id)}】${asString(item.description) || asString(item.title)}`);
    const allIds = group.map((item) => asString(item.id));
    base.id = allIds.join("+");
    base.merged_from = allIds;
    base.title = `[合并 ${group.length} 个] ${asString(base.title)}`;
    base.description = allDescriptions.join("\n---\n");

    const seenPreTexts = new Set<string>();
    const mergedPre: ConditionLike[] = [];
    for (const item of group) {
      for (const condition of asArray<unknown>(item.pre_conditions)) {
        if (!condition || typeof condition !== "object") continue;
        const condRec = condition as ConditionLike;
        const params = asRecord(condRec.params);
        const key = asString(params.text) || asString(params.pattern) || JSON.stringify(params);
        if (!seenPreTexts.has(key)) {
          seenPreTexts.add(key);
          mergedPre.push(condRec);
        }
      }
    }
    base.pre_conditions = mergedPre;

    const seenPostTexts = new Set<string>();
    const mergedPost: ConditionLike[] = [];
    for (const item of group) {
      for (const condition of asArray<unknown>(item.post_conditions)) {
        if (!condition || typeof condition !== "object") continue;
        const condRec = condition as ConditionLike;
        if (condRec.type !== "code_not_contains" && condRec.type !== "code_contains") {
          mergedPost.push(condRec);
          continue;
        }
        const params = asRecord(condRec.params);
        const key = asString(params.text) || asString(params.pattern) || JSON.stringify(params);
        if (!seenPostTexts.has(key)) {
          seenPostTexts.add(key);
          const newParams = { ...params };
          delete newParams.line;
          mergedPost.push({ ...condRec, params: newParams });
        }
      }
    }
    base.post_conditions = mergedPost;

    const allCriteria = new Set<unknown>();
    for (const item of group) {
      for (const criterion of asArray<unknown>(item.acceptance_criteria)) allCriteria.add(criterion);
    }
    base.acceptance_criteria = [...allCriteria];

    const allDeps = new Set<unknown>(asArray<unknown>(base.depends_on));
    for (const item of group.slice(1)) {
      for (const dependency of asArray<unknown>(item.depends_on)) allDeps.add(dependency);
    }
    base.depends_on = [...allDeps];

    log(base.id, "合并", `合并 ${group.length} 个同文件同类任务: ${allIds.join(", ")} → ${target}`);
    merged.push(base);
  }

  return merged;
}

function asIdArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value ? [String(value)] : [];
}

// Coerce non-arrays to empty for safe iteration of condition/criteria/dep fields.
// Same family as #59/#63/#64: PRD migration residue or hand-edited state can put
// strings/objects/numbers where an array is expected, which either crashes .map
// or silently iterates characters via for...of.
function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function taskDependencyIds(task: unknown = Object()): string[] {
  const rec = asRecord(task);
  return [...new Set([
    ...asIdArray(rec.depends_on),
    ...asIdArray(rec.dependencies),
  ])];
}

function taskNodeKey(task: unknown, index: number): string {
  const rec = asRecord(task);
  return `${asString(rec.id) || "__task"}::${index}`;
}

function taskDisplayId(task: unknown, key: string): string {
  const rec = asRecord(task);
  return rec.id ? String(rec.id) : key;
}

function addRepresentative(
  representatives: Map<string, Set<string>>,
  id: unknown,
  key: string,
): void {
  if (!id) return;
  const value = String(id);
  if (!representatives.has(value)) representatives.set(value, new Set());
  representatives.get(value)!.add(key);
}

interface PreflightBlocker {
  code?: string;
  source?: string;
  task_ids?: string[];
  task_id?: string;
  message?: string;
  [key: string]: unknown;
}

function dependencyBlockedPreflight(blockers: PreflightBlocker[]) {
  return {
    status: "blocked" as const,
    blocks_execution: true,
    blockers,
  };
}

interface DependencyNode {
  task: unknown;
  index: number;
  key: string;
}

function noRootDependencyBlocker(nodes: DependencyNode[]): PreflightBlocker {
  return withRuntimeInvariantCode({
    code: "TASK_DEPENDENCY_NO_ROOT",
    source: "task-loop-expansion",
    task_ids: nodes.map((node) => taskDisplayId(node.task, node.key)),
    message: "Task dependency graph has no zero-dependency root task; runner cannot start execution.",
  }, "task_graph_no_root") as PreflightBlocker;
}

function dependencyCycleBlocker(nodes: DependencyNode[]): PreflightBlocker {
  const taskIds = nodes.map((node) => taskDisplayId(node.task, node.key));
  return {
    code: "TASK_DEPENDENCY_CYCLE",
    source: "task-loop-expansion",
    task_ids: taskIds,
    message: `Circular task dependency blocks execution: ${taskIds.join(" -> ")}`,
  };
}

function passPreflight() {
  return { status: "pass" as const, blocks_execution: false, blockers: [] as PreflightBlocker[] };
}

export function orderTasksByDependencies(
  tasks: unknown = [],
  {
    priorityOrder = Object() as Record<string, number>,
  }: { priorityOrder?: Record<string, number> } = Object(),
): {
  tasks: TaskLike[];
  preflight: ReturnType<typeof passPreflight> | ReturnType<typeof dependencyBlockedPreflight>;
} {
  const tasksArr = asArray<unknown>(tasks);
  const nodes: DependencyNode[] = tasksArr.map((task, index) => ({
    task,
    index,
    key: taskNodeKey(task, index),
  }));
  const nodesByKey = new Map<string, DependencyNode>(nodes.map((node) => [node.key, node]));
  const representatives = new Map<string, Set<string>>();

  for (const node of nodes) {
    const taskRec = asRecord(node.task);
    addRepresentative(representatives, taskRec.id, node.key);
    for (const sourceId of asIdArray(taskRec.merged_from)) addRepresentative(representatives, sourceId, node.key);
    const parentId = deriveParentTaskId(taskRec.id);
    if (parentId && parentId !== taskRec.id) addRepresentative(representatives, parentId, node.key);
  }

  const dependenciesByKey = new Map<string, Set<string>>(nodes.map((node) => [node.key, new Set<string>()]));
  const blockers: PreflightBlocker[] = [];
  if (nodes.length > 0 && nodes.every((node) => taskDependencyIds(node.task).length > 0)) {
    blockers.push(noRootDependencyBlocker(nodes));
  }

  for (const node of nodes) {
    const dependencies = dependenciesByKey.get(node.key);
    if (!dependencies) continue;
    for (const dependencyId of taskDependencyIds(node.task)) {
      for (const dependencyKey of representatives.get(dependencyId) || []) {
        dependencies.add(dependencyKey);
      }
    }
  }

  const indegree = new Map<string, number>(nodes.map((node) => [node.key, 0]));
  const outgoing = new Map<string, Set<string>>(nodes.map((node) => [node.key, new Set<string>()]));
  for (const [key, dependencies] of dependenciesByKey) {
    for (const dependencyKey of dependencies) {
      if (!indegree.has(dependencyKey)) continue;
      const outSet = outgoing.get(dependencyKey);
      if (!outSet || outSet.has(key)) continue;
      outSet.add(key);
      indegree.set(key, (indegree.get(key) ?? 0) + 1);
    }
  }

  const compareReady = (leftKey: string, rightKey: string): number => {
    const left = nodesByKey.get(leftKey);
    const right = nodesByKey.get(rightKey);
    const leftPriority = asString(asRecord(left?.task).priority);
    const rightPriority = asString(asRecord(right?.task).priority);
    const priorityDiff = (priorityOrder[leftPriority] ?? 9) - (priorityOrder[rightPriority] ?? 9);
    if (priorityDiff !== 0) return priorityDiff;
    return (left?.index ?? 0) - (right?.index ?? 0);
  };

  const ready = nodes
    .filter((node) => indegree.get(node.key) === 0)
    .map((node) => node.key)
    .sort(compareReady);
  const ordered: DependencyNode[] = [];

  while (ready.length > 0) {
    const key = ready.shift();
    if (key === undefined) continue;
    const node = nodesByKey.get(key);
    if (!node) continue;
    ordered.push(node);

    for (const nextKey of outgoing.get(key) || []) {
      indegree.set(nextKey, (indegree.get(nextKey) ?? 0) - 1);
      if (indegree.get(nextKey) === 0) {
        ready.push(nextKey);
        ready.sort(compareReady);
      }
    }
  }

  if (ordered.length !== nodes.length) {
    const orderedKeys = new Set(ordered.map((node) => node.key));
    const cycleNodes = nodes.filter((node) => !orderedKeys.has(node.key));
    blockers.push(dependencyCycleBlocker(cycleNodes));
    return {
      tasks: [...ordered, ...cycleNodes].map((node) => asRecord(node.task) as TaskLike),
      preflight: dependencyBlockedPreflight(blockers),
    };
  }

  if (blockers.length > 0) {
    return {
      tasks: ordered.map((node) => asRecord(node.task) as TaskLike),
      preflight: dependencyBlockedPreflight(blockers),
    };
  }

  return {
    tasks: ordered.map((node) => asRecord(node.task) as TaskLike),
    preflight: passPreflight(),
  };
}

export function expandTasksForMainLoop({
  tasks = [],
  completedIds = new Set<string>(),
  priorityOrder = Object() as Record<string, number>,
  mode = "fix",
  rootDir = process.cwd(),
  exists = existsSync,
  readFile = readFileSync,
  taskCountsAsCompleted = () => false,
  taskIsSplitParent = () => false,
  log = (..._args: unknown[]) => {},
}: {
  tasks?: unknown;
  completedIds?: Set<string>;
  priorityOrder?: Record<string, number>;
  mode?: string;
  rootDir?: string;
  exists?: typeof existsSync;
  readFile?: typeof readFileSync;
  taskCountsAsCompleted?: (task: Record<string, unknown> | undefined) => boolean;
  taskIsSplitParent?: (task: Record<string, unknown>) => boolean;
  log?: LogFn;
} = Object()) {
  // Tolerate null/non-object task entries (manual edits, migration residue,
  // retry PRDs constructed from already-corrupt state). Same family as #104.
  const validTasks = asArray<unknown>(tasks).filter((task) => task && typeof task === "object");
  const expandedBeforeMerge = [...validTasks].flatMap((task) => {
    const prepared = prepareTaskForExpansion(task, { completedIds });
    if (prepared.status === "completed") return [prepared];

    const parts = splitTask(prepared, { mode, rootDir, exists, readFile, log });
    if (parts.length > 1) log(prepared.id, "拆分", `-> ${parts.length} 个子任务`);
    return parts;
  });

  const beforeMerge = expandedBeforeMerge.length;
  const expanded = mergeOverlappingTasks(expandedBeforeMerge, {
    taskCountsAsCompleted,
    taskIsSplitParent,
    log,
  });
  const ordered = orderTasksByDependencies(expanded, { priorityOrder });

  return {
    expanded: ordered.tasks,
    preflight: ordered.preflight,
    beforeMerge,
    mergedCount: ordered.tasks.length,
  };
}
