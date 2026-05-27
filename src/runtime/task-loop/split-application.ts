import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { writeSplitAppliedEvidence } from "../evidence/writers.js";

export function filterConditionsForFiles(conditions = [], files = []) {
  const fileSet = new Set(files.filter(Boolean));
  return (conditions || []).filter((condition) => {
    const file = condition?.params?.file;
    if (!file) return true;
    return fileSet.has(file);
  });
}

export function schemaCompatibleTaskId(candidate) {
  return /^[A-Z]+-[A-Z0-9-]+-[0-9]+[A-Z]*$/.test(String(candidate || ""));
}

export function makeSplitChildId(parentId, suggestion, index, existingIds = new Set()) {
  const suggested = suggestion?.id;
  if (schemaCompatibleTaskId(suggested) && !existingIds.has(suggested)) return suggested;
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

export function splitSuggestionToTask(parentTask, suggestion, index, existingIds = new Set()) {
  const files = Array.isArray(suggestion.files) ? suggestion.files.filter(Boolean) : [];
  const childId = makeSplitChildId(parentTask.id, suggestion, index, existingIds);
  const descriptionParts = [
    suggestion.goal || parentTask.description || "",
    ...(suggestion.required_investigation || []).map((item) => `必须先查证：${item}`),
  ].filter(Boolean);
  return {
    id: childId,
    title: suggestion.title || `${parentTask.title || parentTask.id} (拆分 ${index + 1})`,
    priority: parentTask.priority,
    type: parentTask.type,
    task_kind: parentTask.task_kind,
    status: "pending",
    depends_on: parentTask.depends_on || [],
    description: descriptionParts.join("\n"),
    source_finding_ids: parentTask.source_finding_ids || [],
    must_fix_before_ship: parentTask.must_fix_before_ship,
    parent_task_id: parentTask.id,
    split_from: parentTask.id,
    scope: {
      ...(parentTask.scope || {}),
      targets: files.map((file) => ({ file, description: suggestion.goal || `拆分自 ${parentTask.id}` })),
      max_files: files.length || parentTask.scope?.max_files || 1,
    },
    test_generation: parentTask.test_generation,
    pre_conditions: filterConditionsForFiles(parentTask.pre_conditions || [], files),
    post_conditions: filterConditionsForFiles(parentTask.post_conditions || [], files),
  };
}

export function applySplitSuggestionsToPrd({
  prdPath,
  parentTask,
  doctor,
  yoloRoot,
  projectRoot,
  writeRecoveryCheckpoint,
} = {}) {
  const suggestions = Array.isArray(doctor?.split_suggestions) ? doctor.split_suggestions : [];
  if (!suggestions.length) return { applied: false, reason: "missing_split_suggestions", childIds: [] };
  const raw = readFileSync(prdPath, "utf8");
  const prd = JSON.parse(raw);
  const tasks = Array.isArray(prd.tasks) ? prd.tasks : [];
  const parentIndex = tasks.findIndex((task) => task.id === parentTask.id);
  if (parentIndex < 0) return { applied: false, reason: "parent_task_missing", childIds: [] };

  const existingIds = new Set(tasks.map((task) => task.id));
  const children = suggestions
    .map((suggestion, index) => splitSuggestionToTask(tasks[parentIndex], suggestion, index, existingIds))
    .filter((task) => task.scope?.targets?.length > 0)
    .filter((task) => !existingIds.has(task.id));
  if (!children.length) {
    return {
      applied: true,
      reason: "split_children_already_exist",
      childIds: suggestions.map((suggestion, index) => makeSplitChildId(parentTask.id, suggestion, index, existingIds)),
    };
  }

  const now = new Date().toISOString();
  const childIds = children.map((task) => task.id);
  tasks[parentIndex] = {
    ...tasks[parentIndex],
    status: "split",
    phase: "split",
    phaseDetail: "atomic_task_must_split",
    failReason: `atomic_task_must_split: score=${doctor.score}, evidence=${doctor.evidence_file}`,
    split_into: [...new Set([...(tasks[parentIndex].split_into || []), ...childIds])],
    split_suggestions: suggestions,
    counts_as_completed: false,
    updatedAt: now,
    atomic_task_doctor: {
      mode: doctor.mode,
      score: doctor.score,
      evidence_file: doctor.evidence_file,
      next_action: doctor.next_action,
    },
  };
  tasks.splice(parentIndex + 1, 0, ...children);
  prd.tasks = tasks;
  const tmp = `${prdPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(prd, null, 2), "utf8");
  renameSync(tmp, prdPath);

  const splitEvidence = writeSplitAppliedEvidence({
    parentTask,
    doctor,
    childIds,
    children,
    now,
  }, { yoloRoot, projectRoot });
  writeRecoveryCheckpoint?.(`task_split_${parentTask.id}`, prdPath, parentTask.id, {
    status: "split",
    phase: "split",
    failReason: `atomic_task_must_split: score=${doctor.score}`,
  });
  return { applied: true, reason: "split_applied", childIds, evidence_file: splitEvidence.evidence_file };
}
