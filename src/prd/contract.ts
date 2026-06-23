#!/usr/bin/env node
// contract.js — v2 条件评估引擎
// 用法:
//   评估 pre_conditions:  node contract.js --task=<id> --prd=<path> --phase=pre
//   评估 post_conditions: node contract.js --task=<id> --prd=<path> --phase=post [--baseline-dir=<dir>]

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, isAbsolute, relative, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { supportedConditionTypes as catalogSupportedConditionTypes } from "./condition-catalog.js";
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
import { parseCommandToArgv } from "../lib/security/command-guard.js";
import { execArgv, execCommand } from "../lib/security/safe-exec.js";
import { resolveWithinRoot } from "../lib/security/path-guard.js";

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
    // P12.I1: route through safe-exec — untrusted command strings are parsed
    // to argv and rejected if they contain unquoted shell metacharacters.
    // `2>&1` redirections in the cmd are handled by capturing both streams.
    const stripped = String(cmd ?? "").replace(/\s*2>&1\s*$/, "");
    const result = execCommand(stripped, { cwd: root, timeout });
    const trimmedOut = result.stdout.trim();
    if (result.rejected) {
      return {
        ok: false,
        out: "",
        err: result.stderr,
        commandNotFound: false,
        exitCode: null,
      };
    }
    return {
      ok: result.ok,
      out: trimmedOut,
      err: result.stderr.trim(),
      commandNotFound: result.command_not_found,
      exitCode: result.exit_code,
    };
  };
}

function normalizeRepoFilePath(file, root = ROOT) {
  const raw = typeof file === "string" ? file : file?.file || file?.path || "";
  let normalized = String(raw ?? "").trim().replace(/\\/g, "/");
  if (!normalized) return "";
  if (isAbsolute(normalized)) {
    const relativePath = relative(root, normalized).replace(/\\/g, "/");
    if (relativePath && relativePath !== "." && !relativePath.startsWith("../") && relativePath !== "..") {
      normalized = relativePath;
    }
  }
  normalized = normalize(normalized).replace(/\\/g, "/").replace(/^\.\/+/, "");
  return normalized === "." ? "" : normalized;
}

function changedFilesFromOptions(options = Object(), root = ROOT) {
  const candidates = [
    options.changedFiles,
    options.changed_files,
  ];
  const files = candidates.find((value) => Array.isArray(value));
  if (!Array.isArray(files)) return null;
  return [...new Set(files.map((file) => normalizeRepoFilePath(file, root)).filter(Boolean))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectStaticImports(content, importPath) {
  const info = { count: 0, defaultLocal: "", named: new Set() };
  const source = escapeRegExp(importPath);
  const sideEffectImportRe = new RegExp(`\\bimport\\s*['"]${source}['"]`, "g");
  info.count += (content.match(sideEffectImportRe) || []).length;
  const importRe = new RegExp(`\\bimport\\s+(?:type\\s+)?([\\s\\S]*?)\\s+from\\s*['"]${source}['"]`, "g");
  let match;
  while ((match = importRe.exec(content)) !== null) {
    info.count += 1;
    const clause = String(match[1] || "").trim();
    const namedMatch = clause.match(/\{([\s\S]*?)\}/);
    if (namedMatch) {
      for (const part of namedMatch[1].split(",")) {
        const sourceName = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/i)[0]?.trim();
        if (sourceName) info.named.add(sourceName);
      }
    }
    const beforeNamed = clause.split("{")[0].replace(/,\s*$/, "").trim();
    const defaultName = beforeNamed.split(",")[0]?.trim();
    if (defaultName && !defaultName.startsWith("*") && !info.defaultLocal) {
      info.defaultLocal = defaultName;
    }
  }
  return info;
}

// ── 条件类型调度表 ──────────────────────────────────────────────

function createEvaluators(root, options = Object()) {
  const exec = createExec(root);
  const evaluatorConfig = options.config;
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
    files_modified_max: (params, ts) => evalFilesModifiedMax(params, ts, root, exec, { config: evaluatorConfig, changedFiles: options.changedFiles || options.changed_files }),
    file_lines_max: (params, ts) => evalFileLinesMax(params, ts, root),
    no_new_type_errors: (params, ts) => evalNoNewTypeErrors(params, ts, root, exec),
    type_errors_contain: (params, ts) => evalTypeErrorsContain(params, ts, root, exec),
    no_new_lint_errors: (params, ts) => evalNoNewLintErrors(params, ts, root, exec),
    no_new_dead_code: (params, ts) => evalNoNewDeadCode(params, ts, root),
    no_file_over_max_lines: (params, ts) => evalNoFileOverMaxLines(params, ts, root),
    tests_pass: (params, ts) => evalTestsPass(params, ts, root),
    test_file_passes: (params, ts) => evalTestsPass(params, ts, root),
    build_pass: (params, ts) => evalBuildPass(params, ts, root),
    business_code_min: (params, ts) => evalBusinessCodeMin(params, ts, root, exec, { config: evaluatorConfig, changedFiles: options.changedFiles || options.changed_files }),
    acceptance_criteria: (params, _taskScope) => {
      const verifyCommand = (params && params.verify_command) || null;
      if (verifyCommand && typeof verifyCommand === "string") {
        const parsed = parseCommandToArgv(verifyCommand);
        if (!parsed.ok) {
          return {
            passed: false,
            status: "fail",
            detail: `验收标准 verify_command 被拒绝: ${parsed.detail}`,
          };
        }
        const ran = execArgv(parsed.argv, { cwd: root, timeout: 60000 });
        if (ran.ok) {
          return {
            passed: true,
            status: "pass",
            detail: `验收命令通过: ${verifyCommand}`,
          };
        }
        return {
          passed: false,
          status: "fail",
          detail: `验收命令失败: ${verifyCommand}${ran.stderr ? " — " + String(ran.stderr).trim() : ""}`,
          commandNotFound: ran.command_not_found,
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
      const targetFile = normalizeRepoFilePath(params.file || ts?.targets?.[0]?.file, root);
      if (!targetFile) {
        return {
          passed: false,
          status: "not_run",
          detail: "无目标文件指定，无法验证目标文件是否修改",
        };
      }
      const providedChangedFiles = changedFilesFromOptions(options, root);
      let modified;
      if (providedChangedFiles) {
        modified = providedChangedFiles;
      } else {
        const r = exec("git diff --name-only HEAD", { timeout: 10000 });
        if (!r.ok) {
          return {
            passed: false,
            status: "indeterminate",
            detail: "无法获取 git diff，无法验证目标文件是否修改",
          };
        }
        const untracked = exec("git ls-files --others --exclude-standard", { timeout: 10000 });
        if (!untracked.ok) {
          return {
            passed: false,
            status: "indeterminate",
            detail: "无法获取 git untracked 文件，无法验证目标文件是否修改",
          };
        }
        modified = [...new Set(
          `${r.out}\n${untracked.out}`
            .split("\n")
            .map((file) => normalizeRepoFilePath(file, root))
            .filter(Boolean),
        )];
      }
      // Git-diff-sourced paths demand exact match. Bare `endsWith(targetFile)`
      // let "tests/src/feature.ts" falsely match target "src/feature.ts"
      // (since the literal substring overlaps) and the runner reported DONE
      // when only a same-named file in a nested dir changed.
      // Runner-provided changedFiles keep the monorepo-friendly suffix match.
      const found = providedChangedFiles
        ? modified.some((f) => f === targetFile || f.endsWith(`/${targetFile}`))
        : modified.includes(targetFile);
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
      const unsafeFiles = [];
      for (const f of files) {
        const guardResult = resolveWithinRoot(root, f);
        if (!guardResult.ok) {
          unsafeFiles.push({ file: f, reason: guardResult.reason, detail: guardResult.detail });
          continue;
        }
        const absPath = guardResult.path;
        if (!existsSync(absPath)) {
          missingFiles.push(f);
          continue;
        }
        checkedFiles.push(f);
        const content = readFileSync(absPath, "utf8");
        const requiredNamed = Array.isArray(params.named) ? params.named.map(String).map((name) => name.trim()).filter(Boolean) : [];
        const requiredDefault = typeof params.default === "string" ? params.default.trim() : "";
        const imports = collectStaticImports(content, importPath);
        if (imports.count === 0) return { passed: false, detail: `${f} 缺少导入: ${importPath}` };
        const missingNamed = requiredNamed.filter((name) => !imports.named.has(name));
        if (missingNamed.length > 0) {
          return { passed: false, detail: `${f} 缺少命名导入 ${missingNamed.join(", ")} from ${importPath}` };
        }
        if (requiredDefault && imports.defaultLocal !== requiredDefault) {
          return { passed: false, detail: `${f} 缺少默认导入 ${requiredDefault} from ${importPath}` };
        }
      }
      if (unsafeFiles.length > 0) {
        return {
          passed: false,
          status: "indeterminate",
          detail: `指定文件路径越界，无法验证导入 ${importPath}: ${unsafeFiles.map((item) => item.file).join(", ")}`,
          checked_files: checkedFiles,
          unsafe_files: unsafeFiles,
        };
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
  return catalogSupportedConditionTypes();
}

export function evaluatorConditionTypes(options = Object()) {
  return Object.keys(createEvaluators(scopedRoot(options))).sort();
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

  const fn = createEvaluators(scopedRoot(options), options)[condition.type];
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

// Coerce a task's pre/post_conditions to an array. A non-array value (string,
// number, object) is treated as "no conditions" rather than crashing on
// .some/.length/.map downstream — fail-closed, matching the asArray() pattern
// used by prd-contract-doctor and other gates that consume the same PRD.
// Filter non-object entries (null/string/number/array) inside the array:
// downstream evaluateCondition destructures `condition.id`/`condition.type`,
// which throws on null, and `.some(c => c.type)` over the explicit conditions
// also crashes on null elements. Treat malformed elements as absent — a
// malformed PRD has nothing to evaluate there, and other gates already reject
// PRDs with no executable FAIL conditions.
function asConditions(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
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
  const conditions = asConditions(task?.pre_conditions);
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
  const explicitConditions = asConditions(task?.post_conditions);
  const scope = task?.scope || {};

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
      message: "至少 1 个真实业务源码/测试文件改动",
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
