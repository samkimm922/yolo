// evaluators/quality-check.js — evalNoForbiddenPatterns / evalNoNewTypeErrors / evalNoNewLintErrors / evalNoNewDeadCode

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { config } from "../config.js";

function configuredCommand(params = Object(), key) {
  return params.command || config.build?.[key] || "";
}

export function evalNoForbiddenPatterns(params, taskScope, ROOT, exec) {
  const patterns = params.patterns || taskScope?.forbidden_patterns || [];
  if (patterns.length === 0) return { passed: true, detail: "无禁用模式" };

  const scanScope = params.scan_scope || taskScope?.scan_scope;
  let targets =
    params.targets ||
    params.files ||
    (params.file ? [params.file] : null) ||
    (taskScope?.targets || []).map((t) => t.file).filter(Boolean);

  if (targets.length === 0 && scanScope === "diff") {
    const unstagedFiles = exec("git diff --name-only");
    const stagedFiles = exec("git diff --cached --name-only");
    if (!unstagedFiles.ok && !stagedFiles.ok) {
      return { passed: false, status: "indeterminate", detail: "无法获取 diff，无法验证禁用模式", type: "no_forbidden_patterns" };
    }
    const collect = (out) => String(out || "").split("\n").filter(
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

  const violations = [];
  for (const file of targets) {
    if (!existsSync(resolve(ROOT, file))) continue;
    const unstagedDiff = exec(`git diff -- "${file}"`);
    const stagedDiff = exec(`git diff --cached -- "${file}"`);
    if (!unstagedDiff.ok && !stagedDiff.ok) {
      return { passed: false, status: "indeterminate", detail: `无法获取 ${file} 的 diff，无法验证禁用模式`, type: "no_forbidden_patterns" };
    }
    const diffOut = `${unstagedDiff.out || ""}\n${stagedDiff.out || ""}`;
    if (!diffOut.trim()) continue;

    const addedLines = diffOut
      .split("\n")
      .filter((l) => /^\+[^+]/.test(l))
      .join("\n");

    for (const p of patterns) {
      const pattern = p.pattern || p;
      const isRegex = p.is_regex || !!p.flags;
      const flags = p.flags || "";
      const msg = p.message || p.description || "";
      let matched;
      if (isRegex) {
        matched = new RegExp(pattern, flags).test(addedLines);
      } else {
        matched = addedLines.includes(pattern);
      }
      if (matched) {
        violations.push({
          file,
          pattern,
          severity: p.severity || "FAIL",
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

export function evalNoNewTypeErrors(params = Object(), taskScope, ROOT, exec) {
  const FATAL_CODES = new Set([
    "TS2304", "TS2305", "TS2307", "TS2322", "TS2345", "TS2554", "TS2741",
  ]);

  const targetFiles = (taskScope?.targets || []).map((t) => t.file).filter(Boolean);

  const baselinePath = join(ROOT, "scripts", "yolo", "state", "runtime", "tsc-baseline.json");
  let baselineKeys = [];
  if (existsSync(baselinePath)) {
    try {
      const json = JSON.parse(readFileSync(baselinePath, "utf8"));
      if (json && Array.isArray(json.keys)) baselineKeys = json.keys;
    } catch {}
  }

  const command = configuredCommand(params, "type_check");
  if (!command) {
    return { passed: false, detail: "未配置 type_check 命令，无法验证 no_new_type_errors", type: "no_new_type_errors" };
  }
  const tsc = exec(`${command} 2>&1`, { timeout: params.timeout_ms || config.gate?.timeout?.type_check || 120000 });
  if (tsc.commandNotFound) {
    return { passed: false, detail: "tsc 或 pnpm 命令不可用，类型检查无法执行", type: "no_new_type_errors" };
  }
  const tscOut = tsc.ok ? tsc.out : (tsc.out || "") + (tsc.err || "");

  const currentKeys = new Set();
  for (const line of tscOut.split("\n")) {
    const m = line.match(/^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+)/);
    if (m) {
      const normalizedFile = m[1].replace(/^\.\//, "");
      currentKeys.add(`${normalizedFile}:${m[2]}:${m[3]}`);
    }
  }

  if (!tsc.ok && currentKeys.size === 0) {
    const code = tsc.exitCode != null ? `(code ${tsc.exitCode})` : "";
    return {
      passed: false,
      detail: `typecheck 命令异常退出${code}，无法确认零错误`,
      type: "no_new_type_errors",
    };
  }

  const baseSet = new Set(baselineKeys);

  const allNewIssues = [...currentKeys].filter((k) => !baseSet.has(k));

  const extractFile = (k) => k.split(":").slice(0, -2).join(":");

  const relevantNewIssues = targetFiles.length > 0
    ? allNewIssues.filter((k) => {
        const file = extractFile(k);
        return targetFiles.some((tf) => file === tf);
      })
    : allNewIssues;

  const filteredOutIssues = allNewIssues.filter((k) => !relevantNewIssues.includes(k));
  const filteredWarn = filteredOutIssues.length > 0
    ? `（注意：${filteredOutIssues.length} 个新增错误不在目标文件列表中: ${filteredOutIssues.slice(0, 5).join("; ")}${filteredOutIssues.length > 5 ? "..." : ""}）`
    : "";

  const newFatalIssues = relevantNewIssues.filter((k) => {
    const code = String(k).split(":").pop();
    return FATAL_CODES.has(code);
  });

  const otherNewIssues = relevantNewIssues.filter((k) => {
    const code = String(k).split(":").pop();
    return !FATAL_CODES.has(code);
  });

  const newIssues = [...newFatalIssues, ...otherNewIssues];

  if (newFatalIssues.length > 0) {
    return {
      passed: false,
      detail: `新增致命 tsc 错误 ${newFatalIssues.length} 个: ${newFatalIssues.slice(0, 5).join(", ")}${filteredWarn}`,
      newIssues,
    };
  }

  if (otherNewIssues.length > 0) {
    return {
      passed: false,
      detail: `新增 ${otherNewIssues.length} 个 tsc 错误: ${otherNewIssues.slice(0, 3).join(", ")}${filteredWarn}`,
      newIssues,
    };
  }

  return {
    passed: true,
    detail: baselineKeys.length > 0
      ? `(预存 ${baselineKeys.length} 个 tsc 错误，无新增)${filteredWarn}`
      : `tsc 零错误${filteredWarn}`,
  };
}

export function evalTypeErrorsContain(params = Object(), _taskScope, ROOT, exec) {
  const command = configuredCommand(params, "type_check");
  if (!command) return { passed: false, detail: "未配置 type_check 命令，无法验证 type_errors_contain", type: "type_errors_contain" };

  const result = exec(`${command} 2>&1`, { timeout: params.timeout_ms || config.gate?.timeout?.type_check || 120000 });
  const output = result.ok ? result.out : `${result.out || ""}${result.err || ""}`;
  const needle = params.text || params.pattern || params.code;
  if (!needle) return { passed: false, detail: "缺少 text/pattern/code 参数", type: "type_errors_contain" };

  const matched = params.pattern
    ? new RegExp(params.pattern, params.flags || "").test(output)
    : output.includes(String(needle));
  return {
    passed: matched,
    detail: matched ? `类型检查输出包含 ${String(needle).slice(0, 80)}` : `类型检查输出不包含 ${String(needle).slice(0, 80)}`,
    found: matched ? 1 : 0,
    type: "type_errors_contain",
  };
}

export function evalNoNewLintErrors(params = Object(), _taskScope, ROOT, exec) {
  const baselinePath = join(ROOT, "scripts", "yolo", "state", "runtime", "eslint-baseline.json");
  let baselineKeys = [];
  if (existsSync(baselinePath)) {
    try {
      const json = JSON.parse(readFileSync(baselinePath, "utf8"));
      if (json && Array.isArray(json.keys)) baselineKeys = json.keys;
    } catch {}
  }

  const command = configuredCommand(params, "lint");
  if (!command) {
    return { passed: false, detail: "未配置 lint 命令，无法验证 no_new_lint_errors", type: "no_new_lint_errors" };
  }
  const eslint = exec(`${command} 2>&1`, { timeout: params.timeout_ms || config.gate?.timeout?.lint || 90000 });
  if (eslint.commandNotFound) {
    return { passed: false, detail: "eslint 或 pnpm 命令不可用，lint 检查无法执行", type: "no_new_lint_errors" };
  }
  let issues = [];
  try {
    const jsonStart = eslint.out.indexOf("[");
    if (jsonStart >= 0) {
      issues = JSON.parse(eslint.out.slice(jsonStart));
    } else {
      return { passed: false, detail: "eslint 输出格式异常：未找到 JSON 数组", type: "no_new_lint_errors" };
    }
  } catch {
    return { passed: false, detail: "eslint 输出无法解析为 JSON", type: "no_new_lint_errors" };
  }

  const currentKeys = new Set();
  for (const issue of issues) {
    const file = issue.filePath?.replace(ROOT + "/", "") || "";
    for (const msg of issue.messages || []) {
      if (msg.ruleId) currentKeys.add(`${file}:${msg.line}:${msg.ruleId}`);
    }
  }

  if (!eslint.ok && currentKeys.size === 0) {
    const code = eslint.exitCode != null ? `(code ${eslint.exitCode})` : "";
    return {
      passed: false,
      detail: `eslint 命令异常退出${code}，无法确认零错误`,
      type: "no_new_lint_errors",
    };
  }

  const baseSet = new Set(baselineKeys);
  const newIssues = [...currentKeys].filter((k) => !baseSet.has(k));

  if (newIssues.length > 0) {
    return {
      passed: false,
      detail: `新增 ${newIssues.length} 个 eslint 问题: ${newIssues.slice(0, 3).join(", ")}`,
      newIssues,
    };
  }

  return {
    passed: true,
    detail: baselineKeys.length > 0
      ? `(预存 ${baselineKeys.length} 个 eslint 问题，无新增)`
      : "eslint 零错误",
  };
}

export function evalNoNewDeadCode(params = Object(), _taskScope, ROOT) {
  const baselinePath = join(ROOT, "scripts", "yolo", "state", "runtime", "knip-baseline.json");
  let baselineKeys = [];
  if (existsSync(baselinePath)) {
    try { baselineKeys = JSON.parse(readFileSync(baselinePath, "utf8")).keys || []; }
    catch { /* baseline corrupt, ignore */ }
  }
  try {
    const command = configuredCommand(params, "dead_code");
    if (!command) {
      return { passed: false, detail: "未配置 dead_code 命令，无法验证 no_new_dead_code", type: "no_new_dead_code" };
    }
    const knipOut = execFileSync("sh", ["-c", command], {
      cwd: ROOT, encoding: "utf8", timeout: params.timeout_ms || config.gate?.timeout?.dead_code || 30000, stdio: ["pipe", "pipe", "pipe"],
    });
    const knipData = JSON.parse(knipOut.trim());
    const currentKeys = [];
    const excludeDirs = ["node_modules", "dist", "__tests__"];
    for (const issue of knipData.issues || []) {
      if (excludeDirs.some((d) => issue.file.startsWith(d))) continue;
      for (const exp of issue.exports || []) currentKeys.push(issue.file + ":export:" + exp.name);
      for (const typ of issue.types || []) currentKeys.push(issue.file + ":type:" + typ.name);
    }
    const baselineSet = new Set(baselineKeys);
    const newDead = currentKeys.filter((k) => !baselineSet.has(k));
    if (newDead.length > 0) {
      return { passed: false, detail: "新增 " + newDead.length + " 个死代码: " + newDead.slice(0, 5).join(", ") + (newDead.length > 5 ? "..." : ""), found: newDead.length };
    }
    return { passed: true, detail: baselineKeys.length ? "(预存 " + baselineKeys.length + " 个，无新增)" : "无死代码" };
  } catch {
    const knipBaselinePath = join(ROOT, "scripts", "yolo", "state", "runtime", "knip-baseline.json");
    const hasBaseline = existsSync(knipBaselinePath);
    if (hasBaseline) {
      return { passed: false, detail: "knip 执行失败但 baseline 存在，死代码检测不可用", type: "no_new_dead_code" };
    }
    return {
      passed: false,
      status: "indeterminate",
      detail: "knip 不可用且无 baseline，无法验证死代码",
      type: "no_new_dead_code",
    };
  }
}
