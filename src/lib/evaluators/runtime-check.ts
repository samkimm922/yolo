// evaluators/runtime-check.js — evalTestsPass / evalBuildPass / evalBusinessCodeMin

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isWithin } from "../security/path-guard.js";
import { parseCommandToArgv } from "../security/command-guard.js";
import { safeRegExp } from "../security/regex-guard.js";
import { config } from "../config.js";
import { execCommand } from "../security/safe-exec.js";
import { businessFilePolicyDescription, isBusinessFile } from "../../runtime/execution/change-set.js";
import type { EvalParams, EvalResult, EvaluatorOptions, ExecFn, TaskScope } from "./types.js";
import {
  assertBuildCommandAvailable,
  buildCommandEnv,
  type BuildCommandKind,
  commandUnavailableDetail,
  resolveBuildCommand,
  resolveGateTimeout,
} from "../toolchain.js";

type CommandRunResult = {
  ok: boolean;
  out: string;
  message: string;
};

type TestCountRule = Record<string, unknown>;

type TestCountProof = {
  passed: boolean;
  detail?: string;
  found?: number;
  minimum?: number;
  proof?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

function targetFilesFromScope(taskScope: TaskScope): string[] {
  return (taskScope.targets || []).map((target) => target.file).filter((file): file is string => Boolean(file));
}

function runCommand(command: string, ROOT: string, timeout: number, kind: "test" | "build"): CommandRunResult {
  // P12.I1: route through safe-exec — untrusted command strings parsed to argv
  // and rejected if they contain shell metacharacters; spawn without shell.
  const result = execCommand(command, { cwd: ROOT, timeout, env: buildCommandEnv(ROOT) });
  if (result.rejected) {
    return {
      ok: false,
      out: "",
      message: `command rejected: ${result.reject_detail}`,
    };
  }
  const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return {
    ok: result.ok,
    out: combinedOutput,
    message: result.ok ? "" : (result.command_not_found ? commandUnavailableDetail(kind, command, ROOT) : (result.stderr || result.error || "")),
  };
}

const BUILD_COMMAND_KINDS = new Set(["test", "type_check", "build", "lint", "dead_code"]);

function requiresNonEmptyTests(params: EvalParams = {}): boolean {
  return params.require_tests === true || params.require_nonzero_tests === true || params.requireNonzeroTests === true;
}

function nodeTestCount(output = ""): number | null {
  const counts = String(output || "").split(/\r?\n/).flatMap((line) => {
    const normalized = line.replace(/\x1b\[[0-9;]*m/g, "").trim();
    const match = normalized.match(/^(?:#|ℹ)?\s*tests\s+(\d+)\s*$/i);
    if (!match) return [];
    const count = Number(match[1]);
    return Number.isSafeInteger(count) ? [count] : [];
  });
  return counts.length > 0 ? counts[counts.length - 1] : null;
}

function testOutputLooksEmpty(output = ""): boolean {
  return nodeTestCount(output) === 0;
}

function testOutputHasAssertionFailure(output = ""): boolean {
  return String(output || "").split(/\r?\n/).some((line) => /\bAssertion failed\b/i.test(line.trim()));
}

function commandConfig(kind: BuildCommandKind, command: string, source: Record<string, unknown> = config): Record<string, unknown> {
  const build = isRecord(source.build) ? source.build : Object();
  return { ...source, build: { ...build, [kind]: command } };
}

function authenticityContract(task: unknown): Record<string, unknown> | null {
  if (!isRecord(task)) return null;
  const generation = isRecord(task.test_generation) ? task.test_generation : isRecord(task.testGeneration) ? task.testGeneration : null;
  const contract = task.verification_contract || task.verificationContract || generation?.verification_contract || generation?.verificationContract;
  if (!isRecord(contract)) return null;
  const authenticity = contract.authenticity || contract.truthfulness;
  return isRecord(authenticity) ? authenticity : null;
}

function declaredTestCountRule(options: EvaluatorOptions = {}): { rule?: TestCountRule; source?: string; error?: string } {
  const authenticity = authenticityContract(options.task);
  const methods = authenticity
    ? asArray(authenticity.methods || authenticity.proofs || authenticity.mechanisms)
      .filter(isRecord)
      .filter((method) => cleanString(method.type) === "test_count")
    : [];
  if (methods.length > 1) return { error: "authenticity contract must declare exactly one test_count method" };
  if (methods.length === 1) return { rule: methods[0], source: "verification_contract.authenticity.test_count" };

  const projectConfig = isRecord(options.config) ? options.config : config;
  const build = isRecord(projectConfig.build) ? projectConfig.build : null;
  if (!build || !Object.prototype.hasOwnProperty.call(build, "test_count")) return {};
  return isRecord(build.test_count)
    ? { rule: build.test_count, source: "config.build.test_count" }
    : { error: "config.build.test_count must be an object" };
}

function extractDeclaredTestCount(output: string, rule: TestCountRule, source: string): TestCountProof {
  const minimum = Number(rule.minimum);
  const pattern = cleanString(rule.pattern);
  const flags = cleanString(rule.flags);
  if (!Number.isInteger(minimum) || minimum < 1) {
    return { passed: false, detail: `${source} must declare a positive integer minimum` };
  }
  if (!pattern.includes("(?<count>")) {
    return { passed: false, detail: `${source} pattern must declare a named (?<count>...) capture` };
  }
  const regex = /^[imsu]*$/.test(flags) ? safeRegExp(pattern, flags) : null;
  if (!regex) return { passed: false, detail: `${source} pattern or flags are invalid or unsafe` };
  const captured = regex.exec(output)?.groups?.count;
  if (captured === undefined) return { passed: false, detail: `${source} 未能从测试输出提取 count` };
  if (!/^\d+$/.test(captured)) return { passed: false, detail: `${source} 提取的 count 不是非负整数: ${captured}` };
  const found = Number(captured);
  if (!Number.isSafeInteger(found)) return { passed: false, detail: `${source} 提取的 count 超出安全整数范围` };
  return found < minimum
    ? { passed: false, detail: `测试命令通过但实际执行测试数 ${found} < 声明最小值 ${minimum}`, found, minimum, proof: source }
    : { passed: true, found, minimum, proof: source };
}

function executableName(value: string): string {
  return value.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.exe$/, "") || "";
}

function packageTestScript(command: string, ROOT: string): string {
  const parsed = parseCommandToArgv(command);
  if (!parsed.ok || !parsed.argv) return "";
  const [executable, ...args] = parsed.argv;
  if (!["npm", "pnpm", "yarn"].includes(executableName(executable))) return "";
  const first = args.findIndex((arg) => !arg.startsWith("-"));
  const script = first >= 0 && args[first] === "run" ? args[first + 1] : args[first];
  if (script !== "test") return "";
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    return cleanString(pkg?.scripts?.test);
  } catch {
    return "";
  }
}

function commandUsesNodeTest(command: string, ROOT: string, nested = false): boolean {
  const parsed = parseCommandToArgv(command);
  if (!parsed.ok || !parsed.argv) return false;
  const [executable, ...args] = parsed.argv;
  if (executableName(executable) === "node" && args.some((arg) => arg === "--test" || arg.startsWith("--test="))) return true;
  if (nested) return false;
  const script = packageTestScript(command, ROOT);
  return Boolean(script) && commandUsesNodeTest(script, ROOT, true);
}

function verifyRequiredTestCount(output: string, command: string, ROOT: string, options: EvaluatorOptions): TestCountProof {
  const declaration = declaredTestCountRule(options);
  if (declaration.error) return { passed: false, detail: declaration.error };
  if (declaration.rule && declaration.source) {
    return extractDeclaredTestCount(output, declaration.rule, declaration.source);
  }
  if (!commandUsesNodeTest(command, ROOT)) {
    return { passed: false, detail: "require_tests=true 但未声明 test_count 提取规则；请在 verification_contract.authenticity 或 config.build.test_count 中补充声明" };
  }
  const found = nodeTestCount(output);
  if (found === null) {
    return { passed: false, detail: "node:test 命令未产生可验证的 tests 计数摘要；请使用固定 TAP 摘要或声明 test_count 提取规则" };
  }
  if (testOutputLooksEmpty(output)) {
    return { passed: false, detail: "测试命令通过但 node:test 报告 0 tests", found, minimum: 1, proof: "node:test TAP" };
  }
  return { passed: true, found, minimum: 1, proof: "node:test TAP" };
}

function buildCommandKind(value: unknown): BuildCommandKind | null {
  const kind = String(value || "").trim();
  return BUILD_COMMAND_KINDS.has(kind) ? kind as BuildCommandKind : null;
}

export function evalBuildCommandAvailable(params: EvalParams = {}, _taskScope: TaskScope, ROOT: string): EvalResult {
  const kind = buildCommandKind(params.kind || params.command_kind);
  if (!kind) {
    return {
      passed: false,
      detail: "build_command_available requires params.kind: test, type_check, build, lint, or dead_code",
      type: "build_command_available",
    };
  }
  const command = String(params.command || resolveBuildCommand(kind, config, ROOT));
  const availability = assertBuildCommandAvailable(kind, commandConfig(kind, command), ROOT);
  return {
    passed: availability.ok,
    detail: availability.ok ? `命令可用: ${command}` : availability.message,
    type: "build_command_available",
    command: availability.command,
    executable: availability.executable,
    config_key: availability.configKey,
  };
}

export function evalTestsPass(params: EvalParams = {}, _taskScope: TaskScope, ROOT: string, options: EvaluatorOptions = {}): EvalResult {
  const projectConfig = isRecord(options.config) ? options.config : config;
  const baseCommand = String(params.command || resolveBuildCommand("test", projectConfig, ROOT));
  const file = params.file || params.test_file;
  const commandWithFile = file && baseCommand.includes("{file}") ? baseCommand.replaceAll("{file}", file) : baseCommand;
  const availability = assertBuildCommandAvailable("test", commandConfig("test", commandWithFile, projectConfig), ROOT);
  if (!availability.ok) return { passed: false, detail: availability.message, type: "tests_pass" };
  const result = runCommand(commandWithFile, ROOT, params.timeout_ms || resolveGateTimeout("test", config), "test");
  if (result.ok && requiresNonEmptyTests(params) && testOutputHasAssertionFailure(result.out)) {
    return {
      passed: false,
      detail: `测试命令通过但输出包含 Assertion failed，可能使用了不会使 node:test 失败的 console.assert: ${commandWithFile}`,
      type: "tests_pass",
    };
  }
  let testCount: TestCountProof | null = null;
  if (result.ok && requiresNonEmptyTests(params)) {
    testCount = verifyRequiredTestCount(result.out, commandWithFile, ROOT, options);
    if (!testCount.passed) {
      return { passed: false, detail: testCount.detail || "测试执行计数无法验证", type: "tests_pass", ...testCount };
    }
  }
  return {
    passed: result.ok,
    detail: result.ok ? `测试命令通过: ${commandWithFile}` : `测试命令失败: ${result.message.slice(0, 200)}`,
    type: "tests_pass",
    ...(testCount ? { found: testCount.found, minimum: testCount.minimum, proof: testCount.proof } : {}),
  };
}

export function evalBuildPass(params: EvalParams = {}, _taskScope: TaskScope, ROOT: string): EvalResult {
  const command = String(params.command || resolveBuildCommand("build", config, ROOT));
  const availability = assertBuildCommandAvailable("build", commandConfig("build", command), ROOT);
  if (!availability.ok) return { passed: false, detail: availability.message, type: "build_pass" };
  const result = runCommand(command, ROOT, params.timeout_ms || resolveGateTimeout("build", config), "build");
  return {
    passed: result.ok,
    detail: result.ok ? `构建命令通过: ${command}` : `构建命令失败: ${result.message.slice(0, 200)}`,
    type: "build_pass",
  };
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");
}

function changedFilesFromFilesystemBaseline(ROOT: string, taskScope: TaskScope = {}): string[] {
  const baselinePath = resolve(ROOT, ".yolo-worktree-baseline.json");
  if (!existsSync(baselinePath)) return [];
  let baseline: { hashes?: Record<string, string> } = {};
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { hashes?: Record<string, string> };
  } catch {
    return [];
  }
  const hashes = baseline.hashes || {};
  const scopedTargets = targetFilesFromScope(taskScope);
  const candidates = scopedTargets.length > 0 ? scopedTargets : Object.keys(hashes);
  const changed: string[] = [];
  for (const file of candidates) {
    const absolute = resolve(ROOT, file);
    if (!isWithin(absolute, ROOT) || !existsSync(absolute)) continue;
    try {
      if (statSync(absolute).isDirectory()) continue;
      const currentHash = hashFile(absolute);
      if (!hashes[file] || hashes[file] !== currentHash) changed.push(file);
    } catch {}
  }
  return changed;
}

function changedFilesFromOptions(options: EvaluatorOptions = {}, taskScope: TaskScope = {}): string[] | null {
  const candidates = [
    options.changedFiles,
    options.changed_files,
    taskScope.changedFiles,
    taskScope.changed_files,
  ];
  const files = candidates.find((value) => Array.isArray(value));
  return Array.isArray(files) ? [...new Set(files.map(String).map((file) => file.trim()).filter(Boolean))] : null;
}

export function evalBusinessCodeMin(params: EvalParams, taskScope: TaskScope, ROOT: string, exec: ExecFn, options: EvaluatorOptions = {}): EvalResult {
  if (taskScope?.expected_zero_business_code === true) {
    return { passed: true, detail: "task 声明 expected_zero_business_code,跳过" };
  }
  const minFiles = params.min ?? 1;
  const businessConfig = options.config || config;
  const providedChangedFiles = changedFilesFromOptions(options, taskScope);

  const all = new Set<string>();
  if (providedChangedFiles) {
    providedChangedFiles.forEach((file) => all.add(file));
  } else {
    const diffOut = exec("git diff --name-only HEAD");
    const untrackedOut = exec("git ls-files --others --exclude-standard");
    if (diffOut.ok) diffOut.out.split("\n").filter(Boolean).forEach((f) => all.add(f));
    if (untrackedOut.ok) untrackedOut.out.split("\n").filter(Boolean).forEach((f) => all.add(f));
  }
  if (!providedChangedFiles && all.size === 0) {
    for (const file of changedFilesFromFilesystemBaseline(ROOT, taskScope)) all.add(file);
  }

  const businessFiles = [...all].filter((file) => isBusinessFile(file, { config: businessConfig }));
  const policyDesc = businessFilePolicyDescription({ config: businessConfig });
  if (businessFiles.length < minFiles) {
    return {
      passed: false,
      detail: `未检测到真业务代码改动 (${policyDesc}; 检测到 ${businessFiles.length} < ${minFiles})`,
      found: businessFiles.length,
    };
  }
  return {
    passed: true,
    detail: `真业务代码改动 ${businessFiles.length} 个文件: ${businessFiles.slice(0, 5).join(", ")}${businessFiles.length > 5 ? "..." : ""}`,
    found: businessFiles.length,
  };
}
