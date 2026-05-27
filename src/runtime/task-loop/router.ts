// task-router.js — deterministic route selection before spending provider time

const AUTO_FIX_RECIPES = new Set([
  "debug-console-log",
  "debug-debugger",
  "raw-collection",
]);

function scannerIds(task = {}) {
  return (task.source_findings || task.fix_findings || [])
    .map((finding) => finding.scanner_id || finding.rule_id)
    .filter(Boolean);
}

function hasOnlyScanner(task, scannerId) {
  const ids = scannerIds(task);
  return ids.length > 0 && ids.every((id) => id === scannerId);
}

export function isSplitOrStructuralRefactorTask(task = {}) {
  const text = `${task.title || ""}\n${task.description || ""}`.toLowerCase();
  const ids = scannerIds(task);
  return task.scope?.allow_new_files === true ||
    ids.includes("R9-file-length") ||
    /拆分|split|提取|文件.*行|file-length|超过\s*\d+\s*行/.test(text);
}

export function hasAutoFixRecipe(task = {}) {
  const rule = task.fix_rule || scannerIds(task)[0] || "";
  return AUTO_FIX_RECIPES.has(rule);
}

function sourceFindings(task = {}) {
  return task.source_findings || task.fix_findings || [];
}

function isTestFile(filePath = "") {
  return filePath.includes("/__tests__/") || /\.(test|spec)\.[tj]sx?$/.test(filePath);
}

export function hasSafeR6UnknownAsRecipe(task = {}) {
  const targets = task.scope?.targets || [];
  if (!hasOnlyScanner(task, "R6-as-unknown-as") || targets.length !== 1) return false;
  const targetFile = targets[0]?.file || "";
  if (!isTestFile(targetFile)) return false;
  const findings = sourceFindings(task);
  if (findings.length === 0) return false;
  return findings.every((finding) => {
    const findingFile = finding.file || targetFile;
    const text = `${finding.context || ""}\n${finding.match || ""}`;
    return findingFile === targetFile &&
      /as unknown as/.test(text) &&
      /mockReturnValue|vi\.mocked|TypedCollection<unknown>/.test(text);
  });
}

export function classifyTaskExecution(task = {}) {
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

  if (hasSafeR6UnknownAsRecipe(task)) {
    return {
      route: "auto_fix",
      reason: "safe_r6_test_mock_cast_recipe",
      quality_profile: "deterministic_recipe",
      provider_required: false,
    };
  }

  if (task.fix_type === "AUTO_FIX") {
    if (hasAutoFixRecipe(task)) {
      return {
        route: "auto_fix",
        reason: "known_deterministic_recipe",
        quality_profile: "deterministic_recipe",
        provider_required: false,
      };
    }
    return {
      route: "provider",
      reason: "auto_fix_requested_but_no_recipe",
      quality_profile: "default",
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
