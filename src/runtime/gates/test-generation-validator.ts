#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { readJsonFileBounded } from "../../lib/bounded-read.js";

const DEFAULT_MODE = "reuse_existing";
const TEST_FILE_RE = /(^__tests__\/|^tests\/|\/__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$)/i;

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function normalizePath(file) {
  return String(file || "").replace(/^\.\//, "");
}

export function isTestFile(file) {
  return TEST_FILE_RE.test(normalizePath(file));
}

function matchPattern(file, pattern) {
  const normalized = normalizePath(file);
  const p = normalizePath(pattern);
  if (!p) return false;
  if (p.endsWith("/**")) return normalized.startsWith(p.slice(0, -3));
  if (p.includes("*")) {
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
    return new RegExp(`^${escaped}$`).test(normalized);
  }
  return normalized === p;
}

export function parseStatusLine(line) {
  const raw = line.replace(/\r?\n$/, "");
  if (!raw.trim()) return null;
  if (raw.startsWith("?? ")) return { status: "A", file: normalizePath(raw.slice(3)), isNew: true };
  const status = raw.slice(0, 2);
  const rest = raw.slice(3).trim();
  const file = normalizePath(rest.includes(" -> ") ? rest.split(" -> ").pop() : rest);
  return { status, file, isNew: status.includes("A") || status.includes("?") };
}

function fileAllowedByTaskScope(file, task) {
  const scope = task?.scope || {};
  if (scope.allow_new_files !== true) return false;
  const targets = asArray(scope.targets).map((target) => normalizePath(target?.file || target)).filter(Boolean);
  const normalized = normalizePath(file);
  return targets.some((target) => normalized === target || normalized.startsWith(`${dirname(target)}/`));
}

function taskRequiresNonEmptyTests(task) {
  return asArray(task?.post_conditions).some((condition) => {
    if (condition?.type !== "tests_pass") return false;
    const params = condition.params || {};
    return params.require_tests === true || params.require_nonzero_tests === true || params.requireNonzeroTests === true;
  });
}

function taskTargetTestFiles(task) {
  return asArray(task?.scope?.targets)
    .map((target) => normalizePath(target?.file || target))
    .filter((file) => file && isTestFile(file));
}

function hasRunnableTestDeclaration(content) {
  return /\b(?:test|it)\s*\(/.test(content) || /\bdescribe\s*\(/.test(content);
}

function hasNodeTestImport(content) {
  return /\bfrom\s+['"]node:test['"]/.test(content)
    || /\brequire\s*\(\s*['"]node:test['"]\s*\)/.test(content)
    || /\bimport\s*\(\s*['"]node:test['"]\s*\)/.test(content);
}

function testOutputLooksEmpty(output = "") {
  const text = String(output || "");
  return /(?:^|\n)#?\s*tests\s+0(?:\n|$)/i.test(text)
    || /\b0\s+tests?\b/i.test(text)
    || /\bno tests? (?:found|run|executed)\b/i.test(text);
}

function taskUsesNodeTestRunner(task, cwd) {
  const testCondition = asArray(task?.post_conditions).find((condition) => condition?.type === "tests_pass");
  const command = String(testCondition?.params?.command || "");
  if (/\bnode\s+--test\b/.test(command)) return true;
  if (!/\bnpm\s+(?:run\s+)?test\b/.test(command)) return false;
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8"));
    return /\bnode\s+--test\b/.test(String(pkg?.scripts?.test || ""));
  } catch {
    return false;
  }
}

function verifyNodeTestTarget(cwd, file) {
  try {
    const output = execFileSync(process.execPath, ["--test", file], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    if (testOutputLooksEmpty(output)) {
      return {
        ok: false,
        code: "TEST_TARGET_NO_EXECUTED_TESTS",
        detail: `node --test ${file} 通过但没有执行任何测试。`,
      };
    }
    return { ok: true };
  } catch (error) {
    const stderr = error?.stderr?.toString?.().trim();
    const stdout = error?.stdout?.toString?.().trim();
    return {
      ok: false,
      code: "TEST_TARGET_COMMAND_FAILED",
      detail: `node --test ${file} 失败: ${(stderr || stdout || error?.message || String(error)).slice(0, 300)}`,
    };
  }
}

function gitErrorDetail(error) {
  const stderr = error?.stderr?.toString?.().trim();
  return stderr || error?.message || String(error || "unknown git error");
}

function inspectChangedFiles(cwd = process.cwd()) {
  let output = "";
  try {
    output = execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
  } catch (error) {
    return { ok: false, files: [], error: `git status failed; cannot verify test generation changes: ${gitErrorDetail(error)}` };
  }
  return { ok: true, files: output.split("\n").map(parseStatusLine).filter(Boolean) };
}

export function getChangedFiles(cwd = process.cwd()) {
  return inspectChangedFiles(cwd).files;
}

function countAddedLines(cwd, file, isNew) {
  if (isNew && existsSync(resolve(cwd, file))) {
    return { ok: true, addedLines: readFileSync(resolve(cwd, file), "utf8").split("\n").length };
  }
  try {
    const unstaged = execFileSync("git", ["-C", cwd, "diff", "--", file], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    const staged = execFileSync("git", ["-C", cwd, "diff", "--cached", "--", file], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    const combined = `${unstaged || ""}\n${staged || ""}`;
    return {
      ok: true,
      addedLines: combined.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    };
  } catch (error) {
    return { ok: false, addedLines: 0, error: gitErrorDetail(error) };
  }
}

export function validateTestGeneration(task, options = Object()) {
  const cwd = options.cwd || process.cwd();
  const policy = task?.test_generation || {};
  const mode = policy.mode || DEFAULT_MODE;
  // M4: a caller-supplied changedFiles=[] used to short-circuit the git check
  // (hasOwnProperty treated presence as authoritative). An empty array must NOT
  // bypass git inspection — only a non-empty caller-supplied list is trusted.
  const callerChangedFiles = Object.prototype.hasOwnProperty.call(options, "changedFiles")
    ? (options.changedFiles || [])
    : null;
  const changedProbe = Object.assign(Object(), callerChangedFiles && callerChangedFiles.length > 0
    ? { ok: true, files: callerChangedFiles }
    : inspectChangedFiles(cwd));
  const changedFiles = changedProbe.files || [];
  const failures = [];
  const warnings = [];

  if (!changedProbe.ok) {
    failures.push({
      code: "TEST_GENERATION_GIT_STATUS_UNAVAILABLE",
      detail: changedProbe.error || "Unable to read git status; cannot verify test generation changes.",
    });
  }

  const changedTests = changedFiles.filter((item) => isTestFile(item.file));
  const newTests = changedTests.filter((item) => item.isNew);
  const requiredTargetTests = taskRequiresNonEmptyTests(task) ? taskTargetTestFiles(task) : [];

  if (taskRequiresNonEmptyTests(task) && requiredTargetTests.length === 0) {
    failures.push({
      code: "TEST_TARGET_SCOPE_MISSING",
      detail: "require_tests=true 的任务必须在 scope.targets 中声明至少一个测试文件。",
    });
  }

  for (const file of requiredTargetTests) {
    const abs = resolve(cwd, file);
    if (!existsSync(abs)) {
      failures.push({
        code: "TEST_TARGET_MISSING",
        detail: `require_tests=true 的目标测试文件未创建: ${file}`,
      });
      continue;
    }
    const content = readFileSync(abs, "utf8");
    if (!content.trim()) {
      failures.push({
        code: "TEST_TARGET_EMPTY",
        detail: `require_tests=true 的目标测试文件为空: ${file}`,
      });
      continue;
    }
    if (!hasRunnableTestDeclaration(content)) {
      failures.push({
        code: "TEST_TARGET_NO_TEST_DECLARATION",
        detail: `目标测试文件缺少 test()/it()/describe() 声明: ${file}`,
      });
      continue;
    }
    if (taskUsesNodeTestRunner(task, cwd)) {
      if (!hasNodeTestImport(content)) {
        failures.push({
          code: "TEST_TARGET_NO_NODE_TEST_IMPORT",
          detail: `node --test 项目的目标测试文件必须显式导入 node:test: ${file}`,
        });
        continue;
      }
      const runnable = verifyNodeTestTarget(cwd, file);
      if (!runnable.ok) {
        failures.push({
          code: runnable.code,
          detail: runnable.detail,
        });
      }
    }
  }

  if (!["none", "reuse_existing", "add_minimal", "forbid"].includes(mode)) {
    failures.push({ code: "INVALID_TEST_GENERATION_MODE", detail: `未知 test_generation.mode: ${mode}` });
  }

  if (mode === "forbid" && changedTests.length > 0) {
    failures.push({
      code: "TEST_CHANGES_FORBIDDEN",
      detail: `forbid 模式禁止新增或修改测试文件: ${changedTests.map((f) => f.file).join(", ")}`,
    });
  }

  const disallowedNewTests = newTests.filter((item) => !fileAllowedByTaskScope(item.file, task));
  if ((mode === "none" || mode === "reuse_existing") && disallowedNewTests.length > 0) {
    failures.push({
      code: "NEW_TESTS_NOT_ALLOWED",
      detail: `${mode} 模式不允许新增测试文件: ${disallowedNewTests.map((f) => f.file).join(", ")}`,
    });
  }

  if (mode === "add_minimal") {
    const maxNew = policy.max_new_test_files ?? 1;
    if (newTests.length > maxNew) {
      failures.push({ code: "TOO_MANY_NEW_TEST_FILES", detail: `新增测试文件 ${newTests.length} > ${maxNew}` });
    }
    const allowed = asArray(policy.allowed_test_files);
    if (allowed.length > 0) {
      const disallowed = newTests.filter((item) => !allowed.some((pattern) => matchPattern(item.file, pattern)));
      if (disallowed.length > 0) {
        failures.push({ code: "TEST_FILE_OUT_OF_ALLOWLIST", detail: `新增测试文件不在 allowed_test_files: ${disallowed.map((f) => f.file).join(", ")}` });
      }
    }
    const maxLines = policy.max_test_lines_changed;
    if (maxLines != null) {
      const lineChecks = changedTests.map((item) => ({ ...item, ...countAddedLines(cwd, item.file, item.isNew) }));
      const overLimit = lineChecks.filter((item) => item.addedLines > maxLines);
      const diffFailures = lineChecks.filter((item) => item.ok === false);
      if (diffFailures.length > 0) {
        failures.push({
          code: "TEST_GENERATION_DIFF_UNAVAILABLE",
          detail: `无法读取测试文件 diff，无法验证测试改动行数: ${diffFailures.map((f) => `${f.file}: ${f.error || "git diff failed"}`).join("; ")}`,
        });
      }
      if (overLimit.length > 0) {
        failures.push({ code: "TEST_LINES_CHANGED_LIMIT", detail: `测试改动行数超限: ${overLimit.map((f) => `${f.file}:${f.addedLines}`).join(", ")}` });
      }
    }
  }

  const failurePolicy = policy.failure_policy || {};
  const sameFailureLimit = failurePolicy.same_failure_limit ?? 2;
  const failureHistory = options.failureHistory || [];
  const repeated = failureHistory.filter((item) => item && item.kind && item.key && item.kind.includes("test"));
  const counts = new Map();
  for (const item of repeated) {
    const key = `${item.kind}:${item.key}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const blockedFailures = [...counts.entries()].filter(([, count]) => count >= sameFailureLimit);
  if (blockedFailures.length > 0) {
    failures.push({ code: "TEST_FAILURE_LOOP_BLOCKED", detail: `同一测试同因失败达到限制: ${blockedFailures.map(([key, count]) => `${key} x${count}`).join(", ")}` });
  }

  if (changedTests.length > 0 && !policy.reason) {
    warnings.push({ code: "MISSING_TEST_GENERATION_REASON", detail: "修改测试文件但 test_generation.reason 为空" });
  }

  const status = failures.length > 0 ? "fail" : warnings.length > 0 ? "warning" : "pass";
  return {
    status,
    blocks_execution: status !== "pass",
    mode,
    changed_test_files: changedTests.map((item) => item.file),
    new_test_files: newTests.map((item) => item.file),
    failures,
    warnings,
    next_action: status === "pass" ? "execute" : "blocked",
  };
}

function parseArgs(argv) {
  const args = Object();
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
    else if (arg === "--json") args.json = true;
  }
  return args;
}

function loadTask(prdPath, taskId) {
  const prd = readJsonFileBounded(resolve(prdPath), { errorCode: "PRD_JSON_SIZE_LIMIT_EXCEEDED" });
  const task = (prd.tasks || []).find((item) => item.id === taskId);
  if (!task) throw new Error(`PRD 中未找到 task: ${taskId}`);
  return task;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task || !args.prd) {
    console.error("用法: node test-generation-validator.js --task=<id> --prd=<prd.json> [--cwd=<worktree>] [--json]");
    process.exit(2);
  }
  try {
    const task = loadTask(args.prd, args.task);
    const result = validateTestGeneration(task, { cwd: args.cwd || process.cwd() });
    console.log(args.json ? JSON.stringify(result, null, 2) : `[test-generation] ${result.status}`);
    process.exit(result.status === "pass" ? 0 : result.status === "warning" ? 2 : 1);
  } catch (error) {
    console.error(`[test-generation] ${error.message}`);
    process.exit(2);
  }
}
