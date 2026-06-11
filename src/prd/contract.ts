#!/usr/bin/env node
// contract.js — v2 条件评估引擎
// 用法:
//   评估 pre_conditions:  node contract.js --task=<id> --prd=<path> --phase=pre
//   评估 post_conditions: node contract.js --task=<id> --prd=<path> --phase=post [--baseline-dir=<dir>]

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  evalAstCallbackUsesParam,
  evalAstFindByProperty,
  evalCodeContains,
  evalCodeNotContains,
  evalFunctionContainsCall,
  evalFunctionContainsText,
} from "../lib/evaluators/code-check.js";
import { evalFileExists, evalFileNotExists, evalDirExists, evalFilesModifiedMax, evalFileLinesMax, evalNoFileOverMaxLines } from "../lib/evaluators/file-check.js";
import { evalNoForbiddenPatterns, evalNoNewTypeErrors, evalTypeErrorsContain, evalNoNewLintErrors, evalNoNewDeadCode } from "../lib/evaluators/quality-check.js";
import { evalTestsPass, evalBuildPass, evalBusinessCodeMin } from "../lib/evaluators/runtime-check.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
let ROOT = PACKAGE_ROOT;

/**
 * 允许 gate 在 worktree 中运行时覆盖项目根目录。
 * 调用 evaluatePostConditions / evaluatePreConditions 之前设置。
 */
export function setContractRoot(newRoot) {
  ROOT = resolve(newRoot);
}

// ── 工具函数 ────────────────────────────────────────────────────

function scopedRoot(options = Object()) {
  return resolve(options.root || options.cwd || ROOT);
}

function createExec(root) {
  return function exec(cmd, opts = Object()) {
    const timeout = opts.timeout || 60000;
    try {
      const out = execFileSync("sh", ["-c", cmd], {
        cwd: root,
        timeout,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return { ok: true, out };
    } catch (e) {
      const errMsg = ((e.stderr || "") + (e.message || "")).toLowerCase();
      const commandNotFound = errMsg.includes("command not found") ||
                              errMsg.includes("enoent") ||
                              e.code === "ENOENT";
      return {
        ok: false,
        out: (e.stdout || "").trim(),
        err: (e.stderr || "").trim(),
        commandNotFound,
      };
    }
  };
}

// ── 从 schema 加载合法 condition type 列表 ────────────────────
import { join } from "node:path";

function loadValidConditionTypes() {
  try {
    const schemaPath = join(PACKAGE_ROOT, "schemas", "prd-v2.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    return schema["x-vocabulary"]?.conditionType || [];
  } catch {
    console.warn('[contract] 无法加载 schema condition types，使用 evaluator keys');
    return Object.keys(createEvaluators(ROOT));
  }
}

// ── 条件类型调度表 ──────────────────────────────────────────────

function createEvaluators(root) {
  const exec = createExec(root);
  return {
    code_contains: (params, ts) => evalCodeContains(params, ts, root),
    code_not_contains: (params, ts) => evalCodeNotContains(params, ts, root),
    file_exists: (params, ts) => evalFileExists(params, ts, root),
    dir_exists: (params, ts) => evalDirExists(params, ts, root),
    file_not_exists: (params, ts) => evalFileNotExists(params, ts, root),
    ast_callback_uses_param: (params, ts) => evalAstCallbackUsesParam(params, ts, root),
    ast_find_by_property: (params, ts) => evalAstFindByProperty(params, ts, root),
    function_contains_call: (params, ts) => evalFunctionContainsCall(params, ts, root),
    function_contains_text: (params, ts) => evalFunctionContainsText(params, ts, root),
    no_forbidden_patterns: (params, ts) => evalNoForbiddenPatterns(params, ts, root, exec),
    files_modified_max: (params, ts) => evalFilesModifiedMax(params, ts, root, exec),
    file_lines_max: (params, ts) => evalFileLinesMax(params, ts, root),
    no_new_type_errors: (params, ts) => evalNoNewTypeErrors(params, ts, root, exec),
    type_errors_contain: (params, ts) => evalTypeErrorsContain(params, ts, root, exec),
    no_new_lint_errors: (params, ts) => evalNoNewLintErrors(params, ts, root, exec),
    no_new_dead_code: (params, ts) => evalNoNewDeadCode(params, ts, root),
    no_file_over_max_lines: (params, ts) => evalNoFileOverMaxLines(params, ts, root),
    tests_pass: (params, ts) => evalTestsPass(params, ts, root),
    test_file_passes: (params, ts) => evalTestsPass(params, ts, root),
    build_pass: (params, ts) => evalBuildPass(params, ts, root),
    business_code_min: (params, ts) => evalBusinessCodeMin(params, ts, root, exec),
    acceptance_criteria: (params, _taskScope) => {
      const verifyCommand = (params && params.verify_command) || null;
      if (verifyCommand && typeof verifyCommand === "string") {
        // Reject commands containing pipe, redirect, or semicolon (gsd-2 rule)
        if (/[;&|>]/.test(verifyCommand)) {
          return {
            passed: false,
            status: "fail",
            detail: `验收标准 verify_command 不允许 pipe/redirect/分号: ${verifyCommand}`,
          };
        }
        const result = createExec(root)(verifyCommand, { timeout: 60000 });
        return {
          passed: result.ok,
          status: result.ok ? "pass" : "fail",
          detail: result.ok ? `验收命令通过: ${verifyCommand}` : `验收命令失败: ${verifyCommand}${result.err ? " — " + result.err : ""}`,
        };
      }
      // No executable verify command — mark as manual (blocked at delivery gate)
      return {
        passed: true,
        status: "pass",
        detail: params?.text || "验收标准（需人工复核）",
        manual: true,
        warn: true,
      };
    },
    code_matches: (params, ts) => evalCodeContains({ ...params, is_regex: true }, ts, root),
    target_file_modified: (params, ts) => {
      const targetFile = params.file || ts?.targets?.[0]?.file;
      if (!targetFile) {
        return {
          passed: false,
          status: "not_run",
          detail: "无目标文件指定，无法验证目标文件是否修改",
        };
      }
      const r = exec("git diff --name-only HEAD", { timeout: 10000 });
      if (!r.ok) {
        return {
          passed: false,
          status: "indeterminate",
          detail: "无法获取 git diff，无法验证目标文件是否修改",
        };
      }
      const modified = r.out.split("\n").filter(Boolean);
      const found = modified.some((f) => f === targetFile || f.endsWith(targetFile));
      return { passed: found, detail: found ? `目标文件 ${targetFile} 已修改` : `目标文件 ${targetFile} 未在修改列表中`, found: found ? 1 : 0 };
    },
    required_imports_present: (params, ts) => {
      const files = params.files || params.file
        ? [params.file || params.files].flat()
        : ts?.targets?.map((t) => t.file) || [];
      if (!files.length) {
        return {
          passed: false,
          status: "not_run",
          detail: "无文件指定，无法验证 required_imports_present",
        };
      }
      const importPath = params.import_path;
      if (!importPath) return { passed: false, detail: "缺少 import_path 参数" };
      const missingFiles = [];
      const checkedFiles = [];
      for (const f of files) {
        const absPath = resolve(root, f);
        if (!existsSync(absPath)) {
          missingFiles.push(f);
          continue;
        }
        checkedFiles.push(f);
        const content = readFileSync(absPath, "utf8");
        const re = new RegExp(`import\\b.*from\\s*['"]${importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`);
        if (!re.test(content)) return { passed: false, detail: `${f} 缺少导入: ${importPath}` };
      }
      if (missingFiles.length > 0) {
        return {
          passed: false,
          status: "indeterminate",
          detail: `指定文件不存在，无法验证导入 ${importPath}: ${missingFiles.join(", ")}`,
          checked_files: checkedFiles,
          missing_files: missingFiles,
        };
      }
      return { passed: true, detail: `所有文件已导入: ${importPath}` };
    },
  };
}

export function supportedConditionTypes() {
  return Object.keys(createEvaluators(ROOT)).sort();
}

/**
 * 评估单个条件
 * @returns {{ id, type, passed, severity, detail, ... }}
 */
const NON_PASS_STATUSES = new Set(["fail", "warning", "not_run", "indeterminate", "blocked", "error"]);
const INVERTIBLE_STATUSES = new Set(["pass", "fail"]);

function normalizeEvaluatorStatus(result = Object()) {
  if (result.status === "pass" || NON_PASS_STATUSES.has(result.status)) return result.status;
  if (result.error) return "error";
  if (result.blocked) return "blocked";
  if (result.indeterminate) return "indeterminate";
  if (result.not_run) return "not_run";
  if (result.warn) return "warning";
  return result.passed ? "pass" : "fail";
}

function evaluateCondition(condition, taskScope, options = Object()) {
  const { id, type, params = Object(), severity = "FAIL", invert = false } =
    condition;

  const fn = createEvaluators(scopedRoot(options))[condition.type];
  if (!fn) {
    return {
      id: condition.id || "UNKNOWN",
      type: condition.type,
      passed: false,
      severity: "FAIL",
      detail: `未知条件类型: ${condition.type}。合法类型请参见 schemas/prd-v2.schema.json`,
    };
  }

  try {
    const result = fn(params, taskScope);
    let status = normalizeEvaluatorStatus(result);
    let passed = status === "pass";
    if (invert && INVERTIBLE_STATUSES.has(status)) {
      status = status === "pass" ? "fail" : "pass";
      passed = status === "pass";
    }
    const { passed: _p, status: _status, ...rest } = result;
    return {
      id,
      type,
      passed,
      status,
      severity,
      detail: result.detail || "",
      invert,
      ...rest,
    };
  } catch (e) {
    return {
      id,
      type,
      passed: false,
      status: "error",
      severity,
      detail: `评估异常: ${e.message}`,
      error: true,
    };
  }
}

/**
 * 评估一组条件
 * @returns {{ allPass, failConditions, warnConditions, results }}
 */
function evaluateConditions(conditions, taskScope, options = Object()) {
  const results = conditions.map((c) => evaluateCondition(c, taskScope, options));
  const nonPassConditions = results.filter((r) => r.status !== "pass" || r.passed !== true);
  const failConditions = results.filter(
    (r) => (r.status !== "pass" || r.passed !== true) &&
      (r.severity === "FAIL" || (r.status !== "warning" && r.status !== "pass")) &&
      !r.unknown,
  );
  const warnConditions = results.filter(
    (r) => (r.status !== "pass" || r.passed !== true) &&
      (r.severity === "WARN" || r.status === "warning"),
  );
  const allPass = nonPassConditions.length === 0;

  return { allPass, failConditions, warnConditions, nonPassConditions, results };
}

// ── 主要 API ────────────────────────────────────────────────────

/**
 * 从 PRD 文件加载任务
 */
function loadTask(prdPath, taskId) {
  const prd = JSON.parse(readFileSync(resolve(prdPath), "utf8"));
  const task = (prd.tasks || []).find((t) => t.id === taskId);
  if (!task) throw new Error(`PRD 中未找到任务: ${taskId}`);
  return { task, prd };
}

/**
 * 评估 pre_conditions（修前验证）
 */
export function evaluatePreConditions(task, prd, options = Object()) {
  const conditions = task.pre_conditions || [];
  if (conditions.length === 0) {
    return { allPass: true, failConditions: [], warnConditions: [], nonPassConditions: [], results: [] };
  }
  return evaluateConditions(conditions, task.scope, options);
}

/**
 * 评估 post_conditions（修后验证）
 * 自动追加 auto-conditions
 */
export function evaluatePostConditions(task, prd, options = Object()) {
  const explicitConditions = task.post_conditions || [];
  const scope = task.scope || {};

  // 自动追加 forbidden_patterns 检查（如果用户没显式添加）
  const hasForbiddenCheck = explicitConditions.some(
    (c) => c.type === "no_forbidden_patterns",
  );
  const autoConditions = [];
  if (
    !hasForbiddenCheck &&
    scope.forbidden_patterns &&
    scope.forbidden_patterns.length > 0
  ) {
    autoConditions.push({
      id: "AUTO-no_forbidden_patterns",
      type: "no_forbidden_patterns",
      params: { patterns: scope.forbidden_patterns },
      message: "diff 新增行不含禁用模式",
      severity: "WARN",
    });
  }

  const hasFilesMax = explicitConditions.some(
    (c) => c.type === "files_modified_max",
  );
  if (!hasFilesMax && scope.max_files) {
    autoConditions.push({
      id: "AUTO-files_modified_max",
      type: "files_modified_max",
      params: { max: scope.max_files },
      message: `修改文件数 ≤ ${scope.max_files}`,
      severity: "FAIL",
    });
  }

  const hasLinesMax = explicitConditions.some(
    (c) => c.type === "file_lines_max",
  );
  if (!hasLinesMax && scope.max_lines_per_file) {
    autoConditions.push({
      id: "AUTO-file_lines_max",
      type: "file_lines_max",
      params: { max: scope.max_lines_per_file },
      message: `单文件 ≤ ${scope.max_lines_per_file} 行`,
      severity: "FAIL",
    });
  }

  const allConditions = [...explicitConditions, ...autoConditions];

  // 自动追加 business_code_min(修复 bug #2:0 业务代码不能 PASS)
  // 任务可通过 scope.expected_zero_business_code = true 豁免
  const hasBizMin = allConditions.some((c) => c.type === "business_code_min");
  if (!hasBizMin) {
    allConditions.push({
      id: "AUTO-business_code_min",
      type: "business_code_min",
      params: { min: 1 },
      message: "至少 1 个真实代码/测试文件改动 (src/**, cloudfunctions/**, __tests__/**, tests/**)",
      severity: "FAIL",
    });
  }

  return evaluateConditions(allConditions, scope, options);
}

/**
 * 序列化为 gate 兼容格式（供 gate.js 使用）
 */
export function toGateFormat(result) {
  const gates = [];
  const allResults = result.results || [];

  for (const r of allResults) {
    gates.push({
      name: r.id,
      passed: r.passed,
      status: r.status || (r.passed ? "pass" : "fail"),
      severity: r.severity,
      detail: r.detail || "",
      type: r.type,
    });
  }

  const failHigh = gates.some(
    (g) => g.status !== "pass" && (g.severity === "FAIL" || g.status !== "warning"),
  );
  const allPass = gates.every((g) => g.status === "pass" && g.passed === true);

  return {
    allPass,
    failHigh,
    gates,
    failConditions: result.failConditions,
    warnConditions: result.warnConditions,
  };
}

// ── CLI ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = Object();
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--(\w[\w-]*)=(.*)$/);
    if (m) args[m[1]] = m[2];
    else if (a === "--json") args.json = true;
  }
  return args;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

export function runContractCli() {
  const args = parseArgs();
  const { task: taskId, prd: prdPath, phase, json } = args;

  if (!taskId || !prdPath || !phase) {
    console.error(
      "用法: node contract.js --task=<id> --prd=<path> --phase=pre|post [--json]",
    );
    process.exit(1);
  }

  try {
    const { task, prd } = loadTask(prdPath, taskId);
    let result;

    if (phase === "pre") {
      result = evaluatePreConditions(task, prd);
    } else if (phase === "post") {
      result = evaluatePostConditions(task, prd);
    } else {
      console.error(`未知 phase: ${phase}（应为 pre 或 post）`);
      process.exit(1);
    }

    if (json) {
      console.log(JSON.stringify(toGateFormat(result), null, 2));
    } else {
      console.log(
        `[${phase.toUpperCase()}] ${result.allPass ? "✅ PASS" : "❌ FAIL"}`,
      );
      for (const r of result.results || []) {
        const icon = r.passed ? "✓" : "✗";
        console.log(`  ${icon} [${r.severity}] ${r.id}: ${r.detail}`);
      }
      if (!result.allPass) {
        console.log(
          `\n失败 ${result.failConditions.length} 条，警告 ${result.warnConditions.length} 条`,
        );
      }
    }

    process.exit(result.allPass ? 0 : 1);
  } catch (e) {
    console.error(`错误: ${e.message}`);
    process.exit(2);
  }
}

if (isMain) runContractCli();
