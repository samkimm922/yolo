import { renameSync, writeFileSync } from "node:fs";
import { writeSplitAppliedEvidence } from "../evidence/writers.js";
import { readJsonFileBounded } from "../../lib/bounded-read.js";

// Loose shapes mirror the implicit-any structure historically returned by
// these helpers (tests access child.scope.targets, child.pre_conditions.map…).
interface ConditionLike {
  [key: string]: unknown;
  id?: unknown;
  type?: unknown;
  params?: Record<string, unknown>;
}

interface ScopeLike {
  [key: string]: unknown;
  targets?: Array<Record<string, unknown>>;
  max_files?: unknown;
}

interface SplitChild {
  [key: string]: unknown;
  id: string;
  title: string;
  scope: ScopeLike;
  pre_conditions: ConditionLike[];
  post_conditions: ConditionLike[];
  depends_on?: unknown;
  description?: string;
  status?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export function filterConditionsForFiles(conditions: unknown = [], files: unknown = []): ConditionLike[] {
  const fileSet = new Set(asArray<unknown>(files).map(String).filter(Boolean));
  return asArray<unknown>(conditions).filter((condition): condition is ConditionLike => {
    if (!condition || typeof condition !== "object") return false;
    const params = asRecord((condition as Record<string, unknown>).params);
    const file = params.file;
    if (!file) return true;
    return fileSet.has(String(file));
  });
}

export function schemaCompatibleTaskId(candidate: unknown): boolean {
  return /^[A-Z]+-[A-Z0-9-]+-[0-9]+[A-Z]*$/.test(String(candidate || ""));
}

export function makeSplitChildId(
  parentId: unknown,
  suggestion: unknown,
  index: number,
  existingIds: Set<string> = new Set(),
): string {
  const suggested = asRecord(suggestion).id;
  if (schemaCompatibleTaskId(suggested) && typeof suggested === "string" && !existingIds.has(suggested)) return suggested;
  const parent = String(parentId || "FIX-SPLIT-0");
  const match = parent.match(/^([A-Z]+)-(.+?)-([0-9]+)[A-Z]*$/);
  const prefix = match ? match[1] : "FIX";
  const middle = match ? match[2] : parent.replace(/[^A-Z0-9-]+/g, "-").replace(/^-|-$/g, "") || "SPLIT";
  const baseNumber = match ? match[3] : "0";
  let suffix = `${baseNumber}${index + 1}`;
  let candidate = `${prefix}-${middle}-${suffix}`;
  let guard = index + 1;
  while (existingIds.has(candidate)) {
    guard++;
    suffix = `${baseNumber}${guard}`;
    candidate = `${prefix}-${middle}-${suffix}`;
  }
  return candidate;
}

export function splitSuggestionToTask(
  parentTask: unknown,
  suggestion: unknown,
  index: number,
  existingIds: Set<string> = new Set(),
): SplitChild {
  const parentRec = asRecord(parentTask);
  const sugRec = asRecord(suggestion);
  const files = asArray<unknown>(sugRec.files).map(String).filter(Boolean);
  const childId = makeSplitChildId(parentRec.id, suggestion, index, existingIds);
  const descriptionParts = [
    asString(sugRec.goal) || asString(parentRec.description),
    ...asArray<unknown>(sugRec.required_investigation).map((item) => `必须先查证：${String(item)}`),
  ].filter(Boolean);
  const parentScope = asRecord(parentRec.scope);
  return {
    id: childId,
    title: asString(sugRec.title) || `${asString(parentRec.title) || asString(parentRec.id)} (拆分 ${index + 1})`,
    priority: parentRec.priority,
    type: parentRec.type,
    task_kind: parentRec.task_kind,
    status: "pending",
    depends_on: asArray<unknown>(parentRec.depends_on),
    description: descriptionParts.join("\n"),
    source_finding_ids: asArray<unknown>(parentRec.source_finding_ids),
    must_fix_before_ship: parentRec.must_fix_before_ship,
    parent_task_id: parentRec.id,
    split_from: parentRec.id,
    scope: {
      ...parentScope,
      targets: files.map((file) => ({ file, description: asString(sugRec.goal) || `拆分自 ${asString(parentRec.id)}` })),
      max_files: files.length || (typeof parentScope.max_files === "number" ? parentScope.max_files : 1),
    },
    test_generation: parentRec.test_generation,
    pre_conditions: filterConditionsForFiles(asArray<unknown>(parentRec.pre_conditions), files),
    post_conditions: filterConditionsForFiles(asArray<unknown>(parentRec.post_conditions), files),
  };
}

export function applySplitSuggestionsToPrd({
  prdPath,
  parentTask,
  doctor,
  yoloRoot,
  projectRoot,
  writeRecoveryCheckpoint,
}: {
  prdPath: string;
  parentTask: unknown;
  doctor: unknown;
  yoloRoot: string;
  projectRoot: string;
  writeRecoveryCheckpoint?: (key: string, prdPath: string, taskId: string, update: Record<string, unknown>) => void;
} = Object() as {
  prdPath: string;
  parentTask: unknown;
  doctor: unknown;
  yoloRoot: string;
  projectRoot: string;
  writeRecoveryCheckpoint?: (key: string, prdPath: string, taskId: string, update: Record<string, unknown>) => void;
}) {
  const doctorRec = asRecord(doctor);
  const parentRec = asRecord(parentTask);
  const suggestions = asArray<unknown>(doctorRec.split_suggestions);
  if (!suggestions.length) return { applied: false, reason: "missing_split_suggestions", childIds: [] as string[] };
  const prd = readJsonFileBounded(prdPath, { errorCode: "PRD_JSON_SIZE_LIMIT_EXCEEDED" }) as Record<string, unknown>;
  const tasks = asArray<Record<string, unknown>>(prd.tasks);
  const parentIndex = tasks.findIndex((task) => asRecord(task).id === parentRec.id);
  if (parentIndex < 0) return { applied: false, reason: "parent_task_missing", childIds: [] as string[] };

  const existingIds = new Set<string>(tasks.map((task) => String(asRecord(task).id)));
  const children = suggestions
    .map((suggestion, index) => splitSuggestionToTask(tasks[parentIndex], suggestion, index, existingIds))
    .filter((task) => {
      const scope = asRecord(task.scope);
      return asArray<unknown>(scope.targets).length > 0;
    })
    .filter((task) => !existingIds.has(String(task.id)));
  if (!children.length) {
    return {
      applied: true,
      reason: "split_children_already_exist",
      childIds: suggestions.map((suggestion, index) => makeSplitChildId(parentRec.id, suggestion, index, existingIds)),
    };
  }

  const now = new Date().toISOString();
  const childIds = children.map((task) => String(task.id));
  const currentParent = asRecord(tasks[parentIndex]);
  tasks[parentIndex] = {
    ...currentParent,
    status: "split",
    phase: "split",
    phaseDetail: "atomic_task_must_split",
    failReason: `atomic_task_must_split: score=${asString(doctorRec.score) || String(doctorRec.score ?? "")}, evidence=${asString(doctorRec.evidence_file)}`,
    split_into: [...new Set([...asArray<unknown>(currentParent.split_into).map(String), ...childIds])],
    split_suggestions: suggestions,
    counts_as_completed: false,
    updatedAt: now,
    atomic_task_doctor: {
      mode: doctorRec.mode,
      score: doctorRec.score,
      evidence_file: doctorRec.evidence_file,
      next_action: doctorRec.next_action,
    },
  };
  tasks.splice(parentIndex + 1, 0, ...children);
  prd.tasks = tasks;
  const tmp = `${prdPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(prd, null, 2), "utf8");
  renameSync(tmp, prdPath);

  const splitEvidence = writeSplitAppliedEvidence({
    parentTask: parentRec,
    doctor: doctorRec,
    childIds,
    children,
    now,
  }, { yoloRoot, projectRoot });
  writeRecoveryCheckpoint?.(`task_split_${asString(parentRec.id)}`, prdPath, asString(parentRec.id), {
    status: "split",
    phase: "split",
    failReason: `atomic_task_must_split: score=${String(doctorRec.score ?? "")}`,
  });
  return { applied: true, reason: "split_applied", childIds, evidence_file: splitEvidence.evidence_file };
}
