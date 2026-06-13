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

export function supportedConditionTypes() {
  return [...CONDITION_TYPES].sort();
}

function sorted(values = []) {
  return [...new Set(values)].sort();
}

function diff(left = [], right = []) {
  const rightSet = new Set(right);
  return sorted(left).filter((value) => !rightSet.has(value));
}

export function inspectConditionCatalogSync({
  catalogTypes = CONDITION_TYPES,
  schemaTypes = [],
  evaluatorTypes = [],
} = Object()) {
  const catalog = sorted(catalogTypes);
  const schema = sorted(schemaTypes);
  const evaluators = sorted(evaluatorTypes);
  const blockers = [];
  const addDiff = (code, source, target, missing) => {
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
