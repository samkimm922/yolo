// task-router.js — deterministic route selection before spending provider time

const AUTO_FIX_RECIPES = new Set([
  "debug-console-log",
  "debug-debugger",
  "raw-collection",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function scannerIds(task: unknown = Object()): string[] {
  const rec = asRecord(task);
  const findings = asArray<unknown>(rec.source_findings).length > 0
    ? asArray<unknown>(rec.source_findings)
    : asArray<unknown>(rec.fix_findings);
  return findings
    .map((finding) => {
      const fRec = asRecord(finding);
      const id = fRec.scanner_id ?? fRec.rule_id;
      return typeof id === "string" ? id : "";
    })
    .filter(Boolean);
}

function hasOnlyScanner(task: unknown, scannerId: string): boolean {
  const ids = scannerIds(task);
  return ids.length > 0 && ids.every((id) => id === scannerId);
}

export function isSplitOrStructuralRefactorTask(task: unknown = Object()): boolean {
  const rec = asRecord(task);
  const text = `${asString(rec.title)}\n${asString(rec.description)}`.toLowerCase();
  const ids = scannerIds(task);
  const scope = asRecord(rec.scope);
  return scope.allow_new_files === true ||
    ids.includes("R9-file-length") ||
    /拆分|split|提取|文件.*行|file-length|超过\s*\d+\s*行/.test(text);
}

export function hasAutoFixRecipe(task: unknown = Object()): boolean {
  const rec = asRecord(task);
  const rule = asString(rec.fix_rule) || scannerIds(task)[0] || "";
  return AUTO_FIX_RECIPES.has(rule);
}

function sourceFindings(task: unknown = Object()): unknown[] {
  const rec = asRecord(task);
  const primary = asArray<unknown>(rec.source_findings);
  if (primary.length > 0) return primary;
  return asArray<unknown>(rec.fix_findings);
}

function isTestFile(filePath: string = ""): boolean {
  return filePath.includes("/__tests__/") || /\.(test|spec)\.[tj]sx?$/.test(filePath);
}

export function hasSafeR6UnknownAsRecipe(task: unknown = Object()): boolean {
  const rec = asRecord(task);
  const scope = asRecord(rec.scope);
  const targets = asArray<unknown>(scope.targets);
  if (!hasOnlyScanner(task, "R6-as-unknown-as") || targets.length !== 1) return false;
  const firstTarget = asRecord(targets[0]);
  const targetFile = asString(firstTarget.file);
  if (!isTestFile(targetFile)) return false;
  const findings = sourceFindings(task);
  if (findings.length === 0) return false;
  return findings.every((finding) => {
    const fRec = asRecord(finding);
    const findingFile = asString(fRec.file) || targetFile;
    const text = `${asString(fRec.context)}\n${asString(fRec.match)}`;
    return findingFile === targetFile &&
      /as unknown as/.test(text) &&
      /mockReturnValue|vi\.mocked|TypedCollection<unknown>/.test(text);
  });
}

export function classifyTaskExecution(task: unknown = Object()): {
  route: string;
  reason: string;
  quality_profile: string;
  provider_required: boolean;
} {
  const rec = asRecord(task);
  if (rec.task_kind === "deterministic_check" || rec.execution_mode === "deterministic_check") {
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

  if (rec.fix_type === "AUTO_FIX") {
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

  const scope = asRecord(rec.scope);
  if (hasOnlyScanner(task, "R6-as-unknown-as") && asArray<unknown>(scope.targets).length === 1) {
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
