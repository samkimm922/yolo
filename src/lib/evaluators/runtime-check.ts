// evaluators/runtime-check.js — evalTestsPass / evalBuildPass / evalBusinessCodeMin

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isWithin } from "../security/path-guard.js";
import { config } from "../config.js";
import { execCommand } from "../security/safe-exec.js";
import { businessFilePolicyDescription, isBusinessFile } from "../../runtime/execution/change-set.js";
import type { EvalParams, EvalResult, EvaluatorOptions, ExecFn, TaskScope } from "./types.js";

type CommandRunResult = {
  ok: boolean;
  out: string;
  message: string;
};

function errorRecord(error: unknown): { stdout?: unknown; stderr?: unknown; message?: unknown } {
  return typeof error === "object" && error !== null
    ? error as { stdout?: unknown; stderr?: unknown; message?: unknown }
    : {};
}

function targetFilesFromScope(taskScope: TaskScope): string[] {
  return (taskScope.targets || []).map((target) => target.file).filter((file): file is string => Boolean(file));
}

function runCommand(command: string, ROOT: string, timeout: number): CommandRunResult {
  // P12.I1: route through safe-exec — untrusted command strings parsed to argv
  // and rejected if they contain shell metacharacters; spawn without shell.
  const result = execCommand(command, { cwd: ROOT, timeout });
  if (result.rejected) {
    return {
      ok: false,
      out: "",
      message: `command rejected: ${result.reject_detail}`,
    };
  }
  return {
    ok: result.ok,
    out: result.stdout,
    message: result.ok ? "" : (result.stderr || result.error || ""),
  };
}

export function evalTestsPass(params: EvalParams = {}, _taskScope: TaskScope, ROOT: string): EvalResult {
  const command = params.command || config.build?.test || "";
  if (command) {
    const file = params.file || params.test_file;
    const commandWithFile = file && command.includes("{file}") ? command.replaceAll("{file}", file) : command;
    const result = runCommand(commandWithFile, ROOT, params.timeout_ms || config.gate?.timeout?.test || 120000);
    return {
      passed: result.ok,
      detail: result.ok ? `测试命令通过: ${commandWithFile}` : `测试命令失败: ${result.message.slice(0, 200)}`,
      type: "tests_pass",
    };
  }

  try {
    const out = execFileSync("pnpm", ["exec", "vitest", "run", "--reporter", "json"], {
      cwd: ROOT, encoding: "utf8", timeout: 120000, stdio: ["pipe", "pipe", "pipe"],
    });
    const s = out.indexOf("{");
    if (s < 0) {
      return { passed: false, detail: "vitest 未输出 JSON 测试结果，无法确认测试通过", type: "tests_pass" };
    }
    const data = JSON.parse(out.slice(s));
    if (!data || typeof data.numFailedTests !== "number") {
      return { passed: false, detail: "vitest JSON 缺少 numFailedTests，测试结果不可信", type: "tests_pass" };
    }
    if ((data.numFailedTests || 0) > 0) return { passed: false, detail: data.numFailedTests + " 个测试失败", found: data.numFailedTests };
    return { passed: true, detail: "全部测试通过", type: "tests_pass" };
  } catch (e) {
    const caught = errorRecord(e);
    const s = String(caught.stdout || "") + String(caught.stderr || "");
    try {
      const start = s.indexOf("{");
      if (start >= 0) {
        const json = JSON.parse(s.slice(start));
        if (json && typeof json.numFailedTests === "number") {
          return {
            passed: json.numFailedTests === 0,
            detail: json.numFailedTests === 0 ? "所有测试通过" : `${json.numFailedTests} 个测试失败`,
            type: "tests_pass"
          };
        }
      }
    } catch {
      // H12: vitest produced no parseable JSON result — fail-closed with a
      // structured code rather than an empty/indeterminate result.
    }
    return { passed: false, detail: `vitest 执行异常：${String(caught.message || caught.stderr || "").slice(0, 200)}`, code: "OUTPUT_UNPARSEABLE", type: "tests_pass" };
  }
}

export function evalBuildPass(params: EvalParams = {}, _taskScope: TaskScope, ROOT: string): EvalResult {
  const command = params.command || config.build?.build || "";
  if (command) {
    const result = runCommand(command, ROOT, params.timeout_ms || config.gate?.timeout?.build || 240000);
    return {
      passed: result.ok,
      detail: result.ok ? `构建命令通过: ${command}` : `构建命令失败: ${result.message.slice(0, 200)}`,
      type: "build_pass",
    };
  }

  try {
    execFileSync("pnpm", ["run", "build:weapp"], {
      cwd: ROOT, encoding: "utf8", timeout: 240000, stdio: ["pipe", "pipe", "pipe"],
    });
    return { passed: true, detail: "构建通过 (weapp)" };
  } catch (e) {
    const caught = errorRecord(e);
    return { passed: false, detail: "构建失败: " + String(caught.message || "").slice(0, 80) };
  }
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
