// task-router.js — deterministic route selection before spending provider time

function scannerIds(task = Object()) {
  return (task.source_findings || task.fix_findings || [])
    .map((finding) => finding.scanner_id || finding.rule_id)
    .filter(Boolean);
}

function hasOnlyScanner(task, scannerId) {
  const ids = scannerIds(task);
  return ids.length > 0 && ids.every((id) => id === scannerId);
}

export function isSplitOrStructuralRefactorTask(task = Object()) {
  const text = `${task.title || ""}\n${task.description || ""}`.toLowerCase();
  const ids = scannerIds(task);
  return task.scope?.allow_new_files === true ||
    ids.includes("R9-file-length") ||
    /拆分|split|提取|文件.*行|file-length|超过\s*\d+\s*行/.test(text);
}

export function classifyTaskExecution(task = Object()) {
  if (task.task_kind === "deterministic_check" || task.execution_mode === "deterministic_check") {
    return {
      route: "deterministic_check",
      reason: "deterministic_postcondition_check",
      quality_profile: "deterministic_check",
      provider_required: false,
    };
  }

  if (isSplitOrStructuralRefactorTask(task)) {
    return {
      route: "provider",
      reason: "split_or_structural_refactor_not_auto_fix",
      quality_profile: "structural_refactor",
      provider_required: true,
    };
  }

  if (task.fix_type === "AUTO_FIX") {
    return {
      route: "provider",
      reason: "mechanical_fix_requires_executor",
      quality_profile: hasOnlyScanner(task, "R6-as-unknown-as") ? "single_line_mechanical" : "default",
      provider_required: true,
    };
  }

  if (hasOnlyScanner(task, "R6-as-unknown-as") && (task.scope?.targets || []).length === 1) {
    return {
      route: "provider",
      reason: "mechanical_no_safe_recipe_yet",
      quality_profile: "single_line_mechanical",
      provider_required: true,
    };
  }

  return {
    route: "provider",
    reason: "requires_reasoning_or_unknown_recipe",
    quality_profile: "default",
    provider_required: true,
  };
}
