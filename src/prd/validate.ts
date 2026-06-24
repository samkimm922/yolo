#!/usr/bin/env node
/**
 * validate-prd.js — PRD Schema 机械验证
 *
 * 使用 AJV 校验 PRD JSON 是否严格符合 prd-v2.schema.json
 * 挂在所有 PRD 写入/读取路径前，确保数据格式一致性
 *
 * 用法:
 *   node validate-prd.js <prd.json>          # 验证文件
 *   node validate-prd.js --check-all          # 验证所有已知 PRD 文件
 *   node validate-prd.js <prd.json> --json    # JSON 输出（程序化调用）
 *
 * 退出码: 0=合规  1=违规  2=文件不存在/读取出错
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ErrorObject } from 'ajv';
import { readJsonFileBounded } from '../lib/bounded-read.js';
import { asRecord, errorMessage, isRecord, type UnknownRecord } from "./condition-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

type JsonSchema = unknown;
type AjvValidateFunction = {
  (data: unknown): boolean;
  errors?: ErrorObject[] | null;
};
type AjvInstance = {
  compile(schema: JsonSchema): AjvValidateFunction;
};
type AjvRuntimeConstructor = new (options?: {
  allErrors?: boolean;
  strict?: boolean;
  validateFormats?: boolean;
}) => AjvInstance;

function isAjvConstructor(value: unknown): value is AjvRuntimeConstructor {
  return typeof value === "function";
}

type ValidateOptions = UnknownRecord & {
  ajv?: AjvInstance;
  schema?: JsonSchema;
};

type ValidationErrorDetail = {
  path: string;
  keyword: string;
  message?: string;
  params?: unknown;
};

type ValidationSummary = {
  missing_required: number;
  wrong_enum: number;
  wrong_type: number;
  pattern_fail: number;
  unsafe_control_chars?: number;
};

type ValidatePrdResult = UnknownRecord & {
  ok: boolean;
  code?: string;
  details?: ValidationErrorDetail[];
  error?: string;
  file?: string;
  summary?: ValidationSummary;
  warnings?: string[];
};

type ValidateAllResult = {
  [key: string]: unknown;
  passed: number;
  failed: number;
  results: ValidatePrdResult[];
};

type UnsafeControlCharError = ValidationErrorDetail & {
  params: {
    allowed_controls: string[];
  };
};

// 动态加载 ajv
let Ajv: AjvRuntimeConstructor | null;
try {
  const ajvMod = await import('ajv');
  const defaultExport: unknown = ajvMod.default;
  Ajv = isAjvConstructor(defaultExport) ? defaultExport : null;
} catch {
  if (isMain) console.error('[validate-prd] ajv 未安装，跳过验证');
  Ajv = null;
}

const SCHEMA_PATH = resolve(PACKAGE_ROOT, 'schemas', 'prd-v2.schema.json');

export function loadSchema(): JsonSchema | null {
  if (!existsSync(SCHEMA_PATH)) {
    console.error(`[validate-prd] Schema 文件不存在: ${SCHEMA_PATH}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8')) as JsonSchema;
  } catch (e) {
    console.error(`[validate-prd] Schema 解析失败: ${errorMessage(e)}`);
    return null;
  }
}

// ── AJV 错误消息中文化 ────────────────────────────────────────────
const ERROR_MESSAGES_ZH: Record<string, string> = {
  "must be equal to constant": "值必须等于",
  "must match pattern": "格式不符合规则",
  "must have required property": "缺少必填字段",
  "must NOT have additional properties": "包含不允许的额外字段",
  "must be string": "必须是字符串",
  "must be number": "必须是数字",
  "must be array": "必须是数组",
  "must be object": "必须是对象",
  "must be >= 1": "不能为空（至少 1 个元素）",
  "must match exactly one schema in oneOf": "字段格式不符合任何一种允许的类型",
  "must be equal to one of the allowed values": "值不在允许的列表中",
  "must NOT be shorter than": "长度不能少于",
  "must NOT be longer than": "长度不能超过",
};

export function translateAjvError(err: ErrorObject | ValidationErrorDetail) {
  let zh = err.message || "";
  for (const [en, cn] of Object.entries(ERROR_MESSAGES_ZH)) {
    if (zh.includes(en)) {
      zh = zh.replace(en, cn);
      break;
    }
  }
  const path = "instancePath" in err ? err.instancePath || "" : err.path || "";
  const params = err.params ? JSON.stringify(err.params) : "";
  return `字段 ${path || "(根)"}: ${zh} ${params}`;
}

export function validateFile(prdPath: string, schema: JsonSchema, ajv: AjvInstance): ValidatePrdResult {
  if (!existsSync(prdPath)) {
    return { ok: false, error: `文件不存在: ${prdPath}` };
  }

  let prd;
  try {
    prd = readJsonFileBounded<unknown>(prdPath, { errorCode: "PRD_JSON_SIZE_LIMIT_EXCEEDED" });
  } catch (e) {
    return { ok: false, error: `JSON 解析失败: ${errorMessage(e)}` };
  }

  return validatePrdDocument(prd, schema, ajv, { file: prdPath });
}

export function validatePrdDocument(prd: unknown, schema: JsonSchema, ajv: AjvInstance, options: UnknownRecord = {}): ValidatePrdResult {
  const validate = ajv.compile(schema);
  const valid = validate(prd);

  if (!valid) {
    const errors: ValidationErrorDetail[] = (validate.errors || []).map((e: ErrorObject) => ({
      path: e.instancePath || '(root)',
      keyword: e.keyword,
      message: e.message,
      params: e.params,
    }));

    // 按严重性分类
    const missingRequired = errors.filter(e => e.keyword === 'required');
    const wrongEnum = errors.filter(e => e.keyword === 'enum');
    const wrongType = errors.filter(e => e.keyword === 'type');
    const patternFail = errors.filter(e => e.keyword === 'pattern');

    return {
      ok: false,
      error: `${errors.length} 条 schema 违规`,
      details: errors,
      summary: {
        missing_required: missingRequired.length,
        wrong_enum: wrongEnum.length,
        wrong_type: wrongType.length,
        pattern_fail: patternFail.length,
      },
    };
  }

  const controlCharErrors = collectUnsafeControlCharErrors(prd);
  if (controlCharErrors.length > 0) {
    return {
      ok: false,
      error: `${controlCharErrors.length} 条 unsafe control character 违规`,
      details: controlCharErrors,
      summary: {
        missing_required: 0,
        wrong_enum: 0,
        wrong_type: 0,
        pattern_fail: 0,
        unsafe_control_chars: controlCharErrors.length,
      },
    };
  }

  // 额外语义检查（Schema 覆盖不到的逻辑）
  const warnings: string[] = [];

  // 检查 condition.type 是否有对应 EVALUATORS 实现
  // 从 schema 动态读取 condition type 枚举
  let knownEvaluatorTypes: string[] = [];
  try {
    const schemaRaw = readFileSync(SCHEMA_PATH, 'utf8');
    const schemaObj = asRecord(JSON.parse(schemaRaw) as unknown);
    const vocabulary = asRecord(schemaObj["x-vocabulary"]);
    const properties = asRecord(schemaObj.properties);
    const tasks = asRecord(properties.tasks);
    const items = asRecord(tasks.items);
    const taskProperties = asRecord(items.properties);
    const preConditions = asRecord(taskProperties.pre_conditions);
    const preConditionItems = asRecord(preConditions.items);
    const preConditionProperties = asRecord(preConditionItems.properties);
    const conditionType = asRecord(preConditionProperties.type);
    const types = vocabulary.conditionType || conditionType.enum || [];
    knownEvaluatorTypes = Array.isArray(types) ? types.map(String) : [];
  } catch {
    // 硬编码 fallback（仅 schema 文件损坏时使用）
    knownEvaluatorTypes = [
      'code_contains', 'code_not_contains',
      'file_exists', 'file_not_exists',
      'no_new_type_errors', 'no_new_lint_errors',
      'tests_pass',
      'files_modified_max', 'file_lines_max',
      'no_forbidden_patterns', 'no_new_dead_code',
      'acceptance_criteria',
      'no_file_over_max_lines', 'build_pass', 'business_code_min',
    ];
  }

  const prdRecord = asRecord(prd);
  const prdTasks = Array.isArray(prdRecord.tasks) ? prdRecord.tasks : [];
  for (const taskValue of prdTasks) {
    const task = asRecord(taskValue);
    // 检查 task ID 格式
    if (typeof task.id === "string" && !/^[A-Z]+-[A-Z0-9-]+/.test(task.id)) {
      warnings.push(`${task.id}: ID 格式不标准，建议 TYPE-SUBSYSTEM-NUMBER`);
    }

    // 检查条件类型
    const preConditions = Array.isArray(task.pre_conditions) ? task.pre_conditions : [];
    const postConditions = Array.isArray(task.post_conditions) ? task.post_conditions : [];
    const allConds = [
      ...preConditions,
      ...postConditions,
    ];
    for (const condValue of allConds) {
      const cond = asRecord(condValue);
      if (typeof cond.type === "string" && !knownEvaluatorTypes.includes(cond.type)) {
        warnings.push(`${task.id}: 未知条件类型 "${cond.type}"，将静默通过`);
      }
    }

    // 检查 priority 格式
    if (task.priority !== undefined && typeof task.priority === 'number') {
      warnings.push(`${task.id}: priority 应为字符串 (P0-P3)，当前为数字 ${task.priority}`);
    }
  }

  return { ok: true, warnings: warnings.length > 0 ? warnings : [] };
}

const UNSAFE_CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const MAX_CONTROL_CHAR_ERRORS = 25;

function jsonPointerEscape(value: unknown): string {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

function jsonPointer(path: string[]): string {
  return path.length > 0 ? `/${path.map(jsonPointerEscape).join("/")}` : "(root)";
}

function hasUnsafeControlChar(value: string): boolean {
  return UNSAFE_CONTROL_CHAR_PATTERN.test(value);
}

function collectUnsafeControlCharErrors(
  value: unknown,
  path: string[] = [],
  errors: UnsafeControlCharError[] = [],
  seen = new WeakSet<object>(),
): UnsafeControlCharError[] {
  if (errors.length >= MAX_CONTROL_CHAR_ERRORS || value == null) return errors;
  if (typeof value === "string") {
    if (hasUnsafeControlChar(value)) {
      errors.push({
        path: jsonPointer(path),
        keyword: "unsafeControlCharacter",
        message: "must not contain NUL, ESC, DEL, or other non-printable control characters",
        params: { allowed_controls: ["\\t", "\\n", "\\r"] },
      });
    }
    return errors;
  }
  if (typeof value !== "object") return errors;
  if (seen.has(value)) return errors;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectUnsafeControlCharErrors(item, [...path, String(index)], errors, seen));
    return errors;
  }
  for (const [key, child] of Object.entries(value)) {
    if (hasUnsafeControlChar(key) && errors.length < MAX_CONTROL_CHAR_ERRORS) {
      errors.push({
        path: jsonPointer([...path, key]),
        keyword: "unsafeControlCharacter",
        message: "property name must not contain NUL, ESC, DEL, or other non-printable control characters",
        params: { allowed_controls: ["\\t", "\\n", "\\r"] },
      });
    }
    collectUnsafeControlCharErrors(child, [...path, key], errors, seen);
    if (errors.length >= MAX_CONTROL_CHAR_ERRORS) break;
  }
  return errors;
}

export function checkAllPrds(schema: JsonSchema, ajv: AjvInstance): ValidatePrdResult[] {
  const dataDirs = [
    join(PACKAGE_ROOT, 'data', 'prd', 'current'),
    join(PACKAGE_ROOT, 'data', 'prd', 'archive'),
  ];
  const prdFiles: string[] = [];

  for (const dataDir of dataDirs) {
    if (!existsSync(dataDir)) continue;
    for (const f of readdirSync(dataDir)) {
      if (f.endsWith('.json')) {
        prdFiles.push(join(dataDir, f));
      }
    }
  }

  const results: ValidatePrdResult[] = [];
  for (const f of prdFiles) {
    const result = validateFile(f, schema, ajv);
    results.push({ file: f.replace(PACKAGE_ROOT + '/', ''), ...result });
  }

  return results;
}

export function validatePrdPath(prdPath: string, options: ValidateOptions = {}): ValidatePrdResult {
  const AjvCtor = Ajv;
  if (!AjvCtor) {
    return {
      ok: false,
      skipped: false,
      code: "PRD_SCHEMA_VALIDATOR_UNAVAILABLE",
      error: "ajv 未安装，无法执行 PRD schema 验证",
      warnings: [],
    };
  }
  const schema = options.schema || loadSchema();
  if (!schema) return { ok: false, error: "Schema 文件不存在或无法解析" };
  const ajv = options.ajv || new AjvCtor({ allErrors: true, strict: false, validateFormats: false });
  return validateFile(resolve(prdPath), schema, ajv);
}

export function validatePrdObject(prd: unknown, options: ValidateOptions = {}): ValidatePrdResult {
  const AjvCtor = Ajv;
  if (!AjvCtor) {
    return {
      ok: false,
      skipped: false,
      code: "PRD_SCHEMA_VALIDATOR_UNAVAILABLE",
      error: "ajv 未安装，无法执行 PRD schema 验证",
      warnings: [],
    };
  }
  const schema = options.schema || loadSchema();
  if (!schema) return { ok: false, error: "Schema 文件不存在或无法解析" };
  const ajv = options.ajv || new AjvCtor({ allErrors: true, strict: false, validateFormats: false });
  return validatePrdDocument(prd, schema, ajv, options);
}

export function validateAllPrds(options: ValidateOptions = {}): ValidateAllResult {
  const AjvCtor = Ajv;
  if (!AjvCtor) {
    return {
      passed: 0,
      failed: 1,
      skipped: false,
      results: [{
        ok: false,
        code: "PRD_SCHEMA_VALIDATOR_UNAVAILABLE",
        error: "ajv 未安装，无法执行 PRD schema 验证",
      }],
    };
  }
  const schema = options.schema || loadSchema();
  if (!schema) return { passed: 0, failed: 1, results: [{ ok: false, error: "Schema 文件不存在或无法解析" }] };
  const ajv = options.ajv || new AjvCtor({ allErrors: true, strict: false, validateFormats: false });
  const results = checkAllPrds(schema, ajv);
  return {
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

function printSingleResult(prdPath: string, result: ValidatePrdResult) {
  if (result.ok) {
    console.log(`[validate-prd] ✓ ${prdPath} 合规`);
  } else {
    console.error(`[validate-prd] ✗ ${prdPath}: ${result.error}`);
    if (result.details) {
      for (let i = 0; i < Math.min(result.details.length, 10); i++) {
        console.error(`  ✗ ${translateAjvError(result.details[i])}`);
      }
      if (result.details.length > 10) {
        console.error(`  ... 及其他 ${result.details.length - 10} 条`);
      }
    }
  }
  if (result.warnings?.length) {
    for (const warning of result.warnings) console.log(`  ! ${warning}`);
  }
}

export function runValidatePrdCli() {
  const args = process.argv.slice(2);
  const checkAll = args.includes('--check-all');
  const jsonOutput = args.includes('--json');
  const prdPath = args.find(a => !a.startsWith('--'));

  if (!Ajv) {
    const result = {
      ok: false,
      code: "PRD_SCHEMA_VALIDATOR_UNAVAILABLE",
      error: "ajv 未安装，无法执行 PRD schema 验证",
    };
    if (jsonOutput) console.log(JSON.stringify(result, null, 2));
    else console.error(`[validate-prd] ✗ ${result.error}`);
    process.exit(1);
  }

  if (checkAll) {
    const result = validateAllPrds();

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`[validate-prd] 检查 ${result.results.length} 个 PRD 文件`);
      for (const item of result.results) {
        const icon = item.ok ? '✓' : '✗';
        console.log(`  ${icon} ${item.file}: ${item.ok ? '合规' : item.error}`);
        if (item.warnings?.length) {
          for (const warning of item.warnings) console.log(`    ! ${warning}`);
        }
      }
      console.log(`\n  合规: ${result.passed}  违规: ${result.failed}`);
    }

    process.exit(result.failed > 0 ? 1 : 0);
  }

  if (prdPath) {
    const result = validatePrdPath(prdPath);

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printSingleResult(prdPath, result);
    }

    process.exit(result.ok ? 0 : 1);
  }

  console.log('用法: node validate-prd.js <prd.json> [--json]');
  console.log('       node validate-prd.js --check-all [--json]');
  process.exit(2);
}

if (isMain) runValidatePrdCli();
