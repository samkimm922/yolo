#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { readJsonFileBounded } from "../../lib/bounded-read.js";
import { safeRegExp } from "../../lib/security/regex-guard.js";

const DEFAULT_MODE = "reuse_existing";
const TEST_FILE_RE = /(^__tests__\/|^tests\/|\/__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$)/i;
const DETERMINISTIC_ACCEPTANCE_RULES = new Set([
  "generic_named_criterion",
  "dual_mode_output",
  "fixture_ground_truth_statistics",
  "error_input_nonzero_exit",
]);
const AUTHENTICITY_METHOD_TYPES = new Set(["assertion_count", "required_marker", "forbidden_pattern", "must_fail_probe", "red_green_sequence"]);

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function clean(value) {
  return String(value ?? "").trim();
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function declaredTestNames(content) {
  return [...content.matchAll(/\b(?:test|it)\s*\(\s*(["'`])([\s\S]*?)\1/g)].map((match) => match[2]);
}

function markerLabel(marker) {
  return typeof marker === "string" ? marker : isRecord(marker) ? clean(marker.text || marker.pattern || marker.name || marker.reason || JSON.stringify(marker)) : clean(marker);
}

function markerMatches(content, marker, forbidden = false) {
  if (!isRecord(marker)) return content.includes(clean(marker));
  const text = clean(marker.text), pattern = clean(marker.pattern);
  const textMatched = text ? content.includes(text) : true;
  const patternMatched = pattern ? Boolean(safeRegExp(pattern)?.test(content)) : true;
  if (forbidden) return Boolean((text && textMatched) || (pattern && patternMatched));
  return Boolean((text || pattern) && textMatched && patternMatched);
}

function markerCount(content, marker) {
  if (!isRecord(marker)) {
    const text = clean(marker);
    if (!text) return 0;
    return content.split(text).length - 1;
  }
  const text = clean(marker.text), pattern = clean(marker.pattern);
  let total = 0;
  if (text) total += content.split(text).length - 1;
  if (pattern) {
    const regex = safeRegExp(pattern, "g");
    if (!regex) return total;
    total += [...content.matchAll(regex)].length;
  }
  return total;
}

function verificationContract(task = Object()) {
  return task.verification_contract || task.verificationContract || task.test_generation?.verification_contract || task.testGeneration?.verificationContract || null;
}

function authenticityContract(task = Object()) {
  const contract = verificationContract(task);
  return contract?.authenticity || contract?.truthfulness || null;
}

function methodFiles(method = Object(), auth = Object(), task = Object(), changedTests = []) {
  return [...new Set([
    ...asArray(method.files || method.file || method.test_files || method.test_file),
    ...asArray(auth.files || auth.file || auth.test_files || auth.test_file),
    ...taskTargetTestFiles(task),
    ...changedTests.map((item) => item.file),
  ].map(normalizePath).filter(Boolean))];
}

function methodMarkers(method = Object()) {
  return asArray(method.markers || method.marker || method.patterns || method.pattern || method.text)
    .filter((marker) => clean(isRecord(marker) ? marker.text || marker.pattern : marker).length > 0);
}

function validateAuthenticityContract(task, cwd, changedTests, failures) {
  const auth = authenticityContract(task);
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return;

  if (auth.required !== true) {
    failures.push({
      code: "AUTHENTICITY_CONTRACT_NOT_REQUIRED",
      detail: "verification_contract.authenticity.required must be true when an authenticity contract is declared.",
    });
  }

  const methods = asArray(auth.methods || auth.proofs || auth.mechanisms);
  if (methods.length === 0) {
    failures.push({
      code: "AUTHENTICITY_METHODS_MISSING",
      detail: "verification_contract.authenticity.methods must declare at least one proof mechanism.",
    });
    return;
  }

  for (const [index, method] of methods.entries()) {
    const type = clean(method?.type);
    if (!AUTHENTICITY_METHOD_TYPES.has(type)) {
      failures.push({
        code: "AUTHENTICITY_METHOD_UNSUPPORTED",
        detail: `Unsupported authenticity method at index ${index}: ${type || "(missing)"}.`,
      });
      continue;
    }
    if (["must_fail_probe", "red_green_sequence"].includes(type)) {
      // PRD contract doctor validates condition references. This runtime gate only
      // checks source/evidence artifacts that exist after the executor session.
      continue;
    }

    const files = methodFiles(method, auth, task, changedTests);
    if (files.length === 0) {
      failures.push({
        code: "AUTHENTICITY_FILES_MISSING",
        detail: `${type} authenticity method must declare files or target a test file.`,
      });
      continue;
    }
    const readable = [];
    for (const file of files) {
      const abs = resolve(cwd, file);
      if (!existsSync(abs)) {
        failures.push({
          code: "AUTHENTICITY_FILE_MISSING",
          detail: `Authenticity contract target file does not exist: ${file}`,
        });
        continue;
      }
      readable.push({ file, content: readFileSync(abs, "utf8") });
    }
    if (readable.length === 0) continue;

    const markers = methodMarkers(method);
    if (markers.length === 0) {
      failures.push({
        code: "AUTHENTICITY_MARKERS_MISSING",
        detail: `${type} authenticity method must declare text or regex markers.`,
      });
      continue;
    }

    if (type === "assertion_count") {
      const minimum = Number(method.minimum ?? method.min ?? method.min_count);
      if (!Number.isFinite(minimum) || minimum < 1) {
        failures.push({
          code: "AUTHENTICITY_ASSERTION_MINIMUM_INVALID",
          detail: "assertion_count authenticity method must declare a positive minimum.",
        });
        continue;
      }
      const count = readable.reduce((sum, item) =>
        sum + markers.reduce((markerSum, marker) => markerSum + markerCount(item.content, marker), 0), 0);
      if (count < minimum) {
        failures.push({
          code: "AUTHENTICITY_ASSERTION_COUNT_BELOW_MINIMUM",
          detail: `Authenticity contract requires at least ${minimum} declared assertion marker(s), found ${count}.`,
          minimum,
          found: count,
        });
      }
      continue;
    }

    if (type === "required_marker") {
      for (const marker of markers) {
        if (!readable.some((item) => markerMatches(item.content, marker))) {
          failures.push({
            code: "AUTHENTICITY_REQUIRED_MARKER_MISSING",
            detail: `Authenticity contract required marker is missing: ${markerLabel(marker)}`,
          });
        }
      }
      continue;
    }

    if (type === "forbidden_pattern") {
      for (const marker of markers) {
        for (const item of readable) {
          if (markerMatches(item.content, marker, true)) {
            failures.push({
              code: "AUTHENTICITY_FORBIDDEN_PATTERN",
              detail: `Authenticity contract forbidden pattern appears in ${item.file}: ${markerLabel(marker)}`,
            });
          }
        }
      }
    }
  }
}

function addAcceptanceFailure(failures, code, detail) {
  failures.push({ code, detail });
}

function validateAcceptanceCoverage(task, cwd, failures) {
  if (task?.test_generation?.acceptance_coverage_required !== true && task?.atomicity?.source !== "synthetic_automated_acceptance") return;
  const manifest = task?.test_generation?.acceptance_coverage || task?.acceptance_coverage || null;
  const criteria = asArray(manifest?.criteria || manifest?.checklist);
  if (!isRecord(manifest) || criteria.length === 0) {
    addAcceptanceFailure(failures, "ACCEPTANCE_COVERAGE_MANIFEST_MISSING", "合成验收测试任务必须声明 test_generation.acceptance_coverage 覆盖清单。");
    return;
  }

  const targetFile = normalizePath(manifest.required_test_file || asArray(manifest.required_test_files)[0] || taskTargetTestFiles(task)[0]);
  if (!targetFile) {
    addAcceptanceFailure(failures, "ACCEPTANCE_COVERAGE_TARGET_MISSING", "acceptance_coverage 必须声明 required_test_file 或在 scope.targets 中声明测试文件。");
    return;
  }
  const abs = resolve(cwd, targetFile);
  if (!existsSync(abs)) {
    addAcceptanceFailure(failures, "ACCEPTANCE_COVERAGE_TARGET_MISSING", `acceptance_coverage 指向的测试文件不存在: ${targetFile}`);
    return;
  }

  const content = readFileSync(abs, "utf8");
  const testNames = declaredTestNames(content);
  for (const criterion of criteria) {
    const criterionId = clean(criterion?.criterion_id || criterion?.id);
    if (!criterionId) {
      addAcceptanceFailure(failures, "ACCEPTANCE_CRITERION_ID_MISSING", "acceptance_coverage.criteria 中存在缺少 criterion_id 的条目。");
      continue;
    }
    const rules = asArray(criterion?.rules || criterion?.rule).map(clean).filter(Boolean);
    const unknownRules = rules.filter((rule) => !DETERMINISTIC_ACCEPTANCE_RULES.has(rule));
    if (unknownRules.length > 0) {
      addAcceptanceFailure(failures, "ACCEPTANCE_CRITERION_UNKNOWN_RULE", `成功标准 ${criterionId} 包含未知确定性规则: ${unknownRules.join(", ")}。`);
    }
    if (criterion?.requires_manual_test === true) {
      addAcceptanceFailure(failures, "ACCEPTANCE_CRITERION_REQUIRES_MANUAL_TEST", `成功标准 ${criterionId} 需要人工测试；确定性生成器不能静默跳过。`);
    }
    const requiredName = clean(criterion.required_test_name || criterion.test_name);
    const hasNamedTest = content.includes(criterionId)
      || (requiredName && content.includes(requiredName))
      || testNames.some((name) => name.includes(criterionId) || (requiredName && name.includes(requiredName)));
    if (!hasNamedTest) {
      addAcceptanceFailure(failures, "ACCEPTANCE_CRITERION_TEST_MISSING", `缺少覆盖成功标准 ${criterionId} 的测试源标记。测试源必须包含 criterion_id 或 required_test_name。`);
    }

    for (const marker of asArray(criterion.required_markers || criterion.required_marker)) {
      if (!markerMatches(content, marker)) {
        addAcceptanceFailure(failures, "ACCEPTANCE_CRITERION_MARKER_MISSING", `成功标准 ${criterionId} 缺少要求的测试标记/断言: ${markerLabel(marker)}`);
      }
    }

    for (const marker of asArray(criterion.forbidden_patterns || criterion.forbidden_markers)) {
      if (markerMatches(content, marker, true)) {
        addAcceptanceFailure(failures, "ACCEPTANCE_CRITERION_FORBIDDEN_PATTERN", `成功标准 ${criterionId} 出现禁止的测试复算/替代模式: ${markerLabel(marker)}`);
      }
    }
  }
}

function hasRunnableTestDeclaration(content) {
  return /\b(?:test|it)\s*\(/.test(content) || /\bdescribe\s*\(/.test(content);
}

function hasNodeTestImport(content) {
  return /\bfrom\s+['"]node:test['"]/.test(content)
    || /\brequire\s*\(\s*['"]node:test['"]\s*\)/.test(content)
    || /\bimport\s*\(\s*['"]node:test['"]\s*\)/.test(content);
}

function usesConsoleAssert(content) {
  return /\bconsole\s*\.\s*assert\s*\(/.test(content);
}

function testOutputLooksEmpty(output = "") {
  return String(output || "").split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return /^(?:#|ℹ)?\s*tests\s+0\b/i.test(trimmed)
      || /^(?:#|ℹ)?\s*0\s+tests?\b(?:\s+(?:found|run|executed|passed|total))?$/i.test(trimmed)
      || /^no tests? (?:found|run|executed)\b/i.test(trimmed);
  });
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
    output = execFileSync("git", ["-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"], {
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
      if (usesConsoleAssert(content)) {
        failures.push({
          code: "TEST_TARGET_CONSOLE_ASSERT",
          detail: `node:test 目标文件不能使用 console.assert；它只打印 Assertion failed，不会让测试失败: ${file}`,
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
  validateAcceptanceCoverage(task, cwd, failures);
  validateAuthenticityContract(task, cwd, changedTests, failures);

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
