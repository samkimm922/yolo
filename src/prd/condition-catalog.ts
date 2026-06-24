export type UnknownRecord = Record<string, unknown>;

export interface ConditionParams extends UnknownRecord {
  command?: string;
  default?: string;
  file?: unknown;
  file_path?: unknown;
  files?: unknown;
  import_path?: string;
  max?: unknown;
  named?: unknown;
  path?: unknown;
  paths?: unknown;
  patterns?: unknown;
  target?: unknown;
  target_file?: unknown;
  targets?: unknown;
  text?: string;
  verify_command?: string;
  verifyCommand?: string;
}

export interface PrdCondition extends UnknownRecord {
  id?: string;
  type?: string;
  severity?: string;
  params?: ConditionParams;
  message?: string;
  verify_command?: string;
  verifyCommand?: string;
  invert?: boolean;
  file?: unknown;
  path?: unknown;
  target?: unknown;
  target_file?: unknown;
}

export interface PrdTarget extends UnknownRecord {
  file?: string;
}

export interface PrdScope extends UnknownRecord {
  targets?: PrdTarget[];
  expected_zero_business_code?: boolean;
  forbidden_patterns?: unknown[];
  max_files?: unknown;
  max_lines_per_file?: unknown;
}

export interface PrdTask extends UnknownRecord {
  id?: string;
  title?: string;
  description?: string;
  type?: string;
  task_kind?: string;
  priority?: string | number;
  status?: string;
  requirement_ids?: string[];
  design_ids?: string[];
  depends_on?: string[];
  scope?: PrdScope;
  pre_conditions?: PrdCondition[];
  post_conditions?: PrdCondition[];
  acceptance_criteria?: string[];
  evidence_files?: string[];
}

export interface PrdDocument extends UnknownRecord {
  id?: string;
  tasks?: PrdTask[];
  execution_mode?: string;
}

export interface EvalResult extends UnknownRecord {
  passed?: boolean;
  status?: string;
  severity?: string;
  detail?: string;
  error?: boolean;
  blocked?: boolean;
  indeterminate?: boolean;
  not_run?: boolean;
  warn?: boolean;
  manual?: boolean;
}

export interface ConditionEvaluation extends EvalResult {
  id?: string;
  type?: string;
  passed: boolean;
  status?: string;
  severity?: string;
  detail: string;
  invert?: boolean;
  unknown?: boolean;
}

export interface ConditionEvaluationSummary {
  allPass: boolean;
  failConditions: ConditionEvaluation[];
  warnConditions: ConditionEvaluation[];
  nonPassConditions: ConditionEvaluation[];
  results: ConditionEvaluation[];
}

export function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ConditionCatalogBlocker = {
  code: string;
  source: string;
  target: string;
  missing: string[];
};

type ConditionCatalogInput = {
  catalogTypes?: readonly string[];
  schemaTypes?: readonly string[];
  evaluatorTypes?: readonly string[];
};

export const CONDITION_TYPES = [
  "file_exists",
  "dir_exists",
  "file_not_exists",
  "code_contains",
  "code_not_contains",
  "code_matches",
  "ast_callback_uses_param",
  "ast_find_by_property",
  "function_contains_call",
  "function_contains_text",
  "no_new_type_errors",
  "type_errors_contain",
  "no_new_lint_errors",
  "tests_pass",
  "test_file_passes",
  "files_modified_max",
  "file_lines_max",
  "target_file_modified",
  "no_forbidden_patterns",
  "required_imports_present",
  "no_new_dead_code",
  "no_file_over_max_lines",
  "build_pass",
  "business_code_min",
  "acceptance_criteria",
];

export const MANUAL_ONLY_CONDITION_TYPES = [
  "acceptance_criteria",
];

export const BEHAVIOR_VERIFICATION_CONDITION_TYPES = [
  "build_pass",
  "no_new_lint_errors",
  "no_new_type_errors",
  "test_file_passes",
  "tests_pass",
];

export const TARGET_COVERAGE_CONDITION_TYPES = [
  "ast_callback_uses_param",
  "ast_find_by_property",
  "code_contains",
  "code_matches",
  "code_not_contains",
  "dir_exists",
  "file_exists",
  "file_lines_max",
  "file_not_exists",
  "function_contains_call",
  "function_contains_text",
  "no_file_over_max_lines",
  "required_imports_present",
  "target_file_modified",
];

export function supportedConditionTypes(): string[] {
  return [...CONDITION_TYPES].sort();
}

function sorted(values: readonly string[] = []): string[] {
  return [...new Set(values)].sort();
}

function diff(left: readonly string[] = [], right: readonly string[] = []): string[] {
  const rightSet = new Set(right);
  return sorted(left).filter((value) => !rightSet.has(value));
}

export function inspectConditionCatalogSync({
  catalogTypes = CONDITION_TYPES,
  schemaTypes = [],
  evaluatorTypes = [],
}: ConditionCatalogInput = {}) {
  const catalog = sorted(catalogTypes);
  const schema = sorted(schemaTypes);
  const evaluators = sorted(evaluatorTypes);
  const blockers: ConditionCatalogBlocker[] = [];
  const addDiff = (code: string, source: string, target: string, missing: string[]) => {
    if (missing.length > 0) blockers.push({ code, source, target, missing });
  };

  addDiff("CONDITION_CATALOG_SCHEMA_DRIFT", "catalog", "schema", diff(catalog, schema));
  addDiff("CONDITION_SCHEMA_CATALOG_DRIFT", "schema", "catalog", diff(schema, catalog));
  addDiff("CONDITION_CATALOG_EVALUATOR_DRIFT", "catalog", "evaluator", diff(catalog, evaluators));
  addDiff("CONDITION_EVALUATOR_CATALOG_DRIFT", "evaluator", "catalog", diff(evaluators, catalog));

  return {
    status: blockers.length > 0 ? "blocked" : "pass",
    blocks_execution: blockers.length > 0,
    catalog,
    schema,
    evaluators,
    blockers,
  };
}
