// evaluators/runtime-check.js — evalTestsPass / evalBuildPass / evalBusinessCodeMin

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isWithin } from "../security/path-guard.js";
import { config } from "../config.js";
import { execCommand } from "../security/safe-exec.js";
import { businessFilePolicyDescription, isBusinessFile } from "../../runtime/execution/change-set.js";
import type { EvalParams, EvalResult, EvaluatorOptions, ExecFn, TaskScope } from "./types.js";
import {
  assertBuildCommandAvailable,
  buildCommandEnv,
  commandUnavailableDetail,
  resolveBuildCommand,
  resolveGateTimeout,
} from "../toolchain.js";

type CommandRunResult = {
  ok: boolean;
  out: string;
  message: string;
};

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
  return {
    ok: result.ok,
    out: result.stdout,
    message: result.ok ? "" : (result.command_not_found ? commandUnavailableDetail(kind, command, ROOT) : (result.stderr || result.error || "")),
  };
}

function commandConfig(kind: "test" | "build", command: string): Record<string, unknown> {
  const build = config.build && typeof config.build === "object" ? config.build as Record<string, unknown> : Object();
  return { ...config, build: { ...build, [kind]: command } };
}

export function evalTestsPass(params: EvalParams = {}, _taskScope: TaskScope, ROOT: string): EvalResult {
  const baseCommand = String(params.command || resolveBuildCommand("test", config, ROOT));
  const file = params.file || params.test_file;
  const commandWithFile = file && baseCommand.includes("{file}") ? baseCommand.replaceAll("{file}", file) : baseCommand;
  const availability = assertBuildCommandAvailable("test", commandConfig("test", commandWithFile), ROOT);
  if (!availability.ok) return { passed: false, detail: availability.message, type: "tests_pass" };
  const result = runCommand(commandWithFile, ROOT, params.timeout_ms || resolveGateTimeout("test", config), "test");
  return {
    passed: result.ok,
    detail: result.ok ? `测试命令通过: ${commandWithFile}` : `测试命令失败: ${result.message.slice(0, 200)}`,
    type: "tests_pass",
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
