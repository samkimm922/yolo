// evaluators/quality-check.js — evalNoForbiddenPatterns / evalNoNewTypeErrors / evalNoNewLintErrors / evalNoNewDeadCode

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { isWithin, resolveWithinRoot } from "../security/path-guard.js";
import { execCommand } from "../security/safe-exec.js";
import { safeRegExp, validateRegexPattern } from "../security/regex-guard.js";
import { config } from "../config.js";
import type { EvalParams, EvalResult, ExecFn, ForbiddenPattern, TaskScope } from "./types.js";
import { commandUnavailableDetail, resolveBuildCommand, resolveGateTimeout } from "../toolchain.js";
import { commandOutputSnapshotKeys, matchDeclaredErrorOutput } from "../../runtime/gates/error-output-policy.js";

type BuildCommandKey = "type_check" | "lint" | "dead_code";

type ForbiddenPatternViolation = {
  file: string;
  pattern: string;
  severity: string;
  description: string;
};

function configuredCommand(params: EvalParams = {}, key: BuildCommandKey, ROOT: string): string {
  return String(params.command || resolveBuildCommand(key, config, ROOT));
}

function targetFilesFromScope(taskScope: TaskScope): string[] {
  return (taskScope.targets || []).map((target) => target.file).filter((file): file is string => Boolean(file));
}

function patternValue(pattern: ForbiddenPattern): string {
  return typeof pattern === "string" ? pattern : pattern.pattern;
}

function patternSeverity(pattern: ForbiddenPattern): string {
  return typeof pattern === "string" ? "FAIL" : pattern.severity || "FAIL";
}

function patternDescription(pattern: ForbiddenPattern): string {
  return typeof pattern === "string" ? "" : pattern.message || pattern.description || "";
}

function patternIsRegex(pattern: ForbiddenPattern): boolean {
  return typeof pattern !== "string" && (pattern.is_regex || !!pattern.flags);
}

function patternFlags(pattern: ForbiddenPattern): string {
  return typeof pattern === "string" ? "" : pattern.flags || "";
}

export function evalNoForbiddenPatterns(params: EvalParams, taskScope: TaskScope, ROOT: string, exec: ExecFn): EvalResult {
  const patterns = params.patterns || taskScope?.forbidden_patterns || [];
  if (patterns.length === 0) return { passed: true, detail: "无禁用模式" };

  const scanScope = params.scan_scope || taskScope?.scan_scope;
  // Coerce targets/files to arrays: a hand-edited PRD can put a string (or
  // other non-array) on params.targets/params.files. Without this guard the
  // downstream `for (const file of targets)` iterates *characters* of the
  // string; single-char paths resolve within root and vacuously `continue`,
  // so a forbidden pattern smuggled past this condition silently passes.
  let targets =
    (Array.isArray(params.targets) ? params.targets : null) ||
    (Array.isArray(params.files) ? params.files : null) ||
    (params.file ? [params.file] : null) ||
    targetFilesFromScope(taskScope);

  if (targets.length === 0 && scanScope === "diff") {
    const unstagedFiles = exec("git diff --name-only");
    const stagedFiles = exec("git diff --cached --name-only");
    if (!unstagedFiles.ok && !stagedFiles.ok) {
      return { passed: false, status: "indeterminate", detail: "无法获取 diff，无法验证禁用模式", type: "no_forbidden_patterns" };
    }
    const collect = (out: string): string[] => String(out || "").split("\n").filter(
      (f) => f && /\.(ts|tsx|js|jsx)$/.test(f) && !f.includes("node_modules"),
    );
    targets = [...new Set([...collect(unstagedFiles.out), ...collect(stagedFiles.out)])];

    const untracked = exec("git ls-files --others --exclude-standard");
    if (!untracked.ok) {
      return { passed: false, status: "indeterminate", detail: "无法获取未跟踪文件列表，无法验证禁用模式", type: "no_forbidden_patterns" };
    }
    if (untracked.out) {
      const utFiles = untracked.out.split("\n").filter(
        (f) => f && /\.(ts|tsx|js|jsx)$/.test(f) && !f.includes("node_modules"),
      );
      targets = [...new Set([...targets, ...utFiles])];
    }
  }

  if (targets.length === 0) {
    return { passed: false, status: "not_run", detail: "无目标文件，无法验证禁用模式", type: "no_forbidden_patterns" };
  }

  const violations: ForbiddenPatternViolation[] = [];
  for (const file of targets) {
    const abs = resolve(ROOT, file);
    if (!isWithin(abs, ROOT) || !existsSync(abs)) continue;
    const unstagedDiff = exec(`git diff -- "${file}"`);
    const stagedDiff = exec(`git diff --cached -- "${file}"`);
    if (!unstagedDiff.ok && !stagedDiff.ok) {
      return { passed: false, status: "indeterminate", detail: `无法获取 ${file} 的 diff，无法验证禁用模式`, type: "no_forbidden_patterns" };
    }
    let diffOut = `${unstagedDiff.out || ""}\n${stagedDiff.out || ""}`;
    if (!diffOut.trim()) {
      // Untracked file — git diff returns empty. Read file directly.
      const tracked = exec(`git ls-files --error-unmatch -- "${file}"`);
      if (!tracked.ok) {
        try {
          const raw = readFileSync(abs, "utf8").trim();
          if (!raw) continue;
          diffOut = raw.split("\n").map((l) => `+${l}`).join("\n");
        } catch { continue; }
      } else {
        continue; // Tracked but unchanged — nothing to check.
      }
    }

    const addedLines = diffOut
      .split("\n")
      .filter((l) => /^\+[^+]/.test(l))
      .join("\n");

    for (const p of patterns) {
      const pattern = patternValue(p);
      const isRegex = patternIsRegex(p);
      const flags = patternFlags(p);
      const msg = patternDescription(p);
      let matched;
      if (isRegex) {
        const validation = validateRegexPattern(pattern);
        if (!validation.ok) {
          return {
            passed: false,
            status: "fail",
            detail: `禁用模式正则被拒绝: ${validation.reason}`,
            type: "no_forbidden_patterns",
          };
        }
        const re = safeRegExp(pattern, flags);
        if (!re) {
          return {
            passed: false,
            status: "fail",
            detail: "禁用模式正则无法编译",
            type: "no_forbidden_patterns",
          };
        }
        matched = re.test(addedLines);
      } else {
        matched = addedLines.includes(pattern);
      }
      if (matched) {
        violations.push({
          file,
          pattern,
          severity: patternSeverity(p),
          description: msg,
        });
      }
    }
  }

  if (violations.length > 0) {
    const warningOnly = violations.every((v) => v.severity === "WARN");
    return {
      passed: false,
      status: warningOnly ? "warning" : "fail",
      detail: violations
        .map((v) => `${v.description ? v.description + " — " : ""}[${v.severity}] ${v.file}: ${v.pattern}`)
        .join("; "),
      violations,
    };
  }

  return { passed: true, detail: "安全扫描通过，无禁用模式", violations: [] };
}

type OutputGateKind = "type_check" | "lint" | "dead_code";

function baselinePathFor(params: EvalParams, kind: OutputGateKind, ROOT: string): string | null {
  const explicit = params.baseline_path || params.baselinePath;
  const filename = kind === "type_check"
    ? "tsc-baseline.json"
    : kind === "lint"
      ? "eslint-baseline.json"
      : "knip-baseline.json";
  const candidate = explicit || join(ROOT, "scripts", "yolo", "state", "runtime", filename);
  const guarded = resolveWithinRoot(ROOT, String(candidate));
  return guarded.ok ? guarded.path || null : null;
}

function readBaselineKeys(params: EvalParams, kind: OutputGateKind, ROOT: string): { keys: string[]; error?: string } {
  const baselinePath = baselinePathFor(params, kind, ROOT);
  if (!baselinePath || !isWithin(baselinePath, ROOT)) {
    return { keys: [], error: "baseline 路径必须位于项目根目录内" };
  }
  if (!existsSync(baselinePath)) return { keys: [] };
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, "utf8")) as unknown;
    const keys = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? (parsed as { keys?: unknown[]; snapshot?: unknown[]; output_snapshot?: unknown[] }).keys ||
          (parsed as { snapshot?: unknown[] }).snapshot ||
          (parsed as { output_snapshot?: unknown[] }).output_snapshot
        : null;
    if (!Array.isArray(keys)) return { keys: [], error: "baseline 缺少通用 keys 快照" };
    return { keys: keys.map(String) };
  } catch {
    return { keys: [], error: "baseline JSON 无法解析" };
  }
}

function outputFailureDetail(kind: OutputGateKind, result: { exitCode?: number | null; out?: string; err?: string }): string {
  const code = result.exitCode != null ? `(code ${result.exitCode})` : "";
  return `${kind} 命令异常退出${code}，无法确认零新增输出`;
}

function evaluateOutputDiff(
  kind: OutputGateKind,
  conditionType: string,
  params: EvalParams,
  ROOT: string,
  result: { ok: boolean; out?: string; err?: string; exitCode?: number | null; commandNotFound?: boolean },
): EvalResult {
  const baseline = readBaselineKeys(params, kind, ROOT);
  if (baseline.error) {
    return { passed: false, detail: baseline.error, code: "BASELINE_CORRUPT", type: conditionType };
  }
  if (result.commandNotFound) {
    return { passed: false, detail: commandUnavailableDetail(kind, configuredCommand(params, kind, ROOT), ROOT), type: conditionType };
  }

  const output = result.ok ? "" : `${result.out || ""}${result.err || ""}`;
  const currentKeys = result.ok ? [] : commandOutputSnapshotKeys(output, params, config);
  if (!result.ok && currentKeys.length === 0) {
    return { passed: false, detail: outputFailureDetail(kind, result), type: conditionType };
  }

  const baselineSet = new Set(baseline.keys);
  const newIssues = currentKeys.filter((key) => !baselineSet.has(key));
  if (newIssues.length > 0) {
    const declared = matchDeclaredErrorOutput(output, params, config);
    const ruleHint = declared.length > 0 ? `（声明规则: ${declared.map((item) => item.id).join(", ")}）` : "";
    return {
      passed: false,
      detail: `新增 ${newIssues.length} 个 ${kind} 输出${ruleHint}: ${newIssues.slice(0, 3).join(", ")}`,
      newIssues,
      type: conditionType,
    };
  }

  return {
    passed: true,
    detail: baseline.keys.length > 0 ? `(预存 ${baseline.keys.length} 个 ${kind} 输出，无新增)` : `${kind} 无新增输出`,
    type: conditionType,
  };
}

export function evalNoNewTypeErrors(params: EvalParams = {}, _taskScope: TaskScope, ROOT: string, exec: ExecFn): EvalResult {
  const command = configuredCommand(params, "type_check", ROOT);
  if (!command) {
    return { passed: false, detail: "未配置 type_check 命令，无法验证 no_new_type_errors", type: "no_new_type_errors" };
  }
  const result = exec(`${command} 2>&1`, { timeout: params.timeout_ms || resolveGateTimeout("type_check", config) });
  return evaluateOutputDiff("type_check", "no_new_type_errors", params, ROOT, result);
}

export function evalTypeErrorsContain(params: EvalParams = {}, _taskScope: TaskScope, ROOT: string, exec: ExecFn): EvalResult {
  const command = configuredCommand(params, "type_check", ROOT);
  if (!command) return { passed: false, detail: "未配置 type_check 命令，无法验证 type_errors_contain", type: "type_errors_contain" };

  const result = exec(`${command} 2>&1`, { timeout: params.timeout_ms || resolveGateTimeout("type_check", config) });
  const output = result.ok ? result.out : `${result.out || ""}${result.err || ""}`;
  const needle = params.text || params.pattern || params.code;
  if (!needle) return { passed: false, detail: "缺少 text/pattern/code 参数", type: "type_errors_contain" };

  let matched;
  if (params.pattern) {
    const validation = validateRegexPattern(params.pattern);
    if (!validation.ok) {
      return {
        passed: false,
        detail: `类型检查正则被拒绝: ${validation.reason}`,
        type: "type_errors_contain",
      };
    }
    const re = safeRegExp(params.pattern, params.flags || "");
    if (!re) {
      return {
        passed: false,
        detail: "类型检查正则无法编译",
        type: "type_errors_contain",
      };
    }
    matched = re.test(output);
  } else {
    matched = output.includes(String(needle));
  }
  return {
    passed: matched,
    detail: matched ? `类型检查输出包含 ${String(needle).slice(0, 80)}` : `类型检查输出不包含 ${String(needle).slice(0, 80)}`,
    found: matched ? 1 : 0,
    type: "type_errors_contain",
  };
}

export function evalNoNewLintErrors(params: EvalParams = {}, _taskScope: TaskScope, ROOT: string, exec: ExecFn): EvalResult {
  const command = configuredCommand(params, "lint", ROOT);
  if (!command) {
    return { passed: false, detail: "未配置 lint 命令，无法验证 no_new_lint_errors", type: "no_new_lint_errors" };
  }
  const result = exec(`${command} 2>&1`, { timeout: params.timeout_ms || resolveGateTimeout("lint", config) });
  return evaluateOutputDiff("lint", "no_new_lint_errors", params, ROOT, result);
}

export function evalNoNewDeadCode(params: EvalParams = {}, _taskScope: TaskScope, ROOT: string): EvalResult {
  const command = configuredCommand(params, "dead_code", ROOT);
  if (!command) {
    const baselinePath = baselinePathFor(params, "dead_code", ROOT);
    const baseline = readBaselineKeys(params, "dead_code", ROOT);
    if (baseline.error) {
      return { passed: false, detail: baseline.error, code: "BASELINE_CORRUPT", type: "no_new_dead_code" };
    }
    return existsSync(baselinePath)
      ? { passed: false, detail: "dead_code 命令不可用但 baseline 存在，无法验证新增输出", type: "no_new_dead_code" }
      : { passed: false, status: "indeterminate", detail: "dead_code 不可用且无 baseline，无法验证新增输出", type: "no_new_dead_code" };
  }
  const result = execCommand(command, {
    cwd: ROOT, timeout: params.timeout_ms || (config.gate?.timeout?.dead_code as number | undefined) || 30000,
  });
  if (result.rejected) {
    return { passed: false, detail: `dead_code 命令被拒绝: ${result.reject_detail}`, type: "no_new_dead_code" };
  }
  if (!result.ok && !String(result.stdout || result.stderr || "").trim() && !existsSync(baselinePathFor(params, "dead_code", ROOT))) {
    return {
      passed: false,
      status: "indeterminate",
      detail: "dead_code 命令失败且无 baseline，无法验证死代码新增输出",
      type: "no_new_dead_code",
    };
  }
  return evaluateOutputDiff("dead_code", "no_new_dead_code", params, ROOT, {
    ok: result.ok,
    out: result.stdout,
    err: result.stderr,
    exitCode: result.exit_code,
    commandNotFound: result.command_not_found,
  });
}
