export type ConditionSeverity = string;

export type ForbiddenPattern = string | {
  pattern: string;
  is_regex?: boolean;
  flags?: string;
  message?: string;
  description?: string;
  severity?: ConditionSeverity;
};

export type CountConstraint = {
  min?: number;
  max?: number;
  exact?: number;
};

export type LineConstraint = number | [number, number];

export type EvalParams = {
  file?: string;
  path?: string;
  files?: string[] | string;
  targets?: string[] | string;
  text?: string;
  pattern?: string;
  code?: string;
  flags?: string;
  count?: CountConstraint;
  line?: LineConstraint | null;
  is_regex?: boolean;
  function?: string;
  function_name?: string;
  name?: string;
  callee?: string;
  call?: string;
  param?: string;
  parameter?: string;
  callback?: string;
  property?: string;
  key?: string;
  value?: unknown;
  allow_missing?: boolean;
  max?: number;
  min?: number;
  max_delta_on_legacy?: number;
  legacy_delta_max?: number;
  delete_intent?: boolean;
  deleteIntent?: boolean;
  command?: string;
  test_file?: string;
  timeout_ms?: number;
  patterns?: ForbiddenPattern[];
  scan_scope?: string;
  verify_command?: string;
  import_path?: string;
  named?: string[];
  default?: string;
  [key: string]: unknown;
};

export type TaskScopeTarget = {
  file?: string;
  [key: string]: unknown;
};

export type TaskScope = {
  targets?: TaskScopeTarget[];
  changedFiles?: unknown;
  changed_files?: unknown;
  forbidden_patterns?: ForbiddenPattern[];
  scan_scope?: string;
  expected_zero_business_code?: boolean;
  [key: string]: unknown;
};

export type ExecResult = {
  ok: boolean;
  out: string;
  err?: string;
  commandNotFound?: boolean;
  exitCode?: number | null;
};

export type ExecOptions = {
  timeout?: number;
};

export type ExecFn = (cmd: string, opts?: ExecOptions) => ExecResult;

export type EvaluatorOptions = {
  config?: unknown;
  changedFiles?: unknown;
  changed_files?: unknown;
  [key: string]: unknown;
};

export type EvalResult = {
  passed: boolean;
  detail: string;
  status?: string;
  found?: number;
  type?: string;
  [key: string]: unknown;
};
