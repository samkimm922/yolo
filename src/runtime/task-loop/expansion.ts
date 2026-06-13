import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SOURCE_FILE_PATTERN = /src\/[^\s,，、]+?\.(tsx?|jsx?|css)/g;

function sourceFileMentions(text = "") {
  return [...new Set([...text.matchAll(SOURCE_FILE_PATTERN)].map((match) => match[0]))];
}

export function taskLooksLikeSplitWork(task = Object()) {
  const desc = `${task.description || ""} ${task.title || ""}`.toLowerCase();
  return /拆分|split|提取/.test(desc) ||
    (desc.includes("超") && desc.includes("行")) ||
    (desc.includes("超过") && desc.includes("行"));
}

export function prepareTaskForExpansion(task, { completedIds = new Set() } = Object()) {
  if (completedIds.has(task.id)) return { ...task, status: "completed" };
  if (!task.scope?.targets || task.scope.allow_new_files || !taskLooksLikeSplitWork(task)) {
    return task;
  }
  return {
    ...task,
    scope: {
      ...task.scope,
      allow_new_files: true,
      expected_zero_business_code: true,
    },
  };
}

function scopedRelativePath(rootDir, absolutePath) {
  return relative(rootDir, absolutePath).replaceAll("\\", "/");
}

export function buildImportGraph(files, { rootDir = process.cwd(), readFile = readFileSync } = Object()) {
  const graph = new Map();
  for (const file of files) {
    const absPath = join(rootDir, file);
    let content;
    try {
      content = readFile(absPath, "utf8");
    } catch {
      graph.set(file, new Set());
      continue;
    }

    const imports = new Set();
    const importRegex = /(?:import|require)\s*\(?['"](\.[^'"]+|@\/[^'"]+)['"]\)?/g;
    let match;
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

export function groupByDependency(files, graph) {
  const parent = new Map(files.map((file) => [file, file]));
  function find(file) {
    const current = parent.get(file);
    if (current === file) return file;
    const root = find(current);
    parent.set(file, root);
    return root;
  }
  function union(a, b) {
    parent.set(find(a), find(b));
  }

  for (const file of files) {
    const deps = graph.get(file) || new Set();
    for (const dep of deps) {
      if (files.includes(dep)) union(file, dep);
    }
  }

  const groups = new Map();
  for (const file of files) {
    const root = find(file);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(file);
  }
  return [...groups.values()];
}

export function splitTask(task, {
  mode = "fix",
  rootDir = process.cwd(),
  exists = existsSync,
  readFile = readFileSync,
  log = (..._args) => {},
} = Object()) {
  if (mode === "dev") return [task];
  if (/-P\d+$/.test(task.id)) return [task];

  const desc = `${task.description || ""} ${task.title || ""}`;
  const target = task.scope?.targets?.[0]?.file || "";

  if (target && target.startsWith("src/")) {
    const absTarget = join(rootDir, target);
    const isNewFile = !exists(absTarget);

    if (isNewFile) {
      const mentionedFiles = sourceFileMentions(desc)
        .filter((file) => file !== target && exists(join(rootDir, file)));

      if (mentionedFiles.length > 0) {
        const baseId = task.id;
        const partA = {
          ...task,
          id: `${baseId}-A`,
          title: `${task.title}（创建文件）`,
          description: `${task.description}\n\n本子任务只创建文件 ${target}，不修改任何已有文件。`,
          scope: { ...task.scope, targets: [{ file: target }], allow_new_files: true },
          depends_on: task.depends_on || [],
        };
        const partB = {
          ...task,
          id: `${baseId}-B`,
          title: `${task.title}（修改调用方）`,
          description: `${task.description}\n\n本子任务只修改已有文件: ${mentionedFiles.join("、")}。文件 ${target} 已由 ${baseId}-A 创建。`,
          scope: { ...task.scope, targets: [{ file: mentionedFiles[0] }] },
          depends_on: [`${baseId}-A`],
        };
        log(task.id, "原子拆分", `新建 ${target} + 修改 ${mentionedFiles.join(",")} → ${baseId}-A, ${baseId}-B`);
        return [partA, partB];
      }
    }

    if (!isNewFile && taskLooksLikeSplitWork(task)) {
      return [{
        ...task,
        scope: {
          ...task.scope,
          allow_new_files: true,
          expected_zero_business_code: true,
        },
      }];
    }
  }

  const files = sourceFileMentions(desc);
  if (files.length <= 4) return [task];

  const graph = buildImportGraph(files, { rootDir, readFile });
  const depGroups = groupByDependency(files, graph);
  log(task.id, "依赖分组", `${files.length} 个文件 → ${depGroups.length} 个依赖组: ${depGroups.map((group) => `[${group.join(",")}]`).join(" | ")}`);

  const finalGroups = [];
  for (const group of depGroups) {
    if (group.length <= 3) {
      finalGroups.push(group);
    } else {
      log(task.id, "依赖保留", `组 [${group.join(",")}] 有 ${group.length} 个文件但存在依赖，保持不拆`);
      finalGroups.push(group);
    }
  }

  if (finalGroups.length <= 1) return [task];
  return finalGroups.map((group, index) => ({
    ...task,
    id: `${task.id}-P${index + 1}`,
    title: `${task.title} (第${index + 1}部分)`,
    description: `修复以下文件的 TypeScript 编译错误:\n${group.map((file) => `- ${file}`).join("\n")}\n\n只修改以上文件，禁止改其他文件。`,
    scope: { ...task.scope, targets: group.map((file) => ({ file })) },
    depends_on: index > 0 ? [`${task.id}-P${index}`] : task.depends_on || [],
  }));
}

export function mergeOverlappingTasks(tasks, {
  taskCountsAsCompleted = () => false,
  taskIsSplitParent = () => false,
  log = (..._args) => {},
} = Object()) {
  const merged = [];
  const consumed = new Set();

  for (let i = 0; i < tasks.length; i++) {
    if (consumed.has(i)) continue;
    const task = tasks[i];
    const target = task.scope?.targets?.[0]?.file;
    if (!target || taskCountsAsCompleted(task) || taskIsSplitParent(task)) {
      merged.push(task);
      continue;
    }

    const preTexts = (task.pre_conditions || [])
      .map((condition) => condition.params?.text || condition.params?.pattern || "")
      .filter(Boolean);
    if (preTexts.length === 0) {
      merged.push(task);
      continue;
    }

    const group = [task];
    consumed.add(i);

    for (let j = i + 1; j < tasks.length; j++) {
      if (consumed.has(j)) continue;
      const candidate = tasks[j];
      const candidateTarget = candidate.scope?.targets?.[0]?.file;
      if (candidateTarget !== target) continue;
      if (taskCountsAsCompleted(candidate) || taskIsSplitParent(candidate)) continue;

      const candidatePreTexts = (candidate.pre_conditions || [])
        .map((condition) => condition.params?.text || condition.params?.pattern || "")
        .filter(Boolean);
      if (candidatePreTexts.length === 0) continue;

      const hasOverlap = preTexts.some((text) =>
        candidatePreTexts.some((candidateText) => text.includes(candidateText) || candidateText.includes(text))
      );
      if (hasOverlap) {
        group.push(candidate);
        consumed.add(j);
      }
    }

    if (group.length === 1) {
      merged.push(task);
      continue;
    }

    const base = { ...group[0] };
    const allDescriptions = group.map((item) => `【${item.id}】${item.description || item.title || ""}`);
    const allIds = group.map((item) => item.id);
    base.id = allIds.join("+");
    base.merged_from = allIds;
    base.title = `[合并 ${group.length} 个] ${base.title || ""}`;
    base.description = allDescriptions.join("\n---\n");

    const seenPreTexts = new Set();
    const mergedPre = [];
    for (const item of group) {
      for (const condition of item.pre_conditions || []) {
        const key = condition.params?.text || condition.params?.pattern || JSON.stringify(condition.params);
        if (!seenPreTexts.has(key)) {
          seenPreTexts.add(key);
          mergedPre.push(condition);
        }
      }
    }
    base.pre_conditions = mergedPre;

    const seenPostTexts = new Set();
    const mergedPost = [];
    for (const item of group) {
      for (const condition of item.post_conditions || []) {
        if (condition.type !== "code_not_contains" && condition.type !== "code_contains") {
          mergedPost.push(condition);
          continue;
        }
        const key = condition.params?.text || condition.params?.pattern || JSON.stringify(condition.params);
        if (!seenPostTexts.has(key)) {
          seenPostTexts.add(key);
          const newParams = { ...condition.params };
          delete newParams.line;
          mergedPost.push({ ...condition, params: newParams });
        }
      }
    }
    base.post_conditions = mergedPost;

    const allCriteria = new Set();
    for (const item of group) {
      for (const criterion of item.acceptance_criteria || []) allCriteria.add(criterion);
    }
    base.acceptance_criteria = [...allCriteria];

    const allDeps = new Set(base.depends_on || []);
    for (const item of group.slice(1)) {
      for (const dependency of item.depends_on || []) allDeps.add(dependency);
    }
    base.depends_on = [...allDeps];

    log(base.id, "合并", `合并 ${group.length} 个同文件同类任务: ${allIds.join(", ")} → ${target}`);
    merged.push(base);
  }

  return merged;
}

export function expandTasksForMainLoop({
  tasks = [],
  completedIds = new Set(),
  priorityOrder = Object(),
  mode = "fix",
  rootDir = process.cwd(),
  exists = existsSync,
  readFile = readFileSync,
  taskCountsAsCompleted = () => false,
  taskIsSplitParent = () => false,
  log = (..._args) => {},
} = Object()) {
  const sorted = [...tasks].sort(
    (a, b) => (priorityOrder[a.priority] ?? 9) - (priorityOrder[b.priority] ?? 9),
  );
  const expandedBeforeMerge = sorted.flatMap((task) => {
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

  return {
    expanded,
    beforeMerge,
    mergedCount: expanded.length,
  };
}
