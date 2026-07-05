#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWithinRoot } from "../../lib/security/path-guard.js";

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

function nowIso() {
  return new Date().toISOString();
}

function normalizePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/:\d+(?:-\d+)?$/, "");
}

function lexicalPrecheck(value) {
  const file = normalizePath(value);
  if (!file) return { ok: false, file, reason: "empty", detail: "path is empty" };
  if (file.includes("\0")) return { ok: false, file, reason: "null_byte", detail: "path contains null byte" };
  if (
    file.startsWith("/") ||
    file === ".." ||
    file.startsWith("../") ||
    file.includes("/../") ||
    file.endsWith("/..")
  ) {
    return { ok: false, file, reason: "path_escape", detail: "path escapes the project root lexically" };
  }
  return { ok: true, file, reason: null, detail: null };
}

function uniqueStrings(values) {
  return [...new Set(values.map(normalizePath).filter(Boolean))];
}

function conditionSummary(condition) {
  return {
    id: condition?.id || "UNKNOWN",
    type: condition?.type || "UNKNOWN",
    severity: condition?.severity || "FAIL",
    params: condition?.params || {},
  };
}

function normalizeTargets(scope = Object()) {
  return Array.isArray(scope.targets)
    ? scope.targets.map((target) => ({
      file: normalizePath(target?.file),
      regions: Array.isArray(target?.regions) ? target.regions : [],
      description: target?.description || "",
    }))
    : [];
}

export function buildContextPackForTask(task, options = Object()) {
  const scope = task?.scope || {};
  const targets = normalizeTargets(scope);
  const readonlyFiles = uniqueStrings(scope.readonly_files || []);
  const preConditions = Array.isArray(task?.pre_conditions)
    ? task.pre_conditions.map(conditionSummary)
    : [];
  const postConditions = Array.isArray(task?.post_conditions)
    ? task.post_conditions.map(conditionSummary)
    : [];

  return {
    version: "1.0",
    generated_at: nowIso(),
    root: options.root ? resolve(options.root) : null,
    attempt: Number.isInteger(options.attempt) ? options.attempt : null,
    task: {
      id: task?.id || null,
      title: task?.title || "",
      type: task?.type || "",
      status: task?.status || "",
      priority: task?.priority || "",
      task_kind: task?.task_kind || "",
      description: task?.description || "",
    },
    scope: {
      targets,
      readonly_files: readonlyFiles,
      allow_new_files: scope.allow_new_files === true,
      allow_delete_files: scope.allow_delete_files === true,
      max_files: scope.max_files || null,
      max_lines_per_file: scope.max_lines_per_file || null,
      forbidden_patterns: Array.isArray(scope.forbidden_patterns) ? scope.forbidden_patterns : [],
    },
    pre_conditions: preConditions,
    post_conditions: postConditions,
    acceptance_criteria: Array.isArray(task?.acceptance_criteria) ? task.acceptance_criteria : [],
  };
}

function addFailure(failures, code, detail, extra = Object()) {
  failures.push({ code, detail, ...extra });
}

function addWarning(warnings, code, detail, extra = Object()) {
  warnings.push({ code, detail, ...extra });
}

function validatePackPath(root, value) {
  const file = normalizePath(value);
  if (root) {
    const guarded = resolveWithinRoot(root, file);
    return guarded.ok
      ? { ok: true, file, reason: null, detail: null }
      : { ok: false, file, reason: guarded.reason || "path_escape", detail: guarded.detail || "path must stay inside root" };
  }
  return lexicalPrecheck(file);
}

export function validateContextPack(pack, options = Object()) {
  const failures = [];
  const warnings = [];
  const root = options.root ? resolve(options.root) : pack?.root || null;

  if (!pack || typeof pack !== "object") {
    addFailure(failures, "CONTEXT_PACK_MISSING", "context pack must be an object");
  }

  const task = pack?.task || {};
  const scope = pack?.scope || {};
  const targets = Array.isArray(scope.targets) ? scope.targets : [];
  const readonlyFiles = Array.isArray(scope.readonly_files) ? scope.readonly_files.map(normalizePath) : [];
  const postConditions = Array.isArray(pack?.post_conditions) ? pack.post_conditions : [];

  if (!task.id) {
    addFailure(failures, "CONTEXT_PACK_TASK_MISSING_ID", "context pack task must include id");
  }

  if (!root) {
    addWarning(warnings, "CONTEXT_PACK_ROOT_MISSING", "context pack has no project root");
  }

  if (task.status === "pending" && targets.length === 0) {
    addFailure(failures, "CONTEXT_PACK_MISSING_TARGETS", "pending task context pack must include scope.targets");
  }

  for (const [index, target] of targets.entries()) {
    const guarded = validatePackPath(root, target?.file);
    if (!guarded.ok) {
      addFailure(failures, "CONTEXT_PACK_UNSAFE_TARGET", `unsafe target path at index ${index}`, {
        target_index: index,
        file: guarded.file || target?.file || null,
        reason: guarded.reason || null,
        guard_detail: guarded.detail || null,
      });
    }
  }

  for (const [index, file] of readonlyFiles.entries()) {
    const guarded = validatePackPath(root, file);
    if (!guarded.ok) {
      addFailure(failures, "CONTEXT_PACK_UNSAFE_READONLY_FILE", `unsafe readonly file path at index ${index}`, {
        readonly_index: index,
        file: guarded.file || file,
        reason: guarded.reason || null,
        guard_detail: guarded.detail || null,
      });
    }
  }

  const targetFiles = uniqueStrings(targets.map((target) => target?.file));
  const readonlyTargetOverlap = targetFiles.filter((file) => readonlyFiles.includes(file));
  if (readonlyTargetOverlap.length > 0) {
    addFailure(
      failures,
      "CONTEXT_PACK_TARGET_READONLY_CONFLICT",
      `target files cannot also be readonly: ${readonlyTargetOverlap.join(", ")}`,
      { files: readonlyTargetOverlap },
    );
  }

  if (scope.max_files && targetFiles.length > scope.max_files) {
    addFailure(
      failures,
      "CONTEXT_PACK_MAX_FILES_EXCEEDED",
      `target count ${targetFiles.length} exceeds scope.max_files ${scope.max_files}`,
      { target_count: targetFiles.length, max_files: scope.max_files },
    );
  }

  if (task.status === "pending" && postConditions.length === 0) {
    addFailure(failures, "CONTEXT_PACK_MISSING_POST_CONDITIONS", "pending task context pack must include post_conditions");
  }

  if (postConditions.length > 50) {
    addWarning(warnings, "CONTEXT_PACK_LARGE_CONDITION_SET", `context pack has ${postConditions.length} post_conditions`);
  }

  const status = failures.length > 0 ? "fail" : warnings.length > 0 ? "warning" : "pass";
  return {
    status,
    blocks_execution: failures.length > 0,
    failures,
    warnings,
    stats: {
      target_count: targetFiles.length,
      readonly_count: readonlyFiles.length,
      pre_condition_count: Array.isArray(pack?.pre_conditions) ? pack.pre_conditions.length : 0,
      post_condition_count: postConditions.length,
    },
  };
}

function main() {
  console.error("context-pack-validator is a library module. Import buildContextPackForTask() and validateContextPack().");
  process.exit(2);
}

if (isMain) main();
